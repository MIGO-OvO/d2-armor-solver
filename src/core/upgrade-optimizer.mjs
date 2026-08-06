import {
  ARCHETYPES, BASE_CONFIGS, STATS,
} from "./armor-model.mjs";
import { getEffectiveBaseStats, inferArchetypeFromStats } from "./dim-csv.mjs";
import { evaluateConfig, scoreStats } from "./solver.mjs";

export const UPGRADE_SLOTS = [
  { id:'helmet', labels:['头盔','頭盔','Helmet'] },
  { id:'arms', labels:['臂铠','臂鎧','Arms'] },
  { id:'chest', labels:['胸甲','胸甲','Chest'] },
  { id:'legs', labels:['腿甲','腿甲','Legs'] },
  { id:'classItem', labels:['职业物品','職業物品','Class Item'] },
];
export const DEFAULT_UPGRADE_ARCHETYPES = ['Brawler', 'Grenadier', 'Paragon', 'Specialist', 'Gunner'];

export function createDefaultUpgradePiece(slotIndex) {
  const archetypeId = DEFAULT_UPGRADE_ARCHETYPES[slotIndex] || ARCHETYPES[slotIndex]?.id || ARCHETYPES[0].id;
  const archetype = ARCHETYPES.find(item => item.id === archetypeId) || ARCHETYPES[0];
  const tertiary = STATS.find(stat => stat !== archetype.primary && stat !== archetype.secondary);
  const tuningFrom = 'health';
  const tuningTo = STATS.find(stat => stat !== tuningFrom);
  return {
    slot: UPGRADE_SLOTS[slotIndex].id,
    archetypeId,
    tertiary,
    tuningMode: 'shift',
    tuningFrom,
    tuningTo,
    armorModSize: 10,
    armorModStat: archetype.secondary,
    exotic: false,
    locked: false,
    baseStats: null,
    setHash: null,
    itemName: "",
    sourceId: null,
    hash: null,
  };
}

export function normalizeUpgradePiece(piece, slotIndex) {
  const fallback = createDefaultUpgradePiece(slotIndex);
  const normalized = { ...fallback, ...(piece || {}), slot: UPGRADE_SLOTS[slotIndex].id };
  const archetype = ARCHETYPES.find(item => item.id === normalized.archetypeId) || ARCHETYPES[0];
  normalized.archetypeId = archetype.id;
  const tertiaryOptions = STATS.filter(stat => stat !== archetype.primary && stat !== archetype.secondary);
  if (!tertiaryOptions.includes(normalized.tertiary)) normalized.tertiary = tertiaryOptions[0];
  if (!['shift', 'plus3'].includes(normalized.tuningMode)) normalized.tuningMode = 'shift';
  if (!STATS.includes(normalized.tuningFrom)) normalized.tuningFrom = archetype.primary;
  if (!STATS.includes(normalized.tuningTo) || normalized.tuningTo === normalized.tuningFrom) {
    normalized.tuningTo = STATS.find(stat => stat !== normalized.tuningFrom);
  }
  normalized.armorModSize = [0, 5, 10].includes(Number(normalized.armorModSize))
    ? Number(normalized.armorModSize) : 10;
  if (!STATS.includes(normalized.armorModStat)) normalized.armorModStat = archetype.secondary;
  normalized.exotic = Boolean(normalized.exotic);
  normalized.locked = normalized.exotic || Boolean(normalized.locked);
  return normalized;
}

