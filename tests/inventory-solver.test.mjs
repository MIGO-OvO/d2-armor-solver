import assert from "node:assert/strict";
import test from "node:test";
import { BASE_CONFIGS } from "../src/core/armor-model.mjs";
import { solveInventoryLoadout } from "../src/core/inventory-solver.mjs";
import {
  compareUpgradeMetrics,
  createUpgradePieceFromItem,
  evaluateUpgradePieces,
} from "../src/core/upgrade-optimizer.mjs";

const SET_A = 741162535; // 埃希恩记忆 (Atheon's Memory)
const SET_B = 774717709; // 传承之誓 (Legacy's Oath)
const SLOTS = ["helmet", "arms", "chest", "legs", "classItem"];

function makeItem(name, slot, setHash, baseStats, hashSuffix = 1) {
  return {
    id: `${slot}-${setHash || "none"}-${hashSuffix}`,
    hash: Number(`${slot.length}${setHash || 0}${hashSuffix}`),
    name,
    slot,
    classId: "hunter",
    tier: "5",
    exotic: false,
    archetypeId: "Gunner",
    tertiary: "super",
    tuningStat: "melee",
    baseStats,
    masterworkTier: 0,
    owner: "Vault",
    equipped: false,
    power: 500,
    setHash,
  };
}

const zero = { weapons: 0, health: 0, class: 0, grenade: 0, super: 0, melee: 0 };

function buildInventory() {
  const items = [];
  for (const slot of SLOTS) {
    const aStats = { ...zero, weapons: 30, grenade: 20, super: 25 };
    const bStats = { ...zero, weapons: 25, grenade: 20, super: 30 };
    const filler = { ...zero, weapons: 35, grenade: 25, super: 15 };
    items.push(makeItem(`A ${slot}`, slot, SET_A, aStats, 1));
    items.push(makeItem(`B ${slot}`, slot, SET_B, bStats, 1));
    items.push(makeItem(`Filler ${slot}`, slot, null, filler, 1));
    items.push(makeItem(`Filler2 ${slot}`, slot, null, filler, 2));
  }
  return items;
}

const TARGETS = { weapons: 130, health: 0, class: 0, grenade: 90, super: 110, melee: 0 };
const FRAGMENTS = { weapons: 0, health: 0, class: 0, grenade: 0, super: 0, melee: 0 };

test("no requirement searches the whole inventory", () => {
  const result = solveInventoryLoadout({
    items: buildInventory(),
    targets: TARGETS,
    fragments: FRAGMENTS,
    setRequirement: { type: "none" },
  });
  assert.ok(result.results.length > 0);
  for (const entry of result.results) {
    assert.equal(entry.pieces.length, 5);
    assert.deepEqual(entry.pieces.map(piece => piece.slot).sort(), [...SLOTS].sort());
  }
  const shorts = result.results.map(entry => entry.metrics.shortfall);
  assert.deepEqual(shorts, [...shorts].sort((a, b) => a - b));
  assert.equal(result.results[0].metrics.shortfall,
    Math.min(...shorts), "best owned combo should be ranked first");
});

test("owned-armor loadouts never equip more than one Exotic armor piece", () => {
  const items = SLOTS.flatMap((slot, index) => {
    const legendary = makeItem(`Legendary ${slot}`, slot, null, {
      ...zero,
      weapons: 10,
    }, index + 1);
    if (!['helmet', 'arms'].includes(slot)) return [legendary];
    return [
      legendary,
      {
        ...makeItem(`Exotic ${slot}`, slot, null, {
          ...zero,
          weapons: 60,
        }, index + 11),
        exotic: true,
      },
    ];
  });

  const result = solveInventoryLoadout({
    items,
    targets: { ...zero, weapons: 200 },
    fragments: FRAGMENTS,
    setRequirement: { type: "none" },
    reassignModifiers: false,
  });

  assert.ok(result.results.length > 0);
  assert.ok(result.results.every(entry =>
    entry.pieces.filter(piece => piece.exotic).length <= 1
  ));
});

