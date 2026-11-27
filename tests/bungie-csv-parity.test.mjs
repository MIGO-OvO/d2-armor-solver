import assert from "node:assert/strict";
import test from "node:test";

import { solveInventory } from "../src/core/armor-engine.mjs";
import { buildArmorInventory, normalizeApiItem } from "../src/core/bungie-inventory.mjs";
import { normalizeDimItem } from "../src/core/dim-csv.mjs";
import { createUpgradePieceFromItem } from "../src/core/upgrade-optimizer.mjs";
import { ARCHETYPES, ARCHETYPE_LABELS, EXOTIC_PERK_NAMES, STATS } from "../src/core/armor-model.mjs";
import {
  BALANCED_TUNING_MOD_HASH,
  STAT_MOD_HASHES,
  TUNING_MOD_HASH_BY_TUNING,
} from "../src/core/armor-mods.data.mjs";

// Parity contract (handoff 3.5 / Phase B completion): the SAME armor instance
// described through Bungie's GetProfile ItemStats+sockets and through a DIM
// armor CSV row must normalize to identical base stats, displayed stats,
// masterwork tier, framework, tertiary, fixed tuning stat, and the same piece
// the solver consumes (createUpgradePieceFromItem output).
//
// The item hash (3400283633, a real helmet) and every stat/mod/tuning hash
// below are REAL values (the helmet appears in tests/fixtures/profile-fixture.json
// with a melee +10 mod, hash 4287799666, installed). Instance IDs are
// desensitized placeholders. Bungie's ItemStats are the item's FULLY COMPUTED
// stats (base + masterwork + installed tuning + installed stat mod), which is
// what the game displays and what DIM's CSV displayed columns report; the
// Bungie path recovers the rolled base by subtracting each layer (handoff 3.5,
// confirmed against live accounts). A fresh capture with ItemStats +
// reusable plugs should be diffed against this file before any formula change
// (scripts/capture-profile-fixture.mjs).

const ITEM_HASH = 3400283633;
const FRAME = ARCHETYPES.find(archetype => archetype.id === "Powerhouse");
const TERTIARY = "grenade";
const FRAMEWORK = new Set([FRAME.primary, FRAME.secondary, TERTIARY]);

const STAT_HASH = {
  weapons: 2996146975,
  health: 392767087,
  class: 1943323491,
  grenade: 1735777505,
  super: 144602215,
  melee: 4244567218,
};

const CATALOG = {
  [ITEM_HASH]: {
    name: { zh: "真实头盔", zhCht: "真實頭盔", en: "Real Helmet" },
    rarity: "Legendary",
    tierType: 5,
  },
};

// Base roll: weapons 30 / super 25 / grenade 20 / health 5 / melee 5 / class 5.
const BASE_ROLL = { health: 5, melee: 5, grenade: 20, super: 25, class: 5, weapons: 30 };

// All stat mods the stat socket accepts, plus the empty placeholder.
const ALL_STAT_HASHES = Object.values(STAT_MOD_HASHES).flatMap(sizes => Object.values(sizes).map(Number));

// Legendary tuning socket: balanced + every directional mod whose +5
// destination is the piece's fixed tuning stat.
function tuningCandidatesFor(fixedTuningStat) {
  const candidates = [BALANCED_TUNING_MOD_HASH];
  for (const [key, hash] of Object.entries(TUNING_MOD_HASH_BY_TUNING)) {
    if (key.startsWith(`${fixedTuningStat}:`)) candidates.push(Number(hash));
  }
  return candidates;
}

