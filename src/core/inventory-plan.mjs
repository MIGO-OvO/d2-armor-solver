import { STATS, normalizeArchetypeId } from "./armor-model.mjs";
import { compareScoreRanks, farmabilityScore } from "./solver.mjs";
import { physicalBaseStats, sealWitness, createResultCertificate, normalizePieceNumbers, createCanonicalId,
  satisfiesConstraintModel, STAT_DOMAIN } from "./solver-v3-contract.mjs";

export const INVENTORY_PLAN_SLOTS = Object.freeze([
  "helmet",
  "arms",
  "chest",
  "legs",
  "classItem",
]);

const LEGENDARY_SLOTS = INVENTORY_PLAN_SLOTS.slice(0, 4);

function archetypeIdForName(name) {
  return normalizeArchetypeId(name);
}

function getItemTunedStat(item) {
  return Object.prototype.hasOwnProperty.call(item || {}, "tunedStat")
    ? item.tunedStat : item?.tuningStat || item?.tuningTo || null;
}

function getItemDirectionalStats(item) {
  if (!item) return null;
  if (item.dataConfidence?.tuning === "unknown") return null;
  if (!item.exotic) {
    const tunedStat = getItemTunedStat(item);
    return tunedStat ? [tunedStat] : null;
  }
  if (Array.isArray(item.allowedTuningStats)) {
    return [...new Set(item.allowedTuningStats)].filter(stat => STATS.includes(stat));
  }
  return null;
}

function getItemKey(item) {
  return item?.sourceId || item?.id || `${item?.hash || 0}:${item?.slot || ""}:${item?.name || ""}`;
}

function getEligibilityKey({
  slot, archetypeId, tertiary, exotic,
}) {
  return `${slot}|${archetypeId}|${tertiary}|${Number(Boolean(exotic))}`;
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
      baseStats: { ...config.baseStats },
      tuningMode: tuning?.mode === "+3" ? "plus3" : "shift",
      tuningTo: tuning?.mode === "+3" ? null : tuning?.to,
      exotic: isClassItem || slot === fixedExotic?.slot,
    });
  }
  return requirements;
}

function matchesFixedExoticIdentity(item, fixedExotic) {
  if (!item || !fixedExotic) return false;
  // An unowned Exotic reservation is a farming requirement, not a wildcard
  // that may silently substitute a different owned Exotic.
  if (fixedExotic.reserved) return false;
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
  if (requirement.tuningMode === "shift"
      && !getItemDirectionalStats(item)?.includes(requirement.tuningTo)) {
    fields.push("tuningCapability");
    score += 5;
  }
  return { score, fields };
}

