import assert from "node:assert/strict";
import test from "node:test";

import { ARCHETYPES, BASE_CONFIGS, STATS as STAT_IDS, createExoticConfig } from "../src/core/armor-model.mjs";
import { rankInventoryPlans, assignmentCanReachExact, sourceSatisfiesRules } from "../src/core/inventory-plan.mjs";
import { runSolver } from "../src/core/solver.mjs";
import { createProblemSpec, verifyWitness, satisfiesConstraintModel, sealWitness } from "../src/core/solver-v3-contract.mjs";
import { verifyMacroEquivalent } from "../src/core/plan-equivalence.mjs";
import { normalizeDimItem, parseCsv } from "../src/core/dim-csv.mjs";
import {
  MACRO_SLOTS, MACRO_TINY_RESIDUAL, macroConfig, macroTotals,
  buildMacroSolution, buildVaultPiece, assertMacroOwnedPlan,
} from "./helpers/macro-fixtures.mjs";

const SLOT_ORDER = ["helmet", "arms", "chest", "legs", "classItem"];

function makeSolution(configs = BASE_CONFIGS.slice(0, 5), exoticIndex = null) {
  return {
    config: configs,
    tuningAssignments: configs.map((_, index) => ({
      mode: "+5-5",
      from: "health",
      to: index % 2 === 0 ? "melee" : "grenade",
    })),
    modAssignments: Object.fromEntries(configs.map((_, index) => [index, null])),
    totals: Object.fromEntries(STAT_IDS.map(stat => [stat, configs.reduce((sum, c, index) =>
      sum + c.baseStats[stat] + (stat === 'health' ? -5 : stat === (index % 2 === 0 ? 'melee' : 'grenade') ? 5 : 0), 0)])),
    score: 0,
    exoticIndex,
  };
}

function makeItem(solution, index, overrides = {}) {
  const config = solution.config[index];
  const tuning = solution.tuningAssignments[index];
  const archetypeId = ARCHETYPES.find(archetype => archetype.id === config.archetype).id;
  return {
    id: `item-${index}`,
    hash: 1000 + index,
    name: `Item ${index}`,
    slot: SLOT_ORDER[index],
    classId: "hunter",
    tier: "5",
    exotic: false,
    archetypeId,
    tertiary: config.tertiary,
    tuningMode: tuning.mode === "+3" ? "plus3" : "shift",
    tuningTo: tuning.to,
    tunedStat: tuning.to,
    allowedTuningStats: [...STAT_IDS],
    baseStats: {...config.baseStats},
    effectiveBaseStats: {...config.baseStats},
    optimizationBaseStats: {...config.baseStats},
    setHash: null,
    ...overrides,
  };
}

test("inventory plans count exact owned identities before farming gaps", () => {
  const solution = makeSolution();
  const items = [0, 1, 2].map(index => makeItem(solution, index));
  const [plan] = rankInventoryPlans({ solutions: [solution], items, classId: "hunter" });

  assert.equal(plan.ownedCount, 3);
  assert.equal(plan.farmCount, 2);
  assert.deepEqual(
    plan.pieces.filter(piece => piece.item).map(piece => piece.slot),
    ["helmet", "arms", "chest"],
  );
});

test('an empty-tuning witness retains all five owned pieces instead of farming them', () => {
  const solution = makeSolution();
  solution.tuningAssignments = solution.config.map(() => ({mode: 'none', from: null, to: null}));
  solution.totals = Object.fromEntries(STAT_IDS.map(stat => [stat,
    solution.config.reduce((sum, config) => sum + config.baseStats[stat], 0)]));
  const items = solution.config.map((_, index) => makeItem(solution, index, {tuningMode: 'none', tuningInstalled: false}));
  const [plan] = rankInventoryPlans({solutions: [solution], items, classId: 'hunter'});
  assert.equal(plan.ownedCount, 5);
  assert.equal(plan.farmCount, 0);
  assert.equal(plan.feasible, true);
});

test('an unowned Exotic reservation cannot be filled by owned Legendary or Exotic armor', () => {
  const solution = makeSolution();
  const items = solution.config.map((_, index) => makeItem(solution, index));
  items.push(makeItem(solution, 2, { id: 'other-exotic', exotic: true, name: 'Other Exotic' }));
  const [plan] = rankInventoryPlans({ solutions: [solution], items, classId: 'hunter',
    fixedExotic: { reserved: true, slot: 'chest', classId: 'hunter' },
    setRequirement: { type: 'none' },
  });
  const chest = plan.pieces.find(piece => piece.slot === 'chest');
  assert.equal(chest.exotic, true);
  assert.equal(chest.item, null);
  assert.equal(chest.closestItem, null);
  assert.equal(chest.farmSetHash, null);
  assert.equal(plan.ownedCount, 4);
});

test("target quality outranks matching more owned armor", () => {
  const better = {
    ...makeSolution(BASE_CONFIGS.slice(0, 5)),
    rank: [0, 0, 0, 0, 0, 0],
    score: 0,
  };
  const worse = {
    ...makeSolution(BASE_CONFIGS.slice(5, 10)),
    rank: [0, 25, 0, 0, 0, 75],
    score: 25,
  };
  const items = worse.config.map((_, index) => makeItem(worse, index, {
    id: `worse-${index}`,
    setHash: 741162535,
  }));

  const [plan] = rankInventoryPlans({
    solutions: [better, worse],
    items,
    classId: "hunter",
    setRequirement: { type: "set", setHash: 741162535, count: 4 },
  });

  assert.equal(plan.solution, better,
    "owned-piece savings must only break ties between equally good stat plans");
});

test("a fixed regular Exotic slot rejects a matching Legendary and recommends farming", () => {
  const solution = makeSolution();
  const legendaryHelmet = makeItem(solution, 0);
  const fixedExotic = {
    classId: "hunter",
    slot: "helmet",
    hash: 9001,
    name: "Selected Exotic",
  };
  const [missingPlan] = rankInventoryPlans({
    solutions: [solution],
    items: [legendaryHelmet],
    classId: "hunter",
    fixedExotic,
  });
  assert.equal(missingPlan.ownedCount, 0);
  assert.equal(missingPlan.pieces[0].exotic, true);
  assert.equal(missingPlan.pieces[0].item, null);

  const [ownedPlan] = rankInventoryPlans({
    solutions: [solution],
    items: [{
      ...legendaryHelmet,
      id: "exotic-helmet",
      hash: fixedExotic.hash,
      name: fixedExotic.name,
      exotic: true,
    }],
    classId: "hunter",
    fixedExotic,
  });
  assert.equal(ownedPlan.ownedCount, 1);
  assert.equal(ownedPlan.pieces[0].item.exotic, true);
});

