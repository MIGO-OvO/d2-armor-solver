import assert from "node:assert/strict";
import test from "node:test";

import { assignArmorMods } from "../src/core/armor-mod-assignment.mjs";
import {
  BALANCED_TUNING_MOD_HASH,
  STAT_MOD_HASHES,
  TUNING_MOD_HASH_BY_TUNING,
} from "../src/core/armor-mods.data.mjs";
import { CANDIDATE_STATE, SOCKET_ROLE } from "../src/core/armor-sockets.mjs";
import { EXECUTION_STATUS } from "../src/core/solver-v3-contract.mjs";

const SLOTS = ["helmet", "arms", "chest", "legs", "classItem"];

const tuningHash = (to, from) => Number(TUNING_MOD_HASH_BY_TUNING[`${to}:${from}`]);
const statHash = (stat, size) => Number(STAT_MOD_HASHES[stat][size]);
const ALL_STAT_HASHES = Object.values(STAT_MOD_HASHES).flatMap(sizes => Object.values(sizes).map(Number));

// Build a normalized inventory item (the bungie-inventory.mjs output shape).
function makeItem({
  index = 0,
  slot = SLOTS[index % 5],
  capacity = 10,
  used = 0,
  currentStat = null,      // [stat, size] or null
  currentTuning = null,    // [to, from] or null
  fixedTuningStat = null,
  allowedTuningStats = null,
  tuningConfidence = "unknown",
  candidateState = CANDIDATE_STATE.KNOWN,
  baseStats = { health: 10, melee: 10, grenade: 10, super: 10, class: 10, weapons: 10 },
  exotic = false,
  masterworkTier = 10,
} = {}) {
  const tuningAllowed = allowedTuningStats ?? (fixedTuningStat ? [fixedTuningStat] : null);
  const tuningConf = (fixedTuningStat || Array.isArray(allowedTuningStats))
    ? "exact"
    : tuningConfidence;
  const tuningCandidates = new Set([BALANCED_TUNING_MOD_HASH]);
  if (fixedTuningStat) {
    for (const stat of ["health", "melee", "grenade", "super", "class", "weapons"]) {
      if (stat !== fixedTuningStat) tuningCandidates.add(tuningHash(fixedTuningStat, stat));
    }
  } else if (Array.isArray(allowedTuningStats)) {
    for (const to of allowedTuningStats) {
      for (const from of ["health", "melee", "grenade", "super", "class", "weapons"]) {
        if (from !== to) tuningCandidates.add(tuningHash(to, from));
      }
    }
  } else if (tuningConf === "unknown") {
    tuningCandidates.clear(); // no reusable-plug data
  }
  const statCandidates = new Set([...ALL_STAT_HASHES]);
  const currentStatHash = currentStat ? statHash(currentStat[0], currentStat[1]) : 0;
  const currentTuningHash = currentTuning ? tuningHash(currentTuning[0], currentTuning[1]) : 0;
  const statSocket = {
    socketIndex: 0,
    role: SOCKET_ROLE.STAT,
    currentPlugHash: currentStatHash,
    enabled: true,
    visible: true,
    candidatePlugHashes: statCandidates,
    candidateState,
    emptyPlugHash: 4256667756, // the "empty mod socket" placeholder hash
  };
  const tuningSocket = {
    socketIndex: 1,
    role: SOCKET_ROLE.TUNING,
    currentPlugHash: currentTuningHash,
    enabled: true,
    visible: true,
    candidatePlugHashes: tuningCandidates,
    candidateState,
    emptyPlugHash: null,
  };
  return {
    id: String(100 + index),
    hash: 1000 + index,
    slot,
    classId: "hunter",
    exotic,
    archetypeId: "Powerhouse", // weapons/super frame
    tertiary: "grenade",
    baseStats,
    masterworkTier,
    energy: { capacity, used },
    sockets: [statSocket, tuningSocket],
    fixedTuningStat,
    allowedTuningStats: tuningAllowed,
    dataConfidence: {
      stats: "exact",
      framework: "exact",
      tuning: tuningConf,
      sockets: candidateState === CANDIDATE_STATE.KNOWN ? "exact" : "partial",
    },
    armorModSize: currentStat ? currentStat[1] : 0,
    armorModStat: currentStat ? currentStat[0] : null,
    tuningMode: currentTuning ? "shift" : null,
    tuningFrom: currentTuning ? currentTuning[1] : null,
    tuningTo: currentTuning ? currentTuning[0] : null,
  };
}