function isItemEligible(item, requirement, options) {
  if (!item || item.slot !== requirement.slot) return false;
  if (item.dataConfidence?.stats === "unknown") return false;
  if (options.classId && item.classId !== options.classId) return false;
  if (item.archetypeId !== requirement.archetypeId) return false;
  if (item.tertiary !== requirement.tertiary) return false;
  const base = item.optimizationBaseStats || physicalBaseStats(item);
  if (STATS.some(stat => base[stat] !== requirement.baseStats[stat])) return false;
  // Installed mode/source are assignment state. Balanced can be installed on
  // any compatible piece; a directional assignment only checks the immutable
  // Legendary tunedStat (Exotics expose a set of allowed destinations).
  if (requirement.tuningMode === "shift") {
    const allowedDirectionalStats = getItemDirectionalStats(item);
    if (!allowedDirectionalStats?.includes(requirement.tuningTo)) return false;
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
  return String(left.name || "").localeCompare(String(right.name || ""))
    || String(getItemKey(left)).localeCompare(String(getItemKey(right)));
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
// archetype and tertiary have matched. Only directional Tuning capability and
// (when requested) set membership can change the assignment outcome.
// Keeping the first sorted item for each signature preserves equipped/locked/
// masterwork preferences without re-exploring equivalent search states.
function compressAssignmentCandidates(candidates, setRequirement) {
  const compressed = [];
  const seen = new Set();
  for (const item of candidates) {
    const setHash = Number(item.setHash);
    const setKey = setRequirement.type === "none" ? 0 : setRequirement.type === "set"
      ? Number(setHash === Number(setRequirement.setHash))
      : setHash === Number(setRequirement.a) ? 1 : setHash === Number(setRequirement.b) ? 2 : 0;
    // Eligibility already bound the exact base and selected assignment.
    // Socket/energy variants do not change owned-count feasibility; this is
    // not an execution certificate. Keep the preferred physical representative.
    const key = `${item.classId || ""}|${setKey}`;
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
    const key = chosen.map(item => item ? getItemKey(item) : "farm").join("|");
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
      if (item?.classId && chosen.slice(0, index).some(previous => previous?.classId && previous.classId !== item.classId)) continue;
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
// RECONSTRUCTION OF THE ALREADY-SELECTED ASSIGNMENT
// ============================================================
// Matching never authorizes a second optimization. Physical bases and the
// fixed per-piece assignments must reproduce the source solution exactly.
export function assignmentCanReachExact(solution, chosen) {
  // Keep the proved assignment. An existential re-optimization is not the
  // assignment displayed alongside this plan.
  if (solution?.config?.length !== 5 || solution?.tuningAssignments?.length !== 5) return false;
  const rebuilt = Object.fromEntries(STATS.map(stat => [stat, 0]));
  for (let index = 0; index < 5; index++) {
    const config = solution.config[index];
    const item = chosen[index];
    const base = item ? item.optimizationBaseStats || physicalBaseStats(item) : config.baseStats;
    if (item && STATS.some(stat => base?.[stat] !== config.baseStats?.[stat])) return false;
    for (const stat of STATS) {
      if (!Number.isSafeInteger(base?.[stat])) return false;
      rebuilt[stat] += base[stat];
    }
    const tuning = solution.tuningAssignments[index];
    if (tuning.mode === "+3") {
      if (config.masterworkStats?.length !== 3) return false;
      for (const stat of config.masterworkStats) rebuilt[stat]++;
    } else {
      if (!STATS.includes(tuning.from) || !STATS.includes(tuning.to) || tuning.from === tuning.to) return false;
      if (item && !getItemDirectionalStats(item)?.includes(tuning.to)) return false;
      rebuilt[tuning.from] -= 5;
      rebuilt[tuning.to] += 5;
    }
    const mod = solution.modAssignments?.[index];
    if (mod) {
      if (![5, 10].includes(mod.size) || !STATS.includes(mod.stat)) return false;
      rebuilt[mod.stat] += mod.size;
    }
  }
  return STATS.every(stat => rebuilt[stat] === solution.totals?.[stat]);
}

// A source witness must satisfy the active rules before any of its owned
// substitutions can be presented as a qualifying plan. Without a bound
// constraint model the historical reproduction check is the only evidence and
// behaviour is preserved for callers that pass raw solver candidates.
export function sourceSatisfiesRules(solution) {
  const model = solution?.problemSpec?.constraintModel;
  if (!model) return true;
  return satisfiesConstraintModel(solution, model, STAT_DOMAIN.ARMOR);
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
  // 达标优先: rule-satisfying plans always outrank near-miss incumbents, even
  // when the near-miss owns more pieces and would otherwise win on savings.
  if (left.rulesFeasible !== right.rulesFeasible) return left.rulesFeasible ? -1 : 1;
  // Plans whose owned pieces can actually reach the exact totals rank first.
  if (left.feasible !== right.feasible) return left.feasible ? -1 : 1;
  const targetOrder = compareScoreRanks(left.solution?.rank, right.solution?.rank);
  if (targetOrder !== 0) return targetOrder;
  if (left.farmCount !== right.farmCount) return left.farmCount - right.farmCount;
  if (left.fixedExoticDistance !== right.fixedExoticDistance) {
    return left.fixedExoticDistance - right.fixedExoticDistance;
  }
  if (left.farmability !== right.farmability) return left.farmability - right.farmability;
  return right.ownedCount - left.ownedCount
    || createCanonicalId(left.solution).localeCompare(createCanonicalId(right.solution));
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
  const pool = items.filter(item => !classId || item.classId === classId).map(normalizePieceNumbers);
  const eligibleItemsByKey = new Map();
  for (const item of pool) {
    const key = getEligibilityKey(item);
    const bucket = eligibleItemsByKey.get(key) || [];
    bucket.push(item);
    eligibleItemsByKey.set(key, bucket);
  }
  const plans = [];

  for (const solution of solutions) {
    let requirements = getSolutionRequirements(solution, fixedExotic);
    if (requirements.length !== INVENTORY_PLAN_SLOTS.length) continue;
    if (solution.exoticIndex !== null && solution.exoticIndex !== undefined && fixedExotic) continue;

    const candidateCache = new Map();
    const candidatesFor = requirement => {
      const key = `${requirement.index}:${requirement.slot}`;
      if (candidateCache.has(key)) return candidateCache.get(key);
      const candidates = compressAssignmentCandidates((
        eligibleItemsByKey.get(getEligibilityKey(requirement)) || []
      )
        .filter(item => isItemEligible(item, requirement, { classId, fixedExotic }))
        .sort((left, right) => sortCandidates(left, right, normalizedSetRequirement)),
        normalizedSetRequirement,
      );
      const values = [...candidates, null];
      candidateCache.set(key, values);
      return values;
    };
    const originalRequirements = requirements;
    const signatures = solution.config.map((config, index) => JSON.stringify([
      config.archetype, config.tertiary, config.baseStats, solution.tuningAssignments[index], solution.modAssignments?.[index],
      solution.exoticIndex === index, config.sourceId || null,
    ]));
    let assignment = null;
    const usedSlots = new Set();
    const mapped = [];
    const searchSlots = index => {
      if (assignment?.feasible && assignment.ownedCount === 5) return;
      if (index === 5) {
        const candidate = chooseBestAssignment(solution, mapped, mapped.map(candidatesFor), normalizedSetRequirement);
        if (!candidate) return;
        if (!assignment || Number(candidate.feasible) > Number(assignment.feasible)
            || candidate.feasible === assignment.feasible && (candidate.ownedCount > assignment.ownedCount
              || candidate.ownedCount === assignment.ownedCount && candidate.setCoverage > assignment.setCoverage)) {
          assignment = candidate;
          requirements = [...mapped];
        }
        return;
      }
      const original = originalRequirements[index];
      const fixed = solution.exoticIndex === index || solution.config[index].sourceId;
      for (const slot of fixed ? [original.slot] : [original.slot, ...INVENTORY_PLAN_SLOTS.filter(slot => slot !== original.slot)]) {
        if (usedSlots.has(slot) || solution.exoticIndex != null && solution.exoticIndex !== index && slot === "classItem") continue;
        const previousEqual = signatures.slice(0, index).lastIndexOf(signatures[index]);
        if (previousEqual >= 0 && INVENTORY_PLAN_SLOTS.indexOf(slot) <= INVENTORY_PLAN_SLOTS.indexOf(mapped[previousEqual].slot)) continue;
        mapped[index] = {...original, slot, exotic: solution.exoticIndex === index || slot === fixedExotic?.slot};
        usedSlots.add(slot);
        searchSlots(index + 1);
        usedSlots.delete(slot);
      }
    };
    searchSlots(0);
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
    const rulesFeasible = sourceSatisfiesRules(solution);
    const plan = {
      solution,
      slotByConfig: requirements.map(requirement => requirement.slot),
      matchingProof: {scope: "provided-theoretical-witness", complete: true, slotPermutations: true},
      requirements,
      pieces,
      ownedCount: assignment.ownedCount,
      farmCount: assignment.farmCount,
      setCoverage: assignment.setCoverage,
      rulesFeasible,
      feasible: rulesFeasible && assignment.setFeasible && assignmentCanReachExact(solution, assignment.chosen),
      fixedExoticDistance: !fixedExotic || fixedExoticPiece?.item
        ? 0
        : fixedExoticPiece?.closestMismatch?.score ?? Number.MAX_SAFE_INTEGER,
      farmability: farmabilityScore(solution.config, solution.exoticIndex),
      score: solution.score,
    };
    if (solution.problemSpec && requirements.some((requirement, index) => requirement.slot !== solution.config[index].slot)) {
      const candidate = {...solution, config: solution.config.map((config, index) => ({...config, slot: requirements[index].slot}))};
      delete candidate.canonicalId;
      delete candidate.certificate;
      const sealed = sealWitness(solution.problemSpec, candidate);
      if (sealed.valid) {
        plan.matchedSolution = sealed.witness;
        plan.matchedSolution.certificate = createResultCertificate({problemSpec: solution.problemSpec,
          witness: sealed.witness, status: solution.status || solution.certificate?.status || "SEARCH_LIMIT_REACHED"});
      }
    }
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
