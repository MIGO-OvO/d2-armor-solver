import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {createProblemSpec, createRulesetId} from '../src/core/solver-v3-contract.mjs';
import {createOwnedPlanCache} from '../src/core/owned-plan-cache.mjs';

const source = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
// The five-piece armor table renders one row per piece; an owned piece of a
// theoretical skeleton gets its required-vs-installed Tuning note from here.
const functions = ['formatInventoryItemTuning', 'renderOwnedPieceRequirement'].map(name =>
  source.slice(source.indexOf(`function ${name}(`)).split('\nfunction ')[0]);
const context = vm.createContext({
  l: (...labels) => labels[0], t: () => '第三属性',
  STAT_LABELS: { melee: '近战', super: '超能', health: '生命值', grenade: '手雷' },
  UPGRADE_SLOTS: [{ id: 'helmet' }], getUpgradeSlotLabel: () => '头盔',
  getArchetypeLabel: () => '专家', escapeHtml: value => value,
  renderOwnedArmorBungieAction: () => '',
});
vm.runInContext(functions.join('\n'), context);

test('owned armor shows required tuning separately from currently installed tuning', () => {
  const piece = { slot: 'helmet', tuningMode: 'shift', tuningTo: 'super',
    item: { name: '忠诚面具', exotic: true, tertiary: 'grenade', tuningMode: 'shift', tuningTo: 'melee' } };
  const html = context.renderOwnedPieceRequirement(piece);
  assert.match(html, /方案.*\+5超能/);
  assert.match(html, /当前.*\+5近战/);
  assert.match(html, /需更换/);
  assert.equal(piece.item.tuningTo, 'melee', 'rendering must not overwrite physical inventory');
  assert.equal(context.formatInventoryItemTuning({tuningMode: 'none'}), '无调整');
  assert.equal(context.formatInventoryItemTuning({tuningMode: 'shift', tuningInstalled: false, tuningTo: 'melee'}), '无调整');
  assert.match(context.renderOwnedPieceRequirement({ ...piece, tuningMode: 'plus3' }), /方案.*\+3/);
  assert.doesNotMatch(context.renderOwnedPieceRequirement({ ...piece, tuningTo: 'melee' }), /需更换/);
});

test('re-ranking owned plans keeps the solution being read', async () => {
  const selected = { id: 'selected' };
  const betterOwnedMatch = { id: 'better' };
  const state = vm.createContext({
    allSolutions: [selected, betterOwnedMatch], currentSolutionIdx: 0,
    SOLUTION_PREVIEW_COUNT: 10,
    lastTargets: {}, lastFragments: {}, displayAllResults: () => {},
    ownedPlanRevision: 0, ownedPlanResultRevision: 0, searchUiRevision: 0,
    ensureOwnedArmorPlans: async () => [{ solution: betterOwnedMatch }, { solution: selected }],
    normalizeTheoryPlan: plan => plan, compareUnifiedEntries: () => 0, scheduleOwnedPlanRender() {},
  });
  const fn = source.slice(source.indexOf('async function refreshInventoryPlansFromSolutions(')).split('\nfunction ')[0];
  vm.runInContext(fn, state);
  await state.refreshInventoryPlansFromSolutions();
  assert.equal(state.allSolutions[state.currentSolutionIdx], selected);
  await state.refreshInventoryPlansFromSolutions({ rerender: false });
  assert.equal(state.allSolutions[state.currentSolutionIdx], betterOwnedMatch,
    'a new search should still select the best owned match initially');
});

