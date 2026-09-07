import assert from "node:assert/strict";
import test from "node:test";
import { BASE_CONFIGS, STATS } from "../src/core/armor-model.mjs";
import { solveInventory, calculateReachability, solveLoadout } from "../src/core/armor-engine.mjs";
import { rankInventoryPlans } from "../src/core/inventory-plan.mjs";
import { createProblemSpec, verifyWitness } from "../src/core/solver-v3-contract.mjs";
import {createUpgradePieceFromItem} from "../src/core/upgrade-optimizer.mjs";

const SLOTS = ["helmet", "arms", "chest", "legs", "classItem"];
const ZERO = Object.fromEntries(STATS.map(stat => [stat, 0]));
const EXACT = Object.fromEntries(STATS.map(stat => [stat, true]));
const vector = values => Object.fromEntries(STATS.map((stat, i) => [stat, values[i]]));
function item(slot, index, config = BASE_CONFIGS[0], overrides = {}) {
  return {
    id: `${slot}-${String(index).padStart(3, "0")}`, hash: 1000 + SLOTS.indexOf(slot),
    name: `Audit ${slot} ${index}`, slot, classId: "hunter", tier: "5", exotic: false,
    archetypeId: config.archetype, tertiary: config.tertiary,
    baseStats: {...config.baseStats}, effectiveBaseStats: {...config.baseStats},
    optimizationBaseStats: {...config.baseStats}, masterworkTier: 5,
    tunedStat: "health", allowedTuningStats: ["health"], tuningMode: "plus3",
    tuningFrom: null, tuningTo: null, armorModSize: 0, armorModStat: "health",
    dataConfidence: {stats: "exact", tuning: "exact", sockets: "unknown"},
    ...overrides,
  };
}
function inventory(items, targets, overrides = {}) {
  return solveInventory({items, targets, fragments: ZERO, setRequirement: {type: "none"},
    reassignModifiers: false, userConstraints: {exact: EXACT}, ...overrides});
}

test("audit F1: late exact inventory witness survives the old frontier ceiling and ID relabeling", () => {
  const items = SLOTS.flatMap(slot => BASE_CONFIGS.slice(0, 37).map((config, i) => item(slot, i, config)));
  const target = vector([100, 30, 30, 30, 150, 125]);
  const result = inventory(items, target, {maxResults: 1});
  assert.equal(result.status, "EXACT_TARGET_PROVEN");
  assert.deepEqual(result.results[0].finalTotals, target);
  const renamed = items.map(entry => ({...entry, id: `${entry.slot}-${String(36 - Number(entry.id.slice(-3))).padStart(3, "0")}`}));
  assert.equal(inventory(renamed, target, {maxResults: 1}).status, "EXACT_TARGET_PROVEN");
});

test("audit F2: production reassignment finds an exact witness for the fixed five pieces", () => {
  const frames = [["Colossus", "melee"], ["Paragon", "health"], ["Grenadier", "health"],
    ["Demolitionist", "health"], ["Colossus", "melee"]];
  const items = SLOTS.map((slot, index) => item(slot, index,
    BASE_CONFIGS.find(config => config.archetype === frames[index][0] && config.tertiary === frames[index][1]), {
      tuningMode: "shift", tuningFrom: "health", tuningTo: index ? "super" : "weapons",
      tunedStat: index ? "super" : "weapons", allowedTuningStats: [index ? "super" : "weapons"],
      armorModSize: 10,
    }));
  const target = vector([110, 75, 70, 155, 40, 50]);
  const result = inventory(items, target, {reassignModifiers: true, onlyPlus5Tuning: true});
  assert.equal(result.status, "EXACT_TARGET_PROVEN");
  assert.deepEqual(result.results[0].finalTotals, target);
});