// Build a normalized upgrade piece from an imported DIM item. The real rolled
// stat distribution and the +5 tuning side (masterwork stat) stay on the piece.
// baseStats carries the item's ACTUAL stats, including only the masterwork
// bonus the item really has; the full-masterwork projection is only used to
// rank replacement candidates (inventory-solver), not the owned piece itself.
export function createUpgradePieceFromItem(item, slotIndex) {
  const archetypeId = item.archetypeId
    || inferArchetypeFromStats(item.baseStats)
    || ARCHETYPES[0].id;
  const archetype = ARCHETYPES.find(entry => entry.id === archetypeId) || ARCHETYPES[0];
  const tertiary = item.tertiary && item.tertiary !== archetype.primary && item.tertiary !== archetype.secondary
    ? item.tertiary
    : STATS.find(stat => stat !== archetype.primary && stat !== archetype.secondary);
  const tuningMode = item.tuningMode === "plus3" ? "plus3" : "shift";
  const tuningTo = item.tuningTo || item.tuningStat || STATS.find(stat => stat !== tertiary);
  const tuningFrom = STATS.includes(item.tuningFrom)
    ? item.tuningFrom
    : STATS.find(stat => stat !== tuningTo);
  const armorModSize = [0, 5, 10].includes(Number(item.armorModSize))
    ? Number(item.armorModSize)
    : 10;
  const armorModStat = STATS.includes(item.armorModStat)
    ? item.armorModStat
    : archetype.secondary;
  return normalizeUpgradePiece({
    slot: UPGRADE_SLOTS[slotIndex].id,
    archetypeId,
    tertiary,
    tuningMode,
    tuningFrom,
    tuningTo,
    armorModSize,
    armorModStat,
    exotic: Boolean(item.exotic),
    locked: false,
    baseStats: { ...(
      item.effectiveBaseStats
      || getEffectiveBaseStats({ ...item, archetypeId, tertiary })
    ) },
    masterworkTier: Number(item.masterworkTier) || 0,
    modifierInference: item.modifierInference || null,
    setHash: item.setHash,
    itemName: item.name,
    sourceId: item.id,
    hash: item.hash,
  }, slotIndex);
}

export function getUpgradeConfig(piece) {
  const archetype = ARCHETYPES.find(item => item.id === piece.archetypeId) || ARCHETYPES[0];
  const config = BASE_CONFIGS.find(config =>
    config.archetype === archetype.name && config.tertiary === piece.tertiary
  ) || BASE_CONFIGS.find(config => config.archetype === archetype.name);
  // Real armor imported from DIM carries its actual rolled stat distribution;
  // otherwise the theoretical T5 archetype layout is used.
  return piece.baseStats ? { ...config, baseStats: piece.baseStats } : config;
}

export function getArchetypeIdForConfig(config) {
  return ARCHETYPES.find(item => item.name === config.archetype)?.id || ARCHETYPES[0].id;
}

export function applyManualUpgradeModifiers(config, piece) {
  const totals = { ...config.baseStats };
  if (piece.tuningMode === 'plus3') {
    for (const stat of STATS) {
      if (stat !== config.primary && stat !== config.secondary && stat !== config.tertiary) totals[stat] += 1;
    }
  } else {
    totals[piece.tuningFrom] -= 5;
    totals[piece.tuningTo] += 5;
  }
  if (piece.armorModSize > 0) totals[piece.armorModStat] += piece.armorModSize;
  return totals;
}

export function getManualUpgradeArmorTotals(pieces) {
  const totals = Object.fromEntries(STATS.map(stat => [stat, 0]));
  pieces.forEach(piece => {
    const pieceTotals = applyManualUpgradeModifiers(getUpgradeConfig(piece), piece);
    for (const stat of STATS) totals[stat] += pieceTotals[stat];
  });
  return totals;
}

export function finalizeUpgradeTotals(armorTotals, fragments) {
  return Object.fromEntries(STATS.map(stat => [
    stat,
    Math.max(0, Math.min(200, armorTotals[stat] + (fragments[stat] || 0)))
  ]));
}

export function getUpgradeModifierBudget(pieces) {
  return {
    numPlus3: pieces.filter(piece => piece.tuningMode === 'plus3').length,
    numPlus5: pieces.filter(piece => piece.armorModSize === 5).length,
    numPlus10: pieces.filter(piece => piece.armorModSize === 10).length,
  };
}

// "Only +5/-5" analysis treats every +3 piece as a +5/-5 one. The +3 mod has no
// rolled +5 side, so the piece is just read as a shift piece with whatever +5
// direction it carried; the budget and re-picking stay consistent.
function coercePiecesToPlus5Only(pieces) {
  return pieces.map((piece, index) => piece.tuningMode === 'plus3'
    ? normalizeUpgradePiece({ ...piece, tuningMode: 'shift' }, index)
    : piece);
}


function normalizeRequiredStats(requiredStats = []) {
  return [...new Set(requiredStats)].filter(stat => STATS.includes(stat));
}

function getUpgradeEvaluationConstraints(armorTarget, requiredStats) {
  return {
    minimums: Object.fromEntries(requiredStats.map(stat => [stat, armorTarget[stat]])),
  };
}

