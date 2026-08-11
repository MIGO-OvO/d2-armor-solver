import assert from "node:assert/strict";
import test from "node:test";

import { saveToken } from "../src/core/bungie-api.mjs";
import {
  BungieLoadoutApplyError,
  applyCustomLoadoutPlan,
  buildCustomLoadoutPlan,
  decodeArmorPlugHashes,
  equipSavedLoadout,
  extractBungieLoadoutState,
  getFragmentAdjustments,
  mapSavedLoadoutArmor,
} from "../src/core/bungie-loadout.mjs";
import {
  BALANCED_TUNING_MOD_HASH,
  STAT_MOD_HASHES,
  TUNING_MOD_HASH_BY_TUNING,
} from "../src/core/armor-mods.data.mjs";

globalThis.__BUNGIE_API_KEY__ = "test-api-key";
globalThis.__BUNGIE_OAUTH_CLIENT_ID__ = "test-client";
globalThis.__BUNGIE_OAUTH_CLIENT_SECRET__ = "test-secret";

const ORIG_FETCH = globalThis.fetch;
const ORIG_LOCAL_STORAGE = globalThis.localStorage;

function installAuth() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
  };
  saveToken({
    accessToken: "live-access",
    refreshToken: "refresh",
    expiresIn: 3600,
    obtainedAt: Date.now(),
  });
}

