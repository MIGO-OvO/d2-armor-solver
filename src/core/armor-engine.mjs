import {
  calculateReachableRanges,
  findReachabilityWitness,
} from "./reachability.mjs";
import { assignArmorMods } from "./armor-mod-assignment.mjs";
import { solveInventoryLoadout } from "./inventory-solver.mjs";
import { runSolver } from "./solver.mjs";
import {
  EXECUTION_STATUS,
  RESULT_STATUS,
  STAT_DOMAIN,
  attachResultCertificate,
  createProblemSpec,
  createProofEvidence,
  createResultCertificate,
  matchesExactTarget,
  satisfiesConstraintModel,
  verifyWitness,
  sealWitness,
} from "./solver-v3-contract.mjs";
import { analyzeUpgradeCandidates, getUpgradeConfig, getUpgradeModifierBudget } from "./upgrade-optimizer.mjs";
import {SearchBudgetExceeded} from "./search-session.mjs";

function certificateForWitness({
  problemSpec,
  witness,
  witnessDomain,
  executionStatus,
  proof,
}) {
  const verification = witness ? verifyWitness(problemSpec, witness) : null;
  const verifiedWitness = verification?.valid ? verification.witness : null;
  // The builder, not this caller, decides whether an unsuccessful witness
  // has an accompanying complete proof that can establish infeasibility.
  let status = RESULT_STATUS.INFEASIBLE_PROVEN;
  if (!problemSpec.valid) status = RESULT_STATUS.INVALID_INPUT;
  else if (verifiedWitness && matchesExactTarget(
    verifiedWitness,
    problemSpec.constraintModel,
    witnessDomain,
  )) status = RESULT_STATUS.EXACT_TARGET_PROVEN;
  else if (verifiedWitness && satisfiesConstraintModel(
    verifiedWitness,
    problemSpec.constraintModel,
    witnessDomain,
  )) status = RESULT_STATUS.RULE_FEASIBLE_PROVEN;

  return createResultCertificate({
    status,
    executionStatus,
    problemSpec,
    witness,
    proof,
    message: problemSpec.valid ? null : problemSpec.errors.join("; "),
  });
}

export function createSearchLimitResult(operation, payload) {
  const problemSpec = createProblemSpec({operation, ...payload,
    target: payload.targets || payload.target || payload.probeTarget || payload.lockedTargets,
    pieces: payload.items || payload.pieces || (payload.fixedPiece ? [payload.fixedPiece] : []),
    targetDomain: operation === "solve" ? payload.targetDomain || STAT_DOMAIN.ARMOR : STAT_DOMAIN.VISIBLE});
  const result = operation === "solve" ? [] : {results: [], feasible: false, ranges: {}, verified: false};
  return attachResultCertificate(result, certificateForWitness({problemSpec, witness: null,
    witnessDomain: problemSpec.constraintModel.targetDomain, executionStatus: EXECUTION_STATUS.NOT_APPLICABLE,
    proof: createProofEvidence(problemSpec, {method: "effort-budget", truncated: true})}));
}

function annotateWitnesses(witnesses, problemSpec) {
  const verified = [];
  for (const candidate of witnesses || []) {
    const result = sealWitness(problemSpec, candidate);
    if (result.valid) verified.push(result.witness);
  }
  verified.proof = witnesses?.proof;
  return verified;
}

function assessExecution(pieces, inventory, evaluation, availablePlugHashes = null) {
  if (!Array.isArray(pieces) || pieces.length !== 5 || !evaluation) return null;
  const result = assignArmorMods({
    pieces,
    inventory: inventory || pieces,
    tuningAssignments: evaluation.tuningAssignments,
    modAssignments: evaluation.modAssignments,
    availablePlugHashes,
  });
  const armor = evaluation.armorTotals || evaluation.totals;
  if (armor && Object.keys(armor).some(stat => armor[stat] !== result.actualTotals[stat])) {
    result.executionStatus = EXECUTION_STATUS.BLOCKED;
    result.valid = false;
    result.unassignedMods.push({ kind: "item", reason: "witnessTotalsMismatch" });
  }
  return result;
}