export function getUpgradeMetrics(finalTotals, targets, score = 0, requiredStats = []) {
  const normalizedRequiredStats = normalizeRequiredStats(requiredStats);
  const deficits = STATS.map(stat => Math.max(0, targets[stat] - finalTotals[stat]));
  const excesses = STATS.map(stat => Math.max(0, finalTotals[stat] - targets[stat]));
  const reachedCount = STATS.filter(stat => finalTotals[stat] >= targets[stat]).length;
  const exactCount = STATS.filter(stat => finalTotals[stat] === targets[stat]).length;
  const requiredDeficits = normalizedRequiredStats.map(stat =>
    Math.max(0, targets[stat] - finalTotals[stat]));
  const requiredReachedCount = normalizedRequiredStats.filter(stat =>
    finalTotals[stat] >= targets[stat]).length;
  return {
    allReached: reachedCount === STATS.length,
    shortfall: deficits.reduce((sum, value) => sum + value, 0),
    maxShortfall: Math.max(...deficits),
    reachedCount,
    exactCount,
    excess: excesses.reduce((sum, value) => sum + value, 0),
    requiredStats: normalizedRequiredStats,
    requiredCount: normalizedRequiredStats.length,
    requiredAllReached: requiredReachedCount === normalizedRequiredStats.length,
    requiredReachedCount,
    requiredShortfall: requiredDeficits.reduce((sum, value) => sum + value, 0),
    requiredMaxShortfall: requiredDeficits.length > 0 ? Math.max(...requiredDeficits) : 0,
    score,
  };
}

export function compareUpgradeMetrics(left, right) {
  const hasRequiredStats = Math.max(left.requiredCount || 0, right.requiredCount || 0) > 0;
  if (hasRequiredStats) {
    if (left.requiredAllReached !== right.requiredAllReached) {
      return left.requiredAllReached ? -1 : 1;
    }
    if (left.requiredShortfall !== right.requiredShortfall) {
      return left.requiredShortfall - right.requiredShortfall;
    }
    if (left.requiredMaxShortfall !== right.requiredMaxShortfall) {
      return left.requiredMaxShortfall - right.requiredMaxShortfall;
    }
    if (left.requiredReachedCount !== right.requiredReachedCount) {
      return right.requiredReachedCount - left.requiredReachedCount;
    }
  }
  if (left.allReached !== right.allReached) return left.allReached ? -1 : 1;
  if (left.shortfall !== right.shortfall) return left.shortfall - right.shortfall;
  if (left.maxShortfall !== right.maxShortfall) return left.maxShortfall - right.maxShortfall;
  if (left.reachedCount !== right.reachedCount) return right.reachedCount - left.reachedCount;
  if (left.excess !== right.excess) return left.excess - right.excess;
  if (left.exactCount !== right.exactCount) return right.exactCount - left.exactCount;
  return left.score - right.score;
}

export function evaluateUpgradePieces(
  pieces, targets, fragments, reassignModifiers, requiredStats = [], onlyPlus5Tuning = false
) {
  if (onlyPlus5Tuning) pieces = coercePiecesToPlus5Only(pieces);
  const normalizedRequiredStats = normalizeRequiredStats(requiredStats);
  const configs = pieces.map(getUpgradeConfig);
  const armorTarget = Object.fromEntries(STATS.map(stat => [
    stat,
    Math.max(0, targets[stat] - (fragments[stat] || 0))
  ]));
  const constraints = getUpgradeEvaluationConstraints(armorTarget, normalizedRequiredStats);
  const manualArmorTotals = getManualUpgradeArmorTotals(pieces);
  const manualEvaluation = {
    totals: manualArmorTotals,
    tuningAssignments: pieces.map(piece => piece.tuningMode === 'plus3'
      ? { mode:'+3', from:null, to:null }
      : { mode:'+5-5', from:piece.tuningFrom, to:piece.tuningTo }),
    modAssignments: Object.fromEntries(pieces.map((piece, index) => [
      index,
      piece.armorModSize > 0 ? { size:piece.armorModSize, stat:piece.armorModStat } : null
    ])),
    score: scoreStats(manualArmorTotals, armorTarget, constraints),
  };
  let evaluation = manualEvaluation;
  if (reassignModifiers) {
    const budget = getUpgradeModifierBudget(pieces);
    // Both the tuning mode and the +5 stat come with each owned piece, so they
    // stay pinned; only the -5 source and the armor mods get re-picked.
    const fixedTuningTargets = pieces.map(piece =>
      piece.tuningMode === 'plus3' ? null : piece.tuningTo);
    const automaticEvaluation = evaluateConfig(
      configs, armorTarget, budget.numPlus5, budget.numPlus10, budget.numPlus3, constraints,
      fixedTuningTargets
    );
    const manualFinal = finalizeUpgradeTotals(manualEvaluation.totals, fragments);
    const automaticFinal = finalizeUpgradeTotals(automaticEvaluation.totals, fragments);
    const manualMetrics = getUpgradeMetrics(
      manualFinal, targets, manualEvaluation.score, normalizedRequiredStats
    );
    const automaticMetrics = getUpgradeMetrics(
      automaticFinal, targets, automaticEvaluation.score, normalizedRequiredStats
    );
    if (compareUpgradeMetrics(automaticMetrics, manualMetrics) < 0) evaluation = automaticEvaluation;
  }
  const finalTotals = finalizeUpgradeTotals(evaluation.totals, fragments);
  return {
    ...evaluation,
    configs,
    finalTotals,
    metrics: getUpgradeMetrics(
      finalTotals, targets, evaluation.score, normalizedRequiredStats
    ),
  };
}

