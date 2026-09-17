import assert from 'node:assert/strict';
import test from 'node:test';
import {STATS, BASE_CONFIGS} from '../src/core/armor-model.mjs';
import {scoreStatsRank, compareScoreRanks, scoreStatsLowerBound, findBestRelaxedTargets} from '../src/core/solver.mjs';
import {getUpgradeMetrics, compareUpgradeMetrics, compareUpgradePlans, normalizeUpgradePiece,
  evaluateUpgradePieces, refineUpgradeNeighborhood, refineUpgradeAssignment} from '../src/core/upgrade-optimizer.mjs';
import {getAssignmentCost} from '../src/core/assignment-cost.mjs';

const target = Object.fromEntries(STATS.map(stat => [stat, 100]));
const exact = {exact: Object.fromEntries(STATS.map(stat => [stat, true]))};
const metrics = (values, constraints) => getUpgradeMetrics(values, target, 0, [],
  scoreStatsRank(values, target, constraints), constraints);

test('same-tier five satisfied rules outrank four with a smaller total gap across solvers', () => {
  const four = {...target, health: 99, melee: 99};
  const five = {...target, health: 80};
  assert.ok(compareScoreRanks(scoreStatsRank(five, target, exact), scoreStatsRank(four, target, exact)) < 0);
  assert.ok(compareUpgradeMetrics(metrics(five, exact), metrics(four, exact)) < 0);
});

test('legal range interiors have zero quality gap, including explicit high priority', () => {
  const constraints = {minimums: {health: 70}, maximums: {health: 110}, priorityLevels: {health: 1}};
  assert.deepEqual(scoreStatsRank({...target, health: 80}, target, constraints), Array(9).fill(0));
  assert.equal(compareUpgradeMetrics(metrics({...target, health: 80}, constraints), metrics(target, constraints)), 0);
});

test('explicit zero and legacy caps replace an implicit target floor', () => {
  assert.deepEqual(scoreStatsRank({...target, health: 0}, target, {force0: {health: true}}), Array(9).fill(0));
  assert.deepEqual(scoreStatsRank(target, {...target, health: 180}, {le100: {health: true}}), Array(9).fill(0));
});

test('rank lower bounds are admissible and keep a boolean first field', () => {
  const constraints = {...exact, priorityLevels: {health: 1, grenade: 2}};
  const base = STATS.map(() => 90);
  const options = STATS.map(() => [0, 1, 2, 3]);
  const lower = scoreStatsLowerBound(base, options, target, constraints);
  for (const health of [90, 95, 100, 105]) for (const melee of [90, 95, 100, 105]) {
    assert.ok(compareScoreRanks(lower, scoreStatsRank({...target, health, melee}, target, constraints)) <= 0);
  }
  assert.ok(lower[0] === 0 || lower[0] === 1);
});

test('coupled lower bounds cannot overestimate when a later component forces rule infeasibility', () => {
  const goal = {health: 100, melee: 0, grenade: 0, super: 0, class: 0, weapons: 0};
  const constraints = {exact: {melee: true, grenade: true}, priorityLevels: {health: 1}};
  const lower = scoreStatsLowerBound([0, 0, 0, 0, 0, 0], [], goal, constraints,
    [[[0, 0], [20, 1]], [[1, 0]], [[0, 0]]]);
  const reachable = {...goal, melee: 5, grenade: 5};
  assert.ok(compareScoreRanks(lower, scoreStatsRank(reachable, goal, constraints)) <= 0);
});

test('relaxed K=1 retains both feasibility classes until the final stat', () => {
  const goal = {health: 10, melee: 5, grenade: 10, super: 0, class: 0, weapons: 0};
  const constraints = {exact: {melee: true, grenade: true}, priorityLevels: {health: 1}};
  const [best] = findBestRelaxedTargets(10, goal, constraints, 1);
  assert.equal(best.target.health, 10, 'once the explicit rules are jointly impossible, preserve the high preference');
});

