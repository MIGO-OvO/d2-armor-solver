// Central localization contract for official Armor 3.0 terminology.
//
// Names with a Bungie Manifest hash are transcribed from the three locale
// displayProperties values. Do not derive these names with Simplified /
// Traditional Chinese conversion. DIM and light.gg spellings belong only in
// compatibility aliases, never in the canonical display-name table.

export const SUPPORTED_LANGUAGES = Object.freeze(["zh-chs", "zh-cht", "en"]);

export const TERMINOLOGY = Object.freeze({
  armor: Object.freeze({ "zh-chs": "护甲", "zh-cht": "防具", en: "Armor" }),
  legendaryArmor: Object.freeze({ "zh-chs": "传说护甲", "zh-cht": "傳說防具", en: "Legendary Armor" }),
  exoticArmor: Object.freeze({ "zh-chs": "异域护甲", "zh-cht": "異域防具", en: "Exotic Armor" }),
  exoticClassItem: Object.freeze({ "zh-chs": "异域职业物品", "zh-cht": "異域職業物品", en: "Exotic Class Item" }),
  armorArchetype: Object.freeze({ "zh-chs": "护甲框架", "zh-cht": "防具原型", en: "Armor Archetype" }),
  primaryStat: Object.freeze({ "zh-chs": "主要属性", "zh-cht": "主要數值", en: "Primary Stat" }),
  secondaryStat: Object.freeze({ "zh-chs": "次要属性", "zh-cht": "次要數值", en: "Secondary Stat" }),
  tertiaryStat: Object.freeze({ "zh-chs": "第三属性", "zh-cht": "第三數值", en: "Tertiary Stat" }),
  masterwork: Object.freeze({ "zh-chs": "大师杰作", "zh-cht": "大師之作", en: "Masterwork" }),
  tuning: Object.freeze({ "zh-chs": "调整", "zh-cht": "調校", en: "Tuning" }),
  tuningStat: Object.freeze({ "zh-chs": "调整属性", "zh-cht": "調校數值", en: "Tuning Stat" }),
  tuningMod: Object.freeze({ "zh-chs": "调整模组", "zh-cht": "調校模組", en: "Tuning Mod" }),
  tuningDirection: Object.freeze({ "zh-chs": "调整方向", "zh-cht": "調校方向", en: "Tuning direction" }),
  tuningModSlot: Object.freeze({ "zh-chs": "调整模组插槽", "zh-cht": "調校模組欄位", en: "Tuning Mod Slot" }),
  armorMod: Object.freeze({ "zh-chs": "护甲模组", "zh-cht": "防具模組", en: "Armor Mod" }),
  armorSetBonus: Object.freeze({ "zh-chs": "护甲套装加成", "zh-cht": "防具套裝獎勵", en: "Armor Set Bonus" }),
  activeArmorSetBonuses: Object.freeze({ "zh-chs": "已激活护甲套装加成", "zh-cht": "已啟用防具套裝獎勵", en: "Active Armor Set Bonuses" }),
  subclass: Object.freeze({ "zh-chs": "分支职业", "zh-cht": "副職業", en: "Subclass" }),
  aspect: Object.freeze({ "zh-chs": "星相", "zh-cht": "相位", en: "Aspect" }),
  fragment: Object.freeze({ "zh-chs": "碎片", "zh-cht": "碎片", en: "Fragment" }),
  power: Object.freeze({ "zh-chs": "能量", "zh-cht": "力量", en: "Power" }),
  health: Object.freeze({ "zh-chs": "生命值", "zh-cht": "生命值", en: "Health" }),
  melee: Object.freeze({ "zh-chs": "近战", "zh-cht": "近戰", en: "Melee" }),
  grenade: Object.freeze({ "zh-chs": "手雷", "zh-cht": "手榴彈", en: "Grenade" }),
  super: Object.freeze({ "zh-chs": "超能", "zh-cht": "超能力", en: "Super" }),
  class: Object.freeze({ "zh-chs": "职业", "zh-cht": "職業", en: "Class" }),
  weapons: Object.freeze({ "zh-chs": "武器", "zh-cht": "武器", en: "Weapons" }),
  kineticWeapon: Object.freeze({ "zh-chs": "动能武器", "zh-cht": "動能武器", en: "Kinetic Weapon" }),
  energyWeapon: Object.freeze({ "zh-chs": "能量武器", "zh-cht": "能量武器", en: "Energy Weapon" }),
  powerWeapon: Object.freeze({ "zh-chs": "威能武器", "zh-cht": "威能武器", en: "Power Weapon" }),
  armorInformation: Object.freeze({ "zh-chs": "护甲信息", "zh-cht": "防具資訊", en: "Armor information" }),
  applicationSettings: Object.freeze({ "zh-chs": "应用设置", "zh-cht": "應用程式設定", en: "Application settings" }),
});

