import {STATS} from './armor-model.mjs';
import {applyManualUpgradeModifiers, getUpgradeConfig, getUpgradeTuningCapability} from './upgrade-optimizer.mjs';

// Support-function relaxation of the joint tuning/mod domain. A signed pair
// spends the mod budget once, and a directional +5/-5 is one coupled action.
// Ignoring sets/classes between remaining slots enlarges the domain: safe for
// pruning, never a feasibility witness. No monotone "higher is better" rule.
export function createResidualBounds(rows, rules, reassign, onlyPlus5 = false) {
  const terms = rules.flatMap((rule, index) => [
    ...(rule.armorMinimum === null ? [] : [{index, sign: 1, floor: rule.armorMinimum}]),
    ...(rule.armorMaximum === null ? [] : [{index, sign: -1, floor: -rule.armorMaximum}]),
  ]);
  const groups = terms.map(term => [term]);
  for (let a = 0; a < terms.length; a++) for (let b = a + 1; b < terms.length; b++) {
    if (terms[a].index !== terms[b].index) groups.push([terms[a], terms[b]]);
  }
  for (const sign of [1, -1]) {
    const group = terms.filter(term => term.sign === sign);
    if (group.length > 2) groups.push(group);
  }
  const floors = groups.map(group => group.reduce((sum, term) => sum + term.floor, 0));
  const project = vector => groups.map(group => group.reduce((sum, term) => sum + term.sign * vector[term.index], 0));
  const maxima = new Map();
  for (const row of rows) for (const candidate of row.candidates) {
    const piece = candidate.piece;
    const config = getUpgradeConfig(piece);
    const manual = applyManualUpgradeModifiers(config, piece);
    let vectors = [STATS.map(stat => manual[stat])];
    if (reassign) {
      const cap = getUpgradeTuningCapability(piece, onlyPlus5);
      const base = STATS.map(stat => config.baseStats[stat]);
      vectors = [STATS.map(stat => manual[stat] - (piece.armorModStat === stat ? piece.armorModSize || 0 : 0))];
      if (cap.allowBalanced) vectors.push(base.map((value, index) => value + Number(config.masterworkStats.includes(STATS[index]))));
      for (const to of cap.allowedDirectionalStats || []) for (const from of STATS) {
        if (from !== to) vectors.push(base.map((value, index) => value + 5 * (Number(STATS[index] === to) - Number(STATS[index] === from))));
      }
    }
    const projected = vectors.map(project);
    maxima.set(candidate, groups.map((group, index) => Math.max(...projected.map(vector => vector[index]))
      + (reassign ? (piece.armorModSize || 0) * Math.max(...STATS.map((_, stat) => group.find(term => term.index === stat)?.sign || 0)) : 0)));
  }
  const suffix = Array.from({length: rows.length + 1}, () => groups.map(() => 0));
  for (let depth = rows.length - 1; depth >= 0; depth--) {
    suffix[depth] = groups.map((_, index) => suffix[depth + 1][index]
      + Math.max(-Infinity, ...rows[depth].candidates.map(candidate => maxima.get(candidate)[index])));
  }
  const partial = groups.map(() => 0);
  return {
    canReach(depth) { return floors.every((floor, index) => partial[index] + suffix[depth][index] >= floor); },
    add(candidate, direction) { maxima.get(candidate).forEach((value, index) => { partial[index] += direction * value; }); },
    projections: groups.length,
  };
}
