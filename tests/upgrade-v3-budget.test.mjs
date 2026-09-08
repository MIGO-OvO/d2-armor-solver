import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeUpgrade, solveLoadout } from '../src/core/armor-engine.mjs';
import { getUpgradeConfig, normalizeUpgradePiece } from '../src/core/upgrade-optimizer.mjs';
import { createSearchSession, withSearchProfile } from '../src/core/search-session.mjs';
import { STATS } from '../src/core/armor-model.mjs';
import { visibleConstraintsToArmor } from '../src/core/target-constraints.mjs';

test('bounded Upgrade reaches the same farmable target as Scratch while retaining a fixed Exotic', () => {
  const targets = { health: 0, melee: 35, grenade: 200, super: 100, class: 15, weapons: 150 };
  const fragments = { health: 0, melee: 10, grenade: 0, super: 0, class: -10, weapons: 0 };
  const constraints = { exact: Object.fromEntries(STATS.map(stat => [stat, true])) };
  const pieces = ['helmet', 'arms', 'chest', 'legs', 'classItem'].map((slot, index) => normalizeUpgradePiece({
    slot, sourceId: `owned-${slot}`, archetypeId: 'Gunner', tertiary: index === 1 ? 'super' : 'class',
    tuningMode: 'shift', tuningFrom: 'health', tuningTo: index < 4 ? 'super' : 'grenade',
    armorModSize: 10, armorModStat: 'grenade', exotic: index === 1, locked: index === 1,
    allowedTuningStats: index === 1 ? [...STATS] : undefined,
  }, index));
  const scratch = solveLoadout({ target: targets, fragments, targetDomain: 'visible', constraints,
    numPlus5: 0, numPlus10: 5, numPlus3: 0 });
  assert.equal(scratch.certificate.status, 'EXACT_TARGET_PROVEN');
  // Use the user's Deep profile so slower CI hosts do not turn this regression
  // into a hardware-speed assertion. Production still honors the same limits.
  const session = createSearchSession({ operation: 'analyzeUpgrade', generation: 1, profile: 'deep' });
  const result = session.finish(analyzeUpgrade(withSearchProfile('analyzeUpgrade', {
    searchProfile: 'deep', pieces, targets, fragments,
    constraints: visibleConstraintsToArmor(targets, fragments, constraints),
    reassignModifiers: true, onlyPlus5Tuning: true,
  }), session));
  assert.equal(result.certificate.status, 'EXACT_TARGET_PROVEN');
  assert.deepEqual(result.plan.evaluation.finalTotals, targets);
  assert.equal(result.plan.pieces[1].sourceId, pieces[1].sourceId);
  assert.equal(result.plan.pieces[1].exotic, true);
  assert.deepEqual(result.plan.pieces[1].baseStats, getUpgradeConfig(pieces[1]).baseStats);
  assert.equal(result.plan.replacements.some(entry => entry.slotIndex === 1), false);
  assert.equal(result.certificate.witnessVerification.valid, true);
  assert.ok(result.search.firstExactMs !== null, 'publish a verified exact plan before returning');
  if (result.plan.replacementProof?.minimal) {
    assert.equal(result.plan.replacementProof.complete, true);
  }
});
