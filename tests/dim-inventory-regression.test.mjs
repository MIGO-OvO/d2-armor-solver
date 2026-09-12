import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {normalizeDimItem} from '../src/core/dim-csv.mjs';
import {solveInventory} from '../src/core/armor-engine.mjs';
import {STATS} from '../src/core/armor-model.mjs';
import {assertSolutionConsistency} from '../src/core/solver-v3-contract.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/dim-mask-of-fealty.json', import.meta.url), 'utf8'));
const items = fixture.records.map(normalizeDimItem);
const request = {
  items, targets: fixture.targets, fragments: fixture.fragments,
  setRequirement: fixture.setRequirement, fixedExotic: fixture.fixedExotic,
  reassignModifiers: true, onlyPlus5Tuning: true,
  userConstraints: {exact: Object.fromEntries(STATS.map(stat => [stat, true]))},
};
const buildKey = ids => [...ids].sort().join('|');

test('reported DIM inventory recovers BOTH physical exact builds without altering installed mods', () => {
  const before = structuredClone(items);
  const result = solveInventory(request);
  const exact = result.results.filter(entry => entry.status === 'EXACT_TARGET_PROVEN');
  assert.deepEqual(exact.map(entry => buildKey(entry.pieces.map(piece => piece.sourceId))).sort(),
    fixture.builds.map(buildKey).sort());
  for (const entry of exact) {
    assertSolutionConsistency(entry.problemSpec, entry, fixture.targets);
    assert.deepEqual(entry.finalTotals, fixture.targets);
    assert.equal(entry.pieces.filter(piece => piece.setHash === fixture.setRequirement.setHash).length, 4);
    assert.equal(entry.pieces[0].hash, fixture.fixedExotic.hash);
    assert.equal(Object.values(entry.modAssignments).filter(mod => mod?.size === 10).length, 5);
  }
  assert.deepEqual(items, before);
});

test('automatic inventory stat mods are independent of the CSV-installed count', () => {
  const bare = items.filter(item => fixture.builds[1].includes(item.id))
    .map(item => ({...item, armorModSize: 0, armorModStat: null}));
  const result = solveInventory({...request, items: bare});
  assert.equal(result.status, 'EXACT_TARGET_PROVEN');
  assert.deepEqual(result.results[0].finalTotals, fixture.targets);
});

test('fixed ordinary Exotic is a search constraint, not a post-search matching hint', () => {
  const impostor = {...items[0], id: 'other-exotic', hash: 12345, name: 'Different Exotic'};
  const result = solveInventory({...request, items: [impostor, ...items.slice(1)]});
  assert.equal(result.results.length, 0);
  assert.notEqual(result.status, 'EXACT_TARGET_PROVEN');
  assert.equal(result.examined, 0, 'exclude other Exotics before enumeration');
});

test('explicit inventory budgets override installed mods and preserve the requested Balanced count', () => {
  const bare = items.filter(item => fixture.builds[1].includes(item.id))
    .map(item => ({...item, armorModSize: 0, armorModStat: null}));
  const result = solveInventory({...request, items: bare,
    modifierBudget: {numPlus5: 0, numPlus10: 5, numPlus3: 0}});
  assert.equal(result.status, 'EXACT_TARGET_PROVEN');
  assert.equal(Object.values(result.results[0].modAssignments).filter(mod => mod?.size === 10).length, 5);
  assert.ok(result.results[0].tuningAssignments.every(tuning => tuning.mode !== '+3'));
  const fixed = solveInventory({...request, items: bare, autoStatMods: false});
  assert.notEqual(fixed.status, 'EXACT_TARGET_PROVEN', 'legacy installed-budget mode remains available');
});

test('large zero-installed-mod inventory is not pruned by installed-budget bounds', () => {
  const bare = items.filter(item => fixture.builds[1].includes(item.id))
    .map(item => ({...item, armorModSize: 0, armorModStat: null}));
  const large = bare.flatMap(item => Array.from({length: 6}, (_, index) => ({...item, id: `${item.id}-${index}`})));
  const result = solveInventory({...request, items: large, maxResults: 1});
  assert.equal(result.status, 'EXACT_TARGET_PROVEN');
  assert.deepEqual(result.results[0].visibleTotals, fixture.targets);
  assert.ok(result.searchStats.jointProjections > 0);
});

// --- Mathematical vs installable totals on a math-only import ---------------
// DIM CSV carries the exact roll but no socket/energy metadata, so the execution
// preflight can never be VERIFIED. It must report UNVERIFIED — never BLOCKED, and
// never by deducting the planned stat/tuning mods from the plan's numbers.

test("both reported exact builds stay mathematically exact and merely UNVERIFIED to execute", () => {
  const result = solveInventory(request);
  const exact = result.results.filter(entry => entry.status === 'EXACT_TARGET_PROVEN');
  assert.equal(exact.length, fixture.builds.length);
  for (const entry of exact) {
    // The certificate's mathematical domain is authoritative for the six bars.
    assert.deepEqual(entry.finalTotals, fixture.targets);
    assert.deepEqual(entry.visibleTotals, fixture.targets);
    for (const stat of STATS) {
      assert.equal(entry.certificate.statResults[stat].met, true, `${stat} must be met to the certificate`);
      assert.equal(entry.certificate.statResults[stat].actual, fixture.targets[stat],
        `${stat} certificate actual must equal the target, not an installable shortfall`);
    }
    assert.equal(entry.certificate.status, 'EXACT_TARGET_PROVEN');
  }
});

test("unknown DIM socket metadata yields UNVERIFIED execution, never BLOCKED", () => {
  const result = solveInventory(request);
  for (const entry of result.results) {
    assert.equal(entry.executionStatus, 'UNVERIFIED',
      'a math-only import cannot be BLOCKED: the socket objects are absent, not disproven');
    assert.equal(entry.certificate.executionStatus, 'UNVERIFIED');
    assert.deepEqual(entry.execution.unassignedMods, [],
      'no mod may be reported as uninstallable without socket evidence');
    assert.ok(entry.execution.unverifiedMods.some(mod => mod.reason === 'socketCapabilityUnknown'),
      'the export gap itself must be surfaced as unverified');
    assert.ok(Object.values(entry.modAssignments).filter(mod => mod?.size === 10).length > 0,
      'the planned armor mods are still part of the plan');
  }
});

test("installable totals are never allowed to drive the certificate", () => {
  const result = solveInventory(request);
  const entry = result.results[0];
  // The instance-level numbers legitimately differ (the fixture armor is not all
  // masterworked), which is precisely why they must not feed the six-bar view.
  assert.notDeepEqual(entry.execution.actualTotals, entry.armorTotals);
  assert.deepEqual(entry.execution.projectedTotals, entry.armorTotals,
    'projected totals are the execution bridge back to the solver arithmetic');
  assert.equal(entry.execution.unassignedMods.some(mod => mod.reason === 'witnessTotalsMismatch'), false,
    'mathematical != installable is not a witness failure');
});
