import assert from "node:assert/strict";
import test from "node:test";

import { ARCHETYPES, BASE_CONFIGS } from "../src/core/armor-model.mjs";
import { rankInventoryPlans } from "../src/core/inventory-plan.mjs";

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
  const archetypeId = ARCHETYPES.find(archetype => archetype.name === config.archetype).id;
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

test("a named Exotic picks the closest roll among same-name inventory copies", () => {
  const solution = makeSolution();
  const fixedExotic = {
    classId: "hunter",
    slot: "helmet",
    hash: 9001,
    name: "Selected Exotic",
  };
  const closeRoll = makeItem(solution, 0, {
    id: "close-roll",
    hash: fixedExotic.hash,
    name: fixedExotic.name,
    exotic: true,
    tuningTo: "weapons",
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
  assert.deepEqual(plan.pieces[0].closestMismatch.fields, ["tuningTo"]);
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
