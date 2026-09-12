import { ARCHETYPES, BASE_CONFIGS, STATS, getMasterworkStats } from "./armor-model.mjs";

export const SOLVER_V3_SCHEMA_VERSION = 3;

export const RESULT_STATUS = Object.freeze({
  EXACT_TARGET_PROVEN: "EXACT_TARGET_PROVEN",
  RULE_FEASIBLE_PROVEN: "RULE_FEASIBLE_PROVEN",
  INFEASIBLE_PROVEN: "INFEASIBLE_PROVEN",
  SEARCH_LIMIT_REACHED: "SEARCH_LIMIT_REACHED",
  INVALID_INPUT: "INVALID_INPUT",
});

export const EXECUTION_STATUS = Object.freeze({
  VERIFIED: "VERIFIED",
  UNVERIFIED: "UNVERIFIED",
  BLOCKED: "BLOCKED",
  NOT_APPLICABLE: "NOT_APPLICABLE",
});

export const STAT_DOMAIN = Object.freeze({
  ARMOR: "armor",
  VISIBLE: "visible",
});

const RESULT_STATUS_VALUES = new Set(Object.values(RESULT_STATUS));
const EXECUTION_STATUS_VALUES = new Set(Object.values(EXECUTION_STATUS));

// Only evidence issued at an internal producer boundary can authorize a
// negative certificate. Serialized certificates are audit records, not bearer
// tokens: copying their fields must not authorize a new result certificate.
const issuedProofEvidence = new WeakSet();
const PROOF_PRODUCERS = Object.freeze({
  "exact-target-oracle": ["exact-target-oracle"],
  "reachability-dp": ["point-rule-dynamic-programming", "interval-complete-dynamic-programming", "budget-reduced-interval-oracle"],
  "inventory-frontier": ["complete-inventory-frontier"],
  "global-fuzzy-enumeration": ["complete-global-fuzzy-enumeration"],
});

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function finiteInteger(value) {
  if (value === null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function normalizeInteger(value, fallback, path, errors, { minimum, maximum } = {}) {
  const normalized = value === undefined ? fallback : finiteInteger(value);
  if (normalized === null) {
    errors.push(`${path} must be a safe integer`);
    return fallback;
  }
  if (minimum !== undefined && normalized < minimum) {
    errors.push(`${path} must be >= ${minimum}`);
  }
  if (maximum !== undefined && normalized > maximum) {
    errors.push(`${path} must be <= ${maximum}`);
  }
  return normalized;
}

export function clampVisibleStat(value) {
  return Math.max(0, Math.min(200, value));
}

export function visibleStatFromArmor(armorValue, fragmentValue = 0) {
  return clampVisibleStat(armorValue + fragmentValue);
}

export function statObjectFromVector(vector) {
  return Object.fromEntries(STATS.map((stat, index) => [stat, vector[index]]));
}

export function statVectorFromObject(values = {}, fallback = 0) {
  return STATS.map(stat => own(values, stat) ? Number(values[stat]) : fallback);
}

function normalizeStatObject(values, fallback, path, errors) {
  return Object.fromEntries(STATS.map(stat => [
    stat,
    normalizeInteger(values?.[stat], fallback, `${path}.${stat}`, errors),
  ]));
}

function translateVisibleBoundsToArmor(minimum, maximum, fragment) {
  // Visible stats are clamp(armor + fragment, 0, 200). At the two clamp
  // boundaries, equality is an interval in the unclamped armor domain.
  const armorMinimum = minimum === null || minimum <= 0
    ? null
    : minimum - fragment;
  const armorMaximum = maximum === null || maximum >= 200
    ? null
    : maximum - fragment;
  return { minimum: armorMinimum, maximum: armorMaximum };
}

function createStatRule(stat, target, fragment, constraints, targetDomain, errors) {
  const targetValue = target[stat];
  const exact = Boolean(constraints.exact?.[stat]);
  const forceZero = Boolean(constraints.force0?.[stat]);
  const legacyCap = Boolean(constraints.le100?.[stat]);
  const visibleLimits = targetDomain === STAT_DOMAIN.VISIBLE
    ? { minimum: 0, maximum: 200 }
    : {};
  let minimum = own(constraints.minimums, stat)
    ? normalizeInteger(
      constraints.minimums[stat],
      0,
      `constraints.minimums.${stat}`,
      errors,
      visibleLimits,
    )
    : null;
  let maximum = own(constraints.maximums, stat)
    ? normalizeInteger(
      constraints.maximums[stat],
      200,
      `constraints.maximums.${stat}`,
      errors,
      visibleLimits,
    )
    : null;

  if (exact) {
    minimum = Math.max(minimum ?? targetValue, targetValue);
    maximum = Math.min(maximum ?? targetValue, targetValue);
  }
  if (forceZero) {
    minimum = Math.max(minimum ?? 0, 0);
    maximum = Math.min(maximum ?? 0, 0);
  }
  if (legacyCap) maximum = Math.min(maximum ?? 100, 100);

  const visibleBounds = targetDomain === STAT_DOMAIN.VISIBLE
    ? { minimum, maximum }
    : {
      minimum: minimum === null ? null : visibleStatFromArmor(minimum, fragment),
      maximum: maximum === null ? null : visibleStatFromArmor(maximum, fragment),
    };
  const armorBounds = targetDomain === STAT_DOMAIN.ARMOR
    ? { minimum, maximum }
    : translateVisibleBoundsToArmor(minimum, maximum, fragment);

  if (minimum !== null && maximum !== null && minimum > maximum) {
    errors.push(`constraints for ${stat} have minimum greater than maximum`);
  }

  const priority = normalizeInteger(
    constraints.priorityLevels?.[stat],
    constraints.priorityOrder?.includes(stat) ? Math.min(3, constraints.priorityOrder.indexOf(stat) + 1)
      : constraints.priorities?.[stat] ? 1 : 0,
    `constraints.priorityLevels.${stat}`,
    errors,
    { minimum: 0, maximum: 3 },
  );

  return {
    stat,
    target: targetValue,
    preferredArmor: targetDomain === STAT_DOMAIN.ARMOR
      ? targetValue
      : targetValue - fragment,
    preferredVisible: targetDomain === STAT_DOMAIN.VISIBLE
      ? targetValue
      : visibleStatFromArmor(targetValue, fragment),
    fragment,
    exact,
    priority,
    armorMinimum: armorBounds.minimum,
    armorMaximum: armorBounds.maximum,
    visibleMinimum: visibleBounds.minimum,
    visibleMaximum: visibleBounds.maximum,
  };
}

export function createConstraintModel({
  target = {},
  fragments = {},
  constraints = {},
  targetDomain = STAT_DOMAIN.ARMOR,
} = {}) {
  const errors = [];
  if (!Object.values(STAT_DOMAIN).includes(targetDomain)) {
    errors.push(`targetDomain must be "${STAT_DOMAIN.ARMOR}" or "${STAT_DOMAIN.VISIBLE}"`);
    targetDomain = STAT_DOMAIN.ARMOR;
  }
  const normalizedTarget = normalizeStatObject(target, 0, "target", errors);
  const normalizedFragments = normalizeStatObject(fragments, 0, "fragments", errors);
  if (targetDomain === STAT_DOMAIN.VISIBLE) {
    for (const stat of STATS) {
      if (normalizedTarget[stat] < 0 || normalizedTarget[stat] > 200) {
        errors.push(`target.${stat} must be between 0 and 200 in the visible domain`);
      }
    }
  }
  const rules = STATS.map(stat => createStatRule(
    stat,
    normalizedTarget,
    normalizedFragments[stat],
    constraints || {},
    targetDomain,
    errors,
  ));

  return {
    schemaVersion: SOLVER_V3_SCHEMA_VERSION,
    domain: STAT_DOMAIN.ARMOR,
    targetDomain,
    visibleTransform: "clamp(armor + fragment, 0, 200)",
    stats: [...STATS],
    target: normalizedTarget,
    fragments: normalizedFragments,
    rules,
    priorityOrder: [...(constraints?.priorityOrder || [])]
      .filter(stat => STATS.includes(stat)),
    valid: errors.length === 0,
    errors,
  };
}

function normalizeAllowedTuningStats(piece) {
  if (!piece?.exotic && own(piece, "tunedStat")) {
    return STATS.includes(piece.tunedStat) ? [piece.tunedStat] : null;
  }
  if (Array.isArray(piece?.allowedTuningStats)) {
    return [...new Set(piece.allowedTuningStats)]
      .filter(stat => STATS.includes(stat))
      .sort((left, right) => STATS.indexOf(left) - STATS.indexOf(right));
  }
  if (STATS.includes(piece?.tunedStat)) return [piece.tunedStat];
  if (STATS.includes(piece?.tuningStat)) return [piece.tuningStat];
  if (STATS.includes(piece?.tuningTo) && !piece?.exotic) return [piece.tuningTo];
  return null;
}

// Base in a witness is masterwork-inclusive, but never includes Tuning/mods.
// Imported items carry a raw roll; upgrade pieces already carry this base.
export function physicalBaseStats(piece = {}) {
  if (piece.physicalBaseStats) return { ...piece.physicalBaseStats };
  if (piece.effectiveBaseStats) return { ...piece.effectiveBaseStats };
  const config = BASE_CONFIGS.find(entry => entry.archetype === (piece.archetypeId || piece.archetype)
    && entry.tertiary === piece.tertiary);
  const base = { ...(piece.baseStats || config?.baseStats || {}) };
  if (piece.id && !piece.sourceId && piece.baseStats) {
    const tier = Math.max(0, Math.min(5, Number(piece.masterworkTier) || 0));
    const archetype = ARCHETYPES.find(entry => entry.id === piece.archetypeId);
    if (archetype && STATS.includes(piece.tertiary)) {
      for (const stat of STATS) {
        if (![archetype.primary, archetype.secondary, piece.tertiary].includes(stat)) base[stat] += tier;
      }
    }
  }
  return base;
}

// Numeric strings are accepted at the API boundary. Never let the search
// consume the pre-normalization vectors after the contract accepted them.
export function normalizePieceNumbers(piece) {
  const normalized = {...piece};
  for (const key of ["baseStats", "effectiveBaseStats", "optimizationBaseStats", "physicalBaseStats"]) {
    if (piece[key]) normalized[key] = Object.fromEntries(Object.entries(piece[key]).map(([stat, value]) => [stat, Number(value)]));
  }
  for (const key of ["armorModSize", "masterworkTier", "setHash"]) {
    if (piece[key] !== undefined && piece[key] !== null) normalized[key] = Number(piece[key]);
  }
  return normalized;
}

function projectedPhysicalBaseStats(piece, base) {
  if (piece.optimizationBaseStats) return { ...piece.optimizationBaseStats };
  const projected = { ...base };
  const frame = ARCHETYPES.find(a => a.id === (piece.archetypeId || piece.archetype));
  if (frame && STATS.includes(piece.tertiary) && (piece.id || piece.masterworkTier !== undefined)) {
    const remaining = 5 - Math.max(0, Math.min(5, Number(piece.masterworkTier) || 0));
    for (const stat of STATS) if (![frame.primary, frame.secondary, piece.tertiary].includes(stat)) projected[stat] += remaining;
  }
  return projected;
}

function normalizeSocketCapability(socket) {
  const hashes = socket?.candidatePlugHashes instanceof Set
    ? [...socket.candidatePlugHashes]
    : Array.isArray(socket?.candidatePlugHashes)
      ? [...socket.candidatePlugHashes]
      : [];
  return {
    socketIndex: finiteInteger(socket?.socketIndex) ?? -1,
    role: String(socket?.role || "other"),
    enabled: socket?.enabled !== false,
    candidateState: String(socket?.candidateState || "unknown"),
    currentPlugHash: socket?.currentPlugHash ?? null,
    emptyPlugHash: socket?.emptyPlugHash ?? null,
    visible: socket?.visible !== false,
    candidatePlugHashes: hashes
      .map(Number)
      .filter(Number.isSafeInteger)
      .sort((left, right) => left - right),
  };
}

export function createPieceCapability(piece = {}, slotIndex = 0) {
  piece ||= {};
  const errors = [];
  const rawBaseStats = physicalBaseStats(piece);
  const baseStats = normalizeStatObject(
    rawBaseStats,
    0,
    `pieces[${slotIndex}].baseStats`,
    errors,
  );
  const sockets = (piece.socketCapabilities || piece.sockets || [])
    .map(normalizeSocketCapability)
    .sort((left, right) => left.socketIndex - right.socketIndex);
  const energyCapacity = finiteInteger(piece.energy?.capacity ?? piece.energyCapacity);
  const energyUsed = finiteInteger(piece.energy?.used ?? piece.energyUsed);
  const tuningConfidence = String(
    piece.tuningConfidence
      || piece.tuningCapabilityConfidence
      || piece.dataConfidence?.tuning
      || "unknown",
  );
  const allowedTuningStats = normalizeAllowedTuningStats(piece);
  const fixed = own(piece, "tunedStat") ? piece.tunedStat : piece.tuningTo ?? piece.tuningStat;
  const tunedStat = !piece.exotic && STATS.includes(fixed) ? fixed : null;
  const masterworkStats = getMasterworkStats(piece);
  if (Array.isArray(piece.masterworkStats) && (!masterworkStats
      || stableSerialize([...piece.masterworkStats].sort()) !== stableSerialize([...masterworkStats].sort()))) {
    errors.push(`pieces[${slotIndex}] has contradictory masterwork stats`);
  }
  const mathDataKnown = errors.length === 0 && piece.dataConfidence?.stats !== "unknown"
    && STATS.every(stat => own(rawBaseStats, stat) && finiteInteger(rawBaseStats[stat]) !== null);
  const executionKnown = sockets.length > 0
    && sockets.every(socket => ["known", "full"].includes(socket.candidateState))
    && tuningConfidence !== "unknown"
    && energyCapacity !== null && energyUsed !== null;

  const capability = {
    schemaVersion: SOLVER_V3_SCHEMA_VERSION,
    slotIndex,
    slot: String(piece.slot || slotIndex),
    identity: String(piece.sourceId ?? piece.id ?? piece.instanceId ?? ""),
    hash: piece.hash ?? null,
    baseStats,
    projectedBaseStats: projectedPhysicalBaseStats(piece, baseStats),
    archetype: String(piece.archetype || piece.archetypeId || ""),
    tertiary: String(piece.tertiary || ""),
    exotic: Boolean(piece.exotic),
    classId: piece.classId || null,
    locked: Boolean(piece.locked),
    primaryPerkId: piece.primaryPerkId || null,
    secondaryPerkId: piece.secondaryPerkId || null,
    dataConfidence: { ...(piece.dataConfidence || {}) },
    armorModSize: piece.armorModSize ?? 0,
    armorModStat: piece.armorModStat ?? null,
    canEquip: piece.canEquip ?? null,
    cannotEquipReason: piece.cannotEquipReason ?? null,
    owner: piece.owner ?? null,
    equipped: Boolean(piece.equipped),
    tuningInstalled: piece.tuningInstalled,
    setHash: piece.setHash === null || piece.setHash === undefined
      ? null
      : Number(piece.setHash),
    tunedStat,
    allowedTuningStats,
    tuningAssignment: {
      mode: String(piece.tuningAssignment?.mode || piece.tuningMode || "unknown"),
      from: STATS.includes(piece.tuningAssignment?.from ?? piece.tuningFrom)
        ? piece.tuningAssignment?.from ?? piece.tuningFrom
        : null,
      to: STATS.includes(piece.tuningAssignment?.to ?? piece.tuningTo)
        ? piece.tuningAssignment?.to ?? piece.tuningTo
        : null,
    },
    tuningConfidence,
    sockets,
    energy: {
      capacity: energyCapacity,
      used: energyUsed,
    },
    masterworkStats,
    mathDataKnown,
    executionKnown,
    valid: errors.length === 0,
    errors,
  };
  // Three identity levels, in the order a compressed search would consume
  // them (see docs/math-equivalence-compression.md):
  //   mathEquivalenceKey      — only what changes the mathematical search
  //                             result. Owner/equipped/instance id are absent:
  //                             two rolls with the same numbers are the same
  //                             math no matter who holds them.
  //   executionEquivalenceKey — what changes whether the plan can actually be
  //                             executed on this instance (energy, sockets,
  //                             tuning executability, equippability).
  //   physicalIdentity        — the specific instance: id, hash, owner, equipped.
  capability.mathEquivalenceKey = stableSerialize({
    slot: capability.slot,
    baseStats: capability.baseStats,
    projectedBaseStats: capability.projectedBaseStats,
    archetype: capability.archetype,
    tertiary: capability.tertiary,
    exotic: capability.exotic,
    classId: capability.classId,
    locked: capability.locked,
    setHash: capability.setHash,
    tunedStat: capability.tunedStat,
    allowedTuningStats: capability.allowedTuningStats,
    tuningConfidence: capability.tuningConfidence,
    tuningAssignment: capability.tuningAssignment,
    armorModSize: capability.armorModSize,
    armorModStat: capability.armorModStat,
    primaryPerkId: capability.primaryPerkId,
    secondaryPerkId: capability.secondaryPerkId,
    masterworkStats: capability.masterworkStats,
  });
  capability.executionEquivalenceKey = stableSerialize({
    slot: capability.slot,
    exotic: capability.exotic,
    classId: capability.classId,
    tuningConfidence: capability.tuningConfidence,
    tuningAssignment: capability.tuningAssignment,
    armorModSize: capability.armorModSize,
    armorModStat: capability.armorModStat,
    canEquip: capability.canEquip,
    cannotEquipReason: capability.cannotEquipReason,
    sockets: capability.sockets,
    energy: capability.energy,
    executionKnown: capability.executionKnown,
  });
  capability.physicalIdentity = stableSerialize({
    identity: capability.identity,
    hash: capability.hash,
    owner: capability.owner,
    equipped: capability.equipped,
  });
  capability.equivalenceKey = stableSerialize({
    slot: capability.slot,
    baseStats: capability.baseStats,
    archetype: capability.archetype,
    tertiary: capability.tertiary,
    exotic: capability.exotic,
    classId: capability.classId,
    locked: capability.locked,
    setHash: capability.setHash,
    tunedStat: capability.tunedStat,
    allowedTuningStats: capability.allowedTuningStats,
    tuningConfidence: capability.tuningConfidence,
    sockets: capability.sockets,
    energy: capability.energy,
    primaryPerkId: capability.primaryPerkId,
    secondaryPerkId: capability.secondaryPerkId,
    dataConfidence: capability.dataConfidence,
    projectedBaseStats: capability.projectedBaseStats,
    tuningAssignment: capability.tuningAssignment,
    armorModSize: capability.armorModSize,
    armorModStat: capability.armorModStat,
    canEquip: capability.canEquip,
    cannotEquipReason: capability.cannotEquipReason,
    owner: capability.owner,
    equipped: capability.equipped,
  });
  return capability;
}

export function hasCompletePieceMath(capability, reassignModifiers = false) {
  if (!capability.mathDataKnown) return false;
  if (reassignModifiers) return Array.isArray(capability.allowedTuningStats)
    && capability.tuningConfidence !== "unknown" && capability.masterworkStats?.length === 3;
  if (capability.tuningInstalled === false) return true;
  const { mode, from, to } = capability.tuningAssignment;
  if (["plus3", "+3"].includes(mode)) return capability.masterworkStats?.length === 3;
  return ["shift", "+5-5"].includes(mode) && STATS.includes(from) && from !== to
    && capability.allowedTuningStats?.includes(to) === true;
}

export function matchesFixedExotic(piece, fixed) {
  if (!piece?.exotic || !fixed || fixed.reserved || piece.slot !== fixed.slot
      || fixed.classId && piece.classId !== fixed.classId) return false;
  const identity = fixed.sourceId || fixed.id;
  if (identity && String(piece.sourceId || piece.id || piece.identity) !== String(identity)) return false;
  if (Number(fixed.hash) > 0 && Number(piece.hash) !== Number(fixed.hash)) return false;
  for (const key of ['primaryPerkId', 'secondaryPerkId']) {
    if (fixed[key] && piece[key] && fixed[key] !== piece[key]) return false;
  }
  return !fixed.config || STATS.every(stat =>
    (piece.optimizationBaseStats || piece.projectedBaseStats || piece.baseStats)?.[stat] === fixed.config.baseStats[stat]);
}

export function createProblemSpec({
  operation = "solve",
  target = {},
  targets,
  fragments = {},
  constraints = {},
  targetDomain = STAT_DOMAIN.ARMOR,
  numPlus5 = 0,
  numPlus10 = 0,
  numPlus3 = 0,
  pieces = [],
  runtimeOptions = {},
  exoticSettings = null,
  inventoryContext = null,
} = {}) {
  const errors = [];
  const constraintModel = createConstraintModel({
    target: targets || target,
    fragments,
    constraints,
    targetDomain,
  });
  errors.push(...constraintModel.errors);
  const budget = {
    numPlus5: normalizeInteger(numPlus5, 0, "numPlus5", errors, { minimum: 0, maximum: 5 }),
    numPlus10: normalizeInteger(numPlus10, 0, "numPlus10", errors, { minimum: 0, maximum: 5 }),
    numPlus3: normalizeInteger(numPlus3, 0, "numPlus3", errors, { minimum: 0, maximum: 5 }),
  };
  if (budget.numPlus5 + budget.numPlus10 > 5) {
    errors.push("numPlus5 + numPlus10 must be <= 5");
  }
  if (inventoryContext?.modifierBudget) {
    const value = inventoryContext.modifierBudget;
    for (const key of ['numPlus5', 'numPlus10', 'numPlus3']) {
      if (key === 'numPlus3' && value[key] == null) continue;
      if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 5) errors.push(`invalid inventory ${key}`);
    }
    if (value.numPlus5 + value.numPlus10 > 5) errors.push('inventory armor mods exceed five slots');
  }
  const pieceCapabilities = (pieces || []).map(createPieceCapability);
  for (const capability of pieceCapabilities) errors.push(...capability.errors);
  const sourceIds = new Set();
  for (const capability of pieceCapabilities) {
    if (!capability.identity) continue;
    if (sourceIds.has(capability.identity)) errors.push(`duplicate source identity ${capability.identity}`);
    sourceIds.add(capability.identity);
  }
  const exoticSelection = exoticSettings
    ? Object.fromEntries(Object.entries(exoticSettings)
      .filter(([key]) => key !== "config"))
    : null;
  const fixedInput = exoticSettings?.config
    || (operation === "calculateReachability" ? pieces?.[0] : null);
  const fixedCapability = fixedInput ? createPieceCapability(fixedInput) : null;
  const fixedConfig = fixedInput ? {
    ...fixedInput, baseStats: {...fixedCapability.baseStats},
    masterworkStats: fixedCapability.masterworkStats,
  } : null;
  if (fixedConfig && !fixedConfig.masterworkStats) errors.push("fixed config has no valid framework");

  return {
    schemaVersion: SOLVER_V3_SCHEMA_VERSION,
    operation: String(operation),
    constraintModel,
    pieceCapabilities,
    budget,
    runtimeOptions: { ...runtimeOptions },
    solverContext: {
      fixedConfig,
      exoticSelection,
    },
    inventoryContext,
    valid: errors.length === 0,
    errors,
  };
}

export function getArmorSolverInput(problemSpec) {
  if (!problemSpec?.constraintModel) {
    throw new TypeError("runSolver requires a normalized ProblemSpec");
  }
  const { constraintModel } = problemSpec;
  const target = Object.fromEntries(constraintModel.rules.map(rule => [
    rule.stat,
    rule.preferredArmor,
  ]));
  const isArmorPointExact = rule => rule.exact
    && rule.armorMinimum !== null
    && rule.armorMinimum === rule.armorMaximum;
  const constraints = {
    minimums: Object.fromEntries(constraintModel.rules
      .filter(rule => rule.armorMinimum !== null && !isArmorPointExact(rule))
      .map(rule => [rule.stat, rule.armorMinimum])),
    maximums: Object.fromEntries(constraintModel.rules
      .filter(rule => rule.armorMaximum !== null && !isArmorPointExact(rule))
      .map(rule => [rule.stat, rule.armorMaximum])),
    exact: Object.fromEntries(constraintModel.rules.map(rule => [
      rule.stat,
      isArmorPointExact(rule),
    ])),
    priorityLevels: Object.fromEntries(constraintModel.rules.map(rule => [
      rule.stat,
      rule.priority,
    ])),
    priorityOrder: [...constraintModel.priorityOrder],
  };
  return {
    target,
    constraints,
    budget: { ...problemSpec.budget },
    runtimeOptions: { ...(problemSpec.runtimeOptions || {}) },
    fixedConfig: problemSpec.solverContext?.fixedConfig || null,
    exoticSelection: problemSpec.solverContext?.exoticSelection || null,
  };
}

export function compareIntegerTuples(left = [], right = []) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (!Number.isSafeInteger(leftValue) || !Number.isSafeInteger(rightValue)) {
      throw new TypeError("canonical tuples may only contain safe integers");
    }
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
}