test("large-inventory search keeps legal alternatives when Exotics score highest", () => {
  const items = SLOTS.flatMap((slot, slotIndex) => {
    const legendaries = Array.from({ length: 6 }, (_, itemIndex) =>
      makeItem(`Legendary ${slot} ${itemIndex}`, slot, null, {
        ...zero,
        weapons: 10 + itemIndex,
      }, slotIndex * 10 + itemIndex + 1));
    if (!['helmet', 'arms'].includes(slot)) return legendaries;
    return [
      ...legendaries,
      {
        ...makeItem(`Exotic ${slot}`, slot, null, {
          ...zero,
          weapons: 80,
        }, slotIndex + 91),
        exotic: true,
      },
    ];
  });

  const result = solveInventoryLoadout({
    items,
    targets: { ...zero, weapons: 200 },
    fragments: FRAGMENTS,
    setRequirement: { type: "none" },
    reassignModifiers: false,
  });

  assert.ok(result.results.length > 0);
  assert.ok(result.results.every(entry =>
    entry.pieces.filter(piece => piece.exotic).length <= 1
  ));
});

test("large inventories keep an exact combination that looks bad in an early slot", () => {
  const exactPiece = { weapons: 0, health: 0, class: 0, grenade: 0, super: 0, melee: 0 };
  const supportingPiece = {
    weapons: 15, health: 15, class: 15, grenade: 15, super: 15, melee: 15,
  };
  const temptingDecoy = {
    weapons: 12, health: 12, class: 12, grenade: 12, super: 12, melee: 12,
  };
  const items = [
    ...Array.from({ length: 25 }, (_, index) =>
      makeItem(`Helmet decoy ${index}`, "helmet", SET_A, temptingDecoy, index + 1)),
    makeItem("Exact helmet", "helmet", SET_A, exactPiece, 99),
    ...Array.from({ length: 16 }, (_, index) =>
      makeItem(`Arms ${index}`, "arms", SET_A, supportingPiece, index + 1)),
    ...Array.from({ length: 10 }, (_, index) =>
      makeItem(`Chest ${index}`, "chest", SET_A, supportingPiece, index + 1)),
    makeItem("Legs", "legs", SET_A, supportingPiece, 1),
    makeItem("Class item", "classItem", SET_A, supportingPiece, 1),
  ].map(item => ({
    ...item,
    tuningMode: "shift",
    tuningStat: null,
    tuningTo: null,
    tuningUnknown: true,
    armorModSize: 0,
    armorModStat: "health",
    masterworkTier: 5,
    effectiveBaseStats: { ...item.baseStats },
    optimizationBaseStats: { ...item.baseStats },
  }));
  const targets = Object.fromEntries(Object.keys(zero).map(stat => [stat, 60]));
  const exact = Object.fromEntries(Object.keys(zero).map(stat => [stat, true]));

  const result = solveInventoryLoadout({
    items,
    targets,
    fragments: zero,
    setRequirement: { type: "set", setHash: SET_A, count: 4 },
    reassignModifiers: false,
    userConstraints: { exact },
  });

  assert.equal(result.results[0].metrics.allReached, true);
  assert.equal(
    result.results[0].pieces.find(piece => piece.slot === "helmet").itemName,
    "Exact helmet",
  );
});

