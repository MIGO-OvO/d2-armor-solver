import assert from 'node:assert/strict';
import test from 'node:test';
import {Worker} from 'node:worker_threads';
import {solveInventory} from '../src/core/armor-engine.mjs';
import {fixture} from '../scripts/fixtures/search-performance.mjs';

test('real worker reuses a registered vault and rejects stale/missing registrations', async t => {
  const worker = new Worker(new URL('./helpers/armor-worker-host.mjs', import.meta.url));
  t.after(() => worker.terminate());
  let sequence = 0;
  const ask = payload => new Promise((resolve, reject) => {
    const id = ++sequence;
    const listener = data => {
      if (data.id !== id || data.type === 'started') return;
      worker.off('message', listener);
      if (data.error) reject(Object.assign(new Error(data.error.message), {name: data.error.name}));
      else resolve(data.result);
    };
    worker.on('message', listener);
    worker.postMessage({id, generation: id, type: 'start', operation: 'mergeInventoryShardResults', payload});
  });
  const request = fixture('small');
  const parts = [solveInventory(request)];
  const first = await ask({requestId: 41, request, parts, count: 1});
  const next = await ask({requestId: 41, parts, count: 1});
  assert.equal(next.results[0]?.canonicalId, first.results[0]?.canonicalId);
  assert.equal(next.results[0]?.certificate.witnessVerification.valid, true);
  await assert.rejects(ask({requestId: 42, parts, count: 1}), {name: 'MissingPreparedInventoryError'});
  await ask({requestId: 42, request, parts, count: 1});
  await assert.rejects(ask({requestId: 41, parts, count: 1}), {name: 'MissingPreparedInventoryError'});
});
