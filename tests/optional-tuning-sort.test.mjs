import assert from 'node:assert/strict';
import test from 'node:test';
import { solveLoadout } from '../src/core/armor-engine.mjs';
import { farmabilityScore } from '../src/core/solver.mjs';
import { getTuningCost } from '../src/core/tuning-domain.mjs';

test('equally farmable exact theoretical solutions prefer fewer installed tuning mods', () => {
  const target = {health: 100, melee: 100, grenade: 100, super: 100, class: 50, weapons: 50};
  const solutions = solveLoadout({target, numPlus5: 0, numPlus10: 5, numPlus3: 0});
  assert.ok(solutions.length > 1);
  assert.equal(solutions.status, 'EXACT_TARGET_PROVEN');
  for (let index = 1; index < solutions.length; index++) {
    const previous = solutions[index - 1], current = solutions[index];
    const farmOrder = farmabilityScore(previous.config, previous.exoticIndex) - farmabilityScore(current.config, current.exoticIndex);
    assert.ok(farmOrder <= 0);
    if (!farmOrder) assert.ok(getTuningCost(previous.tuningAssignments).installedCount
      <= getTuningCost(current.tuningAssignments).installedCount);
  }
});
