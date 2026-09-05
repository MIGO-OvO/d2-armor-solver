import { ARCHETYPES, STATS } from "./armor-model.mjs";

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

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function finiteInteger(value) {
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
    minimum = targetValue;
    maximum = targetValue;
  }
  if (forceZero) {
    minimum = 0;
    maximum = 0;
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
    constraints.priorities?.[stat] ? 1 : 0,
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
  if (Array.isArray(piece?.allowedTuningStats)) {
    return [...new Set(piece.allowedTuningStats)]
      .filter(stat => STATS.includes(stat))
      .sort((left, right) => STATS.indexOf(left) - STATS.indexOf(right));
  }
  if (STATS.includes(piece?.tuningStat)) return [piece.tuningStat];
  if (STATS.includes(piece?.tuningTo) && !piece?.exotic) return [piece.tuningTo];
  return null;
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
    candidatePlugHashes: hashes
      .map(Number)
      .filter(Number.isSafeInteger)
      .sort((left, right) => left - right),
  };
}

export function createPieceCapability(piece = {}, slotIndex = 0) {
  const errors = [];
  const baseStats = normalizeStatObject(
    piece.baseStats || piece.stats || {},
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
    piece.tuningConfidence || piece.tuningCapabilityConfidence || "unknown",
  );
  const allowedTuningStats = normalizeAllowedTuningStats(piece);
  const executionKnown = sockets.length > 0
    && sockets.every(socket => socket.candidateState === "known")
    && tuningConfidence !== "unknown";

  const capability = {
    schemaVersion: SOLVER_V3_SCHEMA_VERSION,
    slotIndex,
    slot: String(piece.slot || slotIndex),
    identity: String(piece.sourceId ?? piece.id ?? piece.instanceId ?? ""),
    baseStats,
    archetype: String(piece.archetype || piece.archetypeId || ""),
    tertiary: String(piece.tertiary || ""),
    exotic: Boolean(piece.exotic),
    locked: Boolean(piece.locked),
    setHash: piece.setHash === null || piece.setHash === undefined
      ? null
      : Number(piece.setHash),
    tuningMode: String(piece.tuningMode || "unknown"),
    allowedTuningStats,
    tuningConfidence,
    sockets,
    energy: {
      capacity: energyCapacity,
      used: energyUsed,
    },
    executionKnown,
    valid: errors.length === 0,
    errors,
  };
  capability.equivalenceKey = stableSerialize({
    slot: capability.slot,
    baseStats: capability.baseStats,
    archetype: capability.archetype,
    tertiary: capability.tertiary,
    exotic: capability.exotic,
    locked: capability.locked,
    setHash: capability.setHash,
    tuningMode: capability.tuningMode,
    allowedTuningStats: capability.allowedTuningStats,
    tuningConfidence: capability.tuningConfidence,
    sockets: capability.sockets,
    energy: capability.energy,
  });
  return capability;
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
  const pieceCapabilities = (pieces || []).map(createPieceCapability);
  for (const capability of pieceCapabilities) errors.push(...capability.errors);
  const exoticSelection = exoticSettings
    ? Object.fromEntries(Object.entries(exoticSettings)
      .filter(([key]) => key !== "config"))
    : null;

  return {
    schemaVersion: SOLVER_V3_SCHEMA_VERSION,
    operation: String(operation),
    constraintModel,
    pieceCapabilities,
    budget,
    runtimeOptions: { ...runtimeOptions },
    solverContext: {
      fixedConfig: exoticSettings?.config || null,
      exoticSelection,
    },
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

export function createCanonicalId(witness) {
  if (!witness) return null;
  const config = (witness.config || witness.pieces || []).map((piece, index) => ({
    index,
    identity: piece?.sourceId ?? piece?.id ?? piece?.instanceId ?? null,
    archetype: piece?.archetype ?? piece?.archetypeId ?? null,
    tertiary: piece?.tertiary ?? null,
    baseStats: Object.fromEntries(STATS.map(stat => [stat, piece?.baseStats?.[stat] ?? 0])),
  }));
  return stableSerialize({
    config,
    tuningAssignments: witness.tuningAssignments || witness.evaluation?.tuningAssignments || [],
    modAssignments: witness.modAssignments || witness.evaluation?.modAssignments || {},
    totals: witness.totals || witness.finalTotals || witness.evaluation?.finalTotals || {},
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

function resolveMasterworkStats(piece) {
  if (Array.isArray(piece?.masterworkStats)) {
    const stats = [...new Set(piece.masterworkStats)].filter(stat => STATS.includes(stat));
    if (stats.length === 3) return stats;
  }
  const archetypeId = piece?.archetype || piece?.archetypeId;
  const archetype = ARCHETYPES.find(candidate => candidate.id === archetypeId);
  if (!archetype || !STATS.includes(piece?.tertiary)) return null;
  return STATS.filter(stat =>
    stat !== archetype.primary
    && stat !== archetype.secondary
    && stat !== piece.tertiary);
}

function witnessAssignments(witness) {
  return {
    tuning: witness?.tuningAssignments || witness?.evaluation?.tuningAssignments || null,
    mods: witness?.modAssignments || witness?.evaluation?.modAssignments || null,
  };
}

export function verifyWitness(problemSpec, witness) {
  const errors = [];
  const pieces = witness?.config || witness?.pieces;
  const { tuning, mods } = witnessAssignments(witness);
  if (!problemSpec?.constraintModel) errors.push("problemSpec.constraintModel is required");
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
  if (Array.isArray(pieces) && pieces.length === 5) {
    for (let index = 0; index < pieces.length; index++) {
      const piece = pieces[index];
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
          armorTotals[assignment.from] -= 5;
          armorTotals[assignment.to] += 5;
        }
      } else {
        errors.push(`witness tuning ${index} is missing or unknown`);
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
  const valid = errors.length === 0;
  const verifiedWitness = valid ? {
    ...witness,
    totals: { ...armorTotals },
    armorTotals: { ...armorTotals },
    visibleTotals: { ...visibleTotals },
  } : null;
  return {
    valid,
    errors,
    armorTotals,
    visibleTotals,
    witness: verifiedWitness,
  };
}

export function createResultCertificate({
  status,
  executionStatus = EXECUTION_STATUS.NOT_APPLICABLE,
  problemSpec,
  witness = null,
  proof = {},
  verification = null,
  message = null,
} = {}) {
  if (!RESULT_STATUS_VALUES.has(status)) {
    throw new TypeError(`unknown Solver V3 result status: ${status}`);
  }
  if (!EXECUTION_STATUS_VALUES.has(executionStatus)) {
    throw new TypeError(`unknown Solver V3 execution status: ${executionStatus}`);
  }
  const resolvedVerification = verification
    || (witness ? verifyWitness(problemSpec, witness) : null);
  const verifiedWitness = resolvedVerification?.valid
    ? resolvedVerification.witness
    : null;
  let verifiedStatus = status;
  if (status === RESULT_STATUS.EXACT_TARGET_PROVEN
      && (!verifiedWitness || !matchesExactTarget(
        verifiedWitness,
        problemSpec?.constraintModel,
        problemSpec?.constraintModel?.targetDomain,
      ))) {
    verifiedStatus = RESULT_STATUS.SEARCH_LIMIT_REACHED;
  } else if (status === RESULT_STATUS.RULE_FEASIBLE_PROVEN
      && witness
      && (!verifiedWitness || !satisfiesConstraintModel(
        verifiedWitness,
        problemSpec?.constraintModel,
        problemSpec?.constraintModel?.targetDomain,
      ))) {
    verifiedStatus = RESULT_STATUS.SEARCH_LIMIT_REACHED;
  }
  return {
    schemaVersion: SOLVER_V3_SCHEMA_VERSION,
    status: verifiedStatus,
    executionStatus,
    canonicalId: createCanonicalId(verifiedWitness),
    problem: {
      operation: problemSpec?.operation || null,
      constraintModel: problemSpec?.constraintModel || null,
      budget: problemSpec?.budget || null,
    },
    proof: { ...proof },
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
