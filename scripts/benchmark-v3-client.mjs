// Real production-path benchmark for the inventory solver.
//
// `benchmark:v3-realistic` calls the backend `solveInventory()` directly, so it
// cannot see anything the *client* wrapper does: the search profile it forwards,
// worker parallelism, aggregate worker effort, or the progressive callback /
// projection cache. This script drives `solveInventoryParallelAsync()` with a
// realistic 1300-piece vault (5 slots x 260) and records wall time, time to
// first feasible/exact witness, termination and coverage, states, nodes,
// evaluations, math cache hits, pruning counters and the canonical witness.
//
// BENCH_FORCE_EXHAUSTIVE=1 emulates the historical wrapper bug (it injected
// `searchLimits.exhaustive = true` into every shard) so before/after numbers can
// be produced in a single run without editing the source.

import { Worker as NodeWorker } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = file => import(pathToFileURL(path.join(root, "src/core", file)));

const { BASE_CONFIGS, STATS } = await load("armor-model.mjs");
const { createUpgradePieceFromItem, getManualUpgradeArmorTotals } = await load("upgrade-optimizer.mjs");
const { solveInventory } = await load("armor-engine.mjs");
const { withSearchProfile } = await load("search-session.mjs");

const slots = ["helmet", "arms", "chest", "legs", "classItem"];
const fixtureSeed = 0x1300cafe;
let rng = fixtureSeed;
const random = max => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) % max);

function buildFixture(perSlot) {
  return slots.flatMap((slot, index) => Array.from({length: perSlot}, (_, n) => {
    const config = BASE_CONFIGS[random(BASE_CONFIGS.length)];
    const base = {...config.baseStats};
    // Real rolls are not only the 48 theoretical T5 layouts.
    if (n % 3 === 0) { base.health += n % 7; base.weapons -= n % 5; }
    const destination = STATS[(index + n) % 6];
    return {
      id: `bench-${index}-${String(n).padStart(3, "0")}`, hash: 1000 + index, name: `Bench ${slot}`,
      slot, classId: "hunter", tier: "5", exotic: false,
      archetypeId: config.archetype, tertiary: config.tertiary,
      tunedStat: destination, tuningStat: destination, allowedTuningStats: [destination],
      baseStats: base, effectiveBaseStats: base, optimizationBaseStats: base,
      tuningMode: n % 2 ? "plus3" : "shift",
      tuningFrom: STATS[(STATS.indexOf(destination) + 1) % 6], tuningTo: destination,
      armorModSize: [0, 5, 10][n % 3], armorModStat: STATS[index], masterworkTier: 5,
      dataConfidence: {stats: "exact", tuning: "exact", sockets: "unknown"},
      setHash: 700 + n % 3,
    };
  }));
}

// A vault of 260 identical-per-slot rolls. Every combination is an exact
// witness, so a non-exhaustive profile reaches its `exact-witness-quota` stop
// almost immediately — which is exactly the early termination the client
// wrapper used to disable by forcing `exhaustive: true`.
function buildEquivalentFixture(perSlot) {
  return slots.flatMap((slot, index) => Array.from({length: perSlot}, (_, n) => {
    const config = BASE_CONFIGS[(index * 4) % BASE_CONFIGS.length];
    const destination = STATS[index];
    return {
      id: `equiv-${index}-${String(n).padStart(3, "0")}`, hash: 2000 + index, name: `Equiv ${slot}`,
      slot, classId: "hunter", tier: "5", exotic: false,
      archetypeId: config.archetype, tertiary: config.tertiary,
      tunedStat: destination, tuningStat: destination, allowedTuningStats: [destination],
      baseStats: {...config.baseStats}, effectiveBaseStats: {...config.baseStats},
      optimizationBaseStats: {...config.baseStats},
      tuningMode: "plus3", tuningFrom: null, tuningTo: null,
      armorModSize: 10, armorModStat: STATS[index], masterworkTier: 5,
      dataConfidence: {stats: "exact", tuning: "exact", sockets: "unknown"}, setHash: null,
    };
  }));
}