export function getTerm(key, language = "zh-chs") {
  return TERMINOLOGY[key]?.[SUPPORTED_LANGUAGES.includes(language) ? language : "zh-chs"] ?? key;
}

export const STAT_LABELS_BY_LANGUAGE = Object.freeze(Object.fromEntries(
  SUPPORTED_LANGUAGES.map(language => [language, Object.freeze(Object.fromEntries(
    ["health", "melee", "grenade", "super", "class", "weapons"]
      .map(stat => [stat, getTerm(stat, language)]),
  ))]),
));

// Bungie Manifest DestinyInventoryItemDefinition.displayProperties names.
// The English id and Manifest hash are the only canonical identities.
export const ARMOR_ARCHETYPES = Object.freeze([
  { id: "Siegebreaker", hash: 2503381935, primary: "health", secondary: "grenade" },
  { id: "Bulwark", hash: 549468645, primary: "health", secondary: "class" },
  { id: "Brawler", hash: 3349393475, primary: "melee", secondary: "health" },
  { id: "Skirmisher", hash: 1687144140, primary: "melee", secondary: "weapons" },
  { id: "Grenadier", hash: 2937665788, primary: "grenade", secondary: "super" },
  { id: "Demolitionist", hash: 2222960133, primary: "grenade", secondary: "class" },
  { id: "Colossus", hash: 1418248448, primary: "super", secondary: "health" },
  { id: "Paragon", hash: 4227065942, primary: "super", secondary: "melee" },
  { id: "Reaver", hash: 351770835, primary: "class", secondary: "melee" },
  { id: "Specialist", hash: 2230428468, primary: "class", secondary: "weapons" },
  { id: "Gunner", hash: 1807652646, primary: "weapons", secondary: "grenade" },
  { id: "Powerhouse", hash: 544009373, primary: "weapons", secondary: "super" },
].map(Object.freeze));

export const ARCHETYPE_LABELS = Object.freeze({
  Siegebreaker: Object.freeze({ "zh-chs": "突围者", "zh-cht": "破圍者", en: "Siegebreaker" }),
  Bulwark: Object.freeze({ "zh-chs": "堡垒", "zh-cht": "堡壘", en: "Bulwark" }),
  Brawler: Object.freeze({ "zh-chs": "搏击手", "zh-cht": "赤拳互鬥", en: "Brawler" }),
  Skirmisher: Object.freeze({ "zh-chs": "突击手", "zh-cht": "散兵", en: "Skirmisher" }),
  Grenadier: Object.freeze({ "zh-chs": "掷雷手", "zh-cht": "榴彈兵", en: "Grenadier" }),
  Demolitionist: Object.freeze({ "zh-chs": "爆破专家", "zh-cht": "爆破專家", en: "Demolitionist" }),
  Colossus: Object.freeze({ "zh-chs": "装甲兵", "zh-cht": "巨神兵", en: "Colossus" }),
  Paragon: Object.freeze({ "zh-chs": "楷模典范", "zh-cht": "至高典範", en: "Paragon" }),
  Reaver: Object.freeze({ "zh-chs": "掠夺者", "zh-cht": "剝奪者", en: "Reaver" }),
  Specialist: Object.freeze({ "zh-chs": "专家", "zh-cht": "戰術家", en: "Specialist" }),
  Gunner: Object.freeze({ "zh-chs": "枪手", "zh-cht": "槍手", en: "Gunner" }),
  Powerhouse: Object.freeze({ "zh-chs": "高能者", "zh-cht": "發電站", en: "Powerhouse" }),
});

const ARCHETYPE_ALIASES = new Map();
for (const archetype of ARMOR_ARCHETYPES) {
  ARCHETYPE_ALIASES.set(archetype.id, archetype.id);
  ARCHETYPE_ALIASES.set(String(archetype.hash), archetype.id);
  for (const label of Object.values(ARCHETYPE_LABELS[archetype.id])) {
    ARCHETYPE_ALIASES.set(label, archetype.id);
  }
}
// Historical persisted/UI aliases. These remain input-only and are never
// emitted as current display names.
ARCHETYPE_ALIASES.set("壁垒", "Bulwark");
ARCHETYPE_ALIASES.set("衝突者", "Skirmisher");

export function normalizeArchetypeId(value) {
  if (value === null || value === undefined) return null;
  return ARCHETYPE_ALIASES.get(String(value).trim()) ?? null;
}

export function getArchetypeDefinition(value) {
  const id = normalizeArchetypeId(value);
  return id ? ARMOR_ARCHETYPES.find(archetype => archetype.id === id) ?? null : null;
}
