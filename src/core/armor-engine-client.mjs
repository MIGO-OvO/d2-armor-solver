import {createSearchSession, withSearchProfile, SearchBudgetExceeded} from "./search-session.mjs";
import {chooseInventorySchedule} from './worker-scheduler.mjs';
const workers = new Map();
const generations = new Map();
const pendingRequests = new Map();
let nextRequestId = 1;
let inventoryBatch = null;
let observedStartupMs = 100;
let observedMergeMs = 10;
const transportError = cause => Object.assign(new Error(cause?.message || 'Armor worker transport failed', {cause}),
  {name: 'WorkerTransportError', solverFailure: 'transport'});
function markMergeError(error) {
  if (error && typeof error === 'object' && Object.isExtensible(error)) error.solverFailure = 'merge';
  return error;
}
const abortError = () => Object.assign(new Error('Cancelled armor search'), {name: 'AbortError'});
const OFFLINE_MODE = typeof __OFFLINE_MODE__ !== "undefined" && __OFFLINE_MODE__ === "true";
const canRunInline = () => typeof document === 'undefined';
const workerUnavailable = () => Object.assign(new Error('Background computation is unavailable. Enable Web Workers or reopen the app; no search was run on the UI thread.'),
  {name: 'WorkerUnavailableError', solverFailure: 'transport'});
const auxiliaryOperations = new Set(['rankInventoryPlans', 'mergeInventoryShardResults']);

function createWorker(operation, workerKey = operation) {
  const existing = workers.get(workerKey);
  if (existing || typeof Worker === "undefined") return existing || null;
  let worker;
  let blobUrl = null;
  try {
    const source = globalThis.__ARMOR_OFFLINE_WORKER_SOURCE__;
    if (typeof source === 'string' && source.length) {
      blobUrl = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
      worker = new Worker(blobUrl, {name: `armor-engine-${operation}`});
    } else {
      if (OFFLINE_MODE) return null;
      worker = new Worker(new URL("../workers/armor-engine.worker.mjs", import.meta.url), {type: "module", name: `armor-engine-${operation}`});
    }
  } catch { return null; }
  finally { if (blobUrl) URL.revokeObjectURL(blobUrl); }
  workers.set(workerKey, worker);
  worker.addEventListener("message", ({data}) => {
    const pending = pendingRequests.get(data?.id);
    if (!pending || data.generation !== pending.generation) return;
    pending.started?.();
    if (data.type === 'started') return;
    if (data.type === "progress") {
      try { pending.onProgress?.(data.result, data.search); }
      catch (error) {
        pendingRequests.delete(data.id); pending.cleanup?.(); pending.reject(error);
        worker.terminate(); workers.delete(workerKey);
      }
      return;
    }
    pendingRequests.delete(data.id);
    pending.cleanup?.();
    if (data.error) {
      const error = new Error(data.error.message);
      error.name = data.error.name;
      error.solverFailure = 'solver';
      if (data.error.stack) error.stack = data.error.stack;
      pending.reject(error);
    } else pending.resolve(data.result);
  });
  const failed = event => {
    if (workers.get(workerKey) !== worker) return;
    for (const [id, pending] of pendingRequests) if (pending.workerKey === workerKey) {
      pendingRequests.delete(id); pending.cleanup?.();
      pending.reject(transportError(event.error || new Error(event.message || "Armor worker failed")));
    }
    worker.terminate(); workers.delete(workerKey);
  };
  worker.addEventListener('error', failed);
  worker.addEventListener('messageerror', failed);
  return worker;
}

export function cancelOperation(operation, {dispose = false} = {}) {
  if (operation === 'solveInventory' && inventoryBatch) {
    const batch = inventoryBatch;
    inventoryBatch = null;
    batch.abort();
  }
  const busyKeys = new Set([...pendingRequests.values()].filter(pending => pending.operation === operation).map(pending => pending.workerKey));
  for (const [key, worker] of workers) if ((key === operation || key.startsWith(`${operation}:`)) && (dispose || busyKeys.has(key))) {
    worker.terminate(); workers.delete(key);
  }
  generations.set(operation, (generations.get(operation) || 0) + 1);
  for (const [id, pending] of pendingRequests) if (pending.operation === operation) {
    pendingRequests.delete(id); pending.cleanup?.();
    const error = new Error(`Cancelled ${operation} request`); error.name = "AbortError";
    pending.reject(error);
  }
}