function makePieces(count = 5) {
  return Array.from({ length: count }, (_, index) => ({
    slot: SLOTS[index % 5],
    sourceId: String(100 + index),
    hash: 1000 + index,
  }));
}

function defaultItems() {
  return Array.from({ length: 5 }, (_, index) =>
    makeItem({ index, fixedTuningStat: "health" }));
}

test("five +10 stat mods all fit and produce one write per piece", () => {
  const items = defaultItems();
  const modAssignments = SLOTS.map(() => ({ size: 10, stat: "weapons" }));
  const tuningAssignments = SLOTS.map(() => ({ mode: "+5-5", to: "health", from: "weapons" }));
  const result = assignArmorMods({ pieces: makePieces(), inventory: items, tuningAssignments, modAssignments });
  assert.equal(result.valid, true, JSON.stringify(result.unassignedMods));
  assert.equal(result.plugOperations.length, 10);
  assert.ok(result.plugOperations.every(op => op.plugItemHash > 0));
  assert.equal(result.executionStatus, EXECUTION_STATUS.VERIFIED);
  assert.deepEqual(result.unverifiedMods, []);
});

test("+10 to +5 swap releases energy and is a single direct write", () => {
  const items = defaultItems().map(item => ({
    ...item,
    energy: { ...item.energy, used: 10 },
    armorModSize: 10,
    armorModStat: "weapons",
  }));
  const modAssignments = SLOTS.map(() => ({ size: 5, stat: "health" }));
  const tuningAssignments = SLOTS.map(() => ({ mode: "+5-5", to: "health", from: "weapons" }));
  const result = assignArmorMods({ pieces: makePieces(), inventory: items, tuningAssignments, modAssignments });
  assert.equal(result.valid, true, JSON.stringify(result.unassignedMods));
  // used 10 - old cost 3 + new cost 1 = 8 <= capacity 10.
  const statOps = result.plugOperations.filter(op => op.kind === "stat");
  assert.equal(statOps.length, 5);
  assert.ok(statOps.every(op => op.previousPlugHash === statHash("weapons", 10)));
});

test("insufficient energy is a blocking unassigned, never a skipped success", () => {
  const items = defaultItems().map((item, index) => index === 2
    ? { ...item, energy: { ...item.energy, capacity: 2, used: 0 } }
    : item);
  const modAssignments = SLOTS.map(() => ({ size: 10, stat: "weapons" }));
  const tuningAssignments = SLOTS.map(() => ({ mode: "+5-5", to: "health", from: "weapons" }));
  const result = assignArmorMods({ pieces: makePieces(), inventory: items, tuningAssignments, modAssignments });
  assert.equal(result.valid, false);
  const energyMiss = result.unassignedMods.find(item => item.reason === "energy");
  assert.ok(energyMiss, "the +10 mod on the capacity-2 piece must be unassigned with reason energy");
  assert.equal(energyMiss.index, 2);
  assert.equal(energyMiss.slot, "chest");
  // The other four pieces still resolve; only the energy-infeasible one blocks.
  assert.equal(result.unassignedMods.length, 1);
  assert.equal(result.executionStatus, EXECUTION_STATUS.BLOCKED);
});

