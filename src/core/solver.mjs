import {
  ARCHETYPES, BASE_CONFIGS, STATS,
} from "./armor-model.mjs";

// ============================================================
// EVALUATION: compute deterministic tuning + mods for a config
// ============================================================


// fixedTo pins the +5 side of a tuning mod. On armor you already own, the +5
// stat is rolled with the piece and cannot be re-picked; only the -5 source is
// free. Pass null (the from-scratch solver) to let both sides be chosen.
export function applySingleTuning(totals, target, constraints, forcedFromHits, fixedTo = null) {
  const hasAdvancedConstraints = (constraints?.priorityOrder?.length || 0) > 0 ||
    Object.values(constraints?.minimums || {}).some(v => v > 0) ||
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

  const p = constraints?.priorities || {};
  const l100 = constraints?.le100 || {};
  const f0 = constraints?.force0 || {};
  const priorityOrder = constraints?.priorityOrder || [];
  const minimums = constraints?.minimums || {};
  const exact = constraints?.exact || {};
  const forcedCandidates = STATS.filter(s => (forcedFromHits[s] || 0) > 0 && totals[s] > target[s]);
  const fromCandidates = (forcedCandidates.length > 0 ? forcedCandidates : STATS)
    .filter(s => s !== fixedTo);
  const toCandidates = fixedTo ? [fixedTo] : STATS;
  let best = null;
  let bestImprovement = -Infinity;

  for (const from of fromCandidates) {
    for (const to of toCandidates) {
      if (to === from) continue;
      const fromRank = priorityOrder.indexOf(from);
      const toRank = priorityOrder.indexOf(to);
      const oldPenalty =
        singlePenalty(totals[from], target[from], p[from], l100[from], f0[from], fromRank, minimums[from], exact[from]) +
        singlePenalty(totals[to], target[to], p[to], l100[to], f0[to], toRank, minimums[to], exact[to]);
      const newPenalty =
        singlePenalty(totals[from] - 5, target[from], p[from], l100[from], f0[from], fromRank, minimums[from], exact[from]) +
        singlePenalty(totals[to] + 5, target[to], p[to], l100[to], f0[to], toRank, minimums[to], exact[to]);
      const improvement = oldPenalty - newPenalty;
      if (improvement > bestImprovement) {
        bestImprovement = improvement;
        best = { from, to };
      }
    }
  }
  return best || { from: STATS.find(s => s !== fixedTo), to: fixedTo || STATS[1] };
}