test("set farming never assigns a regular set to the fixed Exotic slot", () => {
  const solution = makeSolution();
  const items = [0, 1, 2, 3, 4].map(index => makeItem(solution, index));
  const setHash = 741162535;
  const fixedExotic = {
    classId: "hunter",
    slot: "helmet",
    hash: 9001,
    name: "Selected Exotic",
  };
  const [plan] = rankInventoryPlans({
    solutions: [solution],
    items,
    classId: "hunter",
    fixedExotic,
    setRequirement: { type: "set", setHash, count: 4 },
  });

  assert.equal(plan.farmCount, 5);
  assert.equal(plan.pieces[0].exotic, true);
  assert.equal(plan.pieces[0].farmSetHash, null);
  assert.equal(plan.pieces.filter(piece => piece.farmSetHash === setHash).length, 4);
});

test("a named Exotic with unknown directional capability is not treated as usable", () => {
  const solution = makeSolution();
  const fixedExotic = {
    classId: "hunter",
    slot: "helmet",
    hash: 9001,
    name: "Selected Exotic",
  };
  // A +3 assignment alone does not reveal which directional destinations the
  // Exotic supports, so neither copy is a verified match for this solution.
  const closeRoll = makeItem(solution, 0, {
    id: "close-roll",
    hash: fixedExotic.hash,
    name: fixedExotic.name,
    exotic: true,
    dataConfidence: { tuning: "unknown" },
    tuningMode: "plus3",
    tuningTo: null,
  });
  const farRoll = makeItem(solution, 0, {
    id: "far-roll",
    hash: fixedExotic.hash,
    name: fixedExotic.name,
    exotic: true,
    archetypeId: "Bulwark",
    tertiary: "class",
    tuningMode: "plus3",
    tuningTo: null,
  });
  const legendaryPieces = [1, 2, 3, 4].map(index => makeItem(solution, index));
  const [plan] = rankInventoryPlans({
    solutions: [solution],
    items: [farRoll, closeRoll, ...legendaryPieces],
    classId: "hunter",
    fixedExotic,
  });

  assert.equal(plan.farmCount, 1);
  assert.equal(plan.pieces[0].item, null);
  assert.equal(plan.pieces[0].closestItem.id, "close-roll");
  assert.deepEqual(plan.pieces[0].closestMismatch.fields, ["tuningCapability"]);
});

test("a named Exotic can change assignment without changing owned identity", () => {
  const solution = makeSolution();
  const fixedExotic = {
    classId: "hunter",
    slot: "helmet",
    hash: 9001,
    name: "Selected Exotic",
  };
  const flexibleRoll = makeItem(solution, 0, {
    id: "flexible-roll",
    hash: fixedExotic.hash,
    name: fixedExotic.name,
    exotic: true,
    allowedTuningStats: [...STATS],
    tuningMode: "plus3",
    tuningTo: null,
  });
  const legendaryPieces = [1, 2, 3, 4].map(index => makeItem(solution, index));
  const [plan] = rankInventoryPlans({
    solutions: [solution],
    items: [flexibleRoll, ...legendaryPieces],
    classId: "hunter",
    fixedExotic,
  });

  assert.equal(plan.farmCount, 0);
  assert.equal(plan.pieces[0].item.id, "flexible-roll");
});

test("Exotic Class Item solutions map the fixed config to the class item slot", () => {
  const configs = BASE_CONFIGS.slice(0, 5);
  const solution = makeSolution(configs, 0);
  const classItem = makeItem(solution, 0, {
    id: "class-exotic",
    slot: "classItem",
    exotic: true,
  });
  const [plan] = rankInventoryPlans({
    solutions: [solution],
    items: [classItem],
    classId: "hunter",
  });

  assert.equal(plan.pieces[0].slot, "classItem");
  assert.equal(plan.pieces[0].item.id, "class-exotic");
  assert.deepEqual(plan.pieces.slice(1).map(piece => piece.slot), ["helmet", "arms", "chest", "legs"]);
});

test("a bound constraint model decides whether an owned plan qualifies", () => {
  const satisfying = makeSolution();
  const problemSpec = createProblemSpec({
    operation: "solve",
    target: satisfying.totals,
    constraints: {exact: Object.fromEntries(STAT_IDS.map(stat => [stat, true]))},
    numPlus5: 0, numPlus10: 0, numPlus3: 0,
    pieces: [],
  });
  satisfying.problemSpec = problemSpec;
  const items = [0, 1, 2, 3, 4].map(index => makeItem(satisfying, index));
  const [qualifying] = rankInventoryPlans({solutions: [satisfying], items, classId: "hunter"});
  assert.equal(qualifying.rulesFeasible, true);
  assert.equal(qualifying.feasible, true);

  // A near-miss incumbent reproduces its own totals exactly but violates the
  // bound rules; reproducing the arithmetic must not present it as a
  // qualifying owned plan under the same rule set.
  const nearMiss = makeSolution(BASE_CONFIGS.slice(5, 10));
  nearMiss.problemSpec = problemSpec;
  const nearItems = [0, 1, 2, 3, 4].map(index => makeItem(nearMiss, index));
  assert.equal(sourceSatisfiesRules(nearMiss), false);
  const [repaired] = rankInventoryPlans({solutions: [nearMiss], items: nearItems, classId: "hunter"});
  // The old test assumed a near-miss source ruled out every alternative final
  // loadout. It must still fail itself, but a newly proved residual plan may
  // qualify. Check the new evidence, not a label on the old witness.
  assert.equal(repaired.feasible, true);
  assert.notEqual(repaired.matchedSolution, nearMiss);
  assert.equal(verifyWitness(repaired.matchedSolution.problemSpec, repaired.matchedSolution).valid, true);
  assert.equal(satisfiesConstraintModel(repaired.matchedSolution, problemSpec.constraintModel), true);
  assert.equal(sourceSatisfiesRules(nearMiss), false);
});

