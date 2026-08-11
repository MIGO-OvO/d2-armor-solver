import assert from "node:assert/strict";
import test from "node:test";
import {
  detectEquippedClass,
  filterArmorItems,
  normalizeDimItem,
  parseCsv,
  pickCurrentLoadout,
  sumBaseStats,
} from "../src/core/dim-csv.mjs";
import { createUpgradePieceFromItem } from "../src/core/upgrade-optimizer.mjs";
import { getManualUpgradeArmorTotals } from "../src/core/upgrade-optimizer.mjs";

const CSV_FIXTURE = [
  "Name,Hash,Id,Rarity,Tier,Type,Equippable,Archetype,Tertiary Stat,Tuning Stat,Masterwork Tier,Owner,Equipped,Power,Weapons,Health,Class,Grenade,Super,Melee,Total,Weapons (Base),Health (Base),Class (Base),Grenade (Base),Super (Base),Melee (Base),Total (Base)",
  '至高狂徒面具,656307180,"6917530190483245125",Legendary,5,头盔,猎人,高能者,super,melee,0,Vault,false,532,0,0,30,20,0,25,75,0,0,30,20,0,25,75',
  '移民号陨落头盔,99093622,"6917530195361849602",Legendary,5,头盔,猎人,突击手,,super,0,Hunter(549),true,545,20,0,0,25,30,0,75,20,0,0,25,30,0,75',
  '奥菲斯钻机,2405271938,"6917530193439146518",Exotic,5,腿部护甲,猎人,搏击手,super,,0,Vault,false,263,0,25,0,0,20,30,75,0,25,0,0,20,30,75',
  '阿尔法·鲁皮之脊,1591207519,"6917529270764483310",Exotic,0,胸部护甲,泰坦,,,health,1,Vault,false,10,9,11,13,13,15,2,63,9,11,13,13,15,2,63',
].join("\n");

test("parseCsv strips the BOM and handles quotes and CRLF", () => {
  const rows = parseCsv("\uFEFFa,b\r\n\"x,y\",\"z\"\"q\"\r\n1,2");
  assert.deepEqual(rows, [
    { a: "x,y", b: 'z"q' },
    { a: "1", b: "2" },
  ]);
});

test("normalizeDimItem maps DIM fields and set membership", () => {
  const item = normalizeDimItem(parseCsv(CSV_FIXTURE)[0]);
  assert.equal(item.id, "6917530190483245125");
  assert.equal(item.hash, 656307180);
  assert.equal(item.slot, "helmet");
  assert.equal(item.classId, "hunter");
  assert.equal(item.tier, "5");
  assert.equal(item.archetypeId, "Powerhouse");
  assert.equal(item.tertiary, "super");
  assert.equal(item.tuningStat, "melee");
  assert.equal(sumBaseStats(item), 75);
  assert.ok(item.setHash);
});

test("DIM total-minus-base stats identify the installed armor mod", () => {
  const csv = [
    "Name,Hash,Id,Rarity,Tier,Type,Equippable,Archetype,Tertiary Stat,Tuning Stat,Masterwork Tier,Owner,Equipped,Power,Weapons,Health,Class,Grenade,Super,Melee,Total,Weapons (Base),Health (Base),Class (Base),Grenade (Base),Super (Base),Melee (Base),Total (Base)",
    "模组识别测试,123456789,test-mod,Legendary,5,臂铠,猎人,高能者,super,health,0,Hunter,true,500,30,25,10,10,10,15,100,20,20,10,10,10,20,90",
  ].join("\n");
  const item = normalizeDimItem(parseCsv(csv)[0]);
  const piece = createUpgradePieceFromItem(item, 1);

  assert.equal(item.tuningFrom, "melee");
  assert.equal(item.armorModSize, 10);
  assert.equal(item.armorModStat, "weapons");
  assert.equal(piece.tuningFrom, "melee");
  assert.equal(piece.armorModSize, 10);
  assert.equal(piece.armorModStat, "weapons");
});

test("DIM import subtracts Tier 5 masterwork stats before inferring an Exotic tuning and mod", () => {
  const csv = [
    "Name,Hash,Id,Rarity,Tier,Type,Equippable,Archetype,Tertiary Stat,Tuning Stat,Masterwork Tier,Owner,Equipped,Power,Weapons,Health,Class,Grenade,Super,Melee,Total,Weapons (Base),Health (Base),Class (Base),Grenade (Base),Super (Base),Melee (Base),Total (Base)",
    "Celestial Nighthawk,123,night-hawk,Exotic,5,Helmet,Hunter,Paragon,Grenade,,5,Hunter,true,500,10,0,5,20,40,25,100,0,0,0,20,30,25,75",
  ].join("\n");
  const item = normalizeDimItem(parseCsv(csv)[0]);
  const piece = createUpgradePieceFromItem(item, 0);

  assert.equal(item.modifierInference.status, "exact");
  assert.equal(piece.tuningMode, "shift");
  assert.equal(piece.tuningFrom, "health");
  assert.equal(piece.tuningTo, "weapons");
  assert.equal(piece.armorModSize, 10);
  assert.equal(piece.armorModStat, "super");
  assert.deepEqual(getManualUpgradeArmorTotals([piece]), {
    health: 0, melee: 25, grenade: 20, super: 40, class: 5, weapons: 10,
  });
});

