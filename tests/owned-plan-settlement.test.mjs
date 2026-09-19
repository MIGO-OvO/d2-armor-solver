import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

import {createProblemSpec, createRulesetId} from "../src/core/solver-v3-contract.mjs";
import {createOwnedPlanCache, isOwnedPlanSettled} from "../src/core/owned-plan-cache.mjs";

// Ownership settlement is decided by `matchingProof.complete` only. A plan
// whose ownership search finished stays settled even when the alternative-plan
// residual search was truncated; a truncated ownership search is provisional,
// usable for the immediate UI but never final.
test('ownership settlement follows matchingProof.complete, not residual truncation', () => {
  assert.equal(isOwnedPlanSettled(null), true);
  assert.equal(isOwnedPlanSettled({}), true);
  assert.equal(isOwnedPlanSettled({matchingProof: {complete: true}}), true);
  assert.equal(isOwnedPlanSettled({matchingProof: {
    scope: 'source-macro-equivalence', complete: true, residualSearchLimited: true}}), true,
  'a truncated alternative-plan search must not demote a completed macro proof');
  assert.equal(isOwnedPlanSettled({matchingProof: {
    complete: false, macroSearchLimited: true, macroSearchLimitReason: 'solution-nodes'}}), false);
});

test('a provisional plan is retried once and then replaced by the settled result', async () => {
  let calls = 0;
  const cache = createOwnedPlanCache({calculate: async request => {
    calls++;
    const settled = calls > 1;
    return request.solutions.map((_, index) => ({
      sourceIndex: index,
      evaluation: calls,
      matchingProof: settled
        ? {scope: 'source-macro-equivalence', complete: true}
        : {complete: false, macroSearchLimited: true},
    }));
  }});
  const request = {solutions: [{id: 'A'}]};
  const keys = ['key-a'];
  await cache.ensure(request, keys);
  assert.equal(cache.isSettled('key-a'), false, 'a truncated search is provisional');
  assert.equal(cache.peek('key-a').matchingProof.complete, false);

  // A plain batch request keeps showing the provisional result.
  await cache.ensure(request, keys);
  assert.equal(calls, 1, 'a provisional entry still serves the list');

  // The foreground retry treats it as missing and replaces the entry.
  await cache.revalidate(request, keys);
  assert.equal(calls, 2);
  assert.equal(cache.isSettled('key-a'), true);
  assert.equal(cache.peek('key-a').matchingProof.complete, true);
  assert.equal(cache.peek('key-a').evaluation, 2, 'the cache entry was replaced');

  // A settled entry is never recalculated again.
  await cache.revalidate(request, keys);
  assert.equal(calls, 2);
});

const source = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
const retrySlice = source.slice(source.indexOf('let ownedPlanRevision ='),
  source.indexOf('async function refreshInventoryPlansFromSolutions('));

function createRetryState(planForCall) {
  return vm.createContext({
    calculatorMode: 'solve', importClassFilter: 'hunter', inventoryExoticSlotFilter: '', inventoryFixedExoticKey: '',
    document: {getElementById: () => ({checked: false, setAttribute: () => {}})},
    snapshotSetRequirement: () => ({type: 'none'}), createCanonicalId: () => 'same-five-pieces', createRulesetId,
    createOwnedArmorPlanRequest: (solutions, maxResults) => ({solutions, maxResults}),
    allSolutions: [], searchUiRevision: 0, console,
    createOwnedPlanCache, rankInventoryPlansAsync: planForCall,
    requestAnimationFrame: () => 1,
  });
}

const flushAsync = () => new Promise(resolve => setTimeout(resolve, 0));

