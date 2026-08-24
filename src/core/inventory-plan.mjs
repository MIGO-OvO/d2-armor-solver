import { ARCHETYPES, STATS } from "./armor-model.mjs";
import { compareScoreRanks, farmabilityScore } from "./solver.mjs";

export const INVENTORY_PLAN_SLOTS = Object.freeze([
  "helmet",
  "arms",
  "chest",
  "legs",
  "classItem",
]);

const LEGENDARY_SLOTS = INVENTORY_PLAN_SLOTS.slice(0, 4);
const MAX_MATCH_CANDIDATES = 8;

function archetypeIdForName(name) {
  // Exotic class item configs carry the archetype ID (e.g. "Brawler") while
  // legendary configs carry the localized name; accept both.
  return ARCHETYPES.find(archetype => archetype.name === name || archetype.id === name)?.id || null;
}

function getItemTuningTo(item) {
  return item?.tuningTo || item?.tuningStat || null;
}

function getItemKey(item) {
  return item?.sourceId || item?.id || `${item?.hash || 0}:${item?.slot || ""}:${item?.name || ""}`;
}

function getEligibilityKey({
  slot, archetypeId, tertiary, tuningMode, exotic,
}) {
  const normalizedMode = tuningMode === "plus3" ? "plus3" : "shift";
  return `${slot}|${archetypeId}|${tertiary}|${normalizedMode}|${Number(Boolean(exotic))}`;
}

function getSetRequirement(requirement = { type: "none" }) {
  if (!requirement || requirement.type === "none") return { type: "none" };
  if (requirement.type === "set") {
    return { type: "set", setHash: Number(requirement.setHash), count: Number(requirement.count) };
  }
  return { type: "split", a: Number(requirement.a), b: Number(requirement.b) };
}

function getSolutionRequirements(solution, fixedExotic = null) {
  const requirements = [];
  let legendaryIndex = 0;
  const hasExoticClassItem = solution.exoticIndex !== null && solution.exoticIndex !== undefined;
  for (let index = 0; index < solution.config.length; index++) {
    const config = solution.config[index];
    const tuning = solution.tuningAssignments[index];
    const isClassItem = solution.exoticIndex === index;
    const slot = hasExoticClassItem
      ? (isClassItem ? "classItem" : LEGENDARY_SLOTS[legendaryIndex++])
      : INVENTORY_PLAN_SLOTS[index];
    requirements.push({
      index,
      slot,
      archetype: config.archetype,
      archetypeId: archetypeIdForName(config.archetype),
      tertiary: config.tertiary,
      tuningMode: tuning?.mode === "+3" ? "plus3" : "shift",
      tuningTo: tuning?.mode === "+3" ? null : tuning?.to,
      exotic: isClassItem || slot === fixedExotic?.slot,
    });
  }
  return requirements;
}

function matchesFixedExoticIdentity(item, fixedExotic) {
  if (!item || !fixedExotic) return false;
  const fixedName = String(fixedExotic.name || "").trim().toLocaleLowerCase();
  const itemName = String(item.name || "").trim().toLocaleLowerCase();
  if (fixedName && itemName) {
    return fixedName === itemName;
  }
  return Number(fixedExotic.hash) > 0 && Number(item.hash) > 0 &&
    Number(item.hash) === Number(fixedExotic.hash);
}

function getFixedExoticMismatch(item, requirement) {
  const fields = [];
  let score = 0;
  if (item.archetypeId !== requirement.archetypeId) {
    fields.push("archetype");
    score += 100;
  }
  if (item.tertiary !== requirement.tertiary) {
    fields.push("tertiary");
    score += 20;
  }
  const itemTuningMode = item.tuningMode === "plus3" ? "plus3" : "shift";
  if (itemTuningMode !== requirement.tuningMode) {
    fields.push("tuningMode");
    score += 10;
  } else if (requirement.tuningMode === "shift" && getItemTuningTo(item) !== requirement.tuningTo) {
    fields.push("tuningTo");
    score += 5;
  }
  return { score, fields };
}

