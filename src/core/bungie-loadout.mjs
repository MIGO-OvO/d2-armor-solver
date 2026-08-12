// Bungie loadout write support.
//
// Bungie's public API does not expose a CreateLoadout operation. Arbitrary
// solver results therefore use the documented manual action sequence:
// transfer -> equip -> InsertSocketPlugFree. Existing in-game loadouts can be
// applied directly through EquipLoadout.
//
// The manual sequence is a DIM-style safe flow (handoff 4.4): prepare source
// characters by unequipping required pieces into spare replacements, transfer
// to the target character, bulk-equip, apply socket plugs in order, then
// re-read the profile and verify every expected instance/plug landed.

import { bungieFetch, bungiePost } from "./bungie-api.mjs";
import {
  BALANCED_TUNING_MOD_HASH,
  STAT_MOD_HASHES,
  TUNING_MOD_HASH_BY_TUNING,
} from "./armor-mods.data.mjs";
import {
  CLASS_ABILITY_PENALTY_FRAGMENTS,
  CLASS_ABILITY_STAT_BY_CLASS,
  FRAGMENT_STAT_CHANGES,
} from "./fragment-data.data.mjs";
import { assignArmorMods } from "./armor-mod-assignment.mjs";
import { buildSocketCapabilities } from "./armor-sockets.mjs";

export const CHARACTER_LOADOUTS_COMPONENT = "CharacterLoadouts";
export const LOADOUT_WRITE_COMPONENTS = [
  CHARACTER_LOADOUTS_COMPONENT,
];
export const SUBCLASS_BUCKET_HASH = 3284755031;

// Components needed to verify a just-applied loadout (Phase E verify).
export const VERIFY_COMPONENTS = [
  "Characters",
  "CharacterEquipment",
  "ItemInstances",
  "ItemStats",
  "ItemSockets",
];

const CLASS_ID_BY_TYPE = { 0: "titan", 1: "hunter", 2: "warlock" };
const CLASS_TYPE_BY_ID = { titan: 0, hunter: 1, warlock: 2 };

const STAT_MOD_BY_HASH = new Map();
for (const [stat, sizes] of Object.entries(STAT_MOD_HASHES)) {
  for (const [size, hash] of Object.entries(sizes)) {
    STAT_MOD_BY_HASH.set(Number(hash), { stat, size: Number(size) });
  }
}

const TUNING_BY_HASH = new Map([[Number(BALANCED_TUNING_MOD_HASH), { mode: "+3" }]]);
for (const [key, hash] of Object.entries(TUNING_MOD_HASH_BY_TUNING)) {
  const [to, from] = key.split(":");
  TUNING_BY_HASH.set(Number(hash), { mode: "+5-5", to, from });
}

// DestinyEquipFailureReason bits that are PERMANENT for a loadout flow: no
// amount of transferring or unequipping makes the item equippable on the
// target character. Empirically from the real fixture, reason 16 (locked) is
// the normal state of every vault item and reason 0/2 are transient API
// states; class mismatch (512) is already rejected separately via classId.
// Everything else (equipped elsewhere, in vault, in another slot, unknown)
// is recoverable by the prepare/transfer flow and must NOT preflight-block.
const PERMANENT_EQUIP_FAILURE_REASONS = new Set([
  1024, // ItemIsInAnotherLevelRequirement
]);

function unwrapProfile(profileResponse) {
  const root = profileResponse?.Response ?? profileResponse;
  return root?.data ?? root ?? {};
}

function normalizedSocketPlugs(sockets, instanceId) {
  return (sockets?.[instanceId]?.sockets || []).map((socket, socketIndex) => ({
    socketIndex,
    plugHash: Number(socket?.plugHash) || 0,
    enabled: socket?.isEnabled !== false,
    visible: socket?.isVisible !== false,
  }));
}

