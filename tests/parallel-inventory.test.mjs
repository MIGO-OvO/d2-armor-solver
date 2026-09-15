import assert from "node:assert/strict";
import test from "node:test";
import {BASE_CONFIGS, STATS} from "../src/core/armor-model.mjs";
import {solveInventory} from "../src/core/armor-engine.mjs";
import {Worker as NodeWorker} from "node:worker_threads";
import {crowdedDimRequest} from './helpers/dim-exact-inventory.mjs';
import {fixture as performanceFixture} from '../scripts/fixtures/search-performance.mjs';

const slots = ["helmet", "arms", "chest", "legs", "classItem"];
function request(count = 2) {
  const items = slots.flatMap((slot, index) => Array.from({length: count}, (_, n) => {
    const config = BASE_CONFIGS[(index * 7 + n * 3) % BASE_CONFIGS.length];
    return {...config, id: `${index}-${n}`, slot, hash: 100 + index,
      archetypeId: config.archetype, effectiveBaseStats: {...config.baseStats}, optimizationBaseStats: {...config.baseStats},
      tunedStat: STATS[index], allowedTuningStats: [STATS[index]], tuningMode: "shift",
      tuningTo: STATS[index], tuningFrom: STATS[(index + 1) % 6], armorModSize: 0,
      exotic: false, setHash: 700, masterworkTier: 5,
      dataConfidence: {stats: "exact", tuning: "exact", sockets: "unknown"}};
  }));
  return {items, targets: Object.fromEntries(STATS.map(stat => [stat, 60])),
    setRequirement: {type: "none"}, reassignModifiers: false, maxResults: 8, searchProfile: "deep"};
}

class ControlledWorker {
  static instances = [];
  constructor() { this.events = {}; this.requests = []; ControlledWorker.instances.push(this); }
  addEventListener(name, callback) { this.events[name] = callback; }
  postMessage(data) { this.requests.push(data); }
  terminate() { this.terminated = true; }
  reply(request, result) { this.events.message({data: {id: request.id, generation: request.generation, type: "result", result}}); }
}

async function clientFor(t) {
  const original = globalThis.Worker;
  ControlledWorker.instances = [];
  globalThis.Worker = ControlledWorker;
  const client = await import(`../src/core/armor-engine-client.mjs?parallel=${Math.random()}`);
  t.after(() => { client.cancelAllSearches(); globalThis.Worker = original; });
  return client;
}

test('Balanced automatic large-vault dispatch has exactly the serial aggregate effort', async t => {
  const client = await clientFor(t);
  const payload = {...performanceFixture('large'), searchProfile: 'balanced', userConstraints: {}};
  const pending = client.solveInventoryParallelAsync(payload);
  assert.equal(ControlledWorker.instances.length, 1);
  const worker = ControlledWorker.instances[0], message = worker.requests[0];
  assert.equal(message.payload.shardCount, 1);
  const result = solveInventory(message.payload);
  worker.reply(message, {...result, search: {nodes: result.searchStats.statesExamined}});
  const actual = await pending;
  assert.equal(actual.search.aggregateNodes, result.searchStats.statesExamined);
  assert.equal(actual.search.progressiveMergeMs + actual.search.finalMergeMs, 0);
});

test('progressive merge retains its original exception and terminates siblings', async t => {
  const client = await clientFor(t);
  const original = new Error('sentinel merge failure');
  const pending = client.solveInventoryParallelAsync(request(), {parallelism: 2, onProgress() {}});
  const rejected = assert.rejects(pending, error => error === original);
  const worker = ControlledWorker.instances[0], message = worker.requests[0];
  const partial = solveInventory(message.payload);
  // Fault injection at the real merge iteration, after scheduling/admission.
  partial.results[Symbol.iterator] = () => { throw original; };
  worker.events.message({data: {...message, type: 'progress', result: partial, search: {nodes: 4}}});
  await rejected;
  assert.equal(original.solverFailure, 'merge');
  assert.ok(ControlledWorker.instances.every(w => w.terminated));
});

