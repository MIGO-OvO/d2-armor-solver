import assert from "node:assert/strict";
import test from "node:test";

import { ARCHETYPES, BASE_CONFIGS, STATS } from "../src/core/armor-model.mjs";
import { createProblemSpec, sealWitness, verifyWitness } from "../src/core/solver-v3-contract.mjs";
import {
  comparePlanMacroProfiles,
  createPlanMacroId,
  createPlanMacroProfile,
  getArmorModMultiset,
  getDirectionalTuningMultiset,
  getFrameworkMultiset,
  getPlus3Contribution,
  getTertiaryMultiset,
  isLegalFrameworkTertiaryPair,
  resolvePlanSlots,
  verifyMacroEquivalent,
} from "../src/core/plan-equivalence.mjs";

const SLOTS = ["helmet", "arms", "chest", "legs", "classItem"];

function legalTertiaries(archetypeId) {
  const definition = ARCHETYPES.find(entry => entry.id === archetypeId);
  return STATS.filter(stat => stat !== definition.primary && stat !== definition.secondary);
}

function baseConfig(archetypeId, tertiary) {
  const config = BASE_CONFIGS.find(entry => entry.archetype === archetypeId && entry.tertiary === tertiary);
  assert.ok(config, `illegal fixture pair ${archetypeId}/${tertiary}`);
  return config;
}

// A sealed theory witness: five (frame, tertiary) pairs, per-index tuning and
// mod assignments, certified against its own exact-target problem.
function buildWitness({ pairs, tuning, mods = {} } = {}) {
  const config = pairs.map(([archetypeId, tertiary], index) => ({
    ...baseConfig(archetypeId, tertiary), slot: SLOTS[index],
  }));
  const tuningAssignments = tuning.map(entry => entry.mode === "+3"
    ? { mode: "+3", from: null, to: null }
    : entry.mode === "none"
      ? { mode: "none", from: null, to: null }
      : { mode: "+5-5", from: entry.from, to: entry.to });
  const modAssignments = Object.fromEntries(config.map((_, index) => [index, mods[index] || null]));
  const totals = Object.fromEntries(STATS.map(stat => [stat, config.reduce((sum, piece, index) => {
    const assignment = tuningAssignments[index];
    const mod = modAssignments[index];
    const masterwork = STATS.filter(s => ![piece.primary, piece.secondary, piece.tertiary].includes(s));
    return sum + piece.baseStats[stat]
      + (assignment.mode === "+3" ? Number(masterwork.includes(stat)) : 0)
      + (assignment.mode === "+5-5"
        ? Number(assignment.to === stat) * 5 - Number(assignment.from === stat) * 5 : 0)
      + (mod ? Number(mod.stat === stat) * mod.size : 0);
  }, 0)]));
  const problem = createProblemSpec({
    target: totals,
    numPlus3: tuning.filter(entry => entry.mode === "+3").length,
    numPlus5: Object.values(mods).filter(mod => mod?.size === 5).length,
    numPlus10: Object.values(mods).filter(mod => mod?.size === 10).length,
    constraints: { exact: Object.fromEntries(STATS.map(stat => [stat, true])) },
  });
  const sealed = sealWitness(problem, {
    config, tuningAssignments, modAssignments, totals, exoticIndex: null,
  });
  assert.equal(sealed.valid, true, sealed.errors.join("; "));
  return sealed.witness;
}

test("tertiary legality follows the archetype's primary/secondary stats", () => {
  assert.equal(isLegalFrameworkTertiaryPair("Bulwark", "melee"), true);
  assert.equal(isLegalFrameworkTertiaryPair("Bulwark", "health"), false, "primary");
  assert.equal(isLegalFrameworkTertiaryPair("Bulwark", "class"), false, "secondary");
  assert.equal(isLegalFrameworkTertiaryPair("NotAnArchetype", "melee"), false);
  assert.equal(isLegalFrameworkTertiaryPair("Bulwark", "not-a-stat"), false);
});

test("resolvePlanSlots defaults raw configs and keeps sealed slots", () => {
  const raw = { config: [{}, {}, {}, {}, {}], exoticIndex: null };
  assert.deepEqual(resolvePlanSlots(raw), SLOTS);
  const exotic = { config: [{}, {}, {}, {}, {}], exoticIndex: 2 };
  assert.deepEqual(resolvePlanSlots(exotic), ["helmet", "arms", "classItem", "chest", "legs"]);
  const sealed = { config: SLOTS.map(() => ({ slot: "chest" })), exoticIndex: null };
  assert.deepEqual(resolvePlanSlots(sealed), ["chest", "chest", "chest", "chest", "chest"]);
});

