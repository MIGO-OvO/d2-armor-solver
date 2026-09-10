import assert from 'node:assert/strict';
import test from 'node:test';
import {BASE_CONFIGS, STATS} from '../src/core/armor-model.mjs';
import {createResidualBounds} from '../src/core/residual-bounds.mjs';
import {findExactTargetWitnesses, findExactPartialConfigWitnesses, findFixedTargetWitness, findFixedRuleWitness, findBestFixedConfigWitness, visibleArmorTargets} from '../src/core/exact-target-oracle.mjs';
import {createDefaultUpgradePiece, getUpgradeConfig, getUpgradeMathKey, refineUpgradeAssignment,
  getUpgradeMetrics, compareUpgradeMetrics, evaluateUpgradePieces} from '../src/core/upgrade-optimizer.mjs';
import {scoreStatsRank, scoreStatsLowerBound, compareScoreRanks} from '../src/core/solver.mjs';
import {solveInventory, analyzeUpgrade} from '../src/core/armor-engine.mjs';
import {createSearchSession} from '../src/core/search-session.mjs';
import {seeded, rebuildReference, ZERO} from './helpers/reference-witness.mjs';

test('mixed exact residue prefilter preserves generated witnesses and bounds pair visits', () => {
  for (const n3 of [2, 3]) {
    const config = BASE_CONFIGS.slice(0, 5);
    const tuning = config.map((_, i) => i < n3 ? {mode: '+3'} : {mode: '+5-5', from: 'health', to: 'melee'});
    const target = rebuildReference(config, tuning, {}).armor;
    const stats = {};
    const results = findExactTargetWitnesses({target, numPlus3: n3, numPlus5: 0, numPlus10: 0, searchStats: stats});
    assert.ok(results.length);
    assert.ok(stats.statesExamined <= (n3 === 2 ? 60 * 19600 : 250 * 1176) + 1);
    for (const result of results) assert.deepEqual(rebuildReference(result.config, result.tuningAssignments, result.modAssignments).armor, target);
  }
});

test('signed joint bounds preserve 160 generated legal assignments at every prefix', () => {
  const random = seeded(0x31b0);
  for (let trial = 0; trial < 160; trial++) {
    const pieces = Array.from({length: 5}, (_, i) => {
      const config = BASE_CONFIGS[random(48)];
      const to = STATS[random(6)];
      return {...createDefaultUpgradePiece(i), archetypeId: config.archetype, tertiary: config.tertiary,
        baseStats: {...config.baseStats}, tuningMode: trial % 2 ? 'plus3' : 'shift', tunedStat: to,
        tuningTo: to, tuningFrom: STATS[(STATS.indexOf(to) + 1) % 6], armorModSize: [0, 5, 10][random(3)]};
    });
    const tuning = pieces.map(piece => trial % 2 ? {mode: '+3'} : {mode: '+5-5', from: piece.tuningFrom, to: piece.tuningTo});
    const mods = pieces.map(piece => ({size: piece.armorModSize, stat: STATS[random(6)]}));
    const target = rebuildReference(pieces, tuning, mods).armor;
    const rules = STATS.map(stat => ({armorMinimum: random(3) ? target[stat] - random(10) : null,
      armorMaximum: random(3) ? target[stat] + random(10) : null}));
    const rows = pieces.map(piece => ({candidates: [{piece}]}));
    const bound = createResidualBounds(rows, rules, true, false);
    assert.ok(bound.canReach(0));
    rows.forEach((row, index) => { bound.add(row.candidates[0], 1); assert.ok(bound.canReach(index + 1), `trial=${trial} depth=${index}`); });
  }
});

test('joint bound rejects simultaneous deficits which cannot reuse the mod budget', () => {
  const rows = Array.from({length: 5}, (_, i) => ({candidates: [{piece: {...createDefaultUpgradePiece(i),
    baseStats: Object.fromEntries(STATS.map(stat => [stat, 10])), tunedStat: 'health', tuningTo: 'health',
    tuningFrom: 'weapons', armorModSize: i === 0 ? 10 : 0}}]}));
  const rules = STATS.map(stat => ({armorMinimum: stat === 'health' ? 85 : stat === 'melee' ? 60 : null, armorMaximum: null}));
  assert.equal(createResidualBounds(rows, rules, true, true).canReach(0), false);
});

test('math keys share execution variants but retain modifier budgets and actual bases', () => {
  const pieces = Array.from({length: 5}, (_, i) => createDefaultUpgradePiece(i));
  const changed = structuredClone(pieces);
  changed[0].sourceId = 'another-physical-instance'; changed[0].owner = 'another-owner';
  changed[0].sockets = [{index: 9}]; changed[0].energy = {capacity: 2};
  assert.equal(getUpgradeMathKey(pieces), getUpgradeMathKey(changed));
  changed[0].armorModSize = 5;
  assert.notEqual(getUpgradeMathKey(pieces), getUpgradeMathKey(changed));
});

