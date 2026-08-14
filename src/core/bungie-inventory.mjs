// Bungie Profile API inventory mapping (T8/T9). Maps DestinyItemComponent
// records to exactly the same solver item shape normalizeDimItem produces
// (src/core/dim-csv.mjs), so API-sourced armor flows through the solver
// unchanged. buildArmorInventory walks a GetProfile response, dedups the
// three armor sources by instanceId and returns the solver-ready list.
// Pure data mapping: no DOM, no fetch, no browser storage.

import {
  ARCHETYPES,
  EXOTIC_CLASSES,
  EXOTIC_PERK_NAMES,
  STATS,
} from "./armor-model.mjs";
import { getArmorSetByItemHash } from "./armor-sets.mjs";
import {
  getEffectiveBaseStats,
  inferArchetypeFromStats,
} from "./dim-csv.mjs";
import {
  BALANCED_TUNING_MOD_HASH,
  STAT_MOD_HASHES,
  TUNING_MOD_HASH_BY_TUNING,
} from "./armor-mods.data.mjs";
import {
  buildSocketCapabilities,
  deriveTuningStats,
  findSocketByRole,
  SOCKET_ROLE,
} from "./armor-sockets.mjs";
import { ARMOR_ITEMS } from "./armor-items.data.mjs";
import {
  CLASS_ABILITY_PENALTY_FRAGMENTS,
  CLASS_ABILITY_STAT_BY_CLASS,
  FRAGMENT_STAT_CHANGES,
} from "./fragment-data.data.mjs";

// The DestinyComponentType values the armor inventory request needs.
// ItemReusablePlugs (310) supplies the per-instance, per-socketIndex candidate
// plugs that make socket roles and the fixed tuning stat derivable without a
// runtime manifest download. ProfilePlugSets / CharacterPlugSets are NOT
// component types (they ride along with ItemSockets); never add them here.
export const ARMOR_COMPONENTS = [
  "Profiles",
  "ProfileInventories",
  "Characters",
  "CharacterInventories",
  "CharacterEquipment",
  "ItemInstances",
  "ItemStats",
  "ItemSockets",
  "ItemPlugStates",
  "ItemReusablePlugs",
];

// Armor bucket hashes -> solver slots (the five armor buckets; anything else
// is filtered out). Verified against the real Bungie Manifest
// (DestinyInventoryBucketDefinition, zh-chs + en aggregates,
// manifest version 244213.26.06.29.2000-1-bnet.65583):
//   3448274439 -> Helmet / 头盔
//   3551918588 -> Gauntlets / 臂铠
//   14239492   -> Chest Armor / 胸部护甲
//   20886954   -> Leg Armor / 腿部护甲
//   1585787867 -> Class Armor / 职业护甲
// (category = 3 Equippable, itemCount 10, location 1 in all five.)
// NOTE: items stored in the Vault all come back with bucketHash 138197802
// ("General", itemCount 500) instead of their equipment-slot bucket;
// normalizeApiItem recovers the slot from the catalog's own bucketHash.
export const ARMOR_BUCKET_HASH_TO_SLOT = {
  3448274439: "helmet", // Helmet
  3551918588: "arms", // Gauntlets
  14239492: "chest", // Chest Armor
  20886954: "legs", // Leg Armor
  1585787867: "classItem", // Classified / class item
};

const CLASS_BY_TYPE = { 0: "titan", 1: "hunter", 2: "warlock" };

// Page language keys -> catalog data keys. The armor-items.data.mjs product
// stores names as { zh, zhCht, en } (fetch-armor-item-data.mjs nameKey), so
// 'zh-chs' -> 'zh' and 'zh-cht' -> 'zhCht' (same map as armor-sets.mjs:11-15).
const DATA_LANGUAGE_BY_PAGE_LANGUAGE = {
  "zh-chs": "zh",
  "zh-cht": "zhCht",
  en: "en",
};

// Armor 3.0 stat hashes -> our stat ids (mirrors scripts/fetch-armor-mod-data.mjs).
const STAT_HASH_TO_NAME = {
  2996146975: "weapons",
  392767087: "health",
  1943323491: "class",
  1735777505: "grenade",
  144602215: "super",
  4244567218: "melee",
};

