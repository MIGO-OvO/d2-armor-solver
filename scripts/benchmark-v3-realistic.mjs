import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const root = path.resolve(process.argv[2] || ".");
const cases = ["easy-exact", "hard-exact", "middle-exact", "late-exact", "no-exact", "hard-rules", "exotic-set", "equivalent", "upgrade"];
const fixtureSeed = 0x1300cafe;
if (!process.argv[3]) {
  const rows = [];
  for (const name of cases) {
    const started = performance.now();
    const row = await new Promise(resolve => {
      const child = spawn(process.execPath, ["--expose-gc", "--max-old-space-size=512", fileURLToPath(import.meta.url), root, name], { windowsHide: true });
      let output = "";
      let diagnostics = "";
      const timer = setTimeout(() => child.kill(), 30000);
      child.stdout.on("data", data => { output += data; });
      child.stderr.on("data", data => { diagnostics += data; });
      child.on("close", code => {
        clearTimeout(timer);
        try { resolve(JSON.parse(output)); }
        catch { resolve({ name, outcome: "RESOURCE_LIMIT", elapsedMs: performance.now() - started, exitCode: code,
          reason: /heap/i.test(diagnostics) ? "heap limit" : "30 second process deadline" }); }
      });
    });
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  const output = process.env.BENCH_OUTPUT;
  if (output) writeFileSync(output, JSON.stringify({ root, node: process.version, seed: fixtureSeed, rows }, null, 2));
} else {
  const load = file => import(pathToFileURL(path.join(root, "src/core", file)));
  const { BASE_CONFIGS, STATS } = await load("armor-model.mjs");
  const { solveInventory, analyzeUpgrade } = await load("armor-engine.mjs");
  const { createUpgradePieceFromItem, getManualUpgradeArmorTotals } = await load("upgrade-optimizer.mjs");
  const name = process.argv[3];
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
  const result = name === "upgrade" ? analyzeUpgrade({pieces: selected, targets: target, fragments: zero,
    reassignModifiers: true, constraints: {exact}}) : solveInventory({items, targets: target, fragments: zero,
      setRequirement: name === "exotic-set" ? {type: "set", setHash: 700, count: 4} : {type: "none"},
      reassignModifiers: name === "hard-rules", userConstraints: name === "hard-rules"
        ? {minimums: {melee: 90, grenade: 90}, maximums: {health: 50, weapons: 100}, priorityLevels: {super: 1}}
        : {exact}, maxResults: 3 });
  const searchMs = performance.now() - start;
  const memory = process.memoryUsage();
  const entries = result.results || [{finalTotals: result.plan?.evaluation?.finalTotals || result.baseline?.finalTotals}];
  const exactHit = entries.some(entry => STATS.every(stat => entry.finalTotals?.[stat] === target[stat]));
  console.log(JSON.stringify({name, seed: fixtureSeed, knownIndex, targets: target, items: items.length, normalizeMs, searchMs,
    outcome: result.status || (exactHit ? "LEGACY_EXACT_HIT" : "LEGACY_PARTIAL"), exactHit,
    resultCount: result.results?.length ?? Number(Boolean(result.plan || result.baseline)),
    states: result.searchStats || {}, heapUsed: memory.heapUsed, arrayBuffers: memory.arrayBuffers,
    maxRSS: process.resourceUsage().maxRSS * 1024,
    note: "heapUsed/arrayBuffers are end-of-search samples; maxRSS is OS process high-water; proof included in searchMs"}));
}
