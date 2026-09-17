import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
const solveSource = source.slice(source.indexOf('async function solve()'), source.indexOf('function buildRefineCard('));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(realInventory = false) {
  const elements = new Map();
  const inventory = [], theory = [], shown = [];
  const state = vm.createContext({
    document: {querySelectorAll: () => [], getElementById(id) {
      if (!elements.has(id)) elements.set(id, {innerHTML: '', dataset: {}, style: {}, disabled: false,
        setAttribute() {}, classList: {add() {}, remove() {}}});
      return elements.get(id);
    }},
    STATS: ['health'], importedInventory: [{}], manualOwnedItems: [], searchProfile: 'balanced',
    searchUiRevision: 0, lastInventoryResult: null, allSolutions: [], currentSolutionIdx: 0,
    theorySearchRunning: false, backgroundInventoryRevision: null,
    getVal: () => 0, getFragments: () => ({}), getEnabledPlus3Count: () => 0, getExoticSettings: () => null,
    clearInventoryResults() {}, buildVisibleTargetConstraints: () => ({}), visibleConstraintsToArmor: () => ({}),
    solveInventoryRequirement() { const task = deferred(); inventory.push(task); return task.promise; },
    solveLoadoutAsync() { const task = deferred(); theory.push(task); return task.promise; },
    renderSearchStatus() {}, refreshInventoryPlansFromSolutions() {},
    displayAllResults(result) { shown.push(result); }, icon: () => '', l: text => text,
    console: {error() {}},
  });
  if (realInventory) {
    Object.assign(state, {calculatorMode: 'solve', inventorySolveRevision: 0, backgroundInventoryRevision: null,
      lastSearchResult: {search: {running: false}}, theorySearchRunning: false, setRequirement: {type: 'none'},
      snapshotSetRequirement: () => ({type: 'none'}), sameSetRequirement: () => true,
      getOwnedArmorInputs: () => ({items: [{}]}),
      solveInventoryParallelAsync(payload, options) {
        const task = {...deferred(), options}; inventory.push(task); return task.promise;
      },
      renderInventoryResults(result) { state.lastInventoryResult = result; }, certifiedFeasible: () => true,
      inventoryProofLabel: result => result.label, escapeHtml: text => text,
    });
    const start = source.indexOf('async function solveInventoryRequirement(');
    const end = source.indexOf('// ============================================================', start);
    vm.runInContext(source.slice(start, end), state);
  }
  vm.runInContext('function beginSearch() { return ++searchUiRevision; }\n' + solveSource, state);
  return {state, inventory, theory, shown, elements};
}

test('actual solve call returns theory before inventory and accepts a late owned message', async () => {
  const h = harness();
  const pending = h.state.solve();
  assert.equal(h.theory.length, 1, 'theory must start without resolving inventory');
  h.theory[0].resolve([{id: 'theory'}]);
  await pending;
  assert.equal(h.shown[0].id, 'theory');
  assert.equal(h.elements.get('btnSolve').disabled, false);
  h.inventory[0].resolve('owned exact witness');
  await flush();
  assert.equal(h.elements.get('messages').innerHTML, 'owned exact witness');
});

test('inventory finishing before first theory publication keeps cancellation enabled', async () => {
  const h = harness(true);
  const pending = h.state.solve();
  h.state.theorySearchRunning = true;
  h.inventory[0].resolve({results: [], label: 'no owned witness'});
  await flush();
  assert.equal(h.elements.get('cancelSearch').disabled, false);
  assert.equal(h.elements.get('btnSolve').disabled, true);
  h.theory[0].resolve([{id: 'theory'}]);
  await pending;
  assert.equal(h.elements.get('cancelSearch').disabled, true);
});