test('same-turn final replies cannot swallow a progressive merge error', async t => {
  const client = await clientFor(t);
  const original = new Error('merge and final response race');
  const pending = client.solveInventoryParallelAsync(request(), {parallelism: 2, onProgress() { throw original; }});
  const rejected = assert.rejects(pending, error => error === original);
  for (const worker of ControlledWorker.instances) {
    const message = worker.requests[0];
    worker.reply(message, solveInventory(message.payload));
  }
  await rejected;
});

test('repeated positives do not trigger whole-vault progressive remerges; final witnesses remain verified', async t => {
  const client = await clientFor(t);
  const events = [];
  const pending = client.solveInventoryParallelAsync(request(), {parallelism: 2,
    onProgress: result => { if (result?.results?.length) events.push(result); }});
  const [worker, sibling] = ControlledWorker.instances, message = worker.requests[0];
  const partial = solveInventory(message.payload);
  const publish = () => worker.events.message({data: {...message, type: 'progress', result: partial, search: {nodes: 4}}});
  publish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, 1);
  // Flush any coalescing timer, so throttling alone cannot pass this test.
  t.mock.timers.enable({apis: ['setTimeout']});
  t.mock.timers.tick(2000);
  for (let i = 0; i < 20; i++) publish();
  t.mock.timers.tick(2000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, 1);
  t.mock.timers.reset(); // Final cleanup must clear the real startup timers.
  worker.reply(message, partial);
  sibling.reply(sibling.requests[0], solveInventory(sibling.requests[0].payload));
  const result = await pending;
  assert.ok(result.results.every(row => row.certificate.witnessVerification.valid));
  assert.equal(result.certificate.proof.complete, false);
  assert.ok(result.search.finalMergeMs > 0);
});

test('final merge errors retain the exception and merge classification', async t => {
  const client = await clientFor(t);
  const original = new Error('final merge failed');
  const pending = client.solveInventoryParallelAsync(request(), {parallelism: 2});
  const rejected = assert.rejects(pending, error => error === original && error.solverFailure === 'merge');
  for (const worker of ControlledWorker.instances) {
    const message = worker.requests[0];
    const result = solveInventory(message.payload);
    result.results[Symbol.iterator] = () => { throw original; };
    worker.reply(message, result);
  }
  await rejected;
});

test('ordinary theory and inventory retry transport on a replacement worker, not logic errors', async t => {
  const client = await clientFor(t);
  for (const operation of ['solveLoadoutAsync', 'solveInventoryAsync']) {
    const pending = client[operation]({});
    ControlledWorker.instances.at(-1).events.error({error: new Error('transport killed')});
    const dead = ControlledWorker.instances.at(-1);
    await new Promise(resolve => setImmediate(resolve));
    const retry = ControlledWorker.instances.at(-1);
    dead.events.error({error: new Error('late event from terminated worker')});
    retry.reply(retry.requests[0], {results: [], search: {}});
    assert.equal((await pending).search.fallback, 'replacement-worker');
    const failed = client[operation]({});
    const rejected = assert.rejects(failed, {name: 'TypeError', message: 'solver logic'});
    const worker = ControlledWorker.instances.at(-1), message = worker.requests.at(-1);
    const count = ControlledWorker.instances.length;
    worker.events.message({data: {...message, type: 'result', error: {name: 'TypeError', message: 'solver logic'}}});
    await rejected;
    assert.equal(ControlledWorker.instances.length, count);
  }
});

