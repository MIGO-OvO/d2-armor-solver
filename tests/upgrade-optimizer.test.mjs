import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeUpgradeCandidates,
  compareUpgradeMetrics,
  compareUpgradePlans,
  createDefaultUpgradePiece,
  evaluateUpgradePieces,
  getUpgradeMetrics,
  normalizeUpgradePiece,
} from "../src/core/upgrade-optimizer.mjs";
import {
  ARCHETYPES, BASE_CONFIGS, STATS,
} from "../src/core/armor-model.mjs";

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

// Regression: a target the from-scratch solver hits exactly must also be found
// by the upgrade optimizer when only 1-2 of the currently equipped pieces need
// swapping. The greedy tertiary seed for the kept archetype used to be forced
// onto the slot, inflating the seed's replacement count so the exact solution
// was truncated out of the per-bucket top-N before refinement.
test("a two-piece swap that exactly reaches the target is found, not over-replaced", () => {
  const target = {
    health: 40, melee: 80, grenade: 100, super: 100, class: 60, weapons: 120,
  };
  const fragments = Object.fromEntries(STATS.map(stat => [stat, 0]));

  const makePiece = (archName, tertiary, tuning, mod, index) => {
    const config = BASE_CONFIGS.find(c =>
      c.archetype === archName && c.tertiary === tertiary);
    return normalizeUpgradePiece({
      archetypeId: ARCHETYPES.find(a => a.name === archName)?.id,
      tertiary,
      tuningMode: "shift",
      tuningFrom: tuning.from || "health",
      tuningTo: tuning.to || "weapons",
      armorModSize: mod?.size || 0,
      armorModStat: mod?.stat || config.secondary,
      baseStats: { ...config.baseStats },
      locked: false,
    }, index);
  };

  // Fixture from a known exact from-scratch solution for this target:
  // 突围者/melee + 高能者/melee + 高能者/grenade + 高能者/melee + 高能者/grenade.
  const archetypes = ["突围者", "高能者", "高能者", "高能者", "高能者"];
  const tertiaries = ["melee", "melee", "grenade", "melee", "grenade"];
  const tuningTo = ["class", "class", "health", "class", "grenade"];
  const tuningFrom = ["health", "health", "super", "weapons", "health"];
  const pieces = archetypes.map((archetype, index) => makePiece(
    archetype, tertiaries[index],
    { from: tuningFrom[index], to: tuningTo[index] },
    { size: 10, stat: ["grenade", "class", "melee", "grenade", "class"][index] },
    index
  ));
  // Sanity: this exact loadout reaches the target.
  const exact = evaluateUpgradePieces(pieces, target, fragments, true);
  assert.equal(exact.metrics.allReached, true, "fixture: exact loadout reaches the target");

  // Slots 1 and 3 are equipped with the wrong archetype; restoring them (a
  // two-piece swap) is the exact fix.
  const broken = pieces.map((piece, index) => index === 1 || index === 3
    ? makePiece(
      "突围者", piece.tertiary,
      { from: piece.tuningFrom, to: piece.tuningTo },
      { size: piece.armorModSize, stat: piece.armorModStat }, index
    )
    : piece);

  const analysis = analyzeUpgradeCandidates(broken, target, fragments, true);
  assert.ok(analysis.plan, "a two-piece swap exists and must be reported");
  assert.equal(analysis.plan.metrics.allReached, true);
  assert.equal(
    analysis.plan.replacementCount, 2,
    `expected the exact 2-swap plan, got ${analysis.plan.replacementCount} replacements`
  );
  assert.equal(
    analysis.plan.evaluation.finalTotals.weapons, target.weapons,
    "the plan must land exactly on the target"
  );
});

// "Only +5/-5" restricts every proposed plan and candidate, while the entered
// baseline keeps reporting the +3 pieces the player actually has equipped.
test("only +5/-5 analysis never proposes +3 pieces but keeps the real baseline", () => {
  const pieces = Array.from({ length: 5 }, (_, index) =>
    createDefaultUpgradePiece(index));
  pieces[0].tuningMode = "plus3";
  pieces[1].tuningMode = "plus3";
  const targets = {
    health: 100, melee: 100, grenade: 100, super: 70, class: 70, weapons: 70,
  };
  const fragments = Object.fromEntries(STATS.map(stat => [stat, 0]));
  const countPlus3 = evaluation =>
    evaluation.tuningAssignments.filter(t => t && t.mode === "+3").length;

  const restricted = analyzeUpgradeCandidates(
    pieces, targets, fragments, true, [], true
  );

  assert.equal(countPlus3(restricted.enteredBaseline), 2,
    "entered baseline must keep reporting the equipped +3 pieces");
  assert.equal(countPlus3(restricted.baseline), 0,
    "baseline must be reachable without +3");
  assert.ok(restricted.rankings.every(candidate =>
    candidate.afterPiece.tuningMode !== "plus3"),
  "no replacement candidate may carry +3");
  if (restricted.plan) {
    assert.equal(countPlus3(restricted.plan.evaluation), 0,
      "the plan must never assign +3");
  }
});

// Regression: a plan that meets the must-meet stats with fewer swaps must beat
// a bigger plan that also meets them but only narrows the optional shortfall.
test("must-meet plans prefer fewer swaps; unmet must-meet still outranks swaps", () => {
  const targets = {
    health: 100, melee: 100, grenade: 100, super: 100, class: 100, weapons: 100,
  };
  const required = ["weapons"];
  const mkPlan = (swaps, totals) => ({
    replacementCount: swaps,
    replacements: [],
    metrics: getUpgradeMetrics(totals, targets, 0, required),
    evaluation: { score: 0 },
  });
  // 2 swaps: weapons met, other stats short. 3 swaps: everything met.
  const twoSwap = mkPlan(2, {
    health: 90, melee: 90, grenade: 90, super: 90, class: 90, weapons: 100,
  });
  const threeSwap = mkPlan(3, {
    health: 100, melee: 100, grenade: 100, super: 100, class: 100, weapons: 100,
  });
  assert.ok(compareUpgradePlans(twoSwap, threeSwap) < 0,
    "fewer swaps must win when both plans meet the required stat");
  // Swap the -5 source around so the required stat is missed on the 2-swap plan.
  const twoSwapUnmet = mkPlan(2, {
    health: 90, melee: 90, grenade: 90, super: 90, class: 90, weapons: 95,
  });
  assert.ok(compareUpgradePlans(threeSwap, twoSwapUnmet) < 0,
    "an unmet required stat must still outrank the swap count");
  // Without required stats, reaching every target outranks fewer swaps.
  const noRequiredOne = {
    replacementCount: 1,
    replacements: [],
    metrics: getUpgradeMetrics({
      health: 90, melee: 90, grenade: 90, super: 90, class: 90, weapons: 90,
    }, targets, 0, []),
    evaluation: { score: 0 },
  };
  const noRequiredTwo = {
    replacementCount: 2,
    replacements: [],
    metrics: getUpgradeMetrics({
      health: 100, melee: 100, grenade: 100, super: 100, class: 100, weapons: 100,
    }, targets, 0, []),
    evaluation: { score: 0 },
  };
  assert.ok(compareUpgradePlans(noRequiredTwo, noRequiredOne) < 0,
    "without required stats, reaching targets must outrank the swap count");
});