test('reading a provisional plan schedules one dedicated foreground retry', async () => {
  let calls = 0;
  const state = createRetryState(async request => {
    calls++;
    const settled = calls > 1;
    return request.solutions.map((_, index) => ({
      sourceIndex: index,
      evaluation: calls,
      matchingProof: settled ? {complete: true} : {complete: false, macroSearchLimited: true},
    }));
  });
  vm.runInContext(retrySlice, state);
  const solution = {problemSpec: createProblemSpec({target: {health: 100}})};

  await state.ensureOwnedArmorPlans([solution]);
  assert.equal(state.getOwnedArmorPlan(solution, {schedule: false}).matchingProof.complete, false);

  // Rendering the plan schedules the retry without blocking the read.
  const provisional = state.getOwnedArmorPlan(solution);
  assert.equal(provisional.matchingProof.complete, false, 'the provisional plan renders immediately');
  await flushAsync();
  assert.equal(calls, 2, 'exactly one dedicated retry was issued');

  const settled = state.getOwnedArmorPlan(solution, {schedule: false});
  assert.equal(settled.matchingProof.complete, true, 'the settled result replaced the cache entry');
  assert.equal(settled.evaluation, 2);

  // No render/retry loop: further reads and batch requests do not recalculate.
  state.getOwnedArmorPlan(solution);
  await state.ensureOwnedArmorPlans([solution]);
  await state.ensureOwnedArmorPlanSettled(solution);
  await flushAsync();
  assert.equal(calls, 2);
});

test('a permanently provisional plan is retried at most once per input revision', async () => {
  let calls = 0;
  const state = createRetryState(async request => {
    calls++;
    return request.solutions.map((_, index) => ({
      sourceIndex: index, evaluation: calls,
      matchingProof: {complete: false, macroSearchLimited: true, macroSearchLimitReason: 'solution-nodes'},
    }));
  });
  vm.runInContext(retrySlice, state);
  const solution = {problemSpec: createProblemSpec({target: {health: 100}})};
  await state.ensureOwnedArmorPlans([solution]);
  assert.equal(calls, 1);

  await state.ensureOwnedArmorPlanSettled(solution);
  assert.equal(calls, 2, 'the automatic retry gets its own budget');
  // Still provisional: the guard must stop any further automatic attempt.
  await state.ensureOwnedArmorPlanSettled(solution);
  state.getOwnedArmorPlan(solution);
  await flushAsync();
  assert.equal(calls, 2, 'no render/retry loop');

  // New inputs re-arm the retry.
  state.invalidateOwnedPlanCache();
  await state.ensureOwnedArmorPlans([solution]);
  await state.ensureOwnedArmorPlanSettled(solution);
  assert.equal(calls, 4, 'a new revision allows one more retry');
});

test('the incomplete-search notice follows the settled state', () => {
  const functions = ['isPlanSearchIncomplete', 'renderPlanSearchIncompleteNote'].map(name =>
    source.slice(source.indexOf(`function ${name}(`)).split('\nfunction ')[0]);
  const context = vm.createContext({l: (...labels) => labels[0], isOwnedPlanSettled});
  vm.runInContext(functions.join('\n'), context);
  const theoryEntry = proof => ({kind: 'theory', farmCount: 2, plan: {matchingProof: proof}});

  assert.match(context.renderPlanSearchIncompleteNote(
    theoryEntry({complete: false, macroSearchLimited: true})), /搜索未完成/);
  assert.equal(context.renderPlanSearchIncompleteNote(
    theoryEntry({scope: 'source-macro-equivalence', complete: true, residualSearchLimited: true})), '',
  'a truncated alternative-plan search is not an incomplete ownership search');
  assert.equal(context.renderPlanSearchIncompleteNote(
    theoryEntry({scope: 'source-macro-equivalence', complete: true})), '');
  assert.equal(context.renderPlanSearchIncompleteNote(
    {...theoryEntry({complete: false}), farmCount: 0}), '',
  'a fully owned plan is trivially minimal');
  assert.equal(context.renderPlanSearchIncompleteNote(
    {kind: 'inventory', farmCount: 3, plan: {matchingProof: {complete: false}}}), '');
});