export function solveLoadout({
  target,
  numPlus5,
  numPlus10,
  numPlus3,
  constraints = {},
  exoticSettings = null,
  runtimeOptions = {},
  fragments = {},
  targetDomain = STAT_DOMAIN.ARMOR,
}, search = null) {
  const problemSpec = createProblemSpec({
    operation: "solve",
    target,
    fragments,
    constraints,
    targetDomain,
    numPlus5,
    numPlus10,
    numPlus3,
    pieces: exoticSettings?.config ? [exoticSettings.config] : [],
    runtimeOptions,
    exoticSettings,
  });
  if (!problemSpec.valid) {
    return attachResultCertificate([], certificateForWitness({
      problemSpec,
      witness: null,
      witnessDomain: targetDomain,
      executionStatus: EXECUTION_STATUS.NOT_APPLICABLE,
      proof: createProofEvidence(problemSpec, { method: "input-validation" }),
    }));
  }
  const publish = candidate => {
    const checked = sealWitness(problemSpec, candidate);
    if (!checked.valid) return;
    const witness = checked.witness;
    const proof = createProofEvidence(problemSpec, {producer: "heuristic-solver", method: "staged-incumbent", truncated: true});
    attachResultCertificate(witness, certificateForWitness({problemSpec, witness, witnessDomain: targetDomain,
      executionStatus: EXECUTION_STATUS.NOT_APPLICABLE, proof}));
    const result = attachResultCertificate([witness], witness.certificate);
    search?.publish(result);
  };
  let raw;
  try { raw = runSolver(problemSpec, search ? {checkpoint: search.checkpoint, publish} : null); }
  catch (error) {
    if (!(error instanceof SearchBudgetExceeded)) throw error;
    return search.lastResult || attachResultCertificate([], certificateForWitness({problemSpec, witness: null,
      witnessDomain: targetDomain, executionStatus: EXECUTION_STATUS.NOT_APPLICABLE,
      proof: createProofEvidence(problemSpec, {method: "effort-budget", truncated: true})}));
  }
  const solutions = annotateWitnesses(raw, problemSpec);
  for (const witness of solutions) attachResultCertificate(witness, certificateForWitness({
    problemSpec, witness, witnessDomain: targetDomain,
    executionStatus: EXECUTION_STATUS.NOT_APPLICABLE, proof: solutions.proof,
  }));
  return attachResultCertificate(solutions, certificateForWitness({
    problemSpec,
    witness: solutions[0] || null,
    witnessDomain: targetDomain,
    executionStatus: EXECUTION_STATUS.NOT_APPLICABLE,
    proof: solutions.proof,
  }));
}

// Legacy Upgrade callers express explicit bounds in the armor domain but
// targets in the visible domain. Convert once, before ProblemSpec creation.
function upgradeVisibleConstraints(constraints = {}, fragments = {}, targets = {}, requiredStats = []) {
  const convert = values => Object.fromEntries(Object.entries(values || {}).map(([stat, value]) =>
    [stat, Math.max(0, Math.min(200, Number(value) + Number(fragments[stat] || 0)))]));
  const minimums = convert(constraints.minimums);
  const maximums = convert(constraints.maximums);
  for (const stat of requiredStats) if (maximums[stat] === undefined) minimums[stat] = Math.max(minimums[stat] ?? 0, targets[stat] ?? 0);
  return { ...constraints, minimums, maximums };
}