// A deterministic exact target: the totals of one specific owned five-piece set.
function exactTarget(items, perSlot, knownIndex) {
  const selected = slots.map((_, index) =>
    createUpgradePieceFromItem(items[index * perSlot + knownIndex], index));
  const target = getManualUpgradeArmorTotals(selected);
  for (const stat of STATS) target[stat] = Math.max(0, Math.min(200, target[stat]));
  return target;
}

const live = new Set();
class ThreadWorker {
  constructor() {
    this.worker = new NodeWorker(new URL("../tests/helpers/armor-worker-host.mjs", import.meta.url));
    live.add(this);
  }
  addEventListener(name, callback) {
    this.worker.on(name, value => callback(name === "message" ? {data: value} : {error: value}));
  }
  postMessage(data) { this.worker.postMessage(data); }
  terminate() { live.delete(this); return this.worker.terminate(); }
}

const originalWorker = globalThis.Worker;
globalThis.Worker = ThreadWorker;
const client = await import(pathToFileURL(path.join(root, "src/core/armor-engine-client.mjs")).href);

const forceExhaustive = process.env.BENCH_FORCE_EXHAUSTIVE === "1";

function basePayload(items, target, maxResults = 12) {
  return {
    items,
    targets: target,
    fragments: Object.fromEntries(STATS.map(stat => [stat, 0])),
    setRequirement: {type: "none"},
    reassignModifiers: true,
    maxResults,
    userConstraints: {exact: Object.fromEntries(STATS.map(stat => [stat, true]))},
    ...(forceExhaustive ? {searchLimits: {exhaustive: true}} : {}),
  };
}

async function runCase({name, items, target, perSlot, profile, parallelism, maxResults = 12}) {
  const payload = {...basePayload(items, target, maxResults), searchProfile: profile};
  const progress = [];
  const started = performance.now();
  let result;
  try {
    result = await client.solveInventoryParallelAsync(payload, {
      parallelism,
      onProgress: (partial, search) => {
        if (partial?.results?.length) {
          progress.push({
            elapsedMs: search?.elapsedMs ?? null,
            running: search?.running ?? null,
            nodes: search?.nodes ?? null,
            topK: partial.results.map(row => row.canonicalId),
            status: partial.certificate?.status ?? null,
          });
        }
      },
    });
  } catch (error) {
    return {name, profile, parallelism, exit: "error", error: error?.message || String(error)};
  }
  const wallMs = performance.now() - started;
  const search = result.search || {};
  const stats = result.searchStats || {};
  const shards = search.shards || [];
  const finalTopK = result.results.map(row => row.canonicalId);
  // Progressive Top-K must converge on the final Top-K: every published
  // candidate is a verified witness, and the last publication is the merge of
  // everything the shards produced.
  const lastProgressive = progress.at(-1)?.topK || [];
  return {
    name, profile, parallelism,
    wallMs: Math.round(wallMs),
    parallelismReported: search.parallelism ?? null,
    workerCount: search.workerCount ?? null,
    budgetScope: search.budgetScope ?? null,
    timeToFirstFeasibleMs: search.firstFeasibleMs ?? null,
    timeToFirstExactMs: search.firstExactMs ?? null,
    termination: search.termination ?? null,
    shardTerminations: shards.map(shard => shard.termination),
    frontierTerminations: shards.map(shard => shard.frontierTermination),
    earlyStopObserved: shards.some(shard => shard.frontierTermination === "exact-witness-quota"),
    frontierComplete: stats.frontierComplete ?? null,
    assignmentComplete: stats.assignmentComplete ?? null,
    proofComplete: result.certificate?.proof?.complete ?? null,
    states: stats.statesExamined ?? null,
    nodes: search.nodes ?? null,
    aggregateNodes: search.aggregateNodes ?? null,
    shardNodes: shards.map(shard => shard.nodes),
    examined: result.examined ?? null,
    evaluations: result.examined ?? null,
    mathEvaluations: stats.mathEvaluations ?? null,
    mathCacheHits: stats.mathCacheHits ?? null,
    prunedBounds: stats.prunedBounds ?? null,
    prunedSets: stats.prunedSets ?? null,
    prunedJoint: stats.prunedJoint ?? null,
    layers: stats.layers ?? null,
    method: stats.method ?? null,
    equivalentItems: stats.equivalentItems ?? null,
    mathEquivalentItems: stats.mathEquivalentItems ?? null,
    status: result.certificate?.status ?? result.status ?? null,
    resultCount: finalTopK.length,
    canonicalId: finalTopK[0] ? String(finalTopK[0]).slice(0, 72) : null,
    canonicalLength: finalTopK[0] ? String(finalTopK[0]).length : 0,
    progressiveEvents: progress.length,
    progressiveMatchesFinal: lastProgressive.length > 0
      && lastProgressive.length === finalTopK.length
      && lastProgressive.every((value, index) => value === finalTopK[index]),
    exactHit: result.results.some(row => STATS.every(stat => row.finalTotals?.[stat] === target[stat])),
    perSlot,
    items: items.length,
  };
}