function collectAvailablePlugHashes(component, target) {
  const plugsBySet = component?.data?.plugs ?? component?.plugs ?? {};
  for (const plugs of Object.values(plugsBySet)) {
    for (const plug of plugs || []) {
      if (plug?.canInsert === false || plug?.enabled === false) continue;
      const hash = Number(plug?.plugItemHash) || 0;
      if (hash) target.add(hash);
    }
  }
}

export function getFragmentAdjustments(plugHashes, classId) {
  const adjustments = {};
  const classAbilityStat = CLASS_ABILITY_STAT_BY_CLASS[classId] || null;
  for (const value of plugHashes || []) {
    const hash = Number(value) || 0;
    if (CLASS_ABILITY_PENALTY_FRAGMENTS.has(hash)) {
      if (classAbilityStat) {
        adjustments[classAbilityStat] = (adjustments[classAbilityStat] || 0) - 10;
      }
      continue;
    }
    for (const [stat, delta] of Object.entries(FRAGMENT_STAT_CHANGES[hash] || {})) {
      adjustments[stat] = (adjustments[stat] || 0) + delta;
    }
  }
  for (const stat of Object.keys(adjustments)) {
    if (adjustments[stat] === 0) delete adjustments[stat];
  }
  return adjustments;
}

export function extractBungieLoadoutState(profileResponse) {
  const data = unwrapProfile(profileResponse);
  const sockets = data.itemComponents?.sockets?.data ?? {};
  const characters = {};
  for (const [characterId, character] of Object.entries(data.characters?.data ?? {})) {
    characters[characterId] = {
      characterId,
      classType: character?.classType ?? null,
      classId: CLASS_ID_BY_TYPE[character?.classType] || null,
      light: Number(character?.light) || 0,
      dateLastPlayed: character?.dateLastPlayed || "",
      emblemPath: character?.emblemPath || "",
    };
  }

  const savedLoadouts = {};
  for (const [characterId, component] of Object.entries(data.characterLoadouts?.data ?? {})) {
    savedLoadouts[characterId] = (component?.loadouts || []).map((loadout, loadoutIndex) => ({
      loadoutIndex,
      colorHash: Number(loadout?.colorHash) || 0,
      iconHash: Number(loadout?.iconHash) || 0,
      nameHash: Number(loadout?.nameHash) || 0,
      items: (loadout?.items || []).map(item => ({
        itemInstanceId: String(item?.itemInstanceId ?? ""),
        plugItemHashes: (item?.plugItemHashes || []).map(Number).filter(Boolean),
      })).filter(item => item.itemInstanceId),
    })).filter(loadout => loadout.items.length > 0);
  }

  const currentSubclassByCharacter = {};
  for (const [characterId, equipment] of Object.entries(data.characterEquipment?.data ?? {})) {
    const subclass = (equipment?.items || []).find(
      item => Number(item?.bucketHash) === SUBCLASS_BUCKET_HASH,
    );
    if (!subclass?.itemInstanceId) continue;
    const instanceId = String(subclass.itemInstanceId);
    const socketPlugs = normalizedSocketPlugs(sockets, instanceId)
      .filter(socket => socket.enabled && socket.plugHash);
    currentSubclassByCharacter[characterId] = {
      itemHash: Number(subclass.itemHash) || 0,
      instanceId,
      socketPlugs,
      plugItemHashes: socketPlugs.map(socket => socket.plugHash),
      adjustments: getFragmentAdjustments(
        socketPlugs.map(socket => socket.plugHash),
        characters[characterId]?.classId,
      ),
    };
  }

  // Tri-state availability (handoff 3.3): when neither the profile nor the
  // character plug-set components were returned, availability is UNKNOWN —
  // never an empty set, which would wrongly prove every plug locked. The
  // executor then verifies each write by its result and the post-write read.
  const hasProfilePlugSets = Boolean(data.profilePlugSets?.data?.plugs)
    || Boolean(data.profilePlugSets?.plugs);
  const availablePlugHashesByCharacter = {};
  for (const characterId of Object.keys(characters)) {
    const characterComponent = data.characterPlugSets?.data?.[characterId];
    const hasCharacterPlugSets = Boolean(characterComponent?.plugs);
    if (!hasProfilePlugSets && !hasCharacterPlugSets) {
      availablePlugHashesByCharacter[characterId] = null;
      continue;
    }
    const available = new Set();
    collectAvailablePlugHashes(data.profilePlugSets, available);
    collectAvailablePlugHashes(characterComponent, available);
    availablePlugHashesByCharacter[characterId] = available;
  }

  return {
    characters,
    savedLoadouts,
    currentSubclassByCharacter,
    availablePlugHashesByCharacter,
  };
}

