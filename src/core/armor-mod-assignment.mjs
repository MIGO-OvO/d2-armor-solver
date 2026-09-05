// Armor mod assignment across the five pieces of a loadout.
//
// The solver already pins one stat mod and one tuning direction per piece; this
// module makes that plan EXECUTABLE: it resolves the exact socket on each
// piece, checks insertability (tri-state availability), energy feasibility, and
// fixed-tuning compatibility, and produces an ordered plug write strategy. It
// never silently skips: any requested mod that cannot be placed lands in
// unassignedMods and invalidates the plan (handoff 3.6 / Phase C).
//
// Pure functions: no DOM, no fetch, no browser storage.

import {
  BALANCED_TUNING_MOD_HASH,
  STAT_MOD_HASHES,
  TUNING_MOD_HASH_BY_TUNING,
} from "./armor-mods.data.mjs";
import { ARCHETYPES, STATS } from "./armor-model.mjs";
import { getEffectiveBaseStats } from "./dim-csv.mjs";
import { SOCKET_ROLE, CANDIDATE_STATE } from "./armor-sockets.mjs";
import { EXECUTION_STATUS } from "./solver-v3-contract.mjs";

export const STAT_MOD_ENERGY_COST = { 5: 1, 10: 3 };

function statModHashFor(assignment) {
  if (!assignment?.stat || !assignment?.size) return null;
  return Number(STAT_MOD_HASHES[assignment.stat]?.[assignment.size]) || null;
}

function tuningHashFor(assignment) {
  if (!assignment) return null; // null assignment = no tuning write (unknown)
  if (assignment.mode === "+3") return Number(BALANCED_TUNING_MOD_HASH);
  if (assignment.mode !== "+5-5" || !assignment.to || !assignment.from) return null;
  return Number(TUNING_MOD_HASH_BY_TUNING[`${assignment.to}:${assignment.from}`]) || null;
}

function tuningChangesFor(item, assignment) {
  const framework = getFrameworkStats(item);
  const changes = {};
  if (!assignment) return changes;
  if (assignment.mode === "+3") {
    if (framework) {
      for (const stat of STATS) {
        if (!framework.has(stat)) changes[stat] = 1;
      }
    }
  } else if (assignment.mode === "+5-5" && assignment.to && assignment.from) {
    changes[assignment.from] = -5;
    changes[assignment.to] = 5;
  }
  return changes;
}

function getFrameworkStats(item) {
  if (!item?.archetypeId || !STATS.includes(item?.tertiary)) return null;
  const archetype = ARCHETYPES.find(entry => entry.id === item.archetypeId);
  if (!archetype) return null;
  return new Set([archetype.primary, archetype.secondary, item.tertiary]);
}

// Is the desired tuning acceptable for this piece given its fixed tuning stat?
//   - known single stat: only a +5-5 tuning INTO that stat (balanced always OK)
//   - known multi (exotic): any destination in the allowed set
//   - unknown: cannot verify -> allowed but flagged unverified (never rejects)
function tuningCompatibility(item, assignment) {
  if (!assignment) return { ok: true, unverified: false };
  if (assignment.mode === "+3") return { ok: true, unverified: false };
  const allowed = item?.allowedTuningStats;
  if (item?.dataConfidence?.tuning === "unknown" || !Array.isArray(allowed)) {
    return { ok: true, unverified: true };
  }
  return {
    ok: allowed.includes(assignment.to),
    unverified: false,
  };
}

function itemSocket(item, role) {
  return (item?.sockets || []).find(socket =>
    socket?.enabled !== false && socket?.role === role,
  ) ?? null;
}

// Resolve one piece's desired stat + tuning plugs onto its actual sockets.
// Returns { assignment, unassigned } where assignment carries per-socket ops.
// Current installed stat/tuning plug hashes decoded from the normalized item
// (Bungie path decodes them from socket plugs; DIM CSV from column inference).
function currentStatModHash(item) {
  return item?.armorModSize > 0
    ? Number(STAT_MOD_HASHES[item.armorModStat]?.[item.armorModSize]) || 0
    : 0;
}

function currentTuningHash(item) {
  if (!item?.tuningMode) return 0;
  if (item.tuningMode === "plus3") return Number(BALANCED_TUNING_MOD_HASH);
  if (item.tuningMode === "shift" && item.tuningTo && item.tuningFrom) {
    return Number(TUNING_MOD_HASH_BY_TUNING[`${item.tuningTo}:${item.tuningFrom}`]) || 0;
  }
  return 0;
}