export function stableSerialize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value instanceof Set) {
    return stableSerialize([...value].sort());
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
}

// The ruleset id is a canonical serialization of the whole capability registry,
// so on a real 1300-piece inventory one call costs milliseconds. It is derived
// far more often than the spec changes — every witness certificate and every
// proof projection recomputes it — and the parallel client does that for every
// retained row on every progressive merge. The result is memoized against the
// *identity* of the five inputs, so replacing `problemSpec.budget` or
// `problemSpec.inventoryContext` (as the Upgrade certifier does) invalidates it
// automatically.
const rulesetIdCache = new WeakMap();

export function createRulesetId(problemSpec) {
  // Canonical serialization is intentionally collision-free. Runtime limits
  // are not rules; inventory identities, assignments and set requirements are.
  const inputs = {
    constraintModel: problemSpec?.constraintModel,
    budget: problemSpec?.budget,
    pieceCapabilities: problemSpec?.pieceCapabilities,
    solverContext: problemSpec?.solverContext,
    inventoryContext: problemSpec?.inventoryContext,
  };
  if (problemSpec && typeof problemSpec === "object") {
    const cached = rulesetIdCache.get(problemSpec);
    if (cached
        && cached.constraintModel === inputs.constraintModel
        && cached.budget === inputs.budget
        && cached.pieceCapabilities === inputs.pieceCapabilities
        && cached.solverContext === inputs.solverContext
        && cached.inventoryContext === inputs.inventoryContext) {
      return cached.id;
    }
  }
  const id = `solver-v3-proof-v1:${stableSerialize({
    operation: problemSpec?.operation,
    ...inputs,
  })}`;
  if (problemSpec && typeof problemSpec === "object") {
    rulesetIdCache.set(problemSpec, {...inputs, id});
  }
  return id;
}

