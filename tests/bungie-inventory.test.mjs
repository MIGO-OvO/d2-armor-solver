import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeApiItem } from "../src/core/bungie-inventory.mjs";

// Synthetic GetProfile fixture (tests/fixtures/synthetic-profile-fixture.json):
// hand-built to the Bungie API shape until a real fixture lands (needs a user
// API key). All expected values below are computed from the fixture's own
// stats, so a broken mapping fails loudly.
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/synthetic-profile-fixture.json", import.meta.url), "utf8"),
);
const { data } = fixture.Response;
const instances = data.itemComponents.instances.data;
const sockets = data.itemComponents.sockets.data;
const plugs = data.itemComponents.plugStates.data;

const HUNTER = "2305843009471208001";

// In-memory catalog: armor-items.data.mjs does not exist yet (T6 happy path
// not run), so tests provide the same shape it would export. Name keys are
// the REAL product format `{ zh, zhCht, en }` (fetch-armor-item-data.mjs
// nameKey), NOT page-language keys.
const CATALOG = {
  2809120022: {
    name: { zh: "相对主义", zhCht: "相對主義", en: "Relativism" },
    rarity: "Exotic",
    tierType: 6,
  },
  656307180: {
    name: { zh: "至高狂徒面具", zhCht: "至高狂徒面具", en: "Eidolon Pursuant Mask" },
    rarity: "Legendary",
    tierType: 5,
  },
  99093622: {
    name: { zh: "烬火坠落之盔", zhCht: "燼火墜落之盔", en: "Fallen Suns Helmet" },
    rarity: "Legendary",
    tierType: 5,
  },
  2405271938: {
    name: { zh: "合成护腿", zhCht: "合成護腿", en: "Synthetic Legs" },
    rarity: "Legendary",
    tierType: 5,
  },
};

const context = (extra = {}) => ({
  characterClassType: 1,
  instances,
  sockets,
  plugs,
  catalog: CATALOG,
  language: "zh-chs",
  owner: "Hunter",
  ...extra,
});

const allItems = [
  ...data.profileInventory.data.items,
  ...data.characterInventories.data[HUNTER].items,
  ...data.characterEquipment.data[HUNTER].items,
];
const byInstance = id => allItems.find(item => String(item.itemInstanceId) === id);

test("armor items map to the full solver shape with correct types", () => {
  const item = normalizeApiItem(byInstance("1000000000000000002"), context());
  assert.equal(item.id, "1000000000000000002");
  assert.equal(typeof item.hash, "number");
  assert.equal(typeof item.name, "string");
  assert.equal(item.name, "至高狂徒面具"); // zh key of the catalog entry
  assert.equal(item.slot, "helmet");
  assert.equal(item.classId, "hunter");
  assert.equal(typeof item.tier, "string");
  assert.equal(typeof item.rarity, "string");
  assert.equal(typeof item.exotic, "boolean");
  assert.equal(typeof item.archetypeId, "string");
  assert.equal(typeof item.tertiary, "string");
  assert.equal(item.tuningStat, null);
  assert.equal(typeof item.masterworkTier, "number");
  assert.equal(typeof item.owner, "string");
  assert.equal(typeof item.equipped, "boolean");
  assert.equal(typeof item.dimLocked, "boolean");
  assert.equal(typeof item.power, "number");
  assert.ok(item.setHash === null || typeof item.setHash === "number");
  assert.ok(item.tuningMode === null || typeof item.tuningMode === "string");
  assert.ok(item.tuningFrom === null || typeof item.tuningFrom === "string");
  assert.ok(item.tuningTo === null || typeof item.tuningTo === "string");
  assert.equal(typeof item.armorModSize, "number");
  assert.ok(item.armorModStat === null || typeof item.armorModStat === "string");
  assert.deepEqual(item.modifierInference, { status: "exact", candidateCount: 1 });
  for (const stat of ["health", "melee", "grenade", "super", "class", "weapons"]) {
    assert.equal(typeof item.baseStats[stat], "number");
    assert.equal(typeof item.displayedStats[stat], "number");
    assert.equal(typeof item.optimizationBaseStats[stat], "number");
  }
});

test("tierType 6 (Exotic) maps to tier \"5\" so tier5Only never drops exotics (C3 regression)", () => {
  const item = normalizeApiItem(byInstance("1000000000000000001"), context());
  assert.equal(item.tier, "5");
});

test("hunter exotic class item 2809120022 resolves frame, exotic flag and tier", () => {
  // This item sits in CharacterEquipment; T9 wires equipped from that set.
  const item = normalizeApiItem(byInstance("1000000000000000001"), context({ equipped: true }));
  assert.equal(item.tier, "5");
  assert.equal(item.rarity, "Exotic");
  assert.equal(item.exotic, true);
  // Fixed 30/25/20 roll: melee 30 / health 25 = Brawler, grenade 20 tertiary.
  assert.equal(item.archetypeId, "Brawler");
  assert.equal(item.tertiary, "grenade");
  assert.equal(item.classId, "hunter");
  assert.equal(item.equipped, true);
  assert.equal(item.power, 2010);
});

