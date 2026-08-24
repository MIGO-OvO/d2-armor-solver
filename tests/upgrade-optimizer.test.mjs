import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeUpgradeCandidates,
  applyManualUpgradeModifiers,
  compareUpgradeMetrics,
  compareUpgradePlans,
  createDefaultUpgradePiece,
  createUpgradePieceFromItem,
  evaluateUpgradePieces,
  getUpgradeConfig,
  getUpgradeMetrics,
  getUpgradePieceIdentity,
  getUpgradeReplacements,
  normalizeUpgradePiece,
  refineUpgradePlanPieces,
  resolveCurrentLoadoutTotals,
  sameUpgradeIdentity,
} from "../src/core/upgrade-optimizer.mjs";
import {
  ARCHETYPES, BASE_CONFIGS, STATS,
} from "../src/core/armor-model.mjs";
import { scoreStatsRank } from "../src/core/solver.mjs";

const TARGETS = {
  health: 20,
  melee: 50,
  grenade: 60,
  super: 80,
  class: 100,
  weapons: 180,
};

test("current loadout targets prefer Bungie's aggregate stats without adding fragments twice", () => {
  const exactTotals = {
    health: 61,
    melee: 72,
    grenade: 83,
    super: 94,
    class: 105,
    weapons: 116,
  };
  const fragments = Object.fromEntries(STATS.map(stat => [stat, 10]));

  assert.deepEqual(resolveCurrentLoadoutTotals([], fragments, exactTotals), exactTotals);
});

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

test("high-priority target gaps outrank a smaller unprioritized total gap", () => {
  const targets = Object.fromEntries(STATS.map(stat => [stat, 100]));
  const fragments = Object.fromEntries(STATS.map(stat => [stat, 0]));
  const constraints = {
    minimums: { health: 100 },
    priorityLevels: { weapons: 1 },
    exact: Object.fromEntries(STATS.map(stat => [stat, true])),
  };
  const highPriorityCloser = {
    health: 100, melee: 100, grenade: 0, super: 100, class: 100, weapons: 90,
  };
  const totalGapCloser = {
    health: 100, melee: 100, grenade: 100, super: 100, class: 100, weapons: 50,
  };
  const metrics = totals => getUpgradeMetrics(
    totals, targets, 0, ["health"],
    scoreStatsRank(totals, targets, constraints), constraints, fragments,
  );

  assert.equal(metrics(highPriorityCloser).requiredAllReached, true);
  assert.equal(metrics(totalGapCloser).requiredAllReached, true);
  assert.ok(
    metrics(highPriorityCloser).shortfall > metrics(totalGapCloser).shortfall,
    "fixture: the preferred plan deliberately has a larger unprioritized total gap",
  );
  assert.ok(compareUpgradeMetrics(
    metrics(highPriorityCloser), metrics(totalGapCloser),
  ) < 0, "the high-priority Weapons gap must be compared before the generic gap");
});

test("upgrade evaluation preserves priority metadata instead of hiding it behind default exact rules", () => {
  const pieces = Array.from({ length: 5 }, (_, index) =>
    createDefaultUpgradePiece(index));
  const targets = Object.fromEntries(STATS.map(stat => [
    stat, stat === "weapons" ? 200 : 60,
  ]));
  const fragments = Object.fromEntries(STATS.map(stat => [stat, 0]));
  const constraints = {
    priorityLevels: { weapons: 1 },
    exact: Object.fromEntries(STATS.map(stat => [stat, true])),
  };

  const evaluation = evaluateUpgradePieces(
    pieces, targets, fragments, false, [], false, constraints,
  );

  assert.equal(evaluation.rank[1], 0,
    "default exact flags must not pre-empt priority ordering for partial plans");
  assert.ok(evaluation.rank[2] > 0,
    "the High-priority Weapons gap must survive constraint construction");
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

  for (const requiredStats of [["health"], STATS]) {
    const requiredAnalysis = analyzeUpgradeCandidates(
      broken, target, fragments, true, requiredStats
    );
    const label = requiredStats.length === STATS.length ? "all stats" : requiredStats[0];
    assert.ok(requiredAnalysis.plan,
      `the exact two-piece plan must survive the ${label} required selection`);
    assert.equal(requiredAnalysis.plan.metrics.allReached, true,
      `${label} required must not demote a plan that reaches the full target`);
    assert.equal(
      requiredAnalysis.plan.replacementCount, 2,
      `${label} required: expected 2 replacements, got ${requiredAnalysis.plan.replacementCount}`
    );
  }
});

