import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
const functions = ['formatInventoryItemTuning', 'renderOwnedArmorMatch'].map(name =>
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
  const html = context.renderOwnedArmorMatch(piece);
  assert.match(html, /方案.*\+5超能/);
  assert.match(html, /当前.*\+5近战/);
  assert.match(html, /需更换/);
  assert.equal(piece.item.tuningTo, 'melee', 'rendering must not overwrite physical inventory');
  assert.match(context.renderOwnedArmorMatch({ ...piece, tuningMode: 'plus3' }), /方案.*\+3/);
  assert.doesNotMatch(context.renderOwnedArmorMatch({ ...piece, tuningTo: 'melee' }), /需更换/);
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
