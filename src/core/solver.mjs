import {
  ARCHETYPES, BASE_CONFIGS, STATS,
} from "./armor-model.mjs";

const modifierAllocationCache = new Map();

function getModifierAllocations(numPlus5, numPlus10) {
  const key = `${numPlus5}|${numPlus10}`;
  const cached = modifierAllocationCache.get(key);
  if (cached) return cached;
  const sizes = [
    ...Array(numPlus10).fill(10),
    ...Array(numPlus5).fill(5),
  ];
  let states = new Map([[
    "0,0,0,0,0,0",
    { gains: STATS.map(() => 0), placements: [] },
  ]]);
  for (const size of sizes) {
    const next = new Map();
    for (const state of states.values()) {
      for (let statIndex = 0; statIndex < STATS.length; statIndex++) {
        const gains = [...state.gains];
        gains[statIndex] += size;
        const stateKey = gains.join(",");
        if (!next.has(stateKey)) {
          next.set(stateKey, {
            gains,
            placements: [...state.placements, statIndex],
          });
        }
      }
    }
    states = next;
  }
  const result = { sizes, options: [...states.values()] };
  modifierAllocationCache.set(key, result);
  return result;
}

function chooseBestModifierAllocation(
  totals, target, constraints, numPlus5, numPlus10
) {
  const { sizes, options } = getModifierAllocations(numPlus5, numPlus10);
  let best = null;
  for (const option of options) {
    const finalTotals = Object.fromEntries(STATS.map((stat, index) => [
      stat, totals[stat] + option.gains[index],
    ]));
    const rank = scoreStatsRank(finalTotals, target, constraints);
    if (!best || compareScoreRanks(rank, best.rank) < 0) {
      const modAssignments = {};
      for (let pieceIndex = 0; pieceIndex < 5; pieceIndex++) {
        modAssignments[pieceIndex] = pieceIndex < option.placements.length
          ? { size: sizes[pieceIndex], stat: STATS[option.placements[pieceIndex]] }
          : null;
      }
      best = { totals: finalTotals, modAssignments, rank };
    }
  }
  return best;
}

function chooseGreedyModifierAllocation(
  totals, target, constraints, numPlus5, numPlus10
) {
  const finalTotals = { ...totals };
  const sizes = [
    ...Array(numPlus10).fill(10),
    ...Array(numPlus5).fill(5),
  ];
  const modAssignments = {};
  const hasAdvancedConstraints = (constraints?.priorityOrder?.length || 0) > 0
    || Object.values(constraints?.priorities || {}).some(Boolean)
    || Object.values(constraints?.priorityLevels || {}).some(value => value > 0)
    || Object.values(constraints?.minimums || {}).some(value => value > 0)
    || Object.values(constraints?.maximums || {}).some(value => value !== undefined)
    || Object.values(constraints?.exact || {}).some(Boolean)
    || Object.values(constraints?.le100 || {}).some(Boolean)
    || Object.values(constraints?.force0 || {}).some(Boolean);
  let currentRank = hasAdvancedConstraints
    ? scoreStatsRank(finalTotals, target, constraints)
    : null;
  for (let pieceIndex = 0; pieceIndex < sizes.length; pieceIndex++) {
    const size = sizes[pieceIndex];
    let bestStat = null;
    let bestRank = null;
    let bestImprovement = -Infinity;
    for (const stat of STATS) {
      if (!hasAdvancedConstraints) {
        const oldDifference = finalTotals[stat] - target[stat];
        const newDifference = finalTotals[stat] + size - target[stat];
        const oldPenalty = oldDifference < 0
          ? oldDifference * oldDifference * 3
          : oldDifference * oldDifference;
        const newPenalty = newDifference < 0
          ? newDifference * newDifference * 3
          : newDifference * newDifference;
        const improvement = oldPenalty - newPenalty;
        if (improvement > bestImprovement) {
          bestImprovement = improvement;
          bestStat = stat;
        }
        continue;
      }
      const oldRank = singleStatScoreRank(
        stat, finalTotals[stat], target[stat], constraints
      );
      const newRank = singleStatScoreRank(
        stat, finalTotals[stat] + size, target[stat], constraints
      );
      const rank = currentRank.map((value, index) =>
        value - oldRank[index] + newRank[index]);
      if (!bestRank || compareScoreRanks(rank, bestRank) < 0) {
        bestRank = rank;
        bestStat = stat;
      }
    }
    finalTotals[bestStat] += size;
    if (hasAdvancedConstraints) currentRank = bestRank;
    modAssignments[pieceIndex] = { size, stat: bestStat };
  }
  for (let pieceIndex = sizes.length; pieceIndex < 5; pieceIndex++) {
    modAssignments[pieceIndex] = null;
  }
  return {
    totals: finalTotals,
    modAssignments,
    rank: currentRank || scoreStatsRank(finalTotals, target, constraints),
  };
}

