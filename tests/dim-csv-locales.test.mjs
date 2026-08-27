import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDimItem } from "../src/core/dim-csv.mjs";

function dimRecord(overrides = {}) {
  return {
    Name: "locale fixture",
    Hash: "123",
    Id: "locale-fixture",
    Rarity: "Legendary",
    Tier: "5",
    Type: "頭盔",
    Equippable: "泰坦",
    Archetype: "Bulwark",
    "Tertiary Stat": "melee",
    "Tuning Stat": "weapons",
    "Masterwork Tier": "0",
    ...overrides,
  };
}

test("Traditional Chinese DIM class and official armor-slot names normalize", () => {
  const cases = [
    [{ Equippable: "獵人", Type: "胸部防具" }, "hunter", "chest"],
    [{ Equippable: "術士", Type: "腿部防具" }, "warlock", "legs"],
  ];

  for (const [input, classId, slot] of cases) {
    const item = normalizeDimItem(dimRecord(input));
    assert.equal(item.classId, classId);
    assert.equal(item.slot, slot);
  }
});

test("localized and English ordinary Exotic rarity values are recognized", () => {
  for (const rarity of ["异域", "異域", "Exotic", " exotic "]) {
    const item = normalizeDimItem(dimRecord({ Rarity: rarity }));
    assert.equal(item.exotic, true, rarity);
  }
});

test("historical DIM slot and Archetype aliases remain compatible", () => {
  const chest = normalizeDimItem(dimRecord({ Type: "胸部護甲", Archetype: "壁垒" }));
  const legs = normalizeDimItem(dimRecord({ Type: "腿部護甲", Archetype: "衝突者" }));
  assert.equal(chest.slot, "chest");
  assert.equal(chest.archetypeId, "Bulwark");
  assert.equal(legs.slot, "legs");
  assert.equal(legs.archetypeId, "Skirmisher");
});