test("DIM import recognizes +3 tuning even when the tuning column contains a stat", () => {
  const csv = [
    "Name,Hash,Id,Rarity,Tier,Type,Equippable,Archetype,Tertiary Stat,Tuning Stat,Masterwork Tier,Owner,Equipped,Power,Weapons,Health,Class,Grenade,Super,Melee,Total,Weapons (Base),Health (Base),Class (Base),Grenade (Base),Super (Base),Melee (Base),Total (Base)",
    "Plus Three Legs,456,plus-three,Legendary,5,Leg Armor,Titan,Grenadier,Melee,Class,0,Titan,true,500,1,1,1,30,35,20,88,0,0,0,30,25,20,75",
  ].join("\n");
  const item = normalizeDimItem(parseCsv(csv)[0]);
  const piece = createUpgradePieceFromItem(item, 3);

  assert.equal(item.modifierInference.status, "exact");
  assert.equal(piece.tuningMode, "plus3");
  assert.equal(piece.armorModSize, 10);
  assert.equal(piece.armorModStat, "super");
  // The piece keeps the item's ACTUAL stats: this armor is not masterworked
  // (tier 0), so no masterwork bonus is added and the totals reproduce the
  // displayed columns (75 base + 3 tuning + 10 mod = 88).
  assert.deepEqual(getManualUpgradeArmorTotals([piece]), {
    health: 1, melee: 20, grenade: 30, super: 35, class: 1, weapons: 1,
  });
  assert.deepEqual(piece.optimizationBaseStats, item.optimizationBaseStats,
    "the upgrade planner must retain the full-masterwork projection");
});

test("DIM import caps the masterwork bonus at +5 per stat regardless of tier", () => {
  const csv = [
    "Name,Hash,Id,Rarity,Tier,Type,Equippable,Archetype,Tertiary Stat,Tuning Stat,Masterwork Tier,Owner,Equipped,Power,Weapons,Health,Class,Grenade,Super,Melee,Total,Weapons (Base),Health (Base),Class (Base),Grenade (Base),Super (Base),Melee (Base),Total (Base)",
    "Capped Helm,124,cap-10,Legendary,5,Helmet,Hunter,Powerhouse,health,melee,10,Hunter,true,500,30,20,5,10,25,10,100,30,20,0,0,25,0,75",
  ].join("\n");
  const item = normalizeDimItem(parseCsv(csv)[0]);
  const piece = createUpgradePieceFromItem(item, 0);

  // Masterwork is capped at +5 per stat: the effective stats stay the same as
  // a tier-5 piece, and the tuning/mod inference still resolves exactly.
  assert.equal(item.modifierInference.status, "exact");
  assert.equal(piece.tuningFrom, "grenade");
  assert.equal(piece.tuningTo, "melee");
  assert.deepEqual(getManualUpgradeArmorTotals([piece]), {
    health: 20, melee: 10, grenade: 10, super: 25, class: 5, weapons: 30,
  });
});

test("DIM import preserves negative displayed stats caused by tuning", () => {
  const csv = [
    "Name,Hash,Id,Rarity,Tier,Type,Equippable,Archetype,Tertiary Stat,Tuning Stat,Masterwork Tier,Owner,Equipped,Power,Weapons,Health,Class,Grenade,Super,Melee,Total,Weapons (Base),Health (Base),Class (Base),Grenade (Base),Super (Base),Melee (Base),Total (Base)",
    "Tuned Legs,789,negative-stat,Legendary,5,Leg Armor,Hunter,Powerhouse,Melee,Class,0,Hunter,true,500,40,-5,5,0,25,20,85,30,0,0,0,25,20,75",
  ].join("\n");
  const item = normalizeDimItem(parseCsv(csv)[0]);

  assert.equal(item.displayedStats.health, -5);
  assert.equal(item.modifierInference.status, "exact");
  assert.equal(item.tuningFrom, "health");
  assert.equal(item.armorModStat, "weapons");
});