export function calculateReachability({
  fixedPiece,
  numPlus5,
  numPlus10,
  numPlus3,
  fragments,
  lockedTargets,
  probeTarget = null,
}, search = null) {
  search?.checkpoint(0);
  const targetForSpec = {...(lockedTargets || {}), ...(probeTarget || {})};
  const constraints = {
    exact: Object.fromEntries(Object.keys(targetForSpec || {}).map(stat => [stat, true])),
  };
  const problemSpec = createProblemSpec({
    operation: "calculateReachability",
    target: targetForSpec,
    fragments,
    constraints,
    targetDomain: STAT_DOMAIN.VISIBLE,
    numPlus5,
    numPlus10,
    numPlus3,
    pieces: fixedPiece ? [fixedPiece] : [],
  });
  if (probeTarget && Object.entries(lockedTargets || {}).some(([stat, value]) =>
    probeTarget[stat] !== undefined && Number(probeTarget[stat]) !== Number(value))) {
    problemSpec.valid = false;
    problemSpec.errors.push("probeTarget contradicts lockedTargets");
  }
  if (!fixedPiece) {
    problemSpec.valid = false;
    problemSpec.errors.push("fixedPiece is required for reachability");
  }
  if (!problemSpec.valid) {
    return attachResultCertificate(
      { feasible: false, ranges: {} },
      certificateForWitness({
        problemSpec,
        witness: null,
        witnessDomain: STAT_DOMAIN.VISIBLE,
        executionStatus: EXECUTION_STATUS.NOT_APPLICABLE,
        proof: createProofEvidence(problemSpec, { method: "input-validation" }),
      }),
    );
  }
  ({numPlus5, numPlus10, numPlus3} = problemSpec.budget);
  fixedPiece = problemSpec.solverContext.fixedConfig;
  fragments = problemSpec.constraintModel.fragments;
  lockedTargets = Object.fromEntries(Object.keys(lockedTargets || {}).map(stat =>
    [stat, problemSpec.constraintModel.target[stat]]));
  let result;
  try { result = calculateReachableRanges(
    fixedPiece,
    numPlus5,
    numPlus10,
    numPlus3,
    fragments,
    lockedTargets,
    search,
  ); } catch (error) {
    if (!(error instanceof SearchBudgetExceeded)) throw error;
    return attachResultCertificate({feasible: false, ranges: {}, searchStats: {complete: false}},
      certificateForWitness({problemSpec, witness: null, witnessDomain: STAT_DOMAIN.VISIBLE,
        executionStatus: EXECUTION_STATUS.NOT_APPLICABLE, proof: createProofEvidence(problemSpec, {method: "effort-budget", truncated: true})}));
  }
  const probe = probeTarget ? findReachabilityWitness({
    fixedPiece,
    numPlus5,
    numPlus10,
    numPlus3,
    fragments,
    visibleTarget: probeTarget,
    problemSpec,
  }) : null;
  if (probe) result.probe = probe;
  const probeVerification = probe?.witness
    ? verifyWitness(problemSpec, probe.witness)
    : null;
  if (probeVerification?.valid) result.feasible = true;
  const hasClampBoundary = [
    ...Object.values(lockedTargets || {}),
    ...Object.values(probeTarget || {}),
  ].some(value => Number(value) === 0 || Number(value) === 200);
  // The current DP proves point rules only. A caller-supplied intervalProof
  // Boolean is not an interval-complete producer.
  const clampSearchLimited = hasClampBoundary && result.searchStats?.complete === false;
  const probeStatus = probe?.witness && !probeVerification?.valid
    ? RESULT_STATUS.SEARCH_LIMIT_REACHED
    : probe?.status;
  return attachResultCertificate(result, createResultCertificate({
    status: probeStatus === RESULT_STATUS.EXACT_TARGET_PROVEN ? probeStatus : clampSearchLimited
      ? RESULT_STATUS.SEARCH_LIMIT_REACHED
      : probeStatus || (result.feasible
        ? RESULT_STATUS.RULE_FEASIBLE_PROVEN
        : RESULT_STATUS.INFEASIBLE_PROVEN),
    executionStatus: EXECUTION_STATUS.NOT_APPLICABLE,
    problemSpec,
    witness: probe?.witness || null,
    proof: probe?.proof || createProofEvidence(problemSpec, {
      producer: "reachability-dp",
      method: hasClampBoundary ? "interval-complete-dynamic-programming" : "point-rule-dynamic-programming",
      complete: !clampSearchLimited,
      statesExamined: result.searchStats?.statesExamined ?? 0,
      assumptions: ["known-data", "complete-catalog", "point-rules-only"],
      outcome: result.feasible ? "feasible" : "infeasible",
      limitation: clampSearchLimited ? "clamped boundary requires an interval-complete proof" : null,
    }),
  }));
}

export function analyzeUpgrade({
  pieces,
  targets,
  fragments,
  reassignModifiers,
  requiredStats = [],
  onlyPlus5Tuning = false,
  constraints = {},
  runtimeOptions = {},
}, search = null) {
  const problemSpec = createProblemSpec({
    operation: "analyzeUpgrade",
    targets,
    fragments,
    constraints: upgradeVisibleConstraints(constraints, fragments, targets, requiredStats),
    targetDomain: STAT_DOMAIN.VISIBLE,
    pieces,
  });
  if (!problemSpec.valid) {
    return attachResultCertificate({
      pieces: pieces || [],
      targets: targets || {},
      fragments: fragments || {},
      requiredStats: [],
      constraints,
      reassignModifiers,
      projectedMasterworkIndices: [],
      enteredBaseline: null,
      baseline: null,
      rankings: [],
      best: null,
      plan: null,
    }, certificateForWitness({
      problemSpec,
      witness: null,
      witnessDomain: STAT_DOMAIN.VISIBLE,
      executionStatus: EXECUTION_STATUS.NOT_APPLICABLE,
      proof: createProofEvidence(problemSpec, { method: "input-validation" }),
    }));
  }
  const result = analyzeUpgradeCandidates(
    pieces,
    problemSpec.constraintModel.target,
    problemSpec.constraintModel.fragments,
    reassignModifiers,
    requiredStats,
    onlyPlus5Tuning,
    constraints,
    search ? {checkpoint: search.checkpoint, runtimeOptions, publish: raw => {
      search.publish(certifyUpgradeResult(raw, problemSpec, pieces, reassignModifiers, onlyPlus5Tuning, requiredStats));
    }} : null,
  );
  return certifyUpgradeResult(result, problemSpec, pieces, reassignModifiers, onlyPlus5Tuning, requiredStats);
}

