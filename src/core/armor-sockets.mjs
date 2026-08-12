// Armor 3.0 socket identification and per-socket plug capabilities.
//
// Bungie's ItemSockets state does not carry socketTypeHash / socketCategoryHash
// (verified in the real GetProfile fixture: socket state only has plugHash,
// isEnabled, isVisible), so socket roles are identified by plug-hash membership
// in the static stat-mod / tuning-mod tables (armor-mods.data.mjs). A stat
// socket only ever holds stat mods, a tuning socket only tuning mods, and the
// two hash sets are disjoint — so current or candidate plugs uniquely identify
// the role without downloading a manifest socket table.
//
// Candidate sources follow Bungie's documented merge (DestinySocketDefinition
// reusablePlugItems / reusablePlugSetHash + DestinyProfileResponse.profilePlugSets
// + characterPlugSets + itemComponents.reusablePlugs). Per-instance reusable
// plugs are the only source keyed by socketIndex; the plug-set components are
// account/character-wide and only prove unlock, not socket membership.
//
// Pure data mapping: no DOM, no fetch, no browser storage.

import {
  BALANCED_TUNING_MOD_HASH,
  STAT_MOD_HASHES,
  TUNING_MOD_HASH_BY_TUNING,
} from "./armor-mods.data.mjs";

export const STAT_MOD_HASH_SET = new Set(
  Object.values(STAT_MOD_HASHES).flatMap(sizes => Object.values(sizes).map(Number)),
);

export const TUNING_HASH_SET = new Set([
  Number(BALANCED_TUNING_MOD_HASH),
  ...Object.values(TUNING_MOD_HASH_BY_TUNING).map(Number),
]);

// Directional +5/-5 tuning mod hashes keyed by the stat they tune INTO (+5
// destination). TUNING_MOD_HASH_BY_TUNING keys are "<to>:<from>".
const TUNING_DESTINATION_BY_HASH = new Map();
for (const [key, hash] of Object.entries(TUNING_MOD_HASH_BY_TUNING)) {
  TUNING_DESTINATION_BY_HASH.set(Number(hash), key.split(":")[0]);
}

export const SOCKET_ROLE = {
  STAT: "stat",
  TUNING: "tuning",
  OTHER: "other",
};

export const CANDIDATE_STATE = {
  UNKNOWN: "unknown", // no reusable-plug data: must not be used to reject
  KNOWN: "known",     // per-instance reusable plugs present (socket membership)
};

// The plug the socket accepts that is neither a stat mod nor a tuning mod is
// the socket's empty/default plug (DIM's plugFitsIntoSocket treats
// emptyPlugItemHash as a valid candidate). Used to clear an installed mod.
export function findEmptyPlugHash(candidatePlugHashes) {
  if (!(candidatePlugHashes instanceof Set)) return null;
  for (const hash of candidatePlugHashes) {
    if (!STAT_MOD_HASH_SET.has(hash) && !TUNING_HASH_SET.has(hash)) return hash;
  }
  return null;
}

export function classifySocketRole({ currentPlugHash = 0, candidatePlugHashes = null }) {
  const candidates = candidatePlugHashes instanceof Set ? candidatePlugHashes : null;
  if (candidates) {
    let stat = false;
    let tuning = false;
    for (const hash of candidates) {
      if (STAT_MOD_HASH_SET.has(hash)) stat = true;
      else if (TUNING_HASH_SET.has(hash)) tuning = true;
      if (stat && tuning) return SOCKET_ROLE.OTHER; // mixed: not a plain armor socket
    }
    if (stat) return SOCKET_ROLE.STAT;
    if (tuning) return SOCKET_ROLE.TUNING;
    return SOCKET_ROLE.OTHER;
  }
  // No candidates: fall back to the currently installed plug, which is also a
  // legal member of the socket's candidate set (an installed plug always fits).
  if (STAT_MOD_HASH_SET.has(Number(currentPlugHash))) return SOCKET_ROLE.STAT;
  if (TUNING_HASH_SET.has(Number(currentPlugHash))) return SOCKET_ROLE.TUNING;
  return SOCKET_ROLE.OTHER;
}

