// Request execution metadata is deliberately separate from serializable
// ProblemSpec. Profiles change effort, never the mathematical rules.
export const SEARCH_PROFILES = Object.freeze({
  // maxNodes = streamed/DFS primitive visits; maxStates = retained states
  // (join buckets/frontiers); maxEvaluations = expensive full evaluator calls;
  // maxTimeMs = wall-clock safety limit. Profiles change effort only.
  fast: Object.freeze({maxTimeMs: 200, maxNodes: 100000, maxStates: 10000, maxEvaluations: 3000, fastMode: true, proveFuzzy: false, exhaustive: false}),
  balanced: Object.freeze({maxTimeMs: 3000, maxNodes: 2000000, maxStates: 50000, maxEvaluations: 50000, fastMode: false, proveFuzzy: false, exhaustive: false}),
  // Deep is the explicit full-inventory pass. The UI still retains Top-K
  // witnesses, while the frontier continues until it is exhausted.
  deep: Object.freeze({maxTimeMs: 120000, maxNodes: 500000000, maxStates: 2000000, maxEvaluations: 5000000, fastMode: false, proveFuzzy: true, exhaustive: true}),
});
export const SEARCH_STAGES_MS = Object.freeze([150, 500, 1500, 3000]);

export function withSearchProfile(operation, payload = {}) {
  const profile = Object.hasOwn(SEARCH_PROFILES, payload.searchProfile) ? payload.searchProfile : "balanced";
  const options = SEARCH_PROFILES[profile];
  const maxNodes = operation === "solveInventory" || profile === "fast" ? options.maxNodes
    : profile === "deep" ? 500000000 : 50000000;
  return {...payload, searchProfile: profile,
    runtimeOptions: {...payload.runtimeOptions, fastMode: options.fastMode, proveFuzzy: options.proveFuzzy},
    searchLimits: {...payload.searchLimits, maxTimeMs: options.maxTimeMs,
      maxNodes, maxStates: options.maxStates, maxEvaluations: options.maxEvaluations,
      exhaustive: options.exhaustive || payload.searchLimits?.exhaustive === true},
  };
}

export class SearchBudgetExceeded extends Error {
  constructor() { super("Search effort budget reached"); this.name = "SearchBudgetExceeded"; }
}

export function createSearchSession({operation, generation, profile = "balanced", onProgress = () => {}, now = () => performance.now()}) {
  const started = now();
  const limits = withSearchProfile(operation, {searchProfile: profile}).searchLimits;
  const maxTimeMs = limits.maxTimeMs;
  let nodes = 0;
  let firstExactMs = null;
  let firstFeasibleMs = null;
  let lastResult = null;
  let lastPublished = -Infinity;
  let stage = 0;
  let coverage = {};
  let budgetReached = false;
  const metadata = (running, termination = null) => ({schemaVersion: 1, operation, generation, profile,
    elapsedMs: now() - started, nodes, firstExactMs, firstFeasibleMs, running, termination,
    stageMs: SEARCH_STAGES_MS[Math.min(stage, SEARCH_STAGES_MS.length - 1)],
    coverage: {...coverage},
  });
  const progress = (result = null, force = false) => {
    const elapsed = now() - started;
    if (!force && elapsed - lastPublished < 100) return;
    lastPublished = elapsed;
    onProgress({result, search: metadata(true)});
  };
  return {
    profile,
    limits,
    shouldPublish() { return lastResult === null || now() - lastPublished >= 100; },
    checkpoint(count = 1, statistics = null) {
      nodes = statistics?.statesExamined ?? nodes + count;
      if (statistics) coverage = {...statistics};
      if (now() - started >= SEARCH_STAGES_MS[stage] && stage < SEARCH_STAGES_MS.length) {
        stage++;
        progress(lastResult, true);
      }
      if (now() - started >= maxTimeMs || nodes >= limits.maxNodes) { budgetReached = true; throw new SearchBudgetExceeded(); }
    },
    publish(result, statistics = null) {
      if (!result?.certificate?.witnessVerification?.valid) return;
      if (statistics) coverage = {...statistics};
      const status = result.certificate.status;
      const exact = status === "EXACT_TARGET_PROVEN";
      const feasible = exact || status === "RULE_FEASIBLE_PROVEN";
      const first = feasible && firstFeasibleMs === null || exact && firstExactMs === null;
      if (feasible) firstFeasibleMs ??= now() - started;
      if (exact) firstExactMs ??= now() - started;
      // Never replace a known feasible witness with a violating fallback.
      const oldStatus = lastResult?.certificate?.status;
      if (oldStatus === "EXACT_TARGET_PROVEN" && !exact
          || oldStatus === "RULE_FEASIBLE_PROVEN" && !feasible) return;
      lastResult = result;
      progress(result, first);
    },
    finish(result, termination = "completed") {
      if (budgetReached) termination = "budget";
      if (result) this.publish(result, result.searchStats);
      // Terminal truth ordering, not witness presence ordering. A trusted
      // complete negative proof must outrank an earlier incomplete positive
      // candidate, while any proven positive witness is never demoted by a
      // weaker terminal state (a contradictory terminal negative cannot be
      // issued by the same certificate boundary in the first place).
      const priority = value => ({EXACT_TARGET_PROVEN: 4, RULE_FEASIBLE_PROVEN: 3,
        INFEASIBLE_PROVEN: 2, SEARCH_LIMIT_REACHED: 1}[value?.certificate?.status] || 0);
      const chosen = priority(lastResult) > priority(result) ? lastResult : result || lastResult;
      nodes = Math.max(nodes, chosen?.searchStats?.statesExamined || 0, chosen?.certificate?.proof?.statesExamined || 0);
      if (chosen?.searchStats) coverage = {...chosen.searchStats, ...coverage};
      coverage.statesExamined = Math.max(coverage.statesExamined || 0, nodes);
      coverage.complete = termination === "completed" && chosen?.certificate?.proof?.complete === true;
      if (termination !== "completed") {
        coverage.frontierComplete = false;
        coverage.termination = termination;
      }
      if (chosen) chosen.search = metadata(false, termination);
      return chosen;
    },
    get lastResult() { return lastResult; },
    metadata,
  };
}
