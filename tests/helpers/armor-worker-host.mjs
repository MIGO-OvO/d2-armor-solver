import {parentPort} from "node:worker_threads";
if (parentPort) {
  globalThis.self = {
    addEventListener: (_name, callback) => parentPort.on("message", data => callback({data})),
    postMessage: data => parentPort.postMessage(data),
  };
  await import("../../src/workers/armor-engine.worker.mjs");
}