// One instance described per case: { name, masterworkTier, statMod, tuning, tuningStat }
const CASES = [
  { name: "no mod, no tuning, full masterwork", masterworkTier: 5, statMod: null, tuning: null, tuningStat: "health" },
  { name: "+10 stat mod", masterworkTier: 5, statMod: { stat: "melee", size: 10 }, tuning: null, tuningStat: "health" },
  { name: "+5 stat mod", masterworkTier: 5, statMod: { stat: "class", size: 5 }, tuning: null, tuningStat: "health" },
  { name: "+5/-5 tuning", masterworkTier: 5, statMod: null, tuning: { to: "health", from: "weapons" }, tuningStat: "health" },
  { name: "balanced tuning", masterworkTier: 5, statMod: null, tuning: "plus3", tuningStat: "health" },
  { name: "non-masterworked, no mods", masterworkTier: 0, statMod: null, tuning: null, tuningStat: "health" },
  { name: "partial masterwork + +10 mod", masterworkTier: 3, statMod: { stat: "super", size: 10 }, tuning: null, tuningStat: "health" },
];

function masterworkBonus(tier) {
  return Math.min(5, Math.max(0, tier));
}

// Bungie ItemStats are the item's fully computed stats: rolled base +
// masterwork bonus + installed tuning + installed stat mod (the game's
// current item values). This mirrors what the CSV displayed columns report.
function itemStatsFor({ masterworkTier, statMod, tuning }) {
  const changes = tuningChangesFor(tuning);
  const stats = {};
  for (const stat of Object.keys(STAT_HASH)) {
    const base = BASE_ROLL[stat];
    const bonus = FRAMEWORK.has(stat) ? 0 : masterworkBonus(masterworkTier);
    const mod = statMod && statMod.stat === stat ? statMod.size : 0;
    stats[STAT_HASH[stat]] = {
      statHash: STAT_HASH[stat],
      value: base + bonus + (changes[stat] || 0) + mod,
    };
  }
  return stats;
}

function tuningChangesFor(tuning) {
  if (!tuning) return {};
  if (tuning === "plus3") {
    return Object.fromEntries(
      Object.keys(STAT_HASH).filter(stat => !FRAMEWORK.has(stat)).map(stat => [stat, 1]),
    );
  }
  return { [tuning.from]: -5, [tuning.to]: 5 };
}

function bungieItemFor({ masterworkTier, statMod, tuning, tuningStat }) {
  const instanceId = "7000000000000000001";
  const statHash = statMod ? Number(STAT_MOD_HASHES[statMod.stat][statMod.size]) : 0;
  const tuningHash = tuning === "plus3"
    ? Number(BALANCED_TUNING_MOD_HASH)
    : tuning ? Number(TUNING_MOD_HASH_BY_TUNING[`${tuning.to}:${tuning.from}`]) : 0;
  const masterworkPlug = [2024015888, 2024015889, 2024015890, 2024015891, 2024015892, 2024015893][masterworkTier];
  const sockets = [
    { socketIndex: 0, plugHash: statHash, isEnabled: true, isVisible: true },
    { socketIndex: 1, plugHash: tuningHash, isEnabled: true, isVisible: true },
    { socketIndex: 2, plugHash: masterworkPlug, isEnabled: true, isVisible: true },
  ];
  const reusablePlugs = {
    0: ALL_STAT_HASHES.map(plugItemHash => ({ plugItemHash, canInsert: true, enabled: true })),
    1: tuningCandidatesFor(tuningStat).map(plugItemHash => ({ plugItemHash, canInsert: true, enabled: true })),
  };
  return normalizeApiItem(
    { bucketHash: 3448274439, itemHash: ITEM_HASH, itemInstanceId: instanceId, tierType: 5 },
    {
      characterClassType: 1,
      instances: { [instanceId]: { energy: { energyCapacity: 11, energyUsed: 0, energyUnused: 11 } } },
      itemStats: { [instanceId]: { stats: itemStatsFor({ masterworkTier, statMod, tuning }) } },
      sockets: { [instanceId]: { sockets } },
      reusablePlugs: { [instanceId]: { plugs: reusablePlugs } },
      catalog: CATALOG,
      language: "en",
      owner: "Vault",
    },
  );
}

