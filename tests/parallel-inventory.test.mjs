import assert from "node:assert/strict";
import test from "node:test";
import {BASE_CONFIGS, STATS} from "../src/core/armor-model.mjs";
import {solveInventory} from "../src/core/armor-engine.mjs";
import {Worker as NodeWorker} from "node:worker_threads";

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

test("parallel API starts separate workers, merges reverse completion in serial canonical order", {timeout: 10000}, async t => {
  const client = await clientFor(t);
  const payload = request();
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

test("real worker threads preserve canonical Top-K for 1/2/4/8 threads and reversed inventory", {timeout: 60000}, async t => {
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

test("worker failure cancels sibling shards instead of hanging the batch", {timeout: 5000}, async t => {
  const client = await clientFor(t);
  const pending = client.solveInventoryParallelAsync(request(), {parallelism: 4});
  const rejection = assert.rejects(pending, /worker failed/);
  ControlledWorker.instances[2].events.error({error: new Error("worker failed")});
  await rejection;
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
  for (const parallelism of [0, -1, 1.5, NaN, Infinity, 9]) {
    await assert.rejects(client.solveInventoryParallelAsync(request(), {parallelism}), RangeError);
  }
  assert.equal(ControlledWorker.instances.length, 0);
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