test('owned plan cache binds original rules/budget as well as inventory revision', async () => {
  let evaluations = 0;
  const state = vm.createContext({
    calculatorMode: 'solve', importClassFilter: 'hunter', inventoryExoticSlotFilter: '', inventoryFixedExoticKey: '',
    document: {getElementById: () => ({checked: false})},
    snapshotSetRequirement: () => ({type: 'none'}), createCanonicalId: () => 'same-five-pieces', createRulesetId,
    createOwnedArmorPlanRequest: solutions => ({solutions}), allSolutions: [], searchUiRevision: 0, console,
    createOwnedPlanCache, rankInventoryPlansAsync: async () => [{sourceIndex: 0, evaluation: ++evaluations}],
    requestAnimationFrame: () => 1,
  });
  vm.runInContext(source.slice(source.indexOf('let ownedPlanRevision ='),
    source.indexOf('async function refreshInventoryPlansFromSolutions(')), state);
  const original = {problemSpec: createProblemSpec({target: {health: 100}})};
  assert.equal(state.getOwnedArmorPlan(original), null, 'a cache miss must not synchronously solve');
  await state.ensureOwnedArmorPlans([original]);
  const first = state.getOwnedArmorPlan(original);
  assert.equal(state.getOwnedArmorPlan(original).evaluation, first.evaluation);
  const differentRule = {problemSpec: createProblemSpec({target: {health: 100}, constraints: {minimums: {health: 100}}})};
  await state.ensureOwnedArmorPlans([differentRule]);
  assert.notEqual(state.getOwnedArmorPlan(differentRule).evaluation, first.evaluation);
  const differentBudget = {problemSpec: createProblemSpec({target: {health: 100}, numPlus10: 1})};
  await state.ensureOwnedArmorPlans([differentBudget]);
  assert.notEqual(state.getOwnedArmorPlan(differentBudget).evaluation, first.evaluation);
  state.invalidateOwnedPlanCache();
  await state.ensureOwnedArmorPlans([original]);
  assert.notEqual(state.getOwnedArmorPlan(original).evaluation, first.evaluation);
  assert.equal(evaluations, 4);
});

test('an explicit new search retries failed plan keys while retaining valid plans and range cache', async () => {
  let evaluations = 0;
  let fail = false;
  const ranges = new Map([['warm-range', {ranges: {health: [100]}}]]);
  const state = vm.createContext({
    calculatorMode: 'solve', importClassFilter: 'hunter', inventoryExoticSlotFilter: '', inventoryFixedExoticKey: '',
    document: {getElementById: () => ({checked: false})},
    snapshotSetRequirement: () => ({type: 'none'}), createCanonicalId: solution => solution.id, createRulesetId,
    createOwnedArmorPlanRequest: solutions => ({solutions}), allSolutions: [], searchUiRevision: 0,
    createOwnedPlanCache, rankInventoryPlansAsync: async () => {
      evaluations++;
      if (fail) throw new Error('temporary plan worker failure');
      return [{sourceIndex: 0, evaluation: evaluations}];
    },
    requestAnimationFrame: () => 1, console: {error() {}},
    realtimeRangeCache: ranges, cancelRealtimePreview() {}, cancelAllSearches() {}, renderSearchStatus() {},
    backgroundInventoryRevision: null, lastSearchResult: null, displayedTheoryProgressKey: null,
  });
  vm.runInContext(source.slice(source.indexOf('let ownedPlanRevision ='),
    source.indexOf('async function refreshInventoryPlansFromSolutions(')), state);
  vm.runInContext(source.slice(source.indexOf('function beginSearch()'), source.indexOf('function setSearchProfile(')), state);
  const good = {id: 'good'}, retry = {id: 'retry'};
  await state.ensureOwnedArmorPlans([good]);
  const cached = state.getOwnedArmorPlan(good).evaluation;
  fail = true;
  await state.ensureOwnedArmorPlans([retry]);
  await state.ensureOwnedArmorPlans([retry]);
  assert.equal(evaluations, 2, 'failed key is suppressed during the same search');
  fail = false;
  state.beginSearch();
  await state.ensureOwnedArmorPlans([retry]);
  assert.equal(evaluations, 3, 'the explicit retry must dispatch again');
  assert.equal(state.getOwnedArmorPlan(good).evaluation, cached, 'valid derived plans stay cached');
  assert.equal(ranges.size, 1, 'an explicit retry must not discard mathematical range cache');
  assert.equal(state.getOwnedArmorPlan(retry).evaluation, 3);
});