test("audit F3: hard-feasible mixed-rule candidates survive priority ranking and top one", () => {
  const a = vector([20, 10, 20, 20, 10, 10]);
  const b = vector([15, 30, 20, 5, 10, 10]);
  const make = (slot, index, stats) => item(slot, index, BASE_CONFIGS[0], {
    baseStats: stats, effectiveBaseStats: stats, optimizationBaseStats: stats,
    tuningMode: "shift", tuningInstalled: false, tuningTo: "health",
  });
  const items = [...SLOTS.map(slot => make(slot, 0, a)), make("helmet", 1, b)];
  const result = inventory(items, vector([100, 150, 100, 100, 50, 50]), {
    userConstraints: {exact: {health: true}, priorityLevels: {melee: 1}}, maxResults: 1,
  });
  assert.equal(result.status, "RULE_FEASIBLE_PROVEN");
  assert.equal(result.results[0].finalTotals.health, 100);
});

test("audit F4: derived masterwork and numeric strings cannot authorize false infeasibility", () => {
  const fixed = {...BASE_CONFIGS[0]};
  delete fixed.masterworkStats;
  const target = vector([150, 100, 125, 30, 30, 30]);
  for (const count of [5, "5"]) {
    const result = calculateReachability({fixedPiece: fixed, numPlus5: 0, numPlus10: 0, numPlus3: count,
      fragments: ZERO, lockedTargets: target, probeTarget: target});
    assert.equal(result.status, "EXACT_TARGET_PROVEN");
    assert.equal(result.feasible, true);
  }
  const spec = createProblemSpec({operation: "calculateReachability", target, targetDomain: "visible",
    constraints: {exact: EXACT}, pieces: [fixed], numPlus3: 5});
  assert.equal(verifyWitness(spec, {config: Array(5).fill(BASE_CONFIGS[0]),
    tuningAssignments: Array.from({length: 5}, () => ({mode: "+3", from: null, to: null})), modAssignments: {}}).valid, true);
});

test("audit F4: an independent probe cannot override contradictory locks", () => {
  const result = calculateReachability({fixedPiece: BASE_CONFIGS[0], numPlus5: 0, numPlus10: 0, numPlus3: 5,
    fragments: ZERO, lockedTargets: {health: 1}, probeTarget: vector([150, 100, 125, 30, 30, 30])});
  assert.notEqual(result.status, "EXACT_TARGET_PROVEN");
  assert.equal(result.feasible, false);
});

test("audit F4: execution evidence cannot prove unknown mathematical data infeasible", () => {
  const items = SLOTS.map((slot, index) => item(slot, index, BASE_CONFIGS[0], {
    tuningConfidence: "exact", dataConfidence: {stats: "unknown", tuning: "exact"},
    sockets: [{socketIndex: 0, role: "tuning", candidateState: "known", candidatePlugHashes: []}],
    energy: {capacity: 10, used: 0},
  }));
  const result = inventory(items, vector([151, 100, 125, 30, 30, 30]));
  assert.notEqual(result.status, "INFEASIBLE_PROVEN");
  assert.equal(result.certificate.proof.complete, false);
});

test("normalized numeric strings in physical vectors share the numeric inventory domain", () => {
  const items = SLOTS.map((slot, index) => item(slot, index));
  const strings = items.map(entry => ({...entry, ...Object.fromEntries(
    ["baseStats", "effectiveBaseStats", "optimizationBaseStats"].map(key =>
      [key, Object.fromEntries(STATS.map(stat => [stat, String(entry[key][stat])]))]))}));
  const target = vector([150, 100, 125, 30, 30, 30]);
  assert.equal(inventory(strings, target).status, "EXACT_TARGET_PROVEN");
  assert.deepEqual(inventory(strings, target).results[0].finalTotals, inventory(items, target).results[0].finalTotals);
});

test("unverifiable exact candidates cannot consume Top-K or the exact witness quota", () => {
  const items = SLOTS.map((slot, index) => item(slot, index));
  const bad = {...items[0], id: "aaa-unknown", dataConfidence: {stats: "unknown", tuning: "exact"}};
  const result = inventory([bad, ...items], vector([150, 100, 125, 30, 30, 30]), {maxResults: 1});
  assert.equal(result.status, "EXACT_TARGET_PROVEN");
  assert.equal(result.results.length, 1);
  assert.notEqual(result.results[0].pieces[0].sourceId, bad.id);
});

