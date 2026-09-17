import assert from 'node:assert/strict';
import test from 'node:test';
import {mergeInventoryShardResults, solveInventory} from '../src/core/armor-engine.mjs';
import {BASE_CONFIGS, STATS} from '../src/core/armor-model.mjs';
import {createSearchSession, withSearchProfile} from '../src/core/search-session.mjs';
import {assertSolutionConsistency} from '../src/core/solver-v3-contract.mjs';
import {crowdedDimRequest as request, dimExactFixture as fixture} from './helpers/dim-exact-inventory.mjs';
import {rebuildReference, seeded, SLOTS} from './helpers/reference-witness.mjs';
import {residueCompatibleNoWitness} from './helpers/residue-compatible-inventory.mjs';

test('large quotient with compatible residues exhausts exact existence despite expired ranking budget', t => {
  const payload = {...residueCompatibleNoWitness(), searchLimits: {maxNodes: 1, maxEvaluations: 1, maxTimeMs: 1}};
  assert.ok(payload.items.every(item => STATS.reduce((sum, stat) => sum + item.baseStats[stat], 0) % 10 === 0));
  assert.equal(Object.values(payload.targets).reduce((sum, value) => sum + value, 0) % 10, 5,
    'independent conserved-total invariant proves the optional-tuning fixture impossible');
  let ticks = 0;
  const session = createSearchSession({operation: 'solveInventory', profile: 'balanced', now: () => ticks++ * 200000});
  const result = session.finish(solveInventory(payload, session));
  const stats = result.search.coverage;
  assert.notEqual(result.status, 'EXACT_TARGET_PROVEN');
  assert.equal(stats.exactExistence, 'exhausted');
  assert.equal(stats.exactPrunedResidues, 0);
  assert.ok(stats.exactGroups.reduce((a, b) => a * b, 1) >= 100000);
  assert.equal(stats.exactStates, 1, 'conserved total rejects before quotient expansion');
  assert.equal(stats.exactPrunedTotals, 1);
  assert.equal(result.certificate.proof.complete, false);
  t.diagnostic(JSON.stringify({groups: stats.exactGroups, states: stats.exactStates,
    evaluations: stats.mathEvaluations}));
});

function assertExact(result, payload) {
  assert.equal(result.status, 'EXACT_TARGET_PROVEN');
  const witness = result.results[0];
  assertSolutionConsistency(witness.problemSpec, witness, payload.targets);
  assert.deepEqual(witness.visibleTotals, payload.targets);
  assert.equal(witness.pieces.find(p => p.slot === 'helmet').hash, fixture.fixedExotic.hash);
  assert.equal(witness.pieces.find(p => p.slot === 'classItem').sourceId, 'dim-piece-6');
}

test('DIM exact witness survives the ordinary Balanced duplicate frontier', () => {
  const payload = request();
  payload.items.reverse();
  const result = solveInventory(payload);
  assertExact(result, payload);
  assert.deepEqual(result.searchStats.exactGroups, [2, 1, 1, 1, 1]);
  assert.ok(result.searchStats.exactPrunedResidues > 0);
  assert.ok(result.searchStats.mathEvaluations <= 2, 'negative duplicate tuples must not consume physical evaluations');
});

test('exact existence is independent of Balanced/Deep ranking budgets and inventory order', () => {
  for (const profile of ['balanced', 'deep']) {
    const payload = withSearchProfile('solveInventory', {...request(), searchProfile: profile});
    payload.items.reverse();
    payload.searchLimits = {...payload.searchLimits, maxEvaluations: 1, maxNodes: 1};
    // A deterministic expired clock also exercises the outer worker/session
    // deadline, not just the inner inventory loop's limits.
    let ticks = 0;
    const session = createSearchSession({operation: 'solveInventory', profile, now: () => ticks++ * 200000});
    assertExact(session.finish(solveInventory(payload, session)), payload);
  }
});

