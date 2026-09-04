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
import { RESULT_STATUS } from "../src/core/solver-v3-contract.mjs";

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

  const solutions = solveLoadout({
    target,
    numPlus5: 0,
    numPlus10: 5,
    numPlus3: 0,
    constraints,
  });
  const [solution] = solutions;

  assert.equal(solution.totals.health, 0);
  assert.equal(solution.totals.super, 140);
  assert.equal(solution.totals.weapons, 200);
  assert.ok(solution.totals.melee >= 25);
  assert.ok(solution.totals.grenade >= 25);
  assert.ok(solution.totals.class >= 35);
  assert.equal(satisfiesTargetConstraints(solution.totals, target, constraints), true);
  assert.notEqual(solution.score, 0, "minimum surplus is valid despite a nonzero fit score");
  assert.equal(solutions.status, RESULT_STATUS.RULE_FEASIBLE_PROVEN);
  assert.equal(solutions.certificate.proof.exhaustive, true);
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

test("at-most cap stays hard even when surplus budget must be spilled", () => {
  // Total target (320) is well under the 500 armor budget, so ~180 surplus
  // points must land somewhere. The solver used to spill them straight into
  // the very stat capped with 至多, because a squared distance to the target
  // cost the same as a squared distance to the cap. The cap must dominate.
  const target = {
    health: 20,
    melee: 20,
    grenade: 40,
    super: 100,
    class: 40,
    weapons: 100,
  };
  const constraints = createTargetConstraints({
    modes: { melee: "<=" },
    targetValues: target,
  });

  const solutions = solveLoadout({
    target,
    numPlus5: 0,
    numPlus10: 5,
    numPlus3: 0,
    constraints,
  });
  const [solution] = solutions;

  assert.ok(
    solution.totals.melee <= constraints.maximums.melee,
    "the at-most cap must be enforced even though the surplus is dumped elsewhere",
  );
  assert.equal(
    satisfiesTargetConstraints(solution.totals, target, constraints),
    false,
    "the exact stats can no longer all be met once the surplus has to go somewhere, but the cap itself must hold",
  );
  assert.equal(solutions.certificate.proof.exhaustive, true);
  assert.equal(solutions.status, RESULT_STATUS.INFEASIBLE_PROVEN);
});

test("non-binding rule changes preserve the canonical exact witness", () => {
  const exact = Object.fromEntries(STATS.map(stat => [stat, true]));
  const common = {
    target: EXACT_ARMOR_TARGET,
    numPlus5: 0,
    numPlus10: 5,
    numPlus3: 0,
  };
  const baseline = solveLoadout({ ...common, constraints: { exact } });
  const decorated = solveLoadout({
    ...common,
    constraints: {
      exact,
      priorityLevels: { weapons: 1, super: 2 },
      minimums: { melee: 0 },
      maximums: { weapons: 200 },
    },
  });
  const repeated = solveLoadout({ ...common, constraints: { exact } });
  const pointRange = solveLoadout({
    ...common,
    constraints: createTargetConstraints({
      modes: Object.fromEntries(STATS.map(stat => [stat, "range"])),
      targetValues: EXACT_ARMOR_TARGET,
      maximumValues: EXACT_ARMOR_TARGET,
    }),
  });

  assert.equal(baseline[0].canonicalId, decorated[0].canonicalId);
  assert.equal(baseline[0].canonicalId, repeated[0].canonicalId);
  assert.equal(baseline[0].canonicalId, pointRange[0].canonicalId,
    "exact and range [T,T] must select the same canonical witness");
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
  const source = [invalid, valid];
  source.status = "RULE_FEASIBLE_PROVEN";
  source.certificate = { proof: { exhaustive: true } };

  const preferred = preferConstraintSatisfyingSolutions(source, target, constraints);
  assert.deepEqual(
    [...preferred],
    [valid],
    "rule satisfaction must win even when its fit score is numerically larger",
  );
  assert.equal(preferred.status, source.status);
  assert.equal(preferred.certificate, source.certificate);
});
