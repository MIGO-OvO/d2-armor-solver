import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import {
  ARCHETYPES,
  BASE_CONFIGS,
  STATS,
} from "../src/core/armor-model.mjs";
import { solveLoadout } from "../src/core/armor-engine.mjs";
import { solveInventoryLoadout } from "../src/core/inventory-solver.mjs";

const ZERO = Object.fromEntries(STATS.map(stat => [stat, 0]));
const EXACT = Object.fromEntries(STATS.map(stat => [stat, true]));
const LIMITS = {
  coldMs: 4_000,
  hotMs: 2_000,
  inventoryMs: 4_000,
  memoryBytes: 96 * 1024 * 1024,
};

if (typeof globalThis.gc !== "function") {
  const child = spawnSync(
    process.execPath,
    ["--expose-gc", process.argv[1], "--with-gc"],
    { stdio: "inherit" },
  );
  process.exit(child.status ?? 1);
}

function memoryFootprint() {
  globalThis.gc();
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

function rebuild(solution) {
  const totals = { ...ZERO };
  for (let index = 0; index < solution.config.length; index++) {
    const config = solution.config[index];
    for (const stat of STATS) totals[stat] += config.baseStats[stat];
    const tuning = solution.tuningAssignments[index];
    if (tuning.mode === "+3") {
      for (const stat of config.masterworkStats) totals[stat] += 1;
    } else {
      totals[tuning.from] -= 5;
      totals[tuning.to] += 5;
    }
    const mod = solution.modAssignments[index];
    if (mod) totals[mod.stat] += mod.size;
  }
  return totals;
}

function generatedTarget(numPlus3) {
  const configs = [
    BASE_CONFIGS[(numPlus3 * 7 + 1) % BASE_CONFIGS.length],
    BASE_CONFIGS[(numPlus3 * 7 + 9) % BASE_CONFIGS.length],
    BASE_CONFIGS[(numPlus3 * 7 + 17) % BASE_CONFIGS.length],
    BASE_CONFIGS[(numPlus3 * 7 + 25) % BASE_CONFIGS.length],
    BASE_CONFIGS[(numPlus3 * 7 + 33) % BASE_CONFIGS.length],
  ];
  const solution = {
    config: configs,
    tuningAssignments: configs.map((_, index) => index < numPlus3
      ? { mode: "+3", from: null, to: null }
      : {
        mode: "+5-5",
        from: STATS[(index + numPlus3) % STATS.length],
        to: STATS[(index + numPlus3 + 1) % STATS.length],
      }),
    modAssignments: Object.fromEntries(configs.map((_, index) => [
      index,
      { size: 10, stat: STATS[(index * 2 + numPlus3) % STATS.length] },
    ])),
  };
  return rebuild(solution);
}

let maximumOperationMemory = 0;

function timed(label, execute) {
  const memoryBefore = memoryFootprint();
  const started = performance.now();
  const value = execute();
  const elapsedMs = performance.now() - started;
  const memoryAfter = memoryFootprint();
  maximumOperationMemory = Math.max(
    maximumOperationMemory,
    Math.max(0, memoryAfter - memoryBefore),
  );
  return { label, elapsedMs, value };
}

function makeInventoryItem(config, slot, slotIndex, itemIndex) {
  return {
    id: `bench-${slotIndex}-${itemIndex}`,
    hash: 10_000 + slotIndex * 100 + itemIndex,
    name: `Benchmark ${slot} ${itemIndex}`,
    slot,
    classId: "hunter",
    tier: "5",
    exotic: false,
    archetypeId: ARCHETYPES.find(entry => entry.id === config.archetype).id,
    tertiary: config.tertiary,
    tuningMode: "plus3",
    tuningFrom: null,
    tuningTo: null,
    tuningUnknown: false,
    armorModSize: 0,
    armorModStat: "health",
    baseStats: { ...config.baseStats },
    effectiveBaseStats: { ...config.baseStats },
    optimizationBaseStats: { ...config.baseStats },
    masterworkTier: 5,
    setHash: null,
  };
}

function inventoryFixture() {
  const slots = ["helmet", "arms", "chest", "legs", "classItem"];
  let state = 5;
  const random = () => (
    (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296
  );
  const selected = [2, 11, 20, 29, 38].map(index => BASE_CONFIGS[index]);
  const target = { ...ZERO };
  selected.forEach(config => {
    for (const stat of STATS) {
      target[stat] += config.baseStats[stat]
        + Number(config.masterworkStats.includes(stat));
    }
  });
  const items = [];
  slots.forEach((slot, slotIndex) => {
    items.push(makeInventoryItem(selected[slotIndex], slot, slotIndex, 0));
    for (let itemIndex = 1; itemIndex < 8; itemIndex++) {
      const config = BASE_CONFIGS[Math.floor(random() * BASE_CONFIGS.length)];
      items.push(makeInventoryItem(config, slot, slotIndex, itemIndex));
    }
  });
  return { items, target };
}

const rows = [];
let hotPayload = null;

for (let numPlus3 = 0; numPlus3 <= 5; numPlus3++) {
  const target = generatedTarget(numPlus3);
  const payload = {
    target,
    numPlus5: 0,
    numPlus10: 5,
    numPlus3,
    constraints: { exact: EXACT },
    runtimeOptions: { maxExactSolutions: 1 },
  };
  const row = timed(`scratch-cold-plus3-${numPlus3}`, () => solveLoadout(payload));
  const witness = row.value[0];
  assert.ok(witness, `${row.label}: missing witness`);
  assert.deepEqual(rebuild(witness), target, `${row.label}: witness does not rebuild`);
  assert.ok(row.elapsedMs <= LIMITS.coldMs,
    `${row.label}: ${row.elapsedMs.toFixed(1)}ms > ${LIMITS.coldMs}ms`);
  rows.push(row);
  if (numPlus3 === 3) hotPayload = payload;
}

const hot = timed("scratch-hot-plus3-3", () => solveLoadout(hotPayload));
assert.ok(hot.elapsedMs <= LIMITS.hotMs,
  `${hot.label}: ${hot.elapsedMs.toFixed(1)}ms > ${LIMITS.hotMs}ms`);
rows.push(hot);

const { items, target: inventoryTarget } = inventoryFixture();
const inventory = timed("inventory-8^5", () => solveInventoryLoadout({
  items,
  targets: inventoryTarget,
  fragments: ZERO,
  setRequirement: { type: "none" },
  reassignModifiers: false,
  userConstraints: { exact: EXACT },
  maxResults: 1,
}));
assert.equal(inventory.value.results[0]?.metrics.allReached, true,
  "inventory-8^5: exact witness not found");
assert.ok(inventory.elapsedMs <= LIMITS.inventoryMs,
  `${inventory.label}: ${inventory.elapsedMs.toFixed(1)}ms > ${LIMITS.inventoryMs}ms`);
rows.push(inventory);

assert.ok(maximumOperationMemory <= LIMITS.memoryBytes,
  `incremental retained memory ${(maximumOperationMemory / 1024 / 1024).toFixed(1)}MiB > 96MiB`);

console.table(rows.map(({ label, elapsedMs }) => ({
  query: label,
  milliseconds: Number(elapsedMs.toFixed(1)),
})));
console.log(`maximum per-operation retained JS/ArrayBuffer memory: ${(maximumOperationMemory / 1024 / 1024).toFixed(1)} MiB`);