test("tuning only enters the legendary armor whose fixed stat matches", () => {
  const items = defaultItems();
  const tuningAssignments = SLOTS.map(() => ({ mode: "+5-5", to: "health", from: "weapons" }));
  const modAssignments = SLOTS.map(() => null);
  const ok = assignArmorMods({ pieces: makePieces(), inventory: items, tuningAssignments, modAssignments });
  assert.equal(ok.valid, true, JSON.stringify(ok.unassignedMods));

  const wrong = assignArmorMods({
    pieces: makePieces(),
    inventory: items,
    tuningAssignments: SLOTS.map(() => ({ mode: "+5-5", to: "grenade", from: "weapons" })),
    modAssignments,
  });
  assert.equal(wrong.valid, false);
  assert.ok(wrong.unassignedMods.every(item => item.reason === "tuningMismatch"));
  assert.equal(wrong.unassignedMods.length, 5);
});

test("exotic accepts any tuning direction; legendary still rejects mismatches", () => {
  const items = defaultItems().map((item, index) => index === 4
    ? makeItem({ index, exotic: true, allowedTuningStats: ["health", "melee", "grenade", "super", "class", "weapons"] })
    : item);
  const tuningAssignments = SLOTS.map(() => ({ mode: "+5-5", to: "grenade", from: "weapons" }));
  const modAssignments = SLOTS.map(() => null);
  const result = assignArmorMods({ pieces: makePieces(), inventory: items, tuningAssignments, modAssignments });
  assert.equal(result.valid, false);
  // Four legendaries reject grenade tuning; the exotic accepts it.
  assert.equal(result.unassignedMods.filter(item => item.reason === "tuningMismatch").length, 4);
});

test("8.133.0 regression: tuning stays assigned to the armor that owns the fixed stat", () => {
  // Two pieces with DIFFERENT fixed tuning stats; each must receive its own
  // direction, and the operations must carry the exact socket of that piece.
  const items = [
    makeItem({ index: 0, fixedTuningStat: "health" }),
    makeItem({ index: 1, fixedTuningStat: "weapons" }),
    makeItem({ index: 2, fixedTuningStat: "health" }),
    makeItem({ index: 3, fixedTuningStat: "weapons" }),
    makeItem({ index: 4, fixedTuningStat: "health" }),
  ];
  const tuningAssignments = SLOTS.map((_, index) => ({
    mode: "+5-5",
    to: index % 2 === 0 ? "health" : "weapons",
    from: "super",
  }));
  const modAssignments = SLOTS.map(() => null);
  const result = assignArmorMods({ pieces: makePieces(), inventory: items, tuningAssignments, modAssignments });
  assert.equal(result.valid, true, JSON.stringify(result.unassignedMods));
  for (const op of result.plugOperations) {
    const pieceIndex = op.itemId - 100;
    const expected = tuningHash(pieceIndex % 2 === 0 ? "health" : "weapons", "super");
    assert.equal(op.plugItemHash, expected, `piece ${pieceIndex} must get its own tuning mod`);
    assert.equal(op.socketIndex, 1, "tuning writes must use the tuning socket, never socket 0");
  }
});

test("known socket candidates reject a plug that does not fit the socket", () => {
  const items = defaultItems().map((item, index) => {
    if (index !== 0) return item;
    const statSocket = {
      ...item.sockets[0],
      candidatePlugHashes: new Set([statHash("weapons", 5), statHash("weapons", 10)]),
      candidateState: CANDIDATE_STATE.KNOWN,
    };
    return { ...item, sockets: [statSocket, item.sockets[1]] };
  });
  const modAssignments = SLOTS.map(() => ({ size: 10, stat: "health" })); // health mod not in socket candidates
  const tuningAssignments = SLOTS.map(() => ({ mode: "+5-5", to: "health", from: "weapons" }));
  const result = assignArmorMods({ pieces: makePieces(), inventory: items, tuningAssignments, modAssignments });
  assert.equal(result.valid, false);
  assert.ok(result.unassignedMods.some(item => item.index === 0 && item.reason === "plugUnavailable"));
});