// Internal producer API. Public payloads never flow into this function as
// proof options; each producer supplies the facts of the search it just ran.
export function createProofEvidence(problemSpec, {
  method = "unknown",
  producer = "unknown",
  complete = false,
  truncated = false,
  statesExamined = 0,
  assumptions = [],
  scope = "rule-domain",
  outcome = "unknown",
  limitation = null,
} = {}) {
  const evidence = Object.freeze({
    method,
    producer,
    domain: STAT_DOMAIN.ARMOR,
    complete: complete === true,
    truncated: truncated === true,
    statesExamined,
    assumptions: Object.freeze([...assumptions]),
    rulesetId: createRulesetId(problemSpec),
    scope,
    outcome,
    ...(limitation ? { limitation } : {}),
  });
  issuedProofEvidence.add(evidence);
  return evidence;
}

export function normalizeProofEvidence(problemSpec, proof = {}) {
  if (!proof || typeof proof !== "object") proof = {};
  const errors = [];
  const expectedRulesetId = createRulesetId(problemSpec);
  if (!issuedProofEvidence.has(proof)) errors.push("evidence was not issued by an internal producer");
  if (!PROOF_PRODUCERS[proof.producer]?.includes(proof.method)) {
    errors.push("untrusted proof producer or method");
  }
  if (proof.rulesetId !== expectedRulesetId) errors.push("rulesetId mismatch");
  if (proof.domain !== STAT_DOMAIN.ARMOR) errors.push("proof domain must be armor");
  if (proof.complete !== true) errors.push("search is incomplete");
  if (proof.truncated !== false) errors.push("search may be truncated");
  if (!Number.isSafeInteger(proof.statesExamined) || proof.statesExamined < 0) {
    errors.push("invalid statesExamined");
  }
  if (!Array.isArray(proof.assumptions)
      || proof.assumptions.some(value => typeof value !== "string")
      || !proof.assumptions.includes("known-data")) {
    errors.push("proof requires known data");
  }
  if (!problemSpec?.valid) errors.push("invalid ProblemSpec");
  const rules = problemSpec?.constraintModel?.rules || [];
  const pointRules = rules.every(rule => rule.armorMinimum === null && rule.armorMaximum === null
    || rule.armorMinimum !== null && rule.armorMinimum === rule.armorMaximum);
  if (proof.producer === "exact-target-oracle" && proof.scope !== "target-point") {
    errors.push("exact oracle covers only a target point");
  }
  const operations = {
    "exact-target-oracle": ["solve", "calculateReachability"],
    "reachability-dp": ["calculateReachability"],
    "inventory-frontier": ["solveInventory"],
    "global-fuzzy-enumeration": ["solve"],
  };
  if (!operations[proof.producer]?.includes(problemSpec?.operation)) {
    errors.push("producer does not cover this operation");
  }
  if (["solve", "calculateReachability"].includes(problemSpec?.operation)
      && problemSpec.pieceCapabilities.some(capability =>
        !capability.mathDataKnown || !capability.masterworkStats
        || Object.values(capability.baseStats).some(value => value < 5))) {
    errors.push("fixed-piece data is outside the nonnegative tuning proof domain");
  }
  if (proof.producer === "reachability-dp"
      && proof.method === "point-rule-dynamic-programming" && !pointRules) {
    errors.push("non-point rules require an interval-complete proof");
  }
  if (proof.producer === "inventory-frontier"
      && problemSpec?.pieceCapabilities?.some(capability => !hasCompletePieceMath(
        capability, problemSpec.inventoryContext?.reassignModifiers !== false,
      ))) {
    errors.push("one or more inventory capabilities contain unknown data");
  }
  if (!["target-point", "rule-domain"].includes(proof.scope)) errors.push("unknown proof scope");
  if (!["feasible", "infeasible", "unknown"].includes(proof.outcome)) errors.push("unknown proof outcome");
  return {
    method: typeof proof.method === "string" ? proof.method : "unknown",
    producer: typeof proof.producer === "string" ? proof.producer : "unknown",
    domain: proof.domain ?? null,
    complete: errors.length === 0,
    truncated: proof.truncated !== false,
    statesExamined: Number.isSafeInteger(proof.statesExamined) ? proof.statesExamined : 0,
    assumptions: Array.isArray(proof.assumptions) ? [...proof.assumptions] : [],
    rulesetId: proof.rulesetId ?? null,
    scope: proof.scope ?? null,
    outcome: proof.outcome ?? "unknown",
    validationErrors: errors,
    ...(proof.limitation ? { limitation: proof.limitation } : {}),
  };
}