test("multiset getters separate movable pieces from modifier invariants", () => {
  const witness = buildWitness({
    pairs: [["Bulwark", "melee"], ["Specialist", "health"], ["Brawler", "class"],
      ["Specialist", "super"], ["Bulwark", "grenade"]],
    tuning: [
      { mode: "+5-5", from: "health", to: "melee" },
      { mode: "+3" },
      { mode: "none" },
      { mode: "+5-5", from: "weapons", to: "super" },
      { mode: "none" },
    ],
    mods: { 1: { size: 10, stat: "grenade" }, 3: { size: 5, stat: "health" } },
  });
  assert.deepEqual(getFrameworkMultiset(witness), [["Brawler", 1], ["Bulwark", 2], ["Specialist", 2]]);
  assert.deepEqual(getTertiaryMultiset(witness),
    [["class", 1], ["grenade", 1], ["health", 1], ["melee", 1], ["super", 1]]);
  assert.deepEqual(getArmorModMultiset(witness), [["10:grenade", 1], ["5:health", 1]]);
  assert.deepEqual(getDirectionalTuningMultiset(witness), [["health>melee", 1], ["weapons>super", 1]]);
  const plus3 = getPlus3Contribution(witness);
  assert.equal(plus3.count, 1);
  // (Specialist, health): masterwork set = STATS \ {class, weapons, health}.
  assert.deepEqual(STATS.map(stat => plus3.vector[stat]),
    STATS.map(stat => ["melee", "grenade", "super"].includes(stat) ? 1 : 0));
});

test("a permuted and re-paired realization shares the macro id", () => {
  const source = buildWitness({
    pairs: [["Bulwark", "melee"], ["Bulwark", "grenade"], ["Specialist", "health"],
      ["Specialist", "super"], ["Brawler", "class"]],
    tuning: [
      { mode: "+5-5", from: "health", to: "melee" },
      { mode: "none" },
      { mode: "+3" },
      { mode: "+5-5", from: "weapons", to: "super" },
      { mode: "none" },
    ],
    mods: { 0: { size: 5, stat: "class" }, 2: { size: 10, stat: "grenade" } },
  });
  // Same framework and tertiary multisets with every pairing changed, pieces
  // at different slots, mods and directional Tuning on other configs, and the
  // +3 carried by the (Specialist, health) pair again — from a different slot.
  const variant = buildWitness({
    pairs: [["Specialist", "super"], ["Bulwark", "melee"], ["Specialist", "health"],
      ["Brawler", "class"], ["Bulwark", "grenade"]],
    tuning: [
      { mode: "+5-5", from: "weapons", to: "super" },
      { mode: "+5-5", from: "health", to: "melee" },
      { mode: "+3" },
      { mode: "none" },
      { mode: "none" },
    ],
    mods: { 1: { size: 10, stat: "grenade" }, 4: { size: 5, stat: "class" } },
  });
  assert.equal(verifyMacroEquivalent(source, variant), true);
  assert.equal(createPlanMacroId(source), createPlanMacroId(variant));
  const comparison = comparePlanMacroProfiles(source, variant);
  assert.deepEqual(comparison.differences, []);
  assert.deepEqual(STATS.map(stat => source.totals[stat]), STATS.map(stat => variant.totals[stat]));
});