test('worker-reported logic exceptions cannot impersonate a transport failure by name', async t => {
  const client = await clientFor(t);
  for (const operation of ['solveLoadoutAsync', 'solveInventoryAsync', 'solveInventoryParallelAsync']) {
    const pending = client[operation]({...request(), searchProfile: 'balanced'});
    const rejected = assert.rejects(pending, error => error.name === 'WorkerTransportError'
      && error.solverFailure === 'solver' && error.stack === 'original worker stack');
    const worker = ControlledWorker.instances.at(-1), message = worker.requests.at(-1);
    const count = ControlledWorker.instances.length;
    worker.events.message({data: {...message, type: 'result', error: {
      name: 'WorkerTransportError', message: 'logic failure', stack: 'original worker stack',
    }}});
    await rejected;
    assert.equal(ControlledWorker.instances.length, count);
  }
});

test('theory repeated transport failure falls back inline; cancellation and supersession never retry', async t => {
  const client = await clientFor(t);
  const payload = {target: Object.fromEntries(STATS.map(s => [s, 60])), searchProfile: 'fast', numPlus5: 0, numPlus10: 5, numPlus3: 0};
  const pending = client.solveLoadoutAsync(payload);
  for (let i = 0; i < 2; i++) {
    ControlledWorker.instances.at(-1).events.messageerror({message: 'killed'});
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal((await pending).search.fallback, 'inline');
  for (const operation of ['solveLoadoutAsync', 'solveInventoryAsync']) {
    const controller = new AbortController();
    const task = client[operation](payload, {signal: controller.signal});
    const rejected = assert.rejects(task, {name: 'AbortError'});
    const count = ControlledWorker.instances.length;
    controller.abort(); await rejected;
    assert.equal(ControlledWorker.instances.length, count);
    const failed = client[operation](payload);
    const cancelled = assert.rejects(failed, {name: 'AbortError'});
    ControlledWorker.instances.at(-1).events.error({message: 'killed'});
    client.cancelAllSearches();
    await cancelled;
  }
});

test('inline inventory recovery waits for theory handoff and remains cancellable before execution', async t => {
  const client = await clientFor(t);
  globalThis.Worker = undefined;
  let release, entered = false, settled = false;
  const gate = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const pending = client.solveInventoryParallelAsync(request(), {signal: controller.signal,
    beforeInline: () => { entered = true; return gate; }});
  const rejected = assert.rejects(pending, {name: 'AbortError'}).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, true);
  assert.equal(settled, false);
  controller.abort(); await rejected;
  release();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ControlledWorker.instances.length, 0);
});

test('already aborted calls allocate no workers and perform no fallback', async t => {
  const client = await clientFor(t);
  const controller = new AbortController(); controller.abort();
  for (const operation of ['solveLoadoutAsync', 'solveInventoryAsync', 'solveInventoryParallelAsync']) {
    await assert.rejects(client[operation](request(), {signal: controller.signal}), {name: 'AbortError'});
  }
  assert.equal(ControlledWorker.instances.length, 0);
});

test("parallel API starts separate workers, merges reverse completion in serial canonical order", {timeout: 10000}, async t => {
  const client = await clientFor(t);
  const payload = request(4);
  const expected = solveInventory({...payload, searchLimits: {exhaustive: true}});
  const pending = client.solveInventoryParallelAsync(payload, {parallelism: 4});
  const settled = Promise.allSettled([pending]);
  try {
    assert.equal(ControlledWorker.instances.length, 4, "one synchronous worker cannot execute shards in parallel");
    for (const worker of [...ControlledWorker.instances].reverse()) {
      const message = worker.requests[0];
      assert.equal(message.payload.searchLimits.exhaustive, true);
      assert.equal(message.payload.maxResults, payload.maxResults, "local K is sufficient; do not retain the Cartesian domain");
      worker.reply(message, structuredClone(solveInventory(message.payload)));
    }
    const actual = await pending;
    assert.deepEqual(actual.results.map(row => row.canonicalId), expected.results.map(row => row.canonicalId));
    assert.equal(actual.status, actual.certificate.status);
    assert.equal(actual.certificate.canonicalId, actual.results[0].canonicalId);
    assert.doesNotThrow(() => JSON.stringify(actual), "merged rows must not contain self references");
    assert.ok(ControlledWorker.instances.every(worker => worker.terminated), "batch workers must be released");
  } finally { client.cancelAllSearches(); await settled; }
});