function evidenceCoversRules(problemSpec, proof) {
  if (!proof.complete) return false;
  if (proof.scope === "rule-domain") return true;
  return problemSpec.constraintModel.rules.every(rule =>
    rule.armorMinimum !== null
    && rule.armorMinimum === rule.armorMaximum
    && rule.armorMinimum === rule.preferredArmor);
}

export function createCanonicalId(witness) {
  if (!witness) return null;
  const config = (witness.config || witness.pieces || []).map((piece, index) => ({
    index,
    identity: piece?.sourceId ?? piece?.id ?? piece?.instanceId ?? null,
    archetype: piece?.archetype ?? piece?.archetypeId ?? null,
    tertiary: piece?.tertiary ?? null,
    baseStats: Object.fromEntries(STATS.map(stat => [stat, piece?.baseStats?.[stat] ?? 0])),
    slot: piece?.slot ?? null,
    hash: piece?.hash ?? null,
    exotic: Boolean(piece?.exotic),
    tunedStat: piece?.tunedStat ?? null,
    allowedTuningStats: piece?.allowedTuningStats ?? null,
    setHash: piece?.setHash ?? null,
    primaryPerkId: piece?.primaryPerkId ?? null,
    secondaryPerkId: piece?.secondaryPerkId ?? null,
    physicalBaseStats: piece?.physicalBaseStats ?? null,
    requiresMasterwork: Boolean(piece?.requiresMasterwork),
  }));
  return stableSerialize({
    config,
    tuningAssignments: witness.tuningAssignments || witness.evaluation?.tuningAssignments || [],
    modAssignments: witness.modAssignments || witness.evaluation?.modAssignments || {},
    totals: witness.totals || witness.finalTotals || witness.evaluation?.finalTotals || {},
    fragments: Object.fromEntries(STATS.map(stat => [stat, witness.fragments?.[stat] ?? 0])),
  });
}

