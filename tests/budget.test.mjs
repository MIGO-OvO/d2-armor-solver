import assert from "node:assert/strict";
import test from "node:test";

import {
  createBalancedTargetPlan,
  getArmorRequirement,
} from "../src/core/budget.mjs";
import { STATS } from "../src/core/armor-model.mjs";

test("armor requirement preserves calibrated zero semantics", () => {
  assert.equal(getArmorRequirement(0, -20), 0);
  assert.equal(getArmorRequirement(100, 10), 90);
  assert.equal(getArmorRequirement(10, 20), 0);
});

test("budget balancing reaches the exact budget with multiples of five", () => {
  const targets = {
    health: 0,
    melee: 100,
    grenade: 100,
    super: 100,
    class: 100,
    weapons: 100,
  };
  const fragments = Object.fromEntries(STATS.map(stat => [stat, 0]));
  const result = createBalancedTargetPlan({
    targets,
    fragments,
    lockedStats: ["melee"],
    budget: 490,
  });

  assert.ok(result);
  assert.equal(result.melee, 100);
  assert.equal(result.health, 0);
  assert.equal(
    STATS.reduce(
      (sum, stat) => sum + getArmorRequirement(result[stat], fragments[stat]),
      0,
    ),
    490,
  );
  for (const stat of STATS) {
    if (result[stat] !== targets[stat]) {
      assert.equal(result[stat] % 5, 0);
    }
  }
});

test("budget balancing reports an impossible fully locked request", () => {
  const targets = Object.fromEntries(STATS.map(stat => [stat, 75]));
  const fragments = Object.fromEntries(STATS.map(stat => [stat, 0]));
  assert.equal(
    createBalancedTargetPlan({
      targets,
      fragments,
      lockedStats: STATS,
      budget: 455,
    }),
    null,
  );
});

test("budget balancing can fill enabled stats above 100 up to the Armor 3.0 cap", () => {
  const targets = {
    health: 0,
    melee: 0,
    grenade: 0,
    super: 50,
    class: 50,
    weapons: 50,
  };
  const fragments = Object.fromEntries(STATS.map(stat => [stat, 0]));
  const result = createBalancedTargetPlan({
    targets,
    fragments,
    budget: 450,
  });

  assert.deepEqual(result, {
    ...targets,
    super: 150,
    class: 150,
    weapons: 150,
  });
});
