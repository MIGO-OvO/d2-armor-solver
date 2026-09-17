import {spawnSync} from 'node:child_process';
import {Worker} from 'node:worker_threads';
import {availableParallelism, totalmem} from 'node:os';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {cases, fixture} from './fixtures/search-performance.mjs';

const [mode = 'pressure', label = 'baseline', selectedCase, workersArg] = process.argv.slice(2);
const cores = availableParallelism();
const pressure = mode.startsWith('pressure');
if (!selectedCase) {
  const points = pressure ? [1] : [...new Set([...(process.env.BENCH_AUTO ? [0] : []), 1, ...Array.from({length: Math.floor((cores - 2) / 2)}, (_, i) => (i + 1) * 2)])];
  const rows = [];
  for (let trial = 0; trial < Number(process.env.BENCH_TRIALS || 3); trial++) {
    for (const name of process.env.BENCH_CASES?.split(',') || (pressure ? cases : ['small', 'large', 'duplicates'])) for (const workers of points) {
      for (const ordering of mode === 'pressure-paired' ? (trial % 2 ? ['pressure', 'baseline'] : ['baseline', 'pressure']) : [process.env.BENCH_ORDER || 'pressure']) {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), mode, label, name, String(workers)],
        {encoding: 'utf8', windowsHide: true, timeout: 60000, env: {...process.env, BENCH_ORDER: ordering}});
      let row;
      try { row = JSON.parse(child.stdout); } catch { row = {name, workers, failed: child.error?.message || child.stderr}; }
      rows.push({trial, ordering, ...row}); console.log(JSON.stringify(rows.at(-1)));
      }
    }
  }
  writeFileSync(new URL(`../docs/benchmarks/search-${mode}-${label}.json`, import.meta.url), JSON.stringify({
    label, node: process.version, hardwareConcurrency: cores, memoryGiB: totalmem() / 2 ** 30, rows}, null, 2) + '\n');
} else {
  const payload = {...fixture(selectedCase), searchProfile: process.env.BENCH_PROFILE || 'fast',
    searchOrdering: process.env.BENCH_ORDER || 'pressure',
    searchLimits: {maxTimeMs: 200, maxNodes: 100000, maxStates: 10000, maxEvaluations: 3000}};
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  let lag = 0, tick = performance.now();
  const timer = setInterval(() => { const now = performance.now(); lag = Math.max(lag, now - tick - 10); tick = now; }, 10);
  const started = performance.now();
  let result;
  if (pressure) {
    const {solveInventory} = await import('../src/core/armor-engine.mjs');
    result = solveInventory(payload);
  } else {
    globalThis.Worker = class {
      constructor() { this.worker = new Worker(new URL('../tests/helpers/armor-worker-host.mjs', import.meta.url)); }
      addEventListener(name, cb) { this.worker.on(name, data => cb(name === 'message' ? {data} : {error: data})); }
      postMessage(data) { this.worker.postMessage(data); }
      terminate() { return this.worker.terminate(); }
    };
    const client = await import('../src/core/armor-engine-client.mjs');
    try { result = await client.solveInventoryParallelAsync(payload, {parallelism: Number(workersArg) || undefined, onProgress() {}}); }
    finally { client.cancelAllSearches({dispose: true}); }
  }
  const wallMs = performance.now() - started;
  await new Promise(resolve => setTimeout(resolve, 0)); clearInterval(timer);
  const search = result.search || {}, stats = result.searchStats || {};
  const nodes = search.aggregateNodes ?? stats.statesExamined ?? 0;
  const exactStates = search.aggregateExactStates ?? stats.exactStates ?? 0;
  const mathEvaluations = search.aggregateMathEvaluations ?? stats.mathEvaluations ?? 0;
  const shardNodes = search.shards?.map(s => s.nodes) || [nodes];
  console.log(JSON.stringify({name: selectedCase, workers: Number(workersArg), profile: payload.searchProfile,
    ...stats,
    targets: payload.targets, wallMs, status: result.status, resultCount: result.results.length,
    verified: result.results.every(x => x.certificate.witnessVerification.valid),
    firstExactMs: search.firstExactMs ?? stats.firstExactMs, firstFeasibleMs: search.firstFeasibleMs ?? stats.firstFeasibleMs,
    search, nodesPerSecond: nodes * 1000 / wallMs, exactStatesPerSecond: exactStates * 1000 / wallMs,
    mathEvaluationsPerSecond: mathEvaluations * 1000 / wallMs,
    shardImbalance: nodes ? Math.max(...shardNodes) / (nodes / shardNodes.length) : null,
    mainThreadDelayMs: lag, processCpuUs: process.cpuUsage(cpu),
    memoryGrowth: process.memoryUsage().rss - memory.rss, maxRSS: process.resourceUsage().maxRSS * 1024}));
}