export function cancelAllSearches(options) {
  for (const operation of ["solve", "suggest", "solveInventory", "analyzeUpgrade", "calculateReachability", "rankInventoryPlans", "mergeInventoryShardResults"]) cancelOperation(operation, options);
}

function run(operation, input, {onProgress = null, signal = null, forceInline = false, retainWorker = false,
  onStartup = null, onClone = null, poolOwned = false, beforeInline = null} = {}, workerKey = operation) {
  if (signal?.aborted) return Promise.reject(abortError());
  // Only batch-owned workers run concurrently. Ordinary operations supersede
  // pending work instead of queueing behind a synchronous solver invocation.
  if (workerKey === operation && ([...pendingRequests.values()].some(pending => pending.operation === operation)
      || operation === 'solveInventory' && inventoryBatch)) cancelOperation(operation);
  const generation = (generations.get(operation) || 0) + 1;
  generations.set(operation, generation);
  const id = nextRequestId++;
  const cloneStarted = performance.now();
  const activeWorker = forceInline ? null : poolOwned ? workers.get(workerKey) : createWorker(operation, workerKey);
  // postMessage already snapshots synchronously. Do not first clone the full
  // vault (and every witness) a second time on the UI thread.
  const payload = withSearchProfile(operation, activeWorker ? input : structuredClone(input));
  if (poolOwned && !forceInline && !activeWorker) return Promise.reject(transportError(new Error('Pool worker unavailable')));
  if (!activeWorker && !canRunInline()) return Promise.reject(workerUnavailable());
  return new Promise((resolve, reject) => {
    let startupTimer = null;
    const startupAt = performance.now();
    let acknowledged = false;
    const abort = () => {
      const current = pendingRequests.get(id);
      if (!current) return;
      if (workerKey === operation) { cancelOperation(operation); return; }
      pendingRequests.delete(id); current.cleanup?.();
      activeWorker?.terminate(); workers.delete(workerKey);
      const error = new Error(`Cancelled ${operation} request`); error.name = "AbortError";
      current.reject(error);
    };
    const pending = {operation, workerKey, generation, resolve, reject, onProgress,
      started: () => {
        if (acknowledged) return;
        acknowledged = true; clearTimeout(startupTimer);
        const ms = performance.now() - startupAt;
        observedStartupMs = observedStartupMs * 0.75 + ms * 0.25;
        onStartup?.(ms);
      },
      cleanup: () => {
        clearTimeout(startupTimer);
        signal?.removeEventListener("abort", abort);
        if (workerKey !== operation && !retainWorker) { activeWorker?.terminate(); workers.delete(workerKey); }
      }};
    pendingRequests.set(id, pending);
    signal?.addEventListener("abort", abort, {once: true});
    if (signal?.aborted) { abort(); return; }
    if (activeWorker) {
      // Startup deadline only. Never time out an acknowledged exact query.
      startupTimer = setTimeout(() => {
        if (!pendingRequests.has(id)) return;
        pendingRequests.delete(id); pending.cleanup();
        activeWorker.terminate(); workers.delete(workerKey);
        reject(transportError(new Error('Worker startup acknowledgement timed out')));
      }, 10000);
      try {
        activeWorker.postMessage({type: "start", id, generation, operation, payload});
        onClone?.(performance.now() - cloneStarted);
      }
      catch (error) {
        pendingRequests.delete(id); pending.cleanup(); activeWorker.terminate(); workers.delete(workerKey);
        reject(transportError(error));
      }
      return;
    }
    onClone?.(performance.now() - cloneStarted);
    // Inline fallback uses the same generation/progress contract. It cannot
    // pre-empt JavaScript inside one synchronous checkpoint-free primitive.
    import("./armor-engine.mjs").then(engine => {
      // Let already completed theory results reach the UI before starting an
      // inline inventory fallback. The hook never delays worker execution.
      return Promise.resolve().then(() => beforeInline?.()).then(() => new Promise(resolve => setTimeout(resolve, 0))).then(() => {
        if (!pendingRequests.has(id)) return;
        const session = createSearchSession({operation, generation, profile: payload.searchProfile,
          onProgress: event => { if (pendingRequests.has(id)) onProgress?.(event.result, event.search); }});
        const execute = {solve: engine.solveLoadout, suggest: engine.solveLoadout, solveInventory: engine.solveInventory,
          analyzeUpgrade: engine.analyzeUpgrade, calculateReachability: engine.calculateReachability,
          rankInventoryPlans: engine.rankOwnedArmorPlans, mergeInventoryShardResults: engine.mergeInventoryRequest}[operation];
        if (auxiliaryOperations.has(operation)) {
          const result = execute(payload);
          if (pendingRequests.has(id)) { pendingRequests.delete(id); pending.cleanup(); resolve(result); }
          return;
        }
        let computed;
        try { computed = execute(payload, session); }
        catch (error) {
          if (!(error instanceof SearchBudgetExceeded)) throw error;
          computed = session.lastResult || engine.createSearchLimitResult(operation === 'suggest' ? 'solve' : operation, payload);
        }
        const result = session.finish(computed);
        if (pendingRequests.has(id)) { pendingRequests.delete(id); pending.cleanup(); resolve(result); }
      });
    }).catch(error => {
      if (pendingRequests.has(id)) { pendingRequests.delete(id); pending.cleanup(); reject(error); }
    });
  });
}

