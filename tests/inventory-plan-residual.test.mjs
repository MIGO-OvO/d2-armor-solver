import assert from 'node:assert/strict';
import test from 'node:test';
import {BASE_CONFIGS, STATS} from '../src/core/armor-model.mjs';
import {rankInventoryPlans} from '../src/core/inventory-plan.mjs';
import {createProblemSpec, sealWitness, verifyWitness, satisfiesConstraintModel} from '../src/core/solver-v3-contract.mjs';

const slots = ['helmet', 'arms', 'chest', 'legs', 'classItem'];
function fixture({destinations = Array(5).fill('melee'), numPlus3 = 0, mods = {}} = {}) {
  const config = [0, 4, 8, 12, 16].map((n, i) => ({...BASE_CONFIGS[n], slot: slots[i]}));
  const tuningAssignments = config.map((_, i) => i < numPlus3 ? {mode: '+3', from: null, to: null}
    : {mode: '+5-5', from: 'health', to: destinations[i]});
  const totals = Object.fromEntries(STATS.map(s => [s, config.reduce((sum, c) => sum + c.baseStats[s], 0)
    + tuningAssignments.reduce((sum, t, i) => sum + (t.mode === '+3' ? Number(config[i].masterworkStats.includes(s))
      : Number(t.to === s) * 5 - Number(t.from === s) * 5), 0)
    + Object.values(mods).reduce((sum, m) => sum + (m.stat === s ? m.size : 0), 0)]));
  const problem = createProblemSpec({target: totals, numPlus3,
    numPlus5: Object.values(mods).filter(m => m.size === 5).length,
    numPlus10: Object.values(mods).filter(m => m.size === 10).length,
    constraints: {exact: Object.fromEntries(STATS.map(s => [s, true]))}});
  const sealed = sealWitness(problem, {config, tuningAssignments, modAssignments: mods, totals, exoticIndex: null});
  assert.equal(sealed.valid, true, sealed.errors.join('; '));
  const items = config.map((c, i) => ({...c, id: `physical-${i}`, archetypeId: c.archetype,
    effectiveBaseStats: {...c.baseStats}, optimizationBaseStats: {...c.baseStats},
    classId: 'hunter', tunedStat: destinations[i], tuningMode: 'shift', tuningTo: destinations[i],
    dataConfidence: {stats: 'known', tuning: 'known'}}));
  return {solution: sealed.witness, items};
}
function checkPlan(plan, count) {
  assert.equal(plan.ownedCount, count);
  assert.equal(plan.farmCount, 5 - count);
  assert.equal(plan.feasible, true);
  assert.ok(plan.matchedSolution, 'ownership must be bound to a newly sealed witness');
  const w = plan.matchedSolution;
  assert.equal(verifyWitness(w.problemSpec, w).valid, true);
  assert.equal(w.certificate.witnessVerification.valid, true);
  assert.equal(satisfiesConstraintModel(w, plan.solution.problemSpec.constraintModel), true);
  assert.deepEqual(w.problemSpec.constraintModel, plan.solution.problemSpec.constraintModel);
  assert.deepEqual(w.problemSpec.budget, plan.solution.problemSpec.budget);
  assert.equal(new Set(w.config.map(c => c.slot)).size, 5);
  assert.equal(w.config.filter(c => c.sourceId || c.id).length, count);
}

test('helmet X imported as arms X increases ownership with a certified slot permutation', () => {
  const {solution, items} = fixture();
  const before = structuredClone(solution);
  const [plan] = rankInventoryPlans({solutions: [solution], items: [{...items[0], slot: 'arms'}], classId: 'hunter'});
  checkPlan(plan, 1);
  assert.equal(plan.pieces.find(p => p.item)?.slot, 'arms');
  assert.deepEqual(solution, before);
});

test('different immutable +5 rolls can exchange assignments between unequal templates', () => {
  const {solution, items} = fixture({destinations: ['melee', 'grenade', 'super', 'class', 'weapons']});
  [items[0].tunedStat, items[1].tunedStat] = [items[1].tunedStat, items[0].tunedStat];
  const [plan] = rankInventoryPlans({solutions: [solution], items, classId: 'hunter'});
  checkPlan(plan, 5);
  for (const c of plan.matchedSolution.config) {
    const i = plan.matchedSolution.config.indexOf(c);
    assert.equal(plan.matchedSolution.tuningAssignments[i].to, c.tunedStat);
  }
});

test('a partial non-template import reoptimizes the remaining farm armor', () => {
  const {solution, items} = fixture();
  const item = {...items[0], slot: 'arms', tunedStat: 'grenade',
    baseStats: {...items[0].baseStats, melee: items[0].baseStats.melee + 5, grenade: items[0].baseStats.grenade - 5}};
  item.effectiveBaseStats = item.optimizationBaseStats = item.baseStats;
  const [plan] = rankInventoryPlans({solutions: [solution], items: [item], classId: 'hunter'});
  checkPlan(plan, 1);
  assert.equal(plan.matchingProof.residualResolve, true);
});