function restoreGlobals() {
  globalThis.fetch = ORIG_FETCH;
  if (ORIG_LOCAL_STORAGE === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = ORIG_LOCAL_STORAGE;
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

test("extractBungieLoadoutState maps characters, saved loadouts, subclass plugs, and unlocks", () => {
  const characterId = "2305843000000000001";
  const subclassId = "1000000000000000100";
  const fragmentHash = 1727069366;
  const profile = {
    characters: { data: { [characterId]: { classType: 1, light: 2020, dateLastPlayed: "2026-08-11T00:00:00Z" } } },
    characterEquipment: { data: { [characterId]: { items: [{
      itemHash: 1234,
      itemInstanceId: subclassId,
      bucketHash: 3284755031,
    }] } } },
    characterLoadouts: { data: { [characterId]: { loadouts: [{
      nameHash: 10,
      colorHash: 20,
      iconHash: 30,
      items: [{ itemInstanceId: "armor-1", plugItemHashes: [4183296050] }],
    }, { items: [] }] } } },
    itemComponents: { sockets: { data: { [subclassId]: { sockets: [
      { plugHash: fragmentHash, isEnabled: true },
      { plugHash: 0, isEnabled: false },
    ] } } } },
    profilePlugSets: { data: { plugs: { 1: [{ plugItemHash: 111, canInsert: true, enabled: true }] } } },
    characterPlugSets: { data: { [characterId]: { plugs: {
      2: [{ plugItemHash: 222, canInsert: true, enabled: true }],
      3: [{ plugItemHash: 333, canInsert: false, enabled: true }],
    } } } },
  };
  const state = extractBungieLoadoutState(profile);
  assert.equal(state.characters[characterId].classId, "hunter");
  assert.equal(state.savedLoadouts[characterId].length, 1);
  assert.equal(state.savedLoadouts[characterId][0].loadoutIndex, 0);
  assert.deepEqual(state.currentSubclassByCharacter[characterId].adjustments, { melee: 10 });
  assert.deepEqual(
    [...state.availablePlugHashesByCharacter[characterId]].sort((a, b) => a - b),
    [111, 222],
  );
});

test("armor and fragment plug hashes decode without inference", () => {
  const tuningHash = TUNING_MOD_HASH_BY_TUNING["health:weapons"];
  assert.deepEqual(decodeArmorPlugHashes([
    STAT_MOD_HASHES.health[10],
    tuningHash,
  ]), {
    armorModSize: 10,
    armorModStat: "health",
    armorModHash: STAT_MOD_HASHES.health[10],
    tuningMode: "shift",
    tuningFrom: "weapons",
    tuningTo: "health",
    tuningHash,
  });
  assert.deepEqual(getFragmentAdjustments([2272984656], "hunter"), {
    weapons: 10,
    super: 10,
  });
  assert.deepEqual(mapSavedLoadoutArmor({ items: [{
    itemInstanceId: "1",
    plugItemHashes: [BALANCED_TUNING_MOD_HASH],
  }] }, [{ id: "1", slot: "helmet" }]), [{
    id: "1",
    slot: "helmet",
    armorModSize: 0,
    armorModStat: null,
    armorModHash: 0,
    tuningMode: "plus3",
    tuningFrom: null,
    tuningTo: null,
    tuningHash: BALANCED_TUNING_MOD_HASH,
  }]);
});

function customPlanFixture({ energyCapacity = 10, energyUsed = 3 } = {}) {
  const slots = ["helmet", "arms", "chest", "legs", "classItem"];
  const currentStat = STAT_MOD_HASHES.weapons[10];
  const currentTuning = TUNING_MOD_HASH_BY_TUNING["weapons:health"];
  const pieces = slots.map((slot, index) => ({
    slot,
    sourceId: String(100 + index),
    hash: 1000 + index,
    exotic: false,
  }));
  const inventory = slots.map((slot, index) => ({
    id: String(100 + index),
    hash: 1000 + index,
    slot,
    classId: "hunter",
    owner: "Vault",
    equipped: false,
    energy: { capacity: energyCapacity, used: energyUsed },
    socketPlugs: [
      { socketIndex: 0, plugHash: currentStat, enabled: true },
      { socketIndex: 11, plugHash: currentTuning, enabled: true },
    ],
  }));
  const tuningAssignments = slots.map(() => ({ mode: "+5-5", to: "health", from: "weapons" }));
  const modAssignments = slots.map(() => ({ size: 10, stat: "health" }));
  const availablePlugHashes = new Set([
    STAT_MOD_HASHES.health[10],
    TUNING_MOD_HASH_BY_TUNING["health:weapons"],
  ]);
  return { pieces, inventory, tuningAssignments, modAssignments, availablePlugHashes };
}

test("buildCustomLoadoutPlan creates vault transfers, one bulk equip, and exact socket writes", () => {
  const fixture = customPlanFixture();
  const plan = buildCustomLoadoutPlan({
    membershipType: 3,
    targetCharacterId: "character-1",
    classId: "hunter",
    ...fixture,
  });
  assert.equal(plan.valid, true, JSON.stringify(plan.errors));
  assert.equal(plan.transfers.length, 5);
  assert.equal(plan.equipItemIds.length, 5);
  assert.equal(plan.plugOperations.length, 10);
  assert.deepEqual(new Set(plan.plugOperations.map(operation => operation.socketIndex)), new Set([0, 11]));
});

test("preflight skips only energy-incompatible stat mods and blocks mismatched Exotic rolls", () => {
  const fixture = customPlanFixture({ energyCapacity: 2, energyUsed: 0 });
  fixture.pieces[4] = {
    ...fixture.pieces[4],
    exotic: true,
    primaryPerkId: "wanted",
  };
  fixture.inventory[4] = {
    ...fixture.inventory[4],
    primaryPerkId: "actual",
  };
  const plan = buildCustomLoadoutPlan({
    membershipType: 3,
    targetCharacterId: "character-1",
    classId: "hunter",
    ...fixture,
  });
  assert.equal(plan.valid, false);
  assert.ok(plan.errors.some(error => error.code === "exoticPerkMismatch"));
  assert.equal(plan.skippedMods.length, 5);
  assert.equal(plan.plugOperations.filter(operation => operation.kind === "tuning").length, 5);
});

test("preflight rejects an armor instance Bungie marks as not equippable", () => {
  const fixture = customPlanFixture();
  fixture.inventory[2] = {
    ...fixture.inventory[2],
    canEquip: false,
    cannotEquipReason: 4,
  };
  const plan = buildCustomLoadoutPlan({
    membershipType: 3,
    targetCharacterId: "character-1",
    classId: "hunter",
    ...fixture,
  });
  assert.equal(plan.valid, false);
  assert.deepEqual(
    plan.errors.find(error => error.code === "itemCannotEquip"),
    { code: "itemCannotEquip", index: 2, slot: "chest", reason: 4 },
  );
});

test("preflight blocks plug changes when Bungie returns no unlocked armor plugs", () => {
  const fixture = customPlanFixture();
  fixture.availablePlugHashes = new Set();
  const plan = buildCustomLoadoutPlan({
    membershipType: 3,
    targetCharacterId: "character-1",
    classId: "hunter",
    ...fixture,
  });
  assert.equal(plan.valid, false);
  assert.equal(plan.errors.filter(error => error.code === "plugUnavailable").length, 10);
});

test("applyCustomLoadoutPlan POSTs the manual sequence with JSON bodies", async () => {
  installAuth();
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return jsonResponse({ Response: [], ErrorCode: 1, ErrorStatus: "Ok" });
  };
  try {
    const plan = buildCustomLoadoutPlan({
      membershipType: 3,
      targetCharacterId: "character-1",
      classId: "hunter",
      ...customPlanFixture(),
    });
    const result = await applyCustomLoadoutPlan(plan);
    assert.equal(result.completed.transfers, 5);
    assert.equal(result.completed.targetEquip, 1);
    assert.equal(result.completed.plugs, 10);
    assert.equal(requests.length, 16);
    assert.ok(requests.every(request => request.options.method === "POST"));
    assert.equal(requests.filter(request => request.url.endsWith("/TransferItem/")).length, 5);
    assert.equal(requests.filter(request => request.url.endsWith("/EquipItems/")).length, 1);
    assert.equal(requests.filter(request => request.url.endsWith("/InsertSocketPlugFree/")).length, 10);
    assert.equal(requests[0].options.headers["Content-Type"], "application/json");
  } finally {
    restoreGlobals();
  }
});

test("manual sequence reports the failed stage and partial completion", async () => {
  installAuth();
  globalThis.fetch = async (url) => {
    if (url.endsWith("/InsertSocketPlugFree/")) {
      return jsonResponse({ ErrorCode: 1675, ErrorStatus: "DestinyCannotAffordMaterialRequirements" });
    }
    return jsonResponse({ Response: [], ErrorCode: 1, ErrorStatus: "Ok" });
  };
  try {
    const plan = buildCustomLoadoutPlan({
      membershipType: 3,
      targetCharacterId: "character-1",
      classId: "hunter",
      ...customPlanFixture(),
    });
    await assert.rejects(applyCustomLoadoutPlan(plan), error => {
      assert.ok(error instanceof BungieLoadoutApplyError);
      assert.equal(error.stage, "plugs");
      assert.equal(error.partial, true);
      assert.equal(error.completed.transfers, 5);
      assert.equal(error.completed.targetEquip, 1);
      return true;
    });
  } finally {
    restoreGlobals();
  }
});

test("equipSavedLoadout uses the official EquipLoadout request shape", async () => {
  installAuth();
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return jsonResponse({ Response: 0, ErrorCode: 1, ErrorStatus: "Ok" });
  };
  try {
    await equipSavedLoadout({ membershipType: 3, characterId: "char", loadoutIndex: 7 });
    assert.ok(request.url.endsWith("/Destiny2/Actions/Loadouts/EquipLoadout/"));
    assert.deepEqual(request.body, {
      membershipType: 3,
      characterId: "char",
      loadoutIndex: 7,
    });
  } finally {
    restoreGlobals();
  }
});
