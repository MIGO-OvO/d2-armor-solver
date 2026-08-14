import assert from "node:assert/strict";
import test from "node:test";

import { solveLoadout } from "../src/core/armor-engine.mjs";
import {
  BASE_CONFIGS,
  DEFAULT_TARGETS,
  STATS,
} from "../src/core/armor-model.mjs";

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