test('changing owned inputs cancels inventory without disabling a pending theory search', async () => {
  const h = harness(true), cancelled = [];
  Object.assign(h.state, {cancelOperation: operation => cancelled.push(operation), invalidateOwnedPlanCache() {},
    detailDisclosureState: new Map(), syncCommandBarActions() {}});
  const start = source.indexOf('function clearInventoryResults(');
  vm.runInContext(source.slice(start, source.indexOf('function formatSetRequirementLabel(', start)), h.state);
  const pending = h.state.solve();
  h.state.theorySearchRunning = true;
  h.state.clearInventoryResults();
  assert.equal(cancelled.at(-1), 'solveInventory');
  assert.equal(h.state.backgroundInventoryRevision, null);
  assert.equal(h.elements.get('cancelSearch').disabled, false);
  h.inventory[0].resolve({results: [{}], label: 'old inputs'});
  await flush();
  assert.equal(h.state.lastInventoryResult, null);
  assert.doesNotMatch(h.elements.get('messages').innerHTML, /old inputs/);
  h.theory[0].resolve([{id: 'valid theory'}]); await pending;
  assert.equal(h.shown[0].id, 'valid theory');
});

test('real inventory completion/progress is revision guarded and does not own theory loading controls', async () => {
  const h = harness(true);
  const first = h.state.solve();
  h.theory[0].resolve([{id: 'old'}]); await first;
  assert.equal(h.elements.get('btnSolve').disabled, false);
  assert.equal(h.elements.get('cancelSearch').disabled, false, 'background exact search remains cancellable');
  const second = h.state.solve();
  h.inventory[0].options.onProgress({results: [{}], label: 'stale progress'});
  h.inventory[0].resolve({results: [{}], label: 'stale final'});
  await flush();
  assert.equal(h.state.lastInventoryResult, null);
  assert.equal(h.elements.get('btnSolve').disabled, true, 'old inventory finally cannot unlock the new theory');
  h.theory[1].resolve([{id: 'new'}]); await second;
  h.inventory[1].options.onProgress({results: [{}], label: 'new progress'});
  assert.equal(h.state.lastInventoryResult.label, 'new progress');
  h.inventory[1].resolve({results: [{}], label: 'new final'});
  await flush();
  assert.equal(h.state.lastInventoryResult.label, 'new final');
  assert.match(h.elements.get('messages').innerHTML, /new final/);
  assert.equal(h.elements.get('cancelSearch').disabled, true);
});

test('old inventory and theory errors cannot overwrite a newer search', async () => {
  const h = harness();
  const old = h.state.solve();
  const next = h.state.solve();
  assert.equal(h.theory.length, 2);
  h.inventory[1].resolve('new owned');
  h.theory[1].resolve([{id: 'new'}]);
  await next;
  h.inventory[0].resolve('stale owned');
  h.theory[0].reject(new Error('stale theory error'));
  await old; await flush();
  assert.equal(h.elements.get('messages').innerHTML, 'new owned');
  assert.deepEqual(h.shown.map(x => x.id), ['new']);
});

test('inventory cancellation or failure does not reject theory', async () => {
  for (const error of [Object.assign(new Error('cancel'), {name: 'AbortError'}), new Error('inventory logic')]) {
    const h = harness();
    const pending = h.state.solve();
    assert.equal(h.theory.length, 1);
    h.inventory[0].reject(error);
    h.theory[0].resolve([{id: 'valid'}]);
    await pending; await flush();
    assert.equal(h.shown[0].id, 'valid');
  }
});

test('solve completion awaits the asynchronous derived workspace but not background inventory', async () => {
  const h = harness(), plans = deferred();
  h.state.refreshInventoryPlansFromSolutions = () => plans.promise;
  let settled = false;
  const pending = h.state.solve().then(() => {settled = true;});
  h.theory[0].resolve([{id: 'theory'}]);
  await flush();
  assert.equal(settled, false);
  assert.equal(h.elements.get('cancelSearch').disabled, false);
  plans.resolve(); await pending;
  assert.equal(h.shown[0].id, 'theory');
  assert.equal(settled, true);
  h.inventory[0].resolve('late owned'); await flush();
  assert.equal(h.elements.get('messages').innerHTML, 'late owned');
});

test('cancelling derived matching does not publish the old theory result into a new search', async () => {
  const h = harness(), plans = deferred();
  h.state.refreshInventoryPlansFromSolutions = () => plans.promise;
  const old = h.state.solve();
  h.theory[0].resolve([{id: 'stale'}]); await flush();
  h.state.searchUiRevision++;
  plans.reject(Object.assign(new Error('cancelled plan'), {name: 'AbortError'}));
  await old;
  assert.equal(h.shown.length, 0);
  h.inventory[0].resolve(null); await flush();
});