function getTotals(witness, domain) {
  if (domain === STAT_DOMAIN.VISIBLE && witness?.visibleTotals) {
    return witness.visibleTotals;
  }
  if (domain === STAT_DOMAIN.ARMOR && witness?.armorTotals) {
    return witness.armorTotals;
  }
  return witness?.totals || witness?.finalTotals || witness?.evaluation?.finalTotals || null;
}

export function matchesExactTarget(witness, constraintModel, domain = STAT_DOMAIN.ARMOR) {
  const totals = getTotals(witness, domain);
  if (!totals) return false;
  return constraintModel.rules.every(rule => {
    const actual = Number(totals[rule.stat]);
    const expected = domain === STAT_DOMAIN.VISIBLE
      ? rule.preferredVisible
      : rule.preferredArmor;
    return actual === expected;
  });
}

export function satisfiesConstraintModel(witness, constraintModel, domain = STAT_DOMAIN.ARMOR) {
  const totals = getTotals(witness, domain);
  if (!totals) return false;
  return constraintModel.rules.every(rule => {
    const actual = Number(totals[rule.stat]);
    const minimum = domain === STAT_DOMAIN.VISIBLE
      ? rule.visibleMinimum
      : rule.armorMinimum;
    const maximum = domain === STAT_DOMAIN.VISIBLE
      ? rule.visibleMaximum
      : rule.armorMaximum;
    return Number.isFinite(actual)
      && (minimum === null || actual >= minimum)
      && (maximum === null || actual <= maximum);
  });
}

const resolveMasterworkStats = getMasterworkStats;

export function samePhysicalPiece(left, right) {
  const a = left?.sourceId ?? left?.id ?? left?.instanceId;
  const b = right?.sourceId ?? right?.id ?? right?.instanceId;
  return Boolean(a) && String(a) === String(b);
}

export function sameImmutableCapabilities(left, right) {
  const a = createPieceCapability(left);
  const b = createPieceCapability(right);
  return ["hash", "slot", "baseStats", "archetype", "tertiary", "exotic", "setHash",
    "tunedStat", "allowedTuningStats", "primaryPerkId", "secondaryPerkId"]
    .every(key => stableSerialize(a[key]) === stableSerialize(b[key]));
}

