import test from 'node:test';
import assert from 'node:assert/strict';
import {solveInventory} from '../src/core/armor-engine.mjs';
import {chooseInventorySchedule, EMERGENCY_WORKER_CAP} from '../src/core/worker-scheduler.mjs';
import {createStatPressure, pressureVectors} from '../src/core/stat-pressure.mjs';
import {cases, fixture} from '../scripts/fixtures/search-performance.mjs';
import {getUpgradeConfig} from '../src/core/upgrade-optimizer.mjs';
import {STATS} from '../src/core/armor-model.mjs';

test('pressure preserves exact existence, negative boundary and reversed-input traversal', () => {
  for (const name of cases) {
    const payload = {...fixture(name), searchLimits: {maxNodes: 1, maxEvaluations: 1, maxTimeMs: 200}};
    const baseline = solveInventory({...payload, searchOrdering: 'baseline'});
    const ordered = solveInventory(payload);
    const reversed = solveInventory({...payload, items: [...payload.items].reverse().map(p => Object.fromEntries(Object.entries(p).reverse()))});
    assert.equal(ordered.status, baseline.status, name);
    assert.equal(reversed.status, ordered.status, name);
    assert.equal(reversed.searchStats.exactStates, ordered.searchStats.exactStates, name);
    assert.deepEqual(reversed.results.map(r => r.canonicalId), ordered.results.map(r => r.canonicalId), name);
    assert.equal(ordered.certificate.proof.complete, false, name);
    assert.ok(ordered.results.every(r => r.certificate.witnessVerification.valid), name);
    if (name.endsWith('200') || name === 'dual-180') assert.ok(ordered.searchStats.exactStates < baseline.searchStats.exactStates, name);
  }
});

test('coupled pressure vectors preserve destination, Balanced and empty legality, with no armor mods', () => {
  const piece = fixture('small').items[0];
  const base = STATS.map(s => getUpgradeConfig(piece).baseStats[s]);
  const vectors = pressureVectors(piece, true);
  assert.equal(vectors.length, 5);
  for (const v of vectors) {
    const diff = v.map((x, i) => x - base[i]);
    assert.equal(diff[STATS.indexOf(piece.tunedStat)], 5);
    assert.equal(diff.reduce((a, b) => a + b), 0);
    assert.equal(diff.filter(x => x === -5).length, 1);
  }
  assert.ok(pressureVectors({...piece, armorModSize: 10}, false).some(v => v.every((x, i) => x === base[i])));
  assert.equal(pressureVectors(piece, false, 5).length, 1);
  assert.equal(pressureVectors(piece, false, 0).length, 6);
});

test('pressure returns a permutation even with conflicting extrema and unknown capability', () => {
  const groups = fixture('small').items.map((piece, i) => [{piece, identity: String(i), existenceKey: String(i)}]);
  const rules = STATS.map((_, i) => ({armorMinimum: i ? null : 200, armorMaximum: i ? 0 : null}));
  const suffix = Array.from({length: 6}, () => ({min: Array(6).fill(25), max: Array(6).fill(150)}));
  const order = createStatPressure(rules, 50, false, suffix);
  const sorted = order(groups, 0, Array(6).fill(0), Array(6).fill(0));
  assert.equal(sorted.length, groups.length);
  assert.equal(new Set(sorted).size, groups.length);
  assert.ok(groups.every(group => sorted.includes(group)));
});

test('scheduler scales with hardware and task, leaves CPU and memory headroom', () => {
  const small = fixture('small');
  for (const cores of [1, 2, 4, 16, 32, 64]) {
    assert.equal(chooseInventorySchedule(small, {hardwareConcurrency: cores, workersAvailable: true}).workerCount, 1);
  }
  const large = fixture('large');
  large.items = large.items.map((p, i) => ({...p, setHash: i}));
  large.searchProfile = 'deep';
  const low = chooseInventorySchedule(large, {hardwareConcurrency: 2, deviceMemory: 2, workersAvailable: true});
  const high = chooseInventorySchedule(large, {hardwareConcurrency: 32, deviceMemory: 32, workersAvailable: true});
  assert.equal(low.workerCount, 1);
  assert.ok(high.workerCount > 8);
  assert.ok(high.workerCount < 32);
  assert.ok(chooseInventorySchedule(large, {hardwareConcurrency: 32, deviceMemory: 1, workersAvailable: true}).workerCount < high.workerCount);
  assert.equal(chooseInventorySchedule(large, {workersAvailable: false}).workerCount, 0);
  assert.ok(chooseInventorySchedule(large, {hardwareConcurrency: 1e12}).requestedWorkers <= EMERGENCY_WORKER_CAP);
  assert.ok(chooseInventorySchedule({...large, searchProfile: 'fast'}, {hardwareConcurrency: 32, workersAvailable: true}).workerCount < high.workerCount);
});