test("DIM import resolves a bare piece with no Tuning or armor mod installed", () => {
  const csv = [
    "Name,Hash,Id,Rarity,Tier,Type,Equippable,Archetype,Tertiary Stat,Tuning Stat,Masterwork Tier,Owner,Equipped,Power,Weapons,Health,Class,Grenade,Super,Melee,Total,Weapons (Base),Health (Base),Class (Base),Grenade (Base),Super (Base),Melee (Base),Total (Base)",
    "Bare Helm,656307180,bare-helm,Legendary,5,头盔,猎人,高能者,grenade,melee,5,Hunter,false,500,30,10,10,20,25,10,105,30,5,5,20,25,5,90",
  ].join("\n");
  const item = normalizeDimItem(parseCsv(csv)[0]);

  // No tuning/mod layer to subtract: the displayed stats equal the effective
  // base, and the piece's fixed +5 roll is the exported Tuning Stat.
  assert.equal(item.modifierInference.status, "exact");
  assert.equal(item.tuningMode, "shift");
  assert.equal(item.tuningTo, "melee");
  assert.equal(item.tuningFrom, null);
});

test("DIM import derives the Exotic Class Item frame from its fixed 30/25/20 roll", () => {
  const csv = [
    "Name,Hash,Id,Rarity,Tier,Type,Equippable,Archetype,Tertiary Stat,Tuning Stat,Masterwork Tier,Owner,Equipped,Power,Weapons,Health,Class,Grenade,Super,Melee,Total,Weapons (Base),Health (Base),Class (Base),Grenade (Base),Super (Base),Melee (Base),Total (Base)",
    'Relativism,2809120022,relativism-1,Exotic,5,猎人披风,猎人,"","","",5,Vault,false,500,10,20,10,20,10,35,105,5,25,5,20,5,30,90',
  ].join("\n");
  const item = normalizeDimItem(parseCsv(csv)[0]);

  // DIM leaves the Archetype column empty for Exotic Class Items; the frame is
  // recovered from the rolled 30/25/20 distribution (melee 30 / health 25 is
  // Brawler, grenade 20 is the tertiary) and tuning inference works after that.
  assert.equal(item.archetypeId, "Brawler");
  assert.equal(item.tertiary, "grenade");
  assert.equal(item.modifierInference.status, "exact");
  assert.equal(item.tuningMode, "shift");
  assert.equal(item.tuningTo, "melee");
});

test("exotic class item keeps the exotic flag even with a localized Rarity value", () => {
  // DIM exports the Rarity column as "Exotic", but a localized export could
  // carry "异域"/"異域". The exotic class item hash must keep it exotic so the
  // upgrade-mode auto-lock still applies.
  const csv = [
    "Name,Hash,Id,Rarity,Tier,Type,Equippable,Archetype,Tertiary Stat,Tuning Stat,Masterwork Tier,Owner,Equipped,Power,Weapons,Health,Class,Grenade,Super,Melee,Total,Weapons (Base),Health (Base),Class (Base),Grenade (Base),Super (Base),Melee (Base),Total (Base)",
    'Relativism,2809120022,relativism-2,异域,5,猎人披风,猎人,"","","",5,Vault,false,500,10,20,10,20,10,35,105,5,25,5,20,5,30,90',
  ].join("\n");
  const item = normalizeDimItem(parseCsv(csv)[0]);
  assert.equal(item.exotic, true);
  assert.equal(item.archetypeId, "Brawler");
});

test("filterArmorItems applies class and Tier 5 filters", () => {
  const items = parseCsv(CSV_FIXTURE).map(normalizeDimItem);
  assert.equal(filterArmorItems(items, { tier5Only: true }).length, 3);
  assert.equal(filterArmorItems(items, { classId: "titan", tier5Only: false }).length, 1);
  assert.equal(filterArmorItems(items, { classId: "hunter", tier5Only: true }).length, 3);
});

test("pickCurrentLoadout prefers equipped pieces per slot", () => {
  const items = parseCsv(CSV_FIXTURE).map(normalizeDimItem);
  const loadout = pickCurrentLoadout(items, "hunter");
  assert.equal(loadout.length, 2);
  assert.equal(loadout[0].id, "6917530195361849602");
  assert.equal(loadout[1].slot, "legs");
});

test("pickCurrentLoadout auto-detects the class with most equipped armor", () => {
  const items = parseCsv(CSV_FIXTURE).map(normalizeDimItem);
  const loadout = pickCurrentLoadout(items);
  assert.equal(loadout.length, 2);
  assert.equal(loadout[0].id, "6917530195361849602");
  assert.ok(loadout.every(item => item.classId === "hunter"));
});

test("equipped class detection refuses an ambiguous multi-character export", () => {
  const hunter = normalizeDimItem(parseCsv(CSV_FIXTURE)[1]);
  const titan = { ...hunter, id: "titan-copy", classId: "titan" };
  assert.equal(detectEquippedClass([hunter, titan]), null);
  assert.deepEqual(pickCurrentLoadout([hunter, titan]), []);
});