test("each invariant violation is reported by name", () => {
  const source = buildWitness({
    pairs: [["Bulwark", "melee"], ["Bulwark", "grenade"], ["Specialist", "health"],
      ["Specialist", "super"], ["Brawler", "class"]],
    tuning: [
      { mode: "+5-5", from: "health", to: "melee" },
      { mode: "none" },
      { mode: "+3" },
      { mode: "none" },
      { mode: "none" },
    ],
    mods: { 2: { size: 5, stat: "super" } },
  });
  const frameChanged = buildWitness({
    pairs: [["Bulwark", "melee"], ["Siegebreaker", "super"], ["Specialist", "health"],
      ["Specialist", "super"], ["Brawler", "class"]],
    tuning: source.tuningAssignments.map(assignment => ({ ...assignment })),
    mods: { 2: { size: 5, stat: "super" } },
  });
  assert.equal(verifyMacroEquivalent(source, frameChanged), false);
  assert.ok(comparePlanMacroProfiles(source, frameChanged).differences.includes("frameworkMultiset"));

  const tertiaryChanged = buildWitness({
    pairs: [["Bulwark", "melee"], ["Bulwark", "grenade"], ["Specialist", "health"],
      ["Specialist", "melee"], ["Brawler", "class"]],
    tuning: source.tuningAssignments.map(assignment => ({ ...assignment })),
    mods: { 2: { size: 5, stat: "super" } },
  });
  assert.equal(verifyMacroEquivalent(source, tertiaryChanged), false);
  assert.ok(comparePlanMacroProfiles(source, tertiaryChanged).differences.includes("tertiaryMultiset"));

  const modChanged = buildWitness({
    pairs: [["Bulwark", "melee"], ["Bulwark", "grenade"], ["Specialist", "health"],
      ["Specialist", "super"], ["Brawler", "class"]],
    tuning: source.tuningAssignments.map(assignment => ({ ...assignment })),
    mods: { 2: { size: 5, stat: "class" } },
  });
  assert.equal(verifyMacroEquivalent(source, modChanged), false);
  assert.ok(comparePlanMacroProfiles(source, modChanged).differences.includes("armorModMultiset"));

  const directionalChanged = buildWitness({
    pairs: [["Bulwark", "melee"], ["Bulwark", "grenade"], ["Specialist", "health"],
      ["Specialist", "super"], ["Brawler", "class"]],
    tuning: [
      { mode: "+5-5", from: "health", to: "grenade" },
      { mode: "none" },
      { mode: "+3" },
      { mode: "none" },
      { mode: "none" },
    ],
    mods: { 2: { size: 5, stat: "super" } },
  });
  assert.equal(verifyMacroEquivalent(source, directionalChanged), false);
  assert.ok(comparePlanMacroProfiles(source, directionalChanged).differences.includes("directionalTuningMultiset"));

  // Same +3 count, different aggregate contribution: the marker moves from
  // (Specialist, health) to (Bulwark, melee), whose masterwork set differs.
  const plus3Moved = buildWitness({
    pairs: [["Bulwark", "melee"], ["Bulwark", "grenade"], ["Specialist", "health"],
      ["Specialist", "super"], ["Brawler", "class"]],
    tuning: [
      { mode: "+5-5", from: "health", to: "melee" },
      { mode: "none" },
      { mode: "none" },
      { mode: "none" },
      { mode: "+3" },
    ],
    mods: { 2: { size: 5, stat: "super" } },
  });
  assert.equal(plus3Moved.tuningAssignments.filter(a => a.mode === "+3").length, 1);
  assert.equal(verifyMacroEquivalent(source, plus3Moved), false);
  assert.ok(comparePlanMacroProfiles(source, plus3Moved).differences.includes("plus3Contribution"));
});

test("pinned pieces compare by exotic frame or source identity, not by ownership", () => {
  const source = buildWitness({
    pairs: [["Bulwark", "melee"], ["Bulwark", "grenade"], ["Specialist", "health"],
      ["Specialist", "super"], ["Brawler", "class"]],
    tuning: Array.from({ length: 5 }, () => ({ mode: "none" })),
  });
  const profile = createPlanMacroProfile(source, { fixedExotic: { slot: "helmet", hash: 9001 } });
  assert.equal(profile.pinnedPieces.length, 1);
  assert.equal(profile.pinnedPieces[0].kind, "exotic");
  assert.equal(profile.pinnedPieces[0].slot, "helmet");
  assert.equal(profile.pinnedPieces[0].hash, 9001);
  // Pinned via fixedExotic, the helmet leaves the movable multisets.
  assert.deepEqual(profile.frameworkMultiset, [["Brawler", 1], ["Bulwark", 1], ["Specialist", 2]]);

  // A source-bound legendary keeps its instance identity.
  const bound = structuredClone(source);
  bound.config = bound.config.map((piece, index) =>
    index === 1 ? { ...piece, sourceId: "vault-piece-17" } : piece);
  const boundProfile = createPlanMacroProfile(bound);
  assert.deepEqual(boundProfile.pinnedPieces,
    [{ kind: "source", slot: "arms", sourceId: "vault-piece-17", hash: null,
      archetypeId: "Bulwark", tertiary: "grenade",
      baseStats: boundProfile.pinnedPieces[0].baseStats }]);
});