// DestinyItemStatsComponent values use the DestinyStat shape
// `{ statHash, value }`, while character aggregate stats and older fixtures
// use plain numbers. Normalize both at the API boundary so no object can leak
// into framework inference or stat arithmetic.
function normalizeDestinyStats(statsComponent) {
  const normalized = {};
  for (const [key, entry] of Object.entries(statsComponent || {})) {
    const statHash = Number(
      entry && typeof entry === "object" ? entry.statHash ?? key : key,
    );
    const stat = STAT_HASH_TO_NAME[statHash];
    const rawValue = entry && typeof entry === "object" ? entry.value : entry;
    const value = Number(rawValue);
    if (stat && Number.isFinite(value)) normalized[stat] = value;
  }
  return normalized;
}

// Reverse indexes over the mod hash tables: a plug hash resolves forward to
// the exact tuning/mod it grants (Metis C1 — no reverse inference needed).
const STAT_MOD_HASH_TO_MOD = new Map();
for (const [stat, sizes] of Object.entries(STAT_MOD_HASHES)) {
  for (const [size, hash] of Object.entries(sizes)) {
    STAT_MOD_HASH_TO_MOD.set(hash, { armorModSize: Number(size), armorModStat: stat });
  }
}

// TUNING_MOD_HASH_BY_TUNING keys are "<+5 destination>:<-5 source>".
const TUNING_HASH_TO_TUNING = new Map();
for (const [key, hash] of Object.entries(TUNING_MOD_HASH_BY_TUNING)) {
  const [tuningTo, tuningFrom] = key.split(":");
  TUNING_HASH_TO_TUNING.set(hash, { tuningFrom, tuningTo });
}

function getFrameworkStats(archetypeId, tertiary) {
  const archetype = ARCHETYPES.find(item => item.id === archetypeId);
  if (!archetype || !STATS.includes(tertiary)) return null;
  return new Set([archetype.primary, archetype.secondary, tertiary]);
}

// Highest non-primary/secondary base stat (dim-csv.mjs fallback logic).
function inferTertiary(baseStats, archetypeId) {
  const archetype = ARCHETYPES.find(item => item.id === archetypeId);
  const candidates = STATS.filter(stat =>
    !archetype || (stat !== archetype.primary && stat !== archetype.secondary),
  );
  return candidates
    .sort((left, right) => (baseStats[right] || 0) - (baseStats[left] || 0))[0] || null;
}

// Every plug hash installed on an instance, gathered from the sockets
// component. The ItemPlugStates component is NOT an installed-plug source: it
// reports per-plug-ITEM statuses (canInsert/enabled/insertFailIndexes), keyed
// by plug item hash, and feeds availability checks instead (handoff 3.2).
function collectPlugHashes(instanceId, sockets) {
  const hashes = new Set();
  for (const socket of sockets?.[instanceId]?.sockets || []) {
    if (socket?.isEnabled !== false && socket?.plugHash) hashes.add(Number(socket.plugHash));
  }
  return hashes;
}