test('Inventory shares math while preserving physical execution alternatives', () => {
  const slots = ['helmet', 'arms', 'chest', 'legs', 'classItem'];
  const pieces = slots.map((slot, index) => ({...BASE_CONFIGS[index], id: `${slot}-a`, slot,
    effectiveBaseStats: {...BASE_CONFIGS[index].baseStats}, optimizationBaseStats: {...BASE_CONFIGS[index].baseStats},
    archetypeId: BASE_CONFIGS[index].archetype, tuningMode: 'plus3', tunedStat: 'health', tuningTo: 'health', tuningFrom: 'melee',
    armorModSize: 0, masterworkTier: 5, allowedTuningStats: ['health'], owner: 'a',
    dataConfidence: {stats: 'exact', tuning: 'exact', sockets: 'unknown'}}));
const target = rebuildReference(pieces, pieces.map(() => ({mode: '+3'})), {}).visible;
  const items = pieces.flatMap(piece => [piece, {...piece, id: piece.id.replace('-a', '-b')}]);
  const result = solveInventory({items, targets: target, fragments: ZERO, reassignModifiers: true,
    setRequirement: {type: 'none'}, maxResults: 32, userConstraints: {exact: Object.fromEntries(STATS.map(stat => [stat, true]))}});
  assert.ok(result.searchStats.mathCacheHits > 0);
  assert.equal(result.searchStats.mathEvaluations, 1);
  assert.equal(result.results.length, 32);
  for (const entry of result.results) {
    assert.equal(entry.verified, true);
    assert.deepEqual(entry.finalTotals, target);
    assert.equal(new Set(entry.pieces.map(piece => piece.sourceId)).size, 5);
  }
  assert.equal(result.proof.complete, false);
});

test('partial interval oracle agrees with an independent finite assignment/config enumeration', () => {
  const fixed = BASE_CONFIGS.slice(0, 4);
  const fixedEntries = fixed.map(config => ({config, allowBalanced: true, allowedDirectionalStats: []}));
  const alternatives = BASE_CONFIGS.flatMap(config => STATS.map(stat => {
    const configs = [...fixed, config];
    return rebuildReference(configs, configs.map(() => ({mode: '+3'})), {0: {size: 5, stat}}).armor;
  }));
  for (let trial = 0; trial < 24; trial++) {
    const target = alternatives[trial * 11];
    const minimums = STATS.map((stat, i) => i < 2 ? null : target[stat] - 2);
    const maximums = STATS.map((stat, i) => i < 2 ? target[stat] + 8 : target[stat] + 2);
    if (trial % 4 === 0) minimums[5] = 1000;
    const fits = totals => STATS.every((stat, i) => (minimums[i] === null || totals[stat] >= minimums[i])
      && (maximums[i] === null || totals[stat] <= maximums[i]));
    const result = findExactPartialConfigWitnesses({fixedEntries, freePieceCount: 1, minimums, maximums,
      numPlus5: 1, numPlus10: 0, allowedFreePlus3Counts: [1], maxWitnesses: 1});
    assert.equal(Boolean(result.length), alternatives.some(fits), `trial=${trial}`);
    if (result.length) {
      const rebuilt = rebuildReference(result[0].config, result[0].tuningAssignments, result[0].modAssignments).armor;
      assert.deepEqual(rebuilt, result[0].totals); assert.ok(fits(rebuilt));
    }
  }
});

test('fixed-five refinement matches exhaustive assignments under the production comparator', () => {
  const pieces = Array.from({length: 5}, (_, i) => ({...createDefaultUpgradePiece(i), exotic: true,
    allowedTuningStats: i < 2 ? ['health'] : [], armorModSize: i === 0 ? 5 : 0, tuningMode: 'plus3'}));
  const configs = pieces.map(getUpgradeConfig);
  const target = {health: 80, melee: 80, grenade: 80, super: 80, class: 80, weapons: 80};
  const constraints = {priorityLevels: {health: 1}};
  let expected = null;
  const actions = [{mode: '+3'}, ...STATS.filter(stat => stat !== 'health').map(from => ({mode: '+5-5', from, to: 'health'}))];
  for (const a of actions) for (const b of actions) for (const stat of STATS) {
    const totals = rebuildReference(configs, [a, b, {mode: '+3'}, {mode: '+3'}, {mode: '+3'}], {0: {size: 5, stat}}).visible;
    const metrics = getUpgradeMetrics(totals, target, 0, [], scoreStatsRank(totals, target, constraints), constraints, ZERO);
    if (!expected || compareUpgradeMetrics(metrics, expected) < 0) expected = metrics;
  }
  const refined = refineUpgradeAssignment(pieces, target, ZERO, [], false, constraints);
  assert.equal(compareUpgradeMetrics(refined.metrics, expected), 0);
  assert.equal(refined.assignmentOptimal, true);
  assert.deepEqual(rebuildReference(configs, refined.tuningAssignments, refined.modAssignments).visible, refined.finalTotals);
});

