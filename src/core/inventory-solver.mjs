import { STATS } from "./armor-model.mjs";
import { createPieceCapability } from "./solver-v3-contract.mjs";
import {
  applyManualUpgradeModifiers,
  compareUpgradeMetrics,
  createUpgradePieceFromItem,
  evaluateUpgradePieces,
  getUpgradeConfig,
} from "./upgrade-optimizer.mjs";

const SLOT_ORDER = ["helmet", "arms", "chest", "legs", "classItem"];

// Build a five-piece loadout from the imported inventory that satisfies the
// set-bonus requirement (or none) and comes as close as possible to the stat
// targets. This is the "no farming" option: every piece is already owned.
// Slot order matches UPGRADE_SLOTS so results can drop straight into the editor.
export function solveInventoryLoadout({
  items,
  targets,
  fragments,
  setRequirement,
  reassignModifiers = true,
  currentPieces = null,
  requiredStats = [],
  onlyPlus5Tuning = false,
  maxResults = 12,
  userConstraints = {},
}) {
  if (!setRequirement) return null;
  const normalizedRequiredStats = [...new Set(requiredStats)]
    .filter(stat => STATS.includes(stat));

  const bySlot = new Map();
  for (const slot of SLOT_ORDER) bySlot.set(slot, []);
  for (const item of items) {
    if (item?.slot && bySlot.has(item.slot)) bySlot.get(item.slot).push(item);
  }
  const evaluate = pieces => evaluateUpgradePieces(
    pieces, targets, fragments, reassignModifiers, normalizedRequiredStats,
    onlyPlus5Tuning, userConstraints
  );
  const lockedPiecesBySlot = new Map(
    (Array.isArray(currentPieces) ? currentPieces : [])
      .filter(piece => piece?.locked && SLOT_ORDER.includes(piece.slot))
      .map(piece => [piece.slot, projectInventoryPiece(piece)]),
  );
  const keyOf = pieces => pieces
    .map(piece => `${piece.slot}:${getPieceInstanceKey(piece)}`)
    .sort()
    .join("|");

  const results = [];
  const seen = new Set();
  const push = (pieces, evaluation) => {
    if (!isLegalArmorLoadout(pieces)) return;
    const key = keyOf(pieces);
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ pieces, evaluation, key });
  };

  let examined = 0;
  const assignments = enumerateSetAssignments(bySlot, setRequirement);
  for (const assignment of assignments) {
    const freeSlots = assignment.free.filter(slot => !lockedPiecesBySlot.has(slot));
    const constrainedAssignment = { ...assignment, free: freeSlots };
    const exhaustivePieces = enumerateSmallAssignmentLoadouts(
      bySlot, constrainedAssignment, lockedPiecesBySlot
    );
    if (exhaustivePieces) {
      for (const pieces of exhaustivePieces) {
        if (!isLegalArmorLoadout(pieces)) continue;
        if (!satisfiesRequirement(pieces, setRequirement)) continue;
        push(pieces, evaluate(pieces));
        examined++;
      }
      continue;
    }
    const exactPieces = searchAssignmentExact(
      bySlot, constrainedAssignment, lockedPiecesBySlot, setRequirement,
      reassignModifiers, onlyPlus5Tuning,
    );
    for (const pieces of exactPieces) {
      if (!isLegalArmorLoadout(pieces)) continue;
      if (!satisfiesRequirement(pieces, setRequirement)) continue;
      push(pieces, evaluate(pieces));
      examined++;
    }
  }

  const currentKey = Array.isArray(currentPieces)
    ? keyOf(currentPieces)
    : null;
  if (currentKey && isLegalArmorLoadout(currentPieces)
    && satisfiesRequirement(currentPieces, setRequirement)) {
    push(currentPieces.map(piece => ({ ...piece })), evaluate(currentPieces));
  }

  const validResults = results.filter(entry =>
    isLegalArmorLoadout(entry.pieces)
    && satisfiesRequirement(entry.pieces, setRequirement));
  validResults.sort((left, right) =>
    compareUpgradeMetrics(left.evaluation.metrics, right.evaluation.metrics)
  );
  return {
    requirement: setRequirement,
    requiredStats: normalizedRequiredStats,
    examined,
    searchComplete: !reassignModifiers,
    results: validResults.slice(0, maxResults).map(entry => ({
      pieces: entry.pieces,
      isCurrent: entry.key === currentKey,
      score: entry.evaluation.score,
      metrics: entry.evaluation.metrics,
      finalTotals: entry.evaluation.finalTotals,
      tuningAssignments: entry.evaluation.tuningAssignments,
      modAssignments: entry.evaluation.modAssignments,
    })),
  };
}