function createUpgradeEvaluator(targets, fragments, requiredStats, onlyPlus5Tuning = false) {
  const cache = new Map();
  return (pieces, reassignModifiers) => {
    const key = pieces.map(piece => [
      piece.archetypeId,
      piece.tertiary,
      piece.tuningMode,
      piece.tuningFrom,
      piece.tuningTo,
      piece.armorModSize,
      piece.armorModStat,
    ].join(':')).join('|') + '#' + Number(reassignModifiers) + '#' + Number(onlyPlus5Tuning);
    const cached = cache.get(key);
    if (cached) return cached;
    const evaluation = evaluateUpgradePieces(
      pieces, targets, fragments, reassignModifiers, requiredStats, onlyPlus5Tuning
    );
    cache.set(key, evaluation);
    return evaluation;
  };
}

// A piece's identity for "do I already own this?" purposes. The +5 tuning side
// is rolled onto the armor, so changing it means farming a new piece — it
// belongs here alongside the archetype and tertiary stat.
export function getUpgradePieceIdentity(piece) {
  const config = getUpgradeConfig(piece);
  return {
    archetype: config.archetype,
    tertiary: config.tertiary,
    tuningTo: piece.tuningMode === 'plus3' ? null : piece.tuningTo,
    tuningMode: piece.tuningMode,
  };
}

export function sameUpgradeIdentity(left, right) {
  return left.archetype === right.archetype &&
    left.tertiary === right.tertiary &&
    left.tuningMode === right.tuningMode &&
    left.tuningTo === right.tuningTo;
}

export function sameUpgradeConfig(left, right) {
  return left?.archetype === right?.archetype && left?.tertiary === right?.tertiary;
}

export function setUpgradePieceConfig(piece, slotIndex, config) {
  // Replacement candidates are freshly farmed pieces, so real-stat fields
  // from an imported owned piece must not leak into the hypothetical config.
  const hypothetical = { ...piece };
  delete hypothetical.baseStats;
  delete hypothetical.masterworkStats;
  delete hypothetical.setHash;
  delete hypothetical.itemName;
  delete hypothetical.sourceId;
  delete hypothetical.hash;
  delete hypothetical.masterworkTier;
  delete hypothetical.modifierInference;
  return normalizeUpgradePiece({
    ...hypothetical,
    archetypeId: getArchetypeIdForConfig(config),
    tertiary: config.tertiary,
  }, slotIndex);
}

