import assert from "node:assert/strict";
import test from "node:test";
import { ARMOR_SETS } from "../src/core/armor-sets.data.mjs";
import {
  getActiveSetBonuses,
  getArmorSetByHash,
  getArmorSetByItemHash,
} from "../src/core/armor-sets.mjs";

test("manifest-derived set data is complete and consistent", () => {
  assert.equal(ARMOR_SETS.length, 56);
  for (const set of ARMOR_SETS) {
    assert.equal(set.items.length, 15, set.name.zh);
    assert.deepEqual(set.bonuses.map(bonus => bonus.count).sort(), [2, 4], set.name.zh);
    assert.ok(set.name.zh && set.name.en && set.name.zhCht, set.name.zh);
    for (const bonus of set.bonuses) {
      assert.ok(bonus.zh?.desc && bonus.en?.desc, set.name.zh);
    }
  }
});

test("every set member resolves back to exactly one set", () => {
  const seen = new Set();
  for (const set of ARMOR_SETS) {
    for (const hash of set.items) {
      assert.ok(!seen.has(hash), `duplicate item hash ${hash}`);
      seen.add(hash);
      assert.equal(getArmorSetByItemHash(hash).hash, set.hash);
    }
  }
  assert.equal(seen.size, 840);
});

test("active bonuses depend on the equipped piece count", () => {
  const atheon = getArmorSetByHash(741162535);
  const hashes = atheon.items.slice(0, 4);
  assert.deepEqual(
    getActiveSetBonuses(hashes).map(bonus => bonus.requiredCount).sort(),
    [2, 4]
  );
  assert.deepEqual(
    getActiveSetBonuses(hashes.slice(0, 2)).map(bonus => bonus.requiredCount),
    [2]
  );
  assert.deepEqual(
    getActiveSetBonuses(hashes.slice(0, 1)).map(bonus => bonus.requiredCount),
    []
  );
});
