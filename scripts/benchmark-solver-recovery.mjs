// Isolated, paired client/UI-order benchmark. No solver deadlines are altered.
import {spawnSync} from 'node:child_process';
import {Worker} from 'node:worker_threads';
import {availableParallelism} from 'node:os';
import {writeFileSync, readFileSync, existsSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {fixture} from './fixtures/search-performance.mjs';

const [label = 'before', name, profile, policy, outcome] = process.argv.slice(2);
if (!name) {
  const output = new URL(`../docs/benchmarks/solver-recovery-${label}.json`, import.meta.url);
  const rows = process.env.BENCH_RESUME && existsSync(output)
    ? JSON.parse(readFileSync(output, 'utf8')).rows.filter(row => !row.error) : [];
  for (const p of process.env.BENCH_PROFILES?.split(',') || ['fast', 'balanced', 'deep']) for (const n of process.env.BENCH_CASES?.split(',') || ['small', 'large', 'duplicates', 'fuzzy-large']) {
    // Fuzzy control targets the interactive-profile amplification regression.
    // Deep already has positive/negative coverage for all three vault sizes.
    if (p === 'deep' && n === 'fuzzy-large') continue;
    for (const o of ['positive', 'negative']) for (const workers of ['1', 'auto']) {
      if (rows.some(row => row.profile === p && row.name === n && row.outcome === o && row.policy === workers)) continue;
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), label, n, p, workers, o],
        {encoding: 'utf8', windowsHide: true, timeout: 330000});
      let row;
      try { row = JSON.parse(child.stdout); }
      catch { row = {name: n, profile: p, policy: workers, outcome: o, error: child.error?.message || child.stderr}; }
      rows.push(row);
      console.log(JSON.stringify(row));
      writeFileSync(output,
        JSON.stringify({label, sourceRevision: process.env.BENCH_REVISION || (label.startsWith('before') ? '1d4b7c5' : 'working-tree'),
          node: process.version, cores: availableParallelism(), rows}, null, 2) + '\n');
    }
  }
} else {
  const root = process.env.BENCH_SOURCE_ROOT ? pathToFileURL(process.env.BENCH_SOURCE_ROOT.replaceAll('\\', '/') + '/') : new URL('../', import.meta.url);
  globalThis.Worker = class {
    constructor() { this.worker = new Worker(new URL('tests/helpers/armor-worker-host.mjs', root)); }
    addEventListener(name, cb) { this.worker.on(name, data => cb(name === 'message' ? {data} : {error: data})); }
    postMessage(data) { this.worker.postMessage(data); }
    terminate() { return this.worker.terminate(); }
  };
  const client = await import(new URL('src/core/armor-engine-client.mjs', root));
  const payload = {...fixture(name === 'fuzzy-large' ? 'large' : name), searchProfile: profile};
  if (name === 'duplicates') {
    const originals = payload.items;
    payload.items = Array.from({length: 1300}, (_, i) => ({...originals[i % originals.length], id: `crowded-${i}`}));
  }
  // The no-exact control is an impossible visible total, not a timeout.
  if (outcome === 'negative') payload.targets.health = 199;
  if (name === 'fuzzy-large') payload.userConstraints = {};
  const theoryPayload = {searchProfile: profile, target: payload.targets, fragments: payload.fragments,
    targetDomain: 'visible', numPlus5: 0, numPlus10: 5, numPlus3: 0,
    constraints: payload.userConstraints};
  const startRSS = process.memoryUsage().rss;
  let peakRSS = startRSS, delay = 0, tick = performance.now(), firstTheoryMs = null, firstExactMs = null;
  const started = performance.now();
  const timer = setInterval(() => {
    const now = performance.now(); delay = Math.max(delay, now - tick - 10); tick = now;
    peakRSS = Math.max(peakRSS, process.memoryUsage().rss);
  }, 10);
  const theory = async () => {
    const result = await client.solveLoadoutAsync(theoryPayload, {onProgress: result => {
      if (result?.length) firstTheoryMs ??= performance.now() - started;
    }});
    firstTheoryMs ??= performance.now() - started;
    return result;
  };
  try {
    // Mirrors the audited app call order at the measured revision.
    const theoryTask = label.startsWith('before') || label === 'parent' ? null : theory();
    const result = await client.solveInventoryParallelAsync(payload, {
      parallelism: policy === '1' ? 1 : label === 'parent' ? Math.min(4, availableParallelism()) : undefined,
      onProgress: result => {
        if (result?.status === 'EXACT_TARGET_PROVEN') firstExactMs ??= performance.now() - started;
      },
    });
    if (result.status === 'EXACT_TARGET_PROVEN') firstExactMs ??= performance.now() - started;
    const inventoryMs = performance.now() - started;
    await (theoryTask || theory());
    const wallMs = performance.now() - started;
    await new Promise(resolve => setTimeout(resolve, 20));
    console.log(JSON.stringify({name, items: payload.items.length, profile, policy, outcome, wallMs, inventoryMs, firstTheoryMs, firstExactMs,
      aggregateNodes: result.search.aggregateNodes ?? result.search.nodes, exactStates: result.search.aggregateExactStates ?? result.search.coverage?.exactStates,
      mathEvaluations: result.search.aggregateMathEvaluations ?? result.search.coverage?.mathEvaluations, workers: result.search.workerCount ?? 1,
      shards: result.search.shardCount ?? result.search.parallelism ?? 1, peakRSS, memoryGrowth: peakRSS - startRSS, eventLoopDelayMs: delay,
      mergeMs: result.search.progressiveMergeMs === undefined ? null : result.search.progressiveMergeMs + result.search.finalMergeMs,
      status: result.status, verified: result.results.every(r => r.certificate.witnessVerification.valid)}));
  } finally { clearInterval(timer); client.cancelAllSearches(); }
}