// Build per-instance socket capabilities from the raw GetProfile components.
//   sockets: itemComponents.sockets.data[instanceId].sockets
//   reusablePlugs: itemComponents.reusablePlugs.data[instanceId].plugs
//                  (map of socketIndex -> [{plugItemHash, canInsert, enabled}])
//   availableHashes: profile+character plug-set union (unlock evidence); when
//                  absent the reusable plugs stay unverified, which is fine
//                  because the executor re-checks every write.
export function buildSocketCapabilities(sockets = [], reusablePlugs = null, availableHashes = null) {
  const reusableByIndex = reusablePlugs && typeof reusablePlugs === "object"
    ? reusablePlugs
    : {};
  return sockets.map((socket, socketIndex) => {
    const currentPlugHash = Number(socket?.plugHash) || 0;
    const enabled = socket?.isEnabled !== false;
    const visible = socket?.isVisible !== false;
    // socket.socketIndex wins when present (normalized items preserve the
    // exact API ordering, which may have gaps like 0 and 11).
    const index = Number(socket?.socketIndex) || socketIndex;
    // Reusable plugs are keyed by the socket's INDEX, not the array position.
    const reusableEntries = reusableByIndex[index] ?? null;
    const candidatePlugHashes = new Set();
    let candidateState = CANDIDATE_STATE.UNKNOWN;
    if (Array.isArray(reusableEntries)) {
      for (const entry of reusableEntries) {
        const hash = Number(entry && typeof entry === "object" ? entry.plugItemHash : entry) || 0;
        if (hash) candidatePlugHashes.add(hash);
      }
      candidateState = CANDIDATE_STATE.KNOWN;
    }
    // The currently installed plug is always a legal candidate (it sits in the
    // socket); adding it keeps availability checks from rejecting the status
    // quo when reusable data is partial.
    if (currentPlugHash) candidatePlugHashes.add(currentPlugHash);
    if (availableHashes instanceof Set) {
      // Unlock filtering only removes plugs we can PROVE are absent; an empty
      // plug-set response must not empty a known candidate list.
      for (const hash of [...candidatePlugHashes]) {
        if (!availableHashes.has(hash)) candidatePlugHashes.delete(hash);
      }
      if (candidatePlugHashes.size === 0 && candidateState === CANDIDATE_STATE.KNOWN) {
        // Every reusable plug was filtered out: the item-definition list is
        // still the socket contract, so re-add it unfiltered and mark partial.
        for (const entry of reusableEntries) {
          const hash = Number(entry && typeof entry === "object" ? entry.plugItemHash : entry) || 0;
          if (hash) candidatePlugHashes.add(hash);
        }
      }
    }
    const role = classifySocketRole({ currentPlugHash, candidatePlugHashes });
    return {
      socketIndex: index,
      role,
      currentPlugHash,
      emptyPlugHash: findEmptyPlugHash(candidatePlugHashes),
      enabled,
      visible,
      candidatePlugHashes,
      candidateState,
    };
  });
}

// Find the first enabled socket of a role. Returns null instead of falling
// back to a guessed index — an unknown socket must never be written blind.
export function findSocketByRole(sockets, role) {
  return (sockets || []).find(socket =>
    socket?.enabled !== false && socket?.role === role,
  ) ?? null;
}

// Derive the armor piece's fixed tuning stat from its tuning socket candidates
// (DIM getArmor3TuningStat semantics):
//   - no directional candidates  -> no directional tuning accepted (balanced
//     only), fixedTuningStat null
//   - exactly one destination     -> that stat is the fixed tuning stat
//   - multiple destinations       -> exotic-style socket, not locked to one
// Returns { fixedTuningStat, allowedTuningStats, confidence }.
export function deriveTuningStats(tuningSocket) {
  if (!tuningSocket) {
    return { fixedTuningStat: null, allowedTuningStats: null, confidence: "unknown" };
  }
  const destinations = new Set();
  for (const hash of tuningSocket.candidatePlugHashes) {
    const destination = TUNING_DESTINATION_BY_HASH.get(hash);
    if (destination) destinations.add(destination);
  }
  if (tuningSocket.candidateState !== CANDIDATE_STATE.KNOWN) {
    return { fixedTuningStat: null, allowedTuningStats: null, confidence: "unknown" };
  }
  if (destinations.size === 1) {
    const stat = [...destinations][0];
    return { fixedTuningStat: stat, allowedTuningStats: [stat], confidence: "exact" };
  }
  if (destinations.size > 1) {
    return {
      fixedTuningStat: null,
      allowedTuningStats: [...destinations],
      confidence: "exact", // known but not locked to a single stat
    };
  }
  return { fixedTuningStat: null, allowedTuningStats: [], confidence: "exact" };
}
