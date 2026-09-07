import {createSearchSession, withSearchProfile, SearchBudgetExceeded} from "./search-session.mjs";
const workers = new Map();
const generations = new Map();
const pendingRequests = new Map();
let nextRequestId = 1;
const OFFLINE_MODE = typeof __OFFLINE_MODE__ !== "undefined" && __OFFLINE_MODE__ === "true";

function createWorker(operation) {
  const existing = workers.get(operation);
  if (existing || OFFLINE_MODE || typeof Worker === "undefined") return existing || null;
  let worker;
  try {
    worker = new Worker(new URL("../workers/armor-engine.worker.mjs", import.meta.url), {type: "module", name: `armor-engine-${operation}`});
  } catch { return null; }
  workers.set(operation, worker);
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
    for (const [id, pending] of pendingRequests) if (pending.operation === operation) {
      pendingRequests.delete(id); pending.cleanup?.();
      pending.reject(event.error || new Error(event.message || "Armor worker failed"));
    }
    worker.terminate(); workers.delete(operation);
  });
  return worker;
}

export function cancelOperation(operation) {
  const worker = workers.get(operation);
  worker?.terminate(); workers.delete(operation);
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

function run(operation, input, {onProgress = null, signal = null} = {}) {
  if ([...pendingRequests.values()].some(pending => pending.operation === operation)) cancelOperation(operation);
  else generations.set(operation, (generations.get(operation) || 0) + 1);
  const generation = generations.get(operation);
  const id = nextRequestId++;
  const payload = withSearchProfile(operation, structuredClone(input));
  const activeWorker = createWorker(operation);
  return new Promise((resolve, reject) => {
    const abort = () => {
      if (generations.get(operation) === generation) cancelOperation(operation);
    };
    const pending = {operation, generation, resolve, reject, onProgress,
      cleanup: () => signal?.removeEventListener("abort", abort)};
    pendingRequests.set(id, pending);
    signal?.addEventListener("abort", abort, {once: true});
    if (signal?.aborted) { abort(); return; }
    if (activeWorker) { activeWorker.postMessage({type: "start", id, generation, operation, payload}); return; }
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