function enumerateSmallAssignmentLoadouts(bySlot, assignment, lockedPiecesBySlot) {
  const candidatesBySlot = [];
  let combinationCount = 1;
  for (const slot of SLOT_ORDER) {
    const lockedPiece = lockedPiecesBySlot.get(slot);
    if (lockedPiece) {
      candidatesBySlot.push([{ piece: { ...lockedPiece } }]);
      continue;
    }
    const requiredSetHash = assignment.fixed.get(slot);
    const items = requiredSetHash
      ? bySlot.get(slot).filter(item => item.setHash === requiredSetHash)
      : bySlot.get(slot);
    if (items.length === 0) return [];
    combinationCount *= items.length;
    if (combinationCount > 4096) return null;
    candidatesBySlot.push(items.map(item => ({ item })));
  }

  const loadouts = [];
  const chosen = Array(SLOT_ORDER.length);
  const enumerate = (slotIndex, exoticCount) => {
    if (slotIndex === SLOT_ORDER.length) {
      loadouts.push(chosen.map((candidate, index) => candidate.piece
        ? { ...candidate.piece }
        : createInventorySearchPiece(candidate.item, index)));
      return;
    }
    for (const candidate of candidatesBySlot[slotIndex]) {
      const nextExoticCount = exoticCount + Number(Boolean(
        candidate.piece?.exotic ?? candidate.item?.exotic,
      ));
      if (nextExoticCount > 1) continue;
      chosen[slotIndex] = candidate;
      enumerate(slotIndex + 1, nextExoticCount);
    }
  };
  enumerate(0, 0);
  return loadouts;
}

function projectInventoryPiece(piece) {
  return piece?.optimizationBaseStats
    ? { ...piece, baseStats: { ...piece.optimizationBaseStats } }
    : { ...piece };
}

function createInventorySearchPiece(item, slotIndex) {
  return projectInventoryPiece(createUpgradePieceFromItem(item, slotIndex));
}

function getRequirementCoverage(piece, requirement) {
  if (requirement.type === "set") {
    return [Number(piece.setHash) === Number(requirement.setHash) ? 1 : 0, 0];
  }
  if (requirement.type === "split") {
    return [
      Number(piece.setHash) === Number(requirement.a) ? 1 : 0,
      Number(piece.setHash) === Number(requirement.b) ? 1 : 0,
    ];
  }
  return [0, 0];
}

function getEvaluationContribution(piece, reassignModifiers, onlyPlus5Tuning) {
  const config = getUpgradeConfig(piece);
  if (!reassignModifiers) {
    return {
      stats: applyManualUpgradeModifiers(config, piece),
      descriptor: "",
    };
  }

  const tuningMode = onlyPlus5Tuning && piece.tuningMode === "plus3"
    ? "shift"
    : piece.tuningMode;
  const tuning = tuningMode === "plus3"
    ? `+3:${[...(config.masterworkStats || [])].sort().join(",")}`
    : `shift:${piece.exotic ? "free" : piece.tuningTo || "unknown"}`;
  return {
    stats: config.baseStats,
    descriptor: `${tuning}:mod${piece.armorModSize || 0}`,
  };
}

function getStateKey(state, includeCoverage = true) {
  const stats = STATS.map(stat => state.stats[stat]).join(",");
  // Modifier budgets and rolled tuning destinations affect the five-piece
  // total as a multiset; their armor-slot order does not. Canonicalizing that
  // multiset avoids retaining equivalent permutations in large inventories.
  const descriptors = [...state.descriptors].sort().join("|");
  const capabilities = [...state.capabilityKeys].sort().join("|");
  const coverage = includeCoverage ? `|${state.coverageA}|${state.coverageB}` : "";
  return `${stats}#${descriptors}#${capabilities}#${state.exoticCount}${coverage}`;
}

