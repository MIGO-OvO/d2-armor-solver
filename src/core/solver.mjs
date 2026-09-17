import {
  ARCHETYPES, BASE_CONFIGS, STATS,
} from "./armor-model.mjs";
import {
  findBestFixedConfigWitness,
  findBestGlobalWitness,
  findExactTargetWitnesses,
  findExactPartialConfigWitnesses,
  visibleArmorTargets,
} from "./exact-target-oracle.mjs";
import {
  createCanonicalId,
  createProofEvidence,
  getArmorSolverInput,
  satisfiesConstraintModel,
  compareIntegerTuples,
} from "./solver-v3-contract.mjs";
import {emptyStatRank, normalizeStatRank, rankStatRule, rankStatRules} from './stat-ranking.mjs';
import {getTuningCost, compareTuningCosts} from './tuning-domain.mjs';

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

function chooseGreedyModifierAllocation(totals, target, constraints, numPlus5, numPlus10) {
  const finalTotals = {...totals};
  const sizes = [...Array(numPlus10).fill(10), ...Array(numPlus5).fill(5)];
  const modAssignments = {};
  for (let index = 0; index < sizes.length; index++) {
    let bestStat = null, bestRank = null;
    for (const stat of STATS) {
      const rank = scoreStatsRank({...finalTotals, [stat]: finalTotals[stat] + sizes[index]}, target, constraints);
      if (!bestRank || compareScoreRanks(rank, bestRank) < 0) { bestStat = stat; bestRank = rank; }
    }
    finalTotals[bestStat] += sizes[index];
    modAssignments[index] = {size: sizes[index], stat: bestStat};
  }
  for (let index = sizes.length; index < 5; index++) modAssignments[index] = null;
  return {totals: finalTotals, modAssignments, rank: scoreStatsRank(finalTotals, target, constraints)};
}

// ============================================================
// EVALUATION: compute deterministic tuning + mods for a config
// ============================================================


// fixedTo pins the +5 side of a tuning mod. On armor you already own, the +5
// stat is rolled with the piece and cannot be re-picked; only the -5 source is
// free. Pass null (the from-scratch solver) to let both sides be chosen.
export function applySingleTuning(totals, target, constraints, _forcedFromHits, fixedTo = null) {
  const allowedTargets = Array.isArray(fixedTo) ? fixedTo.filter(stat => STATS.includes(stat))
    : STATS.includes(fixedTo) ? [fixedTo] : STATS;
  let best = null, bestRank = null;
  for (const to of allowedTargets) for (const from of STATS) {
    if (from === to) continue;
    const rank = scoreStatsRank({...totals, [from]: totals[from] - 5, [to]: totals[to] + 5}, target, constraints);
    if (!bestRank || compareScoreRanks(rank, bestRank) < 0) { best = {from, to}; bestRank = rank; }
  }
  return best;
}