// ============================================================
// EVALUATION: compute deterministic tuning + mods for a config
// ============================================================


// fixedTo pins the +5 side of a tuning mod. On armor you already own, the +5
// stat is rolled with the piece and cannot be re-picked; only the -5 source is
// free. Pass null (the from-scratch solver) to let both sides be chosen.
export function applySingleTuning(totals, target, constraints, forcedFromHits, fixedTo = null) {
  const hasAdvancedConstraints = (constraints?.priorityOrder?.length || 0) > 0 ||
    Object.values(constraints?.priorityLevels || {}).some(v => v > 0) ||
    Object.values(constraints?.minimums || {}).some(v => v > 0) ||
    Object.values(constraints?.maximums || {}).some(v => v !== undefined) ||
    Object.values(constraints?.exact || {}).some(Boolean);
  if (!hasAdvancedConstraints) {
    const hits = { ...forcedFromHits };
    const gaps = {};
    for (const s of STATS) gaps[s] = totals[s] - target[s];
    let fromStat = null;
    for (const s of STATS) {
      if (s === fixedTo) continue;
      if (hits[s] > 0 && gaps[s] > 0) { fromStat = s; hits[s]--; break; }
    }
    if (fromStat === null) {
      let bestExcess = -Infinity;
      fromStat = STATS.find(s => s !== fixedTo);
      for (const s of STATS) {
        if (s === fixedTo) continue;
        const excess = gaps[s];
        const isPriority = constraints?.priorities && constraints.priorities[s];
        const adjustedExcess = isPriority ? excess - 999 : excess;
        if (adjustedExcess > bestExcess ||
            (Math.abs(adjustedExcess - bestExcess) < 0.001 && target[s] < target[fromStat])) {
          bestExcess = adjustedExcess;
          fromStat = s;
        }
      }
    }
    if (fixedTo) return { from: fromStat, to: fixedTo };
    let bestDeficit = Infinity;
    let toStat = null;
    for (const s of STATS) {
      if (s === fromStat) continue;
      const deficit = gaps[s];
      const isPriority = constraints?.priorities && constraints.priorities[s];
      const adjustedDeficit = isPriority ? deficit - 999 : deficit;
      if (toStat === null || adjustedDeficit < bestDeficit ||
          (Math.abs(adjustedDeficit - bestDeficit) < 0.001 &&
           (constraints?.priorities && constraints.priorities[s] && !constraints.priorities[toStat]))) {
        bestDeficit = adjustedDeficit;
        toStat = s;
      }
    }
    return { from: fromStat, to: toStat || STATS.find(s => s !== fromStat) };
  }

  const forcedCandidates = STATS.filter(s => (forcedFromHits[s] || 0) > 0 && totals[s] > target[s]);
  const fromCandidates = (forcedCandidates.length > 0 ? forcedCandidates : STATS)
    .filter(s => s !== fixedTo);
  const toCandidates = fixedTo ? [fixedTo] : STATS;
  let best = null;
  let bestRank = null;
  const currentRank = scoreStatsRank(totals, target, constraints);

  for (const from of fromCandidates) {
    for (const to of toCandidates) {
      if (to === from) continue;
      const oldFromRank = singleStatScoreRank(
        from, totals[from], target[from], constraints
      );
      const newFromRank = singleStatScoreRank(
        from, totals[from] - 5, target[from], constraints
      );
      const oldToRank = singleStatScoreRank(
        to, totals[to], target[to], constraints
      );
      const newToRank = singleStatScoreRank(
        to, totals[to] + 5, target[to], constraints
      );
      const rank = currentRank.map((value, index) =>
        value - oldFromRank[index] + newFromRank[index]
          - oldToRank[index] + newToRank[index]);
      if (!bestRank || compareScoreRanks(rank, bestRank) < 0) {
        bestRank = rank;
        best = { from, to };
      }
    }
  }
  return best || { from: STATS.find(s => s !== fixedTo), to: fixedTo || STATS[1] };
}