function csvRowFor({ masterworkTier, statMod, tuning, tuningStat }) {
  const changes = tuningChangesFor(tuning);
  const displayed = {};
  for (const stat of Object.keys(STAT_HASH)) {
    const base = BASE_ROLL[stat];
    const bonus = FRAMEWORK.has(stat) ? 0 : masterworkBonus(masterworkTier);
    const mod = statMod && statMod.stat === stat ? statMod.size : 0;
    displayed[stat] = base + bonus + (changes[stat] || 0) + mod;
  }
  return {
    Hash: String(ITEM_HASH),
    Type: "Helmet",
    Equippable: "Hunter",
    Archetype: ARCHETYPE_LABELS[FRAME.id].en,
    "Tertiary Stat": "Grenade",
    "Tuning Stat": tuningStat || "",
    "Masterwork Tier": String(masterworkTier),
    ...Object.fromEntries(Object.keys(STAT_HASH).map(stat => [`${capitalize(stat)} (Base)`, String(BASE_ROLL[stat])])),
    ...Object.fromEntries(Object.keys(STAT_HASH).map(stat => [capitalize(stat), String(displayed[stat])])),
    Tier: "Legendary",
    Rarity: "Legendary",
    Name: "Real Helmet",
    Id: "csv-instance-1",
    Owner: "Vault",
    Equipped: "false",
    Locked: "false",
    Power: "2010",
  };
}

function capitalize(stat) {
  return stat[0].toUpperCase() + stat.slice(1);
}

for (const entry of CASES) {
  test(`parity: ${entry.name} normalizes identically via Bungie and DIM CSV`, () => {
    const apiItem = bungieItemFor(entry);
    const csvItem = normalizeDimItem(csvRowFor(entry));

    assert.equal(apiItem.archetypeId, "Powerhouse");
    assert.equal(csvItem.archetypeId, "Powerhouse", "framework must match across paths");
    assert.equal(apiItem.tertiary, csvItem.tertiary, "tertiary must match");

    for (const stat of STATS) {
      assert.equal(apiItem.baseStats[stat], csvItem.baseStats[stat], `baseStats.${stat}`);
      assert.equal(apiItem.displayedStats[stat], csvItem.displayedStats[stat], `displayedStats.${stat}`);
      assert.equal(apiItem.optimizationBaseStats[stat], csvItem.optimizationBaseStats[stat], `optimizationBaseStats.${stat}`);
    }
    assert.equal(apiItem.masterworkTier, csvItem.masterworkTier, "masterwork tier");
    assert.equal(apiItem.energy.capacity, 11, "mod energy capacity is independent of masterwork");
    assert.equal(apiItem.armorModStat, csvItem.armorModStat, "installed stat mod stat");
    assert.equal(apiItem.armorModSize, csvItem.armorModSize, "installed stat mod size");
    assert.equal(apiItem.tuningStat, csvItem.tuningStat, "fixed tuning stat");

    // The solver consumes the piece; both paths must produce the same piece.
    const apiPiece = createUpgradePieceFromItem(apiItem, 0);
    const csvPiece = createUpgradePieceFromItem(csvItem, 0);
    assert.equal(apiPiece.tuningMode, csvPiece.tuningMode, "piece tuning mode");
    assert.equal(apiPiece.tuningTo, csvPiece.tuningTo, "piece tuning destination");
    assert.equal(apiPiece.tuningFrom, csvPiece.tuningFrom, "piece tuning source");
    assert.equal(apiPiece.armorModSize, csvPiece.armorModSize, "piece stat mod size");
    assert.equal(apiPiece.armorModStat, csvPiece.armorModStat, "piece stat mod stat");
    assert.equal(apiPiece.tuningUnknown, csvPiece.tuningUnknown, "piece tuning confidence");
  });
}

test("parity: fixed tuning stat derived from Bungie sockets equals the DIM CSV Tuning Stat column", () => {
  const apiItem = bungieItemFor({ masterworkTier: 5, statMod: null, tuning: null, tuningStat: "health" });
  // The tuning socket's reusable plugs contain only balanced + the directional
  // mods whose +5 destination is "health", so the derived fixed stat is health
  // — matching what DIM's CSV "Tuning Stat" column reports for the same piece.
  assert.equal(apiItem.tuningStat, "health");
  assert.deepEqual(apiItem.allowedTuningStats, ["health"]);
  assert.equal(apiItem.dataConfidence.tuning, "exact");
  assert.equal(apiItem.dataConfidence.sockets, "exact");
});

