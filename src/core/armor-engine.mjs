import { calculateReachableRanges } from "./reachability.mjs";
import { runSolver } from "./solver.mjs";
import { analyzeUpgradeCandidates } from "./upgrade-optimizer.mjs";

export function solveLoadout({
  target,
  numPlus5,
  numPlus10,
  numPlus3,
  constraints = {},
  exoticSettings = null,
  runtimeOptions = {},
}) {
  return runSolver(
    target,
    numPlus5,
    numPlus10,
    numPlus3,
    constraints,
    exoticSettings,
    runtimeOptions,
  );
}

export function calculateReachability({
  fixedPiece,
  numPlus5,
  numPlus10,
  numPlus3,
  fragments,
  lockedTargets,
}) {
  return calculateReachableRanges(
    fixedPiece,
    numPlus5,
    numPlus10,
    numPlus3,
    fragments,
    lockedTargets,
  );
}

export function analyzeUpgrade({
  pieces,
  targets,
  fragments,
  reassignModifiers,
}) {
  return analyzeUpgradeCandidates(
    pieces,
    targets,
    fragments,
    reassignModifiers,
  );
}
