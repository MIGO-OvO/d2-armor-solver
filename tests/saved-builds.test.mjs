import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

import {
  LEGACY_SAVED_BUILDS_KEYS,
  SAVED_BUILD_LIMIT,
  SAVED_BUILD_SCHEMA_VERSION,
  SHARED_SAVED_BUILDS_KEY,
  STORAGE_KEYS,
  createBuildRepository,
} from "../src/core/build-repository.mjs";

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.has(key) ? this.#values.get(key) : null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }

  removeItem(key) {
    this.#values.delete(key);
  }

  raw(key) {
    return this.#values.get(key) ?? null;
  }
}

const STABLE_LEGACY = LEGACY_SAVED_BUILDS_KEYS[0];
const DEVELOP_LEGACY = LEGACY_SAVED_BUILDS_KEYS[1];

function legacyBuild(overrides = {}) {
  return {
    name: "Legacy",
    targets: { health: 100, melee: 100, grenade: 100, super: 100, class: 100, weapons: 100 },
    savedAt: 1_700_000_000_000,
    result: { canonicalId: "canonical-A", certificate: { status: "EXACT_TARGET_PROVEN" } },
    ...overrides,
  };
}

function repositoryWith(entries = {}) {
  const storage = new MemoryStorage();
  for (const [key, value] of Object.entries(entries)) {
    storage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  return {storage, repository: createBuildRepository(storage)};
}

// --- Channel independence ---------------------------------------------------

test("saved builds live in one shared key that never passes through channelStorageKey", () => {
  assert.equal(STORAGE_KEYS.savedBuilds, SHARED_SAVED_BUILDS_KEY);
  assert.equal(SHARED_SAVED_BUILDS_KEY, "d2_armor_saved_builds_v3");
  assert.doesNotMatch(SHARED_SAVED_BUILDS_KEY, /_dev_/);
  // Channel-scoped state must stay channel-scoped.
  assert.match(STORAGE_KEYS.currentDraft, /d2_armor_current_draft_v1/);
});

test("a build saved in either channel is visible from the other", () => {
  // One physical localStorage: both GitHub Pages paths share the same origin.
  const {storage, repository} = repositoryWith();
  const build = legacyBuild({id: "shared-1", name: "Shared"});
  assert.equal(repository.writeSavedBuilds([build]), true);
  assert.equal(storage.raw(STABLE_LEGACY), null, "the stable legacy key is never written again");
  assert.equal(storage.raw(DEVELOP_LEGACY), null, "the develop legacy key is never written again");
  assert.equal(JSON.parse(storage.raw(SHARED_SAVED_BUILDS_KEY)).builds.length, 1);
  // Re-creating the repository from the same storage is exactly "reload".
  const reloaded = createBuildRepository(storage);
  assert.equal(reloaded.readSavedBuilds().length, 1);
  assert.equal(reloaded.readSavedBuilds()[0].name, "Shared");
});

// --- Legacy migration -------------------------------------------------------

test("legacy stable and develop keys are migrated automatically", () => {
  const {repository} = repositoryWith({
    [STABLE_LEGACY]: [legacyBuild({name: "From stable", result: {canonicalId: "canonical-stable"}})],
    [DEVELOP_LEGACY]: [legacyBuild({name: "From develop", savedAt: 1_700_000_100_000,
      result: {canonicalId: "canonical-develop"}})],
  });
  const builds = repository.readSavedBuilds();
  assert.deepEqual(builds.map(build => build.name).sort(), ["From develop", "From stable"]);
  assert.equal(builds[0].name, "From develop", "newest first");
  for (const build of builds) {
    assert.equal(build.schemaVersion, SAVED_BUILD_SCHEMA_VERSION);
    assert.ok(build.id, "every migrated build gets a stable id");
  }
});

test("legacy keys are read but never deleted", () => {
  const {storage, repository} = repositoryWith({
    [STABLE_LEGACY]: [legacyBuild({result: {canonicalId: "canonical-stable"}})],
  });
  repository.readSavedBuilds();
  assert.notEqual(storage.raw(STABLE_LEGACY), null);
});

test("migration is idempotent across repeated reloads", () => {
  const {storage} = repositoryWith({
    [STABLE_LEGACY]: [legacyBuild({name: "A", result: {canonicalId: "c-a"}})],
    [DEVELOP_LEGACY]: [legacyBuild({name: "B", savedAt: 1_700_000_500_000, result: {canonicalId: "c-b"}})],
  });
  const lengths = [];
  for (let run = 0; run < 4; run++) {
    // Each iteration is a fresh app start against the same localStorage.
    lengths.push(createBuildRepository(storage).readSavedBuilds().length);
  }
  assert.deepEqual(lengths, [2, 2, 2, 2]);
  assert.equal(JSON.parse(storage.raw(SHARED_SAVED_BUILDS_KEY)).builds.length, 2);
});

test("the same build stored in both channels is merged, not duplicated", () => {
  const shared = {name: "Same", savedAt: 1_700_000_000_000, result: {canonicalId: "canonical-same"}};
  const {repository} = repositoryWith({
    [STABLE_LEGACY]: [shared],
    [DEVELOP_LEGACY]: [structuredClone(shared)],
  });
  assert.equal(repository.readSavedBuilds().length, 1);
});

test("records without an id or canonicalId still dedupe on time + name + pieces", () => {
  const record = {
    name: "No identity", savedAt: 1_700_000_000_000,
    targets: {health: 100},
    result: {pieces: [{slot: "helmet", sourceId: "i-1"}, {slot: "arms", sourceId: "i-2"}]},
  };
  const {repository} = repositoryWith({
    [STABLE_LEGACY]: [record],
    [DEVELOP_LEGACY]: [structuredClone(record)],
  });
  assert.equal(repository.readSavedBuilds().length, 1);
});

test("a malformed record cannot take the whole saved list down", () => {
  const {repository} = repositoryWith({
    [STABLE_LEGACY]: [
      "not-an-object",
      null,
      42,
      {name: "Good", savedAt: 1, result: {canonicalId: "canonical-good"}},
      {name: "Also good", savedAt: 2, result: {canonicalId: "canonical-also"}},
    ],
  });
  const builds = repository.readSavedBuilds();
  assert.deepEqual(builds.map(build => build.name).sort(), ["Also good", "Good"]);
  // A record with a broken solution snapshot is still kept as a build.
  const broken = repositoryWith({
    [STABLE_LEGACY]: [{name: "Broken snapshot", savedAt: 3, result: {pieces: "??"}, targets: {health: 5}}],
  }).repository.readSavedBuilds();
  assert.equal(broken.length, 1);
  assert.equal(broken[0].name, "Broken snapshot");
});

test("an unreadable shared key degrades to an empty list instead of throwing", () => {
  const shared = repositoryWith({[SHARED_SAVED_BUILDS_KEY]: "{not json"});
  assert.deepEqual(shared.repository.readSavedBuilds(), []);
  const empty = createBuildRepository(null);
  assert.deepEqual(empty.readSavedBuilds(), []);
});

// --- Write failure ----------------------------------------------------------

test("writeSavedBuilds reports a real failure instead of pretending to save", () => {
  const repository = createBuildRepository({
    getItem() { return null; },
    setItem() { throw new Error("QuotaExceededError"); },
    removeItem() {},
  });
  assert.equal(repository.writeSavedBuilds([legacyBuild()]), false);
  assert.deepEqual(repository.readSavedBuilds(), []);
  assert.equal(repository.clearSavedBuilds(), false);
});

test("clearSavedBuilds does not let the legacy keys resurrect deleted builds", () => {
  const {storage, repository} = repositoryWith({
    [STABLE_LEGACY]: [legacyBuild({result: {canonicalId: "canonical-stable"}})],
  });
  assert.equal(repository.readSavedBuilds().length, 1);
  assert.equal(repository.clearSavedBuilds(), true);
  assert.deepEqual(repository.readSavedBuilds(), []);
  assert.notEqual(storage.raw(STABLE_LEGACY), null, "the legacy key itself is preserved");
});

test("the saved list is capped and newest-first", () => {
  const {repository} = repositoryWith();
  const builds = Array.from({length: SAVED_BUILD_LIMIT + 20}, (_, index) => legacyBuild({
    id: `build-${index}`, name: `Build ${index}`, savedAt: 1_700_000_000_000 + index,
    result: {canonicalId: `canonical-${index}`},
  }));
  assert.equal(repository.writeSavedBuilds(builds), true);
  const stored = repository.readSavedBuilds();
  assert.equal(stored.length, SAVED_BUILD_LIMIT);
  assert.equal(stored[0].name, `Build ${SAVED_BUILD_LIMIT + 19}`);
});

// --- SavedBuild schema ------------------------------------------------------

const source = readFileSync(new URL("../src/app.mjs", import.meta.url), "utf8");
const context = vm.createContext({
  l: (zh) => zh,
  // The helpers below never touch the DOM; anything that would is stubbed out.
  document: {getElementById: () => null},
  getExoticLanguage: () => "zh-chs",
  EXOTIC_CLASS_LABELS: {hunter: "猎人·万事皆允"},
  t: () => "exoticClassItem",
});
vm.runInContext([
  "readSavedBuildInput",
  "resolveExoticPieceLabel",
].map(name => source.slice(source.indexOf(`function ${name}(`)).split("\nfunction ")[0]).join("\n"), context);

test("a legacy flat build restores its full solver input", () => {
  const input = context.readSavedBuildInput({
    targets: {health: 100}, targetMax: {health: 100}, fragments: {super: 10},
    statPriority: {health: "high"}, statFuzzyMode: {melee: "fuzzy"},
    numPlus5: 4, numPlus10: 1, onlyPlus5Tuning: true, n3Enabled: false, numPlus3: 0,
    exotic: {enabled: true, classId: "hunter"},
  });
  assert.deepEqual(input.targets, {health: 100});
  assert.deepEqual(input.fragments, {super: 10});
  assert.equal(input.numPlus5, 4);
  assert.equal(input.onlyPlus5Tuning, true);
  assert.equal(input.exotic.classId, "hunter");
});

test("a nested input block wins over the flat legacy mirror", () => {
  const input = context.readSavedBuildInput({
    targets: {health: 1},
    input: {targets: {health: 100}, numPlus5: 5, setRequirement: {type: "set", setHash: 7, count: 4}},
  });
  assert.deepEqual(input.targets, {health: 100});
  assert.equal(input.numPlus5, 5);
  assert.deepEqual(input.setRequirement, {type: "set", setHash: 7, count: 4});
});

test("a build whose solution snapshot is incompatible still yields its input", () => {
  // The witness is retained as a cache; nothing here invalidates the input.
  const build = {
    schemaVersion: SAVED_BUILD_SCHEMA_VERSION,
    id: "build-1", name: "Old solver",
    solutionSnapshot: {canonicalId: "canonical-old", certificateStatus: "EXACT_TARGET_PROVEN"},
    input: {targets: {health: 90}, numPlus5: 3},
    result: {problemSpec: {operation: "solveInventory"}, pieces: []},
  };
  const repository = createBuildRepository(new MemoryStorage());
  repository.writeSavedBuilds([build]);
  const [stored] = repository.readSavedBuilds();
  assert.equal(stored.result.problemSpec.operation, "solveInventory");
  assert.deepEqual(context.readSavedBuildInput(stored).targets, {health: 90});
});

// --- Source contract: one selection, one save path --------------------------

test("saveBuild consumes the selected unified entry, not the theory cursor", () => {
  const saveSource = source.slice(
    source.indexOf("function saveBuild()"),
    source.indexOf("function applySavedBuildInput("),
  );
  assert.match(saveSource, /getSelectedUnifiedEntry\(\)/);
  assert.doesNotMatch(saveSource, /allSolutions\s*\[\s*currentSolutionIdx\s*\]/);
  assert.match(saveSource, /if \(!saveBuildsToStorage\(builds\)\)/, "a failed write must be surfaced");
});

test("result-level actions resolve the same selection", () => {
  for (const name of ["exportInventorySolution", "equipInventorySolution"]) {
    const body = source.slice(source.indexOf(`async function ${name}(`)).split("\nasync function ")[0];
    assert.match(body, /resolveUnifiedEntry\(/, `${name} must resolve the unified selection`);
    assert.doesNotMatch(body, /allSolutions\s*\[\s*currentSolutionIdx\s*\]/);
  }
});

test("renderFarmingAdvice names Exotics by slot, never by class for regular armor", () => {
  assert.equal(
    context.resolveExoticPieceLabel({slot: "classItem"}, {classItemName: "Relativism"}),
    "Relativism",
  );
  assert.equal(
    context.resolveExoticPieceLabel({slot: "helmet", exotic: true, item: {name: "Celestial Nighthawk"}},
      {classItemName: "Relativism"}),
    "Celestial Nighthawk",
  );
  assert.equal(
    context.resolveExoticPieceLabel({slot: "legs", exotic: true}, {classItemName: "Relativism"}),
    "异域护甲",
  );
  assert.equal(
    context.resolveExoticPieceLabel({slot: "classItem", exotic: true}, {fallbackName: "Stoicism"}),
    "Stoicism",
  );
});