test("an exotic-style tuning socket (every destination) is not locked to one stat", () => {
  const instanceId = "7000000000000000002";
  const exotic = normalizeApiItem(
    { bucketHash: 1585787867, itemHash: ITEM_HASH, itemInstanceId: instanceId, tierType: 6 },
    {
      characterClassType: 1,
      instances: { [instanceId]: { energy: { energyCapacity: 10, energyUsed: 0, energyUnused: 10 } } },
      itemStats: { [instanceId]: { stats: itemStatsFor({ masterworkTier: 10 }) } },
      sockets: { [instanceId]: { sockets: [{ socketIndex: 1, plugHash: 0, isEnabled: true, isVisible: true }] } },
      plugs: {},
      reusablePlugs: { [instanceId]: { plugs: {
        1: [...tuningCandidatesFor("health"), ...tuningCandidatesFor("grenade"), ...tuningCandidatesFor("weapons")]
          .map(plugItemHash => ({ plugItemHash, canInsert: true, enabled: true })),
      } } },
      catalog: CATALOG,
      language: "en",
      owner: "Vault",
    },
  );
  assert.equal(exotic.tuningStat, null, "multiple tuning destinations mean the item is not locked");
  assert.ok(exotic.allowedTuningStats.length > 1);
  assert.equal(exotic.dataConfidence.tuning, "exact");
});