test("+10 stat mod plug resolves armorModSize/armorModStat forward from sockets+plugStates", () => {
  const item = normalizeApiItem(byInstance("1000000000000000003"), context());
  assert.equal(item.armorModSize, 10);
  assert.equal(item.armorModStat, "weapons");
  assert.equal(item.modifierInference.status, "exact");
  assert.equal(item.tuningMode, null);
});

test("tuning mod plug resolves tuningFrom/tuningTo forward", () => {
  const item = normalizeApiItem(byInstance("1000000000000000004"), context());
  assert.equal(item.tuningMode, "shift");
  // TUNING_MOD_HASH_BY_TUNING key "health:weapons" = +5 health (to), -5 weapons (from).
  assert.equal(item.tuningFrom, "weapons");
  assert.equal(item.tuningTo, "health");
  assert.equal(item.armorModSize, 0);
  assert.equal(item.armorModStat, null);
});

test("masterwork tier 10 is kept; baseStats subtract the +5 non-framework bonus", () => {
  const item = normalizeApiItem(byInstance("1000000000000000002"), context());
  assert.equal(item.masterworkTier, 10);
  // Powerhouse weapons30/super25 + tertiary grenade20 stay untouched;
  // health/melee/class each drop from 10 to 5 (10 - masterwork bonus 5).
  assert.deepEqual(item.baseStats, {
    health: 5, melee: 5, grenade: 20, super: 25, class: 5, weapons: 30,
  });
});

test("name resolves per page language: zh-chs->zh, zh-cht->zhCht, en->en, unknown->en", () => {
  const item = byInstance("1000000000000000004");
  assert.equal(
    normalizeApiItem(item, context({ language: "zh-chs" })).name,
    "合成护腿",
  );
  assert.equal(
    normalizeApiItem(item, context({ language: "zh-cht" })).name,
    "合成護腿",
  );
  assert.equal(
    normalizeApiItem(item, context({ language: "en" })).name,
    "Synthetic Legs",
  );
  // Unknown page language: no mapping -> fall back to en.
  assert.equal(
    normalizeApiItem(item, context({ language: "fr" })).name,
    "Synthetic Legs",
  );
  // Data key missing for the page language -> zh -> en (getSetName pattern).
  const partial = {
    ...CATALOG,
    2405271938: {
      ...CATALOG[2405271938],
      name: { zh: "合成护腿", en: "Synthetic Legs" },
    },
  };
  assert.equal(
    normalizeApiItem(item, context({ catalog: partial, language: "zh-cht" })).name,
    "合成护腿",
  );
});

test("missing catalog entry falls back to item_<hash> (and catalog:null too)", () => {
  const uncataloged = normalizeApiItem(byInstance("1000000000000000008"), context());
  assert.equal(uncataloged.name, "item_123456789");
  assert.equal(uncataloged.tier, "0");
  assert.equal(uncataloged.rarity, "");
  const noCatalog = normalizeApiItem(byInstance("1000000000000000002"), context({ catalog: null }));
  assert.equal(noCatalog.name, "item_656307180");
});

test("non-armor buckets (weapons) are filtered to null", () => {
  for (const id of ["1000000000000000005", "1000000000000000006", "1000000000000000007"]) {
    assert.equal(normalizeApiItem(byInstance(id), context()), null, id);
  }
});

test("displayedStats is the forward synthesis of base + masterwork + tuning + mod", () => {
  const modded = normalizeApiItem(byInstance("1000000000000000003"), context());
  assert.deepEqual(modded.displayedStats, {
    health: 5, melee: 5, grenade: 20, super: 25, class: 5, weapons: 40,
  });
  const tuned = normalizeApiItem(byInstance("1000000000000000004"), context());
  assert.deepEqual(tuned.displayedStats, {
    health: 30, melee: 30, grenade: 5, super: 20, class: 5, weapons: 0,
  });
});

test("optimizationBaseStats projects full masterwork (+5 per non-framework stat)", () => {
  // Powerhouse weapons30/super25, tertiary grenade: the non-framework stats
  // (health/melee/class) each gain +5.
  const legendary = normalizeApiItem(byInstance("1000000000000000002"), context());
  assert.deepEqual(legendary.optimizationBaseStats, {
    health: 10, melee: 10, grenade: 20, super: 25, class: 10, weapons: 30,
  });
  const exotic = normalizeApiItem(byInstance("1000000000000000001"), context());
  assert.deepEqual(exotic.optimizationBaseStats, {
    health: 25, melee: 30, grenade: 20, super: 10, class: 10, weapons: 10,
  });
});
