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
  createResultCertificate,
  matchesExactTarget,
  satisfiesConstraintModel,
} from "./solver-v3-contract.mjs";
import { analyzeUpgradeCandidates } from "./upgrade-optimizer.mjs";

function certificateForWitness({
  problemSpec,
  witness,
  witnessDomain,
  executionStatus,
  proof,
  emptyStatus = RESULT_STATUS.SEARCH_LIMIT_REACHED,
}) {
  let status = emptyStatus;
  if (!problemSpec.valid) status = RESULT_STATUS.INVALID_INPUT;
  else if (witness && matchesExactTarget(
    witness,
    problemSpec.constraintModel,
    witnessDomain,
  )) status = RESULT_STATUS.EXACT_TARGET_PROVEN;
  else if (witness && satisfiesConstraintModel(
    witness,
    problemSpec.constraintModel,
    witnessDomain,
  )) status = RESULT_STATUS.RULE_FEASIBLE_PROVEN;

  // Infeasibility is a property of a trusted, operation-specific proof, not
  // of a caller-provided Boolean. Producers that can prove an empty domain
  // must opt in through emptyStatus; arbitrary `proof.exhaustive` metadata is
  // never sufficient to upgrade a bounded miss into INFEASIBLE_PROVEN.

  return createResultCertificate({
    status,
    executionStatus,
    problemSpec,
    witness,
    proof,
    message: problemSpec.valid ? null : problemSpec.errors.join("; "),
  });
}

function annotateWitnesses(witnesses) {
  for (const witness of witnesses || []) {
    if (witness && typeof witness === "object") {
      witness.canonicalId = createCanonicalId(witness);
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
  });
  if (!problemSpec.valid) {
    return attachResultCertificate([], certificateForWitness({
      problemSpec,
      witness: null,
      witnessDomain: targetDomain,
      executionStatus: EXECUTION_STATUS.NOT_APPLICABLE,
      proof: { method: "input-validation", exhaustive: false },
    }));
  }
  const solutions = annotateWitnesses(runSolver(
    target,
    numPlus5,
    numPlus10,
    numPlus3,
    constraints,
    exoticSettings,
    runtimeOptions,
  ));
  return attachResultCertificate(solutions, certificateForWitness({
    problemSpec,
    witness: solutions[0] || null,
    witnessDomain: targetDomain,
    executionStatus: EXECUTION_STATUS.NOT_APPLICABLE,
    proof: {
      method: solutions.proofMethod || (solutions[0] && matchesExactTarget(
        solutions[0], problemSpec.constraintModel, targetDomain,
      ) ? "exact-target-oracle" : "bounded-fallback-search"),
      exhaustive: Boolean(solutions.searchComplete),
    },
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
  const constraints = {
    exact: Object.fromEntries(Object.keys(lockedTargets || {}).map(stat => [stat, true])),
  };
  const problemSpec = createProblemSpec({
    operation: "calculateReachability",
    target: lockedTargets,
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
        proof: { method: "input-validation", exhaustive: false },
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
  }) : null;
  if (probe) result.probe = probe;
  const hasClampBoundary = [
    ...Object.values(lockedTargets || {}),
    ...Object.values(probeTarget || {}),
  ].some(value => Number(value) === 0 || Number(value) === 200);
  const hasIntervalProof = result.intervalProof === true || probe?.intervalProof === true;
  const clampSearchLimited = hasClampBoundary && !hasIntervalProof;
  return attachResultCertificate(result, createResultCertificate({
    status: clampSearchLimited
      ? RESULT_STATUS.SEARCH_LIMIT_REACHED
      : probe?.status || (result.feasible
        ? RESULT_STATUS.RULE_FEASIBLE_PROVEN
        : RESULT_STATUS.INFEASIBLE_PROVEN),
    executionStatus: EXECUTION_STATUS.NOT_APPLICABLE,
    problemSpec,
    proof: {
      method: "reachability-dynamic-programming",
      exhaustive: clampSearchLimited ? false : (probe ? probe.exhaustive : true),
      witnessProducing: Boolean(probe?.witness),
      ...(clampSearchLimited ? {
        limitation: "clamped boundary requires an interval-complete proof",
      } : {}),
    },
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
      proof: { method: "input-validation", exhaustive: false },
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
  const witness = result.plan || result.baseline || null;
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
    proof: {
      method: "upgrade-candidate-search",
      exhaustive: false,
    },
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
      proof: { method: "input-validation", exhaustive: false },
    }));
  }
  const result = solveInventoryLoadout(payload);
  if (!result) return result;
  const hasUnknownCapabilityData = problemSpec.pieceCapabilities.some(
    capability => !capability.executionKnown,
  );
  const canProveInventoryInfeasible = Boolean(result.searchComplete)
    && !hasUnknownCapabilityData;
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
    proof: {
      method: canProveInventoryInfeasible
        ? "inventory-equivalence-frontier"
        : "inventory-frontier-with-legacy-assignment-evaluator",
      exhaustive: canProveInventoryInfeasible,
      ...(hasUnknownCapabilityData ? {
        limitation: "one or more inventory capabilities contain unknown data",
      } : {}),
    },
    emptyStatus: canProveInventoryInfeasible
      ? RESULT_STATUS.INFEASIBLE_PROVEN
      : RESULT_STATUS.SEARCH_LIMIT_REACHED,
  }));
}
