// Bungie Profile API inventory mapping (T8). Maps DestinyItemComponent
// records to exactly the same solver item shape normalizeDimItem produces
// (src/core/dim-csv.mjs), so API-sourced armor flows through the solver
// unchanged. T9's buildArmorInventory assembles the context from the
// GetProfile response; this module only maps one item at a time.

import {
  ARCHETYPES,
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
// is filtered out). Values are the long-standing Bungie bucket ids; verify
// against a real fixture when one lands.
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

  const slot = ARMOR_BUCKET_HASH_TO_SLOT[Number(apiItem.bucketHash)] || null;
  if (!slot) return null;

  const hash = Number(apiItem.itemHash) || 0;
  const instanceId = String(apiItem.itemInstanceId ?? "");
  const instance = instances?.[instanceId] || {};
  const rawStats = {};
  for (const [statHash, value] of Object.entries(instance.stats || {})) {
    const stat = STAT_HASH_TO_NAME[Number(statHash)];
    if (stat) rawStats[stat] = value;
  }

  const entry = catalog?.[hash] || null;
  const tierType = entry?.tierType ?? apiItem.tierType ?? 0;
  const rarity = entry?.rarity ?? "";
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
  const baseStats = {};
  for (const stat of STATS) {
    const value = rawStats[stat] || 0;
    baseStats[stat] = framework && !framework.has(stat) ? value - masterworkBonus : value;
  }

  // Forward tuning/mod inference from the installed plug hashes (Metis C1).
  let tuningMode = null;
  let tuningFrom = null;
  let tuningTo = null;
  let armorModSize = 0;
  let armorModStat = null;
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
    classId: CLASS_BY_TYPE[characterClassType] || null,
    // tierType 5 and 6 (Legendary and Exotic) are both solver tier "5", so
    // the tier5Only filter never drops exotics (Metis C3 regression).
    tier: tierType === 5 || tierType === 6 ? "5" : String(tierType),
    rarity,
    exotic: String(rarity).toLowerCase() === "exotic",
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
