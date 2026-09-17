// Pure certificate projection. Missing/old certificates are never promoted
// using a score, a metric flag, or UI-side target arithmetic.
export function certifiedFeasible(result) {
  return ["EXACT_TARGET_PROVEN", "RULE_FEASIBLE_PROVEN"].includes(result?.certificate?.status);
}

// Count retained, verified candidates, not search nodes or a claim that every
// candidate satisfies the rules. Upgrade exposes one final plan/baseline.
export function candidateSolutionCount(result) {
  const candidates = Array.isArray(result) ? result : Array.isArray(result?.results)
    ? result.results : [result?.plan?.evaluation || result?.baseline];
  return candidates.filter(candidate => candidate?.certificate?.witnessVerification?.valid === true).length;
}

export function proofPresentation(result, search = result?.search) {
  const certificate = result?.certificate;
  const status = certificate?.status;
  const running = search?.running === true;
  const complete = search?.coverage?.frontierComplete ?? certificate?.proof?.complete ?? false;
  let key = "unverified";
  if (status === "EXACT_TARGET_PROVEN") key = "exact";
  else if (status === "RULE_FEASIBLE_PROVEN") key = running || !complete ? "feasibleSearching" : "feasible";
  else if (status === "INFEASIBLE_PROVEN") key = "infeasible";
  else if (status === "INVALID_INPUT") key = "invalid";
  else if (status === "SEARCH_LIMIT_REACHED") key = running ? "searching" : "limited";
  return {key, status: status || null, feasible: certifiedFeasible(result), running, complete,
    termination: search?.termination || null,
    stats: certificate?.statResults || {}, executionStatus: certificate?.executionStatus || "UNVERIFIED"};
}