test('physical shards retain the exact witness after equivalence compression', () => {
  const payload = request();
  for (const shardCount of [2, 4, 8]) {
    const parts = Array.from({length: shardCount}, (_, shardIndex) => solveInventory({...payload,
      shardIndex, shardCount, searchLimits: {maxEvaluations: 1, maxNodes: 1}}));
    const exact = parts.filter(p => p.status === 'EXACT_TARGET_PROVEN');
    assert.equal(exact.length, 1, 'unique viable class item belongs to exactly one shard');
    assertExact(exact[0], payload);
    assertExact(mergeInventoryShardResults(payload, parts, shardCount), payload);
    assert.ok(parts.every(p => !p.certificate.proof.complete));
  }
});

test('split sets and fixed Exotic identity remain hard constraints', () => {
  const payload = request();
  payload.setRequirement = {type: 'split', a: 101, b: 202};
  payload.items = payload.items.map(p => ({...p, setHash: p.exotic ? null
    : ['arms', 'legs'].includes(p.slot) ? 101 : 202}));
  assertExact(solveInventory(payload), payload);
  const wrongExotic = {...payload, items: payload.items.map(p => p.exotic ? {...p, hash: 12345} : p)};
  assert.notEqual(solveInventory(wrongExotic).status, 'EXACT_TARGET_PROVEN');
  const wrongSet = {...payload, items: payload.items.map(p => p.slot === 'classItem' ? {...p, setHash: 303} : p)};
  assert.notEqual(solveInventory(wrongSet).status, 'EXACT_TARGET_PROVEN');
});

test('exact existence preserves explicit Balanced tuning count, class and unknown capability evidence', () => {
  const payload = request();
  const physical = payload.items.filter(p => fixture.builds[1].includes(p.id));
  const configs = SLOTS.map(slot => {
    const p = physical.find(p => p.slot === slot);
    return {...p, effectiveBaseStats: p.optimizationBaseStats};
  });
  const totals = rebuildReference(configs, configs.map(() => ({mode: '+3'})),
    configs.map(() => ({size: 10, stat: 'weapons'})), payload.fragments).visible;
  payload.targets = totals;
  payload.onlyPlus5Tuning = false;
  payload.modifierBudget = {numPlus5: 0, numPlus10: 5, numPlus3: 5};
  payload.searchLimits = {maxNodes: 1, maxEvaluations: 1};
  const result = solveInventory(payload);
  assertExact(result, payload);
  assert.equal(result.results[0].tuningAssignments.filter(t => t.mode === '+3').length, 5);
  const wrongClass = {...payload, items: payload.items.map(p => p.slot === 'arms' ? {...p, classId: 'titan'} : p)};
  assert.notEqual(solveInventory(wrongClass).status, 'EXACT_TARGET_PROVEN');
  const unknown = {...payload, items: payload.items.map(p => p.slot === 'arms'
    ? {...p, dataConfidence: {...p.dataConfidence, stats: 'unknown'}} : p)};
  const missingEvidence = solveInventory(unknown);
  assert.notEqual(missingEvidence.status, 'EXACT_TARGET_PROVEN');
  assert.notEqual(missingEvidence.status, 'INFEASIBLE_PROVEN');
});

