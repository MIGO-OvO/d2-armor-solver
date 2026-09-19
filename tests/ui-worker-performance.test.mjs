import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {Worker as NodeWorker} from 'node:worker_threads';
import {createOwnedPlanCache} from '../src/core/owned-plan-cache.mjs';
import {BASE_CONFIGS, STATS} from '../src/core/armor-model.mjs';
import {rankOwnedArmorPlans} from '../src/core/armor-engine.mjs';
import {createProblemSpec, sealWitness, createResultCertificate} from '../src/core/solver-v3-contract.mjs';

const flush = () => new Promise(setImmediate);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; };
class FakeWorker {
  static instances = [];
  constructor(url, options) { this.url = String(url); this.options = options; this.events = {}; this.requests = []; FakeWorker.instances.push(this); }
  addEventListener(name, callback) { this.events[name] = callback; }
  postMessage(request) { this.requests.push(structuredClone(request)); }
  reply(result, request = this.requests.at(-1)) {
    this.events.message({data: {id: request.id, generation: request.generation, type: 'result', result}});
  }
  terminate() { this.terminated = true; }
}
async function mockClient(t) {
  const original = globalThis.Worker;
  FakeWorker.instances = [];
  globalThis.Worker = FakeWorker;
  const client = await import(`../src/core/armor-engine-client.mjs?ui=${Math.random()}`);
  t.after(() => {client.cancelAllSearches({dispose: true}); globalThis.Worker = original;});
  return client;
}

test('cancelling idle operations retains their warm workers; busy work is terminated', async t => {
  const client = await mockClient(t);
  const first = client.calculateReachabilityAsync({});
  const warm = FakeWorker.instances[0];
  warm.reply({ranges: {}}); await first;
  client.cancelAllSearches();
  assert.notEqual(warm.terminated, true);
  const second = client.calculateReachabilityAsync({});
  assert.equal(FakeWorker.instances.length, 1);
  const rejected = assert.rejects(second, {name: 'AbortError'});
  client.cancelOperation('calculateReachability'); await rejected;
  assert.equal(warm.terminated, true);
  const third = client.calculateReachabilityAsync({});
  assert.equal(FakeWorker.instances.length, 2);
  FakeWorker.instances[1].reply({ranges: {}}); await third;
});

test('nearest suggestions use a fast independent channel and cannot cancel the foreground solve', async t => {
  const client = await mockClient(t);
  const foreground = client.solveLoadoutAsync({searchProfile: 'deep'});
  const foregroundWorker = FakeWorker.instances[0];
  const suggestion = client.suggestLoadoutAsync({searchProfile: 'deep'});
  const previewWorker = FakeWorker.instances[1];
  assert.equal(previewWorker.requests[0].operation, 'suggest');
  assert.equal(previewWorker.requests[0].payload.searchProfile, 'fast');
  assert.equal(previewWorker.requests[0].payload.runtimeOptions.fastMode, true);
  assert.notEqual(foregroundWorker.terminated, true);
  previewWorker.reply([]); foregroundWorker.reply([]);
  await Promise.all([foreground, suggestion]);
});

const source = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function previewHarness(client) {
  const timers = new Map(); let timerId = 0;
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {style: {}, innerHTML: '', textContent: '',
      checked: id.startsWith('targetLock_'), classList: {remove() {}}, removeAttribute() {}, setAttribute() {}});
    return elements.get(id);
  };
  const state = vm.createContext({
    STATS, document: {getElementById: element, querySelectorAll: () => []},
    searchUiRevision: 0, displayedTheoryProgressKey: null, backgroundInventoryRevision: null,
    failedOwnedPlanKeys: new Set(), ownedPlanError: null,
    lastSearchResult: null, theorySearchRunning: false, realtimeRangeRevision: 0,
    realtimeRangeTimer: null, realtimeRangeCache: new Map(), calculatorMode: 'solve',
    setTimeout(fn) {timers.set(++timerId, fn); return timerId;}, clearTimeout(id) {timers.delete(id);},
    cancelOperation: client.cancelOperation, cancelAllSearches: client.cancelAllSearches,
    calculateReachabilityAsync: client.calculateReachabilityAsync, suggestLoadoutAsync: client.suggestLoadoutAsync,
    renderSearchStatus() {}, getExoticSettings: () => ({config: {baseStats: Object.fromEntries(STATS.map(s => [s, 5]))}, priorityOrder: []}),
    getFragments: () => Object.fromEntries(STATS.map(s => [s, 0])), getVal: () => 100, getEnabledPlus3Count: () => 0,
    buildUserConstraints: () => ({}), buildVisibleTargetConstraints: () => ({}), certifiedFeasible: () => true,
    clearRangeHints() {}, updateInlineRangeHints() {}, l: value => value, console,
  });
  for (const [start, end] of [
    ['function beginSearch()', 'function setSearchProfile('],
    ['function stopSearches()', 'import {\n  detectEquippedClass'],
    ['function cancelRealtimePreview()', 'function collectDraftState()'],
    ['async function getNearestTargetSuggestion(', 'function applyNearestTargetSuggestion()'],
    ['function resetRealtimeRangeUI()', '// ============================================================\n// SOLVE'],
  ]) {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    vm.runInContext(source.slice(from, to), state);
  }
  return {state, timers};
}