export function normalizeApiItem(apiItem, context = {}) {
  const {
    characterClassType,
    instances = {},
    itemStats = {},
    sockets = {},
    reusablePlugs = null,
    availablePlugHashes = null,
    catalog = null,
    language = "zh-chs",
    equipped = false,
    owner = "",
  } = context;

  const hash = Number(apiItem.itemHash) || 0;
  const entry = catalog?.[hash] || null;
  // Vault items all report the account-wide "General" bucket (138197802,
  // itemCount 500) instead of their equipment-slot bucket, so the armor slot
  // has to be recovered from the item definition's own bucketHash — the
  // catalog always records one of the five armor buckets for real armor.
  const slot = ARMOR_BUCKET_HASH_TO_SLOT[Number(apiItem.bucketHash)]
    || ARMOR_BUCKET_HASH_TO_SLOT[Number(entry?.bucketHash)]
    || null;
  if (!slot) return null;

  const instanceId = String(apiItem.itemInstanceId ?? "");
  const instance = instances?.[instanceId] || {};
  // Bungie's real GetProfile response keeps stats in the ItemStats component,
  // separate from ItemInstances. Keep the legacy instance.stats fallback for
  // older captured/synthetic fixtures, but prefer the API's actual shape.
  const statsComponent = itemStats?.[instanceId]?.stats || instance.stats || {};
  const rawStats = normalizeDestinyStats(statsComponent);

  const tierType = entry?.tierType ?? apiItem.tierType ?? 0;
  const rarity = entry?.rarity ?? "";
  // Vault items have no owner character, so their class comes from the item
  // definition (armor is class-locked; classType is always 0/1/2).
  const classId = CLASS_BY_TYPE[characterClassType ?? entry?.classType] || null;
  // Exotic Class Items are recognized by their known item hashes as well as by
  // rarity, so the exotic flag (and the upgrade-mode auto-lock it drives) never
  // depends on the catalog being complete for the roll.
  const exoticClassItem = classId
    && EXOTIC_CLASSES[classId]?.itemHash === hash
    ? EXOTIC_CLASSES[classId]
    : null;
  // Names ship as { zh, zhCht, en }. Map the page language to the data key;
  // unknown languages fall back to en, missing data keys to zh then en, then
  // to `item_<hash>` (getSetName pattern, armor-sets.mjs:25-28).
  const dataKey = DATA_LANGUAGE_BY_PAGE_LANGUAGE[language];
  const name = (dataKey ? entry?.name?.[dataKey] : entry?.name?.en)
    || entry?.name?.zh
    || entry?.name?.en
    || `item_${hash}`;

  const energy = instance.energy ?? instance.energyCapacity;
  const masterworkTier = Number(
    energy && typeof energy === "object" ? energy.energyCapacity : energy,
  ) || 0;
  const masterworkBonus = Math.min(5, Math.max(0, masterworkTier));

  // Forward tuning/mod inference from the installed plug hashes (Metis C1).
  // Exotic Class Item perk sockets carry the "Spirit of …" plug hashes; match
  // them against EXOTIC_PERK_NAMES so each instance keeps its exact rolled
  // perk pair (left/right column), the identity a lock must preserve.
  let tuningMode = null;
  let tuningFrom = null;
  let tuningTo = null;
  let armorModSize = 0;
  let armorModStat = null;
  let primaryPerkId = null;
  let secondaryPerkId = null;
  const perkHashToId = new Map(Object.entries(EXOTIC_PERK_NAMES)
    .map(([id, meta]) => [meta.hash, id]));
  const primaryPerkIds = new Set((exoticClassItem?.primary || []).map(([id]) => id));
  const secondaryPerkIds = new Set((exoticClassItem?.secondary || []).map(([id]) => id));
  for (const plugHash of collectPlugHashes(instanceId, sockets)) {
    if (plugHash === BALANCED_TUNING_MOD_HASH) {
      tuningMode = "plus3";
    } else if (TUNING_HASH_TO_TUNING.has(plugHash)) {
      const tuning = TUNING_HASH_TO_TUNING.get(plugHash);
      tuningMode = "shift";
      tuningFrom = tuning.tuningFrom;
      tuningTo = tuning.tuningTo;
    } else if (STAT_MOD_HASH_TO_MOD.has(plugHash)) {
      const mod = STAT_MOD_HASH_TO_MOD.get(plugHash);
      armorModSize = mod.armorModSize;
      armorModStat = mod.armorModStat;
    } else {
      const perkId = exoticClassItem ? perkHashToId.get(plugHash) : null;
      if (!perkId) continue;
      if (primaryPerkIds.has(perkId) && !primaryPerkId) primaryPerkId = perkId;
      else if (secondaryPerkIds.has(perkId) && !secondaryPerkId) secondaryPerkId = perkId;
    }
  }

  // Directional shift changes are fully known from the installed plug; the
  // +3 balanced changes need the framework, so they are added after inference.
  const shiftChanges = {};
  if (tuningMode === "shift" && tuningFrom && tuningTo) {
    shiftChanges[tuningFrom] = -5;
    shiftChanges[tuningTo] = 5;
  }

  // Bungie ItemStats are the item's COMPUTED stats: rolled base + masterwork
  // bonus + installed tuning + installed stat mod (the game's current item
  // values — confirmed against live accounts after the parity contract was
  // introduced; handoff 3.5). Recover the rolled base by subtracting every
  // layer, and treat ItemStats directly as the displayed/current stats.
  // Adding the plug effects on top again would double count them.
  //
  // Framework-null decision: when the framework can't be inferred (tertiary
  // inference failed), keep the stats as-is — getEffectiveBaseStats returns
  // baseStats unchanged for a null framework, so subtracting here would
  // diverge from the CSV path. (A null framework also implies every
  // non-framework stat reads 0, so the masterwork bonus is 0 in any reachable
  // case and the subtraction would be a no-op anyway.)
  const inferenceStats = {};
  for (const stat of STATS) {
    inferenceStats[stat] = (rawStats[stat] || 0)
      - (shiftChanges[stat] || 0)
      - (armorModStat === stat ? armorModSize : 0);
  }
  // Framework inference must run on base + masterwork (plug layers removed);
  // a +10 mod must never decide which stat is the tertiary.
  const archetypeId = inferArchetypeFromStats(inferenceStats);
  const tertiary = inferTertiary(inferenceStats, archetypeId);
  const framework = getFrameworkStats(archetypeId, tertiary);

  const plus3Changes = {};
  if (tuningMode === "plus3" && framework) {
    for (const stat of STATS) {
      if (!framework.has(stat)) plus3Changes[stat] = 1;
    }
  }

  const baseStats = {};
  for (const stat of STATS) {
    const mwBonus = framework && !framework.has(stat) ? masterworkBonus : 0;
    baseStats[stat] = (inferenceStats[stat] || 0) - mwBonus - (plus3Changes[stat] || 0);
  }
  const displayedStats = Object.fromEntries(STATS.map(stat => [stat, rawStats[stat] || 0]));

  const set = getArmorSetByItemHash(hash);
  // Per-instance socket capabilities: roles identified from candidate/current
  // plug hashes (armor-sockets.mjs), so stat/tuning sockets are never guessed
  // by index. The raw socketPlugs list stays for the loadout module.
  const socketPlugs = (sockets?.[instanceId]?.sockets || []).map((socket, socketIndex) => ({
    socketIndex,
    plugHash: Number(socket?.plugHash) || 0,
    enabled: socket?.isEnabled !== false,
    visible: socket?.isVisible !== false,
  }));
  const socketsCapability = buildSocketCapabilities(
    sockets?.[instanceId]?.sockets || [],
    reusablePlugs?.[instanceId]?.plugs ?? null,
    availablePlugHashes,
  );
  const tuningSocket = findSocketByRole(socketsCapability, SOCKET_ROLE.TUNING);
  const statSocket = findSocketByRole(socketsCapability, SOCKET_ROLE.STAT);
  const tuningInfo = deriveTuningStats(tuningSocket);
  const dataConfidence = {
    stats: "exact", // ItemStats fully computed: base + masterwork + installed plugs
    framework: archetypeId && tertiary ? "exact" : "unknown",
    tuning: tuningInfo.confidence,
    sockets: tuningSocket && tuningSocket.candidateState === "known" ? "exact" : "partial",
  };
  const item = {
    id: instanceId,
    hash,
    name,
    slot,
    classId,
    // tierType 5 and 6 (Legendary and Exotic) are both solver tier "5", so
    // the tier5Only filter never drops exotics (Metis C3 regression).
    tier: tierType === 5 || tierType === 6 ? "5" : String(tierType),
    rarity,
    exotic: String(rarity).toLowerCase() === "exotic" || Boolean(exoticClassItem),
    archetypeId,
    tertiary,
    // The piece's fixed tuning stat, derived from the tuning socket's reusable
    // plugs (DIM getArmor3TuningStat). null does NOT mean "guess": confidence
    // "unknown" means the data could not establish it and the solver must not
    // pretend it knows (upgrade-optimizer no longer falls back to a guess).
    tuningStat: tuningInfo.fixedTuningStat,
    allowedTuningStats: tuningInfo.allowedTuningStats,
    dataConfidence,
    baseStats,
    masterworkTier,
    displayedStats,
    owner,
    equipped: Boolean(equipped),
    canEquip: instance.canEquip !== false,
    cannotEquipReason: Number(instance.cannotEquipReason) || 0,
    energy: energy && typeof energy === "object" ? {
      capacity: Number(energy.energyCapacity) || 0,
      used: Number(energy.energyUsed) || 0,
      unused: Number(energy.energyUnused) || 0,
      type: Number(energy.energyType) || 0,
      typeHash: Number(energy.energyTypeHash) || 0,
    } : null,
    // Socket indexes are required by InsertSocketPlugFree. Keep the exact
    // per-instance ordering from ItemSockets; the solver ignores this field.
    socketPlugs,
    // Rich per-socket capabilities consumed by armor-mod-assignment.mjs.
    sockets: socketsCapability,
    statSocketIndex: statSocket ? statSocket.socketIndex : null,
    tuningSocketIndex: tuningSocket ? tuningSocket.socketIndex : null,
    dimLocked: false,
    power: Number(instance.primaryStat?.value) || 0,
    setHash: set ? set.hash : null,
    tuningMode,
    tuningFrom,
    tuningTo,
    armorModSize,
    armorModStat,
    // The exact rolled perk pair, when the instance's sockets were available.
    primaryPerkId,
    secondaryPerkId,
    // The API path is exact: plug hashes resolve against the static tables.
    modifierInference: { status: "exact", candidateCount: 1 },
    // Optimization assumes full masterwork (dim-csv.mjs:310-312).
    optimizationBaseStats: getEffectiveBaseStats({
      baseStats,
      archetypeId,
      tertiary,
      masterworkTier: 5,
    }),
  };
  return item;
}