test("unknown candidates never reject: the plan stays valid and writes proceed", () => {
  const items = defaultItems().map((item, index) => index === 0
    ? {
      ...item,
      sockets: [{
        socketIndex: 0, role: SOCKET_ROLE.STAT, currentPlugHash: 0, enabled: true, visible: true,
        candidatePlugHashes: new Set(), candidateState: CANDIDATE_STATE.UNKNOWN, emptyPlugHash: null,
      }, {
        socketIndex: 1, role: SOCKET_ROLE.TUNING, currentPlugHash: 0, enabled: true, visible: true,
        candidatePlugHashes: new Set(), candidateState: CANDIDATE_STATE.UNKNOWN, emptyPlugHash: null,
      }],
      dataConfidence: { stats: "exact", framework: "exact", tuning: "unknown", sockets: "partial" },
      fixedTuningStat: null,
      allowedTuningStats: null,
    }
    : item);
  const modAssignments = SLOTS.map(() => ({ size: 10, stat: "weapons" }));
  const tuningAssignments = SLOTS.map(() => ({ mode: "+5-5", to: "health", from: "weapons" }));
  const result = assignArmorMods({ pieces: makePieces(), inventory: items, tuningAssignments, modAssignments });
  assert.equal(result.valid, true, JSON.stringify(result.unassignedMods));
  assert.equal(result.plugOperations.length, 10);
  assert.equal(result.executionStatus, EXECUTION_STATUS.UNVERIFIED);
  assert.ok(result.unverifiedMods.some(item =>
    item.reason === "candidateAvailabilityUnknown"));
});

test("a known plug set rejects plugs absent from it (known empty blocks)", () => {
  const items = defaultItems();
  const modAssignments = SLOTS.map(() => ({ size: 10, stat: "weapons" }));
  const tuningAssignments = SLOTS.map(() => ({ mode: "+5-5", to: "health", from: "weapons" }));
  const result = assignArmorMods({
    pieces: makePieces(),
    inventory: items,
    tuningAssignments,
    modAssignments,
    // Only the +5 weapons mod and the health tuning are unlocked.
    availablePlugHashes: new Set([
      statHash("weapons", 5),
      tuningHash("health", "weapons"),
    ]),
  });
  assert.equal(result.valid, false);
  assert.equal(
    result.unassignedMods.filter(item => item.kind === "stat" && item.reason === "plugUnavailable").length,
    5,
    "the +10 stat mods are not in the known unlock set and must block",
  );
  assert.equal(
    result.unassignedMods.filter(item => item.reason === "plugUnavailable" && item.kind === "tuning").length,
    0,
    "the unlocked health tuning must pass",
  );
});

test("clearing an installed stat mod emits the socket's empty plug write", () => {
  const items = defaultItems().map((item, index) => index === 0
    ? { ...item, armorModSize: 10, armorModStat: "weapons", energy: { ...item.energy, used: 3 } }
    : item);
  const modAssignments = SLOTS.map(() => null); // no stat mod wanted anywhere
  const tuningAssignments = SLOTS.map(() => ({ mode: "+5-5", to: "health", from: "weapons" }));
  const result = assignArmorMods({ pieces: makePieces(), inventory: items, tuningAssignments, modAssignments });
  assert.equal(result.valid, true, JSON.stringify(result.unassignedMods));
  const clearOp = result.plugOperations.find(op => op.kind === "stat" && op.plugItemHash === 4256667756);
  assert.ok(clearOp, "the installed +10 must be cleared with the socket's empty plug");
  assert.equal(clearOp.previousPlugHash, statHash("weapons", 10));
  assert.equal(clearOp.itemId, "100");
});

