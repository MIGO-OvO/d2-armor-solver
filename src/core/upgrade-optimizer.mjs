import {
  ARCHETYPES, BASE_CONFIGS, STATS, normalizeArchetypeId,
} from "./armor-model.mjs";
import { getEffectiveBaseStats, inferArchetypeFromStats } from "./dim-csv.mjs";
import {
  compareScoreRanks, evaluateConfig, runSolver, scoreStats, scoreStatsRank,
} from "./solver.mjs";
import {
  compareIntegerTuples,
  createCanonicalId,
  createProblemSpec,
  STAT_DOMAIN,
} from "./solver-v3-contract.mjs";
import { findExactPartialConfigWitnesses } from "./exact-target-oracle.mjs";

export const UPGRADE_SLOTS = [
  { id:'helmet', labels:['头盔','頭盔','Helmet'] },
  { id:'arms', labels:['臂铠','臂鎧','Arms'] },
  { id:'chest', labels:['胸甲','胸甲','Chest'] },
  { id:'legs', labels:['腿甲','腿甲','Legs'] },
  { id:'classItem', labels:['职业物品','職業物品','Class Item'] },
];
export const DEFAULT_UPGRADE_ARCHETYPES = ['Brawler', 'Grenadier', 'Paragon', 'Specialist', 'Gunner'];

function normalizeTuningStats(values) {
  if (!Array.isArray(values)) return null;
  return [...new Set(values)]
    .filter(stat => STATS.includes(stat))
    .sort((left, right) => STATS.indexOf(left) - STATS.indexOf(right));
}

export function getUpgradeTuningCapability(piece, onlyPlus5Tuning = false) {
  const allowedDirectionalStats = piece.exotic
    ? normalizeTuningStats(piece.allowedTuningStats)
    : STATS.includes(piece.tunedStat)
      ? [piece.tunedStat]
      : null;
  return {
    allowBalanced: !onlyPlus5Tuning,
    allowedDirectionalStats,
    complete: Array.isArray(allowedDirectionalStats),
  };
}

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
    tunedStat: tuningTo,
    allowedTuningStats: [tuningTo],
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
  normalized.archetypeId = normalizeArchetypeId(
    normalized.archetypeId ?? normalized.archetype,
  ) || fallback.archetypeId;
  const archetype = ARCHETYPES.find(item => item.id === normalized.archetypeId) || ARCHETYPES[0];
  normalized.archetypeId = archetype.id;
  const tertiaryOptions = STATS.filter(stat => stat !== archetype.primary && stat !== archetype.secondary);
  if (!tertiaryOptions.includes(normalized.tertiary)) normalized.tertiary = tertiaryOptions[0];
  // Upgrade drafts saved before optimizationBaseStats existed still carry the
  // actual DIM stats and masterwork tier. Reconstruct their full-masterwork
  // projection during normalization so users do not need to re-import a CSV.
  if (normalized.baseStats && !normalized.optimizationBaseStats &&
      Number.isFinite(Number(normalized.masterworkTier))) {
    const currentTier = Math.min(5, Math.max(0, Number(normalized.masterworkTier) || 0));
    const frameworkStats = new Set([archetype.primary, archetype.secondary, normalized.tertiary]);
    normalized.optimizationBaseStats = Object.fromEntries(STATS.map(stat => [
      stat,
      (normalized.baseStats[stat] || 0) + (frameworkStats.has(stat) ? 0 : 5 - currentTier),
    ]));
  }
  normalized.exotic = Boolean(normalized.exotic);
  if (!['shift', 'plus3'].includes(normalized.tuningMode)) normalized.tuningMode = 'shift';
  const suppliedAllowedTuningStats = normalizeTuningStats(piece?.allowedTuningStats);
  let legacyTunedStat = fallback.tunedStat;
  if (Object.prototype.hasOwnProperty.call(piece || {}, "tunedStat")) {
    legacyTunedStat = piece.tunedStat;
  } else if (Object.prototype.hasOwnProperty.call(piece || {}, "tuningStat")) {
    legacyTunedStat = piece.tuningStat;
  } else if (!normalized.exotic && STATS.includes(piece?.tuningTo)) {
    legacyTunedStat = piece.tuningTo;
  }
  normalized.tunedStat = !normalized.exotic && STATS.includes(legacyTunedStat)
    ? legacyTunedStat
    : null;
  normalized.allowedTuningStats = normalized.exotic
    ? suppliedAllowedTuningStats
      ?? (normalized.dataConfidence?.tuning === "unknown" ? null : [...STATS])
    : normalized.tunedStat
      ? [normalized.tunedStat]
      : null;
  // An imported piece whose fixed tuning stat could not be established keeps
  // null tuning fields (no fabricated direction); the manual totals skip it
  // and the equip path rejects it with "cannot confirm tuning" (handoff 3.4).
  if (normalized.tuningMode === 'plus3') {
    normalized.tuningUnknown = false;
    normalized.tuningFrom = null;
    normalized.tuningTo = null;
  } else if (normalized.tuningUnknown
      || (!normalized.exotic && !normalized.tunedStat)
      || (normalized.exotic && !normalized.allowedTuningStats?.length)) {
    normalized.tuningUnknown = true;
    normalized.tuningTo = null;
    normalized.tuningFrom = null;
  } else {
    normalized.tuningUnknown = false;
    if (!normalized.exotic) normalized.tuningTo = normalized.tunedStat;
    if (!STATS.includes(normalized.tuningTo)
        || (normalized.exotic && !normalized.allowedTuningStats.includes(normalized.tuningTo))) {
      normalized.tuningTo = normalized.allowedTuningStats[0];
    }
    if (!STATS.includes(normalized.tuningFrom)
        || normalized.tuningFrom === normalized.tuningTo) {
      normalized.tuningFrom = STATS.find(stat => stat !== normalized.tuningTo);
    }
  }
  normalized.tuningUnknown = Boolean(normalized.tuningUnknown);
  normalized.armorModSize = [0, 5, 10].includes(Number(normalized.armorModSize))
    ? Number(normalized.armorModSize) : 10;
  if (!STATS.includes(normalized.armorModStat)) normalized.armorModStat = archetype.secondary;
  normalized.locked = normalized.exotic || Boolean(normalized.locked);
  // Exotic Class Item perks are a fixed roll on the item. Keep them on the
  // piece when known (Bungie API path); CSV-only imports leave them null and
  // the stat frame still distinguishes rolls.
  normalized.primaryPerkId = normalized.primaryPerkId || null;
  normalized.secondaryPerkId = normalized.secondaryPerkId || null;
  normalized.tuningAssignment = Object.freeze({
    mode: normalized.tuningMode,
    from: normalized.tuningFrom,
    to: normalized.tuningTo,
  });
  return normalized;
}