test("real worker threads preserve canonical Top-K for requested 1/2/4/8 with task-capped pools and reversed inventory", {timeout: 60000}, async t => {
  const original = globalThis.Worker;
  const live = new Set();
  class ThreadWorker {
    constructor() {
      this.worker = new NodeWorker(new URL("./helpers/armor-worker-host.mjs", import.meta.url));
      live.add(this);
    }
    addEventListener(name, callback) {
      this.worker.on(name, value => callback(name === "message" ? {data: value} : {error: value}));
    }
    postMessage(data) { this.worker.postMessage(data); }
    terminate() { live.delete(this); return this.worker.terminate(); }
  }
  globalThis.Worker = ThreadWorker;
  const client = await import(`../src/core/armor-engine-client.mjs?real=${Date.now()}`);
  t.after(() => { client.cancelAllSearches(); for (const worker of live) worker.terminate(); globalThis.Worker = original; });
  for (const k of [1, 8]) {
    const payload = {...request(), maxResults: k};
    const expected = solveInventory({...payload, searchLimits: {exhaustive: true}}).results.map(row => row.canonicalId);
    for (const parallelism of [1, 2, 4, 8]) {
      const actual = await client.solveInventoryParallelAsync({...payload, items: [...payload.items].reverse()}, {parallelism});
      assert.deepEqual(actual.results.map(row => row.canonicalId), expected, `K=${k}, threads=${parallelism}`);
      assert.equal(new Set(actual.results.map(row => row.canonicalId)).size, actual.results.length);
      assert.ok(actual.results.every(row => row.certificate.witnessVerification.valid));
    }
  }
  for (const parallelism of [1, 4]) {
    const payload = {...crowdedDimRequest(), searchProfile: 'balanced'};
    payload.items.reverse();
    const actual = await client.solveInventoryParallelAsync(payload, {parallelism});
    assert.equal(actual.status, 'EXACT_TARGET_PROVEN', `crowded DIM inventory, ${parallelism} real workers`);
    assert.deepEqual(actual.results[0].visibleTotals, payload.targets);
    assert.equal(actual.results[0].pieces.find(p => p.slot === 'classItem').sourceId, 'dim-piece-6');
  }
});

test("batch abort releases all workers, ignores stale replies and permits a new batch", {timeout: 5000}, async t => {
  const client = await clientFor(t);
  const controller = new AbortController();
  const events = [];
  const pending = client.solveInventoryParallelAsync(request(), {parallelism: 2, signal: controller.signal,
    onProgress: value => events.push(value)});
  const rejection = assert.rejects(pending, {name: "AbortError"});
  const old = [...ControlledWorker.instances];
  controller.abort();
  await rejection;
  assert.ok(old.every(worker => worker.terminated));
  for (const worker of old) worker.reply(worker.requests[0], {results: []});
  assert.deepEqual(events, []);
  const next = client.solveInventoryParallelAsync(request(), {parallelism: 2});
  for (const worker of ControlledWorker.instances.slice(2)) worker.reply(worker.requests[0], solveInventory(worker.requests[0].payload));
  assert.ok((await next).results.length);
});

test("worker failure requeues its shard on a surviving worker", {timeout: 5000}, async t => {
  const client = await clientFor(t);
  const pending = client.solveInventoryParallelAsync(request(4), {parallelism: 4});
  ControlledWorker.instances[2].events.error({error: new Error("worker failed")});
  for (const worker of ControlledWorker.instances.filter((_, i) => i !== 2)) worker.reply(worker.requests[0], solveInventory(worker.requests[0].payload));
  await new Promise(resolve => setImmediate(resolve));
  const retry = ControlledWorker.instances.find(w => w.requests.length === 2);
  assert.ok(retry);
  retry.reply(retry.requests[1], solveInventory(retry.requests[1].payload));
  const result = await pending;
  assert.equal(result.search.failures, 1);
  assert.equal(result.search.effectiveWorkers, 3);
  assert.ok(ControlledWorker.instances.every(worker => worker.terminated));
});

