import {
  ARCHETYPES,
  EXOTIC_CLASSES,
  STATS,
  normalizeArchetypeId,
} from "./armor-model.mjs";
import { getArmorSetByItemHash } from "./armor-sets.mjs";

// ============================================================
// DIM CSV EXPORT PARSING
// ============================================================

// RFC 4180 style parser; DIM exports use CRLF, quoted fields, and doubled
// quotes inside quoted values. A UTF-8 BOM is stripped before parsing.
export function parseCsv(text) {
  const source = String(text).replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return [];
  const [header, ...data] = rows;
  return data.map(cells => {
    const record = {};
    header.forEach((name, index) => {
      record[name] = cells[index] ?? "";
    });
    return record;
  });
}

const DIM_STAT_COLUMNS = [
  ["weapons", "Weapons"],
  ["health", "Health"],
  ["class", "Class"],
  ["grenade", "Grenade"],
  ["super", "Super"],
  ["melee", "Melee"],
];

const SLOT_BY_NAME = new Map([
  ["头盔", "helmet"], ["頭盔", "helmet"], ["Helmet", "helmet"],
  ["臂铠", "arms"], ["臂鎧", "arms"], ["Gauntlets", "arms"],
  ["胸部护甲", "chest"], ["胸部護甲", "chest"], ["胸部防具", "chest"], ["Chest Armor", "chest"],
  ["腿部护甲", "legs"], ["腿部護甲", "legs"], ["腿部防具", "legs"], ["Leg Armor", "legs"],
  ["猎人披风", "classItem"], ["獵人披風", "classItem"], ["Hunter Cloak", "classItem"],
  ["泰坦印记", "classItem"], ["泰坦印記", "classItem"], ["Titan Mark", "classItem"],
  ["术士臂环", "classItem"], ["術士臂環", "classItem"], ["Warlock Bond", "classItem"],
]);

const CLASS_BY_NAME = new Map([
  ["泰坦", "titan"], ["Titan", "titan"],
  ["猎人", "hunter"], ["獵人", "hunter"], ["Hunter", "hunter"],
  ["术士", "warlock"], ["術士", "warlock"], ["Warlock", "warlock"],
]);

const STAT_BY_NAME = new Map();
for (const stat of STATS) {
  STAT_BY_NAME.set(stat, stat);
}
for (const [stat, column] of DIM_STAT_COLUMNS) {
  STAT_BY_NAME.set(column, stat);
  STAT_BY_NAME.set(column.toLowerCase(), stat);
}
STAT_BY_NAME.set("生命值", "health");
STAT_BY_NAME.set("近战", "melee");
STAT_BY_NAME.set("手雷", "grenade");
STAT_BY_NAME.set("超能", "super");
STAT_BY_NAME.set("职业", "class");
STAT_BY_NAME.set("武器", "weapons");
STAT_BY_NAME.set("生命", "health");
STAT_BY_NAME.set("近戰", "melee");
STAT_BY_NAME.set("手榴彈", "grenade");
STAT_BY_NAME.set("超能力", "super");
STAT_BY_NAME.set("職業", "class");
STAT_BY_NAME.set("武器", "weapons");

const EXOTIC_RARITY_NAMES = new Set(["exotic", "异域", "異域"]);

export function parseBaseStats(record) {
  const stats = {};
  for (const [stat, column] of DIM_STAT_COLUMNS) {
    const value = parseInt(record[`${column} (Base)`] ?? record[column], 10);
    stats[stat] = Number.isFinite(value) && value > 0 ? value : 0;
  }
  return stats;
}

function parseDisplayedStats(record) {
  if (!DIM_STAT_COLUMNS.every(([, column]) => String(record[column] ?? "").trim() !== "")) {
    return null;
  }
  return Object.fromEntries(DIM_STAT_COLUMNS.map(([stat, column]) => {
    const value = parseInt(record[column], 10);
    return [stat, Number.isFinite(value) ? value : 0];
  }));
}

// DIM exports both the rolled base stats and the equipped values. The latter
// include the tuning shift and armor stat mod, so subtract those layers in
// order and only accept an unambiguous +5/+10 residual.
function getFrameworkStats(archetypeId, tertiary) {
  const archetype = ARCHETYPES.find(item => item.id === archetypeId);
  if (!archetype || !STATS.includes(tertiary)) return null;
  return new Set([archetype.primary, archetype.secondary, tertiary]);
}

