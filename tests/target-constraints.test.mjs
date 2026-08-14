import assert from "node:assert/strict";
import test from "node:test";

import { solveLoadout } from "../src/core/armor-engine.mjs";
import { STATS } from "../src/core/armor-model.mjs";
import {
  createTargetConstraints,
  preferConstraintSatisfyingSolutions,
  satisfiesTargetConstraints,
} from "../src/core/target-constraints.mjs";
import { scoreStatsRank } from "../src/core/solver.mjs";

const EXACT_ARMOR_TARGET = {
  health: 0,
  melee: 55,
  grenade: 50,
  super: 140,
  class: 55,
  weapons: 200,
};

test("adding a priority preserves every exact target rule", () => {
  const constraints = createTargetConstraints({
    priorityLevels: { weapons: 1 },
    targetValues: EXACT_ARMOR_TARGET,
  });

  assert.deepEqual(
    constraints.exact,
    Object.fromEntries(STATS.map(stat => [stat, true])),
  );

  const [solution] = solveLoadout({
    target: EXACT_ARMOR_TARGET,
    numPlus5: 0,
    numPlus10: 5,
    numPlus3: 0,
    constraints,
  });

  assert.deepEqual(solution.totals, EXACT_ARMOR_TARGET);
  assert.equal(
    satisfiesTargetConstraints(solution.totals, EXACT_ARMOR_TARGET, constraints),
    true,
  );
});

test("minimum rules keep the remaining stats exact and accept surplus", () => {
  const target = {
    health: 0,
    melee: 25,
    grenade: 25,
    super: 140,
    class: 35,
    weapons: 200,
  };
  const constraints = createTargetConstraints({
    modes: { melee: ">=", grenade: ">=", class: ">=" },
    targetValues: target,
  });

  const [solution] = solveLoadout({
    target,
    numPlus5: 0,
    numPlus10: 5,
    numPlus3: 0,
    constraints,
  });

  assert.equal(solution.totals.health, 0);
  assert.equal(solution.totals.super, 140);
  assert.equal(solution.totals.weapons, 200);
  assert.ok(solution.totals.melee >= 25);
  assert.ok(solution.totals.grenade >= 25);
  assert.ok(solution.totals.class >= 35);
  assert.equal(satisfiesTargetConstraints(solution.totals, target, constraints), true);
  assert.notEqual(solution.score, 0, "minimum surplus is valid despite a nonzero fit score");
});

test("maximum and range bounds participate in rule satisfaction", () => {
  const target = Object.fromEntries(STATS.map(stat => [stat, 50]));
  const constraints = createTargetConstraints({
    modes: { melee: "<=", grenade: "range" },
    targetValues: target,
    maximumValues: { grenade: 70 },
  });

  assert.equal(
    satisfiesTargetConstraints(
      { ...target, melee: 45, grenade: 65 },
      target,
      constraints,
    ),
    true,
  );
  assert.equal(
    satisfiesTargetConstraints(
      { ...target, melee: 55, grenade: 75 },
      target,
      constraints,
    ),
    false,
  );
  assert.ok(
    scoreStatsRank(
      { ...target, melee: 55 },
      target,
      constraints,
    )[0] > 0,
    "an at-most violation must be ranked as a hard rule violation",
  );
});

test("valid fuzzy solutions outrank score-zero classification", () => {
  const target = {
    health: 0,
    melee: 25,
    grenade: 25,
    super: 140,
    class: 35,
    weapons: 200,
  };
  const constraints = createTargetConstraints({
    modes: { melee: ">=", grenade: ">=", class: ">=" },
    targetValues: target,
  });
  const valid = {
    totals: { health: 0, melee: 55, grenade: 50, super: 140, class: 55, weapons: 200 },
    score: 1925,
  };
  const invalid = {
    totals: { health: 15, melee: 40, grenade: 40, super: 145, class: 55, weapons: 205 },
    score: 1125,
  };

  assert.deepEqual(
    preferConstraintSatisfyingSolutions([invalid, valid], target, constraints),
    [valid],
    "rule satisfaction must win even when its fit score is numerically larger",
  );
});
