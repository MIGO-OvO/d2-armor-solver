import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeUpgradeCandidates,
  compareUpgradeMetrics,
  createDefaultUpgradePiece,
  getUpgradeMetrics,
} from "../src/core/upgrade-optimizer.mjs";
import { STATS } from "../src/core/armor-model.mjs";

const TARGETS = {
  health: 20,
  melee: 50,
  grenade: 60,
  super: 80,
  class: 100,
  weapons: 180,
};

test("required targets outrank a smaller total shortfall", () => {
  const smallerTotalGap = getUpgradeMetrics({
    health: 20,
    melee: 50,
    grenade: 60,
    super: 80,
    class: 100,
    weapons: 170,
  }, TARGETS, 0, ["weapons"]);
  const requiredTargetMet = getUpgradeMetrics({
    health: 0,
    melee: 40,
    grenade: 60,
    super: 80,
    class: 100,
    weapons: 180,
  }, TARGETS, 0, ["weapons"]);

  assert.equal(smallerTotalGap.shortfall, 10);
  assert.equal(requiredTargetMet.shortfall, 30);
  assert.equal(smallerTotalGap.requiredAllReached, false);
  assert.equal(requiredTargetMet.requiredAllReached, true);
  assert.ok(compareUpgradeMetrics(requiredTargetMet, smallerTotalGap) < 0);
});

test("unreachable required targets fall back to the smallest required gap", () => {
  const closerRequiredGap = getUpgradeMetrics({
    ...TARGETS,
    health: 0,
    weapons: 175,
  }, TARGETS, 0, ["weapons"]);
  const smallerOverallGap = getUpgradeMetrics({
    ...TARGETS,
    weapons: 170,
  }, TARGETS, 0, ["weapons"]);

  assert.equal(closerRequiredGap.requiredShortfall, 5);
  assert.equal(smallerOverallGap.requiredShortfall, 10);
  assert.ok(compareUpgradeMetrics(closerRequiredGap, smallerOverallGap) < 0);
});

test("replacement planning allocates farmable armor to a required stat first", () => {
  const pieces = Array.from({ length: 5 }, (_, index) =>
    createDefaultUpgradePiece(index));
  const targets = {
    health: 200,
    melee: 200,
    grenade: 200,
    super: 200,
    class: 200,
    weapons: 180,
  };
  const fragments = Object.fromEntries(STATS.map(stat => [stat, 0]));

  const analysis = analyzeUpgradeCandidates(
    pieces, targets, fragments, true, ["weapons"]
  );

  assert.ok(analysis.plan);
  assert.equal(analysis.plan.metrics.requiredAllReached, true);
  assert.ok(analysis.plan.evaluation.finalTotals.weapons >= 180);
});