function certifyUpgradeResult(result, problemSpec, pieces, reassignModifiers, onlyPlus5Tuning, requiredStats) {
  result = structuredClone(result);
  const materialize = (physical, evaluation) => physical.map((piece, index) => ({
    ...piece, ...getUpgradeConfig(piece),
    archetypeId: piece.archetypeId,
    baseStats: { ...evaluation.configs[index].baseStats },
    physicalBaseStats: { ...(piece.physicalBaseStats || getUpgradeConfig(piece).baseStats) },
    requiresMasterwork: piece.requiresMasterwork || Object.keys(piece.baseStats || {}).some(stat =>
      piece.baseStats[stat] !== evaluation.configs[index].baseStats[stat]),
  }));
  problemSpec.inventoryContext = { reassignModifiers, onlyPlus5Tuning, requiredStats };
  problemSpec.budget = getUpgradeModifierBudget(pieces, { reassignModifiers, onlyPlus5Tuning });
  const bind = (physical, evaluation) => {
    const candidate = { ...evaluation, pieces: materialize(physical, evaluation),
      fragments: problemSpec.constraintModel.fragments };
    // Evaluation caches store arithmetic, never the identity of a different
    // snapshot which happened to have the same arithmetic key.
    delete candidate.canonicalId;
    delete candidate.certificate;
    delete candidate.problemSpec;
    const verification = sealWitness(problemSpec, candidate);
    if (verification.valid) {
      Object.assign(evaluation, verification.witness, { finalTotals: verification.visibleTotals });
      attachResultCertificate(evaluation, certificateForWitness({problemSpec, witness: verification.witness,
        witnessDomain: STAT_DOMAIN.VISIBLE, executionStatus: EXECUTION_STATUS.NOT_APPLICABLE,
        proof: createProofEvidence(problemSpec, {method: "verified-upgrade-evaluation", truncated: true})}));
      return verification.witness;
    }
    evaluation.verificationErrors = verification.errors;
    evaluation.verified = false;
    return null;
  };
  const baselineWitness = bind(result.pieces, result.baseline);
  const enteredSpec = { ...problemSpec, inventoryContext: { ...problemSpec.inventoryContext, onlyPlus5Tuning: false } };
  const entered = sealWitness(enteredSpec, {
    ...result.enteredBaseline, pieces: materialize(result.pieces, result.enteredBaseline),
  });
  if (entered.valid) {
    Object.assign(result.enteredBaseline, entered.witness, { finalTotals: entered.visibleTotals });
    attachResultCertificate(result.enteredBaseline, certificateForWitness({problemSpec: enteredSpec, witness: entered.witness,
      witnessDomain: STAT_DOMAIN.VISIBLE, executionStatus: EXECUTION_STATUS.NOT_APPLICABLE,
      proof: createProofEvidence(enteredSpec, {method: "entered-baseline", truncated: true})}));
  }
  let witness = baselineWitness;
  if (result.plan) {
    witness = bind(result.plan.pieces, result.plan.evaluation);
    if (witness) {
      result.plan.pieces = witness.pieces;
      result.plan.canonicalId = witness.canonicalId;
      result.plan.verifiedWitness = witness;
      for (const step of result.plan.steps || []) {
        const snapshot = bind(step.pieces, step.evaluation);
        if (!snapshot) witness = null;
        else step.verifiedWitness = snapshot;
      }
      const last = result.plan.steps?.at(-1)?.verifiedWitness;
      if (last && last.canonicalId !== result.plan.canonicalId) {
        result.plan.consistencyErrors = ["last step does not equal final witness"];
        witness = null;
      }
    }
  }
  result.verified = Boolean(witness && baselineWitness);
  const execution = assessExecution(
    result.plan?.pieces || result.pieces,
    pieces,
    result.plan?.evaluation || result.baseline,
  );
  result.execution = execution;
  return attachResultCertificate(result, certificateForWitness({
    problemSpec,
    witness,
    witnessDomain: STAT_DOMAIN.VISIBLE,
    executionStatus: execution?.executionStatus || EXECUTION_STATUS.NOT_APPLICABLE,
    proof: createProofEvidence(problemSpec, {
      producer: "upgrade-candidate-search",
      method: "upgrade-candidate-search",
      truncated: true,
    }),
  }));
}

