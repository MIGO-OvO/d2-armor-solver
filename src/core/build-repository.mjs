import {
  EXOTIC_LANGUAGE_STORAGE_KEY,
  PAGE_LANGUAGE_STORAGE_KEY,
} from "./armor-model.mjs";
import { channelStorageKey } from "./build-channel.mjs";

export const BUILD_SCHEMA_VERSION = 1;

export const STORAGE_KEYS = Object.freeze({
  currentDraft: channelStorageKey("d2_armor_current_draft_v1"),
  upgradeDraft: channelStorageKey("d2_armor_upgrade_draft_v1"),
  calculatorMode: channelStorageKey("d2_armor_calculator_mode_v1"),
  savedBuilds: channelStorageKey("d2_armor_saved_builds"),
  // Language is intentionally shared so the portal choice follows the user
  // into either channel; mutable solver data remains channel-scoped.
  pageLanguage: PAGE_LANGUAGE_STORAGE_KEY,
  legacyLanguage: EXOTIC_LANGUAGE_STORAGE_KEY,
});

function readText(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeText(storage, key, value) {
  try {
    storage?.setItem(key, String(value));
    return true;
  } catch {
    return false;
  }
}

function remove(storage, key) {
  try {
    storage?.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function readJson(storage, key, fallback) {
  const raw = readText(storage, key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(storage, key, value) {
  return writeText(storage, key, JSON.stringify(value));
}

function safeLocalStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function createBuildRepository(storage) {
  // ponytail: null storage degrades to "no persistence" without crashing
  // (Firefox file:// throws on the localStorage getter itself).
  storage = storage ?? safeLocalStorage();
  return Object.freeze({
    readLanguage() {
      return readText(storage, STORAGE_KEYS.pageLanguage)
        || readText(storage, STORAGE_KEYS.legacyLanguage);
    },

    writeLanguage(language) {
      const saved = writeText(storage, STORAGE_KEYS.pageLanguage, language);
      remove(storage, STORAGE_KEYS.legacyLanguage);
      return saved;
    },

    readCurrentDraft() {
      return readJson(storage, STORAGE_KEYS.currentDraft, null);
    },

    writeCurrentDraft(draft) {
      return writeJson(storage, STORAGE_KEYS.currentDraft, {
        schemaVersion: BUILD_SCHEMA_VERSION,
        ...draft,
      });
    },

    readUpgradeDraft() {
      return readJson(storage, STORAGE_KEYS.upgradeDraft, null);
    },

    writeUpgradeDraft(draft) {
      return writeJson(storage, STORAGE_KEYS.upgradeDraft, {
        schemaVersion: BUILD_SCHEMA_VERSION,
        ...draft,
      });
    },

    readCalculatorMode() {
      return readText(storage, STORAGE_KEYS.calculatorMode) || "solve";
    },

    writeCalculatorMode(mode) {
      return writeText(storage, STORAGE_KEYS.calculatorMode, mode);
    },

    readSavedBuilds() {
      const builds = readJson(storage, STORAGE_KEYS.savedBuilds, []);
      return Array.isArray(builds) ? builds : [];
    },

    writeSavedBuilds(builds) {
      return writeJson(storage, STORAGE_KEYS.savedBuilds, builds);
    },

    clearSavedBuilds() {
      return remove(storage, STORAGE_KEYS.savedBuilds);
    },
  });
}

export const buildRepository = createBuildRepository();
