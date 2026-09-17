import assert from 'node:assert/strict';
import test from 'node:test';
import {solveInventory} from '../src/core/armor-engine.mjs';
import {createProblemSpec, createRulesetId} from '../src/core/solver-v3-contract.mjs';
import {fixture} from '../scripts/fixtures/search-performance.mjs';
import {residueCompatibleNoWitness} from './helpers/residue-compatible-inventory.mjs';

test('full-vault certificates have bounded identities and small serialized witnesses', () => {
  const result = solveInventory({...fixture('large'), searchLimits: {maxNodes: 1, maxEvaluations: 1, maxTimeMs: 1}});
  assert.equal(result.status, 'EXACT_TARGET_PROVEN');
  assert.ok(result.certificate.proof.rulesetId.length < 200);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 300000, 'do not repeat the vault in proof ids');
  assert.ok(Buffer.byteLength(JSON.stringify(result.results[0])) < 100000, 'saved witness must stay compact');
});

test('proof inputs cannot mutate underneath identity caching; replacements invalidate it', () => {
  const context = {setRequirement: {type: 'none'}};
  const spec = createProblemSpec({inventoryContext: context});
  const first = createRulesetId(spec);
  assert.throws(() => { spec.constraintModel.rules[0].armorMinimum = 199; }, TypeError);
  context.setRequirement.type = 'external-change';
  assert.equal(createRulesetId(spec), first, 'caller-owned inputs are isolated, not frozen');
  spec.budget = {...spec.budget, numPlus10: 4};
  assert.notEqual(createRulesetId(spec), first);
  const changed = createRulesetId(spec);
  spec.operation = 'calculateReachability';
  assert.notEqual(createRulesetId(spec), changed, 'operation participates in cached identity');
});

test('conserved-total negative rejects at the root without claiming a new global proof', () => {
  const result = solveInventory({...residueCompatibleNoWitness(30), searchLimits: {maxNodes: 1, maxEvaluations: 1, maxTimeMs: 1}});
  assert.equal(result.searchStats.exactExistence, 'exhausted');
  assert.equal(result.searchStats.exactStates, 1);
  assert.equal(result.searchStats.exactPrunedTotals, 1);
  assert.equal(result.searchStats.mathEvaluations, 0);
  assert.equal(result.certificate.proof.complete, false);
});
