const workers = new Map();
let nextRequestId = 1;
const pendingRequests = new Map();

// Injected by the offline build (build-offline.mjs) as "true"; the regular
// web build does not define it, so typeof guards keep this false there.
const OFFLINE_MODE = typeof __OFFLINE_MODE__ !== "undefined" && __OFFLINE_MODE__ === "true";

function createWorker(operation) {
  const existing = workers.get(operation);
  if (existing || OFFLINE_MODE || typeof Worker === "undefined") return existing || null;
  let worker;
  try {
    worker = new Worker(
      new URL("../workers/armor-engine.worker.mjs", import.meta.url),
      { type: "module", name: `armor-engine-${operation}` },
    );
  } catch {
    return null; // file:// or restricted context: fall back to main-thread engine
  }
  workers.set(operation, worker);
  worker.addEventListener("message", ({ data }) => {
    const pending = pendingRequests.get(data?.id);
    if (!pending) return;
    pendingRequests.delete(data.id);
    if (data.error) {
      const error = new Error(data.error.message);
      error.name = data.error.name;
      error.stack = data.error.stack || error.stack;
      pending.reject(error);
      return;
    }
    pending.resolve(data.result);
  });
  worker.addEventListener("error", (event) => {
    const error = event.error || new Error(event.message || "Armor worker failed");
    for (const [id, pending] of pendingRequests) {
      if (pending.operation !== operation) continue;
      pending.reject(error);
      pendingRequests.delete(id);
    }
    worker.terminate();
    workers.delete(operation);
  });
  return worker;
}

function cancelOperation(operation) {
  const worker = workers.get(operation);
  if (worker) {
    worker.terminate();
    workers.delete(operation);
  }
  for (const [id, pending] of pendingRequests) {
    if (pending.operation !== operation) continue;
    const error = new Error(`Superseded ${operation} request`);
    error.name = "AbortError";
    pending.reject(error);
    pendingRequests.delete(id);
  }
}

function run(operation, payload) {
  if (operation === "calculateReachability" &&
      [...pendingRequests.values()].some(pending => pending.operation === operation)) {
    cancelOperation(operation);
  }
  const activeWorker = createWorker(operation);
  if (!activeWorker) {
    return import("./armor-engine.mjs").then(engine => {
      const localOperations = {
        solve: engine.solveLoadout,
        analyzeUpgrade: engine.analyzeUpgrade,
        calculateReachability: engine.calculateReachability,
        solveInventory: engine.solveInventory,
      };
      return localOperations[operation](payload);
    });
  }

  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject, operation });
    activeWorker.postMessage({ id, operation, payload });
  });
}

export function solveLoadoutAsync(payload) {
  return run("solve", payload);
}

export function analyzeUpgradeAsync(payload) {
  return run("analyzeUpgrade", payload);
}

export function calculateReachabilityAsync(payload) {
  return run("calculateReachability", payload);
}

export function solveInventoryAsync(payload) {
  return run("solveInventory", payload);
}
