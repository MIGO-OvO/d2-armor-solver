import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILD_SCHEMA_VERSION,
  STORAGE_KEYS,
  createBuildRepository,
} from "../src/core/build-repository.mjs";

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.has(key) ? this.#values.get(key) : null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }

  removeItem(key) {
    this.#values.delete(key);
  }
}

test("repository reads the legacy language key and migrates on write", () => {
  const storage = new MemoryStorage();
  storage.setItem(STORAGE_KEYS.legacyLanguage, "en");
  const repository = createBuildRepository(storage);

  assert.equal(repository.readLanguage(), "en");
  assert.equal(repository.writeLanguage("zh-cht"), true);
  assert.equal(storage.getItem(STORAGE_KEYS.pageLanguage), "zh-cht");
  assert.equal(storage.getItem(STORAGE_KEYS.legacyLanguage), null);
});

test("repository preserves existing keys and versions new drafts", () => {
  const storage = new MemoryStorage();
  const repository = createBuildRepository(storage);
  repository.writeCurrentDraft({ targets: { health: 100 } });
  repository.writeUpgradeDraft({ pieces: [{ slot: "helmet" }] });

  assert.deepEqual(repository.readCurrentDraft(), {
    schemaVersion: BUILD_SCHEMA_VERSION,
    targets: { health: 100 },
  });
  assert.deepEqual(repository.readUpgradeDraft(), {
    schemaVersion: BUILD_SCHEMA_VERSION,
    pieces: [{ slot: "helmet" }],
  });
});

test("repository contains malformed or unavailable browser storage", () => {
  const storage = new MemoryStorage();
  storage.setItem(STORAGE_KEYS.savedBuilds, "{bad json");
  const repository = createBuildRepository(storage);
  assert.deepEqual(repository.readSavedBuilds(), []);

  const unavailable = createBuildRepository({
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  });
  assert.equal(unavailable.readLanguage(), null);
  assert.equal(unavailable.writeCalculatorMode("upgrade"), false);
  assert.deepEqual(unavailable.readSavedBuilds(), []);
});