test('point, interval and refinement Oracles respect an explicit Balanced count', () => {
  const configs = BASE_CONFIGS.slice(0, 5);
  const tuningCapabilities = configs.map(() => ({allowBalanced: true, allowedDirectionalStats: ['health']}));
  const target = rebuildReference(configs, configs.map(() => ({mode: '+3'})), {}).armor;
  const common = {configs, numPlus5: 0, numPlus10: 0, tuningCapabilities};
  assert.ok(findFixedTargetWitness({...common, target, numPlus3: 5}));
  assert.equal(findFixedTargetWitness({...common, target, numPlus3: 0}), null);
  const minimums = STATS.map(stat => target[stat]);
  const maximums = [...minimums];
  assert.ok(findFixedRuleWitness({...common, minimums, maximums, numPlus3: 5}));
  assert.equal(findFixedRuleWitness({...common, minimums, maximums, numPlus3: 0}), null);
  const best = findBestFixedConfigWitness({...common, requiredNumPlus3: 0,
    rankTotals: totals => STATS.reduce((sum, stat) => sum + Math.abs(totals[stat] - target[stat]), 0),
    compareRanks: (a, b) => a - b});
  assert.ok(best.tuningAssignments.every(tuning => tuning.mode !== '+3'));
});

test('joint pair score bound is admissible for every vector including caps and priorities', () => {
  const vectors = [[-1, 1, 0, 0, 0, 0], [0, 0, -1, 1, 0, 0], [0, 0, 0, 0, -1, 1]];
  const sets = STATS.map((_, i) => [...new Set(vectors.map(vector => vector[i]))]);
  const pairs = [0, 2, 4].map(i => vectors.map(vector => vector.slice(i, i + 2)));
  const base = [50, 50, 50, 50, 50, 50];
  const target = Object.fromEntries(STATS.map(stat => [stat, 53]));
  const constraints = {maximums: {health: 50}, exact: {melee: true}, priorityLevels: {class: 1}};
  const lower = scoreStatsLowerBound(base, sets, target, constraints, pairs);
  for (const vector of vectors) {
    const totals = Object.fromEntries(STATS.map((stat, i) => [stat, base[i] + vector[i] * 5]));
    assert.ok(compareScoreRanks(lower, scoreStatsRank(totals, target, constraints)) <= 0);
  }
});

test('fixed Oracle loops honor cancellation before producing a result or cache entry', () => {
  const stop = new Error('test cancellation');
  const configs = BASE_CONFIGS.slice(0, 5);
  const tuningCapabilities = configs.map(() => ({allowBalanced: true, allowedDirectionalStats: ['health']}));
  const checkpoint = () => { throw stop; };
  assert.throws(() => findFixedRuleWitness({configs, tuningCapabilities, numPlus5: 1, numPlus10: 0,
    minimums: [80, null, null, null, null, null], maximums: Array(6).fill(null), checkpoint}), error => error === stop);
  assert.throws(() => findBestFixedConfigWitness({configs, tuningCapabilities, numPlus5: 1, numPlus10: 0,
    rankTotals: () => [0], compareRanks: compareScoreRanks, checkpoint}), error => error === stop);
});

test('multiple visible clamps find a witness beyond the old 128-point preimage domain', () => {
  const config = BASE_CONFIGS[0];
  const pieces = Array.from({length: 5}, (_, i) => ({...createDefaultUpgradePiece(i), archetypeId: config.archetype,
    tertiary: config.tertiary, baseStats: {...config.baseStats}, tuningMode: 'plus3', armorModSize: 0}));
  const fragments = {...ZERO, health: -200, melee: -200};
  const target = rebuildReference(pieces, pieces.map(() => ({mode: '+3'})), {}, fragments).visible;
  assert.equal(visibleArmorTargets(target, fragments, 465, 128).complete, false);
  const exact = Object.fromEntries(STATS.map(stat => [stat, true]));
  const result = evaluateUpgradePieces(pieces, target, fragments, true, [], false, {exact});
  assert.deepEqual(result.finalTotals, target);
  assert.deepEqual(rebuildReference(pieces, result.tuningAssignments, result.modAssignments, fragments).visible, target);
});

test('Upgrade publishes a verified baseline before cold reassignment exhausts the budget', () => {
  let elapsed = 0;
  const session = createSearchSession({operation: 'analyzeUpgrade', generation: 1, now: () => elapsed,
    onProgress: event => { if (event.result?.baseline) elapsed = 4000; }});
  const result = session.finish(analyzeUpgrade({pieces: Array.from({length: 5}, (_, i) => createDefaultUpgradePiece(i)),
    targets: Object.fromEntries(STATS.map(stat => [stat, 100])), fragments: ZERO, reassignModifiers: true}, session));
  assert.ok(result.baseline);
  assert.equal(result.certificate.witnessVerification.valid, true);
  assert.equal(result.search.termination, 'budget');
});
