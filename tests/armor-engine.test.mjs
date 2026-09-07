import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateReachability,
  solveInventory,
  solveLoadout,
} from "../src/core/armor-engine.mjs";
import { solveLoadoutAsync } from "../src/core/armor-engine-client.mjs";
import { findExactTargetWitnesses } from "../src/core/exact-target-oracle.mjs";
import {
  BASE_CONFIGS,
  DEFAULT_TARGETS,
  STATS,
} from "../src/core/armor-model.mjs";
import {
  EXECUTION_STATUS,
  RESULT_STATUS,
} from "../src/core/solver-v3-contract.mjs";

test("armor catalog exposes the complete normalized configuration set", () => {
  assert.equal(BASE_CONFIGS.length, 48);
  for (const config of BASE_CONFIGS) {
    assert.equal(
      STATS.reduce((sum, stat) => sum + config.baseStats[stat], 0),
      90,
    );
    assert.equal(config.masterworkStats.length, 3);
  }
});

test("solver returns a reproducible candidate through the engine interface", () => {
  const solutions = solveLoadout({
    target: DEFAULT_TARGETS,
    numPlus5: 0,
    numPlus10: 5,
    numPlus3: 0,
    constraints: {},
    runtimeOptions: { fastMode: true },
  });

  assert.ok(solutions.length > 0);
  const best = solutions[0];
  assert.equal(best.config.length, 5);
  assert.equal(best.tuningAssignments.length, 5);
  assert.equal(Object.keys(best.modAssignments).length, 5);
  assert.equal(
    STATS.reduce((sum, stat) => sum + best.totals[stat], 0),
    500,
  );
  assert.equal(solutions.status, RESULT_STATUS.EXACT_TARGET_PROVEN);
  assert.equal(solutions.executionStatus, EXECUTION_STATUS.NOT_APPLICABLE);
  assert.equal(solutions.certificate.canonicalId, best.canonicalId);
});

test("visible-domain solving certifies recomputed Armor and visible totals", () => {
  const fragments = {
    health: 10,
    melee: -10,
    grenade: 20,
    super: -20,
    class: 10,
    weapons: -10,
  };
  const target = Object.fromEntries(STATS.map(stat => [
    stat,
    Math.max(0, Math.min(200, DEFAULT_TARGETS[stat] + fragments[stat])),
  ]));
  const solutions = solveLoadout({
    target,
    fragments,
    targetDomain: "visible",
    constraints: { exact: Object.fromEntries(STATS.map(stat => [stat, true])) },
    numPlus5: 0,
    numPlus10: 5,
    numPlus3: 0,
  });

  assert.equal(solutions.status, RESULT_STATUS.EXACT_TARGET_PROVEN);
  assert.deepEqual(solutions[0].armorTotals, DEFAULT_TARGETS);
  assert.deepEqual(solutions[0].visibleTotals, target);
  assert.deepEqual(solutions.certificate.witnessVerification.armorTotals, DEFAULT_TARGETS);
  assert.deepEqual(solutions.certificate.witnessVerification.visibleTotals, target);
});

test("inline Adapter and direct ArmorEngine return the same canonical witness", async () => {
  const payload = {
    target: DEFAULT_TARGETS,
    numPlus5: 0,
    numPlus10: 5,
    numPlus3: 0,
    constraints: {},
    runtimeOptions: { fastMode: true },
  };
  const direct = solveLoadout(payload);
  const inline = await solveLoadoutAsync(payload);

  assert.equal(inline[0].canonicalId, direct[0].canonicalId);
  assert.deepEqual(inline.certificate, direct.certificate);
});

test("invalid solve input preserves the legacy array shape with an INVALID_INPUT certificate", () => {
  const solutions = solveLoadout({
    target: DEFAULT_TARGETS,
    numPlus5: 0.5,
    numPlus10: 5,
    numPlus3: 0,
  });

  assert.ok(Array.isArray(solutions));
  assert.equal(solutions.length, 0);
  assert.equal(solutions.status, RESULT_STATUS.INVALID_INPUT);
  assert.match(solutions.certificate.message, /numPlus5/);
});

test("reachability exposes a proof certificate without changing its legacy fields", () => {
  const result = calculateReachability({
    fixedPiece: BASE_CONFIGS[0],
    numPlus5: 0,
    numPlus10: 5,
    numPlus3: 0,
    fragments: Object.fromEntries(STATS.map(stat => [stat, 0])),
    lockedTargets: {},
  });

  assert.equal(result.feasible, true);
  assert.equal(result.status, RESULT_STATUS.RULE_FEASIBLE_PROVEN);
  assert.equal(result.certificate.proof.complete, true);
  assert.equal(result.certificate.proof.producer, "reachability-dp");
});

