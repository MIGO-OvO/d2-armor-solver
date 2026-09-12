import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {certifiedFeasible, proofPresentation} from '../src/core/solver-presentation.mjs';

const source = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
const extract = name => {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  return start < 0 ? '' : source.slice(start).split(/\n(?:async )?function /)[0];
};

function harness(result) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {textContent: '', disabled: false,
      classList: {add() {}, remove() {}}, setAttribute() {}, querySelector: () => element('loadingText')});
    return elements.get(id);
  };
  const progressStatuses = [];
  const context = vm.createContext({
    certifiedFeasible, proofPresentation, l: (...labels) => labels[0],
    document: {getElementById: element, querySelectorAll: () => []},
    calculatorMode: 'solve', searchProfile: 'balanced', searchUiRevision: 1,
    inventorySolveRevision: 0, lastSearchResult: null, lastInventoryTargets: null,
    lastInventoryRequiredStats: null, lastInventoryResult: null, inventoryResultRevision: 0,
    setRequirement: {type: 'none'}, EXOTIC_CLASSES: {},
    snapshotSetRequirement: () => ({type: 'none'}), sameSetRequirement: () => true,
    getOwnedArmorInputs: () => ({items: [{}]}), getExoticSettings: () => null,
    renderUnifiedResults() {}, escapeHtml: value => value, icon: () => '', t: value => value,
    console,
    solveInventoryParallelAsync: async (_request, {onProgress}) => {
      onProgress(result, {...result.search, running: true});
      progressStatuses.push(element('searchStatus').textContent);
      return result;
    },
  });
  const api = vm.runInContext(`${['searchProofLabel', 'inventoryProofLabel', 'renderSearchStatus',
    'solveInventoryRequirement', 'renderInventoryResults'].map(extract).join('\n')}
    ({renderSearchStatus, solveInventoryRequirement, inventoryProofLabel})`, context);
  return {api, element, progressStatuses, context};
}

const inventory = (status, termination = 'budget') => ({results: [], certificate: {status},
  search: {running: false, termination, elapsedMs: 10, nodes: 42}});

test('theory exact + limited inventory with zero owned loadouts keeps both proof scopes', async () => {
  const owned = inventory('SEARCH_LIMIT_REACHED');
  const {api, element, progressStatuses, context} = harness(owned);
  const theory = Object.assign(Array.from({length: 60}, () => ({
    certificate: {status: 'EXACT_TARGET_PROVEN'}, farmCount: 4,
  })), {certificate: {status: 'EXACT_TARGET_PROVEN'},
    search: {running: false, termination: 'completed', elapsedMs: 767, nodes: 2599940}});
  api.renderSearchStatus(theory);
  const statistics = element('searchStatistics').textContent;
  const message = await api.solveInventoryRequirement({targets: {}, fragments: {}, requiredStats: []});
  assert.deepEqual(progressStatuses, ['精确解 · 已证明']);
  assert.equal(element('searchStatus').textContent, '精确解 · 已证明');
  assert.equal(element('searchStatistics').textContent, statistics);
  assert.equal(context.lastSearchResult, theory);
  assert.equal(context.lastInventoryResult, owned);
  assert.equal(context.lastInventoryResult.results.length, 0);
  assert.match(message, /已有护甲：暂未找到无需刷取的达标组合 · 库存搜索已达到上限/);
  assert.doesNotMatch(element('searchStatus').textContent + message, /未找到达标解|已证明不存在/);
  // The production flow also runs inventory before theory: the retained banner
  // must still be scoped when the 60 theoretical plans finish rendering.
  api.renderSearchStatus(theory);
  assert.doesNotMatch(element('searchStatus').textContent + message, /未找到达标解/);
  assert.equal(theory.length, 60);
});

test('inventory proof is independent of completion, limit and cancellation', () => {
  const {api} = harness(null);
  for (const [termination, ending] of [
    ['completed', '库存搜索已完成'], ['budget', '库存搜索已达到上限'],
    ['cancelled', '库存搜索已取消'],
  ]) {
    for (const status of ['SEARCH_LIMIT_REACHED', 'EXACT_TARGET_PROVEN',
      'RULE_FEASIBLE_PROVEN', 'INFEASIBLE_PROVEN', 'INVALID_INPUT', null]) {
      const label = api.inventoryProofLabel(inventory(status, termination));
      assert.ok(label.startsWith('已有护甲：'));
      assert.ok(label.endsWith(ending));
      assert.equal(label.includes('已证明不存在'), status === 'INFEASIBLE_PROVEN');
      if (['EXACT_TARGET_PROVEN', 'RULE_FEASIBLE_PROVEN'].includes(status)) {
        assert.match(label, /已证明/);
        assert.doesNotMatch(label, /暂未找到/);
      }
    }
  }
  const running = inventory('SEARCH_LIMIT_REACHED');
  assert.match(api.inventoryProofLabel(running, {...running.search, running: true}), /库存搜索进行中$/);
  assert.doesNotMatch(api.inventoryProofLabel({status: 'INFEASIBLE_PROVEN'}), /已证明不存在/);
});