function assignPiece({
  item, index, slot,
  desiredStatHash, desiredStatAssignment,
  desiredTuningHash, desiredTuningAssignment,
  availablePlugHashes,
}) {
  const unassigned = [];
  const unverified = [];
  const operations = [];
  const currentStatHash = currentStatModHash(item);
  const currentTuning = currentTuningHash(item);
  const statSocket = desiredStatHash ? itemSocket(item, SOCKET_ROLE.STAT) : null;
  const tuningSocket = desiredTuningHash ? itemSocket(item, SOCKET_ROLE.TUNING) : null;

  // Tri-state availability (handoff 3.3):
  //   - a known account/character plug set (Set) rejects plugs absent from it;
  //   - per-socket candidates from ItemReusablePlugs reject absent plugs when
  //     the list is complete ("known");
  //   - missing data (null set / unknown candidates) must NOT reject — the
  //     write is attempted and the post-write verify confirms it.
  const canInsert = (socket, hash) => {
    if (availablePlugHashes instanceof Set && !availablePlugHashes.has(hash)) {
      return { ok: false, unverified: false };
    }
    if (socket?.candidatePlugHashes?.has(hash)) return { ok: true, unverified: false };
    if (socket?.candidateState === CANDIDATE_STATE.KNOWN) {
      return { ok: false, unverified: false };
    }
    return { ok: true, unverified: true };
  };

  // Clear path: the plan wants no stat mod (or no tuning) but the instance
  // currently has one installed. The socket's empty/default plug is the only
  // legal way to remove it; when the socket contract is unknown there is no
  // way to name the empty plug, so this is a blocking unassigned, never a
  // silent skip.
  const clearOperation = (socket, kind, plugHashLabel) => {
    if (!socket) {
      unassigned.push({ index, slot, kind, plugHash: 0, reason: `${kind}SocketUnknown` });
      return;
    }
    if (socket.emptyPlugHash) {
      operations.push({
        itemId: String(item.id), socketIndex: socket.socketIndex,
        plugItemHash: socket.emptyPlugHash,
        previousPlugHash: plugHashLabel || 0,
        kind,
      });
    } else {
      unassigned.push({ index, slot, kind, plugHash: 0, reason: "cannotClear" });
    }
  };

  if (desiredStatHash) {
    if (!statSocket) {
      unassigned.push({ index, slot, kind: "stat", plugHash: desiredStatHash, reason: "statSocketUnknown" });
    } else if (desiredStatHash !== currentStatHash) {
      const insert = canInsert(statSocket, desiredStatHash);
      if (!insert.ok) {
        unassigned.push({ index, slot, kind: "stat", plugHash: desiredStatHash, reason: "plugUnavailable" });
      } else {
        if (insert.unverified) {
          unverified.push({
            index, slot, kind: "stat", plugHash: desiredStatHash,
            reason: "candidateAvailabilityUnknown",
          });
        }
        const capacity = Number(item?.energy?.capacity) || 0;
        const used = Number(item?.energy?.used) || 0;
        const currentCost = STAT_MOD_ENERGY_COST[item?.armorModSize] || 0;
        const desiredCost = STAT_MOD_ENERGY_COST[desiredStatAssignment?.size] || 0;
        if (capacity > 0 && used - currentCost + desiredCost > capacity) {
          unassigned.push({ index, slot, kind: "stat", plugHash: desiredStatHash, reason: "energy" });
        } else {
          operations.push({
            itemId: String(item.id), socketIndex: statSocket.socketIndex,
            plugItemHash: desiredStatHash, previousPlugHash: currentStatHash || null,
            kind: "stat",
          });
        }
      }
    }
  } else if (currentStatHash) {
    clearOperation(itemSocket(item, SOCKET_ROLE.STAT), "stat", currentStatHash);
  }

  if (desiredTuningHash) {
    if (!tuningSocket) {
      unassigned.push({ index, slot, kind: "tuning", plugHash: desiredTuningHash, reason: "tuningSocketUnknown" });
    } else if (desiredTuningHash !== currentTuning) {
      const compatible = tuningCompatibility(item, desiredTuningAssignment);
      if (!compatible.ok) {
        unassigned.push({ index, slot, kind: "tuning", plugHash: desiredTuningHash, reason: "tuningMismatch" });
      } else {
        const insert = canInsert(tuningSocket, desiredTuningHash);
        if (!insert.ok) {
          unassigned.push({ index, slot, kind: "tuning", plugHash: desiredTuningHash, reason: "plugUnavailable" });
        } else {
          if (compatible.unverified || insert.unverified) {
            unverified.push({
              index, slot, kind: "tuning", plugHash: desiredTuningHash,
              reason: compatible.unverified
                ? "tuningCapabilityUnknown"
                : "candidateAvailabilityUnknown",
            });
          }
          operations.push({
            itemId: String(item.id), socketIndex: tuningSocket.socketIndex,
            plugItemHash: desiredTuningHash, previousPlugHash: currentTuning || null,
            kind: "tuning",
          });
        }
      }
    }
  }
  // A null tuning assignment means the fixed tuning stat could not be
  // established: the tuning socket is left untouched (no write, no clear), and
  // the executor reports the unverified tuning separately.

  return { operations, unassigned, unverified };
}

