import { STATS } from "./armor-model.mjs";

export function createTargetConstraints({
  modes = {},
  priorityLevels = {},
  targetValues = {},
  maximumValues = {},
} = {}) {
  const normalizedPriorities = {};
  const minimums = {};
  const maximums = {};
  const exact = {};

  for (const stat of STATS) {
    const level = priorityLevels[stat] || 0;
    if (level > 0) normalizedPriorities[stat] = level;

    const mode = modes[stat] || "=";
    if (mode === "=") {
      exact[stat] = true;
    } else if (mode === ">=") {
      minimums[stat] = targetValues[stat];
    } else if (mode === "<=") {
      maximums[stat] = targetValues[stat];
    } else if (mode === "range") {
      minimums[stat] = targetValues[stat];
      maximums[stat] = maximumValues[stat];
    }
  }

  return {
    targetRules: true,
    priorityLevels: normalizedPriorities,
    minimums,
    maximums,
    exact,
  };
}

export function satisfiesTargetConstraints(actual, target, constraints = {}) {
  const exact = constraints.exact || {};
  const minimums = constraints.minimums || {};
  const maximums = constraints.maximums || {};

  return STATS.every(stat => {
    if (exact[stat] && actual[stat] !== target[stat]) return false;
    if (minimums[stat] !== undefined && actual[stat] < minimums[stat]) {
      return false;
    }
    if (maximums[stat] !== undefined && actual[stat] > maximums[stat]) {
      return false;
    }
    return true;
  });
}

export function preferConstraintSatisfyingSolutions(
  solutions,
  target,
  constraints = {},
) {
  const satisfying = solutions.filter(solution =>
    satisfiesTargetConstraints(solution.totals, target, constraints));
  if (satisfying.length === 0) return solutions;
  for (const key of ["certificate", "status", "executionStatus", "searchComplete", "proofMethod"]) {
    if (solutions[key] !== undefined) satisfying[key] = solutions[key];
  }
  return satisfying;
}