// ============================================================
// T9: PROFILE RESPONSE -> SOLVER INVENTORY
// ============================================================

// ARMOR_ITEMS entries carry rarity but no tierType. Infer it so exotic (6)
// and legendary (5) armor both map to solver tier "5" — anything else stays
// out of the tier5Only filters (rarity strings are lowercase in the data).
const RARITY_TO_TIER_TYPE = { exotic: 6, legendary: 5 };

// Lazy singleton: index the 9000+ item catalog once on first use. An empty
// or missing catalog degrades to null (names fall back to `item_<hash>`).
let catalogIndex = null;
let catalogBuilt = false;

function getCatalogIndex() {
  if (catalogBuilt) return catalogIndex;
  catalogBuilt = true;
  if (!Array.isArray(ARMOR_ITEMS) || ARMOR_ITEMS.length === 0) return null;
  const index = {};
  for (const entry of ARMOR_ITEMS) {
    index[entry.hash] = {
      name: entry.name,
      rarity: entry.rarity,
      tierType: RARITY_TO_TIER_TYPE[entry.rarity] ?? 0,
      // bucketHash/classType recover the slot and class of vault items, whose
      // API bucket is the account-wide "General" bucket (138197802) instead
      // of their equipment-slot bucket.
      bucketHash: entry.bucketHash ?? null,
      classType: entry.classType ?? null,
    };
  }
  catalogIndex = index;
  return catalogIndex;
}

