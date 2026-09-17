import assert from 'node:assert/strict';
import test from 'node:test';
import { BASE_CONFIGS, STATS } from '../src/core/armor-model.mjs';
import { createProblemSpec, verifyWitness, createRulesetId } from '../src/core/solver-v3-contract.mjs';
import { calculateReachableRanges, findReachabilityWitness } from '../src/core/reachability.mjs';
import { findExactTargetWitnesses, findFixedTargetWitness, findFixedRuleWitness,
  findBestFixedConfigWitness, findExactPartialConfigWitnesses } from '../src/core/exact-target-oracle.mjs';

const vector = values => Object.fromEntries(STATS.map((stat, index) => [stat, values[index]]));

test('theoretical exact search permits four Balanced pieces and one empty tuning socket', () => {
  const target = vector([150, 100, 125, 29, 29, 29]);
  const results = findExactTargetWitnesses({ target, numPlus5: 0, numPlus10: 0, numPlus3: 4 });
  assert.ok(results.length > 0);
  const simplest = results.find(result => result.config.every(piece => piece === BASE_CONFIGS[0]));
  assert.ok(simplest);
  assert.equal(simplest.tuningAssignments.filter(tuning => tuning.mode === '+3').length, 4);
  assert.equal(simplest.tuningAssignments.filter(tuning => tuning.mode === 'none').length, 1);
});

test('point, interval, optimization and partial search share the empty-only capability domain', () => {
  const configs = Array(5).fill(BASE_CONFIGS[0]);
  const tuningCapabilities = configs.map(() => ({allowBalanced: false, allowedDirectionalStats: []}));
  const target = vector([150, 100, 125, 25, 25, 25]);
  const input = {configs, tuningCapabilities, target, numPlus5: 0, numPlus10: 0, numPlus3: 0};
  const results = [findFixedTargetWitness(input), findFixedRuleWitness({...input,
    minimums: STATS.map(stat => target[stat]), maximums: STATS.map(stat => target[stat])}),
  findBestFixedConfigWitness({...input, rankTotals: totals => STATS.reduce((sum, stat) => sum + Math.abs(totals[stat] - target[stat]), 0),
    compareRanks: (left, right) => left - right}),
  findExactPartialConfigWitnesses({...input, fixedEntries: configs.map(config => ({config,
    allowBalanced: false, allowedDirectionalStats: []})), freePieceCount: 0, allowedFreePlus3Counts: [0]})[0]];
  for (const result of results) {
    assert.ok(result);
    assert.deepEqual(result.totals, target);
    assert.ok(result.tuningAssignments.every(tuning => tuning.mode === 'none'));
  }
});

test('fixed-piece exact search can empty one socket without changing immutable destinations', () => {
  const config = BASE_CONFIGS.find(piece => piece.archetype === 'Gunner' && piece.tertiary === 'super');
  const configs = Array(5).fill(config);
  const tuningCapabilities = configs.map(() => ({allowBalanced: false, allowedDirectionalStats: ['melee']}));
  const input = {configs, tuningCapabilities, target: vector([5, 45, 125, 100, 25, 150]),
    numPlus5: 0, numPlus10: 0, numPlus3: 0};
  const result = findFixedTargetWitness(input);
  assert.ok(result);
  assert.equal(result.tuningAssignments.filter(tuning => tuning.mode === 'none').length, 1);
  assert.ok(result.tuningAssignments.every(tuning => tuning.mode === 'none' || tuning.to === 'melee'));
  assert.equal(findFixedTargetWitness({...input,
    tuningCapabilities: tuningCapabilities.map(capability => ({...capability, allowNone: false}))}), null);
});

test('exact point witnesses minimize installed tuning before picking a stat-mod placement', () => {
  const configs = Array(5).fill(BASE_CONFIGS[0]);
  const target = vector([150, 100, 125, 25, 25, 30]);
  const result = findFixedTargetWitness({configs, target, numPlus5: 1, numPlus10: 0, numPlus3: 0,
    tuningCapabilities: configs.map(() => ({allowBalanced: false, allowedDirectionalStats: STATS}))});
  assert.ok(result);
  assert.ok(result.tuningAssignments.every(tuning => tuning.mode === 'none'));
  assert.deepEqual(result.tuningCost, {directionalCount: 0, installedCount: 0});
});

test('fixed optimization minimizes installed tuning among equal-quality witnesses', () => {
  const result = findBestFixedConfigWitness({configs: Array(5).fill(BASE_CONFIGS[0]),
    numPlus5: 0, numPlus10: 0, numPlus3: 0, rankTotals: () => 0, compareRanks: (left, right) => left - right});
  assert.ok(result.tuningAssignments.every(tuning => tuning.mode === 'none'));
  assert.equal(result.tuningCost.installedCount, 0);
});

test('verification accepts theoretical empty sockets and binds proofs to the optional domain', () => {
  const target = vector([150, 100, 125, 29, 29, 29]);
  const spec = createProblemSpec({target, numPlus3: 4});
  const witness = {config: Array(5).fill(BASE_CONFIGS[0]),
    tuningAssignments: Array.from({length: 5}, (_, i) => ({mode: i < 4 ? '+3' : 'none', from: null, to: null})),
    modAssignments: {}};
  assert.equal(verifyWitness(spec, witness).valid, true);
  assert.match(createRulesetId(spec), /optional-tuning-v1/);
  assert.equal(verifyWitness(createProblemSpec({target, numPlus3: 5}), witness).valid, false);
});