test("no socket of a role means the write is blocked, not guessed at socket 0", () => {
  const items = defaultItems().map((item, index) => index === 0
    ? {
      ...item,
      sockets: [item.sockets[1]], // only the tuning socket survives
      statSocketIndex: null,
    }
    : item);
  const modAssignments = SLOTS.map(() => ({ size: 10, stat: "weapons" }));
  const tuningAssignments = SLOTS.map(() => ({ mode: "+5-5", to: "health", from: "weapons" }));
  const result = assignArmorMods({ pieces: makePieces(), inventory: items, tuningAssignments, modAssignments });
  assert.equal(result.valid, false);
  assert.ok(result.unassignedMods.some(item => item.index === 0 && item.reason === "statSocketUnknown"));
});

test("actualTotals use the piece's real masterwork; projectedTotals assume full masterwork", () => {
  const items = Array.from({ length: 5 }, (_, index) =>
    makeItem({
      index,
      fixedTuningStat: "health",
      masterworkTier: 0,
      baseStats: { health: 10, melee: 10, grenade: 10, super: 10, class: 10, weapons: 10 },
    }));
  const modAssignments = SLOTS.map(() => ({ size: 10, stat: "weapons" }));
  const tuningAssignments = SLOTS.map(() => ({ mode: "+5-5", to: "health", from: "weapons" }));
  const result = assignArmorMods({ pieces: makePieces(), inventory: items, tuningAssignments, modAssignments });
  assert.equal(result.valid, true);
  // Powerhouse frame = weapons/super primary pair + grenade tertiary, so
  // health/melee/class are the masterwork stats (+1 per tier, capped +5).
  // At tier 0: no masterwork bonus. With tuning health:+5 from weapons and a
  // weapons +10 mod: health = 10+5, weapons = 10-5+10, others unchanged.
  assert.equal(result.actualTotals.health, 75, "5 pieces x (10 base + 5 tuning)");
  assert.equal(result.actualTotals.weapons, 75, "5 pieces x (10 - 5 tuning + 10 mod)");
  assert.equal(result.actualTotals.melee, 50);
  // Full-masterwork projection adds +5 to the three non-framework stats
  // (health/melee/class for the Powerhouse frame): health 10+5+5 = 20.
  assert.equal(result.projectedTotals.health, 100);
  assert.equal(result.projectedTotals.melee, 75);
});

test("projection separates full-masterwork pieces from actual ones", () => {
  const items = Array.from({ length: 5 }, (_, index) =>
    makeItem({
      index,
      fixedTuningStat: "health",
      masterworkTier: 5,
      baseStats: { health: 10, melee: 10, grenade: 10, super: 10, class: 10, weapons: 10 },
    }));
  const modAssignments = SLOTS.map(() => null);
  const tuningAssignments = SLOTS.map(() => ({ mode: "+5-5", to: "health", from: "weapons" }));
  const result = assignArmorMods({ pieces: makePieces(), inventory: items, tuningAssignments, modAssignments });
  // Tier 5: +5 to the three non-framework stats (health/melee/class for the
  // Powerhouse frame). health = 10 base + 5 tuning + 5 mw = 20/piece;
  // melee = 10 + 5 mw = 15/piece.
  assert.equal(result.actualTotals.health, 100);
  assert.equal(result.actualTotals.melee, 75);
  // Projection at masterwork 5 equals actual here (already full).
  assert.deepEqual(result.actualTotals, result.projectedTotals);
});

test("balanced tuning (+3) is accepted by every piece regardless of fixed stat", () => {
  const items = defaultItems();
  const tuningAssignments = SLOTS.map(() => ({ mode: "+3", from: null, to: null }));
  const modAssignments = SLOTS.map(() => null);
  const result = assignArmorMods({ pieces: makePieces(), inventory: items, tuningAssignments, modAssignments });
  assert.equal(result.valid, true, JSON.stringify(result.unassignedMods));
  assert.ok(result.plugOperations.every(op => op.plugItemHash === BALANCED_TUNING_MOD_HASH));
});