test('a pending 180ms preview is removed by both beginSearch and Stop, with no restarted work', async t => {
  const client = await mockClient(t);
  const h = previewHarness(client);
  for (const action of ['beginSearch', 'stopSearches']) {
    h.state.scheduleRealtimeRanges();
    assert.equal(h.timers.size, 1);
    const revision = h.state.realtimeRangeRevision;
    h.state[action]();
    assert.equal(h.timers.size, 0);
    assert.ok(h.state.realtimeRangeRevision > revision);
  }
  assert.equal(FakeWorker.instances.length, 0);
});

test('identical mathematical range parameters reuse the UI cache after cancelling idle workers', async t => {
  const client = await mockClient(t);
  const {state} = previewHarness(client);
  const first = state.updateRealtimeRanges();
  FakeWorker.instances[0].reply({ranges: {}, certificate: {status: 'RULE_FEASIBLE_PROVEN'}});
  await first;
  state.stopSearches();
  await state.updateRealtimeRanges();
  assert.equal(FakeWorker.instances.length, 1);
  assert.equal(FakeWorker.instances[0].requests.length, 1);
});

test('20 inventory progress updates share one asynchronous plan batch and preserve source identity', async () => {
  let calls = 0, updates = 0;
  const task = deferred();
  const cache = createOwnedPlanCache({calculate: () => {calls++; return task.promise;}, onUpdate() {updates++;}});
  const solutions = [{canonicalId: 'a'}, {canonicalId: 'b'}];
  const request = {solutions, items: []};
  const pending = Array.from({length: 20}, () => cache.ensure(request, ['a|rules|vault', 'b|rules|vault']));
  await flush(); assert.equal(calls, 1);
  task.resolve([{sourceIndex: 1, solution: structuredClone(solutions[1])}, {sourceIndex: 0, solution: structuredClone(solutions[0])}]);
  const plans = (await Promise.all(pending))[0];
  assert.equal(plans[0].solution, solutions[0]);
  assert.equal(plans[1].solution, solutions[1]);
  for (let i = 0; i < 20; i++) await cache.ensure(request, ['a|rules|vault', 'b|rules|vault']);
  assert.equal(calls, 1); assert.equal(updates, 1);
});

test('a late old inventory plan cannot populate or render the new cache generation', async () => {
  const tasks = [], signals = []; let updates = 0;
  const cache = createOwnedPlanCache({calculate: (_request, {signal}) => {
    const task = deferred(); tasks.push(task); signals.push(signal); return task.promise;
  }, onUpdate() {updates++;}});
  const request = {solutions: [{canonicalId: 'a'}], items: []};
  const old = cache.ensure(request, ['a']);
  const rejected = assert.rejects(old, {name: 'AbortError'});
  await flush(); cache.invalidate();
  const fresh = cache.ensure(request, ['a']); await flush();
  assert.equal(signals[0].aborted, true);
  tasks[0].resolve([{sourceIndex: 0, stale: true}]); await rejected;
  assert.equal(cache.has('a'), false);
  tasks[1].resolve([{sourceIndex: 0, stale: false}]); await fresh;
  assert.equal(cache.peek('a').stale, false); assert.equal(updates, 1);
});

test('inventory progress is frame-coalesced and unchanged candidates do not rebuild the DOM', () => {
  const frames = [];
  let writes = 0;
  const element = {hidden: true, setAttribute() {}, set innerHTML(_value) {writes++;}};
  let entry = {pieces: [{slot: 'helmet', sourceId: 'a'}], witness: {canonicalId: 'a'},
    certificate: {status: 'EXACT_TARGET_PROVEN'}, feasible: true, farmCount: 0,
    search: {running: true, nodes: 1}};
  const state = vm.createContext({
    requestAnimationFrame: callback => {frames.push(callback); return frames.length;},
    document: {getElementById: () => element}, renderingUnifiedList: false,
    calculatorMode: 'upgrade',
    ownedPlanResultRevision: 1, inventoryResultRevision: 0, lastInventoryResult: null,
    lastUnifiedLoadouts: [], selectedEntryKey: null, selectedUnifiedIndex: 0,
    PLAN_PAGE_SIZE: 10, planRenderLimit: 10, planFilter: 'all', planSort: 'recommended',
    buildUnifiedLoadouts: () => [entry], projectPlanView: values => values,
    resolveSelectedRowIndex: () => 0, unifiedEntryKey: value => value.witness.canonicalId,
    unifiedSelectionKey: value => value.witness.canonicalId,
    getPageLanguage: () => 'en', renderResultWorkspace: () => 'content', restoreDetailDisclosure() {},
    syncCommandBarActions() {}, syncCommandBarLabels() {},
  });
  const start = source.indexOf('function renderInventoryResults(');
  vm.runInContext(source.slice(start, source.indexOf('// --- Plan browser view projection', start)), state);
  const renderStart = source.indexOf('function renderUnifiedResults(');
  vm.runInContext(source.slice(renderStart, source.indexOf('// Re-render only the selection-dependent', renderStart)), state);
  for (let i = 0; i < 20; i++) state.renderInventoryResults({results: [entry]});
  assert.equal(frames.length, 1); frames.shift()(); assert.equal(writes, 1);
  entry = {...entry, search: {...entry.search, nodes: 100}};
  state.renderInventoryResults({results: [entry]}); frames.shift()(); assert.equal(writes, 1);
  entry = {...entry, search: {...entry.search, running: false, termination: 'completed'}};
  state.renderInventoryResults({results: [entry]}); frames.shift()(); assert.equal(writes, 2);
});