// ============================================================
// REAL SOLUTIONS: fixed +5 roll matching is decided by feasibility
// ============================================================
const EXOTIC_PRIMARY = {
  id: "assassin", name: "Spirit of the Assassin", primary: "melee",
  secondary: "health", archetype: "Brawler",
};
const EXOTIC_SECONDARY = {
  id: "cyrtarachne", name: "Spirit of the Cyrtarachne", order: ["grenade", "health"],
};
const EXOTIC_SETTINGS = {
  classId: "hunter", classLabel: "Hunter", itemHash: 2809120022,
  primaryPerkId: "assassin", secondaryPerkId: "cyrtarachne",
  priorityOrder: [], config: createExoticConfig(EXOTIC_PRIMARY, EXOTIC_SECONDARY),
};
const SOLVE_TARGET = { health: 90, melee: 60, grenade: 45, super: 75, class: 60, weapons: 120 };

function solveExoticSolution() {
  return runSolver(createProblemSpec({
    target: SOLVE_TARGET,
    numPlus5: 0,
    numPlus10: 0,
    numPlus3: 0,
    pieces: [EXOTIC_SETTINGS.config],
    exoticSettings: EXOTIC_SETTINGS,
  }))[0];
}

// Capability-negative fixtures must actually require directional Tuning.
// The production solver now legitimately chooses empty sockets for some
// exact targets, so changing an unused rolled direction is not a mismatch.
function directionalExoticSolution() {
  const solution = makeSolution([EXOTIC_SETTINGS.config, ...BASE_CONFIGS.slice(0, 4)], 0);
  solution.tuningAssignments = solution.config.map(() => ({mode: '+5-5', from: 'health', to: 'melee'}));
  solution.totals = Object.fromEntries(STAT_IDS.map(stat => [stat,
    solution.config.reduce((sum, config) => sum + config.baseStats[stat], 0)
      + (stat === 'health' ? -25 : stat === 'melee' ? 25 : 0)]));
  const problem = createProblemSpec({target: solution.totals,
    constraints: {exact: Object.fromEntries(STAT_IDS.map(stat => [stat, true]))},
    exoticSettings: EXOTIC_SETTINGS});
  assert.equal(verifyWitness(problem, solution).valid, true, 'directional fixture must be a legal concrete witness');
  return solution;
}

const DIM_HEADER = [
  "Name", "Hash", "Id", "Rarity", "Tier", "Type", "Equippable", "Archetype",
  "Tertiary Stat", "Tuning Stat", "Masterwork Tier", "Owner", "Equipped", "Power",
  "Weapons", "Health", "Class", "Grenade", "Super", "Melee", "Total",
  "Weapons (Base)", "Health (Base)", "Class (Base)", "Grenade (Base)",
  "Super (Base)", "Melee (Base)", "Total (Base)",
].join(",");

// Relativism with the Assassin/Cyrtarachne frame (Brawler: melee 30 / health
// 25 / grenade 20), tier 5, +5 melee / -5 health Tuning installed. The DIM
// Archetype column is empty for Exotic Class Items.
const DIM_EXOTIC_CLASS_ITEM_ROW = [
  "Relativism", "2809120022", "relativism-1", "Exotic", "5", "猎人披风", "猎人",
  "", "", "", "5", "Vault", "false", "500",
  // Raw non-framework values are 0; tier-5 masterwork raises them to 5.
  // This fixture must physically match the solver's 90-point config, not 105.
  "5", "20", "5", "20", "5", "35", "90",
  "0", "25", "0", "20", "0", "30", "75",
].join(",");

function makeExoticClassItemFromDIM() {
  return normalizeDimItem(parseCsv([DIM_HEADER, DIM_EXOTIC_CLASS_ITEM_ROW].join("\n"))[0]);
}

function makeOwnedLegendary(solution, index, tuningTo) {
  const config = solution.config[index];
  // Index 0 is the Exotic Class Item slot; legendary indices 1-4 map to
  // helmet/arms/chest/legs.
  const slot = SLOT_ORDER[index - 1];
  return {
    id: `owned-leg-${index}`,
    hash: 1000 + index,
    name: `Owned Legendary ${index}`,
    slot,
    classId: "hunter",
    tier: "5",
    exotic: false,
    archetypeId: ARCHETYPES.find(archetype => archetype.id === config.archetype)?.id,
    tertiary: config.tertiary,
    tuningMode: "shift",
    tuningTo,
    baseStats: config.baseStats,
    setHash: null,
  };
}

const STATS = ["health", "melee", "grenade", "super", "class", "weapons"];
function rotatedRolls(solution, offset) {
  return [1, 2, 3, 4].map(index => {
    const wanted = solution.tuningAssignments[index].to;
    const config = solution.config[index];
    // A different destination in the original slot can now legitimately match
    // another slot. This negative fixture must conflict with every equal base.
    const used = new Set(solution.config.flatMap((other, otherIndex) =>
      STATS.every(stat => other.baseStats[stat] === config.baseStats[stat])
        ? [solution.tuningAssignments[otherIndex].to] : []));
    const destination = Array.from({length: 6}, (_, step) => STATS[(STATS.indexOf(wanted) + offset + step) % 6])
      .find(stat => !used.has(stat));
    return makeOwnedLegendary(solution, index, destination);
  });
}

test("a DIM-imported Exotic Class Item matches its solution slot", () => {
  const solution = solveExoticSolution();
  const classItem = makeExoticClassItemFromDIM();
  const legendaryPieces = [1, 2, 3, 4].map(index =>
    makeOwnedLegendary(solution, index, solution.tuningAssignments[index].to)
  );
  const [plan] = rankInventoryPlans({
    solutions: [solution],
    items: [classItem, ...legendaryPieces],
    classId: "hunter",
  });

  assert.equal(plan.ownedCount, 5);
  assert.equal(plan.farmCount, 0);
  assert.equal(plan.pieces[0].item.id, "relativism-1");
  assert.equal(plan.feasible, true);
});

test("legendary pieces whose +5 roll differs from the solution are downgraded to farm", () => {
  const solution = directionalExoticSolution();
  const classItem = makeExoticClassItemFromDIM();
  // Helmet is missing; the three provided legendary pieces all rolled a +5
  // that differs from the solution, so every legendary slot must farm.
  const ownedArmsChestLegs = rotatedRolls(solution, 5).slice(1);
  const [plan] = rankInventoryPlans({
    solutions: [solution],
    items: [classItem, ...ownedArmsChestLegs],
    classId: "hunter",
  });

  assert.equal(plan.ownedCount, 1);
  assert.equal(plan.farmCount, 4);
  assert.equal(plan.pieces.find(piece => piece.item)?.slot, "classItem");
});