const rows = [];

// --- The production-shaped case: 5 slots x 260 = 1300 vault items -----------
{
  rng = fixtureSeed;
  const items = buildFixture(260);
  const target = exactTarget(items, 260, 0);
  for (const profile of ["fast", "balanced"]) {
    for (const parallelism of [1, 2, 4]) {
      rows.push(await runCase({name: "vault-1300", items, target, perSlot: 260, profile, parallelism}));
      client.cancelAllSearches();
    }
  }
}

// --- Fast/Balanced early termination on the real client path ---------------
{
  const items = buildEquivalentFixture(260);
  const target = exactTarget(items, 260, 0);
  for (const profile of ["fast", "balanced"]) {
    for (const parallelism of [1, 4]) {
      rows.push(await runCase({name: "equivalent-1300", items, target, perSlot: 260, profile, parallelism}));
      client.cancelAllSearches();
    }
  }
}

// --- Deep on a deliberately small case (its budget is 120 s) ---------------
{
  rng = fixtureSeed;
  const items = buildFixture(8);
  const target = exactTarget(items, 8, 0);
  for (const parallelism of [1, 4]) {
    rows.push(await runCase({name: "small-40", items, target, perSlot: 8, profile: "deep", parallelism, maxResults: 3}));
    client.cancelAllSearches();
  }
}

// --- Parallelism must not change a proven result ---------------------------
// The same tiny inventory is solved every way; the proven canonical Top-K has
// to be identical, which is the client-path counterpart of the worker test.
{
  rng = fixtureSeed;
  const items = buildFixture(3);
  const target = exactTarget(items, 3, 0);
  const reference = solveInventory(withSearchProfile("solveInventory", basePayload(items, target, 3)));
  for (const parallelism of [1, 2, 4]) {
    for (const profile of ["fast", "balanced"]) {
      const row = await runCase({name: "parallel-equivalence", items, target, perSlot: 3, profile, parallelism, maxResults: 3});
      row.referenceCanonicalIds = reference.results.map(item => item.canonicalId);
      row.matchesReference = row.resultCount === reference.results.length
        && (row.canonicalId
          ? reference.results[0].canonicalId.startsWith(row.canonicalId)
          : false);
      rows.push(row);
      client.cancelAllSearches();
    }
  }
}

globalThis.Worker = originalWorker;
for (const worker of live) worker.terminate();
for (const row of rows) console.log(JSON.stringify(row));

const output = process.env.BENCH_OUTPUT;
if (output) {
  writeFileSync(output, JSON.stringify({
    root, node: process.version, seed: fixtureSeed, forceExhaustive, rows,
  }, null, 2));
}
