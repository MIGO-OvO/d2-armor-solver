// Armor 3.0 mod item hashes, sourced from the Bungie Manifest via DIM's
// d2-known-values (tuning mods) and D2ArmorPicker's armor-stat data (stat
// mods). DIM loadouts reference mods by these hashes in parameters.mods.

// Armor 3.0 masterwork plugs grouped by tier (0–5), from the Manifest category
// v460.plugs.armor.masterworks. The tier is the conditional stat bonus.
export const ARMOR_MASTERWORK_TIER_BY_PLUG_HASH = new Map([
  [788990507, 1283668727, 1431426106, 1582132965, 2024015888, 2183487823, 2416688579, 3266153492],
  [788990506, 1283668726, 1431426107, 1582132964, 2024015889, 2183487822, 2416688578, 3266153493],
  [788990505, 1283668725, 1431426104, 1582132967, 2024015890, 2183487821, 2416688577, 3266153494],
  [788990504, 1283668724, 1431426105, 1582132966, 2024015891, 2183487820, 2416688576, 3266153495],
  [788990511, 1283668723, 1431426110, 1582132961, 2024015892, 2183487819, 2416688583, 3266153488],
  [788990510, 1283668722, 1431426111, 1582132960, 2024015893, 2183487818, 2416688582, 3266153489],
].flatMap((hashes, tier) => hashes.map(hash => [hash, tier])));

// +5 / +10 stat mod per armor stat. The 2.0 stat mods were updated in Edge of
// Fate to grant the new Armor 3.0 stats (e.g. "Mobility Mod" -> +10 Weapons).
export const STAT_MOD_HASHES = {
  weapons: { 5: 1703647492, 10: 4183296050 },
  health: { 5: 2532323436, 10: 1180408010 },
  class: { 5: 1237786518, 10: 4204488676 },
  grenade: { 5: 4021790309, 10: 1435557120 },
  super: { 5: 350061697, 10: 2724608735 },
  melee: { 5: 2639422088, 10: 4287799666 },
};

// "Balanced Tuning" grants +1 to the three lowest stats (the +3 mode).
export const BALANCED_TUNING_MOD_HASH = 3122197216;

// Directional +5/-5 tuning mods, keyed by "<+5 destination>:<-5 source>".
// Every (destination, source) pair of the six stats exists. Hashes verified
// against the Bungie Manifest (investment stats), 2026.
export const TUNING_MOD_HASH_BY_TUNING = {
  'grenade:melee': 309000506,
  'melee:super': 311164277,
  'class:weapons': 323635379,
  'health:melee': 388618952,
  'grenade:health': 455024236,
  'melee:grenade': 534630542,
  'super:melee': 673231129,
  'weapons:melee': 691392383,
  'weapons:super': 891771298,
  'class:super': 957763733,
  'class:melee': 1510949672,
  'grenade:super': 1672416975,
  'class:grenade': 1879022254,
  'weapons:class': 1918710127,
  'grenade:class': 1922571986,
  'health:weapons': 2125798995,
  'super:weapons': 2244422610,
  'weapons:health': 3121760799,
  'weapons:grenade': 3284443097,
  'health:class': 3310526732,
  'super:class': 3554800389,
  'health:grenade': 3681082702,
  'super:grenade': 3946669007,
  'melee:weapons': 4020349587,
  'super:health': 4026414261,
  'class:health': 4030660414,
  'health:super': 4088823605,
  'grenade:weapons': 4116389173,
  'melee:health': 4164883102,
  'melee:class': 4210715468,
};
