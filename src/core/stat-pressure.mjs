import {STATS} from './armor-model.mjs';
import {getUpgradeConfig, getUpgradeTuningCapability} from './upgrade-optimizer.mjs';

// Ordering only: these vectors and fractional resource estimates are NOT
// bounds, assignments, pruning predicates or certificate evidence.
export function pressureVectors(piece, onlyPlus5, balancedCount = null) {
  const config = getUpgradeConfig(piece), cap = getUpgradeTuningCapability(piece, onlyPlus5);
  const base = STATS.map(s => config.baseStats[s]);
  const vectors = onlyPlus5 || balancedCount === 5 ? [] : [base];
  if (cap.allowBalanced && balancedCount !== 0) vectors.push(base.map((v, i) => v + Number(config.masterworkStats.includes(STATS[i]))));
  if (balancedCount !== 5 && piece.dataConfidence?.tuning !== 'unknown') for (const to of cap.allowedDirectionalStats || []) {
    for (const from of STATS) if (from !== to) vectors.push(base.map((v, i) => v + 5 * (Number(STATS[i] === to) - Number(STATS[i] === from))));
  }
  return vectors.length ? vectors : [base];
}

export function createStatPressure(rules, modBudget, onlyPlus5, suffix, balancedCount = null) {
  const capabilities = new Map();
  return (groups, depth, partialMin, partialMax) => {
    if (groups.length < 2) return groups;
    const mid = suffix[depth].min.map((v, i) => (v + suffix[depth].max[i] + partialMin[i] + partialMax[i]) / 2);
    const deficits = rules.map((r, i) => r.armorMinimum === null ? 0 : Math.max(0, r.armorMinimum - mid[i]));
    const total = deficits.reduce((a, b) => a + b, 0);
    const share = total ? Math.min(1, modBudget / total) : 0;
    const weights = rules.map((r, i) => {
      const center = mid[i] + deficits[i] * share;
      const signed = r.armorMinimum !== null && center < r.armorMinimum ? r.armorMinimum - center
        : r.armorMaximum !== null && center > r.armorMaximum ? r.armorMaximum - center : 0;
      const span = Math.max(5, suffix[depth].max[i] - suffix[depth].min[i]);
      // Central half of the envelope has no scarce direction. Do not impose
      // noisy preferences on ordinary balanced targets.
      return Math.sign(signed) * Math.max(0, Math.abs(signed) / span - 0.25);
    });
    const pressured = weights.some(w => w !== 0);
    const score = candidate => {
      if (!pressured) return 0;
      let entry = capabilities.get(candidate.existenceKey);
      if (!entry) {
        const config = getUpgradeConfig(candidate.piece), cap = getUpgradeTuningCapability(candidate.piece, onlyPlus5);
        entry = {base: STATS.map(s => config.baseStats[s]),
          balanced: cap.allowBalanced && balancedCount !== 0 ? config.masterworkStats.map(s => STATS.indexOf(s)) : [],
          destinations: balancedCount === 5 || candidate.piece.dataConfidence?.tuning === 'unknown' ? []
            : (cap.allowedDirectionalStats || []).map(s => STATS.indexOf(s))};
        capabilities.set(candidate.existenceKey, entry);
      }
      // Analytic support of ONE coupled action; equivalent to enumerating
      // pressureVectors, without allocating a vector for every destination.
      let adjustment = onlyPlus5 || balancedCount === 5 ? -Infinity : 0;
      if (entry.balanced.length) adjustment = Math.max(adjustment, entry.balanced.reduce((n, i) => n + weights[i], 0));
      for (const to of entry.destinations) for (let from = 0; from < 6; from++) {
        if (from !== to) adjustment = Math.max(adjustment, 5 * (weights[to] - weights[from]));
      }
      return entry.base.reduce((sum, value, i) => sum + value * weights[i], 0) + (Number.isFinite(adjustment) ? adjustment : 0);
    };
    // Internal keys need code-point order, not locale collation. The first
    // localeCompare costs ~7–10 ms on cold Windows workers (ICU startup).
    return groups.map(group => ({group, score: score(group[0])})).sort((a, b) => b.score - a.score
      || (a.group[0].identity < b.group[0].identity ? -1 : a.group[0].identity > b.group[0].identity ? 1 : 0)).map(x => x.group);
  };
}