test('96 independently generated exact inventory witnesses survive residue bounds and tiny ranking budgets', () => {
  const random = seeded(0x913fe);
  for (let trial = 0; trial < 96; trial++) {
    const items = SLOTS.map((slot, index) => {
      const config = BASE_CONFIGS[random(BASE_CONFIGS.length)];
      const stats = {...config.baseStats};
      // Include non-catalog residues; exact search must not round the roll.
      stats.super += random(5);
      return {...config, id: `generated-${trial}-${index}`, slot, hash: index + 1, classId: 'hunter',
        exotic: index === 0, archetypeId: config.archetype, baseStats: stats,
        effectiveBaseStats: stats, optimizationBaseStats: stats, masterworkTier: 5,
        tunedStat: STATS[random(6)], tuningMode: 'plus3', armorModSize: 0,
        dataConfidence: {stats: 'exact', tuning: 'exact', sockets: 'unknown'}};
    });
    for (const p of items) p.allowedTuningStats = [p.tunedStat];
    const tuning = items.map(p => trial % 3 && trial % 4 === 0 && random(2) ? {mode: 'none'}
      : trial % 3 && random(2) ? {mode: '+3'} : {
      mode: '+5-5', to: p.tunedStat, from: STATS[(STATS.indexOf(p.tunedStat) + 1 + random(5)) % 6]});
    const mods = items.map(() => ({size: 10, stat: STATS[random(6)]}));
    const fragments = {health: trial % 2 ? -20 : 10};
    const targets = rebuildReference(items, tuning, mods, fragments).visible;
    const payload = {items, targets, fragments, setRequirement: {type: 'none'},
      fixedExotic: {slot: 'helmet', hash: 1, classId: 'hunter'}, reassignModifiers: true,
      onlyPlus5Tuning: trial % 3 === 0, modifierBudget: {numPlus5: 0, numPlus10: 5,
        numPlus3: tuning.filter(t => t.mode === '+3').length}, maxResults: 1,
      userConstraints: {exact: Object.fromEntries(STATS.map(s => [s, true]))},
      searchLimits: {maxNodes: 1, maxEvaluations: 1}};
    const result = solveInventory(payload);
    assert.equal(result.status, 'EXACT_TARGET_PROVEN', `trial ${trial}`);
    const witness = result.results[0];
    assert.deepEqual(rebuildReference(witness.pieces, witness.tuningAssignments, witness.modAssignments, fragments).visible, targets);
    assertSolutionConsistency(witness.problemSpec, witness, targets);
  }
});

test('empty Tuning remains legal with or without the no-Balanced filter, including unknown directional capability', () => {
  const payload = request();
  payload.items = payload.items.filter(p => fixture.builds[1].includes(p.id)).map(p => ({...p,
    tuningMode: 'plus3', tunedStat: null, tuningStat: null, tuningTo: null, tuningFrom: null,
    allowedTuningStats: [], dataConfidence: {...p.dataConfidence, tuning: 'unknown'}}));
  payload.onlyPlus5Tuning = false;
  payload.searchLimits = {maxNodes: 1};
  for (const balancedCount of [0, 2, 5]) {
    payload.modifierBudget = {numPlus5: 0, numPlus10: 5, numPlus3: balancedCount};
    payload.targets = rebuildReference(payload.items.map(p => ({...p, effectiveBaseStats: p.optimizationBaseStats})),
      payload.items.map((_, i) => ({mode: i < balancedCount ? '+3' : 'none'})),
      payload.items.map(() => ({size: 10, stat: 'weapons'})), payload.fragments).visible;
    const result = solveInventory(payload);
    assertExact(result, payload);
    assert.equal(result.results[0].tuningAssignments.filter(t => t.mode === 'none').length, 5 - balancedCount);
    const noBalanced = solveInventory({...payload, onlyPlus5Tuning: true});
    if (balancedCount === 0) assertExact(noBalanced, payload);
    else assert.notEqual(noBalanced.status, 'EXACT_TARGET_PROVEN', 'the filter still forbids every Balanced action');
    if (balancedCount === 0) {
      // Stale installed directions cancel in aggregate but have no capability
      // evidence. They tie the valid empty assignment mathematically; that tie
      // must never make the evaluator throw away the oracle's valid witness.
      const stale = {...payload, items: payload.items.map((p, i) => ({...p,
        armorModSize: 10, armorModStat: 'weapons',
        tuningMode: 'shift', tuningFrom: STATS[i], tuningTo: STATS[(i + 1) % 5],
        tunedStat: STATS[(i + 1) % 5], allowedTuningStats: [STATS[(i + 1) % 5]], tuningInstalled: true}))};
      assertExact(solveInventory(stale), stale);
    }
  }
});
