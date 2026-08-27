import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHETYPE_LABELS,
  ARMOR_ARCHETYPES,
  SUPPORTED_LANGUAGES,
  TERMINOLOGY,
  normalizeArchetypeId,
} from "../src/core/terminology.mjs";

const BASELINE = {
  masterwork: ["大师杰作", "大師之作", "Masterwork"],
  tuningMod: ["调整模组", "調校模組", "Tuning Mod"],
  subclass: ["分支职业", "副職業", "Subclass"],
  aspect: ["星相", "相位", "Aspect"],
  kineticWeapon: ["动能武器", "動能武器", "Kinetic Weapon"],
  energyWeapon: ["能量武器", "能量武器", "Energy Weapon"],
  powerWeapon: ["威能武器", "威能武器", "Power Weapon"],
  armorSetBonus: ["护甲套装加成", "防具套裝獎勵", "Armor Set Bonus"],
};

test("central terminology matches the official three-language baseline", () => {
  for (const [key, expected] of Object.entries(BASELINE)) {
    assert.deepEqual(SUPPORTED_LANGUAGES.map(language => TERMINOLOGY[key][language]), expected, key);
  }
  assert.deepEqual(
    SUPPORTED_LANGUAGES.map(language => ARCHETYPE_LABELS.Skirmisher[language]),
    ["突击手", "散兵", "Skirmisher"],
  );
});

test("Armor Archetype identity contains only stable English ids and hashes", () => {
  assert.equal(new Set(ARMOR_ARCHETYPES.map(item => item.id)).size, ARMOR_ARCHETYPES.length);
  assert.equal(new Set(ARMOR_ARCHETYPES.map(item => item.hash)).size, ARMOR_ARCHETYPES.length);
  for (const archetype of ARMOR_ARCHETYPES) {
    assert.match(archetype.id, /^[A-Za-z]+$/);
    assert.equal(Number.isInteger(archetype.hash), true);
    assert.equal(Object.hasOwn(archetype, "name"), false);
    assert.equal(Object.hasOwn(archetype, "labels"), false);
  }
});

test("canonical ids, Manifest hashes, localized labels, and history aliases normalize", () => {
  for (const value of ["Bulwark", 549468645, "堡垒", "堡壘", "壁垒"]) {
    assert.equal(normalizeArchetypeId(value), "Bulwark", String(value));
  }
  for (const value of ["Skirmisher", 1687144140, "突击手", "散兵", "衝突者"]) {
    assert.equal(normalizeArchetypeId(value), "Skirmisher", String(value));
  }
});