test("stale current modifier assignments cannot hide the same real inventory identities", () => {
  const items = SLOTS.map((slot, index) => item(slot, index, BASE_CONFIGS[0], {armorModSize: 10}));
  const stale = items.map((entry, index) => ({...createUpgradePieceFromItem(entry, index), armorModStat: "melee"}));
  const result = inventory(items, vector([200, 100, 125, 30, 30, 30]), {currentPieces: stale, maxResults: 1});
  assert.equal(result.status, "EXACT_TARGET_PROVEN");
  stale[0].locked = true;
  assert.equal(inventory(items, vector([200, 100, 125, 30, 30, 30]), {currentPieces: stale, maxResults: 1}).status,
    "EXACT_TARGET_PROVEN", "a locked identity must resolve its assignment from the inventory source");
});

test("clamped 200 target searches the armor preimage, not only armor=200", () => {
  const target = vector([200, 75, 125, 25, 25, 25]);
  const solved = solveLoadout({target, targetDomain: "visible", fragments: ZERO,
    numPlus3: 0, numPlus5: 0, numPlus10: 5, constraints: {exact: EXACT}});
  assert.equal(solved.status, "EXACT_TARGET_PROVEN");
  assert.equal(solved[0].armorTotals.health, 225);
  assert.deepEqual(solved[0].visibleTotals, target);
  const probed = calculateReachability({fixedPiece: BASE_CONFIGS[0], numPlus3: 0, numPlus5: 0, numPlus10: 5,
    fragments: ZERO, lockedTargets: {}, probeTarget: target});
  assert.equal(probed.status, "EXACT_TARGET_PROVEN");
  assert.equal(probed.certificate.witnessVerification.valid, true);
});

test("fixed-five rule search retains partial hard exact rules beside a higher soft priority", () => {
  const frames = [["Specialist", "grenade"], ["Paragon", "grenade"], ["Brawler", "grenade"], ["Bulwark", "weapons"], ["Brawler", "class"]];
  const to = ["melee", "health", "super", "grenade", "super"];
  const from = ["weapons", "grenade", "health", "health", "grenade"];
  const mods = ["weapons", "melee", "weapons", "melee", "weapons"];
  const items = SLOTS.map((slot, index) => item(slot, index,
    BASE_CONFIGS.find(config => config.archetype === frames[index][0] && config.tertiary === frames[index][1]), {
      tuningMode: "shift", tunedStat: to[index], allowedTuningStats: [to[index]], tuningTo: to[index], tuningFrom: from[index],
      armorModSize: 10, armorModStat: mods[index],
    }));
  const result = inventory(items, vector([95, 156, 97, 60, 85, 55]), {reassignModifiers: true,
    onlyPlus5Tuning: true, userConstraints: {exact: {health: true}, priorityLevels: {melee: 1}}});
  assert.equal(result.status, "RULE_FEASIBLE_PROVEN");
  assert.equal(result.results[0].finalTotals.health, 95);
});

test("fixed-five interval assignment finds an exact target beyond the first eight clamp preimages", () => {
  const frames = [["Gunner", "class"], ["Specialist", "grenade"], ["Gunner", "class"], ["Gunner", "super"], ["Grenadier", "weapons"]];
  const to = ["class", "super", "health", "melee", "health"];
  const from = ["grenade", "grenade", "super", "weapons", "grenade"];
  const mods = ["grenade", "class", "class", "health", "class"];
  const items = SLOTS.map((slot, index) => item(slot, index,
    BASE_CONFIGS.find(config => config.archetype === frames[index][0] && config.tertiary === frames[index][1]), {
      tuningMode: "shift", tunedStat: to[index], allowedTuningStats: [to[index]], tuningTo: to[index], tuningFrom: from[index],
      armorModSize: 10, armorModStat: mods[index],
    }));
  const target = vector([0, 0, 120, 70, 105, 140]);
  const result = inventory(items, target, {reassignModifiers: true, onlyPlus5Tuning: true, fragments: vector([-60, -60, 0, 0, 0, 0])});
  assert.equal(result.status, "EXACT_TARGET_PROVEN");
  assert.deepEqual(result.results[0].finalTotals, target);
});

