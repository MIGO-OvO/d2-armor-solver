import assert from 'node:assert/strict';
import test from 'node:test';
import { BASE_CONFIGS, STATS } from '../src/core/armor-model.mjs';
import { calculateReachableRanges, calculateReachableStatRange } from '../src/core/reachability.mjs';

test('range preview shares one lock-state traversal across independent unlocked-stat projections', () => {
  const fixed = BASE_CONFIGS[0];
  const locks = {health: 150, melee: 100};
  const expected = {};
  let separateStates = 0;
  for (const stat of STATS.filter(stat => !(stat in locks))) {
    const stats = {statesExamined: 0};
    expected[stat] = calculateReachableStatRange(fixed, 0, 0, 5, {}, locks, stat, stats);
    separateStates += stats.statesExamined;
  }
  const actual = calculateReachableRanges(fixed, 0, 0, 5, {}, locks);
  assert.equal(actual.feasible, true);
  for (const [stat, range] of Object.entries(expected)) assert.deepEqual(actual.ranges[stat], range);
  assert.ok(actual.searchStats.statesExamined < separateStates / 2,
    `one shared traversal (${actual.searchStats.statesExamined}) versus repeated traversals (${separateStates})`);
});

test('clamped interval previews also share projections without inventing joint witnesses', () => {
  for (const [visible, fragment] of [[0, -200], [200, 175]]) {
    const fragments = {health: fragment};
    const locks = {health: visible};
    const expected = {};
    let separateStates = 0;
    for (const stat of STATS.slice(1)) {
      const stats = {statesExamined: 0};
      expected[stat] = calculateReachableStatRange(BASE_CONFIGS[0], 0, 0, 5, fragments, locks, stat, stats);
      separateStates += stats.statesExamined;
    }
    const actual = calculateReachableRanges(BASE_CONFIGS[0], 0, 0, 5, fragments, locks);
    assert.equal(actual.feasible, true);
    assert.equal(actual.witness, undefined);
    for (const [stat, range] of Object.entries(expected)) assert.deepEqual(actual.ranges[stat], range);
    assert.ok(actual.searchStats.statesExamined < separateStates / 2);
  }
});