test("every legendary slot with a mismatched +5 roll is farmed, not kept", () => {
  const solution = directionalExoticSolution();
  const classItem = makeExoticClassItemFromDIM();
  // All five owned, but all four legendary pieces rolled the wrong +5, so they
  // cannot serve the solution's shift requirements and are farmed instead.
  const allOwned = [classItem, ...rotatedRolls(solution, 1)];
  const [plan] = rankInventoryPlans({
    solutions: [solution],
    items: allOwned,
    classId: "hunter",
  });

  assert.equal(plan.ownedCount, 1);
  assert.equal(plan.farmCount, 4);
  assert.deepEqual(
    plan.pieces.filter(piece => !piece.item).map(piece => piece.slot),
    ["helmet", "arms", "chest", "legs"],
  );
});

test("an Exotic's +5 roll is freely selectable and never filtered", () => {
  const solution = solveExoticSolution();
  const wanted = solution.tuningAssignments[0].to;
  const different = STATS.find(stat => stat !== wanted);
  // Force the Exotic Class Item's installed +5 to a stat the solution did not
  // choose. Exotic armor re-rolls its +5 freely, so the copy still matches.
  const classItem = { ...makeExoticClassItemFromDIM(), tuningTo: different };
  const matchingLegendary = [1, 2, 3, 4].map(index =>
    makeOwnedLegendary(solution, index, solution.tuningAssignments[index].to)
  );
  const [plan] = rankInventoryPlans({
    solutions: [solution],
    items: [classItem, ...matchingLegendary],
    classId: "hunter",
  });

  assert.equal(plan.ownedCount, 5);
  assert.equal(plan.farmCount, 0);
  assert.equal(
    assignmentCanReachExact(solution, [classItem, ...matchingLegendary]),
    true,
  );
});

// ============================================================
// MACRO-EQUIVALENT INVENTORY MATCHING
// ============================================================
// Fixtures (sealed witnesses, vault pieces, the macro assertions) live in
// tests/helpers/macro-fixtures.mjs so the batch/budget regressions can share
// the exact same realization.

test("framework pieces placed at different physical slots stay fully owned", () => {
  // Bulwark ×3 + Specialist ×2, exactly like the source witness, but every
  // piece physically sits at a different slot. No piece may be re-farmed just
  // because the source witness sorted its configs differently.
  const solution = buildMacroSolution({
    pairs: [["Bulwark", "melee"], ["Bulwark", "grenade"], ["Bulwark", "super"],
      ["Specialist", "health"], ["Specialist", "melee"]],
    tuning: [{ mode: "none" }, { mode: "none" }, { mode: "none" }, { mode: "none" }, { mode: "none" }],
  });
  const items = [
    buildVaultPiece({ slot: "helmet", archetypeId: "Specialist", tertiary: "health" }),
    buildVaultPiece({ slot: "arms", archetypeId: "Bulwark", tertiary: "melee" }),
    buildVaultPiece({ slot: "chest", archetypeId: "Specialist", tertiary: "melee" }),
    buildVaultPiece({ slot: "legs", archetypeId: "Bulwark", tertiary: "grenade" }),
    buildVaultPiece({ slot: "classItem", archetypeId: "Bulwark", tertiary: "super" }),
  ];
  const [plan] = rankInventoryPlans({
    solutions: [solution], items, classId: "hunter",
    residualSearchLimits: MACRO_TINY_RESIDUAL,
  });
  assertMacroOwnedPlan(plan, solution);
});

test("an illegal framework/tertiary roll is never consumed by multiset counts alone", () => {
  // The vault offers Bulwark/melee-class pieces: one legal pairing and one
  // malformed roll whose tertiary is the archetype's own primary stat. The
  // counts alone would balance; the pairing legality must reject it.
  const solution = buildMacroSolution({
    pairs: [["Bulwark", "melee"], ["Bulwark", "grenade"], ["Specialist", "super"],
      ["Specialist", "health"], ["Brawler", "weapons"]],
    tuning: Array.from({ length: 5 }, () => ({ mode: "none" })),
  });
  const illegalPiece = {
    ...buildVaultPiece({ slot: "helmet", archetypeId: "Bulwark", tertiary: "melee" }),
    id: "vault-illegal-pairing",
    tertiary: "health", // health is Bulwark's primary stat — not a legal tertiary
  };
  const items = [
    illegalPiece,
    buildVaultPiece({ slot: "arms", archetypeId: "Bulwark", tertiary: "melee" }),
    buildVaultPiece({ slot: "chest", archetypeId: "Specialist", tertiary: "super" }),
    buildVaultPiece({ slot: "legs", archetypeId: "Specialist", tertiary: "health" }),
    buildVaultPiece({ slot: "classItem", archetypeId: "Brawler", tertiary: "weapons" }),
  ];
  const [plan] = rankInventoryPlans({
    solutions: [solution], items, classId: "hunter",
    residualSearchLimits: MACRO_TINY_RESIDUAL,
  });
  // The malformed helmet can never be owned; its (Bulwark, grenade) remainder
  // is farmed as a legal pairing instead.
  assert.equal(plan.farmCount, 1);
  assert.equal(plan.ownedCount, 4);
  assert.equal(plan.feasible, true);
  const helmet = plan.pieces.find(piece => piece.slot === "helmet");
  assert.equal(helmet.item, null);
  assert.equal(verifyMacroEquivalent(solution, plan.matchedSolution), true);
});

test("directional +5/-5 assignments may move to different physical pieces", () => {
  const solution = buildMacroSolution({
    pairs: [["Bulwark", "melee"], ["Bulwark", "grenade"], ["Specialist", "super"],
      ["Specialist", "health"], ["Brawler", "weapons"]],
    tuning: [
      { mode: "+5-5", from: "health", to: "melee" },
      { mode: "+5-5", from: "health", to: "grenade" },
      { mode: "+5-5", from: "weapons", to: "super" },
      { mode: "+5-5", from: "melee", to: "health" },
      { mode: "+5-5", from: "grenade", to: "weapons" },
    ],
  });
  // Identical pairs at identical slots, but every immutable +5 roll points
  // somewhere else. Only a global re-placement of the (from, to) multiset can
  // own all five pieces.
  const items = [
    buildVaultPiece({ slot: "helmet", archetypeId: "Bulwark", tertiary: "melee", tunedStat: "grenade" }),
    buildVaultPiece({ slot: "arms", archetypeId: "Bulwark", tertiary: "grenade", tunedStat: "melee" }),
    buildVaultPiece({ slot: "chest", archetypeId: "Specialist", tertiary: "super", tunedStat: "weapons" }),
    buildVaultPiece({ slot: "legs", archetypeId: "Specialist", tertiary: "health", tunedStat: "super" }),
    buildVaultPiece({ slot: "classItem", archetypeId: "Brawler", tertiary: "weapons", tunedStat: "health" }),
  ];
  const [plan] = rankInventoryPlans({
    solutions: [solution], items, classId: "hunter",
    residualSearchLimits: MACRO_TINY_RESIDUAL,
  });
  assertMacroOwnedPlan(plan, solution);
});

