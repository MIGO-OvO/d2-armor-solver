let worker = null;
let nextRequestId = 1;
const pendingRequests = new Map();

function createWorker() {
  if (worker || typeof Worker === "undefined") return worker;
  worker = new Worker(
    new URL("../workers/armor-engine.worker.mjs", import.meta.url),
    { type: "module", name: "armor-engine" },
  );
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
    for (const pending of pendingRequests.values()) pending.reject(error);
    pendingRequests.clear();
    worker?.terminate();
    worker = null;
  });
  return worker;
}

function run(operation, payload) {
  const activeWorker = createWorker();
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
    pendingRequests.set(id, { resolve, reject });
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