test('seeded joint and independent score bounds never exceed any reachable assignment', () => {
  let state = 0x91a7;
  const random = n => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) % n);
  for (let trial = 0; trial < 40; trial++) {
    const base = STATS.map(() => random(21));
    const goal = Object.fromEntries(STATS.map(stat => [stat, random(6) * 5]));
    const constraints = {exact: {}, minimums: {}, maximums: {}, priorityLevels: {}};
    for (const stat of STATS) {
      const kind = random(4);
      if (kind === 1) constraints.exact[stat] = true;
      if (kind === 2) constraints.minimums[stat] = goal[stat];
      if (kind === 3) constraints.maximums[stat] = goal[stat];
      constraints.priorityLevels[stat] = random(4);
    }
    const pairs = Array.from({length: 3}, () => Array.from({length: 4}, () => [random(5) - 1, random(5) - 1]));
    const singles = STATS.map((_, index) => [...new Set(pairs[Math.floor(index / 2)].map(pair => pair[index % 2]))]);
    const bounds = [scoreStatsLowerBound(base, singles, goal, constraints), scoreStatsLowerBound(base, singles, goal, constraints, pairs)];
    for (const a of pairs[0]) for (const b of pairs[1]) for (const c of pairs[2]) {
      const units = [...a, ...b, ...c];
      const actual = Object.fromEntries(STATS.map((stat, index) => [stat, base[index] + 5 * units[index]]));
      const rank = scoreStatsRank(actual, goal, constraints);
      for (const lower of bounds) assert.ok(compareScoreRanks(lower, rank) <= 0, `trial ${trial}`);
    }
  }
});

test('relaxed top one agrees with exhaustive small integer totals across mixed rules', () => {
  for (let total = 3; total <= 8; total++) {
    const goal = {health: total, melee: 3, grenade: 5, super: 0, class: 0, weapons: 0};
    const constraints = {exact: {melee: true}, minimums: {grenade: 5}, priorityLevels: {health: 1, super: 2}};
    let bestRank = null;
    const visit = (index, remaining, actual) => {
      if (index === 5) {
        const rank = scoreStatsRank({...actual, weapons: remaining}, goal, constraints);
        if (!bestRank || compareScoreRanks(rank, bestRank) < 0) bestRank = rank;
        return;
      }
      for (let value = 0; value <= remaining; value++) visit(index + 1, remaining - value, {...actual, [STATS[index]]: value});
    };
    visit(0, total, {});
    assert.deepEqual(findBestRelaxedTargets(total, goal, constraints, 1)[0].rank, bestRank);
  }
});

test('actual rule feasibility precedes unmet preferred targets, even high-priority preferences', () => {
  const constraints = {exact: {health: true}, priorityLevels: {melee: 1}};
  const feasible = {...target, melee: 0, grenade: 0};
  const infeasible = {...target, health: 99};
  assert.ok(compareScoreRanks(scoreStatsRank(feasible, target, constraints), scoreStatsRank(infeasible, target, constraints)) < 0);
  assert.ok(compareUpgradeMetrics(metrics(feasible, constraints), metrics(infeasible, constraints)) < 0);
});

test('high-priority rule satisfaction wins over several lower-tier rules in both paths', () => {
  const constraints = {...exact, priorityLevels: {health: 1}};
  const highMet = {...target, melee: 0, grenade: 0, super: 0};
  const highMiss = {...target, health: 99};
  assert.ok(compareScoreRanks(scoreStatsRank(highMet, target, constraints), scoreStatsRank(highMiss, target, constraints)) < 0);
  assert.ok(compareUpgradeMetrics(metrics(highMet, constraints), metrics(highMiss, constraints)) < 0);
});