test("insufficient directional capability cannot fake a fully owned plan", () => {
  const solution = buildMacroSolution({
    pairs: [["Bulwark", "melee"], ["Bulwark", "grenade"], ["Specialist", "super"],
      ["Specialist", "health"], ["Brawler", "weapons"]],
    tuning: [
      { mode: "+5-5", from: "health", to: "melee" },
      { mode: "+5-5", from: "health", to: "grenade" },
      { mode: "+5-5", from: "weapons", to: "super" },
      { mode: "+5-5", from: "melee", to: "health" },
      { mode: "+5-5", from: "grenade", to: "weapons" },
    ],
  });
  // The same vault as the positive case, but no piece rolled an immutable +5
  // towards `super`. The assignment to super must be farmed, never forged onto
  // a piece whose capability does not allow it.
  const items = [
    buildVaultPiece({ slot: "helmet", archetypeId: "Bulwark", tertiary: "melee", tunedStat: "grenade" }),
    buildVaultPiece({ slot: "arms", archetypeId: "Bulwark", tertiary: "grenade", tunedStat: "melee" }),
    buildVaultPiece({ slot: "chest", archetypeId: "Specialist", tertiary: "super", tunedStat: "health" }),
    buildVaultPiece({ slot: "legs", archetypeId: "Specialist", tertiary: "health", tunedStat: "weapons" }),
    buildVaultPiece({ slot: "classItem", archetypeId: "Brawler", tertiary: "weapons", tunedStat: "health" }),
  ];
  const [plan] = rankInventoryPlans({
    solutions: [solution], items, classId: "hunter",
    residualSearchLimits: MACRO_TINY_RESIDUAL,
  });
  assert.equal(plan.farmCount, 1);
  assert.equal(plan.ownedCount, 4);
  assert.equal(plan.feasible, true);
  assert.equal(verifyMacroEquivalent(solution, plan.matchedSolution), true);
});

test("+3 assignments move to pieces with identical aggregate contribution", () => {
  // (Bulwark, melee) and (Brawler, class) share the masterwork set
  // {grenade, super, weapons}: their +3 contributions are identical, so the +3
  // may move between them. The immutable +5 roll forces the move here.
  const solution = buildMacroSolution({
    pairs: [["Bulwark", "melee"], ["Brawler", "class"], ["Specialist", "super"],
      ["Specialist", "health"], ["Bulwark", "weapons"]],
    tuning: [
      { mode: "+3" },
      { mode: "+5-5", from: "health", to: "grenade" },
      { mode: "none" },
      { mode: "none" },
      { mode: "none" },
    ],
  });
  const items = [
    // (Brawler, class) can only +5 melee, so it cannot host the shift to
    // grenade; it hosts the +3 instead (same aggregate contribution).
    buildVaultPiece({ slot: "helmet", archetypeId: "Brawler", tertiary: "class", tunedStat: "melee" }),
    // The only grenade-capable piece is (Bulwark, melee): the shift lands here.
    buildVaultPiece({ slot: "arms", archetypeId: "Bulwark", tertiary: "melee", tunedStat: "grenade" }),
    buildVaultPiece({ slot: "chest", archetypeId: "Specialist", tertiary: "super", tunedStat: "super" }),
    buildVaultPiece({ slot: "legs", archetypeId: "Specialist", tertiary: "health", tunedStat: "super" }),
    buildVaultPiece({ slot: "classItem", archetypeId: "Bulwark", tertiary: "weapons", tunedStat: "super" }),
  ];
  const [plan] = rankInventoryPlans({
    solutions: [solution], items, classId: "hunter",
    residualSearchLimits: MACRO_TINY_RESIDUAL,
  });
  const witness = assertMacroOwnedPlan(plan, solution);
  // The +3 must have moved: the arms piece hosts the directional shift, so the
  // Balanced assignment sits on the helmet (Brawler, class) piece.
  const plus3Slot = witness.config
    .map((piece, index) => ({ piece, assignment: witness.tuningAssignments[index] }))
    .find(entry => entry.assignment.mode === "+3");
  assert.equal(plus3Slot.piece.slot, "helmet");
  const shiftSlot = witness.config
    .map((piece, index) => ({ piece, assignment: witness.tuningAssignments[index] }))
    .find(entry => entry.assignment.mode === "+5-5");
  assert.equal(shiftSlot.piece.slot, "arms");
});

test("tertiary stats re-paired onto different frameworks remain one macro plan", () => {
  // Same framework and tertiary multisets, every legal pairing rotated against
  // the source configs, and the directional Tuning capabilities only cover the
  // multiset when reassigned across pieces.
  const solution = buildMacroSolution({
    pairs: [["Bulwark", "melee"], ["Bulwark", "grenade"], ["Bulwark", "super"],
      ["Specialist", "health"], ["Specialist", "melee"]],
    tuning: [
      { mode: "+5-5", from: "health", to: "melee" },
      { mode: "+5-5", from: "health", to: "grenade" },
      { mode: "+5-5", from: "health", to: "super" },
      { mode: "+5-5", from: "health", to: "grenade" },
      { mode: "+5-5", from: "health", to: "melee" },
    ],
  });
  assert.deepEqual(
    solution.tuningAssignments.map(assignment => assignment.to).sort(),
    ["grenade", "grenade", "melee", "melee", "super"],
  );
  const items = [
    buildVaultPiece({ slot: "helmet", archetypeId: "Bulwark", tertiary: "grenade", tunedStat: "grenade" }),
    buildVaultPiece({ slot: "arms", archetypeId: "Bulwark", tertiary: "super", tunedStat: "grenade" }),
    buildVaultPiece({ slot: "chest", archetypeId: "Bulwark", tertiary: "melee", tunedStat: "super" }),
    buildVaultPiece({ slot: "legs", archetypeId: "Specialist", tertiary: "melee", tunedStat: "melee" }),
    buildVaultPiece({ slot: "classItem", archetypeId: "Specialist", tertiary: "health", tunedStat: "melee" }),
  ];
  const [plan] = rankInventoryPlans({
    solutions: [solution], items, classId: "hunter",
    residualSearchLimits: MACRO_TINY_RESIDUAL,
  });
  assertMacroOwnedPlan(plan, solution);
});