// Order the per-piece operations deterministically: stat socket writes first,
// then tuning, so the tuning direction (the piece's rolled identity) lands
// last and the strategy is stable across reloads (DIM 8.133.0 regression:
// tuning mods must stay on the armor that owns the fixed tuning stat).
function orderOperations(operationsByPiece) {
  const ordered = [];
  for (const pieceOps of operationsByPiece) {
    const stat = pieceOps.find(op => op.kind === "stat");
    const tuning = pieceOps.find(op => op.kind === "tuning");
    if (stat) ordered.push(stat);
    if (tuning) ordered.push(tuning);
  }
  return ordered;
}

function pieceTotals(item, { tuningAssignment, statAssignment, projected }) {
  const masterworkTier = projected ? 5 : Math.min(5, Math.max(0, Number(item?.masterworkTier) || 0));
  const base = getEffectiveBaseStats({
    ...item,
    archetypeId: item?.archetypeId,
    tertiary: item?.tertiary,
    baseStats: item?.baseStats || {},
    masterworkTier,
  });
  const totals = { ...base };
  const tuningChanges = tuningChangesFor(item, tuningAssignment);
  for (const stat of STATS) totals[stat] += tuningChanges[stat] || 0;
  if (statAssignment?.size > 0 && statAssignment?.stat) {
    totals[statAssignment.stat] += statAssignment.size;
  }
  return totals;
}

// Assign the solver's per-piece stat/tuning plan onto five concrete armor
// instances. pieces are the plan pieces (sourceId/hash), inventory the
// normalized Bungie/DIM items, tuningAssignments/modAssignments the solver
// output (array or index-keyed object). availablePlugHashes is the target
// character's plug-set union or null when unknown.
export function assignArmorMods({
  pieces = [],
  inventory = [],
  tuningAssignments = [],
  modAssignments = {},
  availablePlugHashes = null,
}) {
  const byId = new Map(inventory.map(item => [String(item?.id ?? ""), item]));
  const modList = Array.isArray(modAssignments) ? modAssignments : (modAssignments || {});
  const getMod = index => Array.isArray(modList) ? modList[index] : modList[index] ?? null;
  const operationsByPiece = [];
  const unassignedMods = [];
  const unverifiedMods = [];
  const actualTotals = Object.fromEntries(STATS.map(stat => [stat, 0]));
  const projectedTotals = Object.fromEntries(STATS.map(stat => [stat, 0]));
  const resolvedCounts = { stat: 0, tuning: 0 };

  for (let index = 0; index < 5; index++) {
    const piece = pieces[index];
    const item = byId.get(String(piece?.sourceId ?? ""));
    const statAssignment = getMod(index);
    const tuningAssignment = tuningAssignments[index] ?? null;
    if (!piece || !item) {
      if (piece) {
        unassignedMods.push({
          index, slot: piece.slot || "", kind: "item", plugHash: 0, reason: "notOwnedInstance",
        });
      }
      continue;
    }
    const result = assignPiece({
      item,
      index,
      slot: piece.slot || "",
      desiredStatHash: statModHashFor(statAssignment),
      desiredStatAssignment: statAssignment,
      desiredTuningHash: tuningHashFor(tuningAssignment),
      desiredTuningAssignment: tuningAssignment,
      availablePlugHashes,
    });
    operationsByPiece.push(result.operations);
    unassignedMods.push(...result.unassigned);
    unverifiedMods.push(...result.unverified);
    if (statAssignment?.size > 0) resolvedCounts.stat++;
    if (tuningAssignment) resolvedCounts.tuning++;

    const actual = pieceTotals(item, {
      tuningAssignment, statAssignment: statAssignment, projected: false,
    });
    const projected = pieceTotals(item, {
      tuningAssignment, statAssignment: statAssignment, projected: true,
    });
    for (const stat of STATS) {
      actualTotals[stat] += actual[stat];
      projectedTotals[stat] += projected[stat];
    }
  }

  return {
    valid: unassignedMods.length === 0,
    unassignedMods,
    unverifiedMods,
    executionStatus: unassignedMods.length > 0
      ? EXECUTION_STATUS.BLOCKED
      : unverifiedMods.length > 0
        ? EXECUTION_STATUS.UNVERIFIED
        : EXECUTION_STATUS.VERIFIED,
    // One plug write per changed socket, in stat-then-tuning order. Writes are
    // direct socket replacements (InsertSocketPlugFree is atomic per socket,
    // so no empty-first pass is needed for armor stat/tuning sockets; add one
    // only if a future socket type enforces plug-group mutual exclusion).
    plugOperations: orderOperations(operationsByPiece),
    actualTotals,
    projectedTotals,
    resolvedCounts,
  };
}
