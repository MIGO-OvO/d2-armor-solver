import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILD_SCHEMA_VERSION,
  STORAGE_KEYS,
  createBuildRepository,
} from "../src/core/build-repository.mjs";
import { normalizeUpgradePiece } from "../src/core/upgrade-optimizer.mjs";

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

test("legacy localized Archetype ids migrate in place without clearing draft data", () => {
  const storage = new MemoryStorage();
  const legacy = {
    schemaVersion: 1,
    pieces: [{ archetypeId: "壁垒", tertiary: "melee", custom: "preserve me" }],
    inventory: [{ id: "owned-1", archetypeId: "衝突者", name: "Owned armor" }],
    untouched: { targets: [100, 80] },
  };
  storage.setItem(STORAGE_KEYS.upgradeDraft, JSON.stringify(legacy));

  const draft = createBuildRepository(storage).readUpgradeDraft();
  assert.equal(draft.schemaVersion, BUILD_SCHEMA_VERSION);
  assert.equal(draft.pieces[0].archetypeId, "Bulwark");
  assert.equal(draft.inventory[0].archetypeId, "Skirmisher");
  assert.equal(draft.pieces[0].custom, "preserve me");
  assert.deepEqual(draft.untouched, legacy.untouched);

  const persisted = JSON.parse(storage.getItem(STORAGE_KEYS.upgradeDraft));
  assert.deepEqual(persisted, draft, "migration must write back to the same key");
  assert.equal(storage.values.size, 1, "migration must not clear or replace user storage");
});

test("piece normalization accepts legacy aliases even outside repository reads", () => {
  assert.equal(normalizeUpgradePiece({ archetypeId: "壁垒" }, 0).archetypeId, "Bulwark");
  assert.equal(normalizeUpgradePiece({ archetypeId: "衝突者" }, 1).archetypeId, "Skirmisher");
});
