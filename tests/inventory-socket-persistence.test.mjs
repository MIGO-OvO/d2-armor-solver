import assert from 'node:assert/strict';
import test from 'node:test';
import {Worker} from 'node:worker_threads';
import {createBuildRepository, STORAGE_KEYS} from '../src/core/build-repository.mjs';
import {fixture} from '../scripts/fixtures/search-performance.mjs';
import {STAT_MOD_HASH_SET, TUNING_HASH_SET} from '../src/core/armor-sockets.mjs';

function socketRequest() {
  const request = fixture('small');
  request.items = request.items.map(item => ({...item, energy: {capacity: 10, used: 0},
    sockets: [
      {socketIndex: 0, role: 'stat', candidateState: 'known', currentPlugHash: 0, candidatePlugHashes: new Set(STAT_MOD_HASH_SET)},
      {socketIndex: 1, role: 'tuning', candidateState: 'known', currentPlugHash: 0, candidatePlugHashes: new Set(TUNING_HASH_SET)},
    ], dataConfidence: {...item.dataConfidence, sockets: 'exact'}}));
  return request;
}

function repository() {
  const values = new Map();
  const storage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
  return {storage, repo: createBuildRepository(storage)};
}

function workerSolver(t) {
  const worker = new Worker(new URL('./helpers/armor-worker-host.mjs', import.meta.url));
  t.after(() => worker.terminate());
  let sequence = 0;
  return payload => new Promise((resolve, reject) => {
    const id = ++sequence;
    const listener = data => {
      if (data.id !== id || !['result', 'error'].includes(data.type)) return;
      worker.off('message', listener);
      if (data.error) reject(Object.assign(new Error(data.error.message), {name: data.error.name, stack: data.error.stack}));
      else resolve(data.result);
    };
    worker.on('message', listener);
    worker.postMessage({id, generation: id, type: 'start', operation: 'solveInventory', payload});
  });
}

test('a cold-start persisted Bungie inventory solves in a real Worker before any live refresh', async t => {
  const request = socketRequest();
  const {repo} = repository();
  repo.writeUpgradeDraft({inventory: request.items});
  const saved = repo.readUpgradeDraft().inventory;
  assert.deepEqual(saved[0].sockets[0].candidatePlugHashes, [...STAT_MOD_HASH_SET]);
  assert.equal(saved[0].sockets[0].candidateState, 'known');
  const solve = workerSolver(t);
  const cold = await solve({...request, items: saved});
  const refreshed = await solve(request);
  assert.ok(cold.results.length > 0);
  assert.deepEqual(cold.results.map(row => row.canonicalId), refreshed.results.map(row => row.canonicalId));
});

test('old JSON drafts with lost Set contents also solve on their first Worker run', async t => {
  const request = socketRequest();
  const {storage, repo} = repository();
  // This is exactly what pre-fix JSON.stringify wrote for each candidate Set.
  storage.setItem(STORAGE_KEYS.upgradeDraft, JSON.stringify({inventory: request.items}));
  const result = await workerSolver(t)({...request, items: repo.readUpgradeDraft().inventory});
  assert.ok(result.results.length > 0);
});

test('live structured-cloned socket Sets already solve without persistence', async t => {
  const result = await workerSolver(t)(structuredClone(socketRequest()));
  assert.ok(result.results.length > 0);
});

test('JSON-safe socket candidate arrays solve like live Sets', async t => {
  const request = socketRequest();
  const portable = JSON.parse(JSON.stringify(request, (key, value) =>
    key === 'candidatePlugHashes' && value instanceof Set ? [...value] : value));
  const solve = workerSolver(t);
  const result = await solve(portable);
  const live = await solve(request);
  assert.deepEqual(result.results.map(row => row.canonicalId), live.results.map(row => row.canonicalId));
});
