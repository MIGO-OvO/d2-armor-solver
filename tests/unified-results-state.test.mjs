import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

// The unified result workspace projects two result shapes into one entry and
// decides which row stays selected. Both are pure over their inputs, so they
// are extracted and exercised directly instead of through the DOM.
const source = readFileSync(new URL("../src/app.mjs", import.meta.url), "utf8");

const context = vm.createContext({
  certifiedFeasible: result =>
    ["EXACT_TARGET_PROVEN", "RULE_FEASIBLE_PROVEN"].includes(result?.certificate?.status),
  // Theory projections are not part of these tests; the inventory list is.
  createOwnedArmorPlanRequest: () => null,
  rankInventoryPlans: () => [],
  SOLUTION_PREVIEW_COUNT: 1,
});

const api = vm.runInContext(`(() => {
  let ownedPlanRevision = 0;
  let inventorySolveRevision = 0;
  let inventoryResultRevision = 0;
  let unifiedCache = { key: null, solutions: null, entries: [] };
  let lastInventoryResult = null;
  let allSolutions = [];
  ${[
    "compareRankTuples",
    "unifiedPieceIdentity",
    "unifiedEntryKey",
    "compareUnifiedEntries",
    "normalizeInventoryEntry",
    "buildUnifiedLoadouts",
    "resolveSelectedRowIndex",
  ].map(name => source.slice(source.indexOf(`function ${name}(`)).split("\nfunction ")[0]).join("\n")}
  return {
    buildUnifiedLoadouts,
    normalizeInventoryEntry,
    resolveSelectedRowIndex,
    unifiedEntryKey,
    acceptInventory(result) {
      lastInventoryResult = result;
      inventoryResultRevision++;
    },
    revision() { return inventoryResultRevision; },
  };
})()`, context, {filename: "app-unified.mjs"});

function witness(id, overrides = {}) {
  return {
    pieces: [{slot: "helmet", sourceId: id}],
    certificate: {status: "EXACT_TARGET_PROVEN"},
    ...overrides,
  };
}

function inventoryResult(ids, search = null) {
  return {
    results: ids.map(id => witness(id)),
    search: search || {schemaVersion: 1, running: false, termination: "completed",
      coverage: {frontierComplete: true, assignmentComplete: true, statesExamined: 10}},
  };
}

const twelve = Array.from({length: 12}, (_, index) => `instance-${index}`);

// Regression: Progressive Top-K keeps maxResults entries while their content
// and order change, so a cache keyed on `results.length` served a stale list
// forever. The projection must key on the inventory result revision.
test("a progressive Top-K of the same length but different content updates the list", () => {
  // The projection runs inside a vm realm, so results are copied into this
  // realm before comparison.
  const ids = () => [...api.buildUnifiedLoadouts().map(entry => entry.pieces[0].sourceId)];
  api.acceptInventory(inventoryResult(twelve));
  assert.deepEqual(ids(), twelve);

  const reordered = [...twelve].reverse();
  api.acceptInventory(inventoryResult(reordered));
  assert.deepEqual(ids(), reordered, "the same 12 ids in a new order must reach the UI");

  const replaced = [...twelve.slice(1), "instance-new"];
  api.acceptInventory(inventoryResult(replaced));
  assert.deepEqual(ids(), replaced, "a replaced candidate must reach the UI");
  assert.equal(api.revision(), 3);
});

test("an unchanged inventory result is still served from the projection cache", () => {
  api.acceptInventory(inventoryResult(twelve));
  const first = api.buildUnifiedLoadouts();
  const second = api.buildUnifiedLoadouts();
  assert.equal(first, second, "no change must not re-project");
});

// --- Search metadata --------------------------------------------------------

test("inventory entries carry the collection's search metadata and coverage", () => {
  const search = {schemaVersion: 1, running: true, termination: null, nodes: 42,
    coverage: {frontierComplete: false, assignmentComplete: false, statesExamined: 128}};
  const entry = api.normalizeInventoryEntry(witness("i-1"), search);
  assert.equal(entry.search.running, true, "a running search must be visible on the entry");
  assert.equal(entry.search.coverage.frontierComplete, false);
  assert.equal(entry.search.coverage.assignmentComplete, false);
  assert.equal(entry.search.coverage.statesExamined, 128);
  assert.notEqual(entry.search.frontierComplete, false,
    "frontierComplete must never be read from the search root");

  const finished = api.normalizeInventoryEntry(witness("i-1"), undefined);
  assert.equal(finished.search, null, "an entry without search evidence stays null");
});

test("progressive and final results describe the same search on the same entry", () => {
  const progressive = inventoryResult(twelve, {schemaVersion: 1, running: true, termination: null,
    coverage: {frontierComplete: false, statesExamined: 30}});
  api.acceptInventory(progressive);
  assert.equal(api.buildUnifiedLoadouts()[0].search.running, true);
  const final = inventoryResult(twelve, {schemaVersion: 1, running: false, termination: "completed",
    coverage: {frontierComplete: true, assignmentComplete: true, statesExamined: 60}});
  api.acceptInventory(final);
  const entry = api.buildUnifiedLoadouts()[0];
  assert.equal(entry.search.running, false);
  assert.equal(entry.search.coverage.frontierComplete, true);
  assert.equal(entry.search.coverage.statesExamined, 60);
});

// --- Selection preservation -------------------------------------------------

const rows = ids => ids.map(id => ({pieces: [{slot: "helmet", sourceId: id}]}));

test("the selected plan survives a progressive refresh", () => {
  const before = rows(["a", "b", "c"]);
  const key = api.unifiedEntryKey(before[1]);
  const after = rows(["c", "b", "a"]);
  assert.equal(api.resolveSelectedRowIndex(after, key, 1), 1);
});

test("a plan that was eliminated falls back to a valid ordinal, never to nothing", () => {
  const view = rows(["a", "b", "c"]);
  const staleKey = api.unifiedEntryKey(rows(["gone"])[0]);
  assert.equal(api.resolveSelectedRowIndex(view, staleKey, 2), 2);
  assert.equal(api.resolveSelectedRowIndex(view, staleKey, 9), 2, "clamped into range");
  assert.equal(api.resolveSelectedRowIndex([], null, 3), -1);
  assert.equal(api.resolveSelectedRowIndex([], staleKey, 0), -1);
});

// --- Source contract: coverage fields are read from coverage ----------------

test("the advanced panel reads coverage.*, never a search root field", () => {
  const advanced = source.slice(
    source.indexOf("function renderAdvancedDetails("),
    source.indexOf("function renderSelectedLoadout("),
  );
  assert.match(advanced, /const coverage = search\?\.coverage \|\| \{\}/);
  assert.match(advanced, /coverage\.frontierComplete/);
  assert.match(advanced, /coverage\.assignmentComplete/);
  assert.match(advanced, /coverage\.statesExamined/);
  assert.doesNotMatch(advanced, /search\.frontierComplete/);
  assert.doesNotMatch(advanced, /search\.assignmentComplete/);
  assert.doesNotMatch(advanced, /window-entry|entry\.plan\?\.solution\?\.search/);
});

test("the unified projection never re-uses the theory cursor as the selection", () => {
  const actions = source.slice(
    source.indexOf("function syncCommandBarActions("),
    source.indexOf("function syncCommandBarActions(") + 1200,
  );
  assert.match(actions, /getSelectedUnifiedEntry\(\)/);
  assert.doesNotMatch(actions, /allSolutions\s*\[\s*currentSolutionIdx\s*\]/);
});