function witnessAssignments(witness) {
  return {
    tuning: witness?.tuningAssignments || witness?.evaluation?.tuningAssignments || null,
    mods: witness?.modAssignments || witness?.evaluation?.modAssignments || null,
  };
}

// Verification looks a witness up in the ProblemSpec's capability registry.
// That registry is the entire vault (1300 entries in a real inventory) and the
// parallel client re-verifies every retained witness on every progressive
// merge, so rebuilding the identity index each time dominated the client's wall
// clock. The array is immutable once derived, so the index is cached against it.
const capabilitySourceCache = new WeakMap();

function capabilitySources(problemSpec) {
  const capabilities = problemSpec?.pieceCapabilities;
  if (!Array.isArray(capabilities)) return new Map();
  const cached = capabilitySourceCache.get(capabilities);
  if (cached) return cached;
  const sources = new Map(capabilities.filter(piece => piece.identity)
    .map(piece => [piece.identity, piece]));
  capabilitySourceCache.set(capabilities, sources);
  return sources;
}

export function verifyWitness(problemSpec, witness) {
  const errors = [];
  const pieces = witness?.config || witness?.pieces;
  const { tuning, mods } = witnessAssignments(witness);
  if (!problemSpec?.constraintModel) errors.push("problemSpec.constraintModel is required");
  if (problemSpec?.valid !== true) errors.push("ProblemSpec is invalid");
  if (!Array.isArray(pieces) || pieces.length !== 5) {
    errors.push("witness must contain exactly five pieces");
  }
  if (!Array.isArray(tuning) || tuning.length !== 5) {
    errors.push("witness must contain exactly five tuning assignments");
  }

  const armorTotals = Object.fromEntries(STATS.map(stat => [stat, 0]));
  let plus3Count = 0;
  let plus5ModCount = 0;
  let plus10ModCount = 0;
  const capabilities = problemSpec?.pieceCapabilities || [];
  const sources = capabilitySources(problemSpec);
  const identities = new Set();
  const slots = new Set();
  const inventoryContext = problemSpec?.inventoryContext;
  const ownedOperation = ["analyzeUpgrade", "solveInventory"].includes(problemSpec?.operation);
  const modeId = mode => mode === "plus3" ? "+3" : mode === "shift" ? "+5-5" : mode;
  if (Object.keys(mods || {}).some(key => !/^[0-4]$/.test(key))) errors.push("invalid armor mod slot");
  const selectedSources = [];
  if (Array.isArray(pieces) && pieces.length === 5) {
    if (pieces.filter(piece => piece?.exotic).length > 1) errors.push("multiple Exotic armor pieces");
    for (let index = 0; index < pieces.length; index++) {
      const piece = pieces[index] || {};
      const capability = createPieceCapability(piece, index);
      const masterwork = resolveMasterworkStats(piece);
      if (Array.isArray(piece?.masterworkStats) && (!masterwork || stableSerialize([...piece.masterworkStats].sort()) !== stableSerialize([...masterwork].sort()))) errors.push(`piece ${index} has contradictory masterwork stats`);
      const identity = capability.identity;
      const source = sources.get(identity);
      selectedSources.push(source);
      if (identity) {
        if (identities.has(identity)) errors.push(`duplicate physical identity ${identity}`);
        identities.add(identity);
        if (!source) errors.push(`unknown physical identity ${identity}`);
      } else if (problemSpec?.operation === "solveInventory") errors.push(`piece ${index} is not owned`);
      if (ownedOperation) {
        if (!["helmet", "arms", "chest", "legs", "classItem"].includes(piece?.slot)
            || slots.has(piece.slot)) errors.push(`invalid or duplicate armor slot ${piece?.slot}`);
        slots.add(piece?.slot);
      }
      if (source) {
        for (const key of ["hash", "slot", "archetype", "tertiary", "exotic", "setHash", "tunedStat",
          "allowedTuningStats", "primaryPerkId", "secondaryPerkId"]) {
          if (stableSerialize(source[key]) !== stableSerialize(capability[key])) {
            errors.push(`immutable capability ${identity}.${key} changed`);
          }
        }
        const expectedBase = piece.requiresMasterwork ? source.projectedBaseStats : source.baseStats;
        if (STATS.some(stat => piece?.baseStats?.[stat] !== expectedBase[stat])) {
          errors.push(`physical base stats changed for ${identity}`);
        }
        if (piece.physicalBaseStats && STATS.some(stat => piece.physicalBaseStats[stat] !== source.baseStats[stat])) errors.push(`physical base binding changed for ${identity}`);
        if (source.dataConfidence?.stats === "unknown") errors.push(`unknown base data for ${identity}`);
      }
      if (ownedOperation && !identity) {
        const knownBase = [...BASE_CONFIGS, ...capabilities.filter(p => p.slot === piece.slot)]
          .some(p => (p.archetype || p.archetypeId) === (piece.archetype || piece.archetypeId)
            && p.tertiary === piece.tertiary && STATS.every(stat => p.baseStats[stat] === piece.baseStats?.[stat]
              || piece.requiresMasterwork && p.projectedBaseStats?.[stat] === piece.baseStats?.[stat]));
        if (!knownBase) errors.push(`piece ${index} is neither an input piece nor a catalog replacement`);
      }
      if (["solve", "calculateReachability"].includes(problemSpec?.operation)) {
        const catalog = [...BASE_CONFIGS, ...(problemSpec.solverContext?.fixedConfig ? [problemSpec.solverContext.fixedConfig] : []),
          ...capabilities.map(p => ({ ...p, baseStats: p.baseStats }))];
        if (!catalog.some(p => (p.archetype || p.archetypeId) === (piece.archetype || piece.archetypeId)
            && p.tertiary === piece.tertiary && STATS.every(stat => p.baseStats[stat] === piece.baseStats?.[stat]))) errors.push(`piece ${index} is outside the problem catalog`);
      }
      for (const stat of STATS) {
        const value = finiteInteger(piece?.baseStats?.[stat]);
        if (value === null) {
          errors.push(`witness.pieces[${index}].baseStats.${stat} must be a safe integer`);
        } else {
          armorTotals[stat] += value;
        }
      }

      const assignment = Array.isArray(tuning) ? tuning[index] : null;
      const mode = assignment?.mode;
      if ((mode === "+3" || mode === "plus3" || mode === "none") && (assignment.from != null || assignment.to != null)) errors.push(`witness tuning ${index} has stale directional fields`);
      if (mode === "+3" || mode === "plus3") {
        const masterworkStats = resolveMasterworkStats(piece);
        if (!masterworkStats) {
          errors.push(`witness tuning ${index} has no verifiable Balanced stat set`);
        } else {
          for (const stat of masterworkStats) armorTotals[stat] += 1;
          plus3Count++;
        }
      } else if (mode === "+5-5" || mode === "shift") {
        if (!STATS.includes(assignment?.from)
            || !STATS.includes(assignment?.to)
            || assignment.from === assignment.to) {
          errors.push(`witness tuning ${index} has an invalid directional assignment`);
        } else {
          const allowed = source?.allowedTuningStats ?? capability.allowedTuningStats;
          if (ownedOperation && !Array.isArray(allowed)) {
            errors.push(`witness tuning ${index} capability is unknown`);
          } else if (Array.isArray(allowed) && !allowed.includes(assignment.to)) {
            errors.push(`witness tuning ${index} changes immutable destination or exceeds capability`);
          }
          armorTotals[assignment.from] -= 5;
          armorTotals[assignment.to] += 5;
        }
      } else if (mode !== "none" || !ownedOperation) {
        errors.push(`witness tuning ${index} is missing or unknown`);
      }
      if (source && inventoryContext?.reassignModifiers === false && !inventoryContext?.onlyPlus5Tuning) {
        const expectedMode = source.tuningInstalled === false ? "none" : modeId(source.tuningAssignment.mode);
        if (modeId(mode) !== expectedMode
            || (expectedMode === "+5-5" && (assignment.from !== source.tuningAssignment.from || assignment.to !== source.tuningAssignment.to))) errors.push("reassignment is disabled");
        const assignedMod = mods?.[index];
        if ((assignedMod?.size || 0) !== source.armorModSize || assignedMod && assignedMod.stat !== source.armorModStat) errors.push("armor mod reassignment is disabled");
      }
      if (inventoryContext?.onlyPlus5Tuning && mode !== "+5-5" && mode !== "shift") {
        errors.push(`witness tuning ${index} violates onlyPlus5Tuning`);
      }

      const mod = mods?.[index] ?? mods?.[String(index)] ?? null;
      if (mod !== null && mod !== undefined) {
        const size = finiteInteger(mod.size);
        if (![5, 10].includes(size) || !STATS.includes(mod.stat)) {
          errors.push(`witness armor mod ${index} is invalid`);
        } else {
          armorTotals[mod.stat] += size;
          if (size === 5) plus5ModCount++;
          else plus10ModCount++;
        }
      }
    }
  }

  if (ownedOperation) {
    if (new Set(selectedSources.filter(Boolean).map(p => p.classId).filter(Boolean)).size > 1) errors.push("mixed armor classes");
    for (const source of capabilities.filter(p => p.locked)) {
      // Inventory pools can contain many Exotic items; only explicit current
      // locks (or Upgrade's five input locks) constrain the selected instances.
      if (problemSpec.operation === "analyzeUpgrade" && source.identity && !identities.has(source.identity)) {
        errors.push(`locked physical piece ${source.identity} was replaced`);
      }
      if (problemSpec.operation === "analyzeUpgrade" && !source.identity && !(pieces || []).some(piece => piece.slot === source.slot
        && (piece.archetypeId || piece.archetype) === source.archetype && piece.tertiary === source.tertiary
        && (piece.exotic ? null : piece.tunedStat) === source.tunedStat
        && STATS.every(stat => piece.baseStats?.[stat] === source.baseStats[stat]
          || piece.requiresMasterwork && piece.baseStats?.[stat] === source.projectedBaseStats[stat]))) errors.push("locked manual piece was replaced");
    }
    for (const locked of inventoryContext?.currentPieces || []) {
      if (locked.locked && locked.sourceId && !identities.has(String(locked.sourceId))) errors.push("locked inventory piece was replaced");
    }
    const requirement = inventoryContext?.setRequirement;
    if (inventoryContext?.fixedExotic && !selectedSources.some(piece => matchesFixedExotic(piece, inventoryContext.fixedExotic))) {
      errors.push('fixed Exotic requirement violated');
    }
    const count = hash => (pieces || []).filter(p => Number(p?.setHash) === Number(hash)).length;
    if (requirement?.type === "set" && count(requirement.setHash) < requirement.count
        || requirement?.type === "split" && (requirement.a === requirement.b || count(requirement.a) < 2 || count(requirement.b) < 2)) {
      errors.push("set requirement violated");
    }
    const budgetSources = problemSpec.operation === "solveInventory" ? selectedSources : capabilities;
    const explicitBudget = inventoryContext?.modifierBudget;
    if (explicitBudget) {
      if (plus5ModCount !== explicitBudget.numPlus5 || plus10ModCount !== explicitBudget.numPlus10
          || explicitBudget.numPlus3 != null && plus3Count !== explicitBudget.numPlus3) errors.push('inventory modifier budget violated');
    } else if (!inventoryContext?.autoStatMods && budgetSources.length === 5 && budgetSources.every(Boolean)) {
      if (plus5ModCount !== budgetSources.filter(p => p.armorModSize === 5).length
          || plus10ModCount !== budgetSources.filter(p => p.armorModSize === 10).length) errors.push("owned armor mod budget changed");
    }
  }

  const fixed = problemSpec?.solverContext?.fixedConfig;
  if (fixed && Array.isArray(pieces) && !pieces.some(piece => STATS.every(stat =>
    piece?.baseStats?.[stat] === fixed.baseStats?.[stat]) && piece.tertiary === fixed.tertiary
    && (piece.archetype || piece.archetypeId) === (fixed.archetype || fixed.archetypeId))) errors.push("fixed config was replaced");

  if (["solve", "calculateReachability"].includes(problemSpec?.operation)) {
    if (plus3Count !== problemSpec.budget?.numPlus3) {
      errors.push("witness Balanced tuning count does not match ProblemSpec budget");
    }
    if (plus5ModCount !== problemSpec.budget?.numPlus5
        || plus10ModCount !== problemSpec.budget?.numPlus10) {
      errors.push("witness armor mod count does not match ProblemSpec budget");
    }
  }

  const fragments = problemSpec?.constraintModel?.fragments
    || Object.fromEntries(STATS.map(stat => [stat, 0]));
  const visibleTotals = Object.fromEntries(STATS.map(stat => [
    stat,
    visibleStatFromArmor(armorTotals[stat], fragments[stat]),
  ]));
  if (STATS.some(stat => !Number.isSafeInteger(armorTotals[stat]))) errors.push("unsafe integer totals");
  if (witness?.fragments && STATS.some(stat => (witness.fragments[stat] ?? 0) !== fragments[stat])) errors.push("fragment mismatch");
  if (witness?.canonicalId) {
    if (witness.canonicalId !== createCanonicalId(witness)) errors.push("canonical witness changed");
    for (const [key, expected] of [["totals", armorTotals], ["armorTotals", armorTotals], ["visibleTotals", visibleTotals], ["finalTotals", visibleTotals]]) {
      if (witness[key] && STATS.some(stat => witness[key][stat] !== expected[stat])) errors.push(`${key} does not rebuild`);
    }
  }
  const valid = errors.length === 0;
  const verifiedWitness = valid ? {
    ...witness,
    totals: { ...armorTotals },
    armorTotals: { ...armorTotals },
    visibleTotals: { ...visibleTotals },
    fragments: { ...fragments },
  } : null;
  return {
    valid,
    errors,
    armorTotals,
    visibleTotals,
    witness: verifiedWitness,
  };
}