export function getEffectiveBaseStats(item) {
  const baseStats = { ...item.baseStats };
  const framework = getFrameworkStats(item.archetypeId, item.tertiary);
  if (!framework) return baseStats;
  // Masterwork grants +1 per level to the three stats outside the framework,
  // capped at +5 per stat (Bungie Update 9.0.0.1).
  const masterworkTier = Math.min(5, Math.max(0, Number(item.masterworkTier) || 0));
  for (const stat of STATS) {
    if (!framework.has(stat)) baseStats[stat] += masterworkTier;
  }
  return baseStats;
}

// DIM's displayed columns contain four layers: the raw roll, Tier 5
// masterwork bonuses, tuning, and one armor stat mod. Enumerate the legal
// tuning/mod combinations and accept only an exact, unique reconstruction.
function inferInstalledModifiers(item, displayedStats, tuningStat) {
  if (!displayedStats) {
    return { modifierInference: { status: "unavailable", candidateCount: 0 } };
  }
  const framework = getFrameworkStats(item.archetypeId, item.tertiary);
  if (!framework) {
    return { modifierInference: { status: "unavailable", candidateCount: 0 } };
  }
  const effectiveBaseStats = getEffectiveBaseStats(item);
  const tunings = [{
    tuningMode: "plus3",
    tuningFrom: null,
    tuningTo: null,
    changes: Object.fromEntries(STATS.map(stat => [stat, framework.has(stat) ? 0 : 1])),
  }, {
    // No Tuning Mod installed: the displayed stats carry no tuning layer, so
    // nothing changes here. The piece's fixed +5 roll comes from the DIM
    // "Tuning Stat" column (null when the export omits it).
    tuningMode: "shift",
    tuningFrom: null,
    tuningTo: tuningStat || null,
    changes: {},
  }];
  for (const from of STATS) {
    for (const to of STATS) {
      if (from === to || (tuningStat && to !== tuningStat)) continue;
      tunings.push({
        tuningMode: "shift",
        tuningFrom: from,
        tuningTo: to,
        changes: { [from]: -5, [to]: 5 },
      });
    }
  }
  const mods = [{ armorModSize: 0, armorModStat: null }];
  for (const armorModSize of [5, 10]) {
    for (const armorModStat of STATS) mods.push({ armorModSize, armorModStat });
  }

  const candidates = [];
  for (const tuning of tunings) {
    for (const mod of mods) {
      const matches = STATS.every(stat =>
        effectiveBaseStats[stat]
          + (tuning.changes[stat] || 0)
          + (mod.armorModStat === stat ? mod.armorModSize : 0)
        === displayedStats[stat]
      );
      if (matches) candidates.push({ ...tuning, ...mod });
    }
  }
  if (candidates.length !== 1) {
    return {
      effectiveBaseStats,
      modifierInference: {
        status: candidates.length > 1 ? "ambiguous" : "no-match",
        candidateCount: candidates.length,
      },
    };
  }
  const match = { ...candidates[0] };
  delete match.changes;
  return {
    ...match,
    effectiveBaseStats,
    modifierInference: { status: "exact", candidateCount: 1 },
  };
}

function cleanId(value) {
  return String(value || "").replace(/^"|"$/g, "").trim();
}

// Best-fit archetype from an actual stat roll when DIM leaves the Archetype
// column empty (legacy armor). Scores the two defining stats of each archetype.
export function inferArchetypeFromStats(baseStats) {
  let best = null;
  let bestScore = -1;
  for (const archetype of ARCHETYPES) {
    const score = (baseStats[archetype.primary] || 0) * 2 + (baseStats[archetype.secondary] || 0);
    if (score > bestScore) {
      bestScore = score;
      best = archetype.id;
    }
  }
  return bestScore > 0 ? best : null;
}