// Regression for the real DIM-import scenario reported in the UI. The current
// values are the item's present masterwork values, while from-scratch solving
// and farming advice both assume the same pieces at full masterwork. Planning
// must use that projection without changing the entered/current-stat display.
test("upgrade planning uses full-masterwork projections for kept DIM pieces", () => {
  const grenadier = ARCHETYPES.find(archetype => archetype.id === "Grenadier");
  const fullStats = BASE_CONFIGS.find(config =>
    config.archetype === grenadier.name && config.tertiary === "melee"
  ).baseStats;
  const currentStats = [
    fullStats,
    fullStats,
    { health: 0, melee: 20, grenade: 30, super: 25, class: 4, weapons: 0 },
    { health: 0, melee: 20, grenade: 30, super: 25, class: 0, weapons: 0 },
    fullStats,
  ];
  const pieces = currentStats.map((baseStats, index) => normalizeUpgradePiece({
    archetypeId: "Grenadier",
    tertiary: "melee",
    baseStats: { ...baseStats },
    optimizationBaseStats: { ...fullStats },
    tuningMode: index === 3 ? "plus3" : "shift",
    tuningFrom: "class",
    tuningTo: index === 2 ? "melee" : "super",
    armorModSize: [5, 5, 10, 10, 10][index],
    armorModStat: index === 4 ? "melee" : "super",
    exotic: index === 1,
    locked: index === 1,
  }, index));
  const targets = {
    health: 35, melee: 100, grenade: 130, super: 200, class: 0, weapons: 25,
  };
  const fragments = {
    health: 10, melee: -20, grenade: 0, super: 10, class: 0, weapons: 0,
  };

  const analysis = analyzeUpgradeCandidates(
    pieces, targets, fragments, true, [], true
  );

  assert.deepEqual(analysis.enteredBaseline.finalTotals, {
    health: 26, melee: 95, grenade: 150, super: 180, class: 0, weapons: 16,
  }, "the entered baseline must keep the current DIM/masterwork values");
  assert.ok(analysis.plan, "the projected full-masterwork loadout has an exact plan");
  assert.equal(analysis.plan.metrics.allReached, true);
  assert.equal(
    analysis.plan.replacementCount, 2,
    "only legs and class item need farming after retained pieces are projected"
  );
  assert.deepEqual(
    analysis.plan.replacements.map(replacement => replacement.slotIndex).sort(),
    [3, 4]
  );
  assert.ok(analysis.plan.pieces.every(piece => piece.tuningMode !== "plus3"));
});

test("legacy upgrade drafts reconstruct their full-masterwork projection", () => {
  const piece = normalizeUpgradePiece({
    archetypeId: "Grenadier",
    tertiary: "melee",
    baseStats: {
      health: 2, melee: 20, grenade: 30, super: 25, class: 2, weapons: 2,
    },
    masterworkTier: 2,
  }, 0);

  assert.deepEqual(piece.optimizationBaseStats, {
    health: 5, melee: 20, grenade: 30, super: 25, class: 5, weapons: 5,
  });
});

