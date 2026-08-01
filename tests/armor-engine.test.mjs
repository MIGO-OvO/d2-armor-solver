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
