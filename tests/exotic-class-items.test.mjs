import assert from "node:assert/strict";
import test from "node:test";

import {
  EXOTIC_CLASSES,
  STATS,
  createExoticConfig,
} from "../src/core/armor-model.mjs";

const EXPECTED_PRIMARY = {
  hunter: {
    assassin: ["melee", "health", "Brawler"],
    inmost: ["super", "melee", "Paragon"],
    caliban: ["melee", "health", "Brawler"],
    galanor: ["super", "melee", "Paragon"],
    foetracer: ["weapons", "grenade", "Gunner"],
    renewal: ["grenade", "super", "Grenadier"],
    dragon: ["class", "weapons", "Specialist"],
    ophidian: ["weapons", "grenade", "Gunner"],
  },
  warlock: {
    assassin: ["melee", "health", "Brawler"],
    inmost: ["super", "melee", "Paragon"],
    ophidian: ["weapons", "grenade", "Gunner"],
    apotheosis: ["super", "melee", "Paragon"],
    osmiomancy: ["grenade", "super", "Grenadier"],
    stag: ["health", "class", "Bulwark"],
    filaments: ["class", "weapons", "Specialist"],
    necrotic: ["melee", "health", "Brawler"],
  },
  titan: {
    assassin: ["melee", "health", "Brawler"],
    inmost: ["super", "melee", "Paragon"],
    ophidian: ["weapons", "grenade", "Gunner"],
    hoarfrost: ["class", "weapons", "Specialist"],
    severance: ["melee", "health", "Brawler"],
    abeyant: ["class", "weapons", "Specialist"],
    bear: ["grenade", "super", "Grenadier"],
    "eternal-warrior": ["super", "melee", "Paragon"],
  },
};

const EXPECTED_SECONDARY = {
  hunter: {
    cyrtarachne: ["grenade", "health"],
    gyrfalcon: ["weapons", "melee"],
    liar: ["melee", "health", "class"],
    "star-eater": ["super", "weapons"],
    synthoceps: ["melee", "health", "class"],
    verity: ["grenade", "super", "melee"],
    wormhusk: ["class", "health"],
    coyote: ["class", "melee"],
  },
  warlock: {
    claw: ["melee", "health", "class"],
    starfire: ["grenade", "super", "weapons"],
    swarm: ["grenade", "melee"],
    synthoceps: ["melee", "health", "class"],
    "star-eater": ["super", "weapons"],
    verity: ["grenade", "super", "melee"],
    harmony: ["weapons", "super"],
    vesper: ["class", "health", "weapons"],
  },
  titan: {
    armamentarium: ["grenade", "super", "weapons"],
    "alpha-lupi": ["class", "health"],
    contact: ["melee", "health", "grenade"],
    horn: ["class", "grenade"],
    scars: ["health", "weapons"],
    "star-eater": ["super", "weapons"],
    synthoceps: ["melee", "health", "class"],
    verity: ["grenade", "super", "melee"],
  },
};

function normalizePrimary(entries) {
  return Object.fromEntries(entries.map(entry => [
    entry[0],
    [entry[2], entry[3], entry[4]],
  ]));
}

function normalizeSecondary(entries) {
  return Object.fromEntries(entries.map(entry => [entry[0], entry[2]]));
}

test("Exotic Class Item perk metadata matches the Armor 3.0 reference", () => {
  assert.deepEqual(Object.keys(EXOTIC_CLASSES).sort(), ["hunter", "titan", "warlock"]);

  for (const [classId, data] of Object.entries(EXOTIC_CLASSES)) {
    assert.deepEqual(normalizePrimary(data.primary), EXPECTED_PRIMARY[classId], `${classId} left-column perks`);
    assert.deepEqual(normalizeSecondary(data.secondary), EXPECTED_SECONDARY[classId], `${classId} right-column perks`);
  }
});

test("all 192 Exotic Class Item perk pairs resolve to the referenced 30/25/20 stats", () => {
  let combinationCount = 0;

  for (const [classId, data] of Object.entries(EXOTIC_CLASSES)) {
    for (const primaryEntry of data.primary) {
      const [primaryId, primaryName] = primaryEntry;
      const [primary, secondary, archetype] = EXPECTED_PRIMARY[classId][primaryId];
      const primaryMeta = { id: primaryId, name: primaryName, primary, secondary, archetype };

      for (const secondaryEntry of data.secondary) {
        const [secondaryId, secondaryName] = secondaryEntry;
        const order = EXPECTED_SECONDARY[classId][secondaryId];
        const secondaryMeta = { id: secondaryId, name: secondaryName, order };
        const occupied = new Set([primary, secondary]);
        const tertiary = order.find(stat => !occupied.has(stat));
        const expectedStats = Object.fromEntries(STATS.map(stat => [stat, 5]));
        expectedStats[primary] = 30;
        expectedStats[secondary] = 25;
        expectedStats[tertiary] = 20;

        const config = createExoticConfig(primaryMeta, secondaryMeta);
        const context = `${classId}: ${primaryId} + ${secondaryId}`;
        assert.equal(config.archetype, archetype, context);
        assert.equal(config.primary, primary, context);
        assert.equal(config.secondary, secondary, context);
        assert.equal(config.tertiary, tertiary, context);
        assert.deepEqual(config.baseStats, expectedStats, context);
        combinationCount += 1;
      }
    }
  }

  assert.equal(combinationCount, 192);
});
