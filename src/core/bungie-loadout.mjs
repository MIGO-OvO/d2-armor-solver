// Bungie loadout write support.
//
// Bungie's public API does not expose a CreateLoadout operation. Arbitrary
// solver results therefore use the documented manual action sequence:
// transfer -> equip -> InsertSocketPlugFree. Existing in-game loadouts can be
// applied directly through EquipLoadout.

import { bungiePost } from "./bungie-api.mjs";
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

export const CHARACTER_LOADOUTS_COMPONENT = "CharacterLoadouts";
export const LOADOUT_WRITE_COMPONENTS = [
  CHARACTER_LOADOUTS_COMPONENT,
  "ProfilePlugSets",
  "CharacterPlugSets",
];
export const SUBCLASS_BUCKET_HASH = 3284755031;

const CLASS_ID_BY_TYPE = { 0: "titan", 1: "hunter", 2: "warlock" };
const CLASS_TYPE_BY_ID = { titan: 0, hunter: 1, warlock: 2 };
const STAT_MOD_ENERGY_COST = { 5: 1, 10: 3 };

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

const KNOWN_ARMOR_PLUG_HASHES = new Set([
  ...STAT_MOD_BY_HASH.keys(),
  ...TUNING_BY_HASH.keys(),
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

  const profileAvailable = new Set();
  collectAvailablePlugHashes(data.profilePlugSets, profileAvailable);
  const availablePlugHashesByCharacter = {};
  for (const characterId of Object.keys(characters)) {
    const available = new Set(profileAvailable);
    collectAvailablePlugHashes(data.characterPlugSets?.data?.[characterId], available);
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

function tuningHashFor(assignment) {
  if (assignment?.mode === "+3") return Number(BALANCED_TUNING_MOD_HASH);
  if (assignment?.mode !== "+5-5" || !assignment.to || !assignment.from) return 0;
  return Number(TUNING_MOD_HASH_BY_TUNING[`${assignment.to}:${assignment.from}`]) || 0;
}

function statModHashFor(assignment) {
  if (!assignment?.stat || !assignment?.size) return 0;
  return Number(STAT_MOD_HASHES[assignment.stat]?.[assignment.size]) || 0;
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

function findKnownSocket(item, knownHashes) {
  return (item?.socketPlugs || []).find(socket =>
    socket?.enabled !== false && knownHashes.has(Number(socket?.plugHash)),
  )?.socketIndex ?? null;
}

function availableArmorPlugSet(availablePlugHashes) {
  if (!(availablePlugHashes instanceof Set)) return null;
  return new Set([...availablePlugHashes].filter(hash =>
    KNOWN_ARMOR_PLUG_HASHES.has(Number(hash))));
}

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
  const skippedMods = [];
  const itemsById = new Map((inventory || []).map(item => [String(item?.id ?? ""), item]));
  const targetIds = new Set((pieces || []).map(piece => String(piece?.sourceId ?? "")));
  const characterClassType = CLASS_TYPE_BY_ID[classId];
  const knownAvailable = availableArmorPlugSet(availablePlugHashes);
  const resolvedItems = [];
  const plugOperations = [];

  if (!membershipType || !targetCharacterId) {
    errors.push({ code: "missingTarget" });
  }
  if (!Array.isArray(pieces) || pieces.length !== 5) {
    errors.push({ code: "missingPieces" });
  }

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
    if (item.canEquip === false) {
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
    if (!item.owner) {
      errors.push({ code: "missingOwner", index, slot: piece.slot });
    }
    resolvedItems.push({ ...item, planIndex: index });

    const desiredStatHash = statModHashFor(modAssignments?.[index]);
    const desiredTuningHash = tuningHashFor(tuningAssignments?.[index]);
    const current = decodeArmorPlugHashes((item.socketPlugs || []).map(socket => socket.plugHash));
    const statSocketIndex = findKnownSocket(item, new Set(STAT_MOD_BY_HASH.keys())) ??
      ((item.socketPlugs || []).some(socket => socket.socketIndex === 0 && socket.enabled) ? 0 : null);
    const tuningSocketIndex = findKnownSocket(item, new Set(TUNING_BY_HASH.keys()));

    if (desiredStatHash) {
      if (current.armorModHash === desiredStatHash) {
        // An unchanged installed plug needs no write and remains safe even if
        // Bungie's reusable-plug component omits a legacy entry.
      } else if (knownAvailable && !knownAvailable.has(desiredStatHash)) {
        errors.push({ code: "plugUnavailable", index, slot: piece.slot, plugHash: desiredStatHash });
      } else if (statSocketIndex === null) {
        errors.push({ code: "statSocketUnknown", index, slot: piece.slot });
      } else {
        const targetCost = STAT_MOD_ENERGY_COST[Number(modAssignments[index]?.size)] || 0;
        const currentCost = STAT_MOD_ENERGY_COST[Number(current.armorModSize)] || 0;
        const capacity = Number(item.energy?.capacity) || 0;
        const projectedUsed = Math.max(0, (Number(item.energy?.used) || 0) - currentCost) + targetCost;
        if (capacity > 0 && projectedUsed > capacity) {
          skippedMods.push({ index, slot: piece.slot, plugHash: desiredStatHash, reason: "energy" });
        } else {
          plugOperations.push({
            itemId: String(item.id),
            socketIndex: statSocketIndex,
            plugItemHash: desiredStatHash,
            kind: "stat",
            slot: piece.slot,
          });
        }
      }
    } else if (current.armorModHash) {
      errors.push({ code: "cannotClearStatMod", index, slot: piece.slot });
    }

    if (!desiredTuningHash) {
      errors.push({ code: "invalidTuning", index, slot: piece.slot });
    } else if (current.tuningHash === desiredTuningHash) {
      // No write required; see the installed-plug note above.
    } else if (knownAvailable && !knownAvailable.has(desiredTuningHash)) {
      errors.push({ code: "plugUnavailable", index, slot: piece.slot, plugHash: desiredTuningHash });
    } else if (tuningSocketIndex === null) {
      errors.push({ code: "tuningSocketUnknown", index, slot: piece.slot });
    } else {
      plugOperations.push({
        itemId: String(item.id),
        socketIndex: tuningSocketIndex,
        plugItemHash: desiredTuningHash,
        kind: "tuning",
        slot: piece.slot,
      });
    }
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
  if (skippedMods.length > 0) {
    warnings.push({ code: "modsSkipped", count: skippedMods.length });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    skippedMods,
    membershipType: Number(membershipType),
    targetCharacterId: String(targetCharacterId || ""),
    classId,
    classType: characterClassType,
    preparationTransfers,
    sourceEquips: [...sourceEquipByCharacter].map(([characterId, itemIds]) => ({
      characterId,
      itemIds,
    })),
    transfers,
    equipItemIds: resolvedItems.map(item => String(item.id)),
    plugOperations,
  };
}

function equipFailures(response) {
  const results = Array.isArray(response)
    ? response
    : (response?.equipResults || response?.results || []);
  return results.filter(result => Number(result?.equipStatus) !== 0);
}

export async function applyCustomLoadoutPlan(plan, { onProgress = null } = {}) {
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
    return { completed, skippedMods: plan.skippedMods };
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