test("an equal +3 count with a different contribution vector is not macro-equivalent", () => {
  // The vault re-pairs the bag so that no owned piece (nor any single farmed
  // remainder) reproduces the source +3 contribution {grenade, super, weapons}.
  // A matcher that only counts numPlus3 would fake full ownership.
  const solution = buildMacroSolution({
    pairs: [["Bulwark", "melee"], ["Bulwark", "grenade"], ["Specialist", "super"],
      ["Specialist", "health"], ["Siegebreaker", "weapons"]],
    tuning: [
      { mode: "+3" },
      { mode: "none" },
      { mode: "none" },
      { mode: "none" },
      { mode: "none" },
    ],
  });
  const items = [
    buildVaultPiece({ slot: "helmet", archetypeId: "Bulwark", tertiary: "grenade", tunedStat: "melee" }),
    buildVaultPiece({ slot: "arms", archetypeId: "Bulwark", tertiary: "super", tunedStat: "grenade" }),
    buildVaultPiece({ slot: "chest", archetypeId: "Specialist", tertiary: "melee", tunedStat: "super" }),
    buildVaultPiece({ slot: "legs", archetypeId: "Specialist", tertiary: "health", tunedStat: "melee" }),
    buildVaultPiece({ slot: "classItem", archetypeId: "Siegebreaker", tertiary: "weapons", tunedStat: "super" }),
  ];
  const [plan] = rankInventoryPlans({
    solutions: [solution], items, classId: "hunter",
    residualSearchLimits: MACRO_TINY_RESIDUAL,
  });
  // No five-owned macro arrangement exists: the +3 contribution cannot be
  // reproduced on owned pieces and a single farmed remainder does not help.
  assert.ok(plan.farmCount >= 2, `expected farming, got ${plan.farmCount}`);
  assert.equal(plan.feasible, true);
  if (plan.matchedSolution) {
    assert.equal(verifyMacroEquivalent(solution, plan.matchedSolution), true,
      "any certified plan that realizes this witness must remain macro-equivalent");
  }
});

test("a full permutation of frameworks, tertiaries, mods, tuning and +3 stays owned", () => {
  const solution = buildMacroSolution({
    pairs: [["Bulwark", "melee"], ["Bulwark", "grenade"], ["Brawler", "class"],
      ["Specialist", "health"], ["Specialist", "super"]],
    tuning: [
      { mode: "+3" },
      { mode: "+5-5", from: "health", to: "super" },
      { mode: "+5-5", from: "health", to: "melee" },
      { mode: "none" },
      { mode: "none" },
    ],
    mods: { 3: { size: 5, stat: "super" }, 4: { size: 10, stat: "grenade" } },
  });
  // Framework multiset and tertiary multiset are unchanged, two pairings are
  // re-paired, every piece sits at another slot, the directional assignments
  // move to different pieces, and the +3 moves from the helmet (Bulwark, melee)
  // roll to the class-item (Bulwark, melee) roll with the same masterwork set.
  const items = [
    buildVaultPiece({ slot: "helmet", archetypeId: "Brawler", tertiary: "class", tunedStat: "melee" }),
    buildVaultPiece({ slot: "arms", archetypeId: "Specialist", tertiary: "grenade", tunedStat: "super" }),
    buildVaultPiece({ slot: "chest", archetypeId: "Bulwark", tertiary: "super", tunedStat: "health" }),
    buildVaultPiece({ slot: "legs", archetypeId: "Specialist", tertiary: "health", tunedStat: "grenade" }),
    buildVaultPiece({ slot: "classItem", archetypeId: "Bulwark", tertiary: "melee", tunedStat: "weapons" }),
  ];
  const [plan] = rankInventoryPlans({
    solutions: [solution], items, classId: "hunter",
    residualSearchLimits: MACRO_TINY_RESIDUAL,
  });
  const witness = assertMacroOwnedPlan(plan, solution);
  const modEntries = Object.values(witness.modAssignments).filter(Boolean)
    .map(mod => `${mod.size}:${mod.stat}`).sort();
  assert.deepEqual(modEntries, ["10:grenade", "5:super"]);
});

test("a fixed Exotic keeps its identity, slot and roll through macro matching", () => {
  const solution = buildMacroSolution({
    pairs: [["Bulwark", "melee"], ["Specialist", "health"], ["Specialist", "super"],
      ["Brawler", "class"], ["Bulwark", "weapons"]],
    tuning: [
      { mode: "none" },
      { mode: "+5-5", from: "health", to: "grenade" },
      { mode: "none" },
      { mode: "none" },
      { mode: "+5-5", from: "health", to: "melee" },
    ],
  });
  const fixedExotic = { slot: "helmet", classId: "hunter", hash: 9001, name: "Pinned Exotic" };
  const exoticRoll = buildVaultPiece({ slot: "helmet", archetypeId: "Bulwark", tertiary: "melee" });
  const ownedExotic = {
    ...exoticRoll, id: "owned-pinned-exotic", hash: 9001, name: "Pinned Exotic",
    exotic: true, tunedStat: null, tuningTo: null, allowedTuningStats: [...STAT_IDS],
  };
  const legendaries = [
    buildVaultPiece({ slot: "arms", archetypeId: "Specialist", tertiary: "super", tunedStat: "grenade" }),
    buildVaultPiece({ slot: "chest", archetypeId: "Specialist", tertiary: "health", tunedStat: "super" }),
    buildVaultPiece({ slot: "legs", archetypeId: "Brawler", tertiary: "class", tunedStat: "melee" }),
    buildVaultPiece({ slot: "classItem", archetypeId: "Bulwark", tertiary: "weapons", tunedStat: "health" }),
  ];
  const [owned] = rankInventoryPlans({
    solutions: [solution], items: [ownedExotic, ...legendaries], classId: "hunter",
    fixedExotic, residualSearchLimits: MACRO_TINY_RESIDUAL,
  });
  const witness = assertMacroOwnedPlan(owned, solution);
  const exoticPiece = witness.config.find(piece => piece.exotic);
  assert.equal(exoticPiece.slot, "helmet");
  assert.equal(exoticPiece.sourceId, "owned-pinned-exotic");
  assert.equal(owned.pieces.find(piece => piece.slot === "helmet").item.id, "owned-pinned-exotic");

  // A different Exotic identity never substitutes for the pinned one.
  const wrongIdentity = rankInventoryPlans({
    solutions: [solution],
    items: [{ ...ownedExotic, id: "other-exotic", hash: 9002, name: "Different Exotic" }, ...legendaries],
    classId: "hunter", fixedExotic, residualSearchLimits: MACRO_TINY_RESIDUAL,
  })[0];
  assert.equal(wrongIdentity.farmCount, 1);
  assert.equal(wrongIdentity.ownedCount, 4);
  assert.equal(wrongIdentity.pieces.find(piece => piece.slot === "helmet").item, null);

  // The pinned Exotic's roll is fixed: a right-identity Exotic with another
  // frame cannot own the exotic slot either.
  const wrongRollConfig = macroConfig("Brawler", "class", "helmet");
  const wrongRoll = rankInventoryPlans({
    solutions: [solution],
    items: [{
      ...ownedExotic, id: "wrong-roll-exotic", archetypeId: "Brawler", tertiary: "class",
      baseStats: { ...wrongRollConfig.baseStats },
      effectiveBaseStats: { ...wrongRollConfig.baseStats },
      optimizationBaseStats: { ...wrongRollConfig.baseStats },
    }, ...legendaries],
    classId: "hunter", fixedExotic, residualSearchLimits: MACRO_TINY_RESIDUAL,
  })[0];
  assert.equal(wrongRoll.farmCount, 1);
  assert.equal(wrongRoll.ownedCount, 4);
  assert.equal(wrongRoll.pieces.find(piece => piece.slot === "helmet").item, null);
});