test('quality ties prefer fewer installed tuning sockets before fewer changed sockets', () => {
  const make = cost => ({metrics: metrics(target, exact), replacementCount: 0, assignmentCost: cost});
  assert.ok(compareUpgradePlans(make({installedTuningCount: 1, changedSocketCount: 5}),
    make({installedTuningCount: 2, changedSocketCount: 0})) < 0);
  assert.ok(compareUpgradePlans(make({installedTuningCount: 1, changedSocketCount: 1}),
    make({installedTuningCount: 1, changedSocketCount: 2})) < 0);
});

test('a returned local closure cannot miss the one-empty-socket exact improvement', () => {
  const config = BASE_CONFIGS.find(c => c.archetype === 'Gunner' && c.tertiary === 'super');
  const pieces = Array.from({length: 5}, (_, i) => normalizeUpgradePiece({archetypeId: config.archetype,
    tertiary: config.tertiary, baseStats: {...config.baseStats}, sourceId: String(i + 1),
    tunedStat: 'melee', tuningMode: 'shift', tuningFrom: 'health', tuningTo: 'melee',
    tuningInstalled: true, armorModSize: 0, locked: true}, i));
  const goal = {health: 5, melee: 45, grenade: 125, super: 100, class: 25, weapons: 150};
  const initial = evaluateUpgradePieces(pieces, goal, {}, false, [], true, exact);
  const limited = refineUpgradeNeighborhood(pieces, goal, {}, [], true, exact, initial, {maxChecks: 1});
  assert.equal(limited.neighborhood.singleComplete, false);
  assert.equal(limited.assignmentOptimal, false);
  const closed = refineUpgradeNeighborhood(pieces, goal, {}, [], true, exact, initial, {maxTimeMs: 1000});
  assert.deepEqual(closed.finalTotals, goal);
  assert.equal(closed.neighborhood.singleComplete, true);
  assert.equal(closed.assignmentCost.installedTuningCount, 4);
  const exactBest = refineUpgradeAssignment(pieces, goal, {}, [], true, exact, closed);
  assert.equal(exactBest.assignmentOptimal, true);
  assert.equal(exactBest.assignmentOptimalScope, 'quality-and-mathematical-socket-cost');
  assert.equal(exactBest.assignmentCost.changedSocketCount, 1);
});

test('normalizing an empty socket preserves its immutable destination without installing a shift', () => {
  const piece = normalizeUpgradePiece({tuningMode: 'none', tunedStat: 'weapons', tuningTo: 'weapons',
    tuningFrom: 'health', tuningInstalled: true}, 0);
  assert.equal(piece.tuningMode, 'none');
  assert.equal(piece.tuningInstalled, false);
  assert.equal(piece.tunedStat, 'weapons');
  assert.equal(piece.tuningFrom, null);
  assert.equal(piece.tuningTo, null);
});

test('directional-only optimization measures changes against real Balanced sockets, not a coerced baseline', () => {
  const config = BASE_CONFIGS[0];
  const pieces = Array.from({length: 5}, (_, i) => normalizeUpgradePiece({archetypeId: config.archetype,
    tertiary: config.tertiary, baseStats: {...config.baseStats}, tuningMode: 'plus3', tuningInstalled: true,
    tunedStat: 'melee', armorModSize: 0, dataConfidence: {stats: 'exact', tuning: 'exact'}}, i));
  const goal = {health: 125, melee: 125, grenade: 125, super: 25, class: 25, weapons: 25};
  const result = refineUpgradeAssignment(pieces, goal, {}, [], true, exact);
  assert.equal(result.assignmentCost.changedSocketCount, 5);
  assert.deepEqual(result.assignmentCost, getAssignmentCost(pieces, result));
  const unknown = pieces.map(piece => ({...piece, dataConfidence: {...piece.dataConfidence, tuning: 'unknown'}}));
  const limited = refineUpgradeAssignment(unknown, goal, {}, [], true, exact);
  assert.equal(limited.assignmentOptimal, false);
  assert.ok(limited.tuningAssignments.every(tuning => tuning.mode === 'none'));
});
