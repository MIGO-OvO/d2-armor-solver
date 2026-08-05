import { ARCHETYPES } from "./armor-model.mjs";
import { farmabilityScore } from "./solver.mjs";

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
  return ARCHETYPES.find(archetype => archetype.name === name)?.id || null;
}

function getItemTuningTo(item) {
  return item?.tuningTo || item?.tuningStat || null;
}

function getItemKey(item) {
  return item?.sourceId || item?.id || `${item?.hash || 0}:${item?.slot || ""}:${item?.name || ""}`;
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
  if (requirement.tuningMode === "plus3") {
    if (item.tuningMode !== "plus3") return false;
  } else if (item.tuningMode === "plus3" || getItemTuningTo(item) !== requirement.tuningTo) {
    return false;
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

function chooseBestAssignment(requirements, candidatesBySlot, setRequirement) {
  let best = null;
  const chosen = [];
  const used = new Set();

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
    if (!best || (candidate.setFeasible && !best.setFeasible) ||
        (candidate.setFeasible === best.setFeasible && candidate.ownedCount > best.ownedCount) ||
        (candidate.setFeasible === best.setFeasible && candidate.ownedCount === best.ownedCount &&
          candidate.setCoverage > best.setCoverage)) {
      best = candidate;
    }
  }

  function walk(index) {
    if (index >= requirements.length) {
      consider();
      return;
    }
    for (const item of candidatesBySlot[index]) {
      if (item && used.has(getItemKey(item))) continue;
      if (item) used.add(getItemKey(item));
      chosen[index] = item;
      walk(index + 1);
      if (item) used.delete(getItemKey(item));
    }
    chosen[index] = null;
  }

  walk(0);
  consider();
  return best;
}

function comparePlans(left, right) {
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
  const plans = [];

  for (const solution of solutions) {
    const requirements = getSolutionRequirements(solution, fixedExotic);
    if (requirements.length !== INVENTORY_PLAN_SLOTS.length) continue;
    if (solution.exoticIndex !== null && solution.exoticIndex !== undefined && fixedExotic) continue;

    const candidatesBySlot = requirements.map(requirement => {
      const candidates = pool
        .filter(item => isItemEligible(item, requirement, { classId, fixedExotic }))
        .sort((left, right) => sortCandidates(left, right, normalizedSetRequirement))
        .slice(0, MAX_MATCH_CANDIDATES);
      return [...candidates, null];
    });
    const assignment = chooseBestAssignment(requirements, candidatesBySlot, normalizedSetRequirement);
    if (!assignment) continue;

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