function isItemEligible(item, requirement, options) {
  if (!item || item.slot !== requirement.slot) return false;
  if (options.classId && item.classId !== options.classId) return false;
  if (item.archetypeId !== requirement.archetypeId) return false;
  if (item.tertiary !== requirement.tertiary) return false;
  // The tuning MODE is installed on the piece and read from the export. The
  // fixed +5 side of a +5/-5 roll is rolled onto LEGENDARY armor and cannot be
  // re-picked (only the -5 source is free), so a legendary piece only serves a
  // shift requirement whose +5 destination matches its fixed roll. Exotic armor
  // accepts any directional tuning, so its +5 side is never filtered here.
  if (requirement.tuningMode === "plus3") {
    if (item.tuningMode !== "plus3") return false;
  } else {
    if (item.tuningMode === "plus3") return false;
    if (!item.exotic && getItemTuningTo(item) !== requirement.tuningTo) return false;
  }

  const fixedExotic = options.fixedExotic || null;
  const wantsFixedExotic = Boolean(fixedExotic && requirement.slot === fixedExotic.slot);
  const wantsExotic = Boolean(requirement.exotic || wantsFixedExotic);
  if (Boolean(item.exotic) !== wantsExotic) return false;
  if (wantsFixedExotic && fixedExotic.classId && item.classId !== fixedExotic.classId) return false;
  if (wantsFixedExotic && !matchesFixedExoticIdentity(item, fixedExotic)) return false;
  return true;
}

function findClosestFixedExotic(pool, requirement, fixedExotic, setRequirement) {
  if (!fixedExotic || requirement.slot !== fixedExotic.slot) return null;
  const candidates = pool
    .filter(item => Boolean(item.exotic) && item.slot === requirement.slot)
    .filter(item => !fixedExotic.classId || item.classId === fixedExotic.classId)
    .filter(item => matchesFixedExoticIdentity(item, fixedExotic))
    .map(item => ({ item, mismatch: getFixedExoticMismatch(item, requirement) }))
    .sort((left, right) => left.mismatch.score - right.mismatch.score ||
      sortCandidates(left.item, right.item, setRequirement));
  return candidates[0] || null;
}

function sortCandidates(left, right, setRequirement) {
  const leftSet = left.setHash || 0;
  const rightSet = right.setHash || 0;
  const setPreference = setRequirement.type === "set"
    ? Number(setRequirement.setHash)
    : null;
  const splitPreference = setRequirement.type === "split"
    ? new Set([Number(setRequirement.a), Number(setRequirement.b)])
    : null;
  const leftRequired = setPreference === leftSet || splitPreference?.has(leftSet) ? 1 : 0;
  const rightRequired = setPreference === rightSet || splitPreference?.has(rightSet) ? 1 : 0;
  if (leftRequired !== rightRequired) return rightRequired - leftRequired;
  if (Boolean(left.equipped) !== Boolean(right.equipped)) return left.equipped ? -1 : 1;
  if (Boolean(left.dimLocked) !== Boolean(right.dimLocked)) return left.dimLocked ? -1 : 1;
  if (Number(left.masterworkTier) !== Number(right.masterworkTier)) {
    return Number(right.masterworkTier) - Number(left.masterworkTier);
  }
  return String(left.name || "").localeCompare(String(right.name || ""));
}

function getSetCoverage(pieces, setRequirement) {
  if (setRequirement.type === "none") return 0;
  const counts = new Map();
  for (const item of pieces) {
    if (!item?.setHash) continue;
    counts.set(Number(item.setHash), (counts.get(Number(item.setHash)) || 0) + 1);
  }
  if (setRequirement.type === "set") {
    return Math.min(Number(setRequirement.count), counts.get(Number(setRequirement.setHash)) || 0);
  }
  return Math.min(2, counts.get(Number(setRequirement.a)) || 0)
    + Math.min(2, counts.get(Number(setRequirement.b)) || 0);
}

function getMaximumSetCoverage(setRequirement) {
  if (setRequirement.type === "set") return Number(setRequirement.count);
  if (setRequirement.type === "split") return 4;
  return 0;
}

