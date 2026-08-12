import assert from "node:assert/strict";
import test from "node:test";
import { solveInventoryLoadout } from "../src/core/inventory-solver.mjs";
import { createUpgradePieceFromItem } from "../src/core/upgrade-optimizer.mjs";

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

test("large-inventory beam search keeps legal alternatives when Exotics score highest", () => {
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