// Walk a full GetProfile response (or its already-unwrapped .Response) and
// merge vault + per-character inventory + equipment armor, deduped by
// instanceId. Equipped copies win; otherwise the first occurrence is kept
// (vault is iterated first, so a vault copy is the default owner).
export function buildArmorInventory(profileResponse, { language = "zh-chs" } = {}) {
  // Unwrap both envelope shapes seen in the wild:
  //   synthetic: { Response: { data: { profile, profileInventory, ... } } }
  //   real     : { Response: { profile, profileInventory, ... } }  (no .data)
  // `data` prefers root.data (synthetic); the real response root is the data.
  const root = profileResponse?.Response ?? profileResponse;
  const data = root?.data ?? root;
  const userInfo = data.profile?.data?.userInfo ?? {};
  const characters = {};
  for (const [characterId, character] of Object.entries(data.characters?.data ?? {})) {
    const stats = normalizeDestinyStats(character?.stats);
    characters[characterId] = {
      classType: character?.classType ?? null,
      ...(Object.keys(stats).length > 0 ? { stats } : {}),
    };
  }

  // Per-character inventory occupancy (ALL unequipped items, not just armor)
  // for the loadout planner's spaceLeftForItem check and move-aside candidates.
  const characterInventories = {};
  for (const [characterId, component] of Object.entries(data.characterInventories?.data ?? {})) {
    characterInventories[characterId] = (component?.items || [])
      .map(apiItem => ({
        itemInstanceId: String(apiItem?.itemInstanceId ?? ""),
        itemHash: Number(apiItem?.itemHash) || 0,
      }))
      .filter(entry => entry.itemInstanceId);
  }
  const instances = data.itemComponents?.instances?.data ?? {};
  const itemStats = data.itemComponents?.stats?.data ?? {};
  const sockets = data.itemComponents?.sockets?.data ?? {};
  // Per-instance candidate plugs (component 310). Unlock filtering happens at
  // plan time against the target character's plug sets; the import keeps the
  // item-definition socket contract so candidates are never emptied by a
  // missing/partial plug-set response.
  const reusablePlugs = data.itemComponents?.reusablePlugs?.data ?? null;
  const catalog = getCatalogIndex();

  const byInstance = new Map();
  const push = (apiItem, characterClassType, owner, equipped) => {
    const id = String(apiItem?.itemInstanceId ?? "");
    if (!id) return;
    if (byInstance.has(id) && !equipped) return; // keep the first non-equipped copy
    const item = normalizeApiItem(apiItem, {
      characterClassType,
      instances,
      itemStats,
      sockets,
      reusablePlugs,
      catalog,
      language,
      equipped,
      owner,
    });
    if (item) byInstance.set(id, item); // non-armor (null) is skipped
  };

  for (const apiItem of data.profileInventory?.data?.items ?? []) {
    push(apiItem, undefined, "Vault", false);
  }
  for (const [characterId, character] of Object.entries(data.characterInventories?.data ?? {})) {
    const classType = characters[characterId]?.classType ?? null;
    for (const apiItem of character?.items ?? []) push(apiItem, classType, characterId, false);
  }
  for (const [characterId, character] of Object.entries(data.characterEquipment?.data ?? {})) {
    const classType = characters[characterId]?.classType ?? null;
    for (const apiItem of character?.items ?? []) push(apiItem, classType, characterId, true);
  }

  return {
    items: [...byInstance.values()],
    membershipType: userInfo.membershipType ?? null,
    membershipId: userInfo.membershipId ?? null,
    characters,
    characterInventories,
  };
}

