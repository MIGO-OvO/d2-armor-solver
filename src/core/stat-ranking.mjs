import {STATS} from './armor-model.mjs';

// One rule-quality contract for search, admissible bounds and presentation.
// [any unmet, high count/gap, medium count/gap, low count/gap, ordinary count/gap]
// The first component is a BOOLEAN, never a count across priority tiers.
export const STAT_RANK_LENGTH = 9;
export const emptyStatRank = () => [0, 0, 0, 0, 0, 0, 0, 0, 0];
export function normalizeStatRank(rank) {
  // Implicit preferred targets must not outrank actual rule feasibility.
  rank[0] = Number(rank[0] > 0);
  return rank;
}

export function statRuleGap(stat, actual, target, constraints = {}) {
  const minimum = constraints.minimums?.[stat];
  const maximum = constraints.maximums?.[stat];
  let low = minimum ?? (maximum === undefined && !constraints.force0?.[stat] && !constraints.le100?.[stat] ? target : -Infinity);
  let high = maximum ?? Infinity;
  if (constraints.exact?.[stat]) { low = Math.max(low, target); high = Math.min(high, target); }
  if (constraints.force0?.[stat]) { low = Math.max(low, 0); high = Math.min(high, 0); }
  if (constraints.le100?.[stat]) high = Math.min(high, 100);
  return Math.max(0, low - actual) + Math.max(0, actual - high);
}

export function rankStatRule(stat, actual, target, constraints = {}) {
  const order = constraints.priorityOrder?.indexOf(stat) ?? -1;
  const level = constraints.priorityLevels?.[stat]
    || (order >= 0 ? Math.min(3, order + 1) : constraints.priorities?.[stat] ? 1 : 0);
  const index = level >= 1 && level <= 3 ? 1 + (level - 1) * 2 : 7;
  const gap = statRuleGap(stat, actual, target, constraints);
  const rank = emptyStatRank();
  const explicit = constraints.exact?.[stat] || constraints.force0?.[stat] || constraints.le100?.[stat]
    || constraints.minimums?.[stat] !== undefined || constraints.maximums?.[stat] !== undefined;
  rank[0] = Number(Boolean(explicit) && gap > 0);
  rank[index] = Number(gap > 0);
  rank[index + 1] = gap;
  return normalizeStatRank(rank);
}

export function rankStatRules(actual, target, constraints = {}) {
  const total = emptyStatRank();
  for (const stat of STATS) {
    const gap = statRuleGap(stat, actual[stat], target[stat], constraints);
    if (!gap) continue;
    const order = constraints.priorityOrder?.indexOf(stat) ?? -1;
    const level = constraints.priorityLevels?.[stat]
      || (order >= 0 ? Math.min(3, order + 1) : constraints.priorities?.[stat] ? 1 : 0);
    const index = level >= 1 && level <= 3 ? 1 + (level - 1) * 2 : 7;
    total[index]++;
    total[index + 1] += gap;
    if (constraints.exact?.[stat] || constraints.force0?.[stat] || constraints.le100?.[stat]
        || constraints.minimums?.[stat] !== undefined || constraints.maximums?.[stat] !== undefined) total[0] = 1;
  }
  return total;
}

export function visibleRankingConstraints(constraints = {}, fragments = {}) {
  const convert = values => Object.fromEntries(Object.entries(values || {}).map(([stat, value]) =>
    [stat, Math.max(0, Math.min(200, Number(value) + (fragments[stat] || 0)))]));
  return {...constraints, minimums: convert(constraints.minimums), maximums: convert(constraints.maximums)};
}
