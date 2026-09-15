import {BASE_CONFIGS, STATS} from '../../src/core/armor-model.mjs';
import {SLOTS, seeded} from './reference-witness.mjs';

// Mod-5 residue pruning cannot reject this domain. Every base weapons total
// is 25 mod 10, and five mandatory directional tunings add 25: the result is
// 0 mod 10, never the requested 95. Broad per-stat bounds overlap the target.
export function residueCompatibleNoWitness(groups = 12) {
  const random = seeded(0x421d);
  const items = SLOTS.flatMap((slot, index) => Array.from({length: groups}, (_, n) => {
    const config = BASE_CONFIGS[(index * groups + n) % BASE_CONFIGS.length];
    const baseStats = Object.fromEntries(STATS.map(s => [s, 5 + 10 * random(3)]));
    return {...config, id: `${slot}-${n}`, slot, hash: index + 1, classId: 'hunter', exotic: false,
      archetypeId: config.archetype, baseStats, effectiveBaseStats: baseStats, optimizationBaseStats: baseStats,
      masterworkTier: 5, tunedStat: 'weapons', allowedTuningStats: ['weapons'],
      tuningMode: 'shift', tuningTo: 'weapons', tuningFrom: 'super', armorModSize: 0,
      dataConfidence: {stats: 'exact', tuning: 'exact', sockets: 'unknown'}};
  }));
  return {items, targets: {...Object.fromEntries(STATS.map(s => [s, 75])), weapons: 95},
    fragments: {}, reassignModifiers: true, onlyPlus5Tuning: true,
    modifierBudget: {numPlus5: 0, numPlus10: 0, numPlus3: 0}, maxResults: 1,
    setRequirement: {type: 'none'}, userConstraints: {exact: Object.fromEntries(STATS.map(s => [s, true]))}};
}