export function decodeArmorPlugHashes(plugHashes) {
  const decoded = {
    armorModSize: 0,
    armorModStat: null,
    armorModHash: 0,
    tuningMode: null,
    tuningFrom: null,
    tuningTo: null,
    tuningHash: 0,
  };
  for (const value of plugHashes || []) {
    const hash = Number(value) || 0;
    const statMod = STAT_MOD_BY_HASH.get(hash);
    if (statMod) {
      decoded.armorModSize = statMod.size;
      decoded.armorModStat = statMod.stat;
      decoded.armorModHash = hash;
    }
    const tuning = TUNING_BY_HASH.get(hash);
    if (tuning) {
      decoded.tuningMode = tuning.mode === "+3" ? "plus3" : "shift";
      decoded.tuningFrom = tuning.from || null;
      decoded.tuningTo = tuning.to || null;
      decoded.tuningHash = hash;
    }
  }
  return decoded;
}

export function mapSavedLoadoutArmor(loadout, inventory) {
  const byId = new Map((inventory || []).map(item => [String(item?.id ?? ""), item]));
  return (loadout?.items || []).map(loadoutItem => {
    const item = byId.get(String(loadoutItem?.itemInstanceId ?? ""));
    if (!item) return null;
    return {
      ...item,
      ...decodeArmorPlugHashes(loadoutItem.plugItemHashes),
    };
  }).filter(Boolean);
}

// Inventory items produced by older code paths carry only raw socketPlugs
// (no role/candidate capabilities). Derive minimal capabilities from the
// currently installed plug so the assignment still resolves roles, with
// candidate state unknown (never rejecting on availability).
function ensureSocketCapabilities(item) {
  if (Array.isArray(item?.sockets) && item.sockets.length > 0) return item.sockets;
  if (!Array.isArray(item?.socketPlugs)) return [];
  return buildSocketCapabilities(
    item.socketPlugs.map(socket => ({
      socketIndex: socket?.socketIndex,
      plugHash: socket?.plugHash || 0,
      isEnabled: socket?.enabled,
      isVisible: socket?.visible,
    })),
    null,
    null,
  );
}

function transferRequest(item, membershipType, characterId, transferToVault) {
  return {
    itemReferenceHash: Number(item.hash),
    stackSize: 1,
    transferToVault,
    itemId: String(item.id),
    characterId: String(characterId),
    membershipType: Number(membershipType),
  };
}

const MISS_REASON_TO_ERROR_CODE = {
  statSocketUnknown: "statSocketUnknown",
  tuningSocketUnknown: "tuningSocketUnknown",
  plugUnavailable: "plugUnavailable",
  energy: "energy",
  tuningMismatch: "tuningMismatch",
  cannotClear: "cannotClearStatMod",
  notOwnedInstance: "notOwnedInstance",
};

export class BungieLoadoutPlanError extends Error {
  constructor(errors) {
    super("Bungie loadout plan failed preflight");
    this.name = "BungieLoadoutPlanError";
    this.errors = errors;
  }
}