export function normalizeDimItem(record) {
  const hash = parseInt(record.Hash, 10) || 0;
  const slot = SLOT_BY_NAME.get(record.Type) || null;
  const classId = CLASS_BY_NAME.get(record.Equippable) || null;
  const baseStats = parseBaseStats(record);
  const displayedStats = parseDisplayedStats(record);
  const tuningStat = STAT_BY_NAME.get(record["Tuning Stat"]) || null;
  const set = getArmorSetByItemHash(hash);

  // Exotic Class Items (Relativism / Solipsism / Stoicism) carry a fixed
  // 30/25/20 roll: the 30/25 pair identifies the frame and the 20 stat is the
  // tertiary. DIM's Archetype column is empty for these, so derive them here.
  const exoticClassItem = Object.values(EXOTIC_CLASSES)
    .find(entry => entry.itemHash === hash) || null;
  let archetypeId = normalizeArchetypeId(record.Archetype);
  let exoticStat20 = null;
  if (exoticClassItem) {
    const stat30 = STATS.find(stat => baseStats[stat] === 30);
    const stat25 = STATS.find(stat => baseStats[stat] === 25);
    exoticStat20 = STATS.find(stat => baseStats[stat] === 20) || null;
    const frame = ARCHETYPES.find(
      archetype => archetype.primary === stat30 && archetype.secondary === stat25
    );
    if (frame) archetypeId = frame.id;
  }

  const fallbackTertiary = STATS
    .filter(stat => {
      const archetype = ARCHETYPES.find(item => item.id === archetypeId);
      return !archetype || (stat !== archetype.primary && stat !== archetype.secondary);
    })
    .sort((left, right) => (baseStats[right] || 0) - (baseStats[left] || 0))[0];
  const tertiary = exoticClassItem
    ? (exoticStat20 || STAT_BY_NAME.get(record["Tertiary Stat"]) || fallbackTertiary)
    : (STAT_BY_NAME.get(record["Tertiary Stat"]) || fallbackTertiary || null);

  const item = {
    id: cleanId(record.Id),
    hash,
    name: record.Name || "",
    slot,
    classId,
    tier: String(record.Tier || "").trim() || "0",
    rarity: record.Rarity || "",
    // Exotic Class Items are recognized by their known item hashes in addition
    // to the Rarity column, so a localized DIM export (e.g. "异域"/"異域")
    // never loses the exotic flag — and with it the auto-lock on the piece.
    exotic: EXOTIC_RARITY_NAMES.has(String(record.Rarity || "").trim().toLowerCase()) || Boolean(exoticClassItem),
    archetypeId,
    tertiary,
    tuningStat,
    baseStats,
    masterworkTier: parseInt(record["Masterwork Tier"], 10) || 0,
    displayedStats,
    owner: record.Owner || "",
    equipped: record.Equipped === "true",
    dimLocked: record.Locked === "true",
    power: parseInt(record.Power, 10) || 0,
    setHash: set ? set.hash : null,
  };
  const normalized = { ...item, ...inferInstalledModifiers(item, displayedStats, tuningStat) };
  return {
    ...normalized,
    // Optimization assumes every candidate will be fully masterworked, while
    // modifier inference above still uses the actual tier exported by DIM.
    optimizationBaseStats: getEffectiveBaseStats({ ...normalized, masterworkTier: 5 }),
  };
}

export function sumBaseStats(item) {
  return STATS.reduce((sum, stat) => sum + (item.baseStats?.[stat] || 0), 0);
}

export function filterArmorItems(items, { classId = null, tier5Only = true } = {}) {
  return items.filter(item =>
    item.slot &&
    (!classId || item.classId === classId) &&
    (!tier5Only || item.tier === "5")
  );
}

const SLOT_ORDER = ["helmet", "arms", "chest", "legs", "classItem"];

export function detectEquippedClass(inventory) {
  const counts = new Map();
  for (const item of inventory) {
    if (item.equipped && item.classId) {
      counts.set(item.classId, (counts.get(item.classId) || 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  if (ranked.length === 0 || (ranked[1] && ranked[0][1] === ranked[1][1])) return null;
  return ranked[0][0];
}

// Current in-game loadout: equipped pieces first, then best remaining item per
// slot (highest base total, power as tie-break).
export function pickCurrentLoadout(inventory, classId = null) {
  if (!classId) {
    classId = detectEquippedClass(inventory);
    if (!classId) return [];
  }
  const eligible = filterArmorItems(inventory, { classId, tier5Only: false });
  const bySlot = new Map();
  for (const slot of SLOT_ORDER) bySlot.set(slot, []);
  for (const item of eligible) {
    if (bySlot.has(item.slot)) bySlot.get(item.slot).push(item);
  }
  const score = item => sumBaseStats(item) * 1000 + item.power;
  return SLOT_ORDER
    .map(slot => {
      const candidates = bySlot.get(slot);
      const equipped = candidates.filter(item => item.equipped);
      const pool = (equipped.length > 0 ? equipped : candidates).sort((a, b) => score(b) - score(a));
      return pool[0] || null;
    })
    .filter(Boolean);
}