test('residual search preserves Balanced and armor-mod counts while reassigning them', () => {
  const {solution, items} = fixture({numPlus3: 2,
    destinations: ['melee', 'grenade', 'super', 'class', 'weapons'],
    mods: {0: {size: 5, stat: 'grenade'}, 3: {size: 10, stat: 'health'}}});
  [items[2].tunedStat, items[3].tunedStat] = [items[3].tunedStat, items[2].tunedStat];
  const [plan] = rankInventoryPlans({solutions: [solution], items, classId: 'hunter'});
  checkPlan(plan, 5);
  const w = plan.matchedSolution;
  assert.equal(w.tuningAssignments.filter(t => t.mode === '+3').length, 2);
  assert.equal(Object.values(w.modAssignments).filter(m => m?.size === 5).length, 1);
  assert.equal(Object.values(w.modAssignments).filter(m => m?.size === 10).length, 1);
});

test('four-piece and split sets constrain residual ownership, not just badges', () => {
  for (const setRequirement of [{type: 'set', setHash: 111, count: 4}, {type: 'split', a: 111, b: 222}]) {
    const {solution, items} = fixture({destinations: ['melee', 'grenade', 'super', 'class', 'weapons']});
    [items[0].tunedStat, items[1].tunedStat] = [items[1].tunedStat, items[0].tunedStat];
    items.forEach((item, i) => { item.setHash = i < 2 ? 111 : i < 4 ? 222 : null; });
    const [plan] = rankInventoryPlans({solutions: [solution], items, setRequirement});
    checkPlan(plan, setRequirement.type === 'split' ? 5 : 3);
    const w = plan.matchedSolution;
    assert.equal(w.config.filter(c => c.setHash === 111).length >= (setRequirement.type === 'split' ? 2 : 4), true);
    if (setRequirement.type === 'split') assert.equal(w.config.filter(c => c.setHash === 222).length, 2);
  }
});

test('unknown stats/capability, wrong class, and duplicate slots never become five owned pieces', () => {
  for (const mutate of [
    items => { items[0].dataConfidence.stats = 'unknown'; },
    items => { items[0].dataConfidence.tuning = 'unknown'; },
    items => { items[0].classId = 'titan'; },
    items => { items[0].slot = 'arms'; },
  ]) {
    const {solution, items} = fixture();
    mutate(items);
    const [plan] = rankInventoryPlans({solutions: [solution], items, classId: 'hunter'});
    assert.ok(plan.ownedCount <= 4);
    if (plan.feasible) checkPlan(plan, plan.ownedCount);
  }
});

test('a freshly sealed planning witness rejects tampered physical constraints and budget', () => {
  const {solution, items} = fixture();
  const [plan] = rankInventoryPlans({solutions: [solution], items, classId: 'hunter'});
  checkPlan(plan, 5);
  for (const mutate of [
    w => { w.config[0].slot = 'arms'; },
    w => { w.config[0].classId = 'titan'; },
    w => { w.config[0].tunedStat = 'grenade'; },
    w => { w.config[0].baseStats.health++; },
    w => { w.config[0].sourceId = w.config[1].sourceId; },
    w => { w.modAssignments[0] = {size: 10, stat: 'health'}; },
    w => { w.config[0].exotic = true; },
  ]) {
    const w = structuredClone(plan.matchedSolution);
    delete w.canonicalId; // Exercise hard constraints, not only the checksum.
    mutate(w);
    assert.equal(verifyWitness(plan.matchedSolution.problemSpec, w).valid, false);
  }
});

test('a bounded residual miss is not an infeasibility or completeness proof', () => {
  const {solution, items} = fixture();
  items[0].tunedStat = 'grenade';
  const [plan] = rankInventoryPlans({solutions: [solution], items, residualSearchLimits: {maxNodes: 0}});
  assert.equal(plan.matchingProof.complete, false);
  assert.equal(plan.matchingProof.residualSearchLimited, true);
  assert.notEqual(plan.matchedSolution?.certificate.status, 'INFEASIBLE_PROVEN');
});