test("interval reachability caches cannot replay a prior fixed physical identity", () => {
  const target = vector([150, 100, 125, 0, 0, 30]);
  const fragments = vector([0, 0, 0, -40, -40, 0]);
  for (const sourceId of ["first", "second"]) {
    const result = calculateReachability({fixedPiece: {...BASE_CONFIGS[0], sourceId, hash: 1},
      numPlus3: 5, numPlus5: 0, numPlus10: 0, fragments, lockedTargets: target, probeTarget: target});
    assert.equal(result.status, "EXACT_TARGET_PROVEN");
    assert.equal(result.probe.witness.config[0].sourceId, sourceId);
  }
});

test("force0 and partial exact rules share the fixed-five armor-domain bounds", () => {
  const frames = [["Gunner", "health"], ["Demolitionist", "weapons"], ["Colossus", "class"], ["Siegebreaker", "super"], ["Paragon", "health"]];
  const to = ["weapons", "health", "melee", "grenade", "weapons"];
  const from = ["melee", "grenade", "weapons", "weapons", "grenade"];
  const mods = ["super", "weapons", "super", "weapons", "melee"];
  const items = SLOTS.map((slot, index) => item(slot, index,
    BASE_CONFIGS.find(config => config.archetype === frames[index][0] && config.tertiary === frames[index][1]), {
      tuningMode: "shift", tunedStat: to[index], allowedTuningStats: [to[index]], tuningTo: to[index], tuningFrom: from[index],
      armorModSize: 10, armorModStat: mods[index],
    }));
  const target = vector([100, 86, 95, 95, 55, 80]);
  const result = inventory(items, target, {reassignModifiers: true, onlyPlus5Tuning: true,
    fragments: vector([-120, 0, 0, 0, 0, 0]), userConstraints: {force0: {health: true},
      exact: {grenade: true, super: true, class: true, weapons: true}, priorityLevels: {melee: 1}}});
  assert.equal(result.status, "RULE_FEASIBLE_PROVEN");
  assert.equal(result.results[0].finalTotals.health, 0);
  for (const stat of ["grenade", "super", "class", "weapons"]) assert.equal(result.results[0].finalTotals[stat], target[stat]);
});

test("ownership matching compresses irrelevant execution variants without losing a set solution", () => {
  const config = Array(5).fill(BASE_CONFIGS[0]);
  const solution = {config, tuningAssignments: config.map(() => ({mode: "+3", from: null, to: null})),
    modAssignments: {}, totals: vector([150, 100, 125, 30, 30, 30]), exoticIndex: null};
  const items = SLOTS.flatMap(slot => Array.from({length: 40}, (_, index) => item(slot, index, BASE_CONFIGS[0], {
    setHash: 111, sockets: [{socketIndex: 0, candidatePlugHashes: [index]}],
  })));
  const started = performance.now();
  const plan = rankInventoryPlans({solutions: [solution], items, setRequirement: {type: "set", setHash: 999, count: 4}})[0];
  assert.equal(plan.farmCount, 4);
  assert.equal(plan.feasible, true);
  assert.ok(performance.now() - started < 2000);
});

test("audit F5: match theoretical multiset to physical slots without changing its assignment", () => {
  const config = [0, 4, 8, 12, 16].map(index => BASE_CONFIGS[index]);
  const items = SLOTS.map((slot, index) => item(slot, index, config[(index + 1) % 5]));
  const solution = {config, totals: vector([125, 106, 87, 49, 49, 49]),
    tuningAssignments: config.map(() => ({mode: "+3", from: null, to: null})),
    modAssignments: {}, exoticIndex: null, rank: [0, 0, 0, 0, 0, 0], score: 0};
  const before = structuredClone(solution);
  const plan = rankInventoryPlans({solutions: [solution], items})[0];
  assert.equal(plan.farmCount, 0);
  assert.equal(plan.ownedCount, 5);
  assert.equal(plan.feasible, true);
  assert.deepEqual(solution, before, "matching must not mutate a sealed source witness");
});
