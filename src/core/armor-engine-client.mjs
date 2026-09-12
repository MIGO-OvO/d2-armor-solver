import {createSearchSession, withSearchProfile, SearchBudgetExceeded} from "./search-session.mjs";
const workers = new Map();
const generations = new Map();
const pendingRequests = new Map();
let nextRequestId = 1;
let inventoryBatch = null;
const OFFLINE_MODE = typeof __OFFLINE_MODE__ !== "undefined" && __OFFLINE_MODE__ === "true";

function createWorker(operation, workerKey = operation) {
  const existing = workers.get(workerKey);
  if (existing || OFFLINE_MODE || typeof Worker === "undefined") return existing || null;
  let worker;
  try {
    worker = new Worker(new URL("../workers/armor-engine.worker.mjs", import.meta.url), {type: "module", name: `armor-engine-${operation}`});
  } catch { return null; }
  workers.set(workerKey, worker);
  worker.addEventListener("message", ({data}) => {
    const pending = pendingRequests.get(data?.id);
    if (!pending || data.generation !== pending.generation) return;
    if (data.type === "progress") {
      pending.onProgress?.(data.result, data.search);
      return;
    }
    pendingRequests.delete(data.id);
    pending.cleanup?.();
    if (data.error) {
      const error = new Error(data.error.message);
      error.name = data.error.name;
      pending.reject(error);
    } else pending.resolve(data.result);
  });
  worker.addEventListener("error", event => {
    for (const [id, pending] of pendingRequests) if (pending.workerKey === workerKey) {
      pendingRequests.delete(id); pending.cleanup?.();
      pending.reject(event.error || new Error(event.message || "Armor worker failed"));
    }
    worker.terminate(); workers.delete(workerKey);
  });
  return worker;
}

export function cancelOperation(operation) {
  if (operation === 'solveInventory' && inventoryBatch) {
    const batch = inventoryBatch;
    inventoryBatch = null;
    batch.abort();
  }
  for (const [key, worker] of workers) if (key === operation || key.startsWith(`${operation}:`)) {
    worker.terminate(); workers.delete(key);
  }
  generations.set(operation, (generations.get(operation) || 0) + 1);
  for (const [id, pending] of pendingRequests) if (pending.operation === operation) {
    pendingRequests.delete(id); pending.cleanup?.();
    const error = new Error(`Cancelled ${operation} request`); error.name = "AbortError";
    pending.reject(error);
  }
}

export function cancelAllSearches() {
  for (const operation of ["solve", "solveInventory", "analyzeUpgrade", "calculateReachability"]) cancelOperation(operation);
}

function run(operation, input, {onProgress = null, signal = null} = {}, workerKey = operation) {
  // Only batch-owned workers run concurrently. Ordinary operations supersede
  // pending work instead of queueing behind a synchronous solver invocation.
  if (workerKey === operation && ([...pendingRequests.values()].some(pending => pending.operation === operation)
      || operation === 'solveInventory' && inventoryBatch)) cancelOperation(operation);
  const generation = (generations.get(operation) || 0) + 1;
  generations.set(operation, generation);
  const id = nextRequestId++;
  const payload = withSearchProfile(operation, structuredClone(input));
  const activeWorker = createWorker(operation, workerKey);
  return new Promise((resolve, reject) => {
    const abort = () => {
      const current = pendingRequests.get(id);
      if (!current) return;
      if (workerKey === operation) { cancelOperation(operation); return; }
      pendingRequests.delete(id); current.cleanup?.();
      const error = new Error(`Cancelled ${operation} request`); error.name = "AbortError";
      current.reject(error);
    };
    const pending = {operation, workerKey, generation, resolve, reject, onProgress,
      cleanup: () => {
        signal?.removeEventListener("abort", abort);
        if (workerKey !== operation) { activeWorker?.terminate(); workers.delete(workerKey); }
      }};
    pendingRequests.set(id, pending);
    signal?.addEventListener("abort", abort, {once: true});
    if (signal?.aborted) { abort(); return; }
    if (activeWorker) {
      try { activeWorker.postMessage({type: "start", id, generation, operation, payload}); }
      catch (error) { pendingRequests.delete(id); pending.cleanup(); reject(error); }
      return;
    }
    // Inline fallback uses the same generation/progress contract. It cannot
    // pre-empt JavaScript inside one synchronous checkpoint-free primitive.
    import("./armor-engine.mjs").then(engine => {
      if (!pendingRequests.has(id)) return;
      const session = createSearchSession({operation, generation, profile: payload.searchProfile,
        onProgress: event => { if (pendingRequests.has(id)) onProgress?.(event.result, event.search); }});
      const execute = {solve: engine.solveLoadout, solveInventory: engine.solveInventory,
        analyzeUpgrade: engine.analyzeUpgrade, calculateReachability: engine.calculateReachability}[operation];
      let computed;
      try { computed = execute(payload, session); }
      catch (error) {
        if (!(error instanceof SearchBudgetExceeded)) throw error;
        computed = session.lastResult || engine.createSearchLimitResult(operation, payload);
      }
      const result = session.finish(computed);
      if (pendingRequests.has(id)) { pendingRequests.delete(id); pending.cleanup(); resolve(result); }
    }).catch(error => {
      if (pendingRequests.has(id)) { pendingRequests.delete(id); pending.cleanup(); reject(error); }
    });
  });
}