// ============================================================
// DETERMINISTIC PROPERTY-STYLE DIFFERENTIAL
// ============================================================
// Random legal witnesses are permuted into macro-equivalent realizations
// (slot permutation, legal tertiary re-pairing, Tuning/mod redistribution)
// and every randomized mutation of one invariant must be rejected.

let rng = 0x5eed1eaf;
const random = max => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) % max);
const randomElement = list => list[random(list.length)];

function randomPairs() {
  const pairs = [];
  for (let index = 0; index < 5; index++) {
    const archetypeId = randomElement(ARCHETYPES).id;
    const tertiary = randomElement(legalTertiaries(archetypeId));
    pairs.push([archetypeId, tertiary]);
  }
  return pairs;
}

function randomTuning() {
  const plus3Count = random(3); // 0..2
  const modes = Array.from({ length: 5 }, (_, index) => index < plus3Count ? "+3" : "none");
  // Deterministic shuffle, then turn up to three `none` slots into shifts.
  for (let round = modes.length - 1; round > 0; round--) {
    const swap = random(round + 1);
    [modes[round], modes[swap]] = [modes[swap], modes[round]];
  }
  let shifts = random(4); // 0..3
  return modes.map(mode => {
    if (mode === "+3") return { mode: "+3" };
    if (shifts-- > 0) {
      const from = randomElement(STATS);
      const to = randomElement(STATS.filter(stat => stat !== from));
      return { mode: "+5-5", from, to };
    }
    return { mode: "none" };
  });
}

function randomMods() {
  const mods = {};
  for (let index = 0; index < 5; index++) {
    if (random(3) === 0) {
      mods[index] = { size: random(2) ? 10 : 5, stat: randomElement(STATS) };
    }
  }
  return mods;
}

// Build a macro-equivalent realization: permute the configs (Tuning travels
// with its config so the +3 contribution is carried by the same pair), then
// re-pair the tertiaries of two non-+3 pieces when the swap stays legal.
function permuteWitness(source) {
  const order = [0, 1, 2, 3, 4];
  for (let round = order.length - 1; round > 0; round--) {
    const swap = random(round + 1);
    [order[round], order[swap]] = [order[swap], order[round]];
  }
  const pairs = order.map(index => {
    const piece = source.config[index];
    return [piece.archetype, piece.tertiary];
  });
  const tuning = order.map(index => {
    const assignment = source.tuningAssignments[index];
    return assignment.mode === "+3" ? { mode: "+3" }
      : assignment.mode === "+5-5" ? { mode: "+5-5", from: assignment.from, to: assignment.to }
        : { mode: "none" };
  });
  // Legal tertiary re-pairing between two pieces that do not carry a +3.
  const eligible = [0, 1, 2, 3, 4].filter(index => tuning[index].mode !== "+3");
  if (eligible.length >= 2) {
    const [left, right] = eligible;
    const [leftFrame, leftTertiary] = pairs[left];
    const [rightFrame, rightTertiary] = pairs[right];
    if (leftFrame !== rightFrame
        && isLegalFrameworkTertiaryPair(leftFrame, rightTertiary)
        && isLegalFrameworkTertiaryPair(rightFrame, leftTertiary)) {
      pairs[left] = [leftFrame, rightTertiary];
      pairs[right] = [rightFrame, leftTertiary];
    }
  }
  // Redistribute the mod multiset over a permutation of distinct configs.
  const modList = [0, 1, 2, 3, 4]
    .map(index => source.modAssignments[index] ?? null).filter(Boolean);
  const targets = [0, 1, 2, 3, 4];
  for (let round = targets.length - 1; round > 0; round--) {
    const swap = random(round + 1);
    [targets[round], targets[swap]] = [targets[swap], targets[round]];
  }
  const mods = {};
  modList.forEach((mod, position) => { mods[targets[position]] = { ...mod }; });
  return buildWitness({ pairs, tuning, mods });
}