// fixedTuningTargets preserves the legacy fixed-assignment API. New callers
// pass runtimeOptions.tuningCapabilities to enumerate Balanced and every legal
// directional destination independently from the piece's current assignment.
export function evaluateConfig(
  baseConfigs, target, numPlus5, numPlus10, numPlus3, constraints,
  fixedTuningTargets = null, runtimeOptions = {}
) {
  const tuningCapabilities = Array.isArray(runtimeOptions.tuningCapabilities)
    ? runtimeOptions.tuningCapabilities
    : null;
  if (!runtimeOptions.skipExactJointSearch) {
    const exactEvaluation = findBestFixedConfigWitness({
      configs: baseConfigs,
      target,
      numPlus5,
      numPlus10,
      numPlus3,
      requiredNumPlus3: runtimeOptions.numPlus3 ?? (tuningCapabilities ? null : numPlus3),
      fixedTuningTargets,
      tuningCapabilities,
      rankTotals: totals => scoreStatsRank(totals, target, constraints),
      compareRanks: compareScoreRanks,
      checkpoint: runtimeOptions.checkpoint,
    });
    if (exactEvaluation) {
      return {
        ...exactEvaluation,
        score: scoreStats(exactEvaluation.totals, target, constraints),
      };
    }
  }

  const allocateModifiers = !fixedTuningTargets && !tuningCapabilities
      && numPlus5 + numPlus10 <= 2
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
  if (tuningCapabilities) {
    for (let mask = 0; mask < 32; mask++) {
      if (Number.isInteger(runtimeOptions.numPlus3)
          && mask.toString(2).replaceAll('0', '').length !== runtimeOptions.numPlus3) continue;
      const allowed = tuningCapabilities.every((capability, index) => {
        const balanced = Boolean((mask >> index) & 1);
        return balanced
          ? capability?.allowBalanced !== false
          : capability?.allowNone !== false || Array.isArray(capability?.allowedDirectionalStats)
            && capability.allowedDirectionalStats.some(stat => STATS.includes(stat));
      });
      if (allowed) masks.push(mask);
    }
  } else if (fixedTuningTargets) {
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
  if (masks.length === 0) {
    if (tuningCapabilities) return null;
    masks.push(0);
  }

  const equivalentMasks = new Set();
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

    // Same Balanced contribution and ordered remaining capabilities produce
    // the same greedy search and neighborhood. Keep its first representative.
    const maskKey = STATS.map(stat => totals[stat]).join(",") + "|" + tuningAssignments
      .flatMap((assignment, index) => assignment ? [] : [tuningCapabilities
        ? tuningCapabilities[index].allowedDirectionalStats?.join(",")
        : fixedTuningTargets?.[index] || "*"]).join(";");
    if (equivalentMasks.has(maskKey)) continue;
    equivalentMasks.add(maskKey);
    const hitsRemaining = { ...forcedFromHits };
    for (let i = 0; i < 5; i++) {
      if (tuningAssignments[i] !== null) continue;
      const fixedTo = tuningCapabilities
        ? tuningCapabilities[i].allowedDirectionalStats || []
        : STATS.includes(fixedTuningTargets?.[i])
          ? fixedTuningTargets[i]
          : null;
      const t = applySingleTuning(
        totals, target, constraints, hitsRemaining, fixedTo
      );
      const allowNone = tuningCapabilities?.[i]?.allowNone !== false;
      if (!t || allowNone && compareScoreRanks(scoreStatsRank(totals, target, constraints),
        scoreStatsRank({...totals, [t.from]: totals[t.from] - 5, [t.to]: totals[t.to] + 5}, target, constraints)) <= 0) {
        tuningAssignments[i] = {mode: 'none', from: null, to: null};
        continue;
      }
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
    const qualityOrder = bestRank ? compareScoreRanks(finalRank, bestRank) : -1;
    if (qualityOrder < 0 || qualityOrder === 0 && compareTuningCosts(getTuningCost(tuningAssignments),
      getTuningCost(bestOverall.tuningAssignments)) < 0) {
      bestRank = finalRank;
      bestOverall = {
        totals: { ...modifierResult.totals },
        tuningAssignments: [...tuningAssignments],
        modAssignments: { ...modifierResult.modAssignments },
        rank: [...finalRank],
        score: finalScore,
      };
      if (finalRank.every(value => value === 0) && getTuningCost(tuningAssignments).installedCount === 0) break;
    }
  }

  // Refinement: try swapping each +5/-5 piece's +5 target to improve score
  if (!runtimeOptions.skipTuningRefinement && bestOverall &&
      bestRank.some(value => value !== 0)) {
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < 5; i++) {
        if (bestOverall.tuningAssignments[i].mode === '+3') continue;
        // With a pinned +5 (owned armor) only the -5 source can be retried;
        // otherwise both sides of the shift must remain searchable.
        const allowedTargets = tuningCapabilities
          ? tuningCapabilities[i].allowedDirectionalStats || []
          : STATS.includes(fixedTuningTargets?.[i])
            ? [fixedTuningTargets[i]]
            : STATS;
        const variants = allowedTargets.flatMap(altTo => STATS
            .filter(altFrom => altFrom !== altTo)
            .map(altFrom => ({ from: altFrom, to: altTo })));
        if (tuningCapabilities?.[i]?.allowNone !== false) variants.push({mode: 'none', from: null, to: null});
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
            if (j === i) {
              if (variant.mode !== 'none') { trialTotals[altFrom] -= 5; trialTotals[altTo] += 5; }
            } else if (t.mode === '+5-5') {
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
              tuningAssignments: bestOverall.tuningAssignments.map((t2, j) => j === i ? { mode: variant.mode || '+5-5', from: altFrom, to: altTo } : { ...t2 }),
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

// Structural, rule-aware quality is shared with owned-armor optimization.
// The legacy numeric score below is display metadata, never an ordering key.
export function singleStatScoreRank(stat, actual, target, constraints) {
  return rankStatRule(stat, actual, target, constraints);
}

export function scoreStatsRank(actual, target, constraints) {
  return rankStatRules(actual, target, constraints);
}

export function scoreStatsLowerBound(baseTotals, adjustmentValueSets, target, constraints, pairValueSets = null) {
  const compareTail = (left, right) => {
    for (let index = 1; index < left.length; index++) if (left[index] !== right[index]) return left[index] - right[index];
    return 0;
  };
  // The feasibility head is OR, not an additive count. Retain both classes
  // until all independent components are known; a later forced violation
  // removes the earlier advantage of a feasible component.
  const components = [];
  const keep = (bucket, rank) => {
    const head = rank[0];
    if (!bucket[head] || compareTail(rank, bucket[head]) < 0) bucket[head] = rank;
  };
  if (pairValueSets) {
    pairValueSets.forEach((values, pair) => {
      const best = [null, null];
      for (const units of values) {
        const ranks = units.map((unit, offset) => {
          const index = pair * 2 + offset;
          return singleStatScoreRank(STATS[index], baseTotals[index] + unit * 5, target[STATS[index]], constraints);
        });
        keep(best, normalizeStatRank(ranks[0].map((value, index) => value + ranks[1][index])));
      }
      components.push(best);
    });
  } else {
    for (let index = 0; index < STATS.length; index++) {
      const best = [null, null];
      for (const units of adjustmentValueSets[index]) keep(best,
        singleStatScoreRank(STATS[index], baseTotals[index] + units * 5, target[STATS[index]], constraints));
      components.push(best);
    }
  }
  const total = emptyStatRank();
  if (components.some(ranks => !ranks[0] && !ranks[1])) return total;
  const forcedViolation = components.some(ranks => !ranks[0]);
  total[0] = Number(forcedViolation);
  for (const [feasible, infeasible] of components) {
    const best = !forcedViolation ? feasible : !feasible ? infeasible : !infeasible ? feasible
      : compareTail(feasible, infeasible) <= 0 ? feasible : infeasible;
    for (let index = 1; index < total.length; index++) total[index] += best[index];
  }
  return total;
}

function compareRelaxedEntries(left, right) {
  const rankOrder = compareScoreRanks(left.rank, right.rank);
  if (rankOrder !== 0) return rankOrder;
  return compareScoreRanks(left.values, right.values);
}

function insertRelaxedEntry(bucket, entry, limit) {
  const boundary = bucket.findIndex(value => value.rank[0] === 1);
  const feasibleEnd = boundary < 0 ? bucket.length : boundary;
  const start = entry.rank[0] ? feasibleEnd : 0;
  const count = entry.rank[0] ? bucket.length - feasibleEnd : feasibleEnd;
  let low = 0;
  let high = bucket.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (compareRelaxedEntries(entry, bucket[middle]) < 0) high = middle;
    else low = middle + 1;
  }
  // Keep K per feasibility class. A future violated rule ORs both heads to
  // one and may make a currently inferior infeasible prefix the best result.
  if (low - start >= limit) return;
  bucket.splice(low, 0, entry);
  if (count >= limit) bucket.splice(start + limit, 1);
}

export function findBestRelaxedTargets(total, target, constraints, limit = 8, valueStep = 1, search = null) {
  if (!Number.isSafeInteger(total) || total < 0 || total > 1200) return [];
  // This is an armor-domain relaxation, not the clamped display domain.
  // Armor can exceed 200 (e.g. Health=225); the conserved total is its bound.
  const statRanks = STATS.map(stat => Array.from({ length: total + 1 }, (_, value) =>
    singleStatScoreRank(stat, value, target[stat], constraints)));
  let states = Array.from({ length: total + 1 }, () => []);
  states[0].push({ rank: emptyStatRank(), values: [] });

  for (let statIndex = 0; statIndex < STATS.length; statIndex++) {
    const next = Array.from({ length: total + 1 }, () => []);
    for (let sum = 0; sum <= total; sum++) {
      search?.checkpoint();
      if (states[sum].length === 0) continue;
      const maximum = total - sum;
      for (const previous of states[sum]) {
        for (let value = 0; value <= maximum; value += valueStep) {
          const contribution = statRanks[statIndex][value];
          insertRelaxedEntry(next[sum + value], {
            rank: normalizeStatRank(previous.rank.map((part, index) => part + contribution[index])),
            values: [...previous.values, value],
          }, limit);
        }
      }
    }
    states = next;
  }
  return states[total].slice(0, limit).map(entry => ({
    ...entry,
    target: Object.fromEntries(STATS.map((stat, index) => [stat, entry.values[index]])),
  }));
}

export function compareScoreRanks(left, right) {
  return compareIntegerTuples(left || [], right || []);
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

export function runSolver(problemSpec, search = null) {
  const {
    target,
    constraints,
    budget: { numPlus5, numPlus10, numPlus3 },
    runtimeOptions,
    fixedConfig,
    exoticSelection,
  } = getArmorSolverInput(problemSpec);
  const exoticSettings = fixedConfig
    ? { ...(exoticSelection || {}), config: fixedConfig }
    : null;
  let publishedRank = null;
  let feasibleIncumbent = null;
  const feasibilityFirst = Boolean(search && runtimeOptions.feasibilityFirst);
  const publishImprovement = candidate => {
    if (satisfiesConstraintModel(candidate, problemSpec.constraintModel)
        && (!feasibleIncumbent || compareScoreRanks(candidate.rank, feasibleIncumbent.rank) < 0)) {
      feasibleIncumbent = candidate;
    }
    if (!search || publishedRank && compareScoreRanks(candidate.rank, publishedRank) >= 0) return;
    publishedRank = [...candidate.rank];
    search.publish(candidate);
  };
  if (search) {
    let incumbent = null;
    // Cheap target-directed seeds precede the cold residual index. The same
    // request keeps searching; these candidates cannot prove infeasibility.
    for (let seed = 0; seed < 12; seed++) {
      search.checkpoint(1, feasibilityFirst ? {phase: 'theory-feasibility'} : null);
      const configs = fixedConfig ? [fixedConfig] : [BASE_CONFIGS[(seed * 5) % BASE_CONFIGS.length]];
      const totals = {...configs[0].baseStats};
      while (configs.length < 5) {
        const count = configs.length + 1;
        const projected = Object.fromEntries(STATS.map(stat => [stat, target[stat] * count]));
        let piece = null, rank = null;
        for (const config of BASE_CONFIGS) {
          if (seed > 0 && STATS.some(stat => {
            const ceiling = constraints.exact?.[stat] ? target[stat] : constraints.maximums?.[stat];
            return ceiling !== undefined && totals[stat] + config.baseStats[stat]
              + (5 - count) * 5 - (5 - numPlus3) * 5 > ceiling;
          })) continue;
          const values = Object.fromEntries(STATS.map(stat => [stat, (totals[stat] + config.baseStats[stat]) * 5]));
          const score = scoreStatsRank(values, projected, {});
          if (!rank || compareScoreRanks(score, rank) < 0) { piece = config; rank = score; }
        }
        if (!piece) { configs.length = 0; break; }
        configs.push(piece);
        for (const stat of STATS) totals[stat] += piece.baseStats[stat];
      }
      if (configs.length !== 5) continue;
      const evaluation = evaluateConfig(configs, target, numPlus5, numPlus10, numPlus3, constraints, null, {skipExactJointSearch: true});
      const candidate = {...evaluation, config: configs, exoticIndex: fixedConfig ? 0 : null};
      if (!incumbent || compareScoreRanks(candidate.rank, incumbent.rank) < 0) {
        incumbent = candidate; publishImprovement(candidate);
      }
      if (candidate.rank.every(value => value === 0)) break;
    }
    if (feasibilityFirst && !feasibleIncumbent) {
      // Search the actual rule box, not a short list of preferred target
      // points. The existing partial-config oracle covers exact targets,
      // intervals and visible clamp preimages, and stops at its first witness.
      // Fixed Exotic identity and the exact Balanced count remain unchanged.
      const fixedEntries = fixedConfig ? [{config: fixedConfig, allowBalanced: true,
        allowedDirectionalStats: STATS}] : [];
      const [witness] = findExactPartialConfigWitnesses({
        fixedEntries,
        freePieceCount: 5 - fixedEntries.length,
        minimums: problemSpec.constraintModel.rules.map(rule => rule.armorMinimum),
        maximums: problemSpec.constraintModel.rules.map(rule => rule.armorMaximum),
        numPlus5, numPlus10, numPlus3,
        allowedFreePlus3Counts: fixedConfig ? [numPlus3, numPlus3 - 1] : [numPlus3],
        maxWitnesses: 1,
        checkpoint: (count = 0) => search.checkpoint(count, {phase: 'theory-feasibility'}),
      });
      if (witness) publishImprovement({...witness,
        rank: scoreStatsRank(witness.totals, target, constraints),
        score: scoreStats(witness.totals, target, constraints),
        exoticIndex: fixedConfig ? 0 : null,
        exoticSelection: exoticSelection || null,
      });
    }
    if (runtimeOptions.fastMode) {
      const best = feasibleIncumbent || incumbent;
      const result = best ? [best] : [];
      result.proof = createProofEvidence(problemSpec, {producer: "heuristic-solver",
        method: feasibilityFirst ? "first-feasible-theory" : "fast-incumbent", truncated: true});
      return result;
    }
  }
  // Search the exact target independently of all heuristic ranking and
  // refinement limits. A returned witness proves reachability; only a miss
  // falls through to the deterministic fuzzy/near-target search below.
  const exactTargetRank = scoreStatsRank(target, target, constraints);
  if (exactTargetRank.every(value => value === 0)) {
    const fixedBase = exoticSettings?.config?.baseStats;
    const budgetTotal = (fixedBase ? STATS.reduce((sum, stat) => sum + fixedBase[stat], 360) : 450)
      + numPlus3 * 3 + numPlus5 * 5 + numPlus10 * 10;
    const exactTargets = problemSpec.constraintModel.targetDomain === "visible"
      ? visibleArmorTargets(problemSpec.constraintModel.target, problemSpec.constraintModel.fragments, budgetTotal, 8).targets
      : [target];
    for (const exactTarget of exactTargets) {
      if (!satisfiesConstraintModel({totals: exactTarget}, problemSpec.constraintModel)) continue;
      const searchStats = {};
      let progressFarmability = Infinity;
      const exactWitnesses = findExactTargetWitnesses({
        target: exactTarget,
        numPlus5,
        numPlus10,
        numPlus3,
        fixedConfig: exoticSettings?.config || null,
        searchStats,
        checkpoint: search?.checkpoint,
        onWitness: search ? witness => {
          const farmability = farmabilityScore(witness.config, exoticSettings?.config ? 0 : null);
          if (farmability >= progressFarmability) return;
          progressFarmability = farmability;
          search.publish({...witness, totals: {...exactTarget},
            rank: scoreStatsRank(exactTarget, target, constraints), score: scoreStats(exactTarget, target, constraints),
            exoticIndex: exoticSettings?.config ? 0 : null});
        } : null,
      });
      if (exactWitnesses.length > 0) {
        const exactScore = scoreStats(exactTarget, target, constraints);
        const exactSolutions = exactWitnesses.map(witness => ({
          ...witness,
          totals: { ...exactTarget },
          rank: scoreStatsRank(exactTarget, target, constraints),
          score: exactScore,
          exoticIndex: exoticSettings?.config ? 0 : null,
          exoticSelection: exoticSettings ? {
            classId: exoticSettings.classId,
            classLabel: exoticSettings.classLabel,
            primaryPerkId: exoticSettings.primaryPerkId,
            primaryPerkName: exoticSettings.primaryPerkName,
            secondaryPerkId: exoticSettings.secondaryPerkId,
            secondaryPerkName: exoticSettings.secondaryPerkName,
          } : null,
        }));
        const exactSortKeys = new Map(exactSolutions.map(candidate => [candidate, {
          farmability: farmabilityScore(candidate.config, candidate.exoticIndex),
          tuning: getTuningCost(candidate.tuningAssignments).installedCount,
          key: archetypeKey(candidate.config, candidate.exoticIndex),
        }]));
        exactSolutions.sort((left, right) => {
          const leftKey = exactSortKeys.get(left), rightKey = exactSortKeys.get(right);
          const farmabilityOrder = leftKey.farmability - rightKey.farmability;
          if (farmabilityOrder !== 0) return farmabilityOrder;
          if (leftKey.tuning !== rightKey.tuning) return leftKey.tuning - rightKey.tuning;
          return leftKey.key.localeCompare(rightKey.key);
        });
        const requestedLimit = Number(runtimeOptions.maxExactSolutions);
        const maxExactSolutions = Number.isInteger(requestedLimit)
          ? Math.max(1, requestedLimit)
          : 60;
        // The exact oracle has already scanned the full target space before this
        // presentation limit is applied. Truncation therefore cannot turn a
        // reachable target into a miss.
        const presented = exactSolutions.slice(0, maxExactSolutions);
        presented.proof = createProofEvidence(problemSpec, {
          producer: "exact-target-oracle",
          method: "exact-target-oracle",
          complete: true,
          statesExamined: searchStats.statesExamined,
          assumptions: ["known-data", "complete-catalog", "unrestricted-theoretical-tuning"],
          scope: "target-point",
          outcome: "feasible",
        });
        return presented;
      }
    }
  }

  if (!runtimeOptions.fastMode && !runtimeOptions.proveFuzzy) {
    const relaxedProof = tryRelaxedProof(
      target,
      numPlus5,
      numPlus10,
      numPlus3,
      constraints,
      exoticSettings,
      runtimeOptions,
      search,
    );
    if (relaxedProof) {
      relaxedProof.proof = createProofEvidence(problemSpec, {
        producer: "relaxed-k-best",
        method: "relaxed-k-best-plus-exact-target-oracle",
        truncated: true,
        limitation: "K-best targets do not cover the complete Armor value domain",
      });
      return relaxedProof;
    }
  }

  const solutionMap = new Map();
  const fixedExotic = exoticSettings?.config || null;
  const purpleCount = fixedExotic ? 4 : 5;
  const stagedCandidates = [];

  function storeSolution(bestConfig, bestResult) {
    search?.checkpoint();
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
    publishImprovement(solutionMap.get(key));
  }

  function refineAndStore(archIndices, config, initialResult, localSearch) {
    let bestConfig = [...config];
    let bestResult = initialResult || evaluateConfig(
      bestConfig, target, numPlus5, numPlus10, numPlus3, constraints, null,
      { skipExactJointSearch: true }
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
              trial, target, numPlus5, numPlus10, numPlus3, constraints, null,
              { skipExactJointSearch: true }
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
        search?.checkpoint();
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
            const projectedTarget = Object.fromEntries(STATS.map(stat => [
              stat, target[stat] * completedPieces,
            ]));
            const projectedConstraints = {
              ...constraints,
              minimums: Object.fromEntries(Object.entries(
                constraints?.minimums || {}
              ).map(([stat, value]) => [stat, value * completedPieces])),
              maximums: Object.fromEntries(Object.entries(constraints?.maximums || {}).map(([stat, value]) => [stat, value * 5])),
            };
            const rank = scoreStatsRank(Object.fromEntries(STATS.map(stat => [stat, hypo[stat] * 5])), projectedTarget, projectedConstraints);
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
          { skipTuningRefinement: true, skipExactJointSearch: true }
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

  const stagedSortKeys = new Map(stagedCandidates.map(candidate => [candidate, {
    farmability: farmabilityScore(candidate.config, fixedExotic ? 0 : null),
    tuning: getTuningCost(candidate.coarseResult.tuningAssignments).installedCount,
    key: createCanonicalId({...candidate.coarseResult, config: candidate.config}),
  }]));
  stagedCandidates.sort((left, right) => {
    const rankOrder = compareScoreRanks(
      left.coarseResult.rank, right.coarseResult.rank
    );
    if (rankOrder !== 0) return rankOrder;
    const leftKey = stagedSortKeys.get(left), rightKey = stagedSortKeys.get(right);
    const farmabilityOrder = leftKey.farmability - rightKey.farmability;
    if (farmabilityOrder !== 0) return farmabilityOrder;
    if (leftKey.tuning !== rightKey.tuning) return leftKey.tuning - rightKey.tuning;
    return leftKey.key.localeCompare(rightKey.key);
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
        candidate.config, target, numPlus5, numPlus10, numPlus3, constraints, null,
        { skipExactJointSearch: true }
      );
    refineAndStore(
      candidate.archIndices,
      candidate.config,
      result,
      !runtimeOptions.fastMode && index < LOCAL_SEARCH_CANDIDATE_LIMIT
    );
  }

  const solutions = [...solutionMap.values()];
  const solutionSortKeys = new Map(solutions.map(candidate => [candidate, {
    farmability: farmabilityScore(candidate.config, candidate.exoticIndex),
    tuning: getTuningCost(candidate.tuningAssignments).installedCount,
    key: createCanonicalId(candidate),
  }]));
  solutions.sort((a, b) => {
    const rankOrder = compareScoreRanks(a.rank, b.rank);
    if (rankOrder !== 0) return rankOrder;
    const aKey = solutionSortKeys.get(a), bKey = solutionSortKeys.get(b);
    const aF = aKey.farmability, bF = bKey.farmability;
    if (aF !== bF) return aF - bF;
    if (aKey.tuning !== bKey.tuning) return aKey.tuning - bKey.tuning;
    return aKey.key.localeCompare(bKey.key);
  });

  // The legacy search supplies an incumbent only. Its Top-N limits cannot
  // decide global optimality or infeasibility.
  const perfectOnes = solutions.filter(solution =>
    solution.rank.every(value => value === 0));
  const incumbentSolutions = perfectOnes.length > 0
    ? perfectOnes
    : solutions.slice(0, 60);
  if (runtimeOptions.fastMode) {
    incumbentSolutions.proof = createProofEvidence(problemSpec, {
      producer: "heuristic-solver",
      method: "bounded-fallback-search",
      truncated: true,
      statesExamined: stagedCandidates.length,
    });
    return incumbentSolutions;
  }

  const incumbent = incumbentSolutions[0] || null;

  if (!runtimeOptions.proveFuzzy) {
    incumbentSolutions.proof = createProofEvidence(problemSpec, {
      producer: "heuristic-solver",
      method: "relaxed-candidate-limit",
      truncated: true,
      statesExamined: stagedCandidates.length,
    });
    return incumbentSolutions;
  }

  const searchStats = {};
  const provenBest = findBestGlobalWitness({
    checkpoint: search?.checkpoint,
    onWitness: search?.publish,
    target,
    numPlus5,
    numPlus10,
    numPlus3,
    fixedConfig: exoticSettings?.config || null,
    rankTotals: totals => scoreStatsRank(totals, target, constraints),
    lowerBoundRank: (baseTotals, adjustmentValueSets, pairValueSets) => scoreStatsLowerBound(
      baseTotals,
      adjustmentValueSets,
      target,
      constraints,
      pairValueSets,
    ),
    compareRanks: compareScoreRanks,
    initialBest: incumbent,
    searchStats,
  });
  const globalProof = createProofEvidence(problemSpec, {
    producer: "global-fuzzy-enumeration",
    method: "complete-global-fuzzy-enumeration",
    complete: true,
    statesExamined: searchStats.statesExamined,
    assumptions: ["known-data", "complete-catalog", "admissible-hard-rule-lower-bound"],
    outcome: provenBest && satisfiesConstraintModel(provenBest, problemSpec.constraintModel)
      ? "feasible" : "infeasible",
  });
  if (!provenBest) {
    incumbentSolutions.proof = globalProof;
    return incumbentSolutions;
  }
  provenBest.score = scoreStats(provenBest.totals, target, constraints);
  provenBest.exoticSelection = exoticSettings ? {
    classId: exoticSettings.classId,
    classLabel: exoticSettings.classLabel,
    primaryPerkId: exoticSettings.primaryPerkId,
    primaryPerkName: exoticSettings.primaryPerkName,
    secondaryPerkId: exoticSettings.secondaryPerkId,
    secondaryPerkName: exoticSettings.secondaryPerkName,
  } : null;
  // The globally proven witness leads, but every other verified candidate is
  // kept behind it. Returning only [provenBest] collapsed the plan list to a
  // single entry whenever a fuzzy rule set was proven, so the alternative
  // rule-satisfying loadouts the exact branch exposes would silently vanish.
  const proven = [provenBest];
  const seenIds = new Set([createCanonicalId(provenBest)]);
  for (const solution of incumbentSolutions) {
    const id = createCanonicalId(solution);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    proven.push(solution);
  }
  proven.proof = globalProof;
  return proven;
}

function tryRelaxedProof(
  target, numPlus5, numPlus10, numPlus3, constraints,
  exoticSettings, runtimeOptions, search = null,
) {
  const fixedBaseTotal = exoticSettings?.config
    ? STATS.reduce((sum, stat) =>
      sum + (Number(exoticSettings.config.baseStats?.[stat]) || 0), 0) + 4 * 90
    : 5 * 90;
  const finalTotal = fixedBaseTotal
    + numPlus3 * 3
    + numPlus5 * 5
    + numPlus10 * 10;
  const relaxedTargets = findBestRelaxedTargets(
    finalTotal,
    target,
    constraints,
    Number.isInteger(runtimeOptions.relaxedCandidateLimit)
      ? Math.max(1, runtimeOptions.relaxedCandidateLimit)
      : 4,
    numPlus3 === 0 ? 5 : 1,
    search,
  );
  for (const relaxed of relaxedTargets) {
    const witnesses = findExactTargetWitnesses({
      checkpoint: search?.checkpoint,
      target: relaxed.target,
      numPlus5,
      numPlus10,
      numPlus3,
      fixedConfig: exoticSettings?.config || null,
    });
    if (witnesses.length === 0) continue;
    const candidates = witnesses.map(witness => ({
      ...witness,
      totals: { ...relaxed.target },
      rank: [...relaxed.rank],
      score: scoreStats(relaxed.target, target, constraints),
      exoticIndex: exoticSettings?.config ? 0 : null,
      exoticSelection: exoticSettings ? {
        classId: exoticSettings.classId,
        classLabel: exoticSettings.classLabel,
        primaryPerkId: exoticSettings.primaryPerkId,
        primaryPerkName: exoticSettings.primaryPerkName,
        secondaryPerkId: exoticSettings.secondaryPerkId,
        secondaryPerkName: exoticSettings.secondaryPerkName,
      } : null,
    }));
    const candidateSortKeys = new Map(candidates.map(candidate => [candidate, {
      farmability: farmabilityScore(candidate.config, candidate.exoticIndex), key: createCanonicalId(candidate),
      tuning: getTuningCost(candidate.tuningAssignments).installedCount,
    }]));
    candidates.sort((left, right) => {
      const leftKey = candidateSortKeys.get(left), rightKey = candidateSortKeys.get(right);
      const farmabilityOrder = leftKey.farmability - rightKey.farmability;
      if (farmabilityOrder !== 0) return farmabilityOrder;
      if (leftKey.tuning !== rightKey.tuning) return leftKey.tuning - rightKey.tuning;
      return leftKey.key.localeCompare(rightKey.key);
    });
    const proven = [candidates[0]];
    // The relaxed target list is K-best and does not cover the full Armor
    // value domain. A witness found here is useful, but a miss against the
    // user's hard rules is not an infeasibility proof.
    return proven;
  }
  return null;
}

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