// Subclass bucket (3284755031) holds the equipped subclass item on every
// character; its sockets carry the currently installed Aspects and Fragments.
// Map the installed plug hashes through FRAGMENT_STAT_CHANGES and sum the
// stat adjustments per character (one subclass per character).
//
// The two class-dependent fragments (Echo of Persistence, Spark of Focus)
// apply -10 to whichever stat governs class-ability regeneration, so the
// character's classType resolves which stat gets the penalty.
export function extractSubclassFragments(profileResponse) {
  // Unwrap both envelope shapes, same as buildArmorInventory.
  const root = profileResponse?.Response ?? profileResponse;
  const data = root?.data ?? root;
  const sockets = data.itemComponents?.sockets?.data ?? {};
  const classByCharacter = {};
  for (const [characterId, character] of Object.entries(data.characters?.data ?? {})) {
    classByCharacter[characterId] = CLASS_BY_TYPE[character?.classType] || null;
  }
  const byCharacter = {};
  for (const [characterId, character] of Object.entries(data.characterEquipment?.data ?? {})) {
    const subclass = (character?.items ?? []).find(item => Number(item.bucketHash) === 3284755031);
    if (!subclass) continue;
    const instanceId = String(subclass.itemInstanceId ?? "");
    if (!instanceId) continue;
    const adjustments = {};
    const classId = classByCharacter[characterId] || null;
    const classAbilityStat = CLASS_ABILITY_STAT_BY_CLASS[classId] || null;
    for (const socket of sockets[instanceId]?.sockets ?? []) {
      // Disabled sockets (e.g. the third Aspect slot before unlocking) carry
      // no installed plug; a missing plugHash means the socket is empty.
      if (socket?.isEnabled === false || !socket.plugHash) continue;
      const plugHash = Number(socket.plugHash);
      if (CLASS_ABILITY_PENALTY_FRAGMENTS.has(plugHash)) {
        if (classAbilityStat) {
          adjustments[classAbilityStat] = (adjustments[classAbilityStat] || 0) - 10;
        }
        continue;
      }
      const changes = FRAGMENT_STAT_CHANGES[plugHash];
      if (!changes) continue;
      for (const [stat, delta] of Object.entries(changes)) {
        adjustments[stat] = (adjustments[stat] || 0) + delta;
      }
    }
    // Drop stats whose adjustments cancelled out (e.g. +10/-10 from two
    // fragments): a zero entry carries no signal for the solver.
    for (const stat of Object.keys(adjustments)) {
      if (adjustments[stat] === 0) delete adjustments[stat];
    }
    if (Object.keys(adjustments).length > 0) byCharacter[characterId] = adjustments;
  }
  return byCharacter;
}