// The public serialization/presentation boundary. A serialized certificate is
// an audit record; every consumption rechecks its concrete witness.
export function assertSolutionConsistency(problemSpec, witness, displayedTotals = null) {
  const verification = verifyWitness(problemSpec, witness);
  const errors = [...verification.errors];
  if (displayedTotals && STATS.some(stat => displayedTotals[stat] !== verification.visibleTotals[stat])) errors.push("displayed totals do not rebuild");
  if (witness?.certificate?.canonicalId && witness.certificate.canonicalId !== createCanonicalId(verification.witness)) errors.push("certificate canonical mismatch");
  if (witness?.certificate?.status === RESULT_STATUS.EXACT_TARGET_PROVEN
      && (!matchesExactTarget(verification.witness, problemSpec.constraintModel, problemSpec.constraintModel.targetDomain)
        || !satisfiesConstraintModel(verification.witness, problemSpec.constraintModel))) errors.push("exact certificate violates the problem");
  if (witness?.certificate?.status === RESULT_STATUS.RULE_FEASIBLE_PROVEN
      && !satisfiesConstraintModel(verification.witness, problemSpec.constraintModel)) errors.push("rule certificate violates the problem");
  if (errors.length) throw new Error(`UNVERIFIED: ${errors.join("; ")}`);
  return verification.witness;
}