test("an Exotic Class Item keeps its perk-derived config while legendaries re-pair", () => {
  const exoticConfig = createExoticConfig(EXOTIC_PRIMARY, EXOTIC_SECONDARY);
  const legendaryPairs = [["Bulwark", "melee"], ["Bulwark", "super"], ["Specialist", "health"], ["Specialist", "grenade"]];
  const config = [
    ...legendaryPairs.map(([archetypeId, tertiary], index) => macroConfig(archetypeId, tertiary, MACRO_SLOTS[index])),
    { ...exoticConfig, slot: "classItem" },
  ];
  const tuningAssignments = [
    { mode: "none", from: null, to: null },
    { mode: "+5-5", from: "health", to: "melee" },
    { mode: "none", from: null, to: null },
    { mode: "none", from: null, to: null },
    { mode: "none", from: null, to: null },
  ];
  const modAssignments = Object.fromEntries(config.map((_, index) => [index, null]));
  const totals = macroTotals(config, tuningAssignments, modAssignments);
  const problem = createProblemSpec({
    target: totals,
    constraints: { exact: Object.fromEntries(STATS.map(stat => [stat, true])) },
    exoticSettings: {
      config: config[4], classId: "hunter", itemHash: 9003,
      primaryPerkId: "left", secondaryPerkId: "right",
    },
  });
  const sealed = sealWitness(problem, {
    config, tuningAssignments, modAssignments, totals, exoticIndex: 4,
  });
  assert.equal(sealed.valid, true, sealed.errors.join("; "));
  const solution = sealed.witness;
  const classItem = {
    ...buildVaultPiece({ slot: "classItem", archetypeId: "Brawler", tertiary: "grenade" }),
    id: "owned-class-item", hash: 9003, name: "Relativism", exotic: true,
    primaryPerkId: "left", secondaryPerkId: "right",
    tunedStat: null, tuningTo: null, allowedTuningStats: [...STAT_IDS],
  };
  const legendaries = [
    buildVaultPiece({ slot: "helmet", archetypeId: "Bulwark", tertiary: "grenade", tunedStat: "melee" }),
    buildVaultPiece({ slot: "arms", archetypeId: "Bulwark", tertiary: "melee", tunedStat: "super" }),
    buildVaultPiece({ slot: "chest", archetypeId: "Specialist", tertiary: "super", tunedStat: "grenade" }),
    buildVaultPiece({ slot: "legs", archetypeId: "Specialist", tertiary: "health", tunedStat: "melee" }),
  ];
  const [plan] = rankInventoryPlans({
    solutions: [solution], items: [classItem, ...legendaries], classId: "hunter",
    residualSearchLimits: MACRO_TINY_RESIDUAL,
  });
  const witness = assertMacroOwnedPlan(plan, solution);
  assert.equal(witness.config[witness.exoticIndex].slot, "classItem");
  assert.equal(witness.config[witness.exoticIndex].sourceId, "owned-class-item");

  // A different perk-derived frame is not the pinned Exotic Class Item.
  const wrongPerks = rankInventoryPlans({
    solutions: [solution],
    items: [{ ...classItem, id: "wrong-perks", primaryPerkId: "different" }, ...legendaries],
    classId: "hunter", residualSearchLimits: MACRO_TINY_RESIDUAL,
  })[0];
  assert.equal(wrongPerks.farmCount, 1);
  assert.equal(wrongPerks.ownedCount, 4);
  assert.equal(wrongPerks.pieces.find(piece => piece.slot === "classItem").item, null);
});

test("set requirements stay strict across macro permutations", () => {
  const solution = buildMacroSolution({
    pairs: [["Bulwark", "melee"], ["Bulwark", "grenade"], ["Specialist", "super"],
      ["Specialist", "health"], ["Brawler", "weapons"]],
    tuning: Array.from({ length: 5 }, () => ({ mode: "none" })),
  });
  const items = [
    buildVaultPiece({ slot: "helmet", archetypeId: "Bulwark", tertiary: "grenade", setHash: 111 }),
    buildVaultPiece({ slot: "arms", archetypeId: "Bulwark", tertiary: "melee", setHash: 111 }),
    buildVaultPiece({ slot: "chest", archetypeId: "Specialist", tertiary: "super", setHash: 111 }),
    buildVaultPiece({ slot: "legs", archetypeId: "Specialist", tertiary: "health", setHash: 111 }),
    buildVaultPiece({ slot: "classItem", archetypeId: "Brawler", tertiary: "weapons", setHash: 222 }),
  ];
  const [fourPiece] = rankInventoryPlans({
    solutions: [solution], items, classId: "hunter",
    setRequirement: { type: "set", setHash: 111, count: 4 },
    residualSearchLimits: MACRO_TINY_RESIDUAL,
  });
  const fourPieceWitness = assertMacroOwnedPlan(fourPiece, solution);
  assert.equal(fourPieceWitness.config.filter(piece => piece.setHash === 111).length, 4);

  const [split] = rankInventoryPlans({
    solutions: [solution],
    items: items.map((item, index) => ({ ...item, setHash: index < 2 ? 111 : index < 4 ? 222 : null })),
    classId: "hunter",
    setRequirement: { type: "split", a: 111, b: 222 },
    residualSearchLimits: MACRO_TINY_RESIDUAL,
  });
  const splitWitness = assertMacroOwnedPlan(split, solution);
  assert.equal(splitWitness.config.filter(piece => piece.setHash === 111).length, 2);
  assert.equal(splitWitness.config.filter(piece => piece.setHash === 222).length, 2);

  // Only one 222-set piece exists: the second 222 coverage must be farmed with
  // an explicit set target, not silently owned from a 111 piece.
  const [splitGap] = rankInventoryPlans({
    solutions: [solution],
    items: items.map((item, index) => ({ ...item, setHash: index < 3 ? 111 : index < 4 ? 222 : null })),
    classId: "hunter",
    setRequirement: { type: "split", a: 111, b: 222 },
    residualSearchLimits: MACRO_TINY_RESIDUAL,
  });
  assert.equal(splitGap.farmCount, 1);
  assert.equal(splitGap.ownedCount, 4);
  assert.equal(splitGap.feasible, true);
  const farmed = splitGap.pieces.find(piece => !piece.item);
  assert.equal(farmed.farmSetHash, 222);
});