test("clamped reachability without an interval proof is always search-limited", () => {
  const fragments = Object.fromEntries(STATS.map(stat => [stat, 0]));
  for (const health of [0, 200]) {
    const result = calculateReachability({
      fixedPiece: BASE_CONFIGS[0],
      numPlus5: 0,
      numPlus10: 5,
      numPlus3: 0,
      fragments,
      lockedTargets: { health },
    });

    assert.equal(result.status, RESULT_STATUS.SEARCH_LIMIT_REACHED);
    assert.equal(result.certificate.proof.complete, false);
  }
});

test("bounded relaxed search cannot turn the reachable Health=225 rule into infeasibility", () => {
  const reachableHealth225 = {
    health: 225,
    melee: 75,
    grenade: 125,
    super: 25,
    class: 25,
    weapons: 25,
  };
  assert.ok(findExactTargetWitnesses({
    target: reachableHealth225,
    numPlus5: 0,
    numPlus10: 5,
    numPlus3: 0,
  }).length > 0, "fixture: an Armor-domain Health=225 witness exists");

  const solutions = solveLoadout({
    target: {
      health: 225,
      melee: 100,
      grenade: 100,
      super: 100,
      class: 100,
      weapons: 100,
    },
    numPlus5: 0,
    numPlus10: 5,
    numPlus3: 0,
    constraints: { exact: { health: true } },
    runtimeOptions: { relaxedCandidateLimit: 1 },
  });

  assert.ok(solutions.length > 0, "the bounded search should still expose its incumbent");
  assert.equal(solutions.proof.complete, false);
  assert.equal(solutions.status, RESULT_STATUS.SEARCH_LIMIT_REACHED);
  assert.notEqual(solutions.status, RESULT_STATUS.INFEASIBLE_PROVEN);
});

test("unknown inventory capability data cannot produce an infeasibility certificate", () => {
  const fragments = Object.fromEntries(STATS.map(stat => [stat, 0]));
  const slots = ["helmet", "arms", "chest", "legs", "classItem"];
  const items = slots.map((slot, index) => ({
    id: `unknown-${slot}`,
    slot,
    archetypeId: BASE_CONFIGS[index].archetype,
    tertiary: BASE_CONFIGS[index].tertiary,
    baseStats: { ...BASE_CONFIGS[index].baseStats },
    setHash: null,
  }));
  const result = solveInventory({
    items,
    targets: fragments,
    fragments,
    setRequirement: { type: "set", setHash: 12345, count: 5 },
    reassignModifiers: false,
  });

  assert.equal(result.results.length, 0);
  assert.equal(result.status, RESULT_STATUS.SEARCH_LIMIT_REACHED);
  assert.equal(result.certificate.proof.complete, false);
  assert.match(result.certificate.proof.limitation, /unknown data/);
});

test("exact residue rejection accounts for the locked piece's actual stat residues", () => {
  const fixedPiece = {
    ...BASE_CONFIGS[0],
    baseStats: {
      ...BASE_CONFIGS[0].baseStats,
      health: BASE_CONFIGS[0].baseStats.health + 1,
      grenade: BASE_CONFIGS[0].baseStats.grenade - 1,
    },
  };
  const target = Object.fromEntries(STATS.map(stat => [
    stat, fixedPiece.baseStats[stat] + 4 * BASE_CONFIGS[0].baseStats[stat]
      + (stat === "health" ? -25 : stat === "melee" ? 25 : 0),
  ]));
  const result = calculateReachability({
    fixedPiece, numPlus3: 0, numPlus5: 0, numPlus10: 0,
    fragments: Object.fromEntries(STATS.map(stat => [stat, 0])),
    lockedTargets: {}, probeTarget: target,
  });
  assert.equal(result.status, RESULT_STATUS.EXACT_TARGET_PROVEN);
  assert.deepEqual(result.certificate.witnessVerification.armorTotals, target);
});

test("three hard minimums stay within the interactive solving budget", () => {
  const target = {
    health: 0,
    melee: 100,
    grenade: 100,
    super: 100,
    class: 100,
    weapons: 100,
  };
  const startedAt = performance.now();
  const solutions = solveLoadout({
    target,
    numPlus5: 0,
    numPlus10: 5,
    numPlus3: 0,
    constraints: {
      minimums: {
        melee: 100,
        grenade: 100,
        super: 100,
      },
    },
  });
  const elapsedMs = performance.now() - startedAt;

  assert.ok(solutions.length > 0);
  assert.ok(solutions[0].totals.melee >= 100);
  assert.ok(solutions[0].totals.grenade >= 100);
  assert.ok(solutions[0].totals.super >= 100);
  assert.ok(
    elapsedMs < 4_000,
    `three-minimum solve took ${Math.round(elapsedMs)}ms`,
  );
});
