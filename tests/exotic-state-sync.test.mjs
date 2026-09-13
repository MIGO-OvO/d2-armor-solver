import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
const extract = name => source.slice(source.indexOf(`function ${name}(`)).split('\nfunction ')[0];
function state() {
  const elements = Object.fromEntries(['useExoticMode', 'exoticSettingsBody', 'inputCard', 'exoticClass',
    'inventoryExoticSlotFilter', 'inventoryFixedExoticName'].map(id => [id, {
    checked: id === 'useExoticMode', value: id === 'exoticClass' ? 'hunter' : '', style: {}, classList: {toggle() {}},
  }]));
  const context = vm.createContext({document: {getElementById: id => elements[id]}, STATS: [],
    calculatorMode: 'solve', importClassFilter: 'titan', inventoryExoticSlotFilter: '', inventoryFixedExoticKey: '',
    setRequirement: {type: 'set', setHash: 741162535, count: 4},
    invalidateOwnedPlanCache() {}, updateExoticFramework() {}, updateExoticPerkOptions() {},
    renderUpgradeImportPanel() {}, updateInventorySolveOptions() {}, renderInventorySolveOptions() {},
    saveUpgradeDraft() {}, refreshInventoryPlansFromSolutions() {}, getExoticClassItemKey: id => `class-${id}`,
    EXOTIC_CLASSES: {hunter: {}, titan: {}, warlock: {}}});
  return {context, elements};
}

test('enabling Exotic Class Item mode follows the explicitly selected inventory class', () => {
  const {context, elements} = state();
  vm.runInContext(extract('toggleExoticMode'), context);
  context.toggleExoticMode();
  assert.equal(context.importClassFilter, 'titan');
  assert.equal(elements.exoticClass.value, 'titan');
  assert.equal(context.inventoryFixedExoticKey, 'class-titan');
  assert.equal(context.setRequirement.count, 4);
});

test('non-event Exotic synchronization cannot read stale picker values back into state', () => {
  const {context} = state();
  context.inventoryExoticSlotFilter = 'classItem';
  context.inventoryFixedExoticKey = 'class-titan';
  vm.runInContext(extract('toggleExoticMode') + '\n' + extract('updateInventorySolveOptions'), context);
  context.toggleExoticMode({syncInventory: false, refreshInventory: false});
  assert.equal(context.inventoryExoticSlotFilter, 'classItem');
  assert.equal(context.inventoryFixedExoticKey, 'class-titan');
});

test('import-panel rendering never calls the picker change handler or persists a draft', () => {
  const body = extract('renderUpgradeImportPanel');
  assert.doesNotMatch(body.replace(/onchange="[^"]*"/g, ''), /updateInventorySolveOptions\(|saveUpgradeDraft\(/);
});

test('DIM/Bungie imports and passive refresh preserve class and independent set requirements', () => {
  for (const classId of ['titan', 'warlock']) for (const source of ['csv', 'bungie']) for (const passive of [false, true]) {
    const {context, elements} = state();
    const requirement = classId === 'titan' ? {type: 'set', setHash: 741162535, count: 4}
      : {type: 'split', a: 741162535, b: 1507061013};
    Object.assign(context, {importClassFilter: classId, setRequirement: requirement,
      inventoryExoticSlotFilter: 'classItem', inventoryFixedExoticKey: `class-${classId}`,
      importedInventory: [], clearInventoryResults() {}, normalizeInventoryExoticSelection() {},
      detectEquippedClass: () => 'hunter'});
    vm.runInContext(extract('applyImportedInventory'), context);
    context.applyImportedInventory([{classId: 'hunter'}, {classId}], source, {passive});
    assert.equal(context.importClassFilter, classId);
    assert.equal(elements.exoticClass.value, classId);
    assert.equal(context.inventoryFixedExoticKey, `class-${classId}`);
    assert.equal(context.setRequirement, requirement);
  }
});

test('Exotic picker data is a read-only projection even when the selection is stale', () => {
  const {context} = state();
  Object.assign(context, {getFilteredInventoryExotics: () => [], EXOTIC_SLOT_ORDER: ['helmet', 'classItem'],
    EXOTIC_SLOTS: new Set(['helmet']), getExoticClassItemName: id => id, l: text => text,
    inventoryExoticSlotFilter: 'invalid', inventoryFixedExoticKey: 'stale'});
  vm.runInContext(extract('getInventoryExoticPickerData'), context);
  const result = context.getInventoryExoticPickerData();
  assert.equal(result.selectedSlot, '');
  assert.equal(context.inventoryExoticSlotFilter, 'invalid');
  assert.equal(context.inventoryFixedExoticKey, 'stale');
});
