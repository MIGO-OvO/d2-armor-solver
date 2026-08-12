import { STATS } from "./armor-model.mjs";
import {
  compareUpgradeMetrics,
  createUpgradePieceFromItem,
  evaluateUpgradePieces,
  getUpgradeConfig,
} from "./upgrade-optimizer.mjs";

const SLOT_ORDER = ["helmet", "arms", "chest", "legs", "classItem"];
const MAX_FREE_CANDIDATES = 24;
const MAX_LOCAL_CANDIDATES = 12;
const MAX_ASSIGNMENTS = 200;
const EXACT_COMBINATION_LIMIT = 4096;
const INVENTORY_BEAM_WIDTH = 64;

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
}) {
  if (!setRequirement) return null;
  const normalizedRequiredStats = [...new Set(requiredStats)]
    .filter(stat => STATS.includes(stat));

  const bySlot = new Map();
  for (const slot of SLOT_ORDER) bySlot.set(slot, []);
  for (const item of items) {
    if (item?.slot && bySlot.has(item.slot)) bySlot.get(item.slot).push(item);
  }
  const armorTarget = Object.fromEntries(STATS.map(stat => [
    stat,
    Math.max(0, (targets[stat] || 0) - (fragments[stat] || 0)),
  ]));
  const evaluate = pieces => evaluateUpgradePieces(
    pieces, targets, fragments, reassignModifiers, normalizedRequiredStats,
    onlyPlus5Tuning
  );
  const lockedPiecesBySlot = new Map(
    (Array.isArray(currentPieces) ? currentPieces : [])
      .filter(piece => piece?.locked && SLOT_ORDER.includes(piece.slot))
      .map(piece => [piece.slot, { ...piece }]),
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
  for (const assignment of assignments.slice(0, MAX_ASSIGNMENTS)) {
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
    const beamPieces = searchAssignmentBeam(
      bySlot,
      constrainedAssignment,
      armorTarget,
      lockedPiecesBySlot,
      normalizedRequiredStats,
    );
    if (beamPieces.length > 0) {
      const evaluatedBeam = beamPieces.map(pieces => ({
        pieces,
        evaluation: evaluate(pieces),
      })).sort((left, right) =>
        compareUpgradeMetrics(left.evaluation.metrics, right.evaluation.metrics));
      for (const entry of evaluatedBeam) {
        if (!isLegalArmorLoadout(entry.pieces)) continue;
        if (!satisfiesRequirement(entry.pieces, setRequirement)) continue;
        push(entry.pieces, entry.evaluation);
        examined++;
      }
      const searchableSlots = SLOT_ORDER.filter(slot => !lockedPiecesBySlot.has(slot));
      for (const entry of evaluatedBeam.slice(0, 4)) {
        examined += localSearch(
          entry.pieces, searchableSlots, bySlot, constrainedAssignment.fixed,
          armorTarget, normalizedRequiredStats, evaluate, push
        );
      }
      continue;
    }
    const filled = greedyFill(
      bySlot, constrainedAssignment, armorTarget, lockedPiecesBySlot,
      normalizedRequiredStats
    );
    if (!filled) continue;
    // A locked piece may occupy a slot selected by the set assignment. Reject
    // that assignment unless the resulting five real pieces still satisfy it.
    if (!isLegalArmorLoadout(filled.pieces)
      || !satisfiesRequirement(filled.pieces, setRequirement)) continue;
    push(filled.pieces, evaluate(filled.pieces));
    examined++;
    const searchableSlots = SLOT_ORDER.filter(slot => !lockedPiecesBySlot.has(slot));
    examined += localSearch(
      filled.pieces, searchableSlots, bySlot, constrainedAssignment.fixed,
      armorTarget, normalizedRequiredStats, evaluate, push
    );
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
    if (combinationCount > EXACT_COMBINATION_LIMIT) return null;
    candidatesBySlot.push(items.map(item => ({ item })));
  }

  const loadouts = [];
  const chosen = Array(SLOT_ORDER.length);
  const enumerate = (slotIndex, exoticCount) => {
    if (slotIndex === SLOT_ORDER.length) {
      loadouts.push(chosen.map((candidate, index) => candidate.piece
        ? { ...candidate.piece }
        : createUpgradePieceFromItem(candidate.item, index)));
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

function searchAssignmentBeam(
  bySlot, assignment, armorTarget, lockedPiecesBySlot, requiredStats
) {
  let states = [{
    chosen: [],
    partial: Object.fromEntries(STATS.map(stat => [stat, 0])),
    score: 0,
    exoticCount: 0,
  }];
  for (let slotIndex = 0; slotIndex < SLOT_ORDER.length; slotIndex++) {
    const slot = SLOT_ORDER[slotIndex];
    const lockedPiece = lockedPiecesBySlot.get(slot);
    const requiredSetHash = assignment.fixed.get(slot);
    const next = [];
    for (const state of states) {
      if (lockedPiece) {
        const exoticCount = state.exoticCount + Number(Boolean(lockedPiece.exotic));
        if (exoticCount > 1) continue;
        const baseStats = getUpgradeConfig(lockedPiece).baseStats;
        const partial = { ...state.partial };
        for (const stat of STATS) partial[stat] += baseStats?.[stat] || 0;
        next.push({
          chosen: [...state.chosen, { piece: { ...lockedPiece } }],
          partial,
          score: fitScore(null, partial, slotIndex + 1, armorTarget, requiredStats),
          exoticCount,
        });
        continue;
      }
      const items = requiredSetHash
        ? bySlot.get(slot).filter(item => item.setHash === requiredSetHash)
        : bySlot.get(slot);
      const candidates = rankSlotCandidates(
        items.filter(item => !item.exotic || state.exoticCount === 0),
        state.partial, slotIndex + 1, armorTarget, requiredStats
      );
      for (const item of candidates) {
        const exoticCount = state.exoticCount + Number(Boolean(item.exotic));
        if (exoticCount > 1) continue;
        const partial = { ...state.partial };
        const itemStats = getItemStats(item);
        for (const stat of STATS) partial[stat] += itemStats[stat] || 0;
        next.push({
          chosen: [...state.chosen, { item }],
          partial,
          score: fitScore(null, partial, slotIndex + 1, armorTarget, requiredStats),
          exoticCount,
        });
      }
    }
    next.sort((left, right) => left.score - right.score);
    states = next.slice(0, INVENTORY_BEAM_WIDTH);
    if (states.length === 0) return [];
  }
  return states.map(state => state.chosen.map((candidate, index) =>
    candidate.piece
      ? { ...candidate.piece }
      : createUpgradePieceFromItem(candidate.item, index)));
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

function fitScore(baseStats, partial, completed, armorTarget, requiredStats = []) {
  const requiredSet = new Set(requiredStats);
  let score = 0;
  for (const stat of STATS) {
    const actual = partial[stat] + (baseStats?.[stat] || 0);
    const expected = armorTarget[stat] * (completed / 5);
    const diff = actual - expected;
    const requiredWeight = requiredSet.has(stat) ? 1e6 : 1;
    score += (diff < 0 ? diff * diff * 3 : diff * diff) * requiredWeight;
  }
  return score;
}

function getItemStats(item) {
  return item?.optimizationBaseStats || item?.effectiveBaseStats || item?.baseStats || {};
}

function getPieceInstanceKey(piece) {
  if (piece?.sourceId) return `id:${piece.sourceId}`;
  if (piece?.id) return `id:${piece.id}`;
  const stats = STATS.map(stat => piece?.baseStats?.[stat] || 0).join(",");
  return `hash:${piece?.hash || 0}:${stats}`;
}

function rankSlotCandidates(items, partial, completed, armorTarget, requiredStats = []) {
  return [...items]
    .sort((a, b) =>
      fitScore(getItemStats(a), partial, completed, armorTarget, requiredStats) -
      fitScore(getItemStats(b), partial, completed, armorTarget, requiredStats)
    )
    .slice(0, MAX_FREE_CANDIDATES);
}

// Fill the free slots one at a time with the owned piece that best fits the
// remaining target ratio. Returns null when any slot has no candidate.
function greedyFill(
  bySlot, assignment, armorTarget, lockedPiecesBySlot = new Map(), requiredStats = []
) {
  const fixed = [];
  const partial = Object.fromEntries(STATS.map(stat => [stat, 0]));
  let exoticCount = 0;
  for (const slot of SLOT_ORDER) {
    const lockedPiece = lockedPiecesBySlot.get(slot);
    if (lockedPiece) {
      exoticCount += Number(Boolean(lockedPiece.exotic));
      if (exoticCount > 1) return null;
      fixed.push({ slot, piece: { ...lockedPiece } });
      const baseStats = getUpgradeConfig(lockedPiece).baseStats;
      for (const stat of STATS) partial[stat] += baseStats?.[stat] || 0;
      continue;
    }
    const requiredSetHash = assignment.fixed.get(slot);
    if (!requiredSetHash) continue;
    const item = rankSlotCandidates(
      bySlot.get(slot).filter(candidate =>
        candidate.setHash === requiredSetHash
        && (!candidate.exotic || exoticCount === 0)
      ),
      partial,
      fixed.length + 1,
      armorTarget,
      requiredStats,
    )[0];
    if (!item) return null;
    exoticCount += Number(Boolean(item.exotic));
    fixed.push({ slot, item });
    const itemStats = getItemStats(item);
    for (const stat of STATS) partial[stat] += itemStats[stat] || 0;
  }

  const chosen = [...fixed];
  let completed = fixed.length;
  for (const slot of assignment.free) {
    const candidates = rankSlotCandidates(
      bySlot.get(slot).filter(candidate => !candidate.exotic || exoticCount === 0),
      partial, completed + 1, armorTarget, requiredStats
    );
    const item = candidates[0];
    if (!item) return null;
    exoticCount += Number(Boolean(item.exotic));
    chosen.push({ slot, item });
    const itemStats = getItemStats(item);
    for (const stat of STATS) partial[stat] += itemStats[stat] || 0;
    completed++;
  }
  const pieces = chosen
    .map(({ slot, item, piece }) => piece
      ? { ...piece }
      : createUpgradePieceFromItem(item, SLOT_ORDER.indexOf(slot)))
    .sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
  return { pieces };
}

// Swap each free slot with nearby candidates while the score improves.
function localSearch(
  initialPieces, searchableSlots, bySlot, fixedSets, armorTarget, requiredStats, evaluate, push
) {
  let bestPieces = [...initialPieces];
  let best = evaluate(bestPieces);
  let examined = 0;
  for (let pass = 0; pass < 2; pass++) {
    let improved = false;
    for (const slot of searchableSlots) {
      const index = bestPieces.findIndex(piece => piece.slot === slot);
      if (index < 0) continue;
      const requiredSetHash = fixedSets.get(slot);
      const slotItems = requiredSetHash
        ? bySlot.get(slot).filter(item => item.setHash === requiredSetHash)
        : bySlot.get(slot);
      const otherExoticCount = bestPieces.filter((piece, pieceIndex) =>
        pieceIndex !== index && piece.exotic
      ).length;
      const candidates = rankSlotCandidates(
        slotItems.filter(item => !item.exotic || otherExoticCount === 0),
        {}, 5, armorTarget, requiredStats,
      )
        .slice(0, MAX_LOCAL_CANDIDATES);
      for (const item of candidates) {
        if (getPieceInstanceKey(bestPieces[index]) === getPieceInstanceKey(item)) continue;
        const trial = bestPieces.map((piece, i) =>
          i === index
            ? createUpgradePieceFromItem(item, SLOT_ORDER.indexOf(slot))
            : piece
        );
        if (!isLegalArmorLoadout(trial)) continue;
        const trialEvaluation = evaluate(trial);
        examined++;
        if (compareUpgradeMetrics(trialEvaluation.metrics, best.metrics) < 0) {
          bestPieces = trial;
          best = trialEvaluation;
          improved = true;
          push(trial, trialEvaluation);
        }
      }
    }
    if (!improved) break;
  }
  return examined;
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
