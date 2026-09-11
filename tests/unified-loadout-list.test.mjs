import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

import { solveLoadout } from '../src/core/armor-engine.mjs';

// The unified list projects two different result shapes (inventory witnesses and
// theoretical owned/farm skeletons) into one entry. Its ordering and identity
// are pure functions, so they are extracted and exercised directly.
const source = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
const context = vm.createContext({
  // `normalizeTheoryPlan` asks the sealed witness whether the six stats satisfy
  // the rules; the physical owned/farm + set mapping is a separate question.
  certifiedFeasible: () => true,
});
vm.runInContext([
  'compareRankTuples',
  'unifiedPieceIdentity',
  'unifiedEntryKey',
  'compareUnifiedEntries',
  'normalizeTheoryPlan',
].map(name => source.slice(source.indexOf(`function ${name}(`)).split('\nfunction ')[0]).join('\n'), context);

function entry(overrides) {
  return {
    feasible: false, exact: false, ownedCount: 0, farmCount: 0,
    rank: [0, 0, 0, 0, 0, 0], farmability: 0, pieces: [], ...overrides,
  };
}

test('the unified list ranks a qualifying plan ahead of a fully owned near-miss', () => {
  const qualifyingPartial = entry({feasible: true, ownedCount: 2, farmCount: 3});
  const nearMissComplete = entry({feasible: false, ownedCount: 5, farmCount: 0});
  assert.ok(context.compareUnifiedEntries(qualifyingPartial, nearMissComplete) < 0,
    '达标 must outrank owned completeness');
  assert.ok(context.compareUnifiedEntries(nearMissComplete, qualifyingPartial) > 0);
});

test('the unified list prefers exact matches, then fuller owned armor', () => {
  const base = entry({feasible: true, ownedCount: 3, farmCount: 2});
  assert.ok(context.compareUnifiedEntries(entry({...base, exact: true}), base) < 0,
    'an exact match must outrank a rule-feasible one');
  assert.ok(context.compareUnifiedEntries(entry({...base, ownedCount: 4, farmCount: 1}), base) < 0,
    'a fuller owned set must outrank a thinner one at equal feasibility');
});

test('the unified dedup key separates owned instances from farm gaps', () => {
  const owned = context.unifiedEntryKey({pieces: [
    {slot: 'helmet', sourceId: 'a'}, {slot: 'arms', sourceId: 'b'},
  ]});
  const farmed = context.unifiedEntryKey({pieces: [
    {slot: 'helmet', farmSetHash: 7, archetype: 'X', tertiary: 'melee'}, {slot: 'arms', sourceId: 'b'},
  ]});
  assert.notEqual(owned, farmed, 'a farmed skeleton is not the same plan as an owned loadout');
  assert.equal(owned, context.unifiedEntryKey({pieces: [
    {slot: 'arms', sourceId: 'b'}, {slot: 'helmet', sourceId: 'a'},
  ]}), 'piece order must not change the identity');
});

// Regression: a theoretical witness can satisfy every stat rule while the
// owned/farm + set mapping still cannot reach it (plan.feasible === false).
// The unified list used to count such a plan as 达标 and rank it above real,
// implementable loadouts. Both conditions must hold.
test('a rule-feasible but unmappable theory plan is never qualifying', () => {
  const witness = {certificate: {status: 'EXACT_TARGET_PROVEN'}, rank: [0, 0]};
  const mappable = context.normalizeTheoryPlan({feasible: true, solution: witness, pieces: [], ownedCount: 3, farmCount: 2});
  assert.equal(mappable.ruleFeasible, true);
  assert.equal(mappable.planFeasible, true);
  assert.equal(mappable.feasible, true);

  const unmappable = context.normalizeTheoryPlan({feasible: false, solution: witness, pieces: [], ownedCount: 5, farmCount: 0});
  assert.equal(unmappable.ruleFeasible, true, 'the witness itself still proves the stat rules');
  assert.equal(unmappable.planFeasible, false);
  assert.equal(unmappable.feasible, false, 'property-feasible must not survive an unmappable plan');
  assert.equal(unmappable.exact, true, 'rule exactness is a property of the witness math');

  const missingFlag = context.normalizeTheoryPlan({solution: witness, pieces: [], ownedCount: 5, farmCount: 0});
  assert.equal(missingFlag.feasible, false, 'an absent plan.feasible is not a pass');

  assert.ok(context.compareUnifiedEntries(mappable, unmappable) < 0,
    'a mappable plan must outrank an unmappable one even with less owned armor');
  assert.equal(context.normalizeTheoryPlan({pieces: []}), null, 'a plan without a witness is not an entry');
});

// Regression: a proven fuzzy rule set used to return only [provenBest], so the
// Deep profile collapsed its plan list to a single loadout the moment any rule
// was not exact. Every verified rule-satisfying candidate must survive.
test('a proven fuzzy rule set keeps every rule-satisfying plan', { timeout: 300000 }, () => {
  const target = {health: 20, melee: 80, grenade: 80, super: 50, class: 100, weapons: 180};
  // The target violates `super <= 40`, so the exact branch is skipped and the
  // global fuzzy proof runs.
  const constraints = {minimums: {super: 0}, maximums: {super: 40}};
  const solutions = solveLoadout({
    target, numPlus5: 0, numPlus10: 0, numPlus3: 0, constraints, targetDomain: 'visible',
    runtimeOptions: {proveFuzzy: true},
  });
  assert.ok(solutions.length > 1,
    'a proven fuzzy search must not collapse the plan list to one witness');
  for (const solution of solutions) {
    assert.ok((solution.visibleTotals?.super ?? Number.POSITIVE_INFINITY) <= 40,
      'every retained witness must satisfy the bound rule');
    assert.equal(solution.certificate?.status, 'RULE_FEASIBLE_PROVEN');
  }
});
