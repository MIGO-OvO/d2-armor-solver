import assert from "node:assert/strict";
import test from "node:test";

import { BASE_CONFIGS, STATS } from "../src/core/armor-model.mjs";
import { calculateReachableRanges } from "../src/core/reachability.mjs";

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
