import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {createProblemSpec, createRulesetId} from '../src/core/solver-v3-contract.mjs';

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
  assert.match(context.renderOwnedPieceRequirement({ ...piece, tuningMode: 'plus3' }), /方案.*\+3/);
  assert.doesNotMatch(context.renderOwnedPieceRequirement({ ...piece, tuningTo: 'melee' }), /需更换/);
});

test('re-ranking owned plans keeps the solution being read', () => {
  const selected = { id: 'selected' };
  const betterOwnedMatch = { id: 'better' };
  const state = vm.createContext({
    allSolutions: [selected, betterOwnedMatch], currentSolutionIdx: 0,
    SOLUTION_PREVIEW_COUNT: 10,
    lastTargets: {}, lastFragments: {}, displayAllResults: () => {},
    createOwnedArmorPlanRequest: () => ({}),
    rankInventoryPlans: () => [{ solution: betterOwnedMatch }, { solution: selected }],
  });
  const fn = source.slice(source.indexOf('function refreshInventoryPlansFromSolutions(')).split('\nfunction ')[0];
  vm.runInContext(fn, state);
  state.refreshInventoryPlansFromSolutions();
  assert.equal(state.allSolutions[state.currentSolutionIdx], selected);
  state.refreshInventoryPlansFromSolutions({ rerender: false });
  assert.equal(state.allSolutions[state.currentSolutionIdx], betterOwnedMatch,
    'a new search should still select the best owned match initially');
});

test('owned plan cache binds original rules/budget as well as inventory revision', () => {
  let evaluations = 0;
  const state = vm.createContext({
    calculatorMode: 'solve', importClassFilter: 'hunter', inventoryExoticSlotFilter: '', inventoryFixedExoticKey: '',
    document: {getElementById: () => ({checked: false})},
    snapshotSetRequirement: () => ({type: 'none'}), createCanonicalId: () => 'same-five-pieces', createRulesetId,
    createOwnedArmorPlanRequest: () => ({}), rankInventoryPlans: () => [{evaluation: ++evaluations}],
  });
  vm.runInContext(source.slice(source.indexOf('let ownedPlanRevision ='),
    source.indexOf('function refreshInventoryPlansFromSolutions(')), state);
  const original = {problemSpec: createProblemSpec({target: {health: 100}})};
  const first = state.getOwnedArmorPlan(original);
  assert.equal(state.getOwnedArmorPlan(original), first);
  const differentRule = {problemSpec: createProblemSpec({target: {health: 100}, constraints: {minimums: {health: 100}}})};
  assert.notEqual(state.getOwnedArmorPlan(differentRule), first);
  const differentBudget = {problemSpec: createProblemSpec({target: {health: 100}, numPlus10: 1})};
  assert.notEqual(state.getOwnedArmorPlan(differentBudget), first);
  state.invalidateOwnedPlanCache();
  assert.notEqual(state.getOwnedArmorPlan(original), first);
  assert.equal(evaluations, 4);
});
