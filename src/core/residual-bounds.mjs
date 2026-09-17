import {STATS} from './armor-model.mjs';
import {applyManualUpgradeModifiers, getUpgradeConfig, getUpgradeTuningCapability} from './upgrade-optimizer.mjs';

// Support-function relaxation of the joint tuning/mod domain. A signed pair
// spends the mod budget once, and a directional +5/-5 is one coupled action.
// Ignoring sets/classes between remaining slots enlarges the domain: safe for
// pruning, never a feasibility witness. No monotone "higher is better" rule.
export function createResidualBounds(rows, rules, reassign, onlyPlus5 = false, globalModBudget = null) {
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
  // Explicit/automatic budgets belong to the whole build, not installed pieces.
  // Dropping forced negative mod contributions is a conservative relaxation.
  const modSupport = groups.map(group => reassign && globalModBudget !== null
    ? globalModBudget * Math.max(0, ...group.map(term => term.sign)) : 0);
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
      // The +5/-5-only switch excludes Balanced, not an empty socket.
      vectors.push(base);
      if (cap.allowBalanced) vectors.push(base.map((value, index) => value + Number(config.masterworkStats.includes(STATS[index]))));
      for (const to of cap.allowedDirectionalStats || []) for (const from of STATS) {
        if (from !== to) vectors.push(base.map((value, index) => value + 5 * (Number(STATS[index] === to) - Number(STATS[index] === from))));
      }
    }
    const projected = vectors.map(project);
    maxima.set(candidate, groups.map((group, index) => Math.max(...projected.map(vector => vector[index]))
      + (reassign && globalModBudget === null ? (piece.armorModSize || 0) * Math.max(...STATS.map((_, stat) => group.find(term => term.index === stat)?.sign || 0)) : 0)));
  }
  const suffix = Array.from({length: rows.length + 1}, () => groups.map(() => 0));
  for (let depth = rows.length - 1; depth >= 0; depth--) {
    suffix[depth] = groups.map((_, index) => suffix[depth + 1][index]
      + Math.max(-Infinity, ...rows[depth].candidates.map(candidate => maxima.get(candidate)[index])));
  }
  const partial = groups.map(() => 0);
  return {
    canReach(depth) { return floors.every((floor, index) => partial[index] + suffix[depth][index] + modSupport[index] >= floor); },
    add(candidate, direction) { maxima.get(candidate).forEach((value, index) => { partial[index] += direction * value; }); },
    projections: groups.length,
  };
}

// Directional tuning and stat mods are multiples of five. Balanced tuning
// contributes +1 on the three masterwork stats. Retain the reachable residues
// of entire suffixes, not independent per-stat ranges. Dropping an oversized
// suffix table means "unknown", never "unreachable"; memory is bounded without
// truncating the search domain. Clamp intervals are deliberately not indexed.
export function createInventoryResidueBounds(rows, rules, onlyPlus5) {
  const indexes = rules.flatMap((rule, index) => rule.armorMinimum !== null
    && rule.armorMinimum === rule.armorMaximum ? [index] : []);
  if (!indexes.length) return null;
  const mod = value => ((value % 5) + 5) % 5;
  const encode = vector => vector.join(',');
  const target = indexes.map(index => mod(rules[index].armorMinimum));
  const zero = indexes.map(() => 0);
  const variants = new Map();
  for (const row of rows) for (const candidate of row) {
    const config = getUpgradeConfig(candidate.piece);
    const base = indexes.map(index => config.baseStats[STATS[index]]);
    if (!base.every(Number.isSafeInteger)) return null;
    const options = [base.map(mod)];
    if (getUpgradeTuningCapability(candidate.piece, onlyPlus5).allowBalanced) {
      options.push(base.map((value, i) => mod(value + Number(config.masterworkStats.includes(STATS[indexes[i]])))));
    }
    variants.set(candidate, options);
  }
  const combine = (left, right) => {
    const out = new Map();
    for (const a of left) for (const b of right) {
      const vector = a.map((value, i) => mod(value + b[i]));
      out.set(encode(vector), vector);
      if (out.size > 4096) return null;
    }
    return [...out.values()];
  };
  const suffix = Array(rows.length + 1);
  suffix[rows.length] = [zero];
  for (let depth = rows.length - 1; depth >= 0; depth--) {
    const choices = new Map(rows[depth].flatMap(candidate => variants.get(candidate).map(vector => [encode(vector), vector])));
    suffix[depth] = suffix[depth + 1] && combine([...choices.values()], suffix[depth + 1]);
  }
  const keys = suffix.map(vectors => vectors && new Set(vectors.map(encode)));
  const prefix = [[zero]];
  return {
    push(candidate) { prefix.push(combine(prefix.at(-1), variants.get(candidate))); },
    pop() { prefix.pop(); },
    canReach(depth) {
      return !keys[depth] || prefix.at(-1).some(vector =>
        keys[depth].has(encode(target.map((value, i) => mod(value - vector[i])))));
    },
  };
}