test('fixed regular Exotic identity/slot and reserved Exotic farming survive re-solving', () => {
  const {solution, items} = fixture({destinations: ['melee', 'grenade', 'super', 'class', 'weapons']});
  const fixedExotic = {slot: 'helmet', classId: 'hunter', hash: 9001, name: 'Pinned Exotic'};
  items[0] = {...items[0], exotic: true, hash: 9001, name: 'Pinned Exotic', allowedTuningStats: [...STATS]};
  [items[1].tunedStat, items[2].tunedStat] = [items[2].tunedStat, items[1].tunedStat];
  const request = {solutions: [solution], items, classId: 'hunter', fixedExotic};
  const [plan] = rankInventoryPlans(request);
  checkPlan(plan, 5);
  const w = plan.matchedSolution;
  assert.equal(w.config.find(c => c.exotic).slot, 'helmet');
  assert.equal(w.config.find(c => c.exotic).hash, 9001);
  const wrong = {...items[0], hash: 9002, name: 'Different Exotic'};
  const [missing] = rankInventoryPlans({...request, items: [wrong, ...items.slice(1)]});
  checkPlan(missing, 4);
  assert.equal(missing.pieces.find(p => p.exotic).item, null);
  const [reserved] = rankInventoryPlans({...request, fixedExotic: {...fixedExotic, reserved: true}});
  checkPlan(reserved, 4);
  assert.equal(reserved.pieces.find(p => p.exotic).farmSetHash, null);
  const unknown = {...items[0], dataConfidence: {stats: 'unknown', tuning: 'unknown'}};
  const [nearMiss] = rankInventoryPlans({...request, items: [unknown, ...items.slice(1)]});
  checkPlan(nearMiss, 4);
  assert.equal(nearMiss.pieces.find(p => p.exotic).closestItem.id, unknown.id,
    'certifying a farm plan must preserve the owned near-miss explanation');
  for (const mutate of [
    candidate => { candidate.config.find(c => c.exotic).hash = 9002; },
    candidate => { candidate.config.find(c => c.exotic).slot = 'arms'; },
  ]) {
    const candidate = structuredClone(w);
    delete candidate.canonicalId;
    mutate(candidate);
    assert.equal(verifyWitness(w.problemSpec, candidate).valid, false);
  }
});

test('Exotic Class Item frame and identity remain pinned while Legendary assignments change', () => {
  const {solution: raw, items} = fixture({destinations: ['melee', 'grenade', 'super', 'class', 'weapons']});
  const config = raw.config.map((c, i) => ({...c, exotic: i === 4}));
  const problem = createProblemSpec({target: raw.totals,
    constraints: {exact: Object.fromEntries(STATS.map(s => [s, true]))},
    exoticSettings: {config: config[4], classId: 'hunter', itemHash: 9003, primaryPerkId: 'left', secondaryPerkId: 'right'}});
  const solution = sealWitness(problem, {...raw, config, exoticIndex: 4, canonicalId: undefined}).witness;
  items[4] = {...items[4], exotic: true, hash: 9003, primaryPerkId: 'left', secondaryPerkId: 'right', allowedTuningStats: [...STATS]};
  [items[0].tunedStat, items[1].tunedStat] = [items[1].tunedStat, items[0].tunedStat];
  const [plan] = rankInventoryPlans({solutions: [solution], items, classId: 'hunter'});
  checkPlan(plan, 5);
  assert.equal(plan.matchedSolution.config[plan.matchedSolution.exoticIndex].slot, 'classItem');
  const [restored] = rankInventoryPlans({solutions: [structuredClone(plan.matchedSolution)], items, classId: 'hunter'});
  checkPlan(restored, 5);
  assert.deepEqual(restored.slotByConfig, plan.slotByConfig,
    're-reading a saved/reoptimized witness must preserve its physical slot mapping');
  const [wrong] = rankInventoryPlans({solutions: [solution], items: items.map((p, i) => i === 4
    ? {...p, primaryPerkId: 'different'} : p), classId: 'hunter'});
  checkPlan(wrong, 4);
  assert.equal(wrong.pieces.find(p => p.exotic).item, null);
});

test('fuzzy rules use original bounds rather than demanding the old preferred totals', () => {
  const {solution: raw, items} = fixture();
  const problem = createProblemSpec({target: raw.totals, constraints: {
    minimums: {health: raw.totals.health}, maximums: {health: raw.totals.health + 10},
    exact: Object.fromEntries(STATS.filter(s => s !== 'health').map(s => [s, true]))}});
  const solution = sealWitness(problem, {...raw, canonicalId: undefined}).witness;
  items[0] = {...items[0], baseStats: {...items[0].baseStats, health: items[0].baseStats.health + 5}};
  items[0].effectiveBaseStats = items[0].optimizationBaseStats = items[0].baseStats;
  const [plan] = rankInventoryPlans({solutions: [solution], items});
  checkPlan(plan, 5);
  assert.equal(plan.matchedSolution.totals.health, raw.totals.health + 5);
  assert.equal(plan.matchedSolution.certificate.status, 'RULE_FEASIBLE_PROVEN');
});

test('non-template inventory roll qualifies by residual re-solve, not old assignment', () => {
  const {solution, items} = fixture();
  // +5 melee/-5 grenade in the physical base compensates for a new immutable
  // +5 grenade roll. The final loadout reaches exactly the original target.
  items[0] = {...items[0], tunedStat: 'grenade', tuningTo: 'grenade',
    baseStats: {...items[0].baseStats, melee: items[0].baseStats.melee + 5, grenade: items[0].baseStats.grenade - 5}};
  items[0].effectiveBaseStats = items[0].optimizationBaseStats = items[0].baseStats;
  const before = structuredClone(solution);
  const [plan] = rankInventoryPlans({solutions: [solution], items, classId: 'hunter'});
  checkPlan(plan, 5);
  assert.deepEqual(plan.matchedSolution.totals, solution.totals);
  assert.deepEqual(solution, before);
});