// fixedTuningTargets describes armor you already own: a stat id pins a
// Legendary piece's rolled +5 side, null marks +3 mode, and undefined keeps a
// shift piece's +5 side free (Exotic armor). Pass null for fully farmed armor.
export function evaluateConfig(
  baseConfigs, target, numPlus5, numPlus10, numPlus3, constraints,
  fixedTuningTargets = null, runtimeOptions = {}
) {
  const allocateModifiers = !fixedTuningTargets && numPlus5 + numPlus10 <= 2
    ? chooseBestModifierAllocation
    : chooseGreedyModifierAllocation;
  const baseTotals = {};
  for (const s of STATS) baseTotals[s] = 0;
  for (let i = 0; i < 5; i++) {
    for (const s of STATS) baseTotals[s] += baseConfigs[i].baseStats[s];
  }

  const forcedFromHits = {};
  for (const s of STATS) {
    if (target[s] === 0 && baseTotals[s] > 0) {
      forcedFromHits[s] = Math.min(5, Math.ceil(baseTotals[s] / 5));
    }
  }

  const mwStats = [];
  for (let i = 0; i < 5; i++) {
    const p = baseConfigs[i];
    mwStats.push(p.masterworkStats || STATS.filter(
      s => s !== p.primary && s !== p.secondary && s !== p.tertiary
    ));
  }

  let bestOverall = null;
  let bestRank = null;

  // Generate masks with exactly numPlus3 bits set. With fixedTuningTargets the
  // per-piece mode is already known (null entry = that piece runs +3), so the
  // single matching mask is used instead of trying every distribution.
  const masks = [];
  if (fixedTuningTargets) {
    let fixedMask = 0;
    for (let i = 0; i < 5; i++) {
      if (fixedTuningTargets[i] === null) fixedMask |= (1 << i);
    }
    masks.push(fixedMask);
  } else {
    for (let m = 0; m < 32; m++) {
      let bits = 0;
      for (let b = 0; b < 5; b++) if ((m >> b) & 1) bits++;
      if (bits === numPlus3) masks.push(m);
    }
  }
  if (masks.length === 0) masks.push(0);

  for (const mask of masks) {
    const totals = { ...baseTotals };
    const tuningAssignments = [];

    for (let i = 0; i < 5; i++) {
      if ((mask >> i) & 1) {
        for (const s of mwStats[i]) totals[s] += 1;
        tuningAssignments[i] = { mode: '+3', from: null, to: null };
      } else {
        tuningAssignments[i] = null;
      }
    }

    const hitsRemaining = { ...forcedFromHits };
    for (let i = 0; i < 5; i++) {
      if (tuningAssignments[i] !== null) continue;
      const fixedTo = STATS.includes(fixedTuningTargets?.[i])
        ? fixedTuningTargets[i]
        : null;
      const t = applySingleTuning(
        totals, target, constraints, hitsRemaining, fixedTo
      );
      tuningAssignments[i] = { mode: '+5-5', from: t.from, to: t.to };
      totals[t.from] -= 5;
      totals[t.to] += 5;
      if (hitsRemaining[t.from] > 0) hitsRemaining[t.from]--;
    }

    const modifierResult = allocateModifiers(
      totals, target, constraints, numPlus5, numPlus10
    );
    const finalRank = modifierResult.rank;
    const finalScore = scoreStats(modifierResult.totals, target, constraints);
    if (!bestRank || compareScoreRanks(finalRank, bestRank) < 0) {
      bestRank = finalRank;
      bestOverall = {
        totals: { ...modifierResult.totals },
        tuningAssignments: [...tuningAssignments],
        modAssignments: { ...modifierResult.modAssignments },
        rank: [...finalRank],
        score: finalScore,
      };
      if (finalRank.every(value => value === 0)) break;
    }
  }

  // Refinement: try swapping each +5/-5 piece's +5 target to improve score
  const minimums = constraints?.minimums || {};
  const maximums = constraints?.maximums || {};
  const exact = constraints?.exact || {};
  // Hard target constraints must still get a refinement pass when their
  // large penalty pushes the score above the normal near-miss cutoff.
  const hasHardTargetConstraint = Object.values(minimums).some(value => value > 0)
    || Object.values(maximums).some(value => value !== undefined)
    || Object.values(exact).some(Boolean);
  const searchFullTuningNeighborhood = hasHardTargetConstraint
    || (constraints?.priorityOrder?.length || 0) > 0
    || Object.values(constraints?.priorityLevels || {}).some(value => value > 0)
    || Object.values(constraints?.maximums || {}).some(value => value !== undefined);
  if (!runtimeOptions.skipTuningRefinement && bestOverall && bestOverall.score > 0 &&
      (bestOverall.score < 10000 || hasHardTargetConstraint)) {
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < 5; i++) {
        if (bestOverall.tuningAssignments[i].mode !== '+5-5') continue;
        const currentFrom = bestOverall.tuningAssignments[i].from;
        const currentTo = bestOverall.tuningAssignments[i].to;
        // With a pinned +5 (owned armor) only the -5 source can be retried;
        // otherwise both sides of the shift must remain searchable.
        const pinnedTo = STATS.includes(fixedTuningTargets?.[i])
          ? fixedTuningTargets[i]
          : null;
        const variants = pinnedTo
          ? STATS
            .filter(stat => stat !== pinnedTo)
            .map(altFrom => ({ from: altFrom, to: pinnedTo }))
          : searchFullTuningNeighborhood
            ? STATS.flatMap(altFrom => STATS
              .filter(altTo => altTo !== altFrom)
              .map(altTo => ({ from: altFrom, to: altTo })))
            : STATS
              .filter(altTo => altTo !== currentFrom && altTo !== currentTo)
              .map(altTo => ({ from: currentFrom, to: altTo }));
        for (const variant of variants) {
          const altFrom = variant.from;
          const altTo = variant.to;
          // Build trial totals
          const trialTotals = { ...baseTotals };
          // Apply +3 pieces
          for (let j = 0; j < 5; j++) {
            if (bestOverall.tuningAssignments[j].mode === '+3') {
              for (const s of mwStats[j]) trialTotals[s] += 1;
            }
          }
          // Apply all tuning with the swap
          for (let j = 0; j < 5; j++) {
            const t = bestOverall.tuningAssignments[j];
            if (t.mode !== '+5-5') continue;
            if (j === i) {
              trialTotals[altFrom] -= 5;
              trialTotals[altTo] += 5;
            } else {
              trialTotals[t.from] -= 5;
              trialTotals[t.to] += 5;
            }
          }
          const modifierResult = allocateModifiers(
            trialTotals, target, constraints, numPlus5, numPlus10
          );
          const trialRank = modifierResult.rank;
          const trialScore = scoreStats(
            modifierResult.totals, target, constraints
          );
          if (compareScoreRanks(trialRank, bestRank) < 0) {
            bestRank = trialRank;
            bestOverall = {
              totals: { ...modifierResult.totals },
              tuningAssignments: bestOverall.tuningAssignments.map((t2, j) => j === i ? { mode: '+5-5', from: altFrom, to: altTo } : { ...t2 }),
              modAssignments: { ...modifierResult.modAssignments },
              rank: [...trialRank],
              score: trialScore,
            };
            improved = true;
            if (trialRank.every(value => value === 0)) break;
          }
        }
        if (improved) break;
      }
    }
  }

  return bestOverall;
}