// Large inventories use an exhaustive state frontier. States merge only when
// their aggregate stats, Tuning/mod descriptors, set coverage, Exotic count,
// and execution capabilities are future-equivalent. No width or Top-N limit
// participates in reachability.
function searchAssignmentExact(
  bySlot, assignment, lockedPiecesBySlot, requirement,
  reassignModifiers, onlyPlus5Tuning,
) {
  const candidatesBySlot = [];
  for (const slot of SLOT_ORDER) {
    const slotIndex = SLOT_ORDER.indexOf(slot);
    const lockedPiece = lockedPiecesBySlot.get(slot);
    const requiredSetHash = assignment.fixed.get(slot);
    const rawCandidates = lockedPiece
      ? [{ ...lockedPiece }]
      : (requiredSetHash
        ? bySlot.get(slot).filter(item => item.setHash === requiredSetHash)
        : bySlot.get(slot)
      ).map(item => createInventorySearchPiece(item, slotIndex));
    if (rawCandidates.length === 0) return [];

    const compressed = new Map();
    for (const piece of rawCandidates) {
      const contribution = getEvaluationContribution(
        piece, reassignModifiers, onlyPlus5Tuning
      );
      const coverage = getRequirementCoverage(piece, requirement);
      const capabilityKey = createPieceCapability(piece, slotIndex).equivalenceKey;
      const key = [
        ...STATS.map(stat => contribution.stats[stat]),
        contribution.descriptor,
        capabilityKey,
        ...coverage,
      ].join(":");
      const candidate = { piece, contribution, coverage, capabilityKey };
      const existing = compressed.get(key);
      if (!existing || getPieceInstanceKey(piece).localeCompare(
        getPieceInstanceKey(existing.piece),
      ) < 0) {
        compressed.set(key, candidate);
      }
    }
    candidatesBySlot.push({
      slotIndex,
      candidates: [...compressed.values()].sort((left, right) =>
        getPieceInstanceKey(left.piece).localeCompare(getPieceInstanceKey(right.piece))),
    });
  }

  // Fewer distinct candidates first keeps intermediate state maps small; the
  // piece array remains in canonical slot order for the evaluator and UI.
  candidatesBySlot.sort((left, right) =>
    left.candidates.length - right.candidates.length
  );
  let states = new Map([["start", {
    pieces: Array(SLOT_ORDER.length),
    stats: Object.fromEntries(STATS.map(stat => [stat, 0])),
    descriptors: Array(SLOT_ORDER.length).fill(""),
    capabilityKeys: Array(SLOT_ORDER.length).fill(""),
    identityKeys: Array(SLOT_ORDER.length).fill(""),
    exoticCount: 0,
    coverageA: 0,
    coverageB: 0,
  }]]);

  for (let candidateIndex = 0; candidateIndex < candidatesBySlot.length; candidateIndex++) {
    const { slotIndex, candidates } = candidatesBySlot[candidateIndex];
    const next = new Map();
    for (const state of states.values()) {
      for (const candidate of candidates) {
        const exoticCount = state.exoticCount + Number(Boolean(candidate.piece.exotic));
        if (exoticCount > 1) continue;
        const pieces = [...state.pieces];
        pieces[slotIndex] = candidate.piece;
        const descriptors = [...state.descriptors];
        descriptors[slotIndex] = candidate.contribution.descriptor;
        const capabilityKeys = [...state.capabilityKeys];
        capabilityKeys[slotIndex] = candidate.capabilityKey;
        const identityKeys = [...state.identityKeys];
        identityKeys[slotIndex] = getPieceInstanceKey(candidate.piece);
        const nextState = {
          pieces,
          descriptors,
          capabilityKeys,
          identityKeys,
          exoticCount,
          coverageA: Math.min(
            state.coverageA + candidate.coverage[0],
            requirement.type === "set" ? requirement.count : 2,
          ),
          coverageB: Math.min(
            state.coverageB + candidate.coverage[1],
            requirement.type === "split" ? 2 : 0,
          ),
          stats: Object.fromEntries(STATS.map(stat => [
            stat,
            state.stats[stat] + candidate.contribution.stats[stat],
          ])),
        };
        const key = getStateKey(nextState);
        const previous = next.get(key);
        if (!previous || identityKeys.join("|").localeCompare(
          previous.identityKeys.join("|"),
        ) < 0) {
          next.set(key, nextState);
        }
      }
    }
    states = next;
    if (states.size === 0) return [];
  }

  const loadouts = [];
  for (const state of [...states.values()].sort((left, right) =>
    left.identityKeys.join("|").localeCompare(right.identityKeys.join("|")))) {
    if (!satisfiesRequirement(state.pieces, requirement)) continue;
    loadouts.push(state.pieces);
  }
  return loadouts;
}

