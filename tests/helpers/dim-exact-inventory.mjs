import {readFileSync} from 'node:fs';
import {normalizeDimItem} from '../../src/core/dim-csv.mjs';
import {STATS} from '../../src/core/armor-model.mjs';

export const dimExactFixture = JSON.parse(readFileSync(new URL('../fixtures/dim-mask-of-fealty.json', import.meta.url)));
export function crowdedDimRequest() {
  const base = dimExactFixture.records.map(normalizeDimItem).filter(p => dimExactFixture.builds[1].includes(p.id));
  // The real DIM witness is unchanged. Class-item decoys have +1 weapons/-1
  // super, unrepairable by directional tuning and 5/10 mods. The smaller row
  // is visited first, exhausting the old Balanced budget on repeated math.
  const items = base.flatMap(p => [p, ...Array.from({length: p.slot === 'classItem' ? 14 : 15}, (_, k) => {
    const delta = Number(p.slot === 'classItem');
    const perturb = stats => ({...stats, weapons: stats.weapons + delta, super: stats.super - delta});
    return {...p, id: `a-${p.id}-${k}`, effectiveBaseStats: perturb(p.effectiveBaseStats),
      optimizationBaseStats: perturb(p.optimizationBaseStats)};
  })]);
  return {...dimExactFixture, items, reassignModifiers: true, onlyPlus5Tuning: true, maxResults: 1,
    userConstraints: {exact: Object.fromEntries(STATS.map(s => [s, true]))}};
}