// Retry transport only, once in a fresh worker before the last-resort inline
// path. A superseded generation or user cancellation must never restart work.
async function runWithTransportFallback(operation, payload, options = {}) {
  let failures = 0;
  for (;;) {
    const pending = run(operation, payload, {...options, forceInline: options.forceInline || failures >= 2});
    const generation = generations.get(operation);
    try {
      const result = await pending;
      if (failures && result) result.search = {...result.search, transportFailures: failures,
        fallback: failures >= 2 ? 'inline' : 'replacement-worker'};
      return result;
    } catch (error) {
      if (options.signal?.aborted || generations.get(operation) !== generation) throw abortError();
      if (error.solverFailure !== 'transport' || failures >= 2 || options.forceInline) throw error;
      failures++;
    }
  }
}
export const solveLoadoutAsync = (payload, options) => runWithTransportFallback("solve", payload, options);
export const suggestLoadoutAsync = (payload, options) => runWithTransportFallback("suggest", {...payload, searchProfile: 'fast'}, options);
export const analyzeUpgradeAsync = (payload, options) => run("analyzeUpgrade", payload, options);
export const calculateReachabilityAsync = (payload, options) => run("calculateReachability", payload, options);
export const solveInventoryAsync = (payload, options) => runWithTransportFallback('solveInventory', payload, options);
export const rankInventoryPlansAsync = (payload, options) => runWithTransportFallback('rankInventoryPlans', payload, options);
export const mergeInventoryResultsAsync = (payload, options) => runWithTransportFallback('mergeInventoryShardResults', payload, options);

// A merge re-verifies every retained witness against the whole vault, which
// costs hundreds of milliseconds on a 1300-piece inventory. Publishing on every
// shard callback therefore costs O(events x vault) on the main thread and made
// a 3 s Balanced search take ~27 s of wall clock. Progressive publication is
// coalesced to one merge per interval (the first one is immediate, so a positive
// witness still reaches the UI without waiting for the batch to finish).
const PROGRESS_MERGE_INTERVAL_MS = 1000;

