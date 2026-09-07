import {
  analyzeUpgrade,
  calculateReachability,
  solveInventory,
  solveLoadout,
  createSearchLimitResult,
} from "../core/armor-engine.mjs";
import {createSearchSession, withSearchProfile, SearchBudgetExceeded} from "../core/search-session.mjs";

const operations = Object.freeze({
  solve: solveLoadout,
  analyzeUpgrade,
  calculateReachability,
  solveInventory,
});

self.addEventListener("message", ({ data }) => {
  const { id, operation, payload, generation = 0 } = data || {};
  const execute = operations[operation];
  if (!execute) {
    self.postMessage({
      id, generation, type: "error",
      error: {
        name: "UnknownOperationError",
        message: "Unknown armor engine operation: " + operation,
      },
    });
    return;
  }

  try {
    // Legacy direct Worker probes retain their unrestricted payload; all UI
    // requests use the versioned start/progress/result envelope.
    if (data.type !== "start") { self.postMessage({id, generation, result: execute(payload)}); return; }
    const request = withSearchProfile(operation, payload);
    const session = createSearchSession({operation, generation, profile: request.searchProfile,
      onProgress: event => self.postMessage({id, generation, type: "progress", ...event})});
    let result;
    try { result = execute(request, session); }
    catch (error) {
      if (!(error instanceof SearchBudgetExceeded)) throw error;
      result = session.lastResult || createSearchLimitResult(operation, request);
    }
    self.postMessage({id, generation, type: "result", result: session.finish(result)});
  } catch (error) {
    self.postMessage({
      id, generation, type: "error",
      error: {
        name: error?.name || "Error",
        message: error?.message || String(error),
        stack: error?.stack || "",
      },
    });
  }
});