test("armor mods are placed on the piece that already carries them", () => {
  // The macro layer owns the mod multiset, but where it lands is execution
  // state: prefer the piece whose installed mod is still in the multiset
  // instead of pouring every mod onto config 0.
  const pairs = [["Bulwark", "melee"], ["Bulwark", "grenade"], ["Specialist", "super"],
    ["Specialist", "health"], ["Brawler", "weapons"]];
  const tuning = [
    { mode: "+5-5", from: "health", to: "melee" },
    { mode: "none" }, { mode: "none" }, { mode: "none" }, { mode: "none" },
  ];
  const solution = buildMacroSolution({ pairs, tuning, mods: { 2: { size: 5, stat: "super" } } });
  const items = pairs.map(([archetypeId, tertiary], index) => ({
    ...buildVaultPiece({
      slot: MACRO_SLOTS[index], archetypeId, tertiary,
      tunedStat: index === 0 ? "melee" : null, id: `mod-${index}`,
    }),
    armorModSize: index === 4 ? 5 : 0,
    armorModStat: index === 4 ? "super" : null,
  }));
  const [plan] = rankInventoryPlans({
    solutions: [solution], items, classId: "hunter",
    residualSearchLimits: MACRO_TINY_RESIDUAL,
  });
  const witness = assertMacroOwnedPlan(plan, solution);
  const carrierIndex = witness.config.findIndex(piece => piece.slot === MACRO_SLOTS[4]);
  assert.deepEqual(witness.modAssignments[carrierIndex], { size: 5, stat: "super" },
    "the installed mod stays on its piece when the multiset allows it");
  assert.equal(Object.values(witness.modAssignments).filter(Boolean).length, 1);
});

test("the best set realization of a settled ownership level is chosen", () => {
  // p4 is never owned, so exactly one slot farms and four pieces are owned.
  // Two 4-owned realizations exist — a 2+2 split and a 2+1 split with a set
  // label on the farmed piece — and only the first covers the requirement.
  const pairs = [["Bulwark", "melee"], ["Bulwark", "grenade"], ["Specialist", "super"],
    ["Specialist", "health"], ["Brawler", "weapons"]];
  const solution = buildMacroSolution({ pairs, tuning: pairs.map(() => ({ mode: "none" })) });
  const layout = {
    0: { helmet: 111, arms: 111, chest: 111, legs: 111, classItem: 111 },
    1: { helmet: 111, arms: 222, chest: 111, legs: 222, classItem: 111 },
    2: { helmet: 111, arms: 111, chest: 111, legs: 111, classItem: 111 },
    3: { helmet: 222, arms: 111, chest: 222, legs: 111, classItem: 222 },
  };
  const items = [];
  for (let pairIndex = 0; pairIndex < 4; pairIndex++) {
    for (const slot of MACRO_SLOTS) {
      items.push(buildVaultPiece({
        slot,
        archetypeId: pairs[pairIndex][0],
        tertiary: pairs[pairIndex][1],
        setHash: layout[pairIndex][slot],
        id: `cov-${pairIndex}-${slot}`,
      }));
    }
  }
  const [plan] = rankInventoryPlans({
    solutions: [solution], items, classId: "hunter",
    setRequirement: { type: "split", a: 111, b: 222 },
    residualSearchLimits: MACRO_TINY_RESIDUAL,
  });
  assert.equal(plan.farmCount, 1);
  assert.equal(plan.ownedCount, 4);
  assert.equal(plan.setCoverage, 4, "the maximal 2+2 realization must win");
  const witness = plan.matchedSolution;
  assert.equal(witness.config.filter(piece => piece.setHash === 111).length, 2);
  assert.equal(witness.config.filter(piece => piece.setHash === 222).length, 2);
});

test("a macro-equivalent vault is recognized even with a one-node residual budget", () => {
  // The residual solver receives a budget of exactly one node, which truncates
  // both the template permutation search and any re-solve. The macro matcher
  // must still answer the ownership question completely on its own.
  const solution = buildMacroSolution({
    pairs: [["Bulwark", "melee"], ["Specialist", "health"], ["Brawler", "class"],
      ["Specialist", "super"], ["Bulwark", "grenade"]],
    tuning: [
      { mode: "none" },
      { mode: "+5-5", from: "health", to: "grenade" },
      { mode: "none" },
      { mode: "none" },
      { mode: "+5-5", from: "health", to: "melee" },
    ],
    mods: { 2: { size: 10, stat: "class" } },
  });
  const items = [
    buildVaultPiece({ slot: "helmet", archetypeId: "Specialist", tertiary: "super", tunedStat: "grenade" }),
    buildVaultPiece({ slot: "arms", archetypeId: "Brawler", tertiary: "class", tunedStat: "melee" }),
    buildVaultPiece({ slot: "chest", archetypeId: "Bulwark", tertiary: "grenade", tunedStat: "super" }),
    buildVaultPiece({ slot: "legs", archetypeId: "Bulwark", tertiary: "melee", tunedStat: "grenade" }),
    buildVaultPiece({ slot: "classItem", archetypeId: "Specialist", tertiary: "health", tunedStat: "melee" }),
  ];
  const [plan] = rankInventoryPlans({
    solutions: [solution], items, classId: "hunter",
    residualSearchLimits: { maxTimeMs: 1, maxNodes: 1 },
  });
  assertMacroOwnedPlan(plan, solution);
});