test("Bungie and DIM find the same exact four-piece set with Relativism", () => {
  const classItemHash = 2809120022;
  const primaryPerkId = "inmost";
  const secondaryPerkId = "cyrtarachne";
  // Five rolls from the reported case with synthetic instance IDs. Stats are in STATS order.
  const rolls = [
    { hash: 656307180, type: "Helmet", frame: "Specialist", tertiary: "Super", tuned: "class",
      base: [0, 0, 0, 20, 30, 25], current: [0, 5, 5, 20, 35, 35],
      masterwork: 5, masterworkPlug: 1283668722, tuning: "class:health", mod: "weapons" },
    { hash: 4105572261, type: "Gauntlets", frame: "Gunner", tertiary: "Super", tuned: "super",
      base: [0, 0, 25, 20, 0, 30], current: [0, 0, 25, 20, 0, 30],
      masterwork: 0, masterworkPlug: 3266153492 },
    { hash: 2245093627, type: "Chest Armor", frame: "Specialist", tertiary: "Melee", tuned: "grenade",
      base: [0, 20, 0, 0, 30, 25], current: [1, 20, 1, 1, 30, 35],
      masterwork: 0, masterworkPlug: 3266153492, tuning: "balanced", mod: "weapons" },
    { hash: 157934631, type: "Leg Armor", frame: "Gunner", tertiary: "Melee", tuned: "grenade",
      base: [0, 20, 25, 0, 0, 30], current: [0, 20, 30, -5, 0, 40],
      masterwork: 0, masterworkPlug: 3266153492, tuning: "grenade:super", mod: "weapons" },
    { hash: classItemHash, type: "Hunter Cloak", frame: "Paragon", tertiary: "Grenade",
      base: [0, 25, 20, 30, 0, 0], current: [5, 35, 20, 25, 5, 10],
      masterwork: 5, masterworkPlug: 2183487818, tuning: "weapons:super", mod: "melee" },
  ];
  const profileInventory = {data: {items: []}};
  const itemComponents = { instances: { data: {} }, stats: { data: {} }, sockets: { data: {} }, reusablePlugs: { data: {} } };
  const csv = rolls.map((roll, index) => {
    const id = `report-${index}`;
    const exotic = roll.hash === classItemHash;
    const tuningHash = roll.tuning === "balanced" ? BALANCED_TUNING_MOD_HASH
      : TUNING_MOD_HASH_BY_TUNING[roll.tuning] ?? 2121121504;
    const plugHashes = [roll.mod ? STAT_MOD_HASHES[roll.mod][10] : 1980618587, tuningHash, roll.masterworkPlug];
    if (exotic) plugHashes.push(EXOTIC_PERK_NAMES[primaryPerkId].hash, EXOTIC_PERK_NAMES[secondaryPerkId].hash);
    profileInventory.data.items.push({ itemHash: roll.hash, itemInstanceId: id, bucketHash: 138197802 });
    itemComponents.instances.data[id] = { energy: { energyCapacity: 11 } };
    itemComponents.stats.data[id] = { stats: Object.fromEntries(STATS.map((stat, i) =>
      [STAT_HASH[stat], { statHash: STAT_HASH[stat], value: roll.current[i] }])) };
    itemComponents.sockets.data[id] = { sockets: plugHashes.map(plugHash => ({ plugHash, isEnabled: true })) };
    itemComponents.reusablePlugs.data[id] = { plugs: {
      1: exotic ? [] : tuningCandidatesFor(roll.tuned).map(plugItemHash => ({ plugItemHash })),
    } };
    return normalizeDimItem({ Id: id, Hash: roll.hash, Type: roll.type, Equippable: "Hunter",
      Tier: "5", Rarity: exotic ? "Exotic" : "Legendary", Archetype: roll.frame,
      "Tertiary Stat": roll.tertiary, "Tuning Stat": roll.tuned ? capitalize(roll.tuned) : "",
      "Masterwork Tier": roll.masterwork,
      ...Object.fromEntries(STATS.flatMap((stat, i) => [
        [capitalize(stat), roll.current[i]], [`${capitalize(stat)} (Base)`, roll.base[i]],
      ])),
    });
  });
  const profile = { Response: { profileInventory, itemComponents } };
  const { items } = buildArmorInventory(profile);
  const targets = { health: 20, melee: 70, grenade: 80, super: 80, class: 80, weapons: 160 };
  const request = {
    targets, fragments: { class: -10 }, setRequirement: { type: "set", setHash: 741162535, count: 4 },
    fixedExotic: { hash: classItemHash, classId: "hunter", slot: "classItem", primaryPerkId, secondaryPerkId,
      config: { archetype: "Paragon", tertiary: "grenade", baseStats: csv.at(-1).optimizationBaseStats } },
    reassignModifiers: true, onlyPlus5Tuning: true,
    userConstraints: { exact: Object.fromEntries(STATS.map(stat => [stat, true])) },
  };
  for (const [source, inventory] of [["DIM CSV", csv], ["Bungie", items]]) {
    const result = solveInventory({ ...request, items: inventory });
    assert.equal(result.status, "EXACT_TARGET_PROVEN", source);
    const [witness] = result.results;
    assert.deepEqual(witness.finalTotals, targets);
    assert.deepEqual(witness.pieces.map(piece => piece.sourceId).sort(), csv.map(item => item.id).sort());
    const classItemIndex = witness.pieces.findIndex(piece => piece.hash === classItemHash);
    assert.equal(witness.tuningAssignments[classItemIndex].to, "weapons");
  }

  const exotic = items.find(item => item.hash === classItemHash);
  assert.equal(exotic.primaryPerkId, primaryPerkId);
  assert.equal(exotic.secondaryPerkId, secondaryPerkId);
  assert.deepEqual(exotic.allowedTuningStats, STATS);
  assert.equal(exotic.dataConfidence.sockets, "partial");
  delete itemComponents.reusablePlugs.data[exotic.id];
  assert.deepEqual(buildArmorInventory(profile).items.at(-1).allowedTuningStats, STATS);
  itemComponents.reusablePlugs.data[exotic.id] = { plugs: { 1: [{ plugItemHash: BALANCED_TUNING_MOD_HASH }] } };
  // The current directional plug also remains a valid candidate for this socket.
  assert.deepEqual(buildArmorInventory(profile).items.at(-1).allowedTuningStats, ["weapons"]);
});