export function mapUpgradeConfigsToPieces(pieces, unlockedIndices, candidateConfigs) {
  const mapped = pieces.map(piece => ({ ...piece }));
  const remaining = [...candidateConfigs];
  const unassignedSlots = [];

  for (const slotIndex of unlockedIndices) {
    const currentConfig = getUpgradeConfig(pieces[slotIndex]);
    // Prefer the exact archetype+tertiary match: it both keeps the owned piece
    // and consumes the matching candidate config, so the configs that remain
    // can serve the slots that genuinely need replacing. When the greedy
    // tertiary pass picked a different tertiary for this archetype, fall back
    // to matching on the archetype alone: the piece the player already owns
    // stays untouched (real stats and tertiary), instead of being turned into
    // a farmed replacement that inflates the seed's replacement count and
    // pushes the exact solution out of the per-bucket top-N that gets refined.
    let matchIndex = remaining.findIndex(config => sameUpgradeConfig(config, currentConfig));
    if (matchIndex < 0) {
      matchIndex = remaining.findIndex(config => config.archetype === currentConfig.archetype);
    }
    if (matchIndex >= 0) {
      remaining.splice(matchIndex, 1);
    } else {
      unassignedSlots.push(slotIndex);
    }
  }
  unassignedSlots.forEach((slotIndex, index) => {
    mapped[slotIndex] = setUpgradePieceConfig(mapped[slotIndex], slotIndex, remaining[index]);
  });
  return mapped;
}

export function getUpgradeReplacements(beforePieces, afterPieces) {
  const replacements = [];
  for (let slotIndex = 0; slotIndex < beforePieces.length; slotIndex++) {
    const beforeIdentity = getUpgradePieceIdentity(beforePieces[slotIndex]);
    const afterIdentity = getUpgradePieceIdentity(afterPieces[slotIndex]);
    if (!sameUpgradeIdentity(beforeIdentity, afterIdentity)) {
      replacements.push({
        slotIndex,
        beforePiece: { ...beforePieces[slotIndex] },
        afterPiece: { ...afterPieces[slotIndex] },
        beforeConfig: getUpgradeConfig(beforePieces[slotIndex]),
        afterConfig: getUpgradeConfig(afterPieces[slotIndex]),
        beforeIdentity,
        afterIdentity,
        // The archetype and tertiary already match, so only the rolled +5 stat
        // differs: same armor type, but a new roll has to be farmed.
        tuningOnly: sameUpgradeConfig(
          getUpgradeConfig(beforePieces[slotIndex]),
          getUpgradeConfig(afterPieces[slotIndex])
        ),
      });
    }
  }
  return replacements;
}

export function compareUpgradePlans(left, right) {
  if (!right) return -1;
  if (left.metrics.allReached && right.metrics.allReached &&
      left.replacementCount !== right.replacementCount) {
    return left.replacementCount - right.replacementCount;
  }
  const metricOrder = compareUpgradeMetrics(left.metrics, right.metrics);
  if (metricOrder !== 0) return metricOrder;
  if (left.replacementCount !== right.replacementCount) {
    return left.replacementCount - right.replacementCount;
  }
  // Same number of swaps: prefer the plan whose swaps only re-roll the +5
  // side. Farming a different archetype/tertiary is strictly more expensive
  // than farming the same armor with a different rolled +5.
  const leftNonTuningOnly = (left.replacements || []).filter(r => !r.tuningOnly).length;
  const rightNonTuningOnly = (right.replacements || []).filter(r => !r.tuningOnly).length;
  if (leftNonTuningOnly !== rightNonTuningOnly) return leftNonTuningOnly - rightNonTuningOnly;
  return left.evaluation.score - right.evaluation.score;
}

export function chooseUpgradeTertiaries(
  archetypeIndices, lockedConfigs, armorTarget, requiredStats = []
) {
  const requiredSet = new Set(normalizeRequiredStats(requiredStats));
  const selected = [];
  const partialTotals = Object.fromEntries(STATS.map(stat => [stat, 0]));
  for (const config of lockedConfigs) {
    for (const stat of STATS) partialTotals[stat] += config.baseStats[stat];
  }

  for (const archetypeIndex of archetypeIndices) {
    let bestConfig = null;
    let bestScore = Infinity;
    for (let tertiaryIndex = 0; tertiaryIndex < 4; tertiaryIndex++) {
      const config = BASE_CONFIGS[archetypeIndex * 4 + tertiaryIndex];
      const completedCount = lockedConfigs.length + selected.length + 1;
      const ratio = completedCount / 5;
      let score = 0;
      for (const stat of STATS) {
        const actual = partialTotals[stat] + config.baseStats[stat];
        const difference = actual - armorTarget[stat] * ratio;
        const requiredWeight = requiredSet.has(stat) ? 1e6 : 1;
        score += (difference < 0 ? difference * difference * 3 : difference * difference)
          * requiredWeight;
      }
      if (score < bestScore) {
        bestScore = score;
        bestConfig = config;
      }
    }
    selected.push(bestConfig);
    for (const stat of STATS) partialTotals[stat] += bestConfig.baseStats[stat];
  }
  return selected;
}