// fixedTuningTargets describes armor you already own: entry i is the stat piece
// i's tuning mod rolled on its +5 side, or null when that piece runs a +3 mod.
// Both the +5 stat and the mode come with the piece, so only the -5 source and
// the armor mods get re-picked. Pass null — as the from-scratch solver does — to
// let the evaluator choose modes and both tuning sides freely, since armor being
// farmed can roll anything.
export function evaluateConfig(
  baseConfigs, target, numPlus5, numPlus10, numPlus3, constraints, fixedTuningTargets = null
) {
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
  let bestScore = Infinity;

  // Generate masks with exactly numPlus3 bits set. With fixedTuningTargets the
  // per-piece mode is already known (null entry = that piece runs +3), so the
  // single matching mask is used instead of trying every distribution.
  const masks = [];
  if (fixedTuningTargets) {
    let fixedMask = 0;
    for (let i = 0; i < 5; i++) if (!fixedTuningTargets[i]) fixedMask |= (1 << i);
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
      const t = applySingleTuning(
        totals, target, constraints, hitsRemaining, fixedTuningTargets?.[i] || null
      );
      tuningAssignments[i] = { mode: '+5-5', from: t.from, to: t.to };
      totals[t.from] -= 5;
      totals[t.to] += 5;
      if (hitsRemaining[t.from] > 0) hitsRemaining[t.from]--;
    }

    const modSizes = [];
    for (let i = 0; i < numPlus10; i++) modSizes.push(10);
    for (let i = 0; i < numPlus5; i++) modSizes.push(5);

    const modAssignments = {};
    const usedPieces = new Set();
    const p = constraints?.priorities || {};
    const l100 = constraints?.le100 || {};
    const f0 = constraints?.force0 || {};
    const priorityOrder = constraints?.priorityOrder || [];
    const minimums = constraints?.minimums || {};
    const exact = constraints?.exact || {};

    for (const modSize of modSizes) {
      let bestStat = null, bestPiece = null, bestImprovement = -Infinity;
      for (const st of STATS) {
        const rank = priorityOrder.indexOf(st);
        const oldPen = singlePenalty(totals[st], target[st], p[st], l100[st], f0[st], rank, minimums[st], exact[st]);
        const newPen = singlePenalty(totals[st] + modSize, target[st], p[st], l100[st], f0[st], rank, minimums[st], exact[st]);
        const imp = oldPen - newPen;
        // Tiebreaker: same improvement -> prefer stat further below target; if still tied -> higher target
        const thisGap = totals[st] - target[st];
        const bestGap = bestStat ? totals[bestStat] - target[bestStat] : 0;
        if (imp > bestImprovement ||
            (Math.abs(imp - bestImprovement) < 0.001 && (thisGap < bestGap ||
             (Math.abs(thisGap - bestGap) < 0.001 && target[st] > (target[bestStat]||0))))) {
          for (let pp = 0; pp < 5; pp++) {
            if (!usedPieces.has(pp)) { bestImprovement = imp; bestStat = st; bestPiece = pp; break; }
          }
        }
      }
      if (bestPiece !== null) {
        modAssignments[bestPiece] = { stat: bestStat, size: modSize };
        usedPieces.add(bestPiece);
        totals[bestStat] += modSize;
      }
    }
    for (let pp = 0; pp < 5; pp++) {
      if (!modAssignments[pp]) modAssignments[pp] = null;
    }

    const finalScore = scoreStats(totals, target, constraints);
    if (finalScore < bestScore) {
      bestScore = finalScore;
      bestOverall = { totals: { ...totals }, tuningAssignments: [...tuningAssignments], modAssignments: { ...modAssignments }, score: finalScore };
      if (bestScore === 0) break;
    }
  }

  // Refinement: try swapping each +5/-5 piece's +5 target to improve score
  const p = constraints?.priorities || {};
  const l100 = constraints?.le100 || {};
  const f0 = constraints?.force0 || {};
  const priorityOrder = constraints?.priorityOrder || [];
  const minimums = constraints?.minimums || {};
  const exact = constraints?.exact || {};
  // Hard minimum/exact constraints must still get a refinement pass when their
  // large penalty pushes the score above the normal near-miss cutoff.
  const hasHardTargetConstraint = Object.values(minimums).some(value => value > 0)
    || Object.values(exact).some(Boolean);
  if (bestOverall && bestOverall.score > 0 &&
      (bestOverall.score < 10000 || hasHardTargetConstraint)) {
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < 5; i++) {
        if (bestOverall.tuningAssignments[i].mode !== '+5-5') continue;
        const curFrom = bestOverall.tuningAssignments[i].from;
        const curTo = bestOverall.tuningAssignments[i].to;
        // With a pinned +5 (owned armor) only the -5 source can be retried;
        // otherwise the +5 target is the thing worth varying.
        const pinnedTo = fixedTuningTargets?.[i] || null;
        const variants = pinnedTo
          ? STATS.filter(s => s !== curFrom && s !== pinnedTo).map(altFrom => ({ from: altFrom, to: pinnedTo }))
          : STATS.filter(s => s !== curTo && s !== curFrom).map(altTo => ({ from: curFrom, to: altTo }));
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
          // Redo mod distribution
          const modSizes2 = [];
          for (let k = 0; k < numPlus10; k++) modSizes2.push(10);
          for (let k = 0; k < numPlus5; k++) modSizes2.push(5);
          const trialMods = {};
          const used2 = new Set();
          for (const ms of modSizes2) {
            let bStat = null, bPiece = null, bImp = -Infinity;
            for (const st2 of STATS) {
              const rank = priorityOrder.indexOf(st2);
              const op = singlePenalty(trialTotals[st2], target[st2], p[st2], l100[st2], f0[st2], rank, minimums[st2], exact[st2]);
              const np = singlePenalty(trialTotals[st2] + ms, target[st2], p[st2], l100[st2], f0[st2], rank, minimums[st2], exact[st2]);
              const im = op - np;
              if (im > bImp) {
                for (let pp2 = 0; pp2 < 5; pp2++) {
                  if (!used2.has(pp2)) { bImp = im; bStat = st2; bPiece = pp2; break; }
                }
              }
            }
            if (bPiece !== null) { trialMods[bPiece] = { stat: bStat, size: ms }; used2.add(bPiece); trialTotals[bStat] += ms; }
          }
          for (let pp2 = 0; pp2 < 5; pp2++) { if (!trialMods[pp2]) trialMods[pp2] = null; }
          const trialScore = scoreStats(trialTotals, target, constraints);
          if (trialScore < bestScore) {
            bestScore = trialScore;
            bestOverall = {
              totals: { ...trialTotals },
              tuningAssignments: bestOverall.tuningAssignments.map((t2, j) => j === i ? { mode: '+5-5', from: altFrom, to: altTo } : { ...t2 }),
              modAssignments: { ...trialMods },
              score: trialScore,
            };
            improved = true;
            if (trialScore === 0) break;
          }
        }
        if (improved) break;
      }
    }
  }

  return bestOverall;
}