// Regression (handoff 3.4): the Bungie path used to fabricate a tuning
// destination with `STATS.find(stat => stat !== tertiary)` when neither the
// installed plug nor the fixed tuning stat was known. That guess produced
// wrong six-stat totals and DIM assignments for armor whose tuning socket data
// was missing. An unknown fixed tuning stat must stay unknown.
test("an imported piece with unknown tuning never fabricates a direction", () => {
  const item = {
    id: "instance-1",
    hash: 656307180,
    name: "Eidolon Pursuant Mask",
    slot: "helmet",
    classId: "hunter",
    tier: "5",
    rarity: "Legendary",
    exotic: false,
    archetypeId: "Powerhouse",
    tertiary: "grenade",
    tuningStat: null, // no reusable plugs: fixed stat cannot be confirmed
    baseStats: { health: 5, melee: 5, grenade: 20, super: 25, class: 5, weapons: 30 },
    masterworkTier: 10,
    tuningMode: null, // no tuning installed
    tuningFrom: null,
    tuningTo: null,
    armorModSize: 0,
    armorModStat: null,
  };
  const piece = createUpgradePieceFromItem(item, 0);
  assert.equal(piece.tuningUnknown, true);
  assert.equal(piece.tuningTo, null, "no fabricated +5 destination");
  assert.equal(piece.tuningFrom, null);
  // Manual totals must skip the unknown tuning instead of counting a guess.
  // effectiveBaseStats already carries the masterwork bonus: health 5+5.
  const totals = applyManualUpgradeModifiers(getUpgradeConfig(piece), piece);
  assert.equal(totals.health, 10, "masterwork-inclusive base only: the unknown tuning adds nothing");
  assert.equal(totals.weapons, 30);
});

test("a known fixed tuning stat becomes the piece's tuning destination", () => {
  const item = {
    id: "instance-2",
    hash: 656307180,
    slot: "helmet",
    classId: "hunter",
    tier: "5",
    rarity: "Legendary",
    exotic: false,
    archetypeId: "Powerhouse",
    tertiary: "grenade",
    tuningStat: "health", // derived from the tuning socket's reusable plugs
    baseStats: { health: 5, melee: 5, grenade: 20, super: 25, class: 5, weapons: 30 },
    masterworkTier: 10,
    tuningMode: null,
    tuningFrom: null,
    tuningTo: null,
    armorModSize: 0,
    armorModStat: null,
  };
  const piece = createUpgradePieceFromItem(item, 0);
  assert.equal(piece.tuningUnknown, false);
  assert.equal(piece.tuningTo, "health");
});