// Every piece variant worth trying in a replaceable slot: each tertiary stat of
// the same archetype, crossed with each rolled +5 tuning stat (or the +3 mod).
// The +5 stat has to be enumerated here because it cannot be re-picked later —
// it comes with the piece.
export function getUpgradeSlotVariants(piece, slotIndex, archetypeFilter, onlyPlus5Tuning = false) {
  const variants = [];
  for (const config of BASE_CONFIGS) {
    if (archetypeFilter && config.archetype !== archetypeFilter) continue;
    const configured = setUpgradePieceConfig(piece, slotIndex, config);
    if (!onlyPlus5Tuning) {
      variants.push(normalizeUpgradePiece({ ...configured, tuningMode: 'plus3' }, slotIndex));
    }
    for (const tuningTo of STATS) {
      variants.push(normalizeUpgradePiece({
        ...configured, tuningMode: 'shift', tuningTo,
      }, slotIndex));
    }
  }
  return variants;
}

export function refineUpgradePlanPieces(
  pieces, unlockedIndices, targets, fragments, reassignModifiers,
  evaluatePieces = (candidatePieces, shouldReassign) => evaluateUpgradePieces(
    candidatePieces, targets, fragments, shouldReassign
  ),
  onlyPlus5Tuning = false
) {
  let bestPieces = pieces.map(piece => ({ ...piece }));
  let bestEvaluation = evaluatePieces(bestPieces, reassignModifiers);
  let improved = true;
  let pass = 0;
  while (improved && pass < 6) {
    improved = false;
    pass++;
    for (const slotIndex of unlockedIndices) {
      const currentIdentity = getUpgradePieceIdentity(bestPieces[slotIndex]);
      const variants = getUpgradeSlotVariants(
        bestPieces[slotIndex], slotIndex, getUpgradeConfig(bestPieces[slotIndex]).archetype,
        onlyPlus5Tuning
      );
      for (const variant of variants) {
        if (sameUpgradeIdentity(getUpgradePieceIdentity(variant), currentIdentity)) continue;
        const trialPieces = bestPieces.map(piece => ({ ...piece }));
        trialPieces[slotIndex] = variant;
        const trialEvaluation = evaluatePieces(trialPieces, reassignModifiers);
        if (compareUpgradeMetrics(trialEvaluation.metrics, bestEvaluation.metrics) < 0) {
          bestPieces = trialPieces;
          bestEvaluation = trialEvaluation;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }
  return { pieces: bestPieces, evaluation: bestEvaluation };
}

// Write an evaluation's tuning and mod choices back onto the pieces, so the
// numbers we print can be reproduced by following the printed configuration.
export function applyUpgradeEvaluationToPieces(pieces, evaluation) {
  return pieces.map((piece, index) => {
    const tuning = evaluation.tuningAssignments[index];
    const mod = evaluation.modAssignments[index];
    return normalizeUpgradePiece({
      ...piece,
      tuningMode: tuning && tuning.mode === '+3' ? 'plus3' : 'shift',
      tuningFrom: tuning && tuning.from ? tuning.from : piece.tuningFrom,
      tuningTo: tuning && tuning.to ? tuning.to : piece.tuningTo,
      armorModSize: mod ? mod.size : 0,
      armorModStat: mod ? mod.stat : piece.armorModStat,
    }, index);
  });
}

export function buildUpgradePlanSteps(
  originalPieces, finalPieces, targets, fragments, finalEvaluation,
  evaluatePieces = (candidatePieces, shouldReassign) => evaluateUpgradePieces(
    candidatePieces, targets, fragments, shouldReassign
  )
) {
  const remaining = getUpgradeReplacements(originalPieces, finalPieces);
  const steps = [];
  // The plan's final tuning/mod layout is slotted in from the start, so each
  // step's stats are exactly what the player sees after doing that one swap.
  // Re-optimizing the mods per step instead would print numbers that no
  // printed configuration can reproduce.
  const configuredFinal = applyUpgradeEvaluationToPieces(finalPieces, finalEvaluation);
  // Slots not yet swapped keep the piece the player actually owns — its
  // archetype, tertiary, tuning mode, and rolled +5 — and only inherit the
  // freely-assignable parts: the -5 source and the armor mod.
  let currentPieces = originalPieces.map((piece, index) => normalizeUpgradePiece({
    ...configuredFinal[index],
    archetypeId: piece.archetypeId,
    tertiary: piece.tertiary,
    tuningMode: piece.tuningMode,
    tuningTo: piece.tuningTo,
  }, index));

  while (remaining.length > 0) {
    let bestChoice = null;
    for (let index = 0; index < remaining.length; index++) {
      const replacement = remaining[index];
      const trialPieces = currentPieces.map(piece => ({ ...piece }));
      trialPieces[replacement.slotIndex] = { ...configuredFinal[replacement.slotIndex] };
      const evaluation = evaluatePieces(trialPieces, false);
      if (!bestChoice ||
          compareUpgradeMetrics(evaluation.metrics, bestChoice.evaluation.metrics) < 0) {
        bestChoice = { index, replacement, pieces: trialPieces, evaluation };
      }
    }
    steps.push({
      ...bestChoice.replacement,
      evaluation: bestChoice.evaluation,
    });
    currentPieces = bestChoice.pieces;
    remaining.splice(bestChoice.index, 1);
  }
  return steps;
}

export function findUpgradeCompletionPlan(
  pieces, targets, fragments, reassignModifiers, baseline, extraSeedPieces = [],
  requiredStats = [],
  evaluatePieces = (candidatePieces, shouldReassign) => evaluateUpgradePieces(
    candidatePieces, targets, fragments, shouldReassign, requiredStats
  ),
  onlyPlus5Tuning = false
) {
  const unlockedIndices = pieces
    .map((piece, index) => piece.locked ? -1 : index)
    .filter(index => index >= 0);
  const lockedConfigs = pieces
    .filter(piece => piece.locked)
    .map(getUpgradeConfig);
  const armorTarget = Object.fromEntries(STATS.map(stat => [
    stat,
    Math.max(0, targets[stat] - (fragments[stat] || 0))
  ]));
  const seedPlansByReplacementCount = new Map();
  let bestPlan = null;

  function addSeed(mappedPieces) {
    const evaluation = evaluatePieces(mappedPieces, reassignModifiers);
    const replacements = getUpgradeReplacements(pieces, mappedPieces);
    const seedPlan = {
      pieces: mappedPieces,
      evaluation,
      metrics: evaluation.metrics,
      replacements,
      replacementCount: replacements.length,
    };
    const seeds = seedPlansByReplacementCount.get(seedPlan.replacementCount) || [];
    seeds.push(seedPlan);
    seeds.sort(compareUpgradePlans);
    if (seeds.length > 16) seeds.length = 16;
    seedPlansByReplacementCount.set(seedPlan.replacementCount, seeds);
  }

  function evaluateArchetypeSet(archetypeIndices) {
    const candidateConfigs = chooseUpgradeTertiaries(
      archetypeIndices, lockedConfigs, armorTarget, requiredStats
    );
    addSeed(mapUpgradeConfigsToPieces(pieces, unlockedIndices, candidateConfigs));
  }

  function enumerate(start, depth, archetypeIndices) {
    if (depth === unlockedIndices.length) {
      evaluateArchetypeSet(archetypeIndices);
      return;
    }
    for (let archetypeIndex = start; archetypeIndex < ARCHETYPES.length; archetypeIndex++) {
      archetypeIndices.push(archetypeIndex);
      enumerate(archetypeIndex, depth + 1, archetypeIndices);
      archetypeIndices.pop();
    }
  }

  enumerate(0, 0, []);
  // The archetype sweep replaces every unlocked slot, so it never proposes
  // "keep this piece's archetype, just farm a different rolled +5". Those
  // single-slot candidates come in as extra seeds.
  for (const seedPieces of extraSeedPieces) addSeed(seedPieces);
  for (const seeds of seedPlansByReplacementCount.values()) {
    for (const seed of seeds) {
      const refined = refineUpgradePlanPieces(
        seed.pieces, unlockedIndices, targets, fragments, reassignModifiers,
        evaluatePieces, onlyPlus5Tuning
      );
      const replacements = getUpgradeReplacements(pieces, refined.pieces);
      const plan = {
        pieces: refined.pieces,
        evaluation: refined.evaluation,
        metrics: refined.evaluation.metrics,
        replacements,
        replacementCount: replacements.length,
      };
      if (compareUpgradePlans(plan, bestPlan) < 0) bestPlan = plan;
    }
  }
  if (!bestPlan) return null;
  if (!bestPlan.metrics.allReached &&
      compareUpgradeMetrics(bestPlan.metrics, baseline.metrics) >= 0) {
    return null;
  }
  bestPlan.steps = buildUpgradePlanSteps(
    pieces, bestPlan.pieces, targets, fragments, bestPlan.evaluation,
    evaluatePieces
  );
  return bestPlan;
}

export function analyzeUpgradeCandidates(
  pieces, targets, fragments, reassignModifiers, requiredStats = [], onlyPlus5Tuning = false
) {
  const normalizedRequiredStats = normalizeRequiredStats(requiredStats);
  const evaluatePieces = createUpgradeEvaluator(
    targets, fragments, normalizedRequiredStats, onlyPlus5Tuning
  );
  // "Only +5/-5" applies to the plan, not to what is equipped right now: the
  // entered baseline keeps reporting the real +3 pieces as they are.
  const enteredBaseline = onlyPlus5Tuning
    ? evaluateUpgradePieces(pieces, targets, fragments, false, normalizedRequiredStats)
    : evaluatePieces(pieces, false);
  const baseline = evaluatePieces(pieces, reassignModifiers);
  const rankings = [];
  if (!baseline.metrics.allReached) {
    for (let slotIndex = 0; slotIndex < pieces.length; slotIndex++) {
      if (pieces[slotIndex].locked) continue;
      const currentIdentity = getUpgradePieceIdentity(pieces[slotIndex]);
      let bestForSlot = null;
      // Every archetype, tertiary, and rolled +5 stat is a distinct piece to
      // farm, so all three vary here.
      for (const variant of getUpgradeSlotVariants(pieces[slotIndex], slotIndex, null, onlyPlus5Tuning)) {
        const variantIdentity = getUpgradePieceIdentity(variant);
        if (sameUpgradeIdentity(variantIdentity, currentIdentity)) continue;
        const trialPieces = pieces.map(piece => ({ ...piece }));
        trialPieces[slotIndex] = variant;
        const evaluation = evaluatePieces(trialPieces, reassignModifiers);
        const candidate = {
          slotIndex,
          beforePiece: pieces[slotIndex],
          afterPiece: variant,
          config: getUpgradeConfig(variant),
          identity: variantIdentity,
          tuningOnly: sameUpgradeConfig(getUpgradeConfig(variant), getUpgradeConfig(pieces[slotIndex])),
          evaluation,
          metrics: evaluation.metrics,
          effectiveGain: baseline.metrics.shortfall - evaluation.metrics.shortfall,
        };
        if (!bestForSlot || compareUpgradeMetrics(candidate.metrics, bestForSlot.metrics) < 0) {
          bestForSlot = candidate;
        }
      }
      if (bestForSlot) rankings.push(bestForSlot);
    }
    rankings.sort((left, right) => compareUpgradeMetrics(left.metrics, right.metrics));
  }
  const bestCandidate = rankings[0] || null;
  const best = bestCandidate && compareUpgradeMetrics(bestCandidate.metrics, baseline.metrics) < 0
    ? bestCandidate : null;
  // Feed the best single-slot swaps in as plan seeds so a one-piece fix — often
  // just a different rolled +5 — is not missed by the archetype sweep.
  const singleSwapSeeds = rankings.slice(0, 8).map(candidate =>
    pieces.map((piece, index) => index === candidate.slotIndex
      ? { ...candidate.afterPiece } : { ...piece }));
  const plan = baseline.metrics.allReached
    ? null
    : findUpgradeCompletionPlan(
      pieces, targets, fragments, reassignModifiers, baseline, singleSwapSeeds,
      normalizedRequiredStats,
      evaluatePieces,
      onlyPlus5Tuning
    );
  return {
    pieces: pieces.map(piece => ({ ...piece })),
    targets: { ...targets },
    fragments: { ...fragments },
    requiredStats: normalizedRequiredStats,
    reassignModifiers,
    enteredBaseline,
    baseline,
    rankings,
    best,
    plan,
  };
}