// A batch owns separate workers; normal operation workers remain reusable.
export async function solveInventoryParallelAsync(payload, {parallelism, shardCount, ...options} = {}) {
  if (options.signal?.aborted) throw abortError();
  const schedule = chooseInventorySchedule(payload, {parallelism, shardCount, observedStartupMs, observedMergeMs,
    workersAvailable: typeof Worker !== 'undefined' && (!OFFLINE_MODE || Boolean(globalThis.__ARMOR_OFFLINE_WORKER_SOURCE__))});
  // The search profile owns effort. Forcing `exhaustive: true` here silently
  // removed Fast/Balanced early termination (their `exact-witness-quota` stop),
  // so every browser solve paid Deep's cost. The wrapper only forwards the
  // shard coordinates; `withSearchProfile` still honours an explicit
  // `searchLimits.exhaustive === true` from the caller.
  const request = structuredClone({...payload, shardIndex: 0, shardCount: 1});
  if (!schedule.workerCount) {
    const result = await solveInventoryAsync(request, options);
    if (!result) return result;
    result.search = {...result.search, scheduling: schedule, requestedWorkers: schedule.requestedWorkers,
      successfullyCreatedWorkers: 0, effectiveWorkers: 0, shardCount: 1, fallback: 'inline'};
    return result;
  }
  cancelOperation('solveInventory');
  const batch = nextRequestId++;
  const controller = new AbortController();
  inventoryBatch = controller;
  const started = performance.now();
  const keys = [];
  for (let i = 0; i < schedule.workerCount; i++) {
    const key = `solveInventory:${batch}:${i}`;
    if (!createWorker('solveInventory', key)) break;
    keys.push(key);
  }
  const successfullyCreatedWorkers = keys.length;
  let effectiveWorkers = keys.length;
  const count = schedule.shardCount;
  const partials = Array(count).fill(null);
  const searches = Array(count).fill(null);
  const queue = Array.from({length: count}, (_, i) => i);
  const startupTimes = [];
  let failures = 0, failedAttemptNodes = 0, progressiveMergeMs = 0, finalMergeMs = 0, cloneMs = 0;
  let fallback = null;
  let firstExactMs = null;
  let firstFeasibleMs = null;
  let progressRevision = 0;
  let mergeError = null;
  let finalizingMerge = false;
  let progressiveTask = Promise.resolve();
  const positiveWitnesses = new Set();
  const merge = (parts) => mergeInventoryResultsAsync({request, parts, count}, {signal: controller.signal});
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
      aggregateExactStates: searches.reduce((sum, s) => sum + (s?.coverage?.exactStates || 0), 0),
      aggregateMathEvaluations: searches.reduce((sum, s) => sum + (s?.coverage?.mathEvaluations || 0), 0),
      firstExactMs, firstFeasibleMs,
      termination: running ? null : searches.some(search => search?.termination === 'budget') ? 'budget' : 'completed',
      parallelism: successfullyCreatedWorkers,
      workerCount: effectiveWorkers,
      requestedWorkers: schedule.requestedWorkers, successfullyCreatedWorkers, effectiveWorkers,
      creationShortfall: schedule.workerCount - successfullyCreatedWorkers,
      shardCount: count, scheduling: schedule, startupTimes, failures, failedAttemptNodes, fallback,
      progressiveMergeMs, finalMergeMs, cloneMs,
      mergeIncludesWitnessVerification: true,
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
        exactStates: search?.coverage?.exactStates ?? 0,
        mathEvaluations: search?.coverage?.mathEvaluations ?? 0,
        mathCacheHits: search?.coverage?.mathCacheHits ?? 0,
        exactPrunedResidues: search?.coverage?.exactPrunedResidues ?? 0,
      })),
      coverage: {...result?.searchStats, complete: count === 1 && result?.certificate?.proof?.complete === true},
    };
  };
  const publishMerge = () => {
    if (!active()) return;
    lastMergeAt = performance.now();
    const revision = ++progressRevision;
    if (count === 1) {
      // Preserve the existing single-worker result/proof boundary; there is
      // no cross-shard evidence to merge or whole-vault clone to verify again.
      const result = partials[0];
      if (!result?.results?.length) return;
      if (result.status === 'EXACT_TARGET_PROVEN') firstExactMs ??= performance.now() - started;
      if (['EXACT_TARGET_PROVEN', 'RULE_FEASIBLE_PROVEN'].includes(result.status)) firstFeasibleMs ??= performance.now() - started;
      try { options.onProgress({...result, search: metadata(true, result)}, metadata(true, result)); }
      catch (error) { mergeError = markMergeError(error); controller.abort(); }
      return;
    }
    // Reconstruct positive witnesses against the full inventory. Local
    // coverage/negative certificates never become a global proof.
    progressiveTask = progressiveTask.then(async () => {
      if (!active() || revision !== progressRevision) return;
      const before = performance.now();
      const merged = await merge(partials);
      progressiveMergeMs += performance.now() - before;
      if (!active() || revision !== progressRevision) return;
      if (!merged.results.length) return;
      const status = merged.certificate.status;
      if (status === 'EXACT_TARGET_PROVEN') firstExactMs ??= performance.now() - started;
      if (status === 'EXACT_TARGET_PROVEN' || status === 'RULE_FEASIBLE_PROVEN') firstFeasibleMs ??= performance.now() - started;
      merged.search = metadata(true, merged);
      options.onProgress(merged, merged.search);
    }).catch(error => {
      if (active()) { mergeError = markMergeError(error); controller.abort(); }
    });
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
      coverage: {...search?.coverage, ...(!budgetBound ? result?.searchStats : {})},
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
    if (count > 1) {
      // Serialized positives are only an admission signal, never trusted
      // evidence: publishMerge still verifies them against the whole vault.
      const fresh = result.results.filter(row => row.certificate?.witnessVerification?.valid
        && ['EXACT_TARGET_PROVEN', 'RULE_FEASIBLE_PROVEN'].includes(row.certificate.status)
        && !positiveWitnesses.has(row.canonicalId));
      if (!fresh.length) return;
      for (const row of fresh) positiveWitnesses.add(row.canonicalId);
    }
    scheduleMerge();
  };
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, {once: true});
  if (options.signal?.aborted) abort();
  try {
    const parts = Array(count).fill(null);
    const consume = async (key, forceInline = false) => {
      while (queue.length && active()) {
        const shardIndex = queue.shift();
        try {
          const result = await run('solveInventory', {...request, shardIndex, shardCount: count}, {
            signal: controller.signal, retainWorker: !forceInline, forceInline, poolOwned: true,
            beforeInline: options.beforeInline,
            onStartup: ms => startupTimes.push(ms),
            onClone: ms => { cloneMs += ms; },
            onProgress: (result, search) => progress(result, search, shardIndex),
          }, key);
          parts[shardIndex] = result;
          progress(result, result?.search, shardIndex);
        } catch (error) {
          if (forceInline || error.name === 'WorkerUnavailableError' || error.solverFailure !== 'transport' || !active()) throw error;
          failures++; effectiveWorkers--;
          failedAttemptNodes += searches[shardIndex]?.nodes || 0;
          searches[shardIndex] = null; partials[shardIndex] = null;
          queue.push(shardIndex); // replay only the failed physical shard
          return;
        }
      }
    };
    await Promise.all(keys.map(key => consume(key)));
    while (queue.length && active() && keys.some(key => workers.has(key))) {
      await Promise.all(keys.filter(key => workers.has(key)).map(key => consume(key)));
    }
    // The failed pool has been released; retry on at most ONE replacement worker.
    // Transient resource pressure should not immediately move an unbounded
    // exact-existence query onto the UI thread. Never retry solver exceptions.
    if (queue.length && active() && successfullyCreatedWorkers) {
      const key = `solveInventory:${batch}:recovery`;
      if (createWorker('solveInventory', key)) {
        keys.push(key); effectiveWorkers = 1; fallback = 'replacement-worker';
        await consume(key);
      }
    }
    // Workers unavailable even after recovery: preserve the original disjoint
    // partition in one sequential inline consumer, with unchanged proof scope.
    if (queue.length && active()) {
      fallback = 'inline';
      await consume(`solveInventory:${batch}:inline`, true);
    }
    // Drain publication before returning: a same-turn final worker response
    // must not outrun the rejection handler of an in-flight progressive merge.
    await progressiveTask;
    if (controller.signal.aborted) { const error = new Error("Cancelled inventory batch"); error.name = "AbortError"; throw error; }
    if (queue.length || parts.some(part => !part)) throw transportError(new Error('Inventory workers did not complete every shard'));
    finalizingMerge = count > 1;
    if (controller.signal.aborted) { const error = new Error("Cancelled inventory batch"); error.name = "AbortError"; throw error; }
    ++progressRevision;
    const before = performance.now();
    const result = count === 1 ? parts[0] : await merge(parts);
    if (!active()) throw abortError();
    if (!result) return result;
    finalMergeMs = count === 1 ? 0 : performance.now() - before;
    if (count > 1) observedMergeMs = observedMergeMs * 0.75 + finalMergeMs * 0.25;
    if (result.status === 'EXACT_TARGET_PROVEN') firstExactMs ??= performance.now() - started;
    if (['EXACT_TARGET_PROVEN', 'RULE_FEASIBLE_PROVEN'].includes(result.status)) firstFeasibleMs ??= performance.now() - started;
    result.search = metadata(false, result);
    return result;
  } catch (error) {
    // Internal merge failure aborts siblings for cleanup, but is not a user
    // cancellation. Preserve the original exception (including its stack).
    throw mergeError || (finalizingMerge && error.name !== 'AbortError' ? markMergeError(error) : error);
  } finally {
    if (scheduledMerge !== null) {
      clearTimeout(scheduledMerge);
      scheduledMerge = null;
    }
    const ownsBatch = inventoryBatch === controller;
    if (ownsBatch) inventoryBatch = null;
    controller.abort();
    // Batch-scoped verification workers never retain the full vault after exit.
    if (ownsBatch) cancelOperation('mergeInventoryShardResults', {dispose: true});
    for (const key of keys) { workers.get(key)?.terminate(); workers.delete(key); }
    options.signal?.removeEventListener("abort", abort);
  }
}