test('offline embedded source creates a classic Blob worker without external module URLs', async t => {
  const client = await mockClient(t);
  const original = globalThis.__ARMOR_OFFLINE_WORKER_SOURCE__;
  globalThis.__ARMOR_OFFLINE_WORKER_SOURCE__ = 'self.onmessage = () => {};';
  t.after(() => {globalThis.__ARMOR_OFFLINE_WORKER_SOURCE__ = original;});
  const pending = client.calculateReachabilityAsync({});
  const worker = FakeWorker.instances[0];
  assert.match(worker.url, /^blob:/); assert.equal(worker.options.type, undefined);
  worker.reply({ranges: {}}); await pending;
});

test('a browser without Worker rejects explicitly instead of running a synchronous fallback', async t => {
  const client = await mockClient(t);
  const original = globalThis.document;
  globalThis.document = {}; globalThis.Worker = undefined;
  t.after(() => {if (original === undefined) delete globalThis.document; else globalThis.document = original;});
  for (const method of ['solveLoadoutAsync', 'rankInventoryPlansAsync', 'calculateReachabilityAsync']) {
    await assert.rejects(client[method]({}), {name: 'WorkerUnavailableError'});
  }
  assert.equal(FakeWorker.instances.length, 0);
});

test('browser Worker construction failure rejects parallel inventory instead of resolving a null result', async t => {
  const client = await mockClient(t);
  const original = globalThis.document;
  globalThis.document = {};
  globalThis.Worker = class {constructor() {throw new Error('CSP denies Worker');}};
  t.after(() => {if (original === undefined) delete globalThis.document; else globalThis.document = original;});
  for (const method of ['solveInventoryAsync', 'solveInventoryParallelAsync']) {
    await assert.rejects(client[method]({items: []}), {name: 'WorkerUnavailableError'});
  }
});

test('real worker matching preserves synchronous plan witnesses and real merge rejects forged negative evidence', {timeout: 10000}, async t => {
  const original = globalThis.Worker;
  globalThis.Worker = class {
    constructor() {this.worker = new NodeWorker(new URL('./helpers/armor-worker-host.mjs', import.meta.url));}
    addEventListener(name, callback) {this.worker.on(name, data => callback(name === 'message' ? {data} : {error: data}));}
    postMessage(data) {this.worker.postMessage(data);}
    terminate() {return this.worker.terminate();}
  };
  const client = await import(`../src/core/armor-engine-client.mjs?realPlans=${Math.random()}`);
  t.after(() => {client.cancelAllSearches({dispose: true}); globalThis.Worker = original;});
  const configs = BASE_CONFIGS.slice(0, 5);
  const target = Object.fromEntries(STATS.map(s => [s, configs.reduce((sum, c) => sum + c.baseStats[s], 0)]));
  const spec = createProblemSpec({operation: 'solve', target, numPlus5: 0, numPlus10: 0, numPlus3: 0});
  const sealed = sealWitness(spec, {config: configs, tuningAssignments: configs.map(() => ({mode: 'none', from: null, to: null})),
    modAssignments: Object.fromEntries(configs.map((_, index) => [index, null]))});
  assert.equal(sealed.valid, true);
  const witness = sealed.witness;
  witness.certificate = createResultCertificate({problemSpec: spec, witness, status: 'EXACT_TARGET_PROVEN'});
  const slots = ['helmet', 'arms', 'chest', 'legs', 'classItem'];
  const items = configs.map((config, index) => ({...config, id: String(index), slot: slots[index], classId: 'hunter',
    archetypeId: config.archetype, optimizationBaseStats: {...config.baseStats}, effectiveBaseStats: {...config.baseStats},
    tuningMode: 'none', tuningInstalled: false, tunedStat: STATS[index], exotic: false}));
  const request = {solutions: [witness], items, classId: 'hunter', maxResults: 1};
  const expected = rankOwnedArmorPlans(request);
  const actual = await client.rankInventoryPlansAsync(request);
  assert.deepEqual(actual, structuredClone(expected));
  const merged = await client.mergeInventoryResultsAsync({request: {items, targets: target, reassignModifiers: false},
    parts: [{results: [], certificate: {status: 'INFEASIBLE_PROVEN', proof: {complete: true}}}], count: 1});
  assert.notEqual(merged.certificate.status, 'INFEASIBLE_PROVEN');
  assert.equal(merged.certificate.proof.complete, false);
});