function combinations(items, count) {
  const out = [];
  const pick = (start, chosen) => {
    if (chosen.length === count) {
      out.push([...chosen]);
      return;
    }
    for (let index = start; index < items.length; index++) {
      chosen.push(items[index]);
      pick(index + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);
  return out;
}

function enumerateSetAssignments(bySlot, requirement) {
  if (requirement.type === "set") {
    return enumerateCountAssignments(bySlot, Number(requirement.setHash), requirement.count);
  }
  if (requirement.type === "split") {
    return enumerateSplitAssignments(bySlot, Number(requirement.a), Number(requirement.b));
  }
  // No set requirement: every slot is free to pick any owned piece.
  return [{ fixed: new Map(), free: [...SLOT_ORDER] }];
}

// Choose `count` slots (out of five) that carry the required set's piece.
function enumerateCountAssignments(bySlot, setHash, count) {
  const setSlots = SLOT_ORDER.filter(slot =>
    bySlot.get(slot).some(item => item.setHash === setHash)
  );
  const out = [];
  for (const chosen of combinations(setSlots, count)) {
    const fixed = new Map();
    for (const slot of chosen) {
      fixed.set(slot, setHash);
    }
    out.push({ fixed, free: SLOT_ORDER.filter(slot => !chosen.includes(slot)) });
  }
  return out;
}

// Two different sets, two pieces each, one slot left free.
function enumerateSplitAssignments(bySlot, aHash, bHash) {
  if (aHash === bHash) return [];
  const aSlots = SLOT_ORDER.filter(slot =>
    bySlot.get(slot).some(item => item.setHash === aHash)
  );
  const out = [];
  for (const aChosen of combinations(aSlots, 2)) {
    const remaining = SLOT_ORDER.filter(slot => !aChosen.includes(slot));
    const bSlots = remaining.filter(slot =>
      bySlot.get(slot).some(item => item.setHash === bHash)
    );
    for (const bChosen of combinations(bSlots, 2)) {
      const fixed = new Map();
      for (const slot of aChosen) {
        fixed.set(slot, aHash);
      }
      for (const slot of bChosen) {
        fixed.set(slot, bHash);
      }
      out.push({
        fixed,
        free: remaining.filter(slot => !bChosen.includes(slot)),
      });
    }
  }
  return out;
}

function getPieceInstanceKey(piece) {
  if (piece?.sourceId) return `id:${piece.sourceId}`;
  if (piece?.id) return `id:${piece.id}`;
  const stats = STATS.map(stat => piece?.baseStats?.[stat] || 0).join(",");
  return `hash:${piece?.hash || 0}:${stats}`;
}

function isLegalArmorLoadout(pieces) {
  return pieces.filter(piece => piece?.exotic).length <= 1;
}

function satisfiesRequirement(pieces, requirement) {
  const counts = new Map();
  for (const piece of pieces) {
    if (piece?.setHash) {
      counts.set(piece.setHash, (counts.get(piece.setHash) || 0) + 1);
    }
  }
  if (requirement.type === "set") {
    return (counts.get(Number(requirement.setHash)) || 0) >= requirement.count;
  }
  if (requirement.type === "split") {
    return (counts.get(Number(requirement.a)) || 0) >= 2
      && (counts.get(Number(requirement.b)) || 0) >= 2;
  }
  return true;
}
