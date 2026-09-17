import assert from 'node:assert/strict';
import test from 'node:test';
import { BASE_CONFIGS, STATS } from '../src/core/armor-model.mjs';
import { findBestFixedConfigWitness, findFixedTargetWitness, findFixedRuleWitness } from '../src/core/exact-target-oracle.mjs';

const empty = () => ({mode: 'none', from: null, to: null});
const compare = (left, right) => {
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
};
const tuningKey = tuning => `${tuning.mode}:${tuning.from}:${tuning.to}`;
const modKey = mod => mod ? `${mod.size}:${mod.stat}` : 'none';

test('zero through five empty sockets agree with finite independent assignment and socket-cost enumeration', () => {
  let seed = 90217;
  const random = maximum => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % maximum; };
  for (let emptyCount = 0; emptyCount <= 5; emptyCount++) {
    const configs = Array.from({length: 5}, () => BASE_CONFIGS[random(BASE_CONFIGS.length)]);
    const destinations = configs.map(() => STATS[random(6)]);
    const capability = destinations.map(to => ({allowBalanced: false, allowedDirectionalStats: [to]}));
    const source = destinations.map((to, index) => index < emptyCount ? empty()
      : {mode: '+5-5', from: STATS[(STATS.indexOf(to) + 1 + random(5)) % 6], to});
    const current = [...source.slice(1), source[0]];
    const n5 = emptyCount % 2;
    const currentMods = Object.fromEntries(configs.map((_, index) => [index,
      n5 && index === 3 ? {size: 5, stat: 'weapons'} : null]));
    const base = Object.fromEntries(STATS.map(stat => [stat, configs.reduce((sum, config) => sum + config.baseStats[stat], 0)]));
    const target = {...base};
    for (const tuning of source) if (tuning.mode === '+5-5') { target[tuning.from] -= 5; target[tuning.to] += 5; }
    if (n5) target.weapons += 5;
    const choices = destinations.map(to => [empty(), ...STATS.filter(from => from !== to)
      .map(from => ({mode: '+5-5', from, to}))]);
    let expected = null;
    const picked = [];
    const totals = {...base};
    const inspect = () => {
      const tuningChanges = picked.reduce((sum, tuning, index) => sum + Number(tuningKey(tuning) !== tuningKey(current[index])), 0);
      const installed = picked.filter(tuning => tuning.mode !== 'none').length;
      for (const slot of n5 ? [0, 1, 2, 3, 4] : [-1]) for (const stat of n5 ? STATS : [null]) {
        if (n5) totals[stat] += 5;
        const quality = STATS.reduce((sum, name) => sum + Math.abs(totals[name] - target[name]), 0);
        let changes = tuningChanges;
        for (let index = 0; index < 5; index++) changes += Number(modKey(index === slot ? {size: 5, stat} : null) !== modKey(currentMods[index]));
        const tuple = [quality, installed, changes];
        if (!expected || compare(tuple, expected) < 0) expected = tuple;
        if (n5) totals[stat] -= 5;
      }
    };
    const visit = index => {
      if (index === 5) return inspect();
      for (const tuning of choices[index]) {
        picked[index] = tuning;
        if (tuning.mode !== 'none') { totals[tuning.from] -= 5; totals[tuning.to] += 5; }
        visit(index + 1);
        if (tuning.mode !== 'none') { totals[tuning.from] += 5; totals[tuning.to] -= 5; }
      }
    };
    visit(0);
    const input = {configs, target, tuningCapabilities: capability, numPlus5: n5, numPlus10: 0, numPlus3: 0};
    const actual = findBestFixedConfigWitness({...input, currentTuningAssignments: current, currentModAssignments: currentMods,
      rankTotals: values => STATS.reduce((sum, stat) => sum + Math.abs(values[stat] - target[stat]), 0), compareRanks: (a, b) => a - b});
    assert.deepEqual([actual.rank, actual.tuningCost.installedCount, actual.socketChangeCount], expected, `empty source slots=${emptyCount}`);
    for (const point of [findFixedTargetWitness(input), findFixedRuleWitness({...input,
      minimums: STATS.map(stat => target[stat]), maximums: STATS.map(stat => target[stat])})]) {
      assert.ok(point);
      assert.equal(point.tuningCost.installedCount, expected[1]);
      assert.deepEqual(point.totals, target);
    }
  }
});
