import assert from "node:assert/strict";
import test from "node:test";

import { BASE_CONFIGS, STATS } from "../src/core/armor-model.mjs";
import {
  calculateReachableRanges,
  findReachabilityWitness,
} from "../src/core/reachability.mjs";
import { RESULT_STATUS } from "../src/core/solver-v3-contract.mjs";

test("dense locks return exact paired ranges from meet-in-the-middle states", () => {
  const fragments = Object.fromEntries(STATS.map(stat => [stat, 0]));
  const lockedTargets = {
    health: 100,
    melee: 50,
    grenade: 100,
    super: 100,
  };
  const result = calculateReachableRanges(
    BASE_CONFIGS[0],
    0,
    5,
    0,
    fragments,
    lockedTargets,
  );

  assert.equal(result.feasible, true);
  assert.ok(result.ranges.class.values.length > 1);
  assert.ok(result.ranges.weapons.values.length > 1);
  const remaining = 500 - Object.values(lockedTargets)
    .reduce((sum, value) => sum + value, 0);
  for (const classValue of result.ranges.class.values) {
    assert.ok(
      result.ranges.weapons.values.includes(remaining - classValue),
      "the companion range must preserve every exact total-budget counterpart",
    );
  }
});

test("reachability target probe and exact witness agree in both directions", () => {
  const fixedPiece = BASE_CONFIGS[0];
  const configs = [fixedPiece, BASE_CONFIGS[4], BASE_CONFIGS[8], BASE_CONFIGS[12], BASE_CONFIGS[16]];
  const target = Object.fromEntries(STATS.map(stat => [
    stat,
    configs.reduce((sum, config) =>
      sum + config.baseStats[stat] + Number(config.masterworkStats.includes(stat)), 0),
  ]));
  const fragments = Object.fromEntries(STATS.map(stat => [stat, 0]));
  const probe = findReachabilityWitness({
    fixedPiece,
    numPlus5: 0,
    numPlus10: 0,
    numPlus3: 5,
    fragments,
    visibleTarget: target,
  });

  assert.equal(probe.status, RESULT_STATUS.EXACT_TARGET_PROVEN);
  assert.deepEqual(probe.witness.visibleTotals, target);
  const rebuilt = Object.fromEntries(STATS.map(stat => [stat, 0]));
  probe.witness.config.forEach((config, index) => {
    for (const stat of STATS) rebuilt[stat] += config.baseStats[stat];
    for (const stat of config.masterworkStats) rebuilt[stat] += 1;
    assert.equal(probe.witness.tuningAssignments[index].mode, "+3");
  });
  assert.deepEqual(rebuilt, target);

  const ranges = calculateReachableRanges(
    fixedPiece,
    0,
    0,
    5,
    fragments,
    Object.fromEntries(STATS.slice(0, 4).map(stat => [stat, target[stat]])),
  );
  assert.equal(ranges.feasible, true);
  for (const stat of STATS.slice(4)) {
    assert.ok(ranges.ranges[stat].values.includes(target[stat]));
  }
});

test("a missed clamped boundary target is limited, never falsely proven infeasible", () => {
  const result = findReachabilityWitness({
    fixedPiece: BASE_CONFIGS[0],
    numPlus5: 0,
    numPlus10: 0,
    numPlus3: 5,
    fragments: Object.fromEntries(STATS.map(stat => [stat, 0])),
    visibleTarget: Object.fromEntries(STATS.map(stat => [stat, 0])),
  });
  assert.equal(result.status, RESULT_STATUS.SEARCH_LIMIT_REACHED);
  assert.equal(result.proof.complete, false);
});
