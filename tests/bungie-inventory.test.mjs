import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ARMOR_BUCKET_HASH_TO_SLOT,
  ARMOR_COMPONENTS,
  buildArmorInventory,
  extractSubclassFragments,
  normalizeApiItem,
} from "../src/core/bungie-inventory.mjs";
import { getEffectiveBaseStats } from "../src/core/dim-csv.mjs";
import { ARMOR_ITEMS } from "../src/core/armor-items.data.mjs";

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

test("exotic class item extracts its rolled perk pair from socket plugs", () => {
  // Socket plugs carry the installed "Spirit of …" perk items; the roll is
  // fixed on the instance and must survive into the solver piece.
  const apiItem = {
    bucketHash: 1585787867, // classItem
    itemHash: 2809120022,
    itemInstanceId: "9000000000000000101",
    tierType: 6,
  };
  const instances = {
    "9000000000000000101": {
      energyCapacity: 10,
      stats: {
        "144602215": 5, "392767087": 25, "1735777505": 20,
        "1943323491": 5, "2996146975": 5, "4244567218": 30,
      },
    },
  };
  const sockets = {
    "9000000000000000101": {
      sockets: [
        { plugHash: 1476923952, isEnabled: true }, // Spirit of the Assassin (left column)
        { plugHash: 3751917994, isEnabled: true }, // Spirit of the Cyrtarachne (right column)
        { plugHash: 2125798995, isEnabled: false }, // disabled socket: ignored
      ],
    },
  };
  const item = normalizeApiItem(apiItem, context({ instances, sockets, plugs: {} }));
  assert.equal(item.primaryPerkId, "assassin");
  assert.equal(item.secondaryPerkId, "cyrtarachne");
  assert.equal(item.archetypeId, "Brawler");
  assert.equal(item.exotic, true);
});