// Candidate identity is irrelevant to exact stat reachability once slot,
// archetype, tertiary, and tuning mode have matched. Only the pinned +5 side
// and (when requested) set membership can change the assignment outcome.
// Keeping the first sorted item for each signature preserves equipped/locked/
// masterwork preferences without re-exploring equivalent search states.
function compressAssignmentCandidates(candidates, setRequirement) {
  const compressed = [];
  const seen = new Set();
  for (const item of candidates) {
    const setKey = setRequirement.type === "none"
      ? ""
      : Number(item.setHash) || 0;
    const key = `${getItemTuningTo(item) || "free"}|${setKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    compressed.push(item);
  }
  return compressed;
}

function canCompleteSetRequirement(chosen, missing, setRequirement) {
  if (setRequirement.type === "none") return true;
  const farmableSlots = missing.filter(entry => !entry.requirement.exotic).length;
  if (setRequirement.type === "set") {
    const deficit = Math.max(0, Number(setRequirement.count) - getSetCoverage(chosen, setRequirement));
    return deficit <= farmableSlots;
  }

  const counts = new Map();
  for (const item of chosen) {
    if (item?.setHash) counts.set(Number(item.setHash), (counts.get(Number(item.setHash)) || 0) + 1);
  }
  const deficit = Math.max(0, 2 - (counts.get(Number(setRequirement.a)) || 0))
    + Math.max(0, 2 - (counts.get(Number(setRequirement.b)) || 0));
  return deficit <= farmableSlots;
}

function getSetTargetLabels(missing, chosen, setRequirement) {
  if (setRequirement.type === "none") return missing.map(() => null);
  const coverage = getSetCoverage(chosen, setRequirement);
  if (setRequirement.type === "set") {
    let need = Math.max(0, setRequirement.count - coverage);
    return missing.map(entry => {
      if (entry.requirement.exotic || need <= 0) return null;
      need--;
      return Number(setRequirement.setHash);
    });
  }

  const counts = new Map();
  for (const item of chosen) {
    if (item?.setHash) counts.set(Number(item.setHash), (counts.get(Number(item.setHash)) || 0) + 1);
  }
  let needA = Math.max(0, 2 - (counts.get(Number(setRequirement.a)) || 0));
  let needB = Math.max(0, 2 - (counts.get(Number(setRequirement.b)) || 0));
  return missing.map(entry => {
    if (entry.requirement.exotic) return null;
    if (needA > 0) {
      needA--;
      return Number(setRequirement.a);
    }
    if (needB > 0) {
      needB--;
      return Number(setRequirement.b);
    }
    return null;
  });
}

function chooseBestAssignment(solution, requirements, candidatesBySlot, setRequirement) {
  let best = null;
  let optimalFound = false;
  const chosen = [];
  const used = new Set();
  const exactnessCache = new Map();
  const maximumSetCoverage = getMaximumSetCoverage(setRequirement);

  function canReachExact() {
    const pinnedCounts = Object.fromEntries(STATS.map(stat => [stat, 0]));
    for (let index = 0; index < chosen.length; index++) {
      if (solution.tuningAssignments?.[index]?.mode === "+3") continue;
      const tuningTo = getItemTuningTo(chosen[index]);
      if (tuningTo) pinnedCounts[tuningTo]++;
    }
    const key = STATS.map(stat => pinnedCounts[stat]).join(",");
    if (!exactnessCache.has(key)) {
      exactnessCache.set(key, assignmentCanReachExact(solution, chosen));
    }
    return exactnessCache.get(key);
  }

  function consider() {
    const owned = chosen.filter(Boolean);
    const missing = requirements
      .map((requirement, index) => ({ requirement, index }))
      .filter(({ index }) => !chosen[index]);
    const coverage = getSetCoverage(owned, setRequirement);
    const candidate = {
      chosen: [...chosen],
      ownedCount: owned.length,
      farmCount: missing.length,
      setCoverage: coverage,
      setFeasible: canCompleteSetRequirement(owned, missing, setRequirement),
      farmSetHashes: getSetTargetLabels(missing, owned, setRequirement),
    };
    candidate.feasible = candidate.setFeasible && canReachExact();
    if (!best || (candidate.feasible && !best.feasible) ||
        (candidate.feasible === best.feasible && candidate.ownedCount > best.ownedCount) ||
        (candidate.feasible === best.feasible && candidate.ownedCount === best.ownedCount &&
          candidate.setCoverage > best.setCoverage)) {
      best = candidate;
      optimalFound = candidate.feasible
        && candidate.ownedCount === requirements.length
        && candidate.setCoverage === maximumSetCoverage;
    }
  }

  function walk(index, ownedSoFar) {
    if (optimalFound) return;
    if (best?.feasible && ownedSoFar + requirements.length - index < best.ownedCount) {
      return;
    }
    if (index >= requirements.length) {
      consider();
      return;
    }
    for (const item of candidatesBySlot[index]) {
      if (item && used.has(getItemKey(item))) continue;
      if (item) used.add(getItemKey(item));
      chosen[index] = item;
      walk(index + 1, ownedSoFar + Number(Boolean(item)));
      if (item) used.delete(getItemKey(item));
      if (optimalFound) return;
    }
    chosen[index] = null;
  }

  walk(0, 0);
  return best;
}

// ============================================================
// EXACT-REACHABILITY OF AN OWNED ASSIGNMENT
// ============================================================
// An owned LEGENDARY piece pins only its fixed +5 roll (the +5 side of a Tuning
// Mod). Exotic armor accepts any directional tuning, so its +5 side stays free.
// The -5 sources, the armor mods, and every roll of a farmed piece stay free.
// This checks whether the solution's exact totals are still reachable given
// the pinned +5 rolls, by counting how the +5/+10 mods and the free +5 sides
// can absorb the residual. (mods contribute +5s without a matching -5, so the
// -5 budget is exactly one per shift piece, while the +5 budget is one per
// shift piece plus every mod.)
function forEachModAllocation(numPlus5, numPlus10, visit) {
  const m = Object.fromEntries(STATS.map(stat => [stat, 0]));
  function walk(statIndex, c5Left, c10Left) {
    if (statIndex === STATS.length) {
      if (c5Left === 0 && c10Left === 0) visit(m);
      return;
    }
    const stat = STATS[statIndex];
    for (let c5 = 0; c5 <= c5Left; c5++) {
      for (let c10 = 0; c10 <= c10Left; c10++) {
        m[stat] = c5 * 5 + c10 * 10;
        walk(statIndex + 1, c5Left - c5, c10Left - c10);
      }
    }
    m[stat] = 0;
  }
  walk(0, numPlus5, numPlus10);
}

export function assignmentCanReachExact(solution, chosen) {
  const config = solution?.config;
  const totals = solution?.totals;
  const hasTotals = Boolean(totals) &&
    STATS.every(stat => Number.isFinite(totals[stat]));
  if (!config || config.length !== 5 || !hasTotals) return true;

  let numPlus5 = 0;
  let numPlus10 = 0;
  for (const assignment of Object.values(solution.modAssignments || {})) {
    if (assignment?.size === 5) numPlus5++;
    else if (assignment?.size === 10) numPlus10++;
  }

  const base = Object.fromEntries(STATS.map(stat => [stat, 0]));
  const pinned = Object.fromEntries(STATS.map(stat => [stat, 0]));
  let numShift = 0;
  let freeCount = 0;
  for (let index = 0; index < 5; index++) {
    const piece = config[index];
    for (const stat of STATS) base[stat] += piece.baseStats[stat];
    if (solution.tuningAssignments?.[index]?.mode === "+3") {
      for (const stat of piece.masterworkStats || []) base[stat] += 1;
      continue;
    }
    numShift++;
    const item = chosen[index];
    // Exotic armor accepts any directional tuning, so its +5 side is free to
    // re-roll and never pins a stat. Only a legendary piece's rolled +5 is
    // fixed and pins that stat.
    const pinnedTo = item && !item.exotic ? getItemTuningTo(item) : null;
    if (pinnedTo) pinned[pinnedTo]++;
    else freeCount++;
  }
  // Nothing pinned: the stored solution itself is the exact witness.
  if (freeCount === numShift) return true;

  const residual = Object.fromEntries(STATS.map(stat => [
    stat, totals[stat] - base[stat] - 5 * pinned[stat],
  ]));

  // For a given mod placement the residual must decompose into the free +5
  // sides (t) and free -5 sources (f) of the shift pieces. With to/from counts
  // t_s/f_s: need_s = (residual - mods)/5 = t_s - f_s, sum(t) = sum(f) =
  // numShift, t_s >= pinned_s. Hall's condition on the "from != to" pairing
  // reduces to t_s <= (numShift + need_s)/2 per stat, so a closed form works.
  let feasible = false;
  forEachModAllocation(numPlus5, numPlus10, m => {
    if (feasible) return;
    let lowerSum = 0;
    let upperSum = 0;
    for (const stat of STATS) {
      const value = residual[stat] - m[stat];
      if (value % 5 !== 0) return;
      const need = value / 5;
      const lower = Math.max(pinned[stat], need);
      const upper = Math.floor((numShift + need) / 2);
      if (lower > upper) return;
      lowerSum += lower;
      upperSum += upper;
    }
    if (lowerSum <= numShift && numShift <= upperSum) feasible = true;
  });
  return feasible;
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

// When the pinned +5 rolls of the chosen owned pieces make the exact totals
// unreachable, downgrade the smallest number of owned pieces back to "farm"
// until the remaining assignment is feasible again. Set-constrained plans keep
// the original assignment: their slots must keep their set membership.
function repairChosenForExactness(solution, chosen, setRequirement) {
  if (setRequirement.type !== "none") return chosen;
  if (assignmentCanReachExact(solution, chosen)) return chosen;
  const ownedIndexes = chosen
    .map((item, index) => (item ? index : -1))
    .filter(index => index >= 0);
  for (let removeCount = 1; removeCount <= ownedIndexes.length; removeCount++) {
    for (const subset of combinations(ownedIndexes, removeCount)) {
      const trial = [...chosen];
      for (const index of subset) trial[index] = null;
      if (assignmentCanReachExact(solution, trial)) return trial;
    }
  }
  return chosen;
}

function comparePlans(left, right) {
  // Plans whose owned pieces can actually reach the exact totals rank first.
  if (left.feasible !== right.feasible) return left.feasible ? -1 : 1;
  const targetOrder = compareScoreRanks(left.solution?.rank, right.solution?.rank);
  if (targetOrder !== 0) return targetOrder;
  if (left.farmCount !== right.farmCount) return left.farmCount - right.farmCount;
  if (left.fixedExoticDistance !== right.fixedExoticDistance) {
    return left.fixedExoticDistance - right.fixedExoticDistance;
  }
  if (left.farmability !== right.farmability) return left.farmability - right.farmability;
  if (left.score !== right.score) return left.score - right.score;
  return right.ownedCount - left.ownedCount;
}

export function rankInventoryPlans({
  solutions = [],
  items = [],
  classId = null,
  fixedExotic = null,
  setRequirement = { type: "none" },
  maxResults = 12,
} = {}) {
  const normalizedSetRequirement = getSetRequirement(setRequirement);
  const pool = items.filter(item => !classId || item.classId === classId);
  const eligibleItemsByKey = new Map();
  for (const item of pool) {
    const key = getEligibilityKey(item);
    const bucket = eligibleItemsByKey.get(key) || [];
    bucket.push(item);
    eligibleItemsByKey.set(key, bucket);
  }
  const plans = [];

  for (const solution of solutions) {
    const requirements = getSolutionRequirements(solution, fixedExotic);
    if (requirements.length !== INVENTORY_PLAN_SLOTS.length) continue;
    if (solution.exoticIndex !== null && solution.exoticIndex !== undefined && fixedExotic) continue;

    const candidatesBySlot = requirements.map(requirement => {
      const candidates = compressAssignmentCandidates((
        eligibleItemsByKey.get(getEligibilityKey(requirement)) || []
      )
        .filter(item => isItemEligible(item, requirement, { classId, fixedExotic }))
        .sort((left, right) => sortCandidates(left, right, normalizedSetRequirement)),
        normalizedSetRequirement,
      ).slice(0, MAX_MATCH_CANDIDATES);
      return [...candidates, null];
    });
    const assignment = chooseBestAssignment(
      solution, requirements, candidatesBySlot, normalizedSetRequirement
    );
    if (!assignment) continue;
    assignment.chosen = repairChosenForExactness(solution, assignment.chosen, normalizedSetRequirement);
    assignment.ownedCount = assignment.chosen.filter(Boolean).length;
    assignment.farmCount = requirements.length - assignment.ownedCount;

    const missingIndexes = requirements
      .map((requirement, index) => ({ requirement, index }))
      .filter(({ index }) => !assignment.chosen[index]);
    const pieces = requirements.map((requirement, index) => {
      const item = assignment.chosen[index];
      const closest = item
        ? null
        : findClosestFixedExotic(pool, requirement, fixedExotic, normalizedSetRequirement);
      return {
        ...requirement,
        item,
        closestItem: closest?.item || null,
        closestMismatch: closest?.mismatch || null,
        farmSetHash: assignment.farmSetHashes[missingIndexes.findIndex(entry => entry.index === index)] || null,
      };
    });
    const fixedExoticPiece = fixedExotic
      ? pieces.find(piece => piece.slot === fixedExotic.slot)
      : null;
    const plan = {
      solution,
      requirements,
      pieces,
      ownedCount: assignment.ownedCount,
      farmCount: assignment.farmCount,
      setCoverage: assignment.setCoverage,
      feasible: assignmentCanReachExact(solution, assignment.chosen),
      fixedExoticDistance: !fixedExotic || fixedExoticPiece?.item
        ? 0
        : fixedExoticPiece?.closestMismatch?.score ?? Number.MAX_SAFE_INTEGER,
      farmability: farmabilityScore(solution.config, solution.exoticIndex),
      score: solution.score,
    };
    plans.push(plan);
  }

  plans.sort(comparePlans);
  return plans.slice(0, maxResults);
}

export function formatInventoryPlanRequirement(piece) {
  return {
    slot: piece.slot,
    archetype: piece.archetype,
    tertiary: piece.tertiary,
    tuningMode: piece.tuningMode,
    tuningTo: piece.tuningTo,
    exotic: piece.exotic,
    farmSetHash: piece.farmSetHash,
  };
}

export function inventoryPlanHasFixedExotic(plan) {
  return plan?.pieces?.some(piece => piece.exotic) === true;
}

export { comparePlans as compareInventoryPlans };
