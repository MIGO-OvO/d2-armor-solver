import assert from 'node:assert/strict';
import test from 'node:test';
import {BASE_CONFIGS, STATS} from '../src/core/armor-model.mjs';
import {solveLoadout} from '../src/core/armor-engine.mjs';
import {solveLoadoutAsync, suggestLoadoutAsync} from '../src/core/armor-engine-client.mjs';
import {createSearchSession, withSearchProfile, SearchBudgetExceeded,
  THEORY_FEASIBILITY_LIMITS} from '../src/core/search-session.mjs';
import {assertSolutionConsistency} from '../src/core/solver-v3-contract.mjs';
import {createTargetConstraints} from '../src/core/target-constraints.mjs';
import {rebuildReference, seeded} from './helpers/reference-witness.mjs';

const exact = Object.fromEntries(STATS.map(stat => [stat, true]));
const regression = {target: {health: 0, melee: 100, grenade: 100, super: 100, class: 100, weapons: 100},
  constraints: {exact}, numPlus5: 0, numPlus10: 5, numPlus3: 0};

test('all foreground profiles find the exact target previously missed by Fast', async () => {
  for (const searchProfile of ['fast', 'balanced', 'deep']) {
    const events = [];
    const result = await solveLoadoutAsync({...regression, searchProfile}, {onProgress: result => {
      if (result) events.push(result);
    }});
    assert.equal(result.status, 'EXACT_TARGET_PROVEN', searchProfile);
    assert.deepEqual(result[0].armorTotals, regression.target);
    assertSolutionConsistency(result[0].problemSpec, result[0], regression.target);
    assert.ok(events.some(value => value.status === 'EXACT_TARGET_PROVEN'));
    assert.ok(result.search.firstExactMs !== null);
    if (searchProfile === 'fast') assert.equal(result.length, 1);
  }
});

test('the shared first-feasible phase survives the ordinary Fast deadline but remains bounded', () => {
  let clock = 0;
  const session = createSearchSession({operation: 'solve', profile: 'fast', now: () => clock});
  clock = 250;
  session.checkpoint(1, {phase: 'theory-feasibility'});
  assert.throws(() => session.checkpoint(0), SearchBudgetExceeded);
  const fresh = createSearchSession({operation: 'solve', profile: 'fast', now: () => clock});
  clock += THEORY_FEASIBILITY_LIMITS.maxTimeMs;
  assert.throws(() => fresh.checkpoint(0, {phase: 'theory-feasibility'}), SearchBudgetExceeded);
  const nodes = createSearchSession({operation: 'solve', profile: 'fast', now: () => 0});
  assert.throws(() => nodes.checkpoint(THEORY_FEASIBILITY_LIMITS.maxNodes,
    {phase: 'theory-feasibility'}), SearchBudgetExceeded);
  let deepClock = 0;
  const deep = createSearchSession({operation: 'solve', profile: 'deep', now: () => deepClock});
  deepClock = 4000;
  deep.checkpoint(THEORY_FEASIBILITY_LIMITS.maxNodes, {phase: 'theory-feasibility'});
  deepClock = deep.limits.maxTimeMs;
  assert.throws(() => deep.checkpoint(0, {phase: 'theory-feasibility'}), SearchBudgetExceeded);
});

test('Fast first-feasible search covers rule intervals and visible clamp preimages', async () => {
  const target = {health: 0, melee: 25, grenade: 25, super: 140, class: 35, weapons: 200};
  const payloads = [
    {target, constraints: createTargetConstraints({targetValues: target,
      modes: {melee: '>=', grenade: '>=', class: '>='}})},
    {target: {health: 200, melee: 75, grenade: 125, super: 25, class: 25, weapons: 25},
      fragments: {health: 20}, targetDomain: 'visible', constraints: {exact}},
    {target: {...regression.target, health: 225}, constraints: {exact: {health: true}}},
  ];
  for (const payload of payloads) {
    const result = await solveLoadoutAsync({...regression, ...payload, searchProfile: 'fast'});
    assert.ok(['RULE_FEASIBLE_PROVEN', 'EXACT_TARGET_PROVEN'].includes(result.status), JSON.stringify(payload));
    assertSolutionConsistency(result[0].problemSpec, result[0], result[0].visibleTotals);
    assert.ok(Object.values(result[0].certificate.statResults).every(rule => rule.met));
  }
  const impossible = await solveLoadoutAsync({...regression, target: Object.fromEntries(STATS.map(s => [s, 200])), searchProfile: 'fast'});
  assert.equal(impossible.status, 'SEARCH_LIMIT_REACHED');
  assert.equal(impossible.certificate.proof.complete, false);
});

test('first-feasible search handles generated targets, mixed Balanced counts and fixed Exotics', () => {
  const random = seeded(0x917fe);
  for (let trial = 0; trial < 12; trial++) {
    const config = Array.from({length: 5}, () => BASE_CONFIGS[random(BASE_CONFIGS.length)]);
    const numPlus3 = trial % 6;
    const tuning = config.map((_, index) => index < numPlus3 ? {mode: '+3'}
      : {mode: '+5-5', from: STATS[index], to: STATS[(index + 1) % 6]});
    const mods = config.map((_, index) => ({size: index < 2 ? 5 : 10, stat: STATS[random(6)]}));
    const target = rebuildReference(config, tuning, mods).armor;
    const payload = withSearchProfile('solve', {target, constraints: {exact}, numPlus5: 2,
      numPlus10: 3, numPlus3, searchProfile: 'fast',
      ...(trial >= 6 ? {exoticSettings: {config: config[0]}} : {})});
    // Exceed Fast's normal wall deadline, independently of machine timing.
    let ticks = 0;
    const session = createSearchSession({operation: 'solve', profile: 'fast', now: () => ticks++ ? 250 : 0});
    const result = session.finish(solveLoadout(payload, session));
    assert.equal(result.status, 'EXACT_TARGET_PROVEN', `trial ${trial}`);
    const witness = result[0];
    assert.deepEqual(rebuildReference(witness.config, witness.tuningAssignments,
      STATS.slice(0, 5).map((_, index) => witness.modAssignments[index])).armor, target);
    assertSolutionConsistency(witness.problemSpec, witness, target);
    if (trial >= 6) assert.deepEqual(witness.config[0].baseStats, config[0].baseStats);
  }
});

test('an expired shared budget is never a negative proof and preview keeps its cheap policy', async () => {
  const payload = withSearchProfile('solve', {...regression, searchProfile: 'fast'});
  let calls = 0;
  const session = createSearchSession({operation: 'solve', profile: 'fast', now: () => calls++ ? 4000 : 0});
  const result = session.finish(solveLoadout(payload, session));
  assert.equal(result.status, 'SEARCH_LIMIT_REACHED');
  assert.equal(result.search.termination, 'budget');
  assert.equal(result.certificate.proof.complete, false);
  assert.equal(withSearchProfile('suggest', {}).runtimeOptions.feasibilityFirst, false);
  assert.equal(withSearchProfile('analyzeUpgrade', {}).runtimeOptions.feasibilityFirst, false);
  const preview = await suggestLoadoutAsync(regression);
  assert.equal(preview.search.operation, 'suggest');
  assert.equal(preview.certificate.proof.complete, false);
});