export const solveLoadoutAsync = (payload, options) => run("solve", payload, options);
export const analyzeUpgradeAsync = (payload, options) => run("analyzeUpgrade", payload, options);
export const calculateReachabilityAsync = (payload, options) => run("calculateReachability", payload, options);
export const solveInventoryAsync = (payload, options) => run("solveInventory", payload, options);

// A merge re-verifies every retained witness against the whole vault, which
// costs hundreds of milliseconds on a 1300-piece inventory. Publishing on every
// shard callback therefore costs O(events x vault) on the main thread and made
// a 3 s Balanced search take ~27 s of wall clock. Progressive publication is
// coalesced to one merge per interval (the first one is immediate, so a positive
// witness still reaches the UI without waiting for the batch to finish).
const PROGRESS_MERGE_INTERVAL_MS = 150;

// A batch owns separate workers; normal operation workers remain reusable.
export async function solveInventoryParallelAsync(payload, {parallelism = 2, ...options} = {}) {
  if (!Number.isSafeInteger(parallelism) || parallelism < 1 || parallelism > 8) {
    throw new RangeError("parallelism must be an integer between 1 and 8");
  }
  // The search profile owns effort. Forcing `exhaustive: true` here silently
  // removed Fast/Balanced early termination (their `exact-witness-quota` stop),
  // so every browser solve paid Deep's cost. The wrapper only forwards the
  // shard coordinates; `withSearchProfile` still honours an explicit
  // `searchLimits.exhaustive === true` from the caller.
  const request = structuredClone({...payload, shardIndex: 0, shardCount: 1});
  if (parallelism === 1 || OFFLINE_MODE || typeof Worker === "undefined") return solveInventoryAsync(request, options);
  cancelOperation('solveInventory');
  const batch = nextRequestId++;
  const controller = new AbortController();
  inventoryBatch = controller;
  const started = performance.now();
  const partials = Array(parallelism).fill(null);
  const searches = Array(parallelism).fill(null);
  let firstExactMs = null;
  let firstFeasibleMs = null;
  let mergeModule = null;
  let progressRevision = 0;
  const engine = () => mergeModule ||= import('./armor-engine.mjs');
  const active = () => !controller.signal.aborted && inventoryBatch === controller;
  // `nodes` is the aggregate across shards; each shard owns the FULL profile
  // budget (maxNodes / maxEvaluations / maxStates / maxTimeMs). The search
  // budget is therefore per-shard, not global, and a 4-worker Balanced batch
  // can spend up to 4x the single-thread effort. `shards` exposes the
  // per-shard truth so this is measurable instead of implied.
  const metadata = (running, result = null) => {
    const aggregateNodes = searches.reduce((sum, search) => sum + (search?.nodes || 0), 0);
    return {
      schemaVersion: 1, operation: 'solveInventory',
      generation: batch, profile: payload.searchProfile || 'balanced', running,
      elapsedMs: performance.now() - started,
      // Kept as an alias: the command bar reads `nodes`.
      nodes: aggregateNodes,
      aggregateNodes,
      firstExactMs, firstFeasibleMs,
      termination: running ? null : searches.some(search => search?.termination === 'budget') ? 'budget' : 'completed',
      parallelism,
      workerCount: parallelism,
      budgetScope: 'per-shard',
      shards: searches.map((search, index) => ({
        index,
        running: search?.running === true,
        // Session termination is "budget" whenever *any* budget was reached,
        // including during the post-frontier refinement pass. The frontier's own
        // reason (`exact-witness-quota`, `time-limit`, `exhausted`, …) is what
        // tells a reader whether the search stopped early or ran out of room.
        termination: search?.termination ?? null,
        frontierTermination: search?.frontierTermination ?? null,
        frontierComplete: search?.frontierComplete ?? null,
        nodes: search?.nodes || 0,
        statesExamined: search?.coverage?.statesExamined ?? null,
      })),
      coverage: {...result?.searchStats, complete: false},
    };
  };
  const publishMerge = () => {
    if (!active()) return;
    lastMergeAt = performance.now();
    const revision = ++progressRevision;
    // Reconstruct positive witnesses against the full inventory. Local
    // coverage/negative certificates never become a global proof.
    void engine().then(({mergeInventoryShardResults}) => {
      if (!active() || revision !== progressRevision) return;
      const merged = mergeInventoryShardResults(request, partials, parallelism);
      if (!merged.results.length) return;
      const status = merged.certificate.status;
      if (status === 'EXACT_TARGET_PROVEN') firstExactMs ??= performance.now() - started;
      if (status === 'EXACT_TARGET_PROVEN' || status === 'RULE_FEASIBLE_PROVEN') firstFeasibleMs ??= performance.now() - started;
      merged.search = metadata(true, merged);
      options.onProgress(merged, merged.search);
    }).catch(() => { if (active()) controller.abort(); });
  };
  let scheduledMerge = null;
  let lastMergeAt = 0;
  const scheduleMerge = () => {
    if (!active() || scheduledMerge !== null) return;
    const elapsed = performance.now() - lastMergeAt;
    if (lastMergeAt === 0 || elapsed >= PROGRESS_MERGE_INTERVAL_MS) { publishMerge(); return; }
    scheduledMerge = setTimeout(() => {
      scheduledMerge = null;
      publishMerge();
    }, PROGRESS_MERGE_INTERVAL_MS - elapsed);
  };
  const progress = (result, search, shardIndex) => {
    if (!active()) return;
    const budgetBound = search?.termination === 'budget';
    searches[shardIndex] = {
      ...search,
      nodes: Math.max(search?.nodes || 0, searches[shardIndex]?.nodes || 0),
      // A budget-truncated shard reports a *published snapshot*, whose frontier
      // termination predates the stop and would read as "exhausted" even though
      // the frontier never finished. Report "not resolved" instead of a stale
      // reason; the session's own `termination` already says "budget".
      frontierTermination: budgetBound
        ? null
        : result?.searchStats?.termination ?? searches[shardIndex]?.frontierTermination ?? null,
      frontierComplete: result?.searchStats?.frontierComplete ?? null,
    };
    if (!result?.results?.length) { options.onProgress?.(null, metadata(true)); return; }
    partials[shardIndex] = result;
    if (!options.onProgress) return;
    scheduleMerge();
  };
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, {once: true});
  if (options.signal?.aborted) abort();
  try {
    const parts = await Promise.all(Array.from({length: parallelism}, (_, shardIndex) =>
      run("solveInventory", {...request, shardIndex, shardCount: parallelism}, {
        signal: controller.signal,
        onProgress: (result, search) => progress(result, search, shardIndex),
      }, `solveInventory:${batch}:${shardIndex}`).then(result => {
        progress(result, result?.search, shardIndex);
        return result;
      })));
    if (controller.signal.aborted) { const error = new Error("Cancelled inventory batch"); error.name = "AbortError"; throw error; }
    const {mergeInventoryShardResults} = await engine();
    if (controller.signal.aborted) { const error = new Error("Cancelled inventory batch"); error.name = "AbortError"; throw error; }
    const result = mergeInventoryShardResults(request, parts, parallelism);
    result.search = metadata(false, result);
    return result;
  } finally {
    if (scheduledMerge !== null) {
      clearTimeout(scheduledMerge);
      scheduledMerge = null;
    }
    if (inventoryBatch === controller) inventoryBatch = null;
    controller.abort();
    options.signal?.removeEventListener("abort", abort);
  }
}
