import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
test('infeasible five-owned theory cannot generate a DIM export', async () => {
  let exports = 0;
  const messages = {innerHTML: ''};
  const entry = {kind: 'theory', farmCount: 0, feasible: false, witness: {},
    pieces: Array.from({length: 5}, (_, i) => ({slot: String(i), item: {sourceId: String(i + 1), hash: i + 1}}))};
  const context = vm.createContext({resolveUnifiedEntry: () => entry,
    document: {getElementById: () => messages}, icon: () => '', l: (_a, _b, en) => en,
    assertSolutionConsistency: () => {}, getDimLoadoutExport: () => { exports++; return {url: 'bad'}; },
    copyText: async () => {}, renderDimExportMessage: () => {}, importSource: 'dim'});
  vm.runInContext(source.slice(source.indexOf('async function exportInventorySolution('))
    .split('\nasync function ')[0], context);
  await context.exportInventorySolution(0);
  assert.equal(exports, 0);
  assert.match(messages.innerHTML, /feasible|verified/i);
});

test('the DIM button requires both no farming and verified feasibility', () => {
  const expression = source.match(/const canExport = (.*);/)[1];
  for (const [farmCount, feasible, expected] of [[0, false, false], [0, true, true], [1, true, false], [0, undefined, false]]) {
    assert.equal(vm.runInNewContext(expression, {entry: {kind: 'theory', farmCount, feasible}}), expected);
  }
});

test('the command bar also disables DIM for an infeasible five-owned theory', () => {
  const button = {};
  const context = vm.createContext({getSelectedUnifiedEntry: () => ({kind: 'theory', farmCount: 0, feasible: false}),
    document: {getElementById: id => id === 'cmdExportDim' ? button : null}, l: (_a, _b, en) => en});
  vm.runInContext(source.slice(source.indexOf('function syncCommandBarActions(')).split('\nfunction ')[0], context);
  context.syncCommandBarActions();
  assert.equal(button.disabled, true);
  assert.match(button.title, /not verified feasible/);
});