export function singlePenalty(actual, target, isPriority, le100, force0, priorityRank = -1, minimum = 0, exact = false, level = 0, maximum = undefined) {
  const diff = actual - target;
  let penalty = diff < 0 ? diff * diff * 3 : diff * diff;
  if (isPriority) penalty *= 50;
  if (priorityRank === 0) penalty *= 1e12;
  else if (priorityRank === 1) penalty *= 1e6;
  if (level === 1) penalty *= 1e12;
  else if (level === 2) penalty *= 1e6;
  else if (level === 3) penalty *= 1e3;
  if (minimum > 0 && actual < minimum) penalty += (minimum - actual) * (minimum - actual) * 1e18;
  if (exact && actual !== target) penalty += (actual - target) * (actual - target) * 1e18;
  // Hard constraints
  if (le100 && actual > 100) penalty += (actual - 100) * (actual - 100) * 500;
  if (maximum !== undefined && actual > maximum) {
    penalty += (actual - maximum) * (actual - maximum) * 1e18;
  }
  if (force0 && actual > 0) penalty += actual * actual * 500;
  return penalty;
}

// Structural score used for every internal optimization decision. Keeping hard
// constraints and priority tiers in separate tuple fields avoids the precision
// loss caused by encoding lexicographic order with 1e18/1e12 multipliers.
// Tuple layout: [bounds, exact, p1, p2, p3, soft] — hard bounds (at-least /
// at-most caps) dominate exact-target matching, which dominates each priority
// tier in turn, then unranked fit and the legacy soft caps (≤100, force →0).
// Bounds must outrank exact: when surplus budget has to be spilled somewhere,
// the "至多/区间上限/必须达标" caps must not be treated as just one more
// squared difference to the target, or the solver happily dumps the surplus
// into the very stat the user asked to cap.
function singleStatScoreRank(stat, actual, target, constraints) {
  const priorities = constraints?.priorities || {};
  const le100 = constraints?.le100 || {};
  const force0 = constraints?.force0 || {};
  const priorityLevels = constraints?.priorityLevels || {};
  const minimums = constraints?.minimums || {};
  const maximums = constraints?.maximums || {};
  const exact = constraints?.exact || {};
  const difference = actual - target;
  let fitPenalty = difference < 0
    ? difference * difference * 3
    : difference * difference;
  if (priorities[stat]) fitPenalty *= 50;
  const level = priorityLevels[stat] || 0;
  const tier = [0, 0, 0];
  let softPenalty = 0;
  if (level >= 1 && level <= 3) tier[level - 1] = fitPenalty;
  else softPenalty = fitPenalty;

  let hardBounds = 0;
  const minimum = minimums[stat] || 0;
  if (minimum > 0 && actual < minimum) {
    hardBounds += (minimum - actual) ** 2;
  }
  const maximum = maximums[stat];
  if (maximum !== undefined && actual > maximum) {
    hardBounds += (actual - maximum) ** 2;
  }
  if (le100[stat] && actual > 100) {
    hardBounds += (actual - 100) ** 2;
  }

  let hardExact = 0;
  if (exact[stat] && actual !== target) hardExact += difference ** 2;
  if (force0[stat] && actual > 0) hardExact += actual * actual;

  return [
    hardBounds,
    hardExact,
    tier[0],
    tier[1],
    tier[2],
    softPenalty,
  ];
}