// Build a normalized upgrade piece from an imported DIM item. The real rolled
// stat distribution and the +5 tuning side (masterwork stat) stay on the piece.
// baseStats carries the item's ACTUAL stats so the current-loadout display can
// reproduce DIM. optimizationBaseStats carries the same item projected to full
// masterwork; farming advice uses that projection, matching the from-scratch
// solver's T5/full-masterwork contract.
export function createUpgradePieceFromItem(item, slotIndex) {
  const archetypeId = item.archetypeId
    || inferArchetypeFromStats(item.baseStats)
    || ARCHETYPES[0].id;
  const archetype = ARCHETYPES.find(entry => entry.id === archetypeId) || ARCHETYPES[0];
  const tertiary = item.tertiary && item.tertiary !== archetype.primary && item.tertiary !== archetype.secondary
    ? item.tertiary
    : STATS.find(stat => stat !== archetype.primary && stat !== archetype.secondary);
  const exotic = Boolean(item.exotic);
  const tuningMode = item.tuningMode === "plus3" ? "plus3" : "shift";
  // The +5 destination is rolled onto the piece. For the Bungie path it comes
  // from the installed plug (item.tuningTo) or the fixed tuning stat derived
  // from the tuning socket's reusable plugs (item.tuningStat); for DIM CSV it
  // is the "Tuning Stat" column. When neither is known the piece must NOT fall
  // back to a fabricated direction (handoff 3.4) — it carries tuningUnknown so
  // the plan/equip path can reject "cannot confirm tuning" instead of guessing.
  const tunedStat = !exotic
    ? item.tunedStat || item.tuningTo || item.tuningStat || null
    : null;
  const allowedTuningStats = exotic
    ? normalizeTuningStats(item.allowedTuningStats)
    : tunedStat ? [tunedStat] : null;
  const tuningTo = tuningMode === "plus3"
    ? null
    : item.tuningTo || tunedStat || allowedTuningStats?.[0] || null;
  const tuningUnknown = tuningMode !== "plus3" && !tuningTo;
  const tuningFrom = STATS.includes(item.tuningFrom)
    ? item.tuningFrom
    : (tuningTo ? STATS.find(stat => stat !== tuningTo) : null);
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
    tunedStat,
    tuningUnknown,
    armorModSize,
    armorModStat,
    exotic,
    locked: false,
    baseStats: { ...(
      item.effectiveBaseStats
      || getEffectiveBaseStats({ ...item, archetypeId, tertiary })
    ) },
    optimizationBaseStats: { ...(
      item.optimizationBaseStats
      || getEffectiveBaseStats({
        ...item, archetypeId, tertiary, masterworkTier: 5,
      })
    ) },
    masterworkTier: Number(item.masterworkTier) || 0,
    modifierInference: item.modifierInference || null,
    setHash: item.setHash,
    itemName: item.name,
    sourceId: item.id,
    hash: item.hash,
    primaryPerkId: item.primaryPerkId || null,
    secondaryPerkId: item.secondaryPerkId || null,
    sockets: item.sockets || [],
    energy: item.energy || null,
    allowedTuningStats,
    dataConfidence: item.dataConfidence || null,
  }, slotIndex);
}

export function getUpgradeConfig(piece) {
  const archetype = ARCHETYPES.find(item => item.id === piece.archetypeId) || ARCHETYPES[0];
  const config = BASE_CONFIGS.find(config =>
    config.archetype === archetype.id && config.tertiary === piece.tertiary
  ) || BASE_CONFIGS.find(config => config.archetype === archetype.id);
  // Real armor imported from DIM carries its actual rolled stat distribution;
  // otherwise the theoretical T5 archetype layout is used.
  return piece.baseStats ? { ...config, baseStats: piece.baseStats } : config;
}

export function getArchetypeIdForConfig(config) {
  return normalizeArchetypeId(config.archetype) || ARCHETYPES[0].id;
}