test("incomplete or missing shard evidence cannot produce global infeasibility", {timeout: 5000}, async t => {
  const client = await clientFor(t);
  const payload = {...request(), targets: Object.fromEntries(STATS.map(stat => [stat, 199])),
    userConstraints: {exact: Object.fromEntries(STATS.map(stat => [stat, true]))}};
  const pending = client.solveInventoryParallelAsync(payload, {parallelism: 2});
  const [a, b] = ControlledWorker.instances;
  a.reply(a.requests[0], solveInventory(a.requests[0].payload));
  b.reply(b.requests[0], {results: [], searchStats: {frontierComplete: false},
    certificate: {status: "INFEASIBLE_PROVEN", proof: {complete: true}}});
  const result = await pending;
  assert.equal(result.status, "SEARCH_LIMIT_REACHED");
  assert.equal(result.status, result.certificate.status);
  assert.equal(result.certificate.proof.complete, false);
  assert.equal(result.searchStats.frontierComplete, false);
});

test("invalid thread counts are rejected without creating workers", async t => {
  const client = await clientFor(t);
  for (const parallelism of [0, -1, 1.5, NaN, Infinity, 257]) {
    await assert.rejects(client.solveInventoryParallelAsync(request(), {parallelism}), RangeError);
  }
  assert.equal(ControlledWorker.instances.length, 0);
});

