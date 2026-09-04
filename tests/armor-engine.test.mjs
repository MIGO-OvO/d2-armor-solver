import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateReachability,
  solveLoadout,
} from "../src/core/armor-engine.mjs";
import { solveLoadoutAsync } from "../src/core/armor-engine-client.mjs";
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
  assert.equal(result.certificate.proof.exhaustive, true);
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
