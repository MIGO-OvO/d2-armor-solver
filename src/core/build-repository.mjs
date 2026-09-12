import {
  EXOTIC_LANGUAGE_STORAGE_KEY,
  PAGE_LANGUAGE_STORAGE_KEY,
  normalizeArchetypeId,
} from "./armor-model.mjs";
import { channelStorageKey } from "./build-channel.mjs";

export const BUILD_SCHEMA_VERSION = 2;

// Saved Builds are *user data*, not channel state. A loadout the player chose
// to keep must survive a stable/develop switch, a page update, and a Solver
// schema bump, so it lives in one shared key that never passes through
// channelStorageKey(). The two historical channel-scoped keys are read once,
// only to migrate what earlier versions wrote; they are never deleted.
export const SAVED_BUILD_SCHEMA_VERSION = 3;
export const SHARED_SAVED_BUILDS_KEY = "d2_armor_saved_builds_v3";
export const LEGACY_SAVED_BUILDS_KEYS = Object.freeze([
  "d2_armor_saved_builds",
  "d2_armor_dev_saved_builds",
]);
export const SAVED_BUILD_LIMIT = 255;

export const STORAGE_KEYS = Object.freeze({
  currentDraft: channelStorageKey("d2_armor_current_draft_v1"),
  upgradeDraft: channelStorageKey("d2_armor_upgrade_draft_v1"),
  calculatorMode: channelStorageKey("d2_armor_calculator_mode_v1"),
  savedBuilds: SHARED_SAVED_BUILDS_KEY,
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

// Drafts and saved solutions from early releases used localized Archetype
// names as identity. Migrate only identity-bearing fields, leaving every
// other user value untouched. The caller writes the migrated object back to
// the same localStorage key; no key is removed and no draft is cleared.
export function migrateStoredArchetypeIds(value) {
  let changed = false;

  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    for (const [key, entry] of Object.entries(node)) {
      if ((key === "archetypeId" || key === "archetype") &&
          (typeof entry === "string" || typeof entry === "number")) {
        const normalized = normalizeArchetypeId(entry);
        if (normalized && normalized !== entry) {
          node[key] = normalized;
          changed = true;
        }
      } else {
        visit(entry);
      }
    }
  }

  visit(value);
  if (value && typeof value === "object" && !Array.isArray(value) &&
      Number(value.schemaVersion || 0) < BUILD_SCHEMA_VERSION) {
    value.schemaVersion = BUILD_SCHEMA_VERSION;
    changed = true;
  }
  return { value, changed };
}

function readMigratedJson(storage, key, fallback) {
  const value = readJson(storage, key, fallback);
  if (value === fallback) return fallback;
  const migrated = migrateStoredArchetypeIds(value);
  if (migrated.changed) writeJson(storage, key, migrated.value);
  return migrated.value;
}

// ---------------------------------------------------------------- Saved Builds

// A stable, deterministic identity hash. Legacy records that never carried an
// id get one derived from their content, which is what makes migration
// idempotent: re-reading the same legacy key produces the same id again.
function hashText(value) {
  let hash = 0x811c9dc5;
  const text = String(value ?? "");
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function positiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function snapshotOf(build) {
  const snapshot = build?.solutionSnapshot;
  return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : null;
}

// The canonical identity of the solved loadout, wherever the record happens to
// keep it: new snapshot, new top level, or the legacy raw Solver witness.
export function savedBuildCanonicalId(build) {
  const candidates = [
    snapshotOf(build)?.canonicalId,
    build?.canonicalId,
    build?.result?.canonicalId,
    build?.result?.certificate?.canonicalId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

// Order-insensitive identity of the five solved pieces. Used as the last-resort
// dedupe key for records that carry neither an id nor a canonicalId.
function savedBuildPieceFingerprint(build) {
  const snapshot = snapshotOf(build);
  const pieces = snapshot?.pieces
    || build?.result?.pieces
    || build?.result?.config
    || null;
  if (!Array.isArray(pieces) || pieces.length === 0) return "";
  return pieces
    .map(piece => [
      piece?.slot ?? "",
      piece?.sourceId ?? piece?.id ?? "",
      piece?.hash ?? "",
    ].join(":"))
    .sort()
    .join("|");
}

function savedBuildTimestamp(build) {
  return positiveNumber(build?.savedAt ?? build?.updatedAt ?? build?.createdAt);
}

function savedBuildIdentity(build) {
  const id = typeof build?.id === "string" && build.id.length > 0 ? build.id : null;
  return {
    id,
    canonicalId: savedBuildCanonicalId(build),
    // 保存时间 + 名称 + solution fingerprint.
    fingerprint: [
      savedBuildTimestamp(build),
      String(build?.name ?? ""),
      savedBuildPieceFingerprint(build),
    ].join("|"),
  };
}

function deriveLegacyBuildId(build) {
  const identity = savedBuildIdentity(build);
  return `legacy-${hashText(`${identity.canonicalId ?? ""}|${identity.fingerprint}`)}`;
}

// One malformed record must never take the whole list down with it, so every
// step here is total: unknown shapes degrade to "kept, minus the bad field".
function normalizeSavedBuild(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const migrated = migrateStoredArchetypeIds(record).value;
  const identity = savedBuildIdentity(migrated);
  const savedAt = savedBuildTimestamp(migrated);
  return {
    ...migrated,
    schemaVersion: SAVED_BUILD_SCHEMA_VERSION,
    id: identity.id || deriveLegacyBuildId(migrated),
    savedAt,
    createdAt: positiveNumber(migrated.createdAt) || savedAt,
    updatedAt: positiveNumber(migrated.updatedAt) || savedAt,
  };
}

function normalizeSavedBuildSource(value) {
  if (!Array.isArray(value)) return [];
  const builds = [];
  for (const record of value) {
    try {
      const build = normalizeSavedBuild(record);
      if (build) builds.push(build);
    } catch {
      // Skip only this record; the remaining Saved Builds survive.
    }
  }
  return builds;
}

// Merge the shared list with both legacy channel lists. Dedupe priority is
// exactly: stable build id → canonicalId → 保存时间 + 名称 + fingerprint.
// The *first* source wins (shared, then stable legacy, then develop legacy),
// so a newer record never loses to an older duplicate.
function mergeSavedBuildSources(sources) {
  const kept = [];
  const seenIds = new Set();
  const seenCanonical = new Set();
  const seenFingerprint = new Set();
  const duplicateOf = identity =>
    (identity.id !== null && seenIds.has(identity.id))
    || (identity.canonicalId !== null && seenCanonical.has(identity.canonicalId))
    || seenFingerprint.has(identity.fingerprint);
  const keep = build => {
    const identity = savedBuildIdentity(build);
    if (identity.id !== null) seenIds.add(identity.id);
    if (identity.canonicalId !== null) seenCanonical.add(identity.canonicalId);
    seenFingerprint.add(identity.fingerprint);
    kept.push(build);
  };
  for (const { builds, dedupeWithinSource } of sources) {
    const localIds = new Set();
    for (const build of builds) {
      const identity = savedBuildIdentity(build);
      if (dedupeWithinSource && identity.id !== null && localIds.has(identity.id)) continue;
      if (duplicateOf(identity)) continue;
      if (identity.id !== null) localIds.add(identity.id);
      keep(build);
    }
  }
  return kept;
}

function sortSavedBuilds(builds) {
  return builds
    .map((build, index) => ({ build, index }))
    .sort((left, right) =>
      savedBuildTimestamp(right.build) - savedBuildTimestamp(left.build)
      || left.index - right.index)
    .slice(0, SAVED_BUILD_LIMIT)
    .map(entry => entry.build);
}

function readSharedSavedBuildState(storage) {
  const raw = readJson(storage, SHARED_SAVED_BUILDS_KEY, null);
  if (Array.isArray(raw)) {
    // A bare array (hand-written or produced by a future/older writer) is
    // still safe: normalize it, then let the legacy keys dedupe against it.
    return { builds: normalizeSavedBuildSource(raw), legacyMergedAt: null };
  }
  if (!raw || typeof raw !== "object") return { builds: [], legacyMergedAt: null };
  return {
    builds: normalizeSavedBuildSource(raw.builds),
    legacyMergedAt: positiveNumber(raw.legacyMergedAt) || null,
  };
}

function readLegacyMergedAt(storage) {
  const raw = readJson(storage, SHARED_SAVED_BUILDS_KEY, null);
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? positiveNumber(raw.legacyMergedAt)
    : 0;
}

function writeSharedSavedBuildState(storage, { builds, legacyMergedAt }) {
  return writeJson(storage, SHARED_SAVED_BUILDS_KEY, {
    schemaVersion: SAVED_BUILD_SCHEMA_VERSION,
    legacyMergedAt: positiveNumber(legacyMergedAt) || null,
    builds,
  });
}

function sameBuildList(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index];
    const b = right[index];
    if (a.id !== b.id || a.savedAt !== b.savedAt) return false;
  }
  return true;
}

// Reading Saved Builds also performs the one-time migration. Idempotent by
// construction: derived legacy ids are deterministic, so the second read finds
// every legacy record already represented in the shared list.
export function readSavedBuildsFrom(storage) {
  const shared = readSharedSavedBuildState(storage);
  if (shared.legacyMergedAt !== null) return shared.builds;
  const legacySources = [];
  for (const key of LEGACY_SAVED_BUILDS_KEYS) {
    legacySources.push({
      builds: normalizeSavedBuildSource(readJson(storage, key, null)),
      dedupeWithinSource: false,
    });
  }
  const hasLegacyData = legacySources.some(source => source.builds.length > 0);
  const merged = sortSavedBuilds(mergeSavedBuildSources([
    { builds: shared.builds, dedupeWithinSource: false },
    ...legacySources,
  ]));
  // Only mark the migration complete when there was nothing left to merge, so
  // a channel that stored its builds later is still picked up.
  const legacyMergedAt = hasLegacyData || shared.builds.length > 0 ? Date.now() : null;
  if (legacyMergedAt !== null && !sameBuildList(merged, shared.builds)) {
    writeSharedSavedBuildState(storage, { builds: merged, legacyMergedAt });
  }
  return merged;
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
      return readMigratedJson(storage, STORAGE_KEYS.currentDraft, null);
    },

    writeCurrentDraft(draft) {
      return writeJson(storage, STORAGE_KEYS.currentDraft, {
        schemaVersion: BUILD_SCHEMA_VERSION,
        ...draft,
      });
    },

    readUpgradeDraft() {
      return readMigratedJson(storage, STORAGE_KEYS.upgradeDraft, null);
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
      try {
        return readSavedBuildsFrom(storage);
      } catch {
        return [];
      }
    },

    // Returns false when the write did not land (storage unavailable, quota
    // exceeded, serialization failure). Callers must surface that, never
    // report a save that did not happen.
    writeSavedBuilds(builds) {
      const normalized = normalizeSavedBuildSource(Array.isArray(builds) ? builds : []);
      return writeSharedSavedBuildState(storage, {
        builds: sortSavedBuilds(normalized),
        legacyMergedAt: readLegacyMergedAt(storage) || Date.now(),
      });
    },

    // Clearing writes an empty shared list instead of removing the key: the
    // "legacy already merged" marker has to survive, or the legacy channel keys
    // would resurrect the builds on the next read. The legacy keys themselves
    // are deliberately left untouched.
    clearSavedBuilds() {
      return writeSharedSavedBuildState(storage, {
        builds: [],
        legacyMergedAt: readLegacyMergedAt(storage) || Date.now(),
      });
    },
  });
}

export const buildRepository = createBuildRepository();