export function createSolutionDisplayModel(witness) {
  const verified = assertSolutionConsistency(witness?.problemSpec, witness);
  return {
    canonicalId: createCanonicalId(verified),
    problemSpec: structuredClone(witness.problemSpec),
    pieces: structuredClone(verified.config || verified.pieces),
    tuningAssignments: structuredClone(verified.tuningAssignments || verified.evaluation?.tuningAssignments),
    modAssignments: structuredClone(verified.modAssignments || verified.evaluation?.modAssignments),
    fragments: { ...verified.fragments },
    armorTotals: { ...verified.armorTotals },
    visibleTotals: { ...verified.visibleTotals },
    totals: { ...verified.armorTotals },
  };
}

export function sealWitness(problemSpec, candidate) {
  const verification = verifyWitness(problemSpec, candidate);
  if (!verification.valid) return verification;
  const witness = structuredClone(verification.witness);
  if (witness.config) {
    let legendarySlot = 0;
    const slotNames = ["helmet", "arms", "chest", "legs", "classItem"];
    witness.config = witness.config.map((piece, index) => ({...piece,
      slot: piece.slot || (witness.exoticIndex === index ? "classItem" : slotNames[legendarySlot++]),
      exotic: Boolean(piece.exotic || witness.exoticIndex === index),
    }));
  }
  // Bind only the used source registry, not a copy of the entire vault per result.
  const ids = new Set((witness.config || witness.pieces).map(p => String(p.sourceId ?? p.id ?? "")));
  witness.problemSpec = structuredClone({ ...problemSpec,
    pieceCapabilities: problemSpec.operation === "solveInventory"
      ? problemSpec.pieceCapabilities.filter(p => !p.identity || ids.has(p.identity)) : problemSpec.pieceCapabilities,
  });
  witness.canonicalId = createCanonicalId(witness);
  return { ...verification, witness };
}

export function createResultCertificate({
  status,
  executionStatus = EXECUTION_STATUS.NOT_APPLICABLE,
  problemSpec,
  witness = null,
  proof = {},
  message = null,
} = {}) {
  if (!RESULT_STATUS_VALUES.has(status)) {
    throw new TypeError(`unknown Solver V3 result status: ${status}`);
  }
  if (!EXECUTION_STATUS_VALUES.has(executionStatus)) {
    throw new TypeError(`unknown Solver V3 execution status: ${executionStatus}`);
  }
  const resolvedVerification = witness ? verifyWitness(problemSpec, witness) : null;
  const verifiedProof = normalizeProofEvidence(problemSpec, proof);
  const verifiedWitness = resolvedVerification?.valid
    ? resolvedVerification.witness
    : null;
  let verifiedStatus = status;
  const witnessSatisfiesRules = verifiedWitness && satisfiesConstraintModel(
    verifiedWitness, problemSpec.constraintModel, STAT_DOMAIN.ARMOR,
  );
  const completeRuleProof = evidenceCoversRules(problemSpec, verifiedProof);
  if (status === RESULT_STATUS.EXACT_TARGET_PROVEN
      && (!witnessSatisfiesRules || !matchesExactTarget(
        verifiedWitness,
        problemSpec?.constraintModel,
        problemSpec?.constraintModel?.targetDomain,
      ))) {
    verifiedStatus = RESULT_STATUS.SEARCH_LIMIT_REACHED;
  } else if (status === RESULT_STATUS.RULE_FEASIBLE_PROVEN
      && !witnessSatisfiesRules
      && !(completeRuleProof && verifiedProof.outcome === "feasible")) {
    verifiedStatus = RESULT_STATUS.SEARCH_LIMIT_REACHED;
  } else if (status === RESULT_STATUS.INFEASIBLE_PROVEN
      && (witnessSatisfiesRules || !completeRuleProof || verifiedProof.outcome !== "infeasible")) {
    verifiedStatus = RESULT_STATUS.SEARCH_LIMIT_REACHED;
  }
  if (!problemSpec?.valid) verifiedStatus = RESULT_STATUS.INVALID_INPUT;
  return {
    schemaVersion: SOLVER_V3_SCHEMA_VERSION,
    status: verifiedStatus,
    statResults: Object.fromEntries((problemSpec?.constraintModel?.rules || []).map(rule => {
      const actual = verifiedWitness?.armorTotals?.[rule.stat];
      const visible = verifiedWitness?.visibleTotals?.[rule.stat];
      const met = actual !== undefined && (rule.armorMinimum === null || actual >= rule.armorMinimum)
        && (rule.armorMaximum === null || actual <= rule.armorMaximum);
      return [rule.stat, {met, actual: visible ?? null, target: rule.preferredVisible,
        below: actual === undefined || rule.armorMinimum === null ? 0 : Math.max(0, rule.armorMinimum - actual),
        above: actual === undefined || rule.armorMaximum === null ? 0 : Math.max(0, actual - rule.armorMaximum)}];
    })),
    executionStatus,
    canonicalId: createCanonicalId(verifiedWitness),
    problem: {
      operation: problemSpec?.operation || null,
      constraintModel: problemSpec?.constraintModel || null,
      budget: problemSpec?.budget || null,
    },
    proof: verifiedProof,
    witnessVerification: resolvedVerification ? {
      valid: resolvedVerification.valid,
      errors: [...resolvedVerification.errors],
      armorTotals: { ...resolvedVerification.armorTotals },
      visibleTotals: { ...resolvedVerification.visibleTotals },
    } : null,
    message,
  };
}

export function attachResultCertificate(result, certificate) {
  if (result && (typeof result === "object" || typeof result === "function")) {
    result.certificate = certificate;
    result.status = certificate.status;
    result.executionStatus = certificate.executionStatus;
  }
  return result;
}

export function compareCanonicalCandidates(left, right) {
  const tupleOrder = compareIntegerTuples(
    left?.canonicalTuple || left?.rank || [],
    right?.canonicalTuple || right?.rank || [],
  );
  if (tupleOrder !== 0) return tupleOrder;
  return String(left?.canonicalId || createCanonicalId(left) || "")
    .localeCompare(String(right?.canonicalId || createCanonicalId(right) || ""));
}