export class BungieLoadoutApplyError extends Error {
  constructor(stage, completed, cause) {
    super(`Bungie loadout apply failed during ${stage}`, { cause });
    this.name = "BungieLoadoutApplyError";
    this.stage = stage;
    this.completed = completed;
    this.partial = Object.values(completed).some(value => Number(value) > 0);
  }
}

export function buildCustomLoadoutPlan({
  membershipType,
  membershipId = null,
  targetCharacterId,
  classId,
  pieces,
  tuningAssignments,
  modAssignments,
  inventory,
  availablePlugHashes = null,
}) {
  const errors = [];
  const warnings = [];
  const itemsById = new Map((inventory || []).map(item => [String(item?.id ?? ""), item]));
  const targetIds = new Set((pieces || []).map(piece => String(piece?.sourceId ?? "")));
  const characterClassType = CLASS_TYPE_BY_ID[classId];
  const resolvedItems = [];

  if (!membershipType || !targetCharacterId) {
    errors.push({ code: "missingTarget" });
  }
  if (!Array.isArray(pieces) || pieces.length !== 5) {
    errors.push({ code: "missingPieces" });
  }

  let exoticCount = 0;
  for (let index = 0; index < (pieces || []).length; index++) {
    const piece = pieces[index];
    const item = itemsById.get(String(piece?.sourceId ?? ""));
    if (!piece?.sourceId || !piece?.hash || !item) {
      errors.push({ code: "notOwnedInstance", index, slot: piece?.slot || "" });
      continue;
    }
    if (item.classId && classId && item.classId !== classId) {
      errors.push({ code: "classMismatch", index, slot: piece.slot });
    }
    // Transient cannot-equip reasons (locked, vaulted, equipped elsewhere,
    // unknown) flow into the prepare/transfer stage; only permanent ones block
    // here (handoff 3.8). Final proof is the EquipItems result + verify.
    if (item.canEquip === false
        && PERMANENT_EQUIP_FAILURE_REASONS.has(Number(item.cannotEquipReason) || 0)) {
      errors.push({
        code: "itemCannotEquip",
        index,
        slot: piece.slot,
        reason: Number(item.cannotEquipReason) || 0,
      });
    }
    if (piece.exotic && ((piece.primaryPerkId || null) !== (item.primaryPerkId || null) ||
        (piece.secondaryPerkId || null) !== (item.secondaryPerkId || null))) {
      errors.push({ code: "exoticPerkMismatch", index, slot: piece.slot });
    }
    if (piece.exotic) exoticCount++;
    if (!item.owner) {
      errors.push({ code: "missingOwner", index, slot: piece.slot });
    }
    resolvedItems.push({ ...item, planIndex: index, sockets: ensureSocketCapabilities(item) });
  }
  if (exoticCount > 1) {
    errors.push({ code: "multipleExotics" });
  }

  // Global assignment over the five real instances: exact socket resolution,
  // tri-state availability, energy feasibility, fixed-tuning compatibility.
  // Any unassignable mod BLOCKS the plan — there is no skipped-success path.
  const assignment = assignArmorMods({
    pieces,
    inventory: resolvedItems,
    tuningAssignments,
    modAssignments,
    availablePlugHashes,
  });
  for (const miss of assignment.unassignedMods) {
    errors.push({
      code: MISS_REASON_TO_ERROR_CODE[miss.reason] || "plugUnavailable",
      index: miss.index,
      slot: miss.slot || "",
      kind: miss.kind || "stat",
      plugHash: miss.plugHash || 0,
    });
  }

  const preparationTransfers = [];
  const sourceEquipByCharacter = new Map();
  for (const item of resolvedItems) {
    if (String(item.owner) === String(targetCharacterId) || item.owner === "Vault" || !item.equipped) {
      continue;
    }
    const replacement = (inventory || []).find(candidate =>
      !targetIds.has(String(candidate?.id ?? "")) &&
      candidate?.slot === item.slot && candidate?.classId === item.classId &&
      !candidate?.equipped &&
      // Prefer a non-exotic replacement so the source character never hits the
      // one-exotic-equipped rule while freeing the loadout piece (handoff 4.4).
      !candidate?.exotic &&
      (String(candidate?.owner) === String(item.owner) || candidate?.owner === "Vault"),
    ) || (inventory || []).find(candidate =>
      !targetIds.has(String(candidate?.id ?? "")) &&
      candidate?.slot === item.slot && candidate?.classId === item.classId &&
      !candidate?.equipped &&
      (String(candidate?.owner) === String(item.owner) || candidate?.owner === "Vault"),
    );
    if (!replacement) {
      errors.push({ code: "equippedElsewhereNoReplacement", slot: item.slot, owner: item.owner });
      continue;
    }
    if (replacement.owner === "Vault") {
      preparationTransfers.push(transferRequest(
        replacement, membershipType, item.owner, false,
      ));
    }
    if (!sourceEquipByCharacter.has(String(item.owner))) {
      sourceEquipByCharacter.set(String(item.owner), []);
    }
    sourceEquipByCharacter.get(String(item.owner)).push(String(replacement.id));
  }

  const transfers = [];
  for (const item of resolvedItems) {
    if (String(item.owner) === String(targetCharacterId)) continue;
    if (item.owner !== "Vault") {
      transfers.push(transferRequest(item, membershipType, item.owner, true));
    }
    transfers.push(transferRequest(item, membershipType, targetCharacterId, false));
  }

  if (characterClassType === undefined) {
    errors.push({ code: "unknownClass" });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    // Legacy compatibility: the old flow could skip energy-incompatible mods
    // and still report success. That success semantics is gone — any unplaced
    // mod is a blocking error above — so the list is always empty.
    skippedMods: [],
    membershipType: Number(membershipType),
    membershipId: membershipId ? String(membershipId) : null,
    targetCharacterId: String(targetCharacterId || ""),
    classId,
    classType: characterClassType,
    assignment,
    preparationTransfers,
    sourceEquips: [...sourceEquipByCharacter].map(([characterId, itemIds]) => ({
      characterId,
      itemIds,
    })),
    transfers,
    equipItemIds: resolvedItems.map(item => String(item.id)),
    // Ordered per-socket plug writes produced by the global assignment.
    plugOperations: assignment.plugOperations,
  };
}

