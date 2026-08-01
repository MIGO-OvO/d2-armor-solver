import {
  analyzeUpgrade,
  calculateReachability,
  solveLoadout,
} from "../core/armor-engine.mjs";

const operations = Object.freeze({
  solve: solveLoadout,
  analyzeUpgrade,
  calculateReachability,
});

self.addEventListener("message", ({ data }) => {
  const { id, operation, payload } = data || {};
  const execute = operations[operation];
  if (!execute) {
    self.postMessage({
      id,
      error: {
        name: "UnknownOperationError",
        message: "Unknown armor engine operation: " + operation,
      },
    });
    return;
  }

  try {
    self.postMessage({ id, result: execute(payload) });
  } catch (error) {
    self.postMessage({
      id,
      error: {
        name: error?.name || "Error",
        message: error?.message || String(error),
        stack: error?.stack || "",
      },
    });
  }
});
