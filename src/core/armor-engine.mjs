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
  createCanonicalId,
  createProblemSpec,
  createProofEvidence,
  createResultCertificate,
  matchesExactTarget,
  satisfiesConstraintModel,
  verifyWitness,
} from "./solver-v3-contract.mjs";
import { analyzeUpgradeCandidates } from "./upgrade-optimizer.mjs";

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

function annotateWitnesses(witnesses, problemSpec) {
  for (const witness of witnesses || []) {
    if (witness && typeof witness === "object") {
      const verification = verifyWitness(problemSpec, witness);
      if (verification.valid) {
        witness.totals = { ...verification.armorTotals };
        witness.armorTotals = { ...verification.armorTotals };
        witness.visibleTotals = { ...verification.visibleTotals };
        witness.canonicalId = createCanonicalId(verification.witness);
      }
    }
  }
  return witnesses;
}

function assessExecution(pieces, inventory, evaluation, availablePlugHashes = null) {
  if (!Array.isArray(pieces) || pieces.length !== 5 || !evaluation) return null;
  return assignArmorMods({
    pieces,
    inventory: inventory || pieces,
    tuningAssignments: evaluation.tuningAssignments,
    modAssignments: evaluation.modAssignments,
    availablePlugHashes,
  });
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
}) {
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
  const solutions = annotateWitnesses(runSolver(problemSpec), problemSpec);
  return attachResultCertificate(solutions, certificateForWitness({
    problemSpec,
    witness: solutions[0] || null,
    witnessDomain: targetDomain,
    executionStatus: EXECUTION_STATUS.NOT_APPLICABLE,
    proof: solutions.proof,
  }));
}

export function calculateReachability({
  fixedPiece,
  numPlus5,
  numPlus10,
  numPlus3,
  fragments,
  lockedTargets,
  probeTarget = null,
}) {
  const targetForSpec = probeTarget || lockedTargets;
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
  const result = calculateReachableRanges(
    fixedPiece,
    numPlus5,
    numPlus10,
    numPlus3,
    fragments,
    lockedTargets,
  );
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
  const hasClampBoundary = [
    ...Object.values(lockedTargets || {}),
    ...Object.values(probeTarget || {}),
  ].some(value => Number(value) === 0 || Number(value) === 200);
  // The current DP proves point rules only. A caller-supplied intervalProof
  // Boolean is not an interval-complete producer.
  const clampSearchLimited = hasClampBoundary;
  const probeStatus = probe?.witness && !probeVerification?.valid
    ? RESULT_STATUS.SEARCH_LIMIT_REACHED
    : probe?.status;
  return attachResultCertificate(result, createResultCertificate({
    status: clampSearchLimited
      ? RESULT_STATUS.SEARCH_LIMIT_REACHED
      : probeStatus || (result.feasible
        ? RESULT_STATUS.RULE_FEASIBLE_PROVEN
        : RESULT_STATUS.INFEASIBLE_PROVEN),
    executionStatus: EXECUTION_STATUS.NOT_APPLICABLE,
    problemSpec,
    witness: probe?.witness || null,
    proof: probe?.proof || createProofEvidence(problemSpec, {
      producer: "reachability-dp",
      method: "point-rule-dynamic-programming",
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
}) {
  const problemSpec = createProblemSpec({
    operation: "analyzeUpgrade",
    targets,
    fragments,
    constraints,
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
    targets,
    fragments,
    reassignModifiers,
    requiredStats,
    onlyPlus5Tuning,
    constraints,
  );
  const witness = result.plan || (result.baseline ? {
    pieces: result.pieces,
    evaluation: result.baseline,
  } : null);
  if (result.plan) result.plan.canonicalId = createCanonicalId(result.plan);
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

export function solveInventory(payload) {
  const problemSpec = createProblemSpec({
    operation: "solveInventory",
    targets: payload?.targets,
    fragments: payload?.fragments,
    constraints: payload?.userConstraints,
    targetDomain: STAT_DOMAIN.VISIBLE,
    pieces: payload?.items,
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
  const result = solveInventoryLoadout(payload, problemSpec);
  if (!result) return result;
  const witness = result.results?.[0] || null;
  for (const entry of result.results || []) {
    entry.canonicalId = createCanonicalId(entry);
    entry.execution = assessExecution(
      entry.pieces,
      payload?.items,
      entry,
      payload?.availablePlugHashes || null,
    );
  }
  return attachResultCertificate(result, certificateForWitness({
    problemSpec,
    witness,
    witnessDomain: STAT_DOMAIN.VISIBLE,
    executionStatus: witness?.execution?.executionStatus
      || EXECUTION_STATUS.NOT_APPLICABLE,
    proof: result.proof,
  }));
}