function equipFailures(response) {
  const results = Array.isArray(response)
    ? response
    : (response?.equipResults || response?.results || []);
  return results.filter(result => Number(result?.equipStatus) !== 0);
}

// Re-read the profile after writing and confirm every expected instance is
// equipped and every expected plug hash sits in its socket. One short retry is
// allowed for Bungie's stale character data; no infinite retries (handoff 5).
export async function verifyLoadoutApplication({
  membershipType,
  membershipId,
  targetCharacterId,
  equipItemIds,
  plugOperations,
}, { retries = 1, delayMs = 1500 } = {}) {
  if (!membershipId) {
    return { status: "failed", mismatches: [{ kind: "missingMembershipId" }], attempts: 1 };
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let lastMismatches = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await bungieFetch(
      `/Destiny2/${membershipType}/Profile/${membershipId}/?components=${VERIFY_COMPONENTS.join(",")}`,
      { auth: true, retries: 0 },
    );
    const data = unwrapProfile(response);
    const mismatches = [];
    const equipment = data.characterEquipment?.data?.[targetCharacterId]?.items || [];
    const equippedIds = new Set(equipment.map(item => String(item.itemInstanceId)));
    for (const itemId of equipItemIds) {
      if (!equippedIds.has(String(itemId))) {
        mismatches.push({ kind: "armorInstanceMissing", itemId: String(itemId) });
      }
    }
    const sockets = data.itemComponents?.sockets?.data ?? {};
    for (const operation of plugOperations || []) {
      const itemSockets = sockets[String(operation.itemId)]?.sockets || [];
      const socket = itemSockets[operation.socketIndex];
      if (Number(socket?.plugHash) !== Number(operation.plugItemHash)) {
        mismatches.push({
          kind: "plugMismatch",
          itemId: String(operation.itemId),
          socketIndex: operation.socketIndex,
          expected: Number(operation.plugItemHash),
          actual: Number(socket?.plugHash) || 0,
        });
      }
    }
    lastMismatches = mismatches;
    if (mismatches.length === 0) return { status: "verified", mismatches: [], attempts: attempt + 1 };
    if (attempt < retries) await sleep(delayMs);
  }
  return { status: "failed", mismatches: lastMismatches, attempts: retries + 1 };
}

