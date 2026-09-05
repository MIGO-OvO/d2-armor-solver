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
  runSolver,
  scoreStats,
  scoreStatsRank,
} from "../src/core/solver.mjs";
import {
  createProblemSpec,
  STAT_DOMAIN,
} from "../src/core/solver-v3-contract.mjs";
import {
  compareUpgradeMetrics,
  createUpgradePieceFromItem,
  evaluateUpgradePieces,
} from "../src/core/upgrade-optimizer.mjs";

const ZERO = Object.fromEntries(STATS.map(stat => [stat, 0]));

test("runSolver accepts only a normalized ProblemSpec", () => {
  assert.throws(
    () => runSolver({ ...ZERO }),
    /normalized ProblemSpec/,
  );
});

function rebuildSolverTotals(solution) {
  const totals = { ...ZERO };
  for (let index = 0; index < solution.config.length; index++) {
    const config = solution.config[index];
    for (const stat of STATS) totals[stat] += config.baseStats[stat];
    const tuning = solution.tuningAssignments[index];
    if (tuning.mode === "+3") {
      for (const stat of config.masterworkStats) totals[stat] += 1;
    } else {
      totals[tuning.from] -= 5;
      totals[tuning.to] += 5;
    }
    const mod = solution.modAssignments[index];
    if (mod) totals[mod.stat] += mod.size;
  }
  return totals;
}

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
      config.archetype === archetype.id && config.tertiary === tertiary);
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

test("fixed-five evaluator matches an independent joint tuning and mod oracle", () => {
  const configs = [0, 5, 10, 15, 20].map(index => BASE_CONFIGS[index]);
  const target = {
    health: 75,
    melee: 90,
    grenade: 80,
    super: 70,
    class: 90,
    weapons: 50,
  };
  const constraints = {
    minimums: { melee: 85 },
    maximums: { weapons: 65 },
    priorityLevels: { grenade: 1 },
  };
  const fixedTuningTargets = [undefined, null, null, null, null];
  const actual = evaluateConfig(
    configs,
    target,
    1,
    0,
    4,
    constraints,
    fixedTuningTargets,
  );

  const plus3Base = { ...ZERO };
  for (let index = 0; index < configs.length; index++) {
    for (const stat of STATS) plus3Base[stat] += configs[index].baseStats[stat];
    if (index > 0) {
      for (const stat of configs[index].masterworkStats) plus3Base[stat] += 1;
    }
  }
  let oracleRank = null;
  for (const from of STATS) {
    for (const to of STATS) {
      if (from === to) continue;
      for (const modStat of STATS) {
        const totals = { ...plus3Base };
        totals[from] -= 5;
        totals[to] += 5;
        totals[modStat] += 5;
        const rank = scoreStatsRank(totals, target, constraints);
        if (!oracleRank || compareScoreRanks(rank, oracleRank) < 0) oracleRank = rank;
      }
    }
  }

  assert.deepEqual(actual.rank, oracleRank);
  assert.deepEqual(rebuildSolverTotals({ ...actual, config: configs }), actual.totals);
});

test("exact-target oracle recovers a generated witness missed by heuristic refinement", () => {
  const sourceConfigs = [37, 33, 15, 10, 6].map(index => BASE_CONFIGS[index]);
  const sourceTuning = [
    { mode: "+3", from: null, to: null },
    { mode: "+3", from: null, to: null },
    { mode: "+3", from: null, to: null },
    { mode: "+5-5", from: "super", to: "melee" },
    { mode: "+5-5", from: "class", to: "weapons" },
  ];
  const sourceMods = ["grenade", "grenade", "super", "class", "class"];
  const target = { ...ZERO };
  for (let index = 0; index < sourceConfigs.length; index++) {
    const config = sourceConfigs[index];
    for (const stat of STATS) target[stat] += config.baseStats[stat];
    const tuning = sourceTuning[index];
    if (tuning.mode === "+3") {
      for (const stat of config.masterworkStats) target[stat] += 1;
    } else {
      target[tuning.from] -= 5;
      target[tuning.to] += 5;
    }
    target[sourceMods[index]] += 10;
  }
  assert.deepEqual(target, {
    health: 73,
    melee: 115,
    grenade: 62,
    super: 48,
    class: 140,
    weapons: 71,
  }, "fixture must be reachable by construction");

  const exact = Object.fromEntries(STATS.map(stat => [stat, true]));
  const solutions = runSolver(createProblemSpec({
    target,
    constraints: { exact },
    targetDomain: STAT_DOMAIN.ARMOR,
    numPlus5: 0,
    numPlus10: 5,
    numPlus3: 3,
  }));
  const witness = solutions.find(solution =>
    STATS.every(stat => solution.totals[stat] === target[stat]));

  assert.ok(witness, "the exact-target path must recover a known reachable target");
  assert.deepEqual(
    rebuildSolverTotals(witness),
    target,
    "the returned config, Tuning, and stat mods must reproduce the target",
  );
});

function createInventoryOracleFixture(itemCount = 4, seed = 1) {
  let state = seed;
  const random = () => (
    (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296
  );
  const slots = ["helmet", "arms", "chest", "legs", "classItem"];
  const bySlot = [];
  const items = [];
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
    const slotItems = [];
    for (let itemIndex = 0; itemIndex < itemCount; itemIndex++) {
      const config = BASE_CONFIGS[Math.floor(random() * BASE_CONFIGS.length)];
      const archetype = ARCHETYPES.find(entry => entry.id === config.archetype);
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

function findExhaustiveInventoryBest(bySlot, targets) {
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
  return exhaustiveBest;
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
  const exhaustiveBest = findExhaustiveInventoryBest(bySlot, targets);

  assert.ok(result.results.length > 0);
  assert.ok(
    compareUpgradeMetrics(result.results[0].metrics, exhaustiveBest.metrics) <= 0,
    "heuristic inventory search must not lose to the exhaustive small-inventory oracle",
  );
});

test("six-per-slot inventory frontier matches independent exhaustive enumeration", () => {
  const { bySlot, items, targets } = createInventoryOracleFixture(6, 17);
  const result = solveInventoryLoadout({
    items,
    targets,
    fragments: ZERO,
    setRequirement: { type: "none" },
    reassignModifiers: false,
  });
  const exhaustiveBest = findExhaustiveInventoryBest(bySlot, targets);

  assert.ok(result.results.length > 0);
  assert.equal(
    compareUpgradeMetrics(result.results[0].metrics, exhaustiveBest.metrics),
    0,
  );
  assert.equal(result.searchComplete, true);
});
