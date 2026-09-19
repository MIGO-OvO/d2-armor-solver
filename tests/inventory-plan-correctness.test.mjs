import assert from 'node:assert/strict';
import test from 'node:test';
import {rankInventoryPlans} from '../src/core/inventory-plan.mjs';
import {verifyWitness} from '../src/core/solver-v3-contract.mjs';
import {verifyMacroEquivalent} from '../src/core/plan-equivalence.mjs';
import {MACRO_SLOTS, buildMacroSolution, buildVaultPiece, assertMacroOwnedPlan} from './helpers/macro-fixtures.mjs';

const pairs = [['Bulwark', 'melee'], ['Bulwark', 'grenade'], ['Specialist', 'super'],
  ['Specialist', 'health'], ['Brawler', 'weapons']];
const unlimited = {maxNodesPerSolution: null, maxNodesPerBatch: null,
  maxTimeMsPerSolution: null, maxTimeMsPerBatch: null};
const bag = mods => Object.values(mods).filter(Boolean).map(m => `${m.size}:${m.stat}`).sort();
function fixture(mods = {}) {
  return {
    solution: buildMacroSolution({pairs, tuning: pairs.map(() => ({mode: 'none'})), mods}),
    items: pairs.map(([archetypeId, tertiary], index) => ({
      ...buildVaultPiece({slot: MACRO_SLOTS[index], archetypeId, tertiary, id: `copy-${index}`, setHash: 111}),
      tuningInstalled: false, armorModSize: mods[index]?.size || 0, armorModStat: mods[index]?.stat || null,
    })),
  };
}
for (const [name, values] of [
  ['duplicate x2', [10, 10]], ['duplicate x3', [5, 5, 5]], ['mixed duplicates', [10, 10, 5, 5]],
]) {
  test(`macro Armor Mod multiset preserves ${name}`, () => {
    const mods = Object.fromEntries(values.map((size, i) => [i, {size, stat: size === 10 ? 'grenade' : 'super'}]));
    const {solution, items} = fixture(mods);
    const plans = rankInventoryPlans({solutions: [solution], items, classId: 'hunter',
      residualSearchLimits: {maxNodes: 0}, macroSearchLimits: {maxTimeMsPerBatch: null}});
    const witness = assertMacroOwnedPlan(plans[0], solution);
    assert.deepEqual(bag(witness.modAssignments), bag(solution.modAssignments));
    assert.equal(witness.certificate.status, 'EXACT_TARGET_PROVEN');
    assert.deepEqual(witness.problemSpec.budget, solution.problemSpec.budget);
    assert.equal(plans[0].assignmentCost.armorModCount, values.length);
    assert.equal(plans[0].assignmentCost.armorModPoints, values.reduce((a, b) => a + b, 0));
    assert.ok(plans.macroDiagnostics.certifications <= 3);
  });
}

for (const withSet of [false, true]) {
  test(`certified four-owned beats an infeasible five-owned skeleton (set=${withSet})`, () => {
    const {items} = fixture();
    const solution = buildMacroSolution({pairs,
      tuning: pairs.map(() => ({mode: '+5-5', from: 'health', to: 'melee'}))});
    for (const item of items) { item.tunedStat = 'melee'; item.tuningTo = 'melee'; }
    // Legacy tuningTo passes template matching; the explicit physical
    // capability list cannot host it. The V3 boundary rejects that skeleton.
    delete items[0].tunedStat;
    items[0].allowedTuningStats = [];
    const options = {solutions: [solution], items, classId: 'hunter',
      ...(withSet ? {setRequirement: {type: 'set', setHash: 111, count: 4}} : {}),
      residualSearchLimits: {maxNodes: 100, maxTimeMs: null}};
    const [skeleton] = rankInventoryPlans({...options, macroSearchLimits: {maxNodesPerSolution: 0}});
    assert.equal(skeleton.ownedCount, 5);
    assert.equal(skeleton.feasible, false);
    const [plan] = rankInventoryPlans({...options, macroSearchLimits: {maxTimeMsPerBatch: null}});
    assertMacroOwnedPlan(plan, solution, {expectedFarm: 1});
    assert.equal(plan.pieces.filter(p => p.item).length, 4);
    assert.equal(plan.matchedSolution.certificate.status, 'EXACT_TARGET_PROVEN');
    if (withSet) assert.ok(plan.matchedSolution.config.filter(p => p.setHash === 111).length >= 4);
  });
}

test('all null macro budgets mean unlimited', () => {
  const {solution, items} = fixture();
  const plans = rankInventoryPlans({solutions: [solution], items, classId: 'hunter',
    residualSearchLimits: {maxNodes: 0}, macroSearchLimits: unlimited});
  assertMacroOwnedPlan(plans[0], solution);
  assert.equal(plans.macroDiagnostics.solutionsLimited, 0);
});

test('budget interruption retains a certified incumbent without claiming optimality', () => {
  const {solution} = fixture({0: {size: 10, stat: 'grenade'}});
  const items = MACRO_SLOTS.flatMap(slot => pairs.map(([archetypeId, tertiary]) => ({
    ...buildVaultPiece({slot, archetypeId, tertiary}), tuningInstalled: false,
  })));
  const plans = rankInventoryPlans({solutions: [solution], items, classId: 'hunter',
    residualSearchLimits: {maxNodes: 0}, macroSearchLimits: {...unlimited, maxNodesPerSolution: 100}});
  const [plan] = plans;
  assert.equal(plan.feasible, true);
  assert.equal(plan.ownedCount, 5);
  assert.equal(plan.matchingProof.scope, 'source-macro-equivalence');
  assert.equal(plan.matchingProof.complete, false);
  assert.equal(plan.matchingProof.macroSearchLimited, true);
  assert.equal(plan.matchingProof.macroSearchLimitReason, 'solution-nodes');
  assert.equal(plan.matchedSolution.certificate.status, 'EXACT_TARGET_PROVEN');
  assert.equal(verifyWitness(plan.matchedSolution.problemSpec, plan.matchedSolution).valid, true);
  assert.equal(verifyMacroEquivalent(solution, plan.matchedSolution), true);
  assert.deepEqual(plan.matchedSolution.totals, solution.totals);
  assert.ok(plans.macroDiagnostics.certifications >= 1 && plans.macroDiagnostics.certifications <= 3);
});

test('macro compression preserves the cheaper installed-mod representative', () => {
  const {solution, items} = fixture({0: {size: 10, stat: 'grenade'}});
  const installed = {...items[0], id: 'z-installed'};
  items[0] = {...items[0], id: 'a-empty', armorModSize: 0, armorModStat: null};
  const plans = rankInventoryPlans({solutions: [solution], items: [...items, installed], classId: 'hunter',
    residualSearchLimits: {maxNodes: 0}, macroSearchLimits: unlimited});
  assertMacroOwnedPlan(plans[0], solution);
  assert.equal(plans[0].pieces.find(p => p.slot === 'helmet').item.id, 'z-installed');
  assert.equal(plans[0].assignmentCost.changedSocketCount, 0);
  assert.ok(plans.macroDiagnostics.certifications <= 3);
});