export function scoreStatsRank(actual, target, constraints) {
  const total = [0, 0, 0, 0, 0, 0];
  for (const stat of STATS) {
    const rank = singleStatScoreRank(
      stat, actual[stat], target[stat], constraints
    );
    for (let index = 0; index < total.length; index++) total[index] += rank[index];
  }
  return total;
}

export function compareScoreRanks(left, right) {
  const length = Math.max(left?.length || 0, right?.length || 0);
  for (let index = 0; index < length; index++) {
    const difference = (left?.[index] || 0) - (right?.[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function scoreStats(actual, target, constraints) {
  let s = 0;
  const p = constraints?.priorities || {};
  const l100 = constraints?.le100 || {};
  const f0 = constraints?.force0 || {};
  const priorityOrder = constraints?.priorityOrder || [];
  const priorityLevels = constraints?.priorityLevels || {};
  const minimums = constraints?.minimums || {};
  const maximums = constraints?.maximums || {};
  const exact = constraints?.exact || {};
  for (const st of STATS) {
    s += singlePenalty(
      actual[st], target[st], p[st], l100[st], f0[st],
      priorityOrder.indexOf(st), minimums[st], exact[st],
      priorityLevels[st] || 0, maximums[st]
    );
  }
  return s;
}


// ============================================================
// SOLUTION FARMABILITY SCORING
// ============================================================

// Get archetype multiset key for dedup (e.g., "壁垒×3,搏击手×2")
export function archetypeKey(config, exoticIndex = null) {
  const freq = {};
  for (let i = 0; i < 5; i++) {
    if (i === exoticIndex) continue;
    const name = config[i].archetype;
    freq[name] = (freq[name] || 0) + 1;
  }
  const purpleKey = Object.entries(freq)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([n, c]) => n + '×' + c).join(',');
  if (exoticIndex === null) return purpleKey;
  return `职业金:${config[exoticIndex].archetype} | 紫装:${purpleKey}`;
}

// Farmability score: lower = easier to farm
// Fewer distinct archetypes = better; 4-1 > 3-2 > 3-1-1 > 2-2-1 > ...
export function farmabilityScore(config, exoticIndex = null) {
  const freq = {};
  for (let i = 0; i < 5; i++) {
    if (i === exoticIndex) continue;
    const name = config[i].archetype;
    freq[name] = (freq[name] || 0) + 1;
  }
  const counts = Object.values(freq).sort((a, b) => b - a);
  if (counts.length === 0) return 0;
  const distinct = counts.length;           // Primary: fewer types
  const maxCount = counts[0];               // Secondary: more concentrated
  // Scoring: distinct has higher weight
  return distinct * 100 - maxCount;
  // 4-1: 2*100-4=196, 3-2: 2*100-3=197, 5-0: 1*100-5=95 (best)
  // 3-1-1: 3*100-3=297, 2-2-1: 3*100-2=298, 2-1-1-1: 4*100-2=398
  // 1-1-1-1-1: 5*100-1=499 (worst)
}

// ============================================================
// SOLVER
// ============================================================

const REFINEMENT_CANDIDATE_LIMIT = 192;
const LOCAL_SEARCH_CANDIDATE_LIMIT = 12;

export function runSolver(target, numPlus5, numPlus10, numPlus3, constraints, exoticSettings = null, runtimeOptions = {}) {
  const solutionMap = new Map();
  const fixedExotic = exoticSettings?.config || null;
  const purpleCount = fixedExotic ? 4 : 5;
  const stagedCandidates = [];

  function storeSolution(bestConfig, bestResult) {
    const exoticIndex = fixedExotic ? 0 : null;
    const key = archetypeKey(bestConfig, exoticIndex);
    const existing = solutionMap.get(key);
    if (existing && compareScoreRanks(bestResult.rank, existing.rank) >= 0) return;
    solutionMap.set(key, {
      config: [...bestConfig],
      tuningAssignments: bestResult.tuningAssignments,
      modAssignments: bestResult.modAssignments,
      totals: bestResult.totals,
      rank: [...bestResult.rank],
      score: bestResult.score,
      exoticIndex,
      exoticSelection: exoticSettings ? {
        classId: exoticSettings.classId,
        classLabel: exoticSettings.classLabel,
        primaryPerkId: exoticSettings.primaryPerkId,
        primaryPerkName: exoticSettings.primaryPerkName,
        secondaryPerkId: exoticSettings.secondaryPerkId,
        secondaryPerkName: exoticSettings.secondaryPerkName,
      } : null,
    });
  }

  function refineAndStore(archIndices, config, initialResult, localSearch) {
    let bestConfig = [...config];
    let bestResult = initialResult || evaluateConfig(
      bestConfig, target, numPlus5, numPlus10, numPlus3, constraints
    );

    // Quick local search over tertiary choices (try swapping one piece's tertiary).
    if (localSearch && !bestResult.rank.every(value => value === 0)) {
      let improved = true;
      while (improved) {
        improved = false;
        for (let i = 0; i < purpleCount; i++) {
          const configIndex = i + (fixedExotic ? 1 : 0);
          const archIdx = archIndices[i];
          for (let t = 0; t < 4; t++) {
            const alt = BASE_CONFIGS[archIdx * 4 + t];
            if (alt === bestConfig[configIndex]) continue;
            const trial = [...bestConfig];
            trial[configIndex] = alt;
            const result = evaluateConfig(
              trial, target, numPlus5, numPlus10, numPlus3, constraints
            );
            if (compareScoreRanks(result.rank, bestResult.rank) < 0) {
              bestConfig = trial;
              bestResult = result;
              improved = true;
              break;
            }
          }
          if (improved) break;
        }
      }
    }
    storeSolution(bestConfig, bestResult);
  }

  function evaluateArchetypeSet(archIndices) {
        // Greedy tertiary assignment. In exotic mode slot 0 is the locked exotic.
        const config = fixedExotic ? [fixedExotic] : [];
        const partialTotals = {};
        for (const s of STATS) partialTotals[s] = 0;
        if (fixedExotic) {
          for (const s of STATS) partialTotals[s] += fixedExotic.baseStats[s];
        }

        for (let i = 0; i < purpleCount; i++) {
          const archIdx = archIndices[i];
          let bestPiece = null, bestAfterRank = null;
          for (let t = 0; t < 4; t++) {
            const piece = BASE_CONFIGS[archIdx * 4 + t];
            const hypo = { ...partialTotals };
            for (const s of STATS) hypo[s] += piece.baseStats[s];
            const completedPieces = i + 1 + (fixedExotic ? 1 : 0);
            const ratio = completedPieces / 5;
            const projectedTarget = Object.fromEntries(STATS.map(stat => [
              stat, target[stat] * ratio,
            ]));
            const projectedConstraints = {
              ...constraints,
              minimums: Object.fromEntries(Object.entries(
                constraints?.minimums || {}
              ).map(([stat, value]) => [stat, value * ratio])),
            };
            const rank = scoreStatsRank(hypo, projectedTarget, projectedConstraints);
            if (!bestAfterRank || compareScoreRanks(rank, bestAfterRank) < 0) {
              bestAfterRank = rank;
              bestPiece = piece;
            }
          }
          config.push(bestPiece);
          for (const s of STATS) partialTotals[s] += bestPiece.baseStats[s];
        }

        const coarseResult = evaluateConfig(
          config, target, numPlus5, numPlus10, numPlus3, constraints, null,
          { skipTuningRefinement: true }
        );
        stagedCandidates.push({
          archIndices: [...archIndices],
          config,
          coarseResult,
        });
  }

  // Enumerate multisets with repetition: 4368 normal, 1365 with one fixed exotic.
  function enumerate(start, depth, indices) {
    if (depth === purpleCount) {
      evaluateArchetypeSet(indices);
      return;
    }
    for (let arch = start; arch < ARCHETYPES.length; arch++) {
      indices.push(arch);
      enumerate(arch, depth + 1, indices);
      indices.pop();
    }
  }
  enumerate(0, 0, []);

  stagedCandidates.sort((left, right) => {
    const rankOrder = compareScoreRanks(
      left.coarseResult.rank, right.coarseResult.rank
    );
    if (rankOrder !== 0) return rankOrder;
    const farmabilityOrder = farmabilityScore(left.config, fixedExotic ? 0 : null)
      - farmabilityScore(right.config, fixedExotic ? 0 : null);
    if (farmabilityOrder !== 0) return farmabilityOrder;
    return left.coarseResult.score - right.coarseResult.score;
  });
  // Preserve every coarse archetype result. Expensive Tuning refinement and
  // tertiary swaps are only useful near the top of the structural ranking.
  for (const candidate of stagedCandidates) {
    storeSolution(candidate.config, candidate.coarseResult);
  }
  const finalists = stagedCandidates.slice(0, REFINEMENT_CANDIDATE_LIMIT);
  for (let index = 0; index < finalists.length; index++) {
    const candidate = finalists[index];
    const isAlreadyPerfect = candidate.coarseResult.rank.every(
      value => value === 0
    );
    const result = isAlreadyPerfect ? candidate.coarseResult : evaluateConfig(
        candidate.config, target, numPlus5, numPlus10, numPlus3, constraints
      );
    refineAndStore(
      candidate.archIndices,
      candidate.config,
      result,
      !runtimeOptions.fastMode && index < LOCAL_SEARCH_CANDIDATE_LIMIT
    );
  }

  const solutions = [...solutionMap.values()];
  solutions.sort((a, b) => {
    const rankOrder = compareScoreRanks(a.rank, b.rank);
    if (rankOrder !== 0) return rankOrder;
    const aF = farmabilityScore(a.config, a.exoticIndex), bF = farmabilityScore(b.config, b.exoticIndex);
    if (aF !== bF) return aF - bF;
    return a.score - b.score;
  });

  // Show all perfect solutions, or top 20 imperfect ones
  const perfectOnes = solutions.filter(solution =>
    solution.rank.every(value => value === 0));
  if (perfectOnes.length > 0) return perfectOnes;
  return solutions.slice(0, 60);
}

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
