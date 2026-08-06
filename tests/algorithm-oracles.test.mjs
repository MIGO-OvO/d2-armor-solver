import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHETYPES,
  BASE_CONFIGS,
  STATS,
} from "../src/core/armor-model.mjs";
import { solveInventoryLoadout } from "../src/core/inventory-solver.mjs";
import {
  compareScoreRanks,
  evaluateConfig,
  scoreStats,
  scoreStatsRank,
} from "../src/core/solver.mjs";
import {
  compareUpgradeMetrics,
  createUpgradePieceFromItem,
  evaluateUpgradePieces,
} from "../src/core/upgrade-optimizer.mjs";

const ZERO = Object.fromEntries(STATS.map(stat => [stat, 0]));

test("structural score preserves soft ordering beside a hard-constraint penalty", () => {
  const target = Object.fromEntries(STATS.map(stat => [stat, 100]));
  const constraints = { minimums: { weapons: 100 } };
  const closer = { ...target, weapons: 99 };
  const farther = { ...closer, health: 99 };

  assert.equal(
    scoreStats(closer, target, constraints),
    scoreStats(farther, target, constraints),
    "fixture: legacy 1e18 encoding loses the soft difference",
  );
  assert.ok(
    compareScoreRanks(
      scoreStatsRank(closer, target, constraints),
      scoreStatsRank(farther, target, constraints),
    ) < 0,
    "structural rank must preserve the soft tie-breaker",
  );
});

test("hard-minimum evaluation searches both sides of free tuning shifts", () => {
  const specs = [
    ["Skirmisher", "health"],
    ["Grenadier", "health"],
    ["Powerhouse", "melee"],
    ["Demolitionist", "super"],
    ["Gunner", "super"],
  ];
  const configs = specs.map(([archetypeId, tertiary]) => {
    const archetype = ARCHETYPES.find(entry => entry.id === archetypeId);
    return BASE_CONFIGS.find(config =>
      config.archetype === archetype.name && config.tertiary === tertiary);
  });
  const target = {
    health: 55,
    melee: 110,
    grenade: 110,
    super: 80,
    class: 115,
    weapons: 120,
  };
  const result = evaluateConfig(
    configs,
    target,
    0,
    2,
    3,
    { minimums: { weapons: 120, super: 80 } },
  );

  assert.equal(result.score, 17697);
  assert.deepEqual(result.totals, {
    health: 57,
    melee: 67,
    grenade: 96,
    super: 85,
    class: 53,
    weapons: 121,
  });
});

function createInventoryOracleFixture() {
  let state = 1;
  const random = () => (
    (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296
  );
  const slots = ["helmet", "arms", "chest", "legs", "classItem"];
  const bySlot = [];
  const items = [];
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
    const slotItems = [];
    for (let itemIndex = 0; itemIndex < 4; itemIndex++) {
      const config = BASE_CONFIGS[Math.floor(random() * BASE_CONFIGS.length)];
      const archetype = ARCHETYPES.find(entry => entry.name === config.archetype);
      const baseStats = { ...config.baseStats };
      const item = {
        id: `oracle-${slotIndex}-${itemIndex}`,
        hash: 1000 + slotIndex * 10 + itemIndex,
        name: `Oracle ${slotIndex}-${itemIndex}`,
        slot: slots[slotIndex],
        classId: "hunter",
        tier: "5",
        exotic: false,
        archetypeId: archetype.id,
        tertiary: config.tertiary,
        tuningMode: "shift",
        tuningFrom: "health",
        tuningTo: "weapons",
        armorModSize: 0,
        armorModStat: "health",
        baseStats,
        effectiveBaseStats: baseStats,
        optimizationBaseStats: baseStats,
        setHash: null,
      };
      slotItems.push(item);
      items.push(item);
    }
    bySlot.push(slotItems);
  }
  return {
    bySlot,
    items,
    targets: {
      health: 65,
      melee: 55,
      grenade: 55,
      super: 70,
      class: 55,
      weapons: 100,
    },
  };
}

test("owned-inventory search matches exhaustive optimum on a small legal inventory", () => {
  const { bySlot, items, targets } = createInventoryOracleFixture();
  const result = solveInventoryLoadout({
    items,
    targets,
    fragments: ZERO,
    setRequirement: { type: "none" },
    reassignModifiers: false,
  });
  let exhaustiveBest = null;
  const chosen = Array(5);
  const enumerate = slotIndex => {
    if (slotIndex === bySlot.length) {
      const pieces = chosen.map((item, index) =>
        createUpgradePieceFromItem(item, index));
      const evaluation = evaluateUpgradePieces(
        pieces, targets, ZERO, false, []
      );
      if (!exhaustiveBest ||
          compareUpgradeMetrics(evaluation.metrics, exhaustiveBest.metrics) < 0) {
        exhaustiveBest = evaluation;
      }
      return;
    }
    for (const item of bySlot[slotIndex]) {
      chosen[slotIndex] = item;
      enumerate(slotIndex + 1);
    }
  };
  enumerate(0);

  assert.ok(result.results.length > 0);
  assert.ok(
    compareUpgradeMetrics(result.results[0].metrics, exhaustiveBest.metrics) <= 0,
    "heuristic inventory search must not lose to the exhaustive small-inventory oracle",
  );
});
