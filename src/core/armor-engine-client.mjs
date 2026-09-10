import {createSearchSession, withSearchProfile, SearchBudgetExceeded} from "./search-session.mjs";
const workers = new Map();
const generations = new Map();
const pendingRequests = new Map();
let nextRequestId = 1;
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
  // Requests of the same operation may run concurrently (parallel inventory
  // shards).  Do not cancel an existing request; each request gets its own
  // monotonically increasing generation token and is matched by id below.
  const generation = (generations.get(operation) || 0) + 1;
  generations.set(operation, generation);
  const id = nextRequestId++;
  const payload = withSearchProfile(operation, structuredClone(input));
  const activeWorker = createWorker(operation, workerKey);
  return new Promise((resolve, reject) => {
    const abort = () => {
      const current = pendingRequests.get(id);
      if (!current) return;
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

// A batch owns separate workers; normal operation workers remain reusable.
export async function solveInventoryParallelAsync(payload, {parallelism = 2, ...options} = {}) {
  if (!Number.isSafeInteger(parallelism) || parallelism < 1 || parallelism > 8) {
    throw new RangeError("parallelism must be an integer between 1 and 8");
  }
  const request = structuredClone({...payload, shardIndex: 0, shardCount: 1,
    searchLimits: {...payload.searchLimits, exhaustive: true}});
  if (parallelism === 1 || OFFLINE_MODE || typeof Worker === "undefined") return solveInventoryAsync(request, options);
  const batch = nextRequestId++;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, {once: true});
  if (options.signal?.aborted) abort();
  try {
    const parts = await Promise.all(Array.from({length: parallelism}, (_, shardIndex) =>
      run("solveInventory", {...request, shardIndex, shardCount: parallelism}, {
        signal: controller.signal,
        // Local negative results are not global progress certificates.
        onProgress: (_result, search) => options.onProgress?.(null, {...search, shardIndex, shardCount: parallelism}),
      }, `solveInventory:${batch}:${shardIndex}`)));
    if (controller.signal.aborted) { const error = new Error("Cancelled inventory batch"); error.name = "AbortError"; throw error; }
    const {mergeInventoryShardResults} = await import("./armor-engine.mjs");
    if (controller.signal.aborted) { const error = new Error("Cancelled inventory batch"); error.name = "AbortError"; throw error; }
    return mergeInventoryShardResults(request, parts, parallelism);
  } finally {
    controller.abort();
    options.signal?.removeEventListener("abort", abort);
  }
}