test("Exotic tuning stays free while Legendary +5 destinations stay fixed", () => {
  const config = BASE_CONFIGS.find(entry =>
    entry.archetype === "突围者" && entry.tertiary === "melee");
  const pieces = Array.from({ length: 5 }, (_, index) => normalizeUpgradePiece({
    archetypeId: "Siegebreaker",
    tertiary: "melee",
    tuningMode: "shift",
    tuningFrom: "health",
    tuningTo: index === 0 ? "class" : "weapons",
    armorModSize: 0,
    armorModStat: "health",
    baseStats: { ...config.baseStats },
    exotic: index === 0,
  }, index));
  const target = Object.fromEntries(STATS.map(stat => [
    stat,
    pieces.reduce((sum, piece) => sum + piece.baseStats[stat], 0),
  ]));
  target.health -= 25;
  target.melee += 5;
  target.weapons += 20;
  const fragments = Object.fromEntries(STATS.map(stat => [stat, 0]));
  const constraints = { exact: Object.fromEntries(STATS.map(stat => [stat, true])) };

  const exoticResult = evaluateUpgradePieces(
    pieces, target, fragments, true, [], false, constraints
  );
  assert.equal(exoticResult.metrics.allReached, true);
  assert.equal(exoticResult.tuningAssignments[0].to, "melee",
    "the Exotic may choose a +5 destination different from its installed value");

  const legendaryResult = evaluateUpgradePieces(
    pieces.map((piece, index) => ({ ...piece, exotic: false, locked: index === 0 })),
    target, fragments, true, [], false, constraints
  );
  assert.equal(legendaryResult.metrics.allReached, false,
    "the same +5 destination remains fixed on Legendary armor");
  assert.equal(legendaryResult.tuningAssignments[0].to, "class");
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

// Regression: the +3 pieces the player owns must not leak into the plan output.
// "Only +5/-5" reads them as +5/-5 pieces everywhere, so the plan's kept pieces
// and every step's farmed piece carry +5/-5 tuning, never +3.
test("only +5/-5 plan pieces and steps never carry +3", () => {
  const pieces = Array.from({ length: 5 }, (_, index) =>
    normalizeUpgradePiece({
      archetypeId: ["Brawler", "Grenadier", "Paragon", "Specialist", "Gunner"][index],
      tertiary: ["grenade", "health", "health", "health", "health"][index],
      tuningMode: "plus3",
      tuningFrom: ["melee", "grenade", "super", "class", "weapons"][index],
      tuningTo: "health",
      armorModSize: [10, 5, 5, 5, 0][index],
      armorModStat: ["melee", "grenade", "super", "health", "class"][index],
      locked: index === 0,
    }, index));
  const targets = {
    health: 80, melee: 55, grenade: 85, super: 105, class: 50, weapons: 90,
  };
  const fragments = {
    health: 9, melee: 14, grenade: 0, super: 2, class: 5, weapons: 8,
  };

  const restricted = analyzeUpgradeCandidates(pieces, targets, fragments, true, [], true);
  assert.ok(restricted.plan, "the scenario must produce a plan");
  assert.ok(
    restricted.plan.pieces.every(piece => piece.tuningMode !== "plus3"),
    "kept plan pieces must be read as +5/-5, not +3"
  );
  assert.ok(
    restricted.plan.steps.every(step => step.afterPiece.tuningMode !== "plus3"),
    "a farmed replacement must never be proposed with +3 tuning"
  );
  // The entered state still reports the real +3 pieces.
  assert.equal(
    restricted.enteredBaseline.tuningAssignments.filter(t => t && t.mode === "+3").length, 5,
    "entered baseline must keep reporting the equipped +3 pieces"
  );
});

// Full-target feasibility is always the primary goal. Required stats only
// prioritize partial plans after no full-target plan exists.
test("full-target plans outrank partial required-stat plans", () => {
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
  assert.ok(compareUpgradePlans(threeSwap, twoSwap) < 0,
    "a full-target plan must beat a smaller plan that only meets required stats");
  const threeSwapEquivalent = mkPlan(3, {
    health: 100, melee: 100, grenade: 100, super: 100, class: 100, weapons: 100,
  });
  const twoSwapExact = { ...threeSwapEquivalent, replacementCount: 2 };
  assert.ok(compareUpgradePlans(twoSwapExact, threeSwapEquivalent) < 0,
    "among full-target plans, fewer replacements must win");
  // Only when neither plan reaches the full target do required stats decide.
  const oneSwapUnmet = mkPlan(1, {
    health: 90, melee: 90, grenade: 90, super: 90, class: 90, weapons: 95,
  });
  assert.ok(compareUpgradePlans(twoSwap, oneSwapUnmet) < 0,
    "among partial plans, meeting a required stat must outrank the swap count");
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
  const noRequiredEqualOne = {
    ...noRequiredTwo,
    replacementCount: 1,
  };
  assert.ok(compareUpgradePlans(noRequiredEqualOne, noRequiredTwo) < 0,
    "equivalent plans without required stats must still prefer fewer swaps");
});

test("plan refinement counts swaps against the equipped loadout, not its seed", () => {
  const equipped = Array.from({ length: 5 }, (_, index) =>
    createDefaultUpgradePiece(index));
  const seed = equipped.map((piece, index) => index < 2
    ? normalizeUpgradePiece({
      ...piece,
      tuningTo: STATS.find(stat =>
        stat !== piece.tuningFrom && stat !== piece.tuningTo),
    }, index)
    : { ...piece });

  assert.equal(getUpgradeReplacements(equipped, seed).length, 2,
    "fixture: the seed starts two swaps away from the equipped loadout");

  const evaluateBySwapCount = candidatePieces => {
    const swapCount = getUpgradeReplacements(equipped, candidatePieces).length;
    return {
      score: swapCount,
      metrics: {
        requiredCount: 0,
        allReached: swapCount === 0,
        shortfall: swapCount,
        maxShortfall: swapCount,
        reachedCount: STATS.length - swapCount,
        exactCount: STATS.length - swapCount,
        excess: 0,
        score: swapCount,
      },
    };
  };
  const refined = refineUpgradePlanPieces(
    seed, [0, 1], {}, {}, false, evaluateBySwapCount, false, equipped
  );

  assert.equal(getUpgradeReplacements(equipped, refined.pieces).length, 0,
    "refinement should be able to restore seed slots and reduce the real swap count");
});

test("plan refinement never reduces swaps by breaking a must-meet constraint", () => {
  const equipped = Array.from({ length: 5 }, (_, index) =>
    createDefaultUpgradePiece(index));
  const seed = equipped.map((piece, index) => index < 3
    ? normalizeUpgradePiece({
      ...piece,
      tuningTo: STATS.find(stat =>
        stat !== piece.tuningFrom && stat !== piece.tuningTo),
    }, index)
    : { ...piece });
  const evaluateRequired = candidatePieces => {
    const swapCount = getUpgradeReplacements(equipped, candidatePieces).length;
    const requiredAllReached = swapCount === 3;
    return {
      score: swapCount,
      metrics: {
        requiredCount: 1,
        requiredAllReached,
        requiredShortfall: requiredAllReached ? 0 : 5,
        requiredMaxShortfall: requiredAllReached ? 0 : 5,
        requiredReachedCount: requiredAllReached ? 1 : 0,
        allReached: false,
        shortfall: requiredAllReached ? 10 : 5,
        maxShortfall: requiredAllReached ? 10 : 5,
        reachedCount: requiredAllReached ? 1 : 2,
        exactCount: 0,
        excess: 0,
        score: swapCount,
      },
    };
  };
  const refined = refineUpgradePlanPieces(
    seed, [0, 1, 2], {}, {}, false, evaluateRequired, false, equipped
  );

  assert.equal(getUpgradeReplacements(equipped, refined.pieces).length, 3,
    "a lower-swap variant that misses a required target must be rejected");
  assert.equal(refined.evaluation.metrics.requiredAllReached, true);
});

test("exotic class item identity distinguishes same-frame rolls with different perks", () => {
  // Two exotic class item rolls share the Paragon frame (super 30 / melee 25 /
  // grenade 20) but carry different perk pairs. The perks are rolled onto the
  // item, so the identities must differ — the locked roll is not interchangeable
  // with the other one even though the stat frames match.
  const base = {
    archetypeId: "Paragon",
    tertiary: "grenade",
    tuningMode: "shift",
    tuningTo: "recovery",
    tuningFrom: "mobility",
    armorModSize: 10,
    armorModStat: "recovery",
    exotic: true,
    locked: true,
    baseStats: { health: 5, class: 5, grenade: 20, super: 30, melee: 25, weapons: 5 },
    hash: 2809120022,
  };
  const inmostRoll = normalizeUpgradePiece({
    ...base, itemName: "光能+曲蛛的楷模典范", primaryPerkId: "inmost", secondaryPerkId: "cyrtarachne",
  }, 4);
  const galanorRoll = normalizeUpgradePiece({
    ...base, itemName: "加拉诺+曲蛛的楷模典范", primaryPerkId: "galanor", secondaryPerkId: "cyrtarachne",
  }, 4);
  const csvRoll = normalizeUpgradePiece({ ...base, primaryPerkId: null, secondaryPerkId: null }, 4);

  assert.equal(
    sameUpgradeIdentity(getUpgradePieceIdentity(inmostRoll), getUpgradePieceIdentity(inmostRoll)),
    true,
    "a roll matches itself"
  );
  assert.equal(
    sameUpgradeIdentity(getUpgradePieceIdentity(inmostRoll), getUpgradePieceIdentity(galanorRoll)),
    false,
    "same frame, different primary perk -> different piece"
  );
  assert.equal(
    sameUpgradeIdentity(getUpgradePieceIdentity(inmostRoll), getUpgradePieceIdentity(csvRoll)),
    false,
    "a perk-known roll is not interchangeable with a perk-unknown one"
  );
  assert.equal(
    sameUpgradeIdentity(getUpgradePieceIdentity(csvRoll), getUpgradePieceIdentity(csvRoll)),
    true,
    "perk-unknown rolls still match on the stat frame"
  );
});

test("at-most caps apply to the optimize-existing-loadout evaluation", () => {
  const baseStats = {
    health: 70, melee: 70, grenade: 130, super: 70, class: 80, weapons: 80,
  };
  const pieces = ["helmet", "arms", "chest", "legs", "classItem"].map((slot, index) => {
    const piece = createDefaultUpgradePiece(index);
    return normalizeUpgradePiece(
      { ...piece, slot, baseStats: { ...baseStats } },
      index,
    );
  });
  // Balanced six-stat target (sum = 500, the exact budget): reaching every
  // other stat forces any surplus out of the capped stat.
  const targets = {
    health: 100, melee: 100, grenade: 100, super: 100, class: 100, weapons: 100,
  };
  const fragments = Object.fromEntries(STATS.map(stat => [stat, 0]));

  // Without a rule the same five pieces are "fully reached" and kept as-is.
  const plain = evaluateUpgradePieces(pieces, targets, fragments, false, [], false);
  assert.equal(plain.metrics.allReached, true);
  assert.equal(plain.metrics.constraintBoundaryViolations, 0);

  // With "至多 grenade 100" the leftover grenade becomes a hard cap violation,
  // so the baseline is no longer reported as "keep your armor".
  const constraints = { maximums: { grenade: 100 } };
  const capped = evaluateUpgradePieces(pieces, targets, fragments, false, [], false, constraints);
  assert.equal(capped.metrics.constraintBoundaryViolations, 1);
  assert.equal(capped.metrics.allReached, false);

  // The replacement analysis must find a plan that respects the cap and does
  // NOT treat the cap as a value to reach: surplus flows to other targets
  // instead of being parked exactly at the cap.
  const analysis = analyzeUpgradeCandidates(
    pieces, targets, fragments, true, [], false, constraints,
  );
  assert.ok(analysis.plan, "a cap-respecting replacement plan should be found");
  assert.equal(analysis.plan.metrics.constraintBoundaryViolations, 0);
  assert.ok(
    analysis.plan.evaluation.finalTotals.grenade < 100,
    "the recommended plan must keep grenade below the at-most cap instead of pinning it to the cap",
  );
});

test("at-most stats below their cap count as met with no shortfall", () => {
  const targets = Object.fromEntries(STATS.map(stat => [stat, 50]));
  const fragments = Object.fromEntries(STATS.map(stat => [stat, 10]));
  const constraints = { maximums: { weapons: 40 } }; // +10 fragments => final cap 50
  const belowCap = { ...targets, weapons: 45 };
  const aboveCap = { ...targets, weapons: 55 };

  const below = getUpgradeMetrics(belowCap, targets, 0, [], null, constraints, fragments);
  assert.equal(below.reachedCount, STATS.length, "a capped stat below its cap is met");
  assert.equal(below.shortfall, 0, "being below an at-most cap is not a shortfall");
  assert.equal(below.excess, 0, "being below an at-most cap is not an excess");
  assert.equal(below.constraintBoundaryViolations, 0);
  assert.equal(below.allReached, true);

  const over = getUpgradeMetrics(aboveCap, targets, 0, [], null, constraints, fragments);
  assert.equal(over.reachedCount, STATS.length - 1, "exceeding the at-most cap is NOT met");
  assert.equal(over.excess, 5, "the amount over the fragment-adjusted cap is the excess");
  assert.equal(over.constraintBoundaryViolations, 1);
  assert.equal(over.allReached, false);
});

test("at-most metric accounting returns to the final domain for fragments", () => {
  const targets = Object.fromEntries(STATS.map(stat => [stat, 50]));
  const fragments = Object.fromEntries(STATS.map(stat => [stat, 20]));
  // Armor-needed cap of 30 + 20 fragment bonus = final cap of 50.
  const constraints = { maximums: { weapons: 30 } };
  const atCap = {
    ...targets, weapons: 50,
  };
  const overCap = {
    ...targets, weapons: 55,
  };
  assert.equal(
    getUpgradeMetrics(atCap, targets, 0, [], null, constraints, fragments)
      .constraintBoundaryViolations,
    0,
    "exactly at the fragment-adjusted cap is not a violation",
  );
  assert.equal(
    getUpgradeMetrics(overCap, targets, 0, [], null, constraints, fragments)
      .constraintBoundaryViolations,
    1,
    "past the fragment-adjusted cap is a violation",
  );
});

test("all-required upgrade search stays exact when from-scratch proves feasibility", () => {
  const target = {
    health: 75, melee: 65, grenade: 110, super: 105, class: 35, weapons: 110,
  };
  const fragments = Object.fromEntries(STATS.map(stat => [stat, 0]));
  const constraints = {
    exact: Object.fromEntries(STATS.map(stat => [stat, true])),
  };
  const pieces = [
    {
      slot: "helmet", archetypeId: "Paragon", tertiary: "grenade",
      tuningMode: "shift", tuningFrom: "grenade", tuningTo: "melee",
      armorModSize: 10, armorModStat: "class", exotic: true, locked: true,
      baseStats: { health: 5, melee: 25, grenade: 20, super: 30, class: 5, weapons: 5 },
    },
    {
      slot: "arms", archetypeId: "Powerhouse", tertiary: "grenade",
      tuningMode: "shift", tuningFrom: "grenade", tuningTo: "class",
      armorModSize: 10, armorModStat: "super", exotic: false, locked: false,
      baseStats: { health: 5, melee: 5, grenade: 20, super: 25, class: 5, weapons: 30 },
    },
    {
      slot: "chest", archetypeId: "Specialist", tertiary: "grenade",
      tuningMode: "shift", tuningFrom: "health", tuningTo: "class",
      armorModSize: 10, armorModStat: "grenade", exotic: false, locked: false,
      baseStats: { health: 5, melee: 5, grenade: 20, super: 5, class: 30, weapons: 25 },
    },
    {
      slot: "legs", archetypeId: "Grenadier", tertiary: "health",
      tuningMode: "shift", tuningFrom: "grenade", tuningTo: "class",
      armorModSize: 10, armorModStat: "health", exotic: false, locked: false,
      baseStats: { health: 20, melee: 5, grenade: 30, super: 25, class: 5, weapons: 5 },
    },
    {
      slot: "classItem", archetypeId: "Skirmisher", tertiary: "grenade",
      tuningMode: "shift", tuningFrom: "melee", tuningTo: "class",
      armorModSize: 10, armorModStat: "class", exotic: false, locked: false,
      baseStats: { health: 5, melee: 30, grenade: 20, super: 5, class: 5, weapons: 25 },
    },
  ].map((piece, index) => normalizeUpgradePiece(piece, index));

  const analysis = analyzeUpgradeCandidates(
    pieces, target, fragments, true, STATS, false, constraints,
  );

  assert.equal(analysis.baseline.metrics.allReached, false,
    "fixture: rearranging the current fixed Legendary +5 rolls is not exact");
  assert.ok(analysis.plan, "the exact plan proven by from-scratch solving must be reported");
  assert.equal(analysis.plan.metrics.allReached, true);
  assert.deepEqual(analysis.plan.evaluation.finalTotals, target);
});