test('range preview and exact probing include the same four-Balanced one-empty point', () => {
  const target = vector([150, 100, 125, 29, 29, 29]);
  const fragments = vector([0, 0, 0, 0, 0, 0]);
  const range = calculateReachableRanges(BASE_CONFIGS[0], 0, 0, 4, fragments, target);
  assert.equal(range.feasible, true);
  const probe = findReachabilityWitness({fixedPiece: BASE_CONFIGS[0], numPlus5: 0, numPlus10: 0,
    numPlus3: 4, fragments, visibleTarget: target});
  assert.equal(probe.status, 'EXACT_TARGET_PROVEN');
  assert.deepEqual(probe.witness.visibleTotals, target);
});

test('fixed optimization retains the least-changed physical tuning assignment inside aggregate states', () => {
  const currentTuningAssignments = Array.from({length: 5}, (_, index) => index === 1
    ? {mode: '+5-5', from: 'health', to: 'melee'} : {mode: 'none', from: null, to: null});
  const target = vector([145, 105, 125, 25, 25, 25]);
  const result = findBestFixedConfigWitness({configs: Array(5).fill(BASE_CONFIGS[0]), target,
    tuningCapabilities: Array.from({length: 5}, (_, index) => ({allowBalanced: false,
      allowedDirectionalStats: index < 2 ? ['melee'] : []})),
    numPlus5: 0, numPlus10: 0, numPlus3: 0, currentTuningAssignments, currentModAssignments: {},
    rankTotals: totals => STATS.reduce((sum, stat) => sum + Math.abs(totals[stat] - target[stat]), 0),
    compareRanks: (left, right) => left - right});
  assert.deepEqual(result.totals, target);
  assert.deepEqual(result.tuningAssignments, currentTuningAssignments);
  assert.equal(result.socketChangeCount, 0);
});

test('empty witnesses survive both visible clamp boundaries and disabled Balanced tuning', () => {
  for (const [visible, fragment] of [[0, -150], [200, 50]]) {
    const target = vector([visible, 100, 125, 29, 29, 29]);
    const probe = findReachabilityWitness({fixedPiece: BASE_CONFIGS[0], numPlus5: 0, numPlus10: 0,
      numPlus3: 4, fragments: {health: fragment}, visibleTarget: target});
    assert.equal(probe.status, 'EXACT_TARGET_PROVEN');
    assert.deepEqual(probe.witness.visibleTotals, target);
    assert.ok(probe.witness.tuningAssignments.some(tuning => tuning.mode === 'none'));
  }
  const config = BASE_CONFIGS[0];
  const slots = ['helmet', 'arms', 'chest', 'legs', 'classItem'];
  const pieces = slots.map((slot, index) => ({...config, slot, sourceId: `optional-${index}`,
    tunedStat: 'melee', allowedTuningStats: ['melee'], dataConfidence: {stats: 'exact', tuning: 'exact'}}));
  const spec = createProblemSpec({operation: 'solveInventory', pieces,
    inventoryContext: {reassignModifiers: true, onlyPlus5Tuning: true},
    target: vector([150, 100, 125, 25, 25, 25])});
  const witness = {pieces, tuningAssignments: pieces.map(() => ({mode: 'none', from: null, to: null})), modAssignments: {}};
  assert.equal(verifyWitness(spec, witness).valid, true);
  assert.equal(verifyWitness(spec, {...witness,
    tuningAssignments: witness.tuningAssignments.map((tuning, index) => index ? tuning : {mode: '+3', from: null, to: null})}).valid, false);
});

test('fixed optimization assigns aggregate stat mods to the least-changed physical slots', () => {
  const target = vector([150, 100, 125, 25, 25, 30]);
  const currentModAssignments = {0: null, 1: null, 2: null, 3: null, 4: {size: 5, stat: 'weapons'}};
  const result = findBestFixedConfigWitness({configs: Array(5).fill(BASE_CONFIGS[0]), target,
    tuningCapabilities: Array.from({length: 5}, () => ({allowBalanced: false, allowedDirectionalStats: []})),
    numPlus5: 1, numPlus10: 0, numPlus3: 0, currentModAssignments,
    rankTotals: totals => STATS.reduce((sum, stat) => sum + Math.abs(totals[stat] - target[stat]), 0),
    compareRanks: (left, right) => left - right});
  assert.deepEqual(result.totals, target);
  assert.deepEqual(result.modAssignments, currentModAssignments);
  assert.equal(result.socketChangeCount, 0);
});

test('mixed-size stat-mod compression does not discard a zero-change placement', () => {
  const target = vector([160, 110, 125, 25, 25, 25]);
  const currentModAssignments = {0: {size: 10, stat: 'melee'}, 1: {size: 5, stat: 'health'},
    2: {size: 5, stat: 'health'}, 3: null, 4: null};
  const result = findBestFixedConfigWitness({configs: Array(5).fill(BASE_CONFIGS[0]), target,
    tuningCapabilities: Array.from({length: 5}, () => ({allowBalanced: false, allowedDirectionalStats: []})),
    numPlus5: 2, numPlus10: 1, numPlus3: 0, currentModAssignments,
    rankTotals: totals => STATS.reduce((sum, stat) => sum + Math.abs(totals[stat] - target[stat]), 0),
    compareRanks: (left, right) => left - right});
  assert.deepEqual(result.modAssignments, currentModAssignments);
  assert.equal(result.socketChangeCount, 0);
});