export function singlePenalty(actual, target, isPriority, le100, force0, priorityRank = -1, minimum = 0, exact = false) {
  const diff = actual - target;
  let penalty = diff < 0 ? diff * diff * 3 : diff * diff;
  if (isPriority) penalty *= 50;
  if (priorityRank === 0) penalty *= 1e12;
  else if (priorityRank === 1) penalty *= 1e6;
  if (minimum > 0 && actual < minimum) penalty += (minimum - actual) * (minimum - actual) * 1e18;
  if (exact && actual !== target) penalty += (actual - target) * (actual - target) * 1e18;
  // Hard constraints
  if (le100 && actual > 100) penalty += (actual - 100) * (actual - 100) * 500;
  if (force0 && actual > 0) penalty += actual * actual * 500;
  return penalty;
}

export function scoreStats(actual, target, constraints) {
  let s = 0;
  const p = constraints?.priorities || {};
  const l100 = constraints?.le100 || {};
  const f0 = constraints?.force0 || {};
  const priorityOrder = constraints?.priorityOrder || [];
  const minimums = constraints?.minimums || {};
  const exact = constraints?.exact || {};
  for (const st of STATS) {
    s += singlePenalty(
      actual[st], target[st], p[st], l100[st], f0[st],
      priorityOrder.indexOf(st), minimums[st], exact[st]
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

export function runSolver(target, numPlus5, numPlus10, numPlus3, constraints, exoticSettings = null, runtimeOptions = {}) {
  const solutionMap = new Map();
  const fixedExotic = exoticSettings?.config || null;
  const purpleCount = fixedExotic ? 4 : 5;

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
          let bestPiece = null, bestAfterScore = Infinity;
          for (let t = 0; t < 4; t++) {
            const piece = BASE_CONFIGS[archIdx * 4 + t];
            const hypo = { ...partialTotals };
            for (const s of STATS) hypo[s] += piece.baseStats[s];
            const completedPieces = i + 1 + (fixedExotic ? 1 : 0);
            const ratio = completedPieces / 5;
            let s = 0;
            for (const st of STATS) {
              const expected = target[st] * ratio;
              const diff = hypo[st] - expected;
              const rank = constraints?.priorityOrder?.indexOf(st) ?? -1;
              const weight = rank === 0 ? 1e12 : (rank === 1 ? 1e6 : 1);
              s += (diff < 0 ? diff * diff * 3 : diff * diff) * weight;
            }
            if (s < bestAfterScore) { bestAfterScore = s; bestPiece = piece; }
          }
          config.push(bestPiece);
          for (const s of STATS) partialTotals[s] += bestPiece.baseStats[s];
        }

        // Quick local search over tertiary choices (try swapping one piece's tertiary)
        let bestConfig = [...config];
        let bestResult = evaluateConfig(bestConfig, target, numPlus5, numPlus10, numPlus3, constraints);
        if (!runtimeOptions.fastMode) {
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
                const r = evaluateConfig(trial, target, numPlus5, numPlus10, numPlus3, constraints);
                if (r.score < bestResult.score) {
                  bestConfig = trial; bestResult = r; improved = true; break;
                }
              }
              if (improved) break;
            }
          }
        }

        // Dedup and store
        const exoticIndex = fixedExotic ? 0 : null;
        const key = archetypeKey(bestConfig, exoticIndex);
        const existing = solutionMap.get(key);
        if (!existing || bestResult.score < existing.score) {
          solutionMap.set(key, {
            config: [...bestConfig],
            tuningAssignments: bestResult.tuningAssignments,
            modAssignments: bestResult.modAssignments,
            totals: bestResult.totals,
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

  const solutions = [...solutionMap.values()];
  solutions.sort((a, b) => {
    if (Math.floor(a.score/100) !== Math.floor(b.score/100)) return a.score - b.score;
    const aF = farmabilityScore(a.config, a.exoticIndex), bF = farmabilityScore(b.config, b.exoticIndex);
    if (aF !== bF) return aF - bF;
    return a.score - b.score;
  });

  // Show all perfect solutions, or top 20 imperfect ones
  const perfectOnes = solutions.filter(s => s.score === 0);
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
