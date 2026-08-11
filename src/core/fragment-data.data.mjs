// Subclass Aspect/Fragment stat adjustments, sourced from the Bungie Manifest
// (DestinyInventoryItemDefinition, version 244213.26.06.29.2000-1-bnet.65583,
// June 2026) via the per-table JSON content file. Extracted by filtering
// plug.plugCategoryIdentifier suffixes `.aspects` / `.fragments` / `.trinkets`
// (Stasis fragments live under shared.stasis.trinkets!) and reading each
// plug's investmentStats. scripts/fetch-fragment-data.mjs can re-verify.
//
// Map shape: plug item hash -> { stat: delta, ... } where stat is one of the
// six Armor 3.0 stats (health / melee / grenade / super / class / weapons).
// Only plugs that actually change stats appear here; aspects and fragments
// that grant no stat adjustment are omitted (their hash simply misses).
//
// Conventions (verified against the live manifest):
// - FragmentCost (119204074) and AspectEnergyCapacity (2223994109) are NOT
//   armor stats and are excluded; only the six Armor 3.0 stat hashes appear.
// - isConditionallyActive on fragment stats does NOT mean "skip": every
//   fragment stat applies unconditionally, EXCEPT the two class-dependent
//   fragments below.
// - Whisper of Hunger is the only non-+/-10 value: -20 strength.
// - Echo of Conduction / Echo of Dilation grant two stats each.

export const FRAGMENT_STAT_CHANGES = {
  // --- Arc (shared.arc.fragments) ---
  1727069362: { melee: -10 }, // Spark of Discharge
  1727069364: { grenade: -10 }, // Spark of Shock
  1727069366: { melee: 10 }, // Spark of Resistance
  3277705904: { class: 10 }, // Spark of Volts
  3277705905: { super: 10 }, // Spark of Brilliance
  3277705907: { health: 10 }, // Spark of Feedback

  // --- Solar (shared.solar.fragments) ---
  362132288: { grenade: -10 }, // Ember of Torches
  362132289: { melee: 10 }, // Ember of Combustion
  362132290: { class: -10 }, // Ember of Tempering
  362132291: { grenade: 10 }, // Ember of Char
  362132292: { grenade: -10 }, // Ember of Benevolence
  362132294: { health: -10 }, // Ember of Empyrean
  362132295: { super: 10 }, // Ember of Beams
  1051276348: { melee: 10 }, // Ember of Eruption
  1051276350: { health: 10 }, // Ember of Wonder
  1051276351: { class: 10 }, // Ember of Searing
  4180586737: { health: 10 }, // Ember of Mercy

  // --- Void (shared.void.fragments) ---
  2272984656: { weapons: 10, super: 10 }, // Echo of Dilation (two stats)
  2272984657: { grenade: 10 }, // Echo of Domineering
  2272984664: { grenade: 10 }, // Echo of Provision
  2272984665: { super: 10 }, // Echo of Expulsion
  2272984667: { melee: 10 }, // Echo of Exchange
  2272984668: { grenade: -10 }, // Echo of Undermining
  2272984670: { health: 10 }, // Echo of Leeching
  2661180600: { melee: 10 }, // Echo of Instability
  2661180602: { class: 10 }, // Echo of Obscurity
  2661180603: { class: -10 }, // Echo of Starvation

  // --- Stasis (shared.stasis.trinkets!) ---
  537774540: { class: 10 }, // Whisper of Chains
  537774541: { grenade: -10 }, // Whisper of Torment
  537774543: { health: 10 }, // Whisper of Impetus
  2483898429: { super: 10, health: 10 }, // Whisper of Conduction (two stats)
  2483898431: { melee: -20 }, // Whisper of Hunger (-20!)
  3469412969: { melee: 10 }, // Whisper of Durance
  3469412974: { super: -10 }, // Whisper of Bonds

  // --- Strand (shared.strand.fragments) ---
  3192552688: { health: 10 }, // Thread of Binding
  3192552691: { grenade: -10 }, // Thread of Generation
  4208512210: { melee: 10 }, // Thread of Propagation
  4208512211: { super: 10 }, // Thread of Evolution
  4208512216: { weapons: 10 }, // Thread of Ascent
  4208512217: { class: 10 }, // Thread of Finality
  4208512219: { melee: -10 }, // Thread of Fury
  4208512221: { melee: 10 }, // Thread of Transmutation
  4208512222: { health: -10 }, // Thread of Warding

  // --- Prismatic (shared.prism.fragments) ---
  74393640: { class: 10 }, // Facet of Defiance
  124726498: { class: -10 }, // Facet of Purpose
  124726499: { weapons: 10 }, // Facet of Ruin
  124726501: { melee: 10 }, // Facet of Honor
  124726502: { grenade: 10 }, // Facet of Sacrifice
  124726504: { grenade: -10 }, // Facet of Dominance
  124726505: { health: 10 }, // Facet of Awakening
  2626922115: { super: 10 }, // Facet of Justice
  2626922120: { melee: 10 }, // Facet of Protection
  2626922121: { health: -10 }, // Facet of Grace
  2626922124: { grenade: 10 }, // Facet of Courage
  2626922125: { melee: 10 }, // Facet of Devotion
  2626922126: { melee: -10 }, // Facet of Dawn
};

// Class-dependent fragments: -10 to whichever stat governs class-ability
// regeneration — mobility (weapons) for Hunter, resilience (health) for
// Titan, recovery (class) for Warlock. The manifest lists all three stats
// conditionally; only one applies per class.
export const CLASS_ABILITY_PENALTY_FRAGMENTS = new Set([
  2272984671, // Echo of Persistence
  1727069360, // Spark of Focus
]);

export const CLASS_ABILITY_STAT_BY_CLASS = {
  hunter: "weapons",
  titan: "health",
  warlock: "class",
};