export function solveInventory(payload, search = null) {
  const problemSpec = createProblemSpec({
    operation: "solveInventory",
    targets: payload?.targets,
    fragments: payload?.fragments,
    constraints: upgradeVisibleConstraints(payload?.userConstraints, payload?.fragments, payload?.targets, payload?.requiredStats),
    targetDomain: STAT_DOMAIN.VISIBLE,
    pieces: payload?.items,
    runtimeOptions: {verifyInventoryCandidates: true},
    inventoryContext: {
      setRequirement: payload?.setRequirement || null,
      reassignModifiers: payload?.reassignModifiers !== false,
      onlyPlus5Tuning: Boolean(payload?.onlyPlus5Tuning),
      requiredStats: payload?.requiredStats || [],
      currentPieces: payload?.currentPieces || null,
    },
  });
  if (!problemSpec.valid) {
    return attachResultCertificate({
      requirement: payload?.setRequirement || null,
      requiredStats: [],
      examined: 0,
      results: [],
    }, certificateForWitness({
      problemSpec,
      witness: null,
      witnessDomain: STAT_DOMAIN.VISIBLE,
      executionStatus: EXECUTION_STATUS.NOT_APPLICABLE,
      proof: createProofEvidence(problemSpec, { method: "input-validation" }),
    }));
  }
  let result;
  try {
    result = solveInventoryLoadout({...payload,
      targets: problemSpec.constraintModel.target, fragments: problemSpec.constraintModel.fragments}, problemSpec,
    search ? {checkpoint: search.checkpoint, publish: raw => {
      const certified = certifyInventoryResult(raw, problemSpec, payload);
      search.publish(certified, raw.searchStats);
    }} : null);
  } catch (error) {
    if (!(error instanceof SearchBudgetExceeded)) throw error;
    return search.lastResult || certifyInventoryResult({results: [], searchStats: {frontierComplete: false}, examined: 0}, problemSpec, payload);
  }
  return certifyInventoryResult(result, problemSpec, payload);
}

function certifyInventoryResult(result, problemSpec, payload) {
  if (!result) return result;
  for (const entry of result.results || []) {
    const verification = sealWitness(problemSpec, entry);
    entry.verified = verification.valid;
    entry.verificationErrors = verification.errors;
    if (verification.valid) Object.assign(entry, verification.witness, {
      finalTotals: verification.visibleTotals,
    });
    if (verification.valid) {
      const rules = problemSpec.constraintModel.rules;
      entry.ruleResults = Object.fromEntries(rules.map(rule => {
        const actual = entry.armorTotals[rule.stat];
        const met = (rule.armorMinimum === null || actual >= rule.armorMinimum)
          && (rule.armorMaximum === null || actual <= rule.armorMaximum);
        return [rule.stat, {met, actual: entry.visibleTotals[rule.stat]}];
      }));
      // Target defaults in the Upgrade UX are minimums; explicit hard rules
      // can never be overruled by its historical quality metric.
      if (!satisfiesConstraintModel(entry, problemSpec.constraintModel)) entry.metrics.allReached = false;
    }
    entry.execution = assessExecution(
      entry.pieces,
      payload?.items,
      entry,
      payload?.availablePlugHashes || null,
    );
    attachResultCertificate(entry, certificateForWitness({problemSpec, witness: entry,
      witnessDomain: STAT_DOMAIN.VISIBLE, executionStatus: entry.execution?.executionStatus || EXECUTION_STATUS.UNVERIFIED,
      proof: result.proof }));
  }
  result.unverifiedCount = (result.rejectedWitnesses || 0) + result.results.filter(entry => !entry.verified).length;
  result.results = result.results.filter(entry => entry.verified);
  return attachResultCertificate(result, certificateForWitness({
    problemSpec,
    witness: result.results[0] || null,
    witnessDomain: STAT_DOMAIN.VISIBLE,
    executionStatus: result.results[0]?.execution?.executionStatus
      || EXECUTION_STATUS.NOT_APPLICABLE,
    proof: result.proof,
  }));
}
