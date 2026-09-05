import assert from "node:assert/strict";
import test from "node:test";

import { ARCHETYPES, BASE_CONFIGS, createExoticConfig } from "../src/core/armor-model.mjs";
import { rankInventoryPlans, assignmentCanReachExact } from "../src/core/inventory-plan.mjs";
import { runSolver } from "../src/core/solver.mjs";
import { createProblemSpec } from "../src/core/solver-v3-contract.mjs";
import { normalizeDimItem, parseCsv } from "../src/core/dim-csv.mjs";

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
    totals: {},
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

test("a named Exotic recommends the closest roll when no copy is usable", () => {
  const solution = makeSolution();
  const fixedExotic = {
    classId: "hunter",
    slot: "helmet",
    hash: 9001,
    name: "Selected Exotic",
  };
  // Both copies run a +3 Tuning mod, which cannot serve the solution's +5/-5
  // slot; the closest roll is still recommended for farming reference.
  const closeRoll = makeItem(solution, 0, {
    id: "close-roll",
    hash: fixedExotic.hash,
    name: fixedExotic.name,
    exotic: true,
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
  assert.deepEqual(plan.pieces[0].closestMismatch.fields, ["tuningMode"]);
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
  "10", "20", "10", "20", "10", "35", "105",
  "5", "25", "5", "20", "5", "30", "90",
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
    return makeOwnedLegendary(solution, index, STATS[(STATS.indexOf(wanted) + offset) % 6]);
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
  const solution = solveExoticSolution();
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
  const solution = solveExoticSolution();
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