test("randomized macro permutations verify equivalent and mutations are rejected", () => {
  for (let iteration = 0; iteration < 40; iteration++) {
    const source = buildWitness({ pairs: randomPairs(), tuning: randomTuning(), mods: randomMods() });
    const variant = permuteWitness(source);

    const comparison = comparePlanMacroProfiles(source, variant);
    assert.equal(comparison.equal, true,
      `iteration ${iteration}: equivalent permutation rejected (${comparison.differences.join(",")})`);
    assert.equal(createPlanMacroId(source), createPlanMacroId(variant));
    assert.equal(verifyWitness(variant.problemSpec, variant).valid, true);
    assert.deepEqual(STATS.map(stat => variant.totals[stat]), STATS.map(stat => source.totals[stat]));

    // Mutating exactly one invariant must break the equivalence. A mutation
    // reports whether it actually applied; inapplicable draws (no shift to
    // alter, identical masterwork sets) are skipped rather than asserted.
    const mutations = {
      frameworkMultiset: witness => {
        const piece = witness.config[random(5)];
        const candidates = ARCHETYPES.filter(entry => entry.id !== piece.archetype
          && isLegalFrameworkTertiaryPair(entry.id, piece.tertiary));
        if (!candidates.length) return false;
        const other = randomElement(candidates);
        piece.archetype = other.id;
        piece.primary = other.primary;
        piece.secondary = other.secondary;
        piece.baseStats = { ...baseConfig(other.id, piece.tertiary).baseStats };
        piece.masterworkStats = baseConfig(other.id, piece.tertiary).masterworkStats;
        return true;
      },
      tertiaryMultiset: witness => {
        const piece = witness.config[random(5)];
        const alternatives = STATS.filter(stat => stat !== piece.tertiary);
        const tertiary = randomElement(alternatives);
        const config = baseConfig(piece.archetype, isLegalFrameworkTertiaryPair(piece.archetype, tertiary)
          ? tertiary : piece.tertiary === legalTertiaries(piece.archetype)[0]
            ? legalTertiaries(piece.archetype)[1] : legalTertiaries(piece.archetype)[0]);
        piece.tertiary = config.tertiary;
        piece.baseStats = { ...config.baseStats };
        piece.masterworkStats = config.masterworkStats;
        return true;
      },
      armorModMultiset: witness => {
        const index = random(5);
        const mod = witness.modAssignments[index];
        if (mod) mod.stat = randomElement(STATS.filter(stat => stat !== mod.stat));
        else witness.modAssignments[index] = { size: 5, stat: randomElement(STATS) };
        return true;
      },
      directionalTuningMultiset: witness => {
        const shifts = witness.tuningAssignments.filter(assignment => assignment.mode === "+5-5");
        if (!shifts.length) return false;
        const assignment = randomElement(shifts);
        assignment.to = randomElement(STATS.filter(stat => stat !== assignment.from && stat !== assignment.to));
        return true;
      },
      plus3Contribution: witness => {
        const plus3Indexes = witness.tuningAssignments
          .map((assignment, index) => assignment.mode === "+3" ? index : -1).filter(index => index >= 0);
        const otherIndexes = witness.tuningAssignments
          .map((assignment, index) => assignment.mode === "none" ? index : -1).filter(index => index >= 0);
        if (!plus3Indexes.length || !otherIndexes.length) return false;
        const from = plus3Indexes[0];
        const to = otherIndexes[0];
        const fromPiece = witness.config[from];
        const toPiece = witness.config[to];
        // Moving the +3 between different masterwork sets changes the vector.
        const fromMw = STATS.filter(stat => ![fromPiece.primary, fromPiece.secondary, fromPiece.tertiary].includes(stat));
        const toMw = STATS.filter(stat => ![toPiece.primary, toPiece.secondary, toPiece.tertiary].includes(stat));
        if (JSON.stringify(fromMw) === JSON.stringify(toMw)) return false;
        witness.tuningAssignments[from] = { mode: "none", from: null, to: null };
        witness.tuningAssignments[to] = { mode: "+3", from: null, to: null };
        return true;
      },
    };
    for (const [name, mutate] of Object.entries(mutations)) {
      const witness = structuredClone(variant);
      delete witness.canonicalId;
      if (!mutate(witness)) continue;
      const mutatedComparison = comparePlanMacroProfiles(source, witness);
      assert.equal(mutatedComparison.equal, false,
        `iteration ${iteration}: ${name} mutation must break equivalence`);
      assert.ok(mutatedComparison.differences.includes(name),
        `iteration ${iteration}: ${name} mutation reported ${mutatedComparison.differences.join(",")}`);
    }
  }
});