export async function applyCustomLoadoutPlan(plan, { onProgress = null, verify = true } = {}) {
  if (!plan?.valid) throw new BungieLoadoutPlanError(plan?.errors || []);
  const completed = {
    preparationTransfers: 0,
    sourceEquips: 0,
    transfers: 0,
    targetEquip: 0,
    plugs: 0,
  };
  let stage = "prepare";
  const progress = detail => onProgress?.({ stage, completed: { ...completed }, ...detail });
  try {
    for (const request of plan.preparationTransfers) {
      progress({ action: "transfer" });
      await bungiePost("/Destiny2/Actions/Items/TransferItem/", request);
      completed.preparationTransfers++;
    }
    stage = "unequip-source";
    for (const source of plan.sourceEquips) {
      progress({ action: "equip-source", characterId: source.characterId });
      const response = await bungiePost("/Destiny2/Actions/Items/EquipItems/", {
        itemIds: source.itemIds,
        characterId: source.characterId,
        membershipType: plan.membershipType,
      });
      const failures = equipFailures(response);
      if (failures.length > 0) throw new Error("Source replacement equip failed");
      completed.sourceEquips++;
    }
    stage = "transfer";
    for (const request of plan.transfers) {
      progress({ action: "transfer" });
      await bungiePost("/Destiny2/Actions/Items/TransferItem/", request);
      completed.transfers++;
    }
    stage = "equip";
    progress({ action: "equip-target" });
    const equipResponse = await bungiePost("/Destiny2/Actions/Items/EquipItems/", {
      itemIds: plan.equipItemIds,
      characterId: plan.targetCharacterId,
      membershipType: plan.membershipType,
    });
    const failures = equipFailures(equipResponse);
    if (failures.length > 0) throw new Error("Target armor equip failed");
    completed.targetEquip = 1;

    stage = "plugs";
    for (const operation of plan.plugOperations) {
      progress({ action: "plug", operation });
      await bungiePost("/Destiny2/Actions/Items/InsertSocketPlugFree/", {
        itemId: operation.itemId,
        characterId: plan.targetCharacterId,
        membershipType: plan.membershipType,
        plug: {
          socketIndex: operation.socketIndex,
          socketArrayType: 0,
          plugItemHash: operation.plugItemHash,
        },
      });
      completed.plugs++;
    }

    let verification = null;
    if (verify) {
      stage = "verify";
      progress({ action: "verify" });
      verification = await verifyLoadoutApplication({
        membershipType: plan.membershipType,
        membershipId: plan.membershipId,
        targetCharacterId: plan.targetCharacterId,
        equipItemIds: plan.equipItemIds,
        plugOperations: plan.plugOperations,
      });
    }
    return { completed, skippedMods: [], verification };
  } catch (cause) {
    throw new BungieLoadoutApplyError(stage, completed, cause);
  }
}

export function equipSavedLoadout({ membershipType, characterId, loadoutIndex }) {
  return bungiePost("/Destiny2/Actions/Loadouts/EquipLoadout/", {
    loadoutIndex: Number(loadoutIndex),
    characterId: String(characterId),
    membershipType: Number(membershipType),
  });
}
