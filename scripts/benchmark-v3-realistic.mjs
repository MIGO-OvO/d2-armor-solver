import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const root = path.resolve(process.argv[2] || ".");
const cases = ["easy-exact", "hard-exact", "middle-exact", "late-exact", "no-exact", "hard-rules", "exotic-set", "equivalent", "upgrade"];
const profiles = ["fast", "balanced", "deep"];
const fixtureSeed = 0x1300cafe;
if (!process.argv[3]) {
  const rows = [];
  for (const name of cases) {
    for (const searchProfile of profiles) {
      const started = performance.now();
      const row = await new Promise(resolve => {
        const child = spawn(process.execPath, ["--expose-gc", "--max-old-space-size=512", fileURLToPath(import.meta.url), root, name, searchProfile], { windowsHide: true });
        let output = "";
        let diagnostics = "";
        const timer = setTimeout(() => child.kill(), 45000);
        child.stdout.on("data", data => { output += data; });
        child.stderr.on("data", data => { diagnostics += data; });
        child.on("close", code => {
          clearTimeout(timer);
          try { resolve(JSON.parse(output)); }
          catch { resolve({ name, searchProfile, outcome: "RESOURCE_LIMIT", elapsedMs: performance.now() - started, exitCode: code,
            reason: /heap/i.test(diagnostics) ? "heap limit" : "45 second process deadline" }); }
        });
      });
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  const output = process.env.BENCH_OUTPUT;
  if (output) writeFileSync(output, JSON.stringify({ root, node: process.version, seed: fixtureSeed, rows }, null, 2));
} else {
  const load = file => import(pathToFileURL(path.join(root, "src/core", file)));
  const { BASE_CONFIGS, STATS } = await load("armor-model.mjs");
  const { solveInventory, analyzeUpgrade, createSearchLimitResult } = await load("armor-engine.mjs");
  const { createSearchSession, withSearchProfile, SearchBudgetExceeded } = await load("search-session.mjs");
  const { createUpgradePieceFromItem, getManualUpgradeArmorTotals } = await load("upgrade-optimizer.mjs");
  const reference = await import(pathToFileURL(path.join(root, "tests/helpers/reference-witness.mjs")));
  const name = process.argv[3];
  const searchProfile = process.argv[4] || "balanced";
  const slots = ["helmet", "arms", "chest", "legs", "classItem"];
  const zero = Object.fromEntries(STATS.map(s => [s, 0]));
  let rng = fixtureSeed;
  const random = max => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) % max);
  const startNormalize = performance.now();
  const items = slots.flatMap((slot, index) => Array.from({length: 260}, (_, n) => {
    const equivalent = ["easy-exact", "equivalent", "upgrade"].includes(name);
    const config = BASE_CONFIGS[equivalent ? index * 4 : random(BASE_CONFIGS.length)];
    const destination = STATS[equivalent ? index : random(6)];
    const base = {...config.baseStats};
    // Real rolls are not only the 48 theoretical T5 layouts.
    if (!equivalent && n % 3 === 0) { base.health += n % 7; base.weapons -= n % 5; }
    return { id: `bench-${index}-${String(n).padStart(3, "0")}`, hash: 1000 + index, name: `Bench ${slot}`,
      slot, classId: "hunter", tier: "5", exotic: name === "exotic-set" && index === 0,
      archetypeId: config.archetype, tertiary: config.tertiary,
      tunedStat: destination, tuningStat: destination, allowedTuningStats: [destination],
      baseStats: base, effectiveBaseStats: base, optimizationBaseStats: base,
      tuningMode: equivalent || n % 2 ? "plus3" : "shift", tuningFrom: STATS[(STATS.indexOf(destination) + 1) % 6], tuningTo: destination,
      armorModSize: equivalent ? 10 : [0, 5, 10][n % 3], armorModStat: STATS[index], masterworkTier: 5,
      dataConfidence: {stats: "exact", tuning: "exact", sockets: "unknown"}, setHash: equivalent ? null : 700 + n % 3 };
  }));
  const knownIndex = name === "late-exact" ? 259 : name === "middle-exact" ? 130 : 0;
  const selected = slots.map((_, index) => createUpgradePieceFromItem(items[index * 260 + knownIndex], index));
  const target = getManualUpgradeArmorTotals(selected);
  for (const s of STATS) target[s] = Math.max(0, Math.min(200, target[s]));
  if (name === "no-exact") target.health++;
  const normalizeMs = performance.now() - startNormalize;
  const start = performance.now();
  const exact = Object.fromEntries(STATS.map(s => [s, true]));
  const operation = name === "upgrade" ? "analyzeUpgrade" : "solveInventory";
  const basePayload = name === "upgrade"
    ? {pieces: selected, targets: target, fragments: zero, reassignModifiers: true, constraints: {exact}}
    : {items, targets: target, fragments: zero,
      setRequirement: name === "exotic-set" ? {type: "set", setHash: 700, count: 4} : {type: "none"},
      reassignModifiers: name === "hard-rules", userConstraints: name === "hard-rules"
        ? {minimums: {melee: 90, grenade: 90}, maximums: {health: 50, weapons: 100}, priorityLevels: {super: 1}}
        : {exact}};
  const payload = withSearchProfile(operation, {...basePayload, searchProfile, maxResults: 3});
  const session = createSearchSession({operation, generation: 1, profile: searchProfile});
  let result;
  try {
    result = name === "upgrade" ? analyzeUpgrade(payload, session) : solveInventory(payload, session);
  } catch (error) {
    if (!(error instanceof SearchBudgetExceeded)) throw error;
    result = session.lastResult || createSearchLimitResult(operation, payload);
  }
  result = session.finish(result);
  const searchMs = performance.now() - start;
  const memory = process.memoryUsage();
  const search = result.search || {};
  const stats = result.searchStats || {};
  const entries = result.results || [{finalTotals: result.plan?.evaluation?.finalTotals || result.baseline?.finalTotals}];
  const exactHit = entries.some(entry => STATS.every(stat => entry.finalTotals?.[stat] === target[stat]));
  const rebuildVerified = result.results ? result.results.every(entry => {
    if (!entry.pieces || !entry.tuningAssignments || !entry.modAssignments) return false;
    try {
      const rebuilt = reference.rebuildReference(entry.pieces, entry.tuningAssignments, entry.modAssignments, zero);
      return STATS.every(stat => rebuilt.visible[stat] === entry.finalTotals?.[stat]);
    } catch { return false; }
  }) : null;
  const evaluations = Number.isSafeInteger(result.examined) ? result.examined : null;
  const canonicalId = result.results?.[0]?.canonicalId ?? result.plan?.canonicalId ?? result.certificate?.canonicalId ?? null;
  const termination = search.termination && search.termination !== "completed"
    ? search.termination
    : stats.frontierComplete === false && stats.termination && stats.termination !== "exhausted"
      ? stats.termination
      : search.termination ?? stats.termination;
  console.log(JSON.stringify({name, searchProfile, seed: fixtureSeed, knownIndex, targets: target, items: items.length, normalizeMs, searchMs,
    elapsedMs: search.elapsedMs ?? searchMs,
    status: result.certificate?.status ?? result.status,
    termination,
    coverageComplete: search.coverage?.complete ?? null,
    frontierComplete: stats.frontierComplete ?? null,
    statesExamined: stats.statesExamined ?? search.coverage?.statesExamined ?? null,
    nodes: search.nodes ?? null,
    evaluations,
    mathEvaluations: stats.mathEvaluations ?? null,
    mathCacheHits: stats.mathCacheHits ?? null,
    evaluationMs: stats.evaluationMs ?? null,
    prunedJoint: stats.prunedJoint ?? null,
    refinedAssignments: stats.refinedAssignments ?? null,
    peakStates: stats.peakStates ?? null,
    firstFeasibleMs: search.firstFeasibleMs ?? null,
    firstExactMs: search.firstExactMs ?? null,
    exactHit, rebuildVerified,
    canonicalId: canonicalId === null ? null : String(canonicalId).slice(0, 96),
    canonicalLength: canonicalId === null ? 0 : String(canonicalId).length,
    resultCount: result.results?.length ?? Number(Boolean(result.plan || result.baseline)),
    heapUsed: memory.heapUsed, arrayBuffers: memory.arrayBuffers,
    maxRSS: process.resourceUsage().maxRSS * 1024,
    note: "heapUsed/arrayBuffers are end-of-search samples; maxRSS is OS process high-water; proof included in searchMs"}));
}