export function applyManualUpgradeModifiers(config, piece) {
  const totals = { ...config.baseStats };
  if (piece.tuningMode === 'plus3') {
    for (const stat of STATS) {
      if (stat !== config.primary && stat !== config.secondary && stat !== config.tertiary) totals[stat] += 1;
    }
  } else if (piece.tuningTo && piece.tuningFrom) {
    // An unknown-tuned imported piece carries null tuning fields and simply
    // contributes its base stats — never a fabricated +5/-5 (handoff 3.4).
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

export function resolveCurrentLoadoutTotals(pieces, fragments, exactTotals = null) {
  const hasCompleteExactTotals = exactTotals
    && STATS.every(stat => Number.isFinite(Number(exactTotals[stat])));
  if (hasCompleteExactTotals) {
    const normalized = Object.fromEntries(STATS.map(stat => [stat, Number(exactTotals[stat])]));
    return finalizeUpgradeTotals(normalized, {});
  }
  return finalizeUpgradeTotals(getManualUpgradeArmorTotals(pieces), fragments);
}

export function getUpgradeModifierBudget(
  pieces,
  { reassignModifiers = false, onlyPlus5Tuning = false } = {},
) {
  const currentNumPlus3 = pieces.filter(piece => piece.tuningMode === 'plus3').length;
  return {
    numPlus3: reassignModifiers ? null : currentNumPlus3,
    currentNumPlus3,
    allowedPlus3Counts: reassignModifiers
      ? onlyPlus5Tuning ? [0] : Array.from({ length: pieces.length + 1 }, (_, count) => count)
      : [currentNumPlus3],
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

// @param armorTarget  armor-needed stat amounts (target minus Fragments)
// @param requiredStats must-meet stat ids (their floors always stay on)
// @param userConstraints optional per-stat fuzzy rules ("至多/至少/区间/精确")
//                        already expressed in the armor-needed domain
function getUpgradeEvaluationConstraints(armorTarget, requiredStats, userConstraints = {}) {
  const minimums = { ...(userConstraints.minimums || {}) };
  const maximums = { ...(userConstraints.maximums || {}) };
  const exact = { ...(userConstraints.exact || {}) };
  // Must-meet floors always stay in effect and win over any fuzzy minimum set
  // for the same stat — EXCEPT for a stat carrying a user cap (至多/区间 upper
  // bound): that cap is a ceiling, not a value to reach, so the all-six-stats
  // pre-check must never pin it to its cap via a mandatory floor.
  for (const stat of requiredStats) {
    if (maximums[stat] !== undefined) continue;
    minimums[stat] = Math.max(minimums[stat] || 0, armorTarget[stat]);
  }
  const hasPriorityLevels = Object.values(userConstraints.priorityLevels || {})
    .some(level => level > 0);
  return {
    ...userConstraints,
    minimums,
    maximums,
    // Upgrade metrics still enforce the user's exact rules through
    // userConstraints. For internal partial-plan scoring, however, leaving all
    // default exact flags enabled would place their aggregate gap ahead of the
    // explicit High/Medium/Low tiers and make those controls ineffective.
    exact: hasPriorityLevels ? {} : exact,
  };
}

// Per-stat target satisfaction for the upgrade path. Rules change what counts
// as "达标": 至多/区间 are ceilings (below is satisfied, above is a violation),
// 至少 keeps the >= floor, and 精确 demands an exact match. Constraints are in
// the armor-needed domain, so the fragment bonus is added back here. Mirrors
// getUpgradeMetrics and the UI's per-stat badges so they can never disagree.
export function satisfiesUpgradeStatRule(stat, finalTotals, targets, constraints = {}, fragments = {}) {
  const value = finalTotals[stat];
  const ceiling = constraints.maximums?.[stat];
  const floor = constraints.minimums?.[stat] || 0;
  const exact = Boolean(constraints.exact?.[stat]);
  const fragment = fragments[stat] || 0;
  if (exact) return value === targets[stat];
  if (ceiling !== undefined && floor > 0) {
    return value >= floor + fragment && value <= ceiling + fragment;
  }
  if (ceiling !== undefined) return value <= ceiling + fragment;
  if (floor > 0) return value >= floor + fragment;
  return value >= targets[stat];
}

export function getUpgradeMetrics(
  finalTotals, targets, score = 0, requiredStats = [], scoreRank = null,
  constraints = {}, fragments = {},
) {
  const normalizedRequiredStats = normalizeRequiredStats(requiredStats);
  // Deficit is rule-aware: an at-most stat below its cap is not "short" at all
  // (the cap is a ceiling, not a value to reach), so the optimizer never pushes
  // it up to the cap and the surplus stays available for other stats.
  const deficits = STATS.map(stat => {
    const final = finalTotals[stat];
    const ceiling = constraints.maximums?.[stat];
    const floor = constraints.minimums?.[stat] || 0;
    const exact = Boolean(constraints.exact?.[stat]);
    const fragment = fragments[stat] || 0;
    if (exact) return Math.abs(final - targets[stat]);
    if (ceiling !== undefined && floor <= 0) return 0;
    if (floor > 0) return Math.max(0, floor + fragment - final);
    return Math.max(0, targets[stat] - final);
  });
  const excesses = STATS.map(stat => {
    const final = finalTotals[stat];
    const ceiling = constraints.maximums?.[stat];
    const exact = Boolean(constraints.exact?.[stat]);
    const fragment = fragments[stat] || 0;
    if (exact) return Math.abs(final - targets[stat]);
    if (ceiling !== undefined) return Math.max(0, final - (ceiling + fragment));
    return Math.max(0, final - targets[stat]);
  });
  const reachedCount = STATS.filter(stat =>
    satisfiesUpgradeStatRule(stat, finalTotals, targets, constraints, fragments)).length;
  const exactCount = STATS.filter(stat => finalTotals[stat] === targets[stat]).length;
  const requiredDeficits = normalizedRequiredStats.map(stat =>
    Math.max(0, targets[stat] - finalTotals[stat]));
  const requiredReachedCount = normalizedRequiredStats.filter(stat =>
    finalTotals[stat] >= targets[stat]).length;
  // Cap/floor rules ("至多/至少/区间") are compared before every reach metric:
  // a loadout that breaches a user-set cap is never reported as "keep current"
  // or picked over one that respects it. Constraints are in the armor-needed
  // domain, so add the fragment bonus back to evaluate the final totals.
  const constraintBoundaryViolations = STATS.filter(stat => {
    const floor = constraints.minimums?.[stat] || 0;
    const ceiling = constraints.maximums?.[stat];
    const fragment = fragments[stat] || 0;
    return (ceiling !== undefined && finalTotals[stat] > ceiling + fragment)
      || (floor > 0 && finalTotals[stat] < floor + fragment);
  }).length;
  const constraintExactViolations = STATS.filter(stat =>
    constraints.exact?.[stat] && finalTotals[stat] !== targets[stat]).length;
  return {
    allReached: reachedCount === STATS.length
      && constraintBoundaryViolations === 0
      && constraintExactViolations === 0,
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
    constraintBoundaryViolations,
    constraintExactViolations,
    scoreRank: Array.isArray(scoreRank) ? [...scoreRank] : null,
    score,
  };
}

export function compareUpgradeMetrics(left, right) {
  const boundaryOrder = (left.constraintBoundaryViolations || 0)
    - (right.constraintBoundaryViolations || 0);
  if (boundaryOrder !== 0) return boundaryOrder;
  if (left.allReached !== right.allReached) return left.allReached ? -1 : 1;
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
  // Once hard boundaries and must-meet stats are tied, preserve the user's
  // explicit High -> Medium -> Low ordering before considering the aggregate
  // unprioritized gap. scoreStatsRank layout is
  // [bounds, exact, high, medium, low, soft]. The exact field is intentionally
  // skipped here: allReached above still makes a fully exact plan win, while a
  // partial fallback must not sacrifice a High stat merely to shave more total
  // points from unprioritized stats.
  if (left.scoreRank || right.scoreRank) {
    for (const index of [2, 3, 4]) {
      const priorityOrder = (left.scoreRank?.[index] || 0)
        - (right.scoreRank?.[index] || 0);
      if (priorityOrder !== 0) return priorityOrder;
    }
  }
  const exactOrder = (left.constraintExactViolations || 0)
    - (right.constraintExactViolations || 0);
  if (exactOrder !== 0) return exactOrder;
  if (left.shortfall !== right.shortfall) return left.shortfall - right.shortfall;
  if (left.maxShortfall !== right.maxShortfall) return left.maxShortfall - right.maxShortfall;
  if (left.reachedCount !== right.reachedCount) return right.reachedCount - left.reachedCount;
  if (left.excess !== right.excess) return left.excess - right.excess;
  if (left.exactCount !== right.exactCount) return right.exactCount - left.exactCount;
  if (left.scoreRank || right.scoreRank) {
    const scoreRankOrder = compareScoreRanks(left.scoreRank, right.scoreRank);
    if (scoreRankOrder !== 0) return scoreRankOrder;
  }
  return 0;
}

export function evaluateUpgradePieces(
  pieces, targets, fragments, reassignModifiers, requiredStats = [], onlyPlus5Tuning = false, userConstraints = {}
) {
  if (onlyPlus5Tuning) pieces = coercePiecesToPlus5Only(pieces);
  const normalizedRequiredStats = normalizeRequiredStats(requiredStats);
  const configs = pieces.map(getUpgradeConfig);
  const armorTarget = Object.fromEntries(STATS.map(stat => [
    stat,
    Math.max(0, targets[stat] - (fragments[stat] || 0))
  ]));
  // 至多/区间 values are CEILINGS, not goals to reach: score them against
  // their floor (0 for a pure at-most) so mods/tuning never park surplus in a
  // capped stat — the points flow to other targets instead.
  const scoringTarget = Object.fromEntries(STATS.map(stat => {
    const ceiling = userConstraints.maximums?.[stat];
    if (ceiling === undefined) return [stat, armorTarget[stat]];
    return [stat, userConstraints.minimums?.[stat] || 0];
  }));
  const constraints = getUpgradeEvaluationConstraints(armorTarget, normalizedRequiredStats, userConstraints);
  const manualArmorTotals = getManualUpgradeArmorTotals(pieces);
  const manualEvaluation = {
    totals: manualArmorTotals,
    tuningAssignments: pieces.map(piece => piece.tuningUnknown
      ? null // no fabricated direction for an unknown-tuned imported piece
      : piece.tuningMode === 'plus3'
        ? { mode:'+3', from:null, to:null }
        : { mode:'+5-5', from:piece.tuningFrom, to:piece.tuningTo }),
    modAssignments: Object.fromEntries(pieces.map((piece, index) => [
      index,
      piece.armorModSize > 0 ? { size:piece.armorModSize, stat:piece.armorModStat } : null
    ])),
    rank: scoreStatsRank(manualArmorTotals, scoringTarget, constraints),
    score: scoreStats(manualArmorTotals, scoringTarget, constraints),
  };
  let evaluation = manualEvaluation;
  if (reassignModifiers) {
    const budget = getUpgradeModifierBudget(pieces, {
      reassignModifiers: true,
      onlyPlus5Tuning,
    });
    const tuningCapabilities = pieces.map(piece =>
      getUpgradeTuningCapability(piece, onlyPlus5Tuning));
    const automaticEvaluation = evaluateConfig(
      configs, scoringTarget, budget.numPlus5, budget.numPlus10, 0, constraints,
      null,
      // The legacy Upgrade outer search evaluates many thousands of candidate
      // sets. It is migrated separately to replacement-count iterative
      // deepening; until then, do not multiply the exact fixed-five DP cost by
      // the old seed/hill-climb loop.
      { skipExactJointSearch: true, tuningCapabilities },
    );
    const manualFinal = finalizeUpgradeTotals(manualEvaluation.totals, fragments);
    const manualMetrics = getUpgradeMetrics(
      manualFinal, targets, manualEvaluation.score, normalizedRequiredStats,
      manualEvaluation.rank, userConstraints, fragments
    );
    if (automaticEvaluation) {
      const automaticFinal = finalizeUpgradeTotals(automaticEvaluation.totals, fragments);
      const automaticMetrics = getUpgradeMetrics(
        automaticFinal, targets, automaticEvaluation.score, normalizedRequiredStats,
        automaticEvaluation.rank, userConstraints, fragments
      );
      if (compareUpgradeMetrics(automaticMetrics, manualMetrics) < 0) {
        evaluation = automaticEvaluation;
      }
    }
  }
  const finalTotals = finalizeUpgradeTotals(evaluation.totals, fragments);
  return {
    ...evaluation,
    configs,
    finalTotals,
    metrics: getUpgradeMetrics(
      finalTotals, targets, evaluation.score, normalizedRequiredStats,
      evaluation.rank, userConstraints, fragments
    ),
  };
}

function createUpgradeEvaluator(targets, fragments, requiredStats, onlyPlus5Tuning = false, userConstraints = {}) {
  const cache = new Map();
  const constraintsKey = JSON.stringify(userConstraints);
  return (pieces, reassignModifiers) => {
    const key = pieces.map(piece => [
      piece.archetypeId,
      piece.tertiary,
      piece.tunedStat,
      piece.allowedTuningStats?.join(',') || "unknown",
      piece.armorModSize,
      ...(reassignModifiers ? [] : [
        piece.tuningMode,
        piece.tuningFrom,
        piece.tuningTo,
        piece.armorModStat,
      ]),
      ...STATS.map(stat => piece.baseStats?.[stat] ?? "farm"),
    ].join(':')).join('|') + '#' + Number(reassignModifiers) + '#' + Number(onlyPlus5Tuning) + '#' + constraintsKey;
    const cached = cache.get(key);
    if (cached) return cached;
    const evaluation = evaluateUpgradePieces(
      pieces, targets, fragments, reassignModifiers, requiredStats, onlyPlus5Tuning, userConstraints
    );
    cache.set(key, evaluation);
    return evaluation;
  };
}

function projectPiecesToFullMasterwork(pieces) {
  return pieces.map(piece => piece.optimizationBaseStats
    ? { ...piece, baseStats: { ...piece.optimizationBaseStats } }
    : { ...piece });
}

const fullTargetSearchCache = new Map();
const MAX_FULL_TARGET_CACHE_ENTRIES = 12;

function getFullTargetSearchKey(
  pieces, targets, fragments, reassignModifiers, onlyPlus5Tuning, userConstraints = {}
) {
  return [
    ...STATS.map(stat => targets[stat] || 0),
    ...STATS.map(stat => fragments[stat] || 0),
    Number(reassignModifiers),
    Number(onlyPlus5Tuning),
    JSON.stringify(userConstraints),
    ...pieces.flatMap(piece => [
      piece.archetypeId,
      piece.tertiary,
      piece.tunedStat,
      piece.allowedTuningStats?.join(',') || "unknown",
      piece.tuningMode,
      piece.tuningFrom,
      piece.tuningTo,
      piece.armorModSize,
      piece.armorModStat,
      Number(Boolean(piece.locked)),
      ...STATS.map(stat => piece.baseStats?.[stat] ?? "farm"),
    ]),
  ].join('|');
}

function cacheFullTargetSearch(key, result) {
  fullTargetSearchCache.set(key, result);
  if (fullTargetSearchCache.size > MAX_FULL_TARGET_CACHE_ENTRIES) {
    fullTargetSearchCache.delete(fullTargetSearchCache.keys().next().value);
  }
}

// A piece's identity for "do I already own this?" purposes. The +5 tuning side
// is rolled onto the armor, so changing it means farming a new piece — it
// belongs here alongside the archetype and tertiary stat. Exotic Class Item
// perks are rolled onto the item too: two rolls with the same frame but
// different perks are different pieces. Perk ids are null when unknown
// (CSV-only import), so the stat frame still distinguishes rolls there.
export function getUpgradePieceIdentity(piece) {
  const config = getUpgradeConfig(piece);
  return {
    archetype: config.archetype,
    tertiary: config.tertiary,
    // Current mode/source/destination belong to the assignment. Only the
    // Legendary roll's immutable directional capability belongs to identity.
    tunedStat: piece.exotic ? null : piece.tunedStat || null,
    primaryPerkId: piece.primaryPerkId || null,
    secondaryPerkId: piece.secondaryPerkId || null,
  };
}

export function sameUpgradeIdentity(left, right) {
  return left.archetype === right.archetype &&
    left.tertiary === right.tertiary &&
    left.tunedStat === right.tunedStat &&
    left.primaryPerkId === right.primaryPerkId &&
    left.secondaryPerkId === right.secondaryPerkId;
}

export function sameUpgradeConfig(left, right) {
  return left?.archetype === right?.archetype && left?.tertiary === right?.tertiary;
}

export function setUpgradePieceConfig(piece, slotIndex, config) {
  // Replacement candidates are freshly farmed pieces, so real-stat fields
  // from an imported owned piece must not leak into the hypothetical config.
  const hypothetical = { ...piece };
  delete hypothetical.baseStats;
  delete hypothetical.optimizationBaseStats;
  delete hypothetical.masterworkStats;
  delete hypothetical.setHash;
  delete hypothetical.itemName;
  delete hypothetical.sourceId;
  delete hypothetical.hash;
  delete hypothetical.masterworkTier;
  delete hypothetical.modifierInference;
  delete hypothetical.tunedStat;
  delete hypothetical.tuningStat;
  delete hypothetical.allowedTuningStats;
  // A farmed class item has no fixed perk roll, so the source piece's perks
  // must not carry into the replacement candidate's identity.
  delete hypothetical.primaryPerkId;
  delete hypothetical.secondaryPerkId;
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
  // Reaching the complete target is always the primary objective, regardless
  // of which fallback priorities the user selected.
  if (left.metrics.allReached !== right.metrics.allReached) {
    return left.metrics.allReached ? -1 : 1;
  }
  if (left.metrics.allReached && left.replacementCount !== right.replacementCount) {
    return left.replacementCount - right.replacementCount;
  }
  // Only partial plans reach this block. Required stats then define their
  // fallback priority before overall distance and farming cost.
  const hasRequiredStats = Math.max(
    left.metrics.requiredCount || 0, right.metrics.requiredCount || 0
  ) > 0;
  if (hasRequiredStats) {
    if (left.metrics.requiredAllReached !== right.metrics.requiredAllReached) {
      return left.metrics.requiredAllReached ? -1 : 1;
    }
    if (left.metrics.requiredShortfall !== right.metrics.requiredShortfall) {
      return left.metrics.requiredShortfall - right.metrics.requiredShortfall;
    }
    if (left.metrics.requiredMaxShortfall !== right.metrics.requiredMaxShortfall) {
      return left.metrics.requiredMaxShortfall - right.metrics.requiredMaxShortfall;
    }
    if (left.metrics.requiredReachedCount !== right.metrics.requiredReachedCount) {
      return right.metrics.requiredReachedCount - left.metrics.requiredReachedCount;
    }
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
  return createCanonicalId(left).localeCompare(createCanonicalId(right));
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
    let bestRank = null;
    for (let tertiaryIndex = 0; tertiaryIndex < 4; tertiaryIndex++) {
      const config = BASE_CONFIGS[archetypeIndex * 4 + tertiaryIndex];
      const completedCount = lockedConfigs.length + selected.length + 1;
      const rank = [0, 0];
      for (const stat of STATS) {
        const actual = partialTotals[stat] + config.baseStats[stat];
        // Compare in fifths instead of multiplying the target by a fractional
        // prefix ratio. Squaring scales every candidate at this depth equally
        // while keeping the canonical tuple strictly integral.
        const difference = actual * 5 - armorTarget[stat] * completedCount;
        const penalty = difference < 0
          ? difference * difference * 3
          : difference * difference;
        rank[requiredSet.has(stat) ? 0 : 1] += penalty;
      }
      if (!bestRank || compareIntegerTuples(rank, bestRank) < 0) {
        bestRank = rank;
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
    if (piece.exotic) {
      variants.push(normalizeUpgradePiece({
        ...configured,
        tuningMode: onlyPlus5Tuning ? 'shift' : configured.tuningMode,
        allowedTuningStats: normalizeTuningStats(piece.allowedTuningStats) || [...STATS],
      }, slotIndex));
      continue;
    }
    for (const tunedStat of STATS) {
      variants.push(normalizeUpgradePiece({
        ...configured,
        tunedStat,
        allowedTuningStats: [tunedStat],
        tuningMode: 'shift',
        tuningTo: tunedStat,
      }, slotIndex));
    }
  }
  return variants;
}

export function refineUpgradePlanPieces(
  seedPieces, unlockedIndices, targets, fragments, reassignModifiers,
  evaluatePieces = (candidatePieces, shouldReassign) => evaluateUpgradePieces(
    candidatePieces, targets, fragments, shouldReassign
  ),
  onlyPlus5Tuning = false,
  equippedPieces = seedPieces
) {
  let bestPieces = seedPieces.map(piece => ({ ...piece }));
  let bestEvaluation = evaluatePieces(bestPieces, reassignModifiers);
  let bestReplacements = getUpgradeReplacements(equippedPieces, bestPieces);
  let bestReplacementCount = bestReplacements.length;
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
        const trialReplacements = getUpgradeReplacements(equippedPieces, trialPieces);
        const trialReplacementCount = trialReplacements.length;
        const trialEvaluation = evaluatePieces(trialPieces, reassignModifiers);
        // Stay within the seed's real swap budget and apply the same ordering
        // used by final plan selection. In particular, fewer swaps may win
        // after hard constraints are equally satisfied, but may never break a
        // must-meet target just to reduce the count.
        const improvesWithinSwapBudget = trialReplacementCount <= bestReplacementCount
          && compareUpgradePlans({
            evaluation: trialEvaluation,
            metrics: trialEvaluation.metrics,
            replacements: trialReplacements,
            replacementCount: trialReplacementCount,
          }, {
            evaluation: bestEvaluation,
            metrics: bestEvaluation.metrics,
            replacements: bestReplacements,
            replacementCount: bestReplacementCount,
          }) < 0;
        if (improvesWithinSwapBudget) {
          bestPieces = trialPieces;
          bestEvaluation = trialEvaluation;
          bestReplacements = trialReplacements;
          bestReplacementCount = trialReplacementCount;
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
  const replacementSlots = new Set(remaining.map(replacement => replacement.slotIndex));
  const steps = [];
  // The plan's final tuning/mod layout is slotted in from the start, so each
  // step's stats are exactly what the player sees after doing that one swap.
  // Re-optimizing the mods per step instead would print numbers that no
  // printed configuration can reproduce.
  const configuredFinal = applyUpgradeEvaluationToPieces(finalPieces, finalEvaluation);
  // Retained pieces can adopt the final assignment immediately. A slot still
  // awaiting a physical replacement keeps its current Tuning assignment until
  // the replacement is installed, because its old tunedStat may differ.
  let currentPieces = originalPieces.map((piece, index) => {
    const final = configuredFinal[index];
    const assignment = replacementSlots.has(index) ? piece : final;
    return normalizeUpgradePiece({
      ...piece,
      tuningMode: assignment.tuningMode,
      tuningFrom: assignment.tuningFrom,
      tuningTo: assignment.tuningTo,
      armorModSize: final.armorModSize,
      armorModStat: final.armorModStat,
    }, index);
  });

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

// The from-scratch solver has an independent exact-target oracle before its
// fuzzy fallback, so an exact result is a valid feasibility witness. Convert
// such a witness back into real upgrade pieces, while retaining owned
// Legendary armor only when its frame, tertiary, and immutable tunedStat all
// match. Installed mode/source/destination are assignment state.
function findFromScratchUpgradeWitness(
  pieces, targets, fragments, reassignModifiers, requiredStats, userConstraints,
  evaluatePieces, onlyPlus5Tuning = false,
) {
  if (!reassignModifiers) return null;
  // runSolver can pin one arbitrary-stat Exotic config. Additional locked
  // Legendary pieces have instance-specific base stats and fixed +5 rolls that
  // its from-scratch model cannot represent, so the existing constrained
  // upgrade search remains authoritative for those loadouts.
  if (pieces.some(piece => piece.locked && !piece.exotic)) return null;
  const exoticIndices = pieces
    .map((piece, index) => piece.exotic ? index : -1)
    .filter(index => index >= 0);
  if (exoticIndices.length > 1) return null;

  const armorTarget = Object.fromEntries(STATS.map(stat => [
    stat,
    Math.max(0, targets[stat] - (fragments[stat] || 0)),
  ]));
  const scoringTarget = Object.fromEntries(STATS.map(stat => [
    stat,
    userConstraints.maximums?.[stat] === undefined
      ? armorTarget[stat]
      : userConstraints.minimums?.[stat] || 0,
  ]));
  const constraints = getUpgradeEvaluationConstraints(
    armorTarget, requiredStats, userConstraints
  );
  const budget = getUpgradeModifierBudget(pieces, {
    reassignModifiers: true,
    onlyPlus5Tuning,
  });
  const exoticIndex = exoticIndices[0];
  const exoticSettings = exoticIndex === undefined
    ? null
    : { config: getUpgradeConfig(pieces[exoticIndex]) };
  const solutions = budget.allowedPlus3Counts.flatMap(numPlus3 =>
    runSolver(createProblemSpec({
      operation: "solve",
      target: scoringTarget,
      constraints,
      targetDomain: STAT_DOMAIN.ARMOR,
      numPlus5: budget.numPlus5,
      numPlus10: budget.numPlus10,
      numPlus3,
      pieces: exoticSettings?.config ? [exoticSettings.config] : [],
      exoticSettings,
      runtimeOptions: { maxExactSolutions: 1 },
    })));
  let bestPlan = null;

  for (const solution of solutions) {
    if (solution.config.length !== pieces.length) continue;
    const descriptorBySlot = Array(pieces.length).fill(-1);
    const remainingSlots = pieces.map((_, index) => index);
    const remainingDescriptors = solution.config.map((_, index) => index);
    if (exoticIndex !== undefined) {
      if (solution.exoticIndex !== 0) continue;
      descriptorBySlot[exoticIndex] = 0;
      remainingSlots.splice(remainingSlots.indexOf(exoticIndex), 1);
      remainingDescriptors.shift();
    } else if (solution.exoticIndex !== null) {
      continue;
    }

    const visitAssignments = depth => {
      if (depth < remainingSlots.length) {
        const slotIndex = remainingSlots[depth];
        for (let index = depth; index < remainingDescriptors.length; index++) {
          [remainingDescriptors[depth], remainingDescriptors[index]] =
            [remainingDescriptors[index], remainingDescriptors[depth]];
          descriptorBySlot[slotIndex] = remainingDescriptors[depth];
          visitAssignments(depth + 1);
          [remainingDescriptors[depth], remainingDescriptors[index]] =
            [remainingDescriptors[index], remainingDescriptors[depth]];
        }
        return;
      }

      let compatible = true;
      const mappedPieces = pieces.map((piece, slotIndex) => {
        const descriptorIndex = descriptorBySlot[slotIndex];
        const config = solution.config[descriptorIndex];
        const tuning = solution.tuningAssignments[descriptorIndex];
        const mod = solution.modAssignments[descriptorIndex];
        const tuningMode = tuning?.mode === '+3' ? 'plus3' : 'shift';
        const currentConfig = getUpgradeConfig(piece);
        const capability = getUpgradeTuningCapability(piece, onlyPlus5Tuning);
        const keepsOwnedPiece = sameUpgradeConfig(currentConfig, config)
          && (tuningMode === 'plus3'
            ? capability.allowBalanced
            : capability.allowedDirectionalStats?.includes(tuning?.to));
        if (piece.locked && !keepsOwnedPiece) compatible = false;
        const configured = keepsOwnedPiece
          ? { ...piece }
          : setUpgradePieceConfig(piece, slotIndex, config);
        return normalizeUpgradePiece({
          ...configured,
          tunedStat: configured.exotic
            ? null
            : keepsOwnedPiece
              ? configured.tunedStat
              : tuningMode === 'shift' ? tuning?.to : STATS[0],
          allowedTuningStats: configured.exotic
            ? configured.allowedTuningStats
            : [keepsOwnedPiece
              ? configured.tunedStat
              : tuningMode === 'shift' ? tuning?.to : STATS[0]],
          tuningMode,
          tuningFrom: tuning?.from || configured.tuningFrom,
          tuningTo: tuning?.to || configured.tuningTo,
          armorModSize: mod?.size || 0,
          armorModStat: mod?.stat || configured.armorModStat,
        }, slotIndex);
      });
      if (!compatible) return;

      // Re-evaluate the materialized pieces without another heuristic pass.
      // This both validates imported/non-theoretical base stats and preserves
      // the exact tuning/mod assignment that proved feasibility.
      const evaluation = evaluatePieces(mappedPieces, false);
      if (!evaluation.metrics.allReached) return;
      const replacements = getUpgradeReplacements(pieces, mappedPieces);
      const plan = {
        pieces: mappedPieces,
        evaluation,
        metrics: evaluation.metrics,
        replacements,
        replacementCount: replacements.length,
      };
      if (compareUpgradePlans(plan, bestPlan) < 0) bestPlan = plan;
    };

    visitAssignments(0);
  }

  if (bestPlan) {
    bestPlan.steps = buildUpgradePlanSteps(
      pieces, bestPlan.pieces, targets, fragments, bestPlan.evaluation,
      evaluatePieces
    );
  }
  return bestPlan;
}

function replacementSubsets(indices, count) {
  const result = [];
  const chosen = [];
  const visit = start => {
    if (chosen.length === count) {
      result.push([...chosen]);
      return;
    }
    for (let index = start; index < indices.length; index++) {
      chosen.push(indices[index]);
      visit(index + 1);
      chosen.pop();
    }
  };
  visit(0);
  return result;
}

function visitPermutations(values, visit, depth = 0) {
  if (depth === values.length) {
    visit(values);
    return;
  }
  for (let index = depth; index < values.length; index++) {
    [values[depth], values[index]] = [values[index], values[depth]];
    visitPermutations(values, visit, depth + 1);
    [values[depth], values[index]] = [values[index], values[depth]];
  }
}

function findExactUpgradePlanIterative(
  pieces, targets, fragments, reassignModifiers, evaluatePieces,
  onlyPlus5Tuning, userConstraints = {},
) {
  if (!reassignModifiers) return null;
  const exactPointModelComplete = STATS.every(stat =>
    userConstraints.exact?.[stat] === true
    && targets[stat] > 0
    && targets[stat] < 200);
  // This producer searches one exact Armor-domain point. Fuzzy rules and the
  // visible 0/200 clamp describe intervals, so they belong to the bounded
  // fallback until an interval-complete replacement oracle exists.
  if (!exactPointModelComplete) return null;
  const unlocked = pieces
    .map((piece, index) => piece.locked ? -1 : index)
    .filter(index => index >= 0);
  const armorTarget = Object.fromEntries(STATS.map(stat => [
    stat,
    targets[stat] - (fragments[stat] || 0),
  ]));
  const budget = getUpgradeModifierBudget(pieces, {
    reassignModifiers: true,
    onlyPlus5Tuning,
  });
  const tuningModelComplete = pieces.every(piece =>
    getUpgradeTuningCapability(piece, onlyPlus5Tuning).complete);
  const proofModelComplete = tuningModelComplete && exactPointModelComplete;

  for (let replacementDepth = 0; replacementDepth <= unlocked.length; replacementDepth++) {
    let bestAtDepth = null;
    for (const replacementSlots of replacementSubsets(unlocked, replacementDepth)) {
      const replacementSet = new Set(replacementSlots);
      const fixed = pieces
        .map((piece, slotIndex) => ({ piece, slotIndex }))
        .filter(({ slotIndex }) => !replacementSet.has(slotIndex));
      const fixedEntries = fixed.map(({ piece }) => {
        const capability = getUpgradeTuningCapability(piece, onlyPlus5Tuning);
        return {
          config: getUpgradeConfig(piece),
          allowBalanced: capability.allowBalanced,
          allowedDirectionalStats: capability.allowedDirectionalStats,
        };
      });
      const allowedFreePlus3Counts = onlyPlus5Tuning
        ? [0]
        : Array.from({ length: replacementDepth + 1 }, (_, count) => count);
      const witnesses = findExactPartialConfigWitnesses({
        fixedEntries,
        freePieceCount: replacementDepth,
        target: armorTarget,
        numPlus5: budget.numPlus5,
        numPlus10: budget.numPlus10,
        allowedFreePlus3Counts,
        // This is an existential query at the current depth. One witness is
        // sufficient; depths with no witness are still enumerated completely.
        maxWitnesses: 1,
      });

      for (const witness of witnesses) {
        const fixedCount = fixed.length;
        const freeDescriptors = Array.from(
          { length: replacementDepth },
          (_, index) => fixedCount + index,
        );
        visitPermutations(freeDescriptors, descriptorOrder => {
          const mapped = pieces.map(piece => ({ ...piece }));
          const applyDescriptor = (slotIndex, descriptorIndex, keepOwned) => {
            const config = witness.config[descriptorIndex];
            const tuning = witness.tuningAssignments[descriptorIndex];
            const mod = witness.modAssignments[descriptorIndex];
            const configured = keepOwned
              ? mapped[slotIndex]
              : setUpgradePieceConfig(mapped[slotIndex], slotIndex, config);
            mapped[slotIndex] = normalizeUpgradePiece({
              ...configured,
              tunedStat: configured.exotic
                ? null
                : keepOwned
                  ? configured.tunedStat
                  : tuning.mode === "+5-5" ? tuning.to : STATS[0],
              allowedTuningStats: configured.exotic
                ? configured.allowedTuningStats
                : [keepOwned
                  ? configured.tunedStat
                  : tuning.mode === "+5-5" ? tuning.to : STATS[0]],
              tuningMode: tuning.mode === "+3" ? "plus3" : "shift",
              tuningFrom: tuning.from,
              tuningTo: tuning.to,
              tuningUnknown: false,
              armorModSize: mod?.size || 0,
              armorModStat: mod?.stat || configured.armorModStat,
            }, slotIndex);
          };
          fixed.forEach(({ slotIndex }, descriptorIndex) =>
            applyDescriptor(slotIndex, descriptorIndex, true));
          replacementSlots.forEach((slotIndex, index) =>
            applyDescriptor(slotIndex, descriptorOrder[index], false));

          const evaluation = evaluatePieces(mapped, false);
          if (!evaluation.metrics.allReached) return;
          const replacements = getUpgradeReplacements(pieces, mapped);
          if (replacements.length > replacementDepth) return;
          const plan = {
            pieces: mapped,
            evaluation,
            metrics: evaluation.metrics,
            replacements,
            replacementCount: replacements.length,
            replacementProof: {
              method: "replacement-count-iterative-deepening",
              examinedThrough: replacementDepth,
              complete: proofModelComplete,
              ...(proofModelComplete ? { minimal: true } : {
                limitation: !tuningModelComplete
                  ? "one or more Tuning capabilities are unknown"
                  : "minimum proof requires six exact, non-clamped visible rules",
              }),
            },
          };
          if (!bestAtDepth || compareUpgradePlans(plan, bestAtDepth) < 0) {
            bestAtDepth = plan;
          }
        });
      }
    }
    if (bestAtDepth) {
      bestAtDepth.steps = buildUpgradePlanSteps(
        pieces,
        bestAtDepth.pieces,
        targets,
        fragments,
        bestAtDepth.evaluation,
        evaluatePieces,
      );
      return bestAtDepth;
    }
  }
  return null;
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
  const deferredBalancedSeeds = new Map();
  const seenSeedKeys = new Set();
  const hasPartialRequiredStats = requiredStats.length > 0
    && requiredStats.length < STATS.length;
  let bestPlan = null;

  const getSeedKey = mappedPieces => mappedPieces.map(piece => [
    piece.archetypeId,
    piece.tertiary,
    piece.tunedStat,
    piece.allowedTuningStats?.join(',') || "unknown",
    ...(reassignModifiers ? [] : [piece.tuningMode, piece.tuningFrom, piece.tuningTo]),
    ...STATS.map(stat => piece.baseStats?.[stat] ?? "farm"),
  ].join(':')).join('|');

  function addSeed(mappedPieces, strategy = "focused") {
    const seedKey = getSeedKey(mappedPieces);
    if (seenSeedKeys.has(seedKey)) return;
    seenSeedKeys.add(seedKey);
    const evaluation = evaluatePieces(mappedPieces, reassignModifiers);
    const replacements = getUpgradeReplacements(pieces, mappedPieces);
    const seedPlan = {
      pieces: mappedPieces,
      evaluation,
      metrics: evaluation.metrics,
      replacements,
      replacementCount: replacements.length,
    };
    const bucketKey = `${seedPlan.replacementCount}|${strategy}`;
    const seeds = seedPlansByReplacementCount.get(bucketKey) || [];
    seeds.push(seedPlan);
    seeds.sort(compareUpgradePlans);
    const bucketLimit = hasPartialRequiredStats || strategy === "single" ? 8 : 16;
    if (seeds.length > bucketLimit) seeds.length = bucketLimit;
    seedPlansByReplacementCount.set(bucketKey, seeds);
  }

  function deferBalancedSeed(mappedPieces) {
    const replacementCount = getUpgradeReplacements(pieces, mappedPieces).length;
    const roughEvaluation = evaluatePieces(mappedPieces, false);
    const candidates = deferredBalancedSeeds.get(replacementCount) || [];
    candidates.push({ pieces: mappedPieces, roughEvaluation });
    candidates.sort((left, right) => compareUpgradeMetrics(
      left.roughEvaluation.metrics, right.roughEvaluation.metrics
    ));
    if (candidates.length > 32) candidates.length = 32;
    deferredBalancedSeeds.set(replacementCount, candidates);
  }

  function evaluateArchetypeSet(archetypeIndices) {
    const focusedConfigs = chooseUpgradeTertiaries(
      archetypeIndices, lockedConfigs, armorTarget, requiredStats
    );
    addSeed(mapUpgradeConfigsToPieces(pieces, unlockedIndices, focusedConfigs));
    if (hasPartialRequiredStats) {
      const balancedConfigs = chooseUpgradeTertiaries(
        archetypeIndices, lockedConfigs, armorTarget, []
      );
      deferBalancedSeed(
        mapUpgradeConfigsToPieces(pieces, unlockedIndices, balancedConfigs)
      );
    }
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
  for (const candidates of deferredBalancedSeeds.values()) {
    for (const candidate of candidates) addSeed(candidate.pieces, "balanced");
  }
  // The archetype sweep replaces every unlocked slot, so it never proposes
  // "keep this piece's archetype, just farm a different rolled +5". Those
  // single-slot candidates come in as extra seeds.
  for (const seedPieces of extraSeedPieces) addSeed(seedPieces, "single");
  for (const seeds of seedPlansByReplacementCount.values()) {
    for (const seed of seeds) {
      const refined = refineUpgradePlanPieces(
        seed.pieces, unlockedIndices, targets, fragments, reassignModifiers,
        evaluatePieces, onlyPlus5Tuning, pieces
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

function rankSingleUpgradeCandidates(
  pieces, baseline, reassignModifiers, evaluatePieces, onlyPlus5Tuning
) {
  const rankings = [];
  if (baseline.metrics.allReached) return rankings;
  for (let slotIndex = 0; slotIndex < pieces.length; slotIndex++) {
    if (pieces[slotIndex].locked) continue;
    const currentIdentity = getUpgradePieceIdentity(pieces[slotIndex]);
    let bestForSlot = null;
    // Every archetype, tertiary, and rolled +5 stat is a distinct piece to
    // farm, so all three vary here.
    for (const variant of getUpgradeSlotVariants(
      pieces[slotIndex], slotIndex, null, onlyPlus5Tuning
    )) {
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
        tuningOnly: sameUpgradeConfig(
          getUpgradeConfig(variant), getUpgradeConfig(pieces[slotIndex])
        ),
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
  return rankings;
}

function getSingleSwapSeeds(pieces, rankings) {
  return rankings.slice(0, 8).map(candidate =>
    pieces.map((piece, index) => index === candidate.slotIndex
      ? { ...candidate.afterPiece } : { ...piece }));
}

export function analyzeUpgradeCandidates(
  pieces, targets, fragments, reassignModifiers, requiredStats = [], onlyPlus5Tuning = false, userConstraints = {}
) {
  const normalizedRequiredStats = normalizeRequiredStats(requiredStats);
  // "Only +5/-5" applies to every plan this analysis proposes: the owned +3
  // pieces are read as +5/-5 pieces up front, so no seed, refinement, plan
  // piece, or step summary can carry +3 into the output. Only the entered
  // baseline keeps reporting the real +3 pieces as they are.
  const enteredPieces = pieces.map(piece => ({ ...piece }));
  const projectedMasterworkIndices = enteredPieces
    .map((piece, index) => piece.optimizationBaseStats && STATS.some(stat =>
      piece.optimizationBaseStats[stat] !== piece.baseStats?.[stat]
    ) ? index : -1)
    .filter(index => index >= 0);
  pieces = projectPiecesToFullMasterwork(enteredPieces);
  if (onlyPlus5Tuning) pieces = coercePiecesToPlus5Only(pieces);
  const evaluatePieces = createUpgradeEvaluator(
    targets, fragments, normalizedRequiredStats, onlyPlus5Tuning, userConstraints
  );
  const enteredBaseline = onlyPlus5Tuning
    ? evaluateUpgradePieces(enteredPieces, targets, fragments, false, normalizedRequiredStats, false, userConstraints)
    : evaluatePieces(enteredPieces, false);
  const baseline = evaluatePieces(pieces, reassignModifiers);
  let rankings = [];
  let plan = null;
  if (!baseline.metrics.allReached) {
    plan = findExactUpgradePlanIterative(
      pieces,
      targets,
      fragments,
      reassignModifiers,
      evaluatePieces,
      onlyPlus5Tuning,
      userConstraints,
    );
    if (!plan) {
    // Full-target feasibility is invariant under the UI's fallback-priority
    // checkboxes. Always run the same all-six-stats search first; only if it
    // cannot reach the complete target may selected required stats steer the
    // fallback search.
    const allStatsRequired = normalizedRequiredStats.length === STATS.length;
    const fullTargetCacheKey = getFullTargetSearchKey(
      pieces, targets, fragments, reassignModifiers, onlyPlus5Tuning, userConstraints
    );
    let fullTargetSearch = fullTargetSearchCache.get(fullTargetCacheKey);
    if (!fullTargetSearch) {
      const fullTargetEvaluator = allStatsRequired
        ? evaluatePieces
        : createUpgradeEvaluator(targets, fragments, STATS, onlyPlus5Tuning, userConstraints);
      const fullTargetBaseline = allStatsRequired
        ? baseline
        : fullTargetEvaluator(pieces, reassignModifiers);
      const fullTargetRankings = rankSingleUpgradeCandidates(
        pieces, fullTargetBaseline, reassignModifiers,
        fullTargetEvaluator, onlyPlus5Tuning
      );
      const fullTargetSeeds = getSingleSwapSeeds(pieces, fullTargetRankings);
      let fullTargetPlan = findUpgradeCompletionPlan(
        pieces, targets, fragments, reassignModifiers, fullTargetBaseline,
        fullTargetSeeds, STATS, fullTargetEvaluator, onlyPlus5Tuning
      );
      // Keep the upgrade-specific search when it already found an exact plan:
      // it is better at minimizing replacements and retaining owned random +5
      // rolls. Only ask the complete from-scratch solver for a feasibility
      // witness when the local search would otherwise claim no exact plan.
      if (!fullTargetPlan?.metrics.allReached) {
        const scratchWitness = findFromScratchUpgradeWitness(
          pieces, targets, fragments, reassignModifiers, STATS, userConstraints,
          fullTargetEvaluator, onlyPlus5Tuning,
        );
        if (scratchWitness && compareUpgradePlans(scratchWitness, fullTargetPlan) < 0) {
          fullTargetPlan = scratchWitness;
        }
      }
      fullTargetSearch = { plan: fullTargetPlan, rankings: fullTargetRankings };
      cacheFullTargetSearch(fullTargetCacheKey, fullTargetSearch);
    }
    const fullTargetPlan = fullTargetSearch.plan;
    if (allStatsRequired) rankings = fullTargetSearch.rankings;

    if (fullTargetPlan?.metrics.allReached) {
      if (allStatsRequired) {
        plan = fullTargetPlan;
      } else {
        // Materialize the exact tuning/mod witness found by the full-target
        // pass, then classify its metrics using only the user's selected
        // fallback priorities. This prevents a second heuristic evaluation
        // from losing an already-proven exact assignment.
        const configuredPieces = applyUpgradeEvaluationToPieces(
          fullTargetPlan.pieces, fullTargetPlan.evaluation
        );
        const evaluation = evaluatePieces(configuredPieces, false);
        const replacements = getUpgradeReplacements(pieces, configuredPieces);
        plan = {
          pieces: configuredPieces,
          evaluation,
          metrics: evaluation.metrics,
          replacements,
          replacementCount: replacements.length,
        };
        plan.steps = buildUpgradePlanSteps(
          pieces, configuredPieces, targets, fragments, evaluation, evaluatePieces
        );
      }
    } else if (allStatsRequired) {
      plan = fullTargetPlan;
    } else {
      rankings = rankSingleUpgradeCandidates(
        pieces, baseline, reassignModifiers, evaluatePieces, onlyPlus5Tuning
      );
      const singleSwapSeeds = getSingleSwapSeeds(pieces, rankings);
      plan = findUpgradeCompletionPlan(
        pieces, targets, fragments, reassignModifiers, baseline, singleSwapSeeds,
        normalizedRequiredStats, evaluatePieces, onlyPlus5Tuning
      );
    }
    }
  }
  const bestCandidate = rankings[0] || null;
  const best = bestCandidate && compareUpgradeMetrics(bestCandidate.metrics, baseline.metrics) < 0
    ? bestCandidate : null;
  return {
    pieces: enteredPieces,
    targets: { ...targets },
    fragments: { ...fragments },
    requiredStats: normalizedRequiredStats,
    constraints: { ...userConstraints },
    reassignModifiers,
    projectedMasterworkIndices,
    enteredBaseline,
    baseline,
    rankings,
    best,
    plan,
  };
}