test("eight-per-slot seed-5 inventory recovers the known exact target canonically", () => {
  const target = {
    health: 85,
    melee: 90,
    grenade: 70,
    super: 70,
    class: 90,
    weapons: 60,
  };
  const exactConfigs = [
    ["Brawler", "super"],
    ["Brawler", "super"],
    ["Brawler", "super"],
    ["Demolitionist", "weapons"],
    ["Demolitionist", "weapons"],
  ].map(([archetype, tertiary]) => BASE_CONFIGS.find(config =>
    config.archetype === archetype && config.tertiary === tertiary));
  const exactTuning = [
    ["health", "melee"],
    ["melee", "health"],
    ["melee", "class"],
    ["melee", "class"],
    ["grenade", "class"],
  ];
  const exactModStats = ["class", "class", "weapons", "health", "health"];
  let state = 5;
  const random = () => (
    (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296
  );
  const items = [];
  for (let slotIndex = 0; slotIndex < SLOTS.length; slotIndex++) {
    for (let itemIndex = 0; itemIndex < 7; itemIndex++) {
      const config = BASE_CONFIGS[Math.floor(random() * BASE_CONFIGS.length)];
      items.push({
        ...makeItem(`Seed decoy ${slotIndex}-${itemIndex}`, SLOTS[slotIndex], null,
          { ...config.baseStats }, 100 + slotIndex * 10 + itemIndex),
        archetypeId: config.archetype,
        tertiary: config.tertiary,
        tuningMode: "shift",
        tuningFrom: "health",
        tuningTo: "weapons",
        armorModSize: slotIndex < 3 ? 5 : 0,
        armorModStat: "health",
        masterworkTier: 5,
        effectiveBaseStats: { ...config.baseStats },
        optimizationBaseStats: { ...config.baseStats },
      });
    }
    const config = exactConfigs[slotIndex];
    items.push({
      ...makeItem(`Exact ${SLOTS[slotIndex]}`, SLOTS[slotIndex], null,
        { ...config.baseStats }, 999 + slotIndex),
      id: `00-exact-${slotIndex}`,
      archetypeId: config.archetype,
      tertiary: config.tertiary,
      tuningMode: "shift",
      tuningFrom: exactTuning[slotIndex][0],
      tuningTo: exactTuning[slotIndex][1],
      armorModSize: slotIndex < 3 ? 5 : 0,
      armorModStat: exactModStats[slotIndex],
      masterworkTier: 5,
      effectiveBaseStats: { ...config.baseStats },
      optimizationBaseStats: { ...config.baseStats },
    });
  }
  const exact = Object.fromEntries(Object.keys(zero).map(stat => [stat, true]));
  const solve = inputItems => solveInventoryLoadout({
    items: inputItems,
    targets: target,
    fragments: zero,
    setRequirement: { type: "none" },
    reassignModifiers: false,
    userConstraints: { exact },
  });

  const forward = solve(items);
  const reversed = solve([...items].reverse());
  const bySlot = SLOTS.map(slot => items.filter(item => item.slot === slot));
  let exhaustiveBest = null;
  const chosen = Array(SLOTS.length);
  const enumerate = slotIndex => {
    if (slotIndex === SLOTS.length) {
      const pieces = chosen.map((item, index) =>
        createUpgradePieceFromItem(item, index));
      const evaluation = evaluateUpgradePieces(
        pieces, target, zero, false, [], false, { exact },
      );
      if (!exhaustiveBest ||
          compareUpgradeMetrics(evaluation.metrics, exhaustiveBest.metrics) < 0) {
        exhaustiveBest = evaluation;
      }
      return;
    }
    for (const item of bySlot[slotIndex]) {
      chosen[slotIndex] = item;
      enumerate(slotIndex + 1);
    }
  };
  enumerate(0);
  assert.equal(forward.results[0].metrics.allReached, true);
  assert.deepEqual(forward.results[0].finalTotals, target);
  assert.equal(
    compareUpgradeMetrics(forward.results[0].metrics, exhaustiveBest.metrics),
    0,
    "the 8^5 frontier must match the independent exhaustive optimum",
  );
  assert.deepEqual(
    forward.results[0].pieces.map(piece => piece.sourceId),
    reversed.results[0].pieces.map(piece => piece.sourceId),
    "inventory input order must not change the canonical exact witness",
  );
});

test("4-piece requirement allows other armor while requiring at least four set pieces", () => {
  const result = solveInventoryLoadout({
    items: buildInventory(),
    targets: TARGETS,
    fragments: FRAGMENTS,
    setRequirement: { type: "set", setHash: SET_A, count: 4 },
  });
  assert.ok(result.results.length > 0);
  for (const entry of result.results) {
    assert.equal(entry.pieces.length, 5);
    assert.ok(entry.pieces.filter(piece => piece.setHash === SET_A).length >= 4);
    assert.deepEqual(entry.pieces.map(piece => piece.slot).sort(), [...SLOTS].sort());
  }
  const shorts = result.results.map(entry => entry.metrics.shortfall);
  assert.deepEqual(shorts, [...shorts].sort((a, b) => a - b));
});

test("2+2 split requirement produces loadouts with two pieces of each set", () => {
  const result = solveInventoryLoadout({
    items: buildInventory(),
    targets: TARGETS,
    fragments: FRAGMENTS,
    setRequirement: { type: "split", a: SET_A, b: SET_B },
  });
  assert.ok(result.results.length > 0);
  for (const entry of result.results) {
    assert.ok(entry.pieces.filter(piece => piece.setHash === SET_A).length >= 2);
    assert.ok(entry.pieces.filter(piece => piece.setHash === SET_B).length >= 2);
  }
});

test("current loadout is offered when it already satisfies the requirement", () => {
  const items = buildInventory();
  const currentItems = [
    items.find(item => item.slot === "helmet" && item.setHash === SET_A),
    items.find(item => item.slot === "arms" && item.setHash === SET_A),
    items.find(item => item.slot === "chest" && item.setHash === SET_A),
    items.find(item => item.slot === "legs" && item.setHash === SET_A),
    items.find(item => item.slot === "classItem" && item.setHash === null),
  ];
  const currentPieces = currentItems.map((item, index) => createUpgradePieceFromItem(item, index));
  const result = solveInventoryLoadout({
    items,
    targets: TARGETS,
    fragments: FRAGMENTS,
    setRequirement: { type: "set", setHash: SET_A, count: 4 },
    currentPieces,
  });
  assert.ok(result.results.some(entry => entry.isCurrent));
});

test("current loadout is excluded when it has only three of four required set pieces", () => {
  const items = buildInventory();
  const exoticClassItem = {
    ...makeItem("Fixed Exotic class item", "classItem", null, {
      ...zero,
      health: 30,
      class: 25,
      melee: 20,
    }, 9),
    exotic: true,
  };
  items.push(exoticClassItem);
  const currentItems = [
    items.find(item => item.slot === "helmet" && item.setHash === SET_B),
    items.find(item => item.slot === "arms" && item.setHash === SET_A),
    items.find(item => item.slot === "chest" && item.setHash === SET_A),
    items.find(item => item.slot === "legs" && item.setHash === SET_A),
    exoticClassItem,
  ];
  const currentPieces = currentItems.map((item, index) =>
    createUpgradePieceFromItem(item, index));

  const result = solveInventoryLoadout({
    items,
    targets: TARGETS,
    fragments: FRAGMENTS,
    setRequirement: { type: "set", setHash: SET_A, count: 4 },
    currentPieces,
  });

  assert.ok(result.results.length > 0);
  assert.equal(result.results.some(entry => entry.isCurrent), false);
  for (const entry of result.results) {
    assert.ok(entry.pieces.filter(piece => piece.setHash === SET_A).length >= 4);
  }
});

test("inventory loadouts preserve a locked Exotic from the current loadout", () => {
  const items = buildInventory();
  const exoticHelmet = {
    ...makeItem("Locked Exotic helmet", "helmet", null, {
      ...zero,
      health: 30,
      class: 25,
      melee: 20,
    }, 9),
    exotic: true,
  };
  items.push(exoticHelmet);
  const currentItems = [
    exoticHelmet,
    items.find(item => item.slot === "arms" && item.setHash === SET_A),
    items.find(item => item.slot === "chest" && item.setHash === SET_A),
    items.find(item => item.slot === "legs" && item.setHash === SET_A),
    items.find(item => item.slot === "classItem" && item.setHash === SET_A),
  ];
  const currentPieces = currentItems.map((item, index) => createUpgradePieceFromItem(item, index));

  const result = solveInventoryLoadout({
    items,
    targets: TARGETS,
    fragments: FRAGMENTS,
    setRequirement: { type: "set", setHash: SET_A, count: 4 },
    currentPieces,
  });

  assert.ok(result.results.length > 0);
  for (const entry of result.results) {
    const helmet = entry.pieces.find(piece => piece.slot === "helmet");
    assert.equal(helmet.hash, exoticHelmet.hash);
    assert.equal(helmet.exotic, true);
    assert.equal(helmet.locked, true);
  }
});

test("impossible requirement yields no results", () => {
  const items = buildInventory().filter(item =>
    item.setHash === SET_B || item.slot === "helmet"
  );
  const result = solveInventoryLoadout({
    items,
    targets: TARGETS,
    fragments: FRAGMENTS,
    setRequirement: { type: "set", setHash: SET_A, count: 4 },
  });
  assert.equal(result.results.length, 0);
});

test("same-hash DIM instances remain distinct optimization candidates", () => {
  const items = buildInventory();
  const weak = items.find(item => item.slot === "arms" && item.setHash === SET_A);
  const strong = {
    ...weak,
    id: "strong-arms-instance",
    name: "Strong arms instance",
    baseStats: { ...zero, weapons: 60, grenade: 10, super: 5 },
  };
  items.splice(items.indexOf(weak) + 1, 0, strong);

  const result = solveInventoryLoadout({
    items,
    targets: { ...TARGETS, weapons: 220 },
    fragments: FRAGMENTS,
    setRequirement: { type: "set", setHash: SET_A, count: 4 },
    reassignModifiers: false,
  });

  assert.ok(result.results.length > 0);
  assert.ok(result.results.some(entry =>
    entry.pieces.find(piece => piece.slot === "arms")?.sourceId === strong.id
  ));
});

test("required stat targets outrank owned loadouts with a smaller total gap", () => {
  const items = [];
  for (const slot of SLOTS) {
    items.push({
      ...makeItem(`Weapons ${slot}`, slot, null, {
        ...zero,
        weapons: 36,
      }, 1),
      tuningMode: "shift",
      tuningFrom: "health",
      tuningTo: "melee",
      armorModSize: 0,
      armorModStat: "health",
    });
    items.push({
      ...makeItem(`Balanced ${slot}`, slot, null, {
        ...zero,
        weapons: 34,
        grenade: 40,
      }, 2),
      tuningMode: "shift",
      tuningFrom: "health",
      tuningTo: "melee",
      armorModSize: 0,
      armorModStat: "health",
    });
  }

  const result = solveInventoryLoadout({
    items,
    targets: { ...zero, weapons: 180, grenade: 200 },
    fragments: FRAGMENTS,
    setRequirement: { type: "none" },
    requiredStats: ["weapons"],
    reassignModifiers: false,
  });

  assert.ok(result.results.length > 0);
  assert.equal(result.results[0].metrics.requiredAllReached, true);
  assert.ok(result.results[0].finalTotals.weapons >= 180);
});

test("only +5/-5 reconfigures owned +3 pieces in inventory loadouts", () => {
  const items = SLOTS.map((slot, index) => ({
    ...makeItem(`Plus3 ${slot}`, slot, null, {
      ...zero,
      weapons: 30,
      grenade: 25,
      super: 20,
    }, index + 1),
    tuningMode: "plus3",
    tuningFrom: null,
    tuningTo: null,
    armorModSize: 0,
    armorModStat: "health",
  }));

  const unrestricted = solveInventoryLoadout({
    items,
    targets: zero,
    fragments: zero,
    setRequirement: { type: "none" },
  });
  assert.ok(unrestricted.results.length > 0, "fixture: +3-only inventory is usable normally");

  const restricted = solveInventoryLoadout({
    items,
    targets: zero,
    fragments: zero,
    setRequirement: { type: "none" },
    onlyPlus5Tuning: true,
  });
  assert.ok(restricted.results.length > 0,
    "owned armor remains usable after changing its installed tuning mod");
  assert.ok(restricted.results.every(entry =>
    entry.tuningAssignments.every(assignment => assignment?.mode !== "+3")
  ), "every configured owned loadout must obey the +5/-5-only constraint");
});