test("exotic class item stays exotic when the catalog lacks its rarity", () => {
  // Catalog missing the item (rarity falls back to ""): the known item hash
  // must still set the exotic flag so the auto-lock is not silently dropped.
  const apiItem = {
    bucketHash: 1585787867,
    itemHash: 2809120022,
    itemInstanceId: "9000000000000000102",
    tierType: 0,
  };
  const instances = { "9000000000000000102": { energyCapacity: 0, stats: {} } };
  const item = normalizeApiItem(
    apiItem,
    context({ instances, sockets: {}, plugs: {}, catalog: {} }),
  );
  assert.equal(item.exotic, true);
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

test("reads armor stats from Bungie's separate ItemStats component", () => {
  const itemInstanceId = "9000000000000000200";
  const apiItem = {
    bucketHash: 3448274439,
    itemHash: 656307180,
    itemInstanceId,
    tierType: 5,
  };
  const item = normalizeApiItem(apiItem, context({
    instances: {
      [itemInstanceId]: { energyCapacity: 10 },
    },
    itemStats: {
      [itemInstanceId]: {
        stats: {
          "144602215": { statHash: 144602215, value: 25 },
          "392767087": { statHash: 392767087, value: 10 },
          "1735777505": { statHash: 1735777505, value: 20 },
          "1943323491": { statHash: 1943323491, value: 10 },
          "2996146975": { statHash: 2996146975, value: 30 },
          "4244567218": { statHash: 4244567218, value: 10 },
        },
      },
    },
    sockets: {},
    plugs: {},
  }));

  assert.deepEqual(item.baseStats, {
    health: 5, melee: 5, grenade: 20, super: 25, class: 5, weapons: 30,
  });
  assert.equal(item.archetypeId, "Powerhouse");
  assert.equal(item.tertiary, "grenade");
  assert.equal(
    Object.values(item.displayedStats).reduce((sum, value) => sum + value, 0),
    105,
  );
});

test("framework null (tertiary inference failed) leaves baseStats untouched, matching the CSV path", () => {
  // All stats read 0, so neither archetype nor tertiary can be inferred and
  // the framework is null — despite a full masterwork tier (10). baseStats
  // must NOT subtract the masterwork bonus: dim-csv's getEffectiveBaseStats
  // returns baseStats unchanged for a null framework, and the API path is
  // its inverse (F2 review decision, bungie-inventory.mjs:162-172).
  const apiItem = {
    bucketHash: 3448274439, // helmet
    itemHash: 656307180,
    itemInstanceId: "9000000000000000009",
  };
  const instances = {
    "9000000000000000009": { energyCapacity: 10, stats: {} },
  };
  const item = normalizeApiItem(apiItem, context({ instances }));
  const allZero = { health: 0, melee: 0, grenade: 0, super: 0, class: 0, weapons: 0 };
  assert.equal(item.masterworkTier, 10);
  assert.deepEqual(item.baseStats, allZero, "no masterwork subtraction without a framework");
  assert.deepEqual(
    getEffectiveBaseStats(item),
    allZero,
    "CSV-path effective stats also leave a null-framework item unchanged",
  );
  assert.deepEqual(item.optimizationBaseStats, allZero);
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

test("vault item in the General bucket (138197802) recovers slot and class from the catalog", () => {
  // Vault items all report the account-wide "General" bucket (138197802)
  // instead of their equipment-slot bucket; without the catalog fallback the
  // slot lookup returns null and every vault armor piece is dropped.
  const apiItem = {
    bucketHash: 138197802, // General (vault)
    itemHash: 2405271938, // Synthetic Legs (warlock legs)
    itemInstanceId: "9000000000000000103",
  };
  const instances = { "9000000000000000103": { energyCapacity: 0, stats: {} } };
  const catalog = {
    2405271938: {
      name: { zh: "合成护腿", zhCht: "合成護腿", en: "Synthetic Legs" },
      rarity: "Legendary",
      tierType: 5,
      bucketHash: 20886954, // legs
      classType: 2, // warlock
    },
  };
  const item = normalizeApiItem(
    apiItem,
    context({
      characterClassType: undefined,
      instances,
      sockets: {},
      plugs: {},
      catalog,
      owner: "Vault",
    }),
  );
  assert.equal(item.slot, "legs");
  assert.equal(item.classId, "warlock");
  assert.equal(item.owner, "Vault");
  assert.equal(item.equipped, false);
  // A vault item whose hash is not in the catalog stays filtered (no slot).
  assert.equal(
    normalizeApiItem(
      { ...apiItem, itemHash: 9000000001, itemInstanceId: "9000000000000000104" },
      context({ characterClassType: undefined, instances, sockets: {}, plugs: {}, catalog }),
    ),
    null,
  );
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

// --- T8: bucket hash table locked to the real Bungie Manifest ---

test("ARMOR_BUCKET_HASH_TO_SLOT matches the real Manifest bucket definitions (T8)", () => {
  // Verified 2026-08-09 against the DestinyInventoryBucketDefinition tables
  // of manifest 244213.26.06.29.2000-1-bnet.65583 (zh-chs + en aggregates):
  //   Helmet / 头盔, Gauntlets / 臂铠, Chest Armor / 胸部护甲,
  //   Leg Armor / 腿部护甲, Class Armor / 职业护甲
  // — all category 3 (Equippable), itemCount 10, location 1. Any change here
  // means Bungie renumbered the armor buckets, which would break inventory
  // mapping app-wide.
  assert.deepEqual(ARMOR_BUCKET_HASH_TO_SLOT, {
    3448274439: "helmet",
    3551918588: "arms",
    14239492: "chest",
    20886954: "legs",
    1585787867: "classItem",
  });
});

test("exotic class item 2809120022 (Relativism) lives in the classItem bucket in catalog and fixture (T8)", () => {
  // The real Manifest item definition reports bucketTypeHash 1585787867
  // (Class Armor / 职业护甲) for Relativism; the local catalog entry and the
  // synthetic fixture must agree so the exotic class item is never filtered.
  const catalogEntry = ARMOR_ITEMS.find(item => item.hash === 2809120022);
  assert.equal(catalogEntry?.bucketHash, 1585787867);
  assert.equal(byInstance("1000000000000000001").bucketHash, 1585787867);
  assert.equal(ARMOR_BUCKET_HASH_TO_SLOT[1585787867], "classItem");
});

// --- T9: buildArmorInventory over the whole GetProfile response ---

const EXPECTED_ARMOR_COMPONENTS = [
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

test("ARMOR_COMPONENTS includes every Bungie component needed for armor stats", () => {
  assert.equal(ARMOR_COMPONENTS.length, 10);
  assert.deepEqual([...ARMOR_COMPONENTS].sort(), [...EXPECTED_ARMOR_COMPONENTS].sort());
});

test("ARMOR_COMPONENTS never lists the pseudo-components ProfilePlugSets/CharacterPlugSets", () => {
  // They are not DestinyComponentType values; they ride along with ItemSockets.
  assert.equal(ARMOR_COMPONENTS.includes("ProfilePlugSets"), false);
  assert.equal(ARMOR_COMPONENTS.includes("CharacterPlugSets"), false);
});

test("buildArmorInventory merges vault, character inventory and equipment without duplicate instanceIds", () => {
  const result = buildArmorInventory(fixture);
  const ids = result.items.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, "instanceIds must be unique");
  assert.equal(ids.length, 5, "5 armor pieces across all sources (3 weapons filtered)");
  // instance 1000000000000000003 sits in both the vault and character 1's inventory.
  assert.equal(ids.filter(id => id === "1000000000000000003").length, 1);
});

test("buildArmorInventory marks equipped pieces and keeps their owner", () => {
  const result = buildArmorInventory(fixture);
  const equipped = result.items.filter(item => item.equipped);
  assert.equal(equipped.length, 1);
  assert.equal(equipped[0].id, "1000000000000000001");
  assert.equal(equipped[0].owner, "2305843009471208001");
  // A never-equipped duplicate keeps the first (vault) copy.
  const duplicated = result.items.find(item => item.id === "1000000000000000003");
  assert.equal(duplicated.owner, "Vault");
  assert.equal(duplicated.equipped, false);
});

test("buildArmorInventory filters every weapon row", () => {
  const result = buildArmorInventory(fixture);
  assert.ok(result.items.every(item => item.slot), "every kept item must be armor");
  for (const weaponId of ["1000000000000000005", "1000000000000000006", "1000000000000000007"]) {
    assert.ok(!result.items.some(item => item.id === weaponId), weaponId);
  }
});

test("buildArmorInventory handles an empty profile without throwing", () => {
  const result = buildArmorInventory({ ErrorCode: 1, Response: { data: {} } });
  assert.deepEqual(result.items, []);
  assert.equal(result.membershipType, null);
  assert.equal(result.membershipId, null);
  assert.deepEqual(result.characters, {});
});

test("buildArmorInventory returns membership and character summaries", () => {
  const result = buildArmorInventory(fixture);
  assert.equal(result.membershipType, 3);
  assert.equal(result.membershipId, "4611686018470000000");
  assert.deepEqual(result.characters, {
    "2305843009471208001": { classType: 1 },
    "2305843009471208002": { classType: 2 },
  });
});

test("buildArmorInventory exposes Bungie's aggregate six stats for each character", () => {
  const characterId = "2305843009471208999";
  const result = buildArmorInventory({
    Response: {
      data: {
        characters: {
          data: {
            [characterId]: {
              classType: 1,
              stats: {
                "144602215": 94,
                "392767087": 61,
                "1735777505": 83,
                "1943323491": 105,
                "2996146975": 116,
                "4244567218": 72,
              },
            },
          },
        },
      },
    },
  });

  assert.deepEqual(result.characters[characterId].stats, {
    health: 61,
    melee: 72,
    grenade: 83,
    super: 94,
    class: 105,
    weapons: 116,
  });
});

test("catalog rarity infers tierType: exotic and legendary armor both land on tier 5", () => {
  // Uses the REAL armor-items.data.mjs catalog (no tierType field), so the
  // rarity -> tierType inference must turn exotic/legendary into tier "5".
  const result = buildArmorInventory(fixture);
  const exotic = result.items.find(item => item.hash === 2809120022);
  const legendary = result.items.find(item => item.hash === 656307180);
  assert.equal(exotic.tier, "5");
  assert.equal(exotic.exotic, true);
  assert.equal(legendary.tier, "5");
  assert.equal(legendary.exotic, false);
});

// --- T7: real desensitized GetProfile fixture (tests/fixtures/profile-fixture.json) ---
//
// Captured from a real GetProfile call for account 時南ovo (membershipType 3,
// 1448 items, 1304 instanceIds desensitized). Its envelope differs from the
// synthetic fixture: components hang directly off Response (Response.profile,
// Response.profileInventory, ...) with no `Response.data` wrapper, so
// buildArmorInventory must unwrap both shapes. The desensitized instanceIds
// are sequential 1000... placeholders (19-20 digits), never real Bungie IDs
// (2305843... / 6917529...).
const realFixture = JSON.parse(
  readFileSync(new URL("./fixtures/profile-fixture.json", import.meta.url), "utf8"),
);

test("real fixture: buildArmorInventory unwraps the no-data envelope and returns a real inventory", () => {
  const result = buildArmorInventory(realFixture);
  assert.equal(result.membershipType, 3);
  assert.equal(result.membershipId, "9000000000000000001");
  assert.ok(Object.keys(result.characters).length >= 1);
  // A real 1448-item account holds far more armor than the synthetic 5.
  assert.ok(result.items.length > 50, `expected >50 armor pieces, got ${result.items.length}`);
  const ids = result.items.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, "instanceIds must be unique");
});

test("real fixture: every item has the full solver shape and desensitized ids", () => {
  const result = buildArmorInventory(realFixture);
  const SLOTS = new Set(Object.values(ARMOR_BUCKET_HASH_TO_SLOT));
  for (const item of result.items) {
    assert.match(item.id, /^1000\d+$/, `instanceId must be a desensitized placeholder: ${item.id}`);
    assert.ok(item.hash > 0 && Number.isInteger(item.hash), item.id);
    assert.ok(item.name.length > 0, `${item.id} must have a name or item_<hash> fallback`);
    assert.ok(SLOTS.has(item.slot), `${item.id} slot ${item.slot} must be a known armor slot`);
    assert.ok(["0", "1", "2", "3", "4", "5"].includes(item.tier), `${item.id} tier ${item.tier}`);
    for (const stat of ["health", "melee", "grenade", "super", "class", "weapons"]) {
      assert.equal(typeof item.baseStats[stat], "number", `${item.id} baseStats.${stat}`);
      assert.equal(typeof item.displayedStats[stat], "number", `${item.id} displayedStats.${stat}`);
    }
  }
});

test("real fixture: hunter exotic class item 2809120022 is recognized as classItem and exotic", () => {
  const result = buildArmorInventory(realFixture);
  const exotic = result.items.filter(item => item.hash === 2809120022);
  assert.ok(exotic.length >= 1, "real account owns at least one Relativism");
  for (const item of exotic) {
    assert.equal(item.slot, "classItem");
    assert.equal(item.exotic, true, `${item.id} must carry the exotic flag`);
    assert.equal(item.tier, "5", "exotic tierType 6 maps to solver tier 5");
    assert.equal(item.classId, "hunter");
  }
});

test("real fixture: vault armor (General bucket 138197802) is recovered via the catalog", () => {
  const vaultItems = realFixture.Response.profileInventory.data.items.filter(item => item.itemInstanceId);
  // Every instanced vault item reports the account-wide "General" bucket.
  assert.ok(vaultItems.length > 500, `vault holds ${vaultItems.length} instanced items`);
  assert.ok(
    vaultItems.every(item => item.bucketHash === 138197802),
    "all instanced vault items carry the General bucket hash",
  );
  const vaultArmorIds = new Set(vaultItems.map(item => String(item.itemInstanceId)));
  const result = buildArmorInventory(realFixture);
  const vaultArmor = result.items.filter(item => vaultArmorIds.has(item.id));
  // ~452 of the 992 instanced vault items are armor; before the catalog
  // fallback every one of them was dropped, leaving only ~73 character
  // pieces instead of the account's 500+.
  assert.ok(vaultArmor.length >= 400, `expected ~452 vault armor pieces, got ${vaultArmor.length}`);
  const SLOTS = new Set(Object.values(ARMOR_BUCKET_HASH_TO_SLOT));
  for (const item of vaultArmor) {
    assert.ok(SLOTS.has(item.slot), `${item.id} must resolve a real armor slot, got ${item.slot}`);
    assert.ok(item.classId, `${item.id} vault armor must resolve a class from the catalog`);
    assert.equal(item.owner, "Vault");
    assert.equal(item.equipped, false);
  }
  assert.ok(result.items.length > 500, `account armor >500, got ${result.items.length}`);
});

// --- Subclass fragment recognition (T12) ---
//
// extractSubclassFragments walks each character's equipped subclass item
// (bucket 3284755031), reads its socket plugs, and maps them through
// FRAGMENT_STAT_CHANGES. The real fixture carries three subclasses; the
// synthetic one carries none.

test("extractSubclassFragments returns an empty map for a profile without subclasses", () => {
  assert.deepEqual(extractSubclassFragments(fixture), {});
  assert.deepEqual(extractSubclassFragments({ ErrorCode: 1, Response: { data: {} } }), {});
});

test("real fixture: every character's subclass resolves stat adjustments", () => {
  const result = extractSubclassFragments(realFixture);
  // The three fixture characters carry real equipped subclasses; their plugs
  // resolve through FRAGMENT_STAT_CHANGES (installed Aspect/Fragment hashes).
  // Assertions are derived from the fixture's own socket plugs:
  //   Hunter  ...: Facet of Purpose (class -10); Facet of Dawn/Protection cancel
  //   Warlock...: Facet of Purpose (class -10), Facet of Protection (melee +10),
  //               Facet of Dominance (grenade -10)
  //   Titan   ...: Whisper of Hunger (melee -20), Whisper of Conduction (super +10, health +10)
  assert.deepEqual(result, {
    "9000000000000000002": { class: -10 },
    "9000000000000000003": { class: -10, melee: 10, grenade: -10 },
    "9000000000000000004": { melee: -20, super: 10, health: 10 },
  });
});
