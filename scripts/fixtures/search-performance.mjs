import {BASE_CONFIGS, STATS} from '../../src/core/armor-model.mjs';
import {rebuildReference, SLOTS} from '../../tests/helpers/reference-witness.mjs';
import {crowdedDimRequest} from '../../tests/helpers/dim-exact-inventory.mjs';

export const cases = ['weapons-200', 'grenade-200', 'melee-200', 'dual-180', 'high-low', 'balanced',
  'duplicates', 'late', 'no-exact', 'fixed-4pc', 'split', 'balanced-tuning', 'directional', 'empty', 'large', 'small', 'reversed'];

export function fixture(name) {
  if (['duplicates', 'fixed-4pc', 'split'].includes(name)) {
    const p = crowdedDimRequest();
    if (name === 'split') {
      p.setRequirement = {type: 'split', a: 101, b: 202};
      p.items = p.items.map(x => ({...x, setHash: x.exotic ? null : ['arms', 'legs'].includes(x.slot) ? 101 : 202}));
    }
    return p;
  }
  const stat = name === 'grenade-200' ? 'grenade' : name === 'melee-200' ? 'melee' : 'weapons';
  const extreme = ['weapons-200', 'grenade-200', 'melee-200', 'high-low', 'dual-180'].includes(name);
  const ranked = [...BASE_CONFIGS].sort((a, b) => b.baseStats[stat] - a.baseStats[stat]
    || (name === 'dual-180' ? b.baseStats.grenade - a.baseStats.grenade : a.baseStats.super - b.baseStats.super));
  const count = name === 'small' ? 1 : name === 'large' ? 260 : 8;
  const items = SLOTS.flatMap((slot, i) => Array.from({length: count}, (_, n) => {
    const config = extreme ? (n % 8 === 7 || count === 1 ? ranked[0] : ranked.at(-1 - n % 7))
      : BASE_CONFIGS[(i * 7 + (n % 8) * 3) % BASE_CONFIGS.length];
    return {...config, id: `${i}-${String(n).padStart(3, '0')}`, hash: i + 1, slot,
      classId: 'hunter', exotic: false, archetypeId: config.archetype,
      baseStats: {...config.baseStats}, effectiveBaseStats: {...config.baseStats}, optimizationBaseStats: {...config.baseStats},
      tunedStat: stat, allowedTuningStats: [stat], masterworkTier: 5,
      tuningMode: 'shift', tuningTo: stat, tuningFrom: 'super', armorModSize: 0,
      dataConfidence: {stats: 'exact', tuning: 'exact', sockets: 'unknown'}};
  }));
  const selected = SLOTS.map(slot => items.filter(x => x.slot === slot)[Math.min(7, count - 1)]);
  const mode = ['balanced-tuning', 'late'].includes(name) ? '+3' : name === 'empty' ? 'none' : '+5-5';
  const tuning = selected.map(() => ({mode, to: stat, from: 'super'}));
  const mods = selected.map((_, i) => ({size: name === 'throughput' ? 0 : 10, stat: name === 'dual-180' && i < 3 ? 'grenade' : stat}));
  const fragments = name === 'high-low' ? {super: -20} : name === 'dual-180' ? {grenade: 25, weapons: -15} : {};
  const targets = rebuildReference(selected, tuning, mods, fragments).visible;
  if (name === 'no-exact') targets.health = 199;
  if (name === 'reversed') items.reverse();
  return {items, targets, fragments, setRequirement: {type: 'none'}, reassignModifiers: name !== 'throughput',
    onlyPlus5Tuning: mode === '+5-5', modifierBudget: {numPlus5: 0, numPlus10: name === 'throughput' ? 0 : 5, numPlus3: mode === '+3' ? 5 : 0},
    maxResults: 1, userConstraints: name === 'throughput' ? {} : {exact: Object.fromEntries(STATS.map(s => [s, true]))}};
}