test('partial construction failure keeps surviving pool and consumes every shard', async t => {
  const client = await clientFor(t);
  globalThis.Worker = class extends ControlledWorker {
    constructor() { if (ControlledWorker.instances.length >= 2) throw new Error('resource exhausted'); super(); }
  };
  const pending = client.solveInventoryParallelAsync(request(4), {parallelism: 4, shardCount: 5});
  const visited = new Set();
  for (let turn = 0; turn < 5; turn++) {
    for (const w of ControlledWorker.instances) for (const message of w.requests) {
      if (visited.has(message.id)) continue;
      visited.add(message.id); w.reply(message, solveInventory(message.payload));
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  const result = await pending;
  assert.equal(visited.size, 5);
  assert.equal(result.search.requestedWorkers, 4);
  assert.equal(result.search.successfullyCreatedWorkers, 2);
  assert.equal(result.search.shardCount, 5);
  assert.ok(result.results.every(r => r.certificate.witnessVerification.valid));
});

test('unavailable, constructor failure and complete runtime failure fall back without a negative proof', async t => {
  const client = await clientFor(t);
  const expected = solveInventory(request()).results.map(r => r.canonicalId);
  for (const worker of [undefined, class { constructor() { throw new Error('no memory'); } }]) {
    globalThis.Worker = worker;
    const result = await client.solveInventoryParallelAsync(request(), {parallelism: 2});
    assert.deepEqual(result.results.map(r => r.canonicalId), expected);
    assert.equal(result.search.effectiveWorkers, 0);
  }
  globalThis.Worker = ControlledWorker;
  const pending = client.solveInventoryParallelAsync(request(), {parallelism: 2});
  for (const w of ControlledWorker.instances) w.events.error({message: 'startup failed'});
  await new Promise(resolve => setImmediate(resolve));
  ControlledWorker.instances.at(-1).events.error({message: 'replacement also failed'});
  const result = await pending;
  assert.deepEqual(result.results.map(r => r.canonicalId), expected);
  assert.equal(result.search.effectiveWorkers, 0);
  assert.equal(result.search.failures, 3);
  assert.equal(result.search.fallback, 'inline');
});

test('a completely failed inventory pool recovers on one fresh worker before inline', async t => {
  const client = await clientFor(t);
  const pending = client.solveInventoryParallelAsync(request(), {parallelism: 2});
  for (const w of ControlledWorker.instances) w.events.error({message: 'pool exhausted'});
  await new Promise(resolve => setImmediate(resolve));
  const replacement = ControlledWorker.instances.at(-1);
  assert.equal(ControlledWorker.instances.length, 3);
  for (let i = 0; i < 2; i++) {
    const message = replacement.requests[i];
    replacement.reply(message, solveInventory(message.payload));
    await new Promise(resolve => setImmediate(resolve));
  }
  const result = await pending;
  assert.equal(result.search.fallback, 'replacement-worker');
  assert.equal(result.search.effectiveWorkers, 1);
  assert.equal(result.search.failures, 2);
  assert.ok(result.results.every(r => r.certificate.witnessVerification.valid));
});

test('more than eight workers is an explicit supported runtime choice', async t => {
  const client = await clientFor(t);
  const pending = client.solveInventoryParallelAsync(request(12), {parallelism: 12});
  assert.equal(ControlledWorker.instances.length, 12);
  for (const w of ControlledWorker.instances) w.reply(w.requests[0], {results: [], searchStats: {frontierComplete: false}});
  assert.equal((await pending).search.successfullyCreatedWorkers, 12);
});

test('startup timeout degrades but never times out an acknowledged exact search', async t => {
  const client = await clientFor(t);
  t.mock.timers.enable({apis: ['setTimeout']});
  const pending = client.solveInventoryParallelAsync(request(), {parallelism: 2});
  const good = ControlledWorker.instances[0], message = good.requests[0];
  good.events.message({data: {id: message.id, generation: message.generation, type: 'started'}});
  t.mock.timers.tick(10001);
  assert.ok(!good.terminated);
  good.reply(message, solveInventory(message.payload));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(good.requests.length, 2);
  good.reply(good.requests[1], solveInventory(good.requests[1].payload));
  assert.equal((await pending).search.failures, 1);
});

test('postMessage failure degrades; explicit cancellation never starts queued fallback work', async t => {
  const client = await clientFor(t);
  globalThis.Worker = class extends ControlledWorker { postMessage() { throw new Error('clone transport failed'); } };
  assert.ok((await client.solveInventoryParallelAsync(request(), {parallelism: 2})).results.length);
  globalThis.Worker = ControlledWorker;
  ControlledWorker.instances = [];
  const controller = new AbortController();
  const pending = client.solveInventoryParallelAsync(request(), {parallelism: 2, shardCount: 5, signal: controller.signal});
  const rejected = assert.rejects(pending, {name: 'AbortError'});
  controller.abort(); await rejected;
  assert.equal(ControlledWorker.instances.reduce((n, w) => n + w.requests.length, 0), 2);
});

test("2+3 join shard results are disjoint and recover serial Top-K", {timeout: 15000}, () => {
  const payload = request(6);
  const seed = solveInventory({...payload, maxResults: 1});
  payload.targets = seed.results[0].visibleTotals;
  payload.userConstraints = {exact: Object.fromEntries(STATS.map(stat => [stat, true]))};
  payload.searchLimits = {exhaustive: true, maxTimeMs: 10000};
  const serial = solveInventory(payload);
  assert.equal(serial.searchStats.method, "fixed-assignment-2+3-join");
  const seen = new Set();
  for (let shardIndex = 0; shardIndex < 4; shardIndex++) {
    const part = solveInventory({...payload, shardIndex, shardCount: 4});
    assert.equal(part.certificate.proof.complete, false, "a shard must not certify the whole inventory");
    for (const row of part.results) {
      assert.equal(seen.has(row.canonicalId), false, "join must partition, not duplicate all work");
      seen.add(row.canonicalId);
    }
  }
  for (const row of serial.results) assert.ok(seen.has(row.canonicalId));
});

test("a valid witness survives an incomplete sibling without claiming complete coverage", {timeout: 5000}, async t => {
  const client = await clientFor(t);
  const payload = request();
  const pending = client.solveInventoryParallelAsync(payload, {parallelism: 2});
  for (const worker of ControlledWorker.instances) {
    const message = worker.requests[0];
    const result = solveInventory(message.payload);
    result.searchStats.frontierComplete = false;
    worker.reply(message, result);
  }
  const result = await pending;
  assert.ok(["EXACT_TARGET_PROVEN", "RULE_FEASIBLE_PROVEN"].includes(result.status));
  assert.equal(result.certificate.proof.complete, false);
  assert.equal(result.certificate.canonicalId, result.results[0].canonicalId);
});

test('DFS shards partition physical candidates, including the current build', () => {
  const payload = {...request(), maxResults: 32, searchLimits: {exhaustive: true}};
  const serial = solveInventory(payload);
  payload.currentPieces = serial.results[0].pieces;
  const seen = new Set();
  let examined = 0;
  for (let shardIndex = 0; shardIndex < 4; shardIndex++) {
    const part = solveInventory({...payload, shardIndex, shardCount: 4});
    assert.equal(part.searchStats.shardIndex, shardIndex);
    assert.equal(part.searchStats.shardCount, 4);
    examined += part.examined;
    for (const row of part.results) {
      assert.equal(seen.has(row.canonicalId), false);
      seen.add(row.canonicalId);
    }
  }
  assert.equal(examined, serial.examined);
  assert.deepEqual([...seen].sort(), serial.results.map(row => row.canonicalId).sort());
});

test('parallel progress retains verified witnesses before siblings finish and across abort', async t => {
  const client = await clientFor(t);
  const controller = new AbortController();
  const events = [];
  const payload = request();
  const pending = client.solveInventoryParallelAsync(payload, {parallelism: 2, signal: controller.signal,
    onProgress: (result, search) => events.push({result, search})});
  const rejected = assert.rejects(pending, {name: 'AbortError'});
  const worker = ControlledWorker.instances[0];
  const message = worker.requests[0];
  const partial = solveInventory(message.payload);
  worker.events.message({data: {...message, type: 'progress', result: partial,
    search: {elapsedMs: 10, nodes: 4, running: true}}});
  await new Promise(resolve => setImmediate(resolve));
  const published = events.find(event => event.result?.results?.length);
  assert.ok(published, 'a positive witness must not wait for all workers');
  assert.equal(published.result.certificate.witnessVerification.valid, true);
  assert.equal(published.result.certificate.proof.complete, false);
  assert.equal(published.search.running, true);
  controller.abort();
  await rejected;
  assert.ok(published.result.results.length, 'already delivered results remain usable after stopping');
  assert.ok(ControlledWorker.instances.every(worker => worker.terminated));
});

test('new batches supersede old batches and ordinary requests supersede batches', async t => {
  const client = await clientFor(t);
  const first = client.solveInventoryParallelAsync(request(), {parallelism: 2});
  const firstRejected = assert.rejects(first, {name: 'AbortError'});
  const old = [...ControlledWorker.instances];
  const second = client.solveInventoryParallelAsync(request(), {parallelism: 2});
  const secondRejected = assert.rejects(second, {name: 'AbortError'});
  await firstRejected;
  assert.ok(old.every(worker => worker.terminated));
  const batchWorkers = ControlledWorker.instances.slice(2);
  const third = client.solveInventoryAsync(request());
  await secondRejected;
  assert.ok(batchWorkers.every(worker => worker.terminated));
  const worker = ControlledWorker.instances.at(-1);
  worker.reply(worker.requests[0], solveInventory(worker.requests[0].payload));
  assert.ok((await third).results.length);
});

// --- Search profile must survive the client wrapper -------------------------
// The wrapper used to inject `searchLimits.exhaustive = true` into every shard,
// which removed Fast/Balanced early termination: the whole browser path paid
// Deep's cost while still reporting the balanced profile.

test("the parallel client forwards the profile's exhaustive flag unchanged", async t => {
  const client = await clientFor(t);
  let seen = 0;
  for (const [searchProfile, expected] of [["fast", false], ["balanced", false], ["deep", true]]) {
    const pending = client.solveInventoryParallelAsync({...request(), searchProfile}, {parallelism: 2});
    const instances = ControlledWorker.instances.slice(seen);
    seen = ControlledWorker.instances.length;
    assert.equal(instances.length, 2);
    for (const worker of instances) {
      assert.equal(worker.requests[0].payload.searchLimits.exhaustive, expected,
        `${searchProfile} must reach the shard unchanged`);
      worker.reply(worker.requests[0], solveInventory(worker.requests[0].payload));
    }
    await pending;
  }
});

test("an explicit caller exhaustive flag still overrides Fast and Balanced", async t => {
  const client = await clientFor(t);
  let seen = 0;
  for (const searchProfile of ["fast", "balanced"]) {
    const pending = client.solveInventoryParallelAsync(
      {...request(), searchProfile, searchLimits: {exhaustive: true}}, {parallelism: 2});
    const instances = ControlledWorker.instances.slice(seen);
    seen = ControlledWorker.instances.length;
    for (const worker of instances) {
      assert.equal(worker.requests[0].payload.searchLimits.exhaustive, true);
      worker.reply(worker.requests[0], solveInventory(worker.requests[0].payload));
    }
    await pending;
  }
});

test("a non-exhaustive search stops early without ever claiming infeasibility", async () => {
  const {withSearchProfile} = await import("../src/core/search-session.mjs");
  const base = request(6);
  const seed = solveInventory({...base, maxResults: 1});
  const payload = {
    ...base,
    targets: seed.results[0].visibleTotals,
    userConstraints: {exact: Object.fromEntries(STATS.map(stat => [stat, true]))},
    maxResults: 1,
  };

  const fast = withSearchProfile("solveInventory", {...payload, searchProfile: "fast"});
  assert.equal(fast.searchLimits.exhaustive, false);
  const result = solveInventory(fast);
  // The early stop the wrapper used to disable.
  assert.equal(result.searchStats.termination, "exact-witness-quota");
  assert.equal(result.searchStats.frontierComplete, false);
  assert.notEqual(result.certificate.status, "INFEASIBLE_PROVEN",
    "a bounded search may not claim the inventory has no solution");
  assert.equal(result.certificate.proof.complete, false);
  assert.ok(result.results.length > 0, "and it must still return the verified candidates it found");
  assert.ok(result.results.every(row => row.certificate.witnessVerification.valid));

  // Forcing exhaustive — exactly what the wrapper used to do — removes the
  // early stop, which is the cost regression this guards against.
  const forced = solveInventory({...fast, searchLimits: {...fast.searchLimits, exhaustive: true}});
  assert.equal(forced.searchStats.termination, "exhausted");

  // Deep remains the profile that is allowed to exhaust the frontier.
  const deep = withSearchProfile("solveInventory", {...payload, searchProfile: "deep"});
  assert.equal(deep.searchLimits.exhaustive, true);
});

test("a budget-limited search for an unreachable target returns a limit, not a proof", async () => {
  const {withSearchProfile} = await import("../src/core/search-session.mjs");
  const payload = {
    ...request(8),
    targets: Object.fromEntries(STATS.map(stat => [stat, 199])),
    userConstraints: {exact: Object.fromEntries(STATS.map(stat => [stat, true]))},
    maxResults: 2,
  };
  const fast = withSearchProfile("solveInventory", {...payload, searchProfile: "fast"});
  assert.equal(fast.searchLimits.exhaustive, false);
  const result = solveInventory(fast);
  assert.notEqual(result.certificate.status, "INFEASIBLE_PROVEN",
    "\"no solution in the budget\" is not \"no solution exists\"");
  assert.equal(result.status, "SEARCH_LIMIT_REACHED");
  assert.equal(result.certificate.proof.complete, false);
  assert.equal(result.searchStats.frontierComplete, false);
});
