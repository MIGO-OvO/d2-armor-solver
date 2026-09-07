import assert from "node:assert/strict";
import {BASE_CONFIGS, STATS} from "../src/core/armor-model.mjs";
import {solveLoadoutAsync, solveInventoryAsync, cancelAllSearches} from "../src/core/armor-engine-client.mjs";
const exact = Object.fromEntries(STATS.map(stat => [stat, true]));
const slots = ["helmet", "arms", "chest", "legs", "classItem"];
const items = slots.flatMap((slot, index) => Array.from({length: 20}, (_, n) => {
  const config = BASE_CONFIGS[(index * 4 + n) % 48];
  return {...config, id: `${slot}-${n}`, hash: index + 1, slot, archetypeId: config.archetype,
    effectiveBaseStats: {...config.baseStats}, optimizationBaseStats: {...config.baseStats}, masterworkTier: 5,
    tuningMode: "plus3", tunedStat: "health", allowedTuningStats: ["health"], armorModSize: 0,
    dataConfidence: {stats: "exact", tuning: "exact"}};
}));
const targets = Object.fromEntries(STATS.map(stat => [stat, slots.reduce((sum, _, index) => {
  const config = BASE_CONFIGS[index * 4];
  return sum + config.baseStats[stat] + Number(config.masterworkStats.includes(stat));
}, 0)]));
for (const searchProfile of ["fast", "balanced", "deep"]) {
  for (const operation of ["solve", "inventory"]) {
    const events = [];
    const payload = operation === "inventory" ? {items, targets, fragments: {}, reassignModifiers: false,
      setRequirement: {type: "none"}, userConstraints: {exact}} : {target: {health: 0, melee: 100, grenade: 100, super: 100, class: 100, weapons: 100},
      numPlus5: 0, numPlus10: 5, numPlus3: 0, constraints: {exact}};
    const result = await (operation === "inventory" ? solveInventoryAsync : solveLoadoutAsync)(
      {...payload, searchProfile}, {onProgress: (value, search) => {
        if (value) assert.equal(value.certificate.witnessVerification.valid, true);
        events.push({elapsedMs: search.elapsedMs, status: value?.certificate?.status || null});
      }});
    assert.ok(result.certificate);
    assert.equal(result.search.running, false);
    console.log(JSON.stringify({operation, searchProfile, status: result.certificate.status,
      ...result.search, events}));
  }
}
cancelAllSearches();
