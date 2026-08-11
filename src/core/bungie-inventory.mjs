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
import { ARMOR_ITEMS } from "./armor-items.data.mjs";

// The 8 DestinyComponentType values the armor inventory request needs.
export const ARMOR_COMPONENTS = [
  "Profiles",
  "ProfileInventories",
  "Characters",
  "CharacterInventories",
  "CharacterEquipment",
  "ItemInstances",
  "ItemSockets",
  "ItemPlugStates",
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

// Every plug hash attached to an instance, gathered from the sockets and
// plugStates components (either may be missing or empty). Hashes that hit no
// known table are ignored — only armor mods and tuning mods matter here.
function collectPlugHashes(instanceId, sockets, plugs) {
  const hashes = new Set();
  for (const socket of sockets?.[instanceId]?.sockets || []) {
    if (socket?.isEnabled !== false && socket?.plugHash) hashes.add(Number(socket.plugHash));
  }
  const plugState = plugs?.[instanceId];
  const plugList = Array.isArray(plugState) ? plugState : plugState?.plugs;
  for (const plug of plugList || []) {
    const hash = plug && typeof plug === "object" ? plug.plugHash : plug;
    if (hash) hashes.add(Number(hash));
  }
  return hashes;
}

export function normalizeApiItem(apiItem, context = {}) {
  const {
    characterClassType,
    instances = {},
    sockets = {},
    plugs = {},
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
  const rawStats = {};
  for (const [statHash, value] of Object.entries(instance.stats || {})) {
    const stat = STAT_HASH_TO_NAME[Number(statHash)];
    if (stat) rawStats[stat] = value;
  }

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
  const archetypeId = inferArchetypeFromStats(rawStats);
  const tertiary = inferTertiary(rawStats, archetypeId);
  const framework = getFrameworkStats(archetypeId, tertiary);

  const energy = instance.energyCapacity;
  const masterworkTier = Number(
    energy && typeof energy === "object" ? energy.energyCapacity : energy,
  ) || 0;
  const masterworkBonus = Math.min(5, Math.max(0, masterworkTier));

  // Bungie instance stats include the masterwork bonus on the three
  // non-framework stats; subtract it to recover the rolled base stats
  // (inverse of getEffectiveBaseStats, dim-csv.mjs:146-157).
  //
  // Framework-null decision: when the framework can't be inferred (tertiary
  // inference failed), keep the stats as-is — getEffectiveBaseStats returns
  // baseStats unchanged for a null framework, so subtracting here would
  // diverge from the CSV path. (A null framework also implies every
  // non-framework stat reads 0, so the masterwork bonus is 0 in any reachable
  // case and the subtraction would be a no-op anyway.)
  const baseStats = {};
  for (const stat of STATS) {
    const value = rawStats[stat] || 0;
    baseStats[stat] = framework && !framework.has(stat) ? value - masterworkBonus : value;
  }

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
  for (const plugHash of collectPlugHashes(instanceId, sockets, plugs)) {
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

  // displayedStats = instance stats (base + masterwork) + tuning + mod, the
  // forward equivalent of the dim-csv inference formula (dim-csv.mjs:204-209).
  const tuningChanges = {};
  if (tuningMode === "plus3" && framework) {
    for (const stat of STATS) {
      if (!framework.has(stat)) tuningChanges[stat] = 1;
    }
  } else if (tuningMode === "shift" && tuningFrom && tuningTo) {
    tuningChanges[tuningFrom] = -5;
    tuningChanges[tuningTo] = 5;
  }
  const displayedStats = {};
  for (const stat of STATS) {
    displayedStats[stat] = (rawStats[stat] || 0)
      + (tuningChanges[stat] || 0)
      + (armorModStat === stat ? armorModSize : 0);
  }

  const set = getArmorSetByItemHash(hash);
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
    tuningStat: null,
    baseStats,
    masterworkTier,
    displayedStats,
    owner,
    equipped: Boolean(equipped),
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
    characters[characterId] = { classType: character?.classType ?? null };
  }
  const instances = data.itemComponents?.instances?.data ?? {};
  const sockets = data.itemComponents?.sockets?.data ?? {};
  const plugs = data.itemComponents?.plugStates?.data ?? {};
  const catalog = getCatalogIndex();

  const byInstance = new Map();
  const push = (apiItem, characterClassType, owner, equipped) => {
    const id = String(apiItem?.itemInstanceId ?? "");
    if (!id) return;
    if (byInstance.has(id) && !equipped) return; // keep the first non-equipped copy
    const item = normalizeApiItem(apiItem, {
      characterClassType,
      instances,
      sockets,
      plugs,
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
  };
}
