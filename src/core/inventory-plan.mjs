import { STATS, normalizeArchetypeId, BASE_CONFIGS, getMasterworkStats } from "./armor-model.mjs";
import { compareScoreRanks, farmabilityScore, scoreStatsRank, scoreStats } from "./solver.mjs";
import { findExactPartialConfigWitnesses } from "./exact-target-oracle.mjs";
import {compareAssignmentCosts, getAssignmentCost} from './assignment-cost.mjs';
import { physicalBaseStats, sealWitness, createResultCertificate, normalizePieceNumbers, createCanonicalId,
  satisfiesConstraintModel, STAT_DOMAIN, createPieceCapability, getArmorSolverInput, stableSerialize,
  matchesFixedExotic } from "./solver-v3-contract.mjs";
import {
  comparePlanMacroProfiles,
  createPlanMacroId,
  createPlanMacroProfile,
  getPlanPieceRoles,
  isLegalFrameworkTertiaryPair,
  resolvePlanSlots,
} from "./plan-equivalence.mjs";

export const INVENTORY_PLAN_SLOTS = Object.freeze([
  "helmet",
  "arms",
  "chest",
  "legs",
  "classItem",
]);

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
  const slots = resolvePlanSlots(solution);
  const requirements = [];
  for (let index = 0; index < solution.config.length; index++) {
    const config = solution.config[index];
    const tuning = solution.tuningAssignments[index];
    const slot = slots[index];
    requirements.push({
      index,
      slot,
      archetype: config.archetype,
      archetypeId: archetypeIdForName(config.archetype),
      tertiary: config.tertiary,
      baseStats: { ...config.baseStats },
      tuningMode: tuning?.mode === 'none' ? 'none' : tuning?.mode === "+3" ? "plus3" : "shift",
      tuningTo: tuning?.mode === "+3" ? null : tuning?.to,
      exotic: solution.exoticIndex === index || slot === fixedExotic?.slot,
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

function chooseBestAssignment(solution, requirements, candidatesBySlot, setRequirement, checkpoint = () => {}) {
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
    checkpoint();
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
    } else if (tuning.mode !== 'none') {
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
  const targetOrder = compareScoreRanks((left.matchedSolution || left.solution)?.rank,
    (right.matchedSolution || right.solution)?.rank);
  if (targetOrder !== 0) return targetOrder;
  if (left.farmCount !== right.farmCount) return left.farmCount - right.farmCount;
  if (left.fixedExoticDistance !== right.fixedExoticDistance) {
    return left.fixedExoticDistance - right.fixedExoticDistance;
  }
  if (left.farmability !== right.farmability) return left.farmability - right.farmability;
  const cost = compareAssignmentCosts(left.assignmentCost || (left.matchedSolution || left.solution)?.assignmentCost,
    right.assignmentCost || (right.matchedSolution || right.solution)?.assignmentCost);
  if (cost) return cost;
  return right.ownedCount - left.ownedCount
    || createCanonicalId(left.solution).localeCompare(createCanonicalId(right.solution));
}

// Bind a fresh planning problem to the same target/rules and budget. Physical
// pieces keep their slots and immutable capabilities; only catalog farm pieces
// are free variables. This is mathematical feasibility, not execution preflight.
function planningContext(solution, pool, classId, fixedExotic, setRequirement) {
  if (!solution.problemSpec?.valid) return null;
  const exoticIndex = solution.exoticIndex ?? (fixedExotic
    ? getSolutionRequirements(solution).findIndex(r => r.slot === fixedExotic.slot) : -1);
  const exoticSlot = solution.exoticIndex != null ? 'classItem' : fixedExotic?.slot;
  const config = solution.config[exoticIndex];
  const selection = solution.problemSpec.solverContext?.exoticSelection;
  const fixed = fixedExotic || (config ? {slot: exoticSlot, classId: selection?.classId || classId,
    hash: selection?.itemHash, config, primaryPerkId: selection?.primaryPerkId,
    secondaryPerkId: selection?.secondaryPerkId} : null);
  const farmExotic = config ? {...config, sourceId: null, id: null, slot: exoticSlot,
    hash: fixed?.hash ?? config.hash ?? null, exotic: true, setHash: null} : null;
  const capabilities = pool.map(createPieceCapability);
  const problem = {...solution.problemSpec, pieceCapabilities: capabilities,
    inventoryContext: {...solution.problemSpec.inventoryContext, planInventory: true,
      reassignModifiers: true, modifierBudget: {...solution.problemSpec.budget},
      classId, fixedExotic: fixed, farmExotic, setRequirement}};
  const physical = item => {
    const c = createPieceCapability(item);
    return {...item, sourceId: c.identity, archetype: c.archetype,
      baseStats: {...c.projectedBaseStats}, physicalBaseStats: {...c.baseStats},
      requiresMasterwork: STATS.some(s => c.projectedBaseStats[s] !== c.baseStats[s]),
      masterworkStats: c.masterworkStats};
  };
  const eligible = item => {
    const c = createPieceCapability(item);
    return c.identity && c.mathDataKnown && c.masterworkStats?.length === 3
      && (!classId || item.classId === classId)
      && (item.slot === exoticSlot ? matchesFixedExotic(item, fixed) : !item.exotic);
  };
  return {problem, physical, eligible, farmExotic, pool};
}

function certifyPlan(plan, context, candidate, chosen, slots, setRequirement) {
  const missing = slots.map((slot, index) => ({index, requirement: {slot,
    exotic: slot === context.farmExotic?.slot}})).filter(p => !chosen[p.index]);
  if (!canCompleteSetRequirement(chosen.filter(Boolean), missing, setRequirement)) return null;
  const hashes = getSetTargetLabels(missing, chosen.filter(Boolean), setRequirement);
  const config = candidate.config.map((c, index) => chosen[index] ? context.physical(chosen[index])
    : {...c, slot: slots[index], exotic: slots[index] === context.farmExotic?.slot,
      ...(slots[index] === context.farmExotic?.slot ? {hash: context.farmExotic.hash} : {}),
      setHash: hashes[missing.findIndex(p => p.index === index)] || null});
  const {target, constraints} = getArmorSolverInput(context.problem);
  const fresh = {config, tuningAssignments: candidate.tuningAssignments, modAssignments: candidate.modAssignments,
    exoticIndex: plan.solution.exoticIndex != null ? slots.indexOf('classItem') : null,
    exoticSelection: plan.solution.exoticSelection,
    rank: scoreStatsRank(candidate.totals, target, constraints), score: scoreStats(candidate.totals, target, constraints)};
  const sealed = sealWitness(context.problem, fresh);
  if (!sealed.valid || !satisfiesConstraintModel(sealed.witness, context.problem.constraintModel)) return null;
  const witness = sealed.witness;
  witness.assignmentCost = getAssignmentCost(chosen.map(item => item || {tuningInstalled: false, armorModSize: 0}), witness);
  witness.certificate = createResultCertificate({problemSpec: witness.problemSpec, witness,
    status: 'EXACT_TARGET_PROVEN'});
  if (witness.certificate.status !== 'EXACT_TARGET_PROVEN') {
    witness.certificate = createResultCertificate({problemSpec: witness.problemSpec, witness,
      status: 'RULE_FEASIBLE_PROVEN'});
  }
  witness.status = witness.certificate.status;
  const requirements = getSolutionRequirements(witness);
  const pieces = requirements.map((r, index) => {
    const requirement = {...r, slot: slots[index], exotic: config[index].exotic};
    const closest = chosen[index] ? null : findClosestFixedExotic(context.pool, requirement,
      context.problem.inventoryContext.fixedExotic, setRequirement);
    return {...requirement, item: chosen[index] || null,
      farmSetHash: chosen[index] ? null : config[index].setHash,
      closestItem: closest?.item || null, closestMismatch: closest?.mismatch || null};
  });
  return {...plan, matchedSolution: witness, assignmentCost: witness.assignmentCost, requirements: pieces.map(({item: _item, ...r}) => r),
    pieces, slotByConfig: slots, ownedCount: chosen.filter(Boolean).length,
    farmCount: missing.length, setCoverage: getSetCoverage(chosen.filter(Boolean), setRequirement),
    feasible: true, rulesFeasible: true, score: witness.score,
    farmability: farmabilityScore(witness.config, witness.exoticIndex)};
}

// ============================================================
// PHASE 2: MACRO-EQUIVALENT MATCHING
// ============================================================
// The exact-template phase replays the source witness config by config, so a
// vault that realizes the same *macro* plan with frames, tertiary stats,
// Tuning or Armor Mods redistributed across pieces is reported as farming.
// This phase searches the macro-equivalence class directly (see
// plan-equivalence.mjs): it consumes the movable framework/tertiary multisets
// piece by piece, re-pairs the remainder legally for farming, reassigns
// directional Tuning by immutable capability, reproduces the +3 aggregate
// contribution and redistributes Armor Mods deterministically. With at most
// five pieces the search is exhaustive, deterministic and independent of the
// residual budget that bounds phases one and three.

const MACRO_SEARCH_NODE_CAP_PER_SOLUTION = 60000;
const MACRO_SEARCH_BATCH_NODE_CEILING = 600000;
const MACRO_SEARCH_TIME_MS = 900;
const macroSearchLimit = Symbol("macro-equivalence search limit");

function createMacroSearchBudget(solutionCount) {
  const deadline = performance.now() + MACRO_SEARCH_TIME_MS;
  const batchNodes = Math.min(
    MACRO_SEARCH_NODE_CAP_PER_SOLUTION * Math.max(1, solutionCount),
    MACRO_SEARCH_BATCH_NODE_CEILING,
  );
  let nodes = 0;
  return {
    reset() { nodes = 0; },
    tick() {
      if (++nodes > batchNodes || performance.now() > deadline) throw macroSearchLimit;
    },
  };
}

function getMathBaseStats(item) {
  return item.optimizationBaseStats || physicalBaseStats(item);
}

function getConfigArchetypeIdForMacro(config) {
  return normalizeArchetypeId(config?.archetype || config?.archetypeId);
}

function getCanonicalFrameConfig(archetypeId, tertiary) {
  return BASE_CONFIGS.find(entry =>
    entry.archetype === archetypeId && entry.tertiary === tertiary) || null;
}

// Candidate identity for macro feasibility. Everything that can change the
// outcome of the macro search is in the key: physical slot, class, the legal
// (framework, tertiary) roll, set relevance and the immutable directional
// capability. Installed sockets/energy and instance ids are execution state —
// two rolls with the same key are interchangeable here.
function getMacroCandidateKey(item, setRequirement) {
  const setHash = Number(item.setHash);
  const setKey = setRequirement.type === "none" ? 0 : setRequirement.type === "set"
    ? Number(setHash === Number(setRequirement.setHash))
    : setHash === Number(setRequirement.a) ? 1 : setHash === Number(setRequirement.b) ? 2 : 0;
  const capability = getItemDirectionalStats(item);
  return [
    item.slot,
    item.classId || "",
    normalizeArchetypeId(item.archetypeId || item.archetype) || "",
    item.tertiary || "",
    setKey,
    capability ? capability.join(",") : "none",
  ].join("|");
}

// Kuhn's maximum matching between bag instances and slots. Used as a cheap
// necessary condition: if the frames (or tertiaries) cannot cover k distinct
// slots, no k-owned macro selection exists and the DFS can be skipped.
function maxBagSlotCover(bag, candidatesBySlot, keyOf) {
  const instances = [];
  for (const [key, count] of bag) {
    for (let n = 0; n < count; n++) instances.push(key);
  }
  const slots = [...candidatesBySlot.keys()];
  const matchSlot = new Map();
  const augment = (key, visited) => {
    for (const slot of slots) {
      if (visited.has(slot)) continue;
      const candidates = candidatesBySlot.get(slot);
      if (!candidates.some(candidate => keyOf(candidate) === key)) continue;
      visited.add(slot);
      const previous = matchSlot.get(slot);
      if (previous === undefined || augment(previous, visited)) {
        matchSlot.set(slot, key);
        return true;
      }
    }
    return false;
  };
  let size = 0;
  for (const key of instances) {
    if (augment(key, new Set())) size++;
  }
  return size;
}

function buildMacroModAssignments(modMultiset) {
  const mods = Object.fromEntries([0, 1, 2, 3, 4].map(index => [index, null]));
  const entries = [];
  for (const [key, count] of modMultiset) {
    const [size, stat] = key.split(":");
    for (let n = 0; n < count; n++) entries.push({ size: Number(size), stat });
  }
  // Deterministic placement: largest mods first, stats in canonical order.
  entries.sort((left, right) => right.size - left.size
    || STATS.indexOf(left.stat) - STATS.indexOf(right.stat));
  entries.forEach((mod, index) => { mods[index] = { ...mod }; });
  return mods;
}

function matchMacroEquivalentPlan({
  plan, solution, context, pool, classId, fixedExotic, setRequirement, budget,
}) {
  // Returns {plan, complete}: `plan` is a certified macro-equivalent plan or
  // null; `complete` reports whether this phase's own search finished.
  budget.reset();
  try {
    return { plan: searchMacroEquivalentPlan({
      plan, solution, context, pool, classId, fixedExotic, setRequirement, budget,
    }), complete: true };
  } catch (error) {
    if (error !== macroSearchLimit) throw error;
    return { plan: null, complete: false };
  }
}

const MACRO_FARM = Symbol("macro farm");

function searchMacroEquivalentPlan({
  plan, solution, context, pool, classId, fixedExotic, setRequirement, budget,
}) {
  if (!Array.isArray(solution.config) || solution.config.length !== 5
      || !Array.isArray(solution.tuningAssignments) || solution.tuningAssignments.length !== 5) {
    return null;
  }
  // A macro candidate reproduces the source totals exactly, so a source that
  // already violates the bound rules can never certify here.
  if (plan.rulesFeasible === false) return null;

  const profile = createPlanMacroProfile(solution, { fixedExotic: fixedExotic || undefined });
  const roles = getPlanPieceRoles(solution, fixedExotic);
  const contextFixed = context.problem.inventoryContext.fixedExotic;

  // --- Pinned resolution -------------------------------------------------
  let exoticSlot = null;
  let exoticConfig = null;
  const pinnedItems = new Map(); // slot -> owned item (source-bound legendaries)
  let chosenClassId = classId || null;
  for (const role of roles) {
    const config = solution.config[role.index];
    if (role.exotic) {
      if (exoticSlot !== null) return null; // at most one Exotic per witness
      exoticSlot = role.slot;
      exoticConfig = config;
    } else if (role.pinned) {
      const identity = String(config.sourceId || "");
      const item = pool.find(candidate =>
        String(candidate.sourceId ?? candidate.id ?? "") === identity) || null;
      if (!item) return null; // a source-bound piece must stay that piece
      if (pinnedItems.has(item.slot)) return null;
      pinnedItems.set(item.slot, item);
      if (!chosenClassId && item.classId) chosenClassId = item.classId;
    }
  }

  let exoticCandidates = [];
  if (exoticSlot && !fixedExotic?.reserved) {
    exoticCandidates = pool.filter(item => item.slot === exoticSlot && Boolean(item.exotic)
      && item.dataConfidence?.stats !== "unknown"
      && (!classId || item.classId === classId)
      && (fixedExotic
        ? matchesFixedExoticIdentity(item, fixedExotic)
        : matchesFixedExotic(item, contextFixed))
      // Macro pin: the Exotic roll is part of the plan's identity. Only the
      // exact source frame may own the slot; other rolls keep farming it.
      && STATS.every(stat => getMathBaseStats(item)[stat] === exoticConfig?.baseStats?.[stat]));
    exoticCandidates.sort((left, right) => sortCandidates(left, right, setRequirement));
    if (exoticCandidates.length && !chosenClassId && exoticCandidates[0].classId) {
      chosenClassId = exoticCandidates[0].classId;
    }
  }

  const pinnedSlots = new Set(pinnedItems.keys());
  if (exoticSlot) pinnedSlots.add(exoticSlot);
  const freeSlots = INVENTORY_PLAN_SLOTS.filter(slot => !pinnedSlots.has(slot));
  const movableCount = profile.frameworkMultiset.reduce((sum, [, count]) => sum + count, 0);
  if (movableCount !== freeSlots.length) return null; // malformed witness

  const frameBag = new Map(profile.frameworkMultiset);
  const tertiaryBag = new Map(profile.tertiaryMultiset);

  // Candidates whose (framework, tertiary) pair already exists in the source
  // witness are tried first: the near-template realization is the common case,
  // and reaching it early keeps the exhaustive search a fallback.
  const sourcePairs = new Set();
  for (const role of roles) {
    if (role.pinned) continue;
    const config = solution.config[role.index];
    sourcePairs.add(`${getConfigArchetypeIdForMacro(config)}|${config.tertiary}`);
  }
  const sourcePairAffinity = candidate =>
    sourcePairs.has(`${candidate.archetypeId}|${candidate.tertiary}`) ? 0 : 1;

  // --- Free-slot candidate index -----------------------------------------
  const candidatesBySlot = new Map();
  for (const slot of freeSlots) {
    const seen = new Set();
    const candidates = [];
    const raw = pool.filter(item => item.slot === slot && !item.exotic
      && item.dataConfidence?.stats !== "unknown"
      && (!classId || item.classId === classId)
      && frameBag.has(normalizeArchetypeId(item.archetypeId || item.archetype))
      && tertiaryBag.has(item.tertiary)
      && isLegalFrameworkTertiaryPair(item.archetypeId || item.archetype, item.tertiary)
      // The macro bag identity assumes canonical T5 frame bases; pieces with
      // baked-in Tuning or exotic rolls stay with the residual re-solve.
      && (() => {
        const canonical = getCanonicalFrameConfig(
          normalizeArchetypeId(item.archetypeId || item.archetype), item.tertiary);
        return canonical && STATS.every(stat =>
          getMathBaseStats(item)[stat] === canonical.baseStats[stat]);
      })());
    raw.sort((left, right) => sourcePairAffinity({
        archetypeId: normalizeArchetypeId(left.archetypeId || left.archetype), tertiary: left.tertiary,
      }) - sourcePairAffinity({
        archetypeId: normalizeArchetypeId(right.archetypeId || right.archetype), tertiary: right.tertiary,
      }) || sortCandidates(left, right, setRequirement));
    for (const item of raw) {
      const key = getMacroCandidateKey(item, setRequirement);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        item,
        archetypeId: normalizeArchetypeId(item.archetypeId || item.archetype),
        tertiary: item.tertiary,
        capability: getItemDirectionalStats(item) || [],
      });
    }
    candidatesBySlot.set(slot, candidates);
  }

  const orderedFreeSlots = [...freeSlots].sort((left, right) =>
    candidatesBySlot.get(left).length - candidatesBySlot.get(right).length
    || INVENTORY_PLAN_SLOTS.indexOf(left) - INVENTORY_PLAN_SLOTS.indexOf(right));

  // Cheap necessary conditions for reaching k owned free slots.
  const frameCover = maxBagSlotCover(frameBag, candidatesBySlot, candidate => candidate.archetypeId);
  const tertiaryCover = maxBagSlotCover(tertiaryBag, candidatesBySlot, candidate => candidate.tertiary);
  const maxK = Math.min(freeSlots.length, frameCover, tertiaryCover);

  const directionalAssignments = [];
  const directionalNeed = new Map();
  for (const [key, count] of profile.directionalTuningMultiset) {
    const [from, to] = key.split(">");
    directionalNeed.set(to, (directionalNeed.get(to) || 0) + count);
    for (let n = 0; n < count; n++) directionalAssignments.push({ from, to });
  }
  const modAssignments = buildMacroModAssignments(profile.armorModMultiset);

  // --- Global +3 feasibility precheck --------------------------------------
  // The +3 hosts are pieces of the final pairing (pinned pieces plus one legal
  // pairing of the bag), so if no pairing admits a subset with the source's
  // aggregate contribution, no macro candidate exists at any ownership level.
  // This cheaply rejects the random-vault case where exhaustive search would
  // otherwise burn its whole budget discovering the same negative.
  if (profile.plus3Count > 0) {
    const pinnedMasterworks = [...pinnedItems.values()]
      .map(item => getMasterworkStats(item) || []);
    // The Exotic piece (owned or farmed) always carries the pinned frame's
    // masterwork set.
    if (exoticSlot) pinnedMasterworks.push(getMasterworkStats(exoticConfig) || []);
    const pairingVectors = pair => pair.map(({ archetypeId, tertiary }) =>
      Object.fromEntries(STATS.map(stat => [stat,
        Number(getMasterworkStats({ archetypeId, tertiary })?.includes(stat) || 0)])));
    const subsetSumsReach = (vectors, target, count) => {
      // Enumerate count-sized subsets of vectors; true if any sums to target.
      const pick = (start, chosen, sum) => {
        if (chosen === count) {
          return STATS.every(stat => sum[stat] === target[stat]);
        }
        for (let index = start; index < vectors.length; index++) {
          const next = Object.fromEntries(STATS.map(stat => [stat, sum[stat] + vectors[index][stat]]));
          if (pick(index + 1, chosen + 1, next)) return true;
        }
        return false;
      };
      return pick(0, 0, Object.fromEntries(STATS.map(stat => [stat, 0])));
    };
    let plus3Reachable = false;
    for (const pairing of enumerateFarmPairings(frameBag, tertiaryBag)) {
      const vectors = [...pinnedMasterworks, ...pairingVectors(pairing)];
      if (subsetSumsReach(vectors, profile.plus3Contribution, profile.plus3Count)) {
        plus3Reachable = true;
        break;
      }
    }
    if (!plus3Reachable) return null;
  }

  // --- Leaf evaluation ----------------------------------------------------
  // Every legal pairing of the remaining bag becomes the farmed pieces; the
  // pairing choice feeds the +3 masterwork contributions.
  function enumerateFarmPairings(frames, tertiaries) {
    const instances = [];
    for (const [key, count] of frames) {
      for (let n = 0; n < count; n++) instances.push(key);
    }
    const pairings = [];
    const pairs = [];
    const recurse = (index, remaining) => {
      budget.tick();
      if (index === instances.length) {
        pairings.push([...pairs]);
        return;
      }
      const frame = instances[index];
      for (const [tertiary, count] of remaining) {
        if (!count || !isLegalFrameworkTertiaryPair(frame, tertiary)) continue;
        remaining.set(tertiary, count - 1);
        pairs.push({ archetypeId: frame, tertiary });
        recurse(index + 1, remaining);
        pairs.pop();
        remaining.set(tertiary, count);
      }
    };
    recurse(0, new Map(tertiaries));
    return pairings;
  }

  // Combined placement of directional shifts and +3 marks. Pieces each hold
  // one tuning mode; the aggregate +3 contribution must match the source.
  function solveTuningPlacement(itemStates, pieces) {
    const used = directionalAssignments.map(() => false);
    let plus3Remaining = profile.plus3Count;
    const vector = Object.fromEntries(STATS.map(stat => [stat, 0]));
    const assignments = pieces.map(() => ({ mode: "none", from: null, to: null }));
    let best = null;
    const record = () => {
      const cost = getAssignmentCost(itemStates, {
        tuningAssignments: assignments, modAssignments,
      });
      if (!best || compareAssignmentCosts(cost, best.cost) < 0) {
        best = { assignments: assignments.map(assignment => ({ ...assignment })), cost };
      }
    };
    const recurse = index => {
      budget.tick();
      const remainingPieces = pieces.length - index;
      const remainingDirectional = used.reduce((sum, flag) => sum + Number(!flag), 0);
      if (remainingPieces < remainingDirectional + plus3Remaining) return;
      if (best?.cost.changedSocketCount === 0) return;
      if (index === pieces.length) {
        if (remainingDirectional || plus3Remaining) return;
        if (!STATS.every(stat => vector[stat] === profile.plus3Contribution[stat])) return;
        record();
        return;
      }
      const piece = pieces[index];
      assignments[index] = { mode: "none", from: null, to: null };
      recurse(index + 1);
      if (plus3Remaining > 0) {
        assignments[index] = { mode: "+3", from: null, to: null };
        plus3Remaining--;
        for (const stat of piece.masterwork) vector[stat]++;
        recurse(index + 1);
        for (const stat of piece.masterwork) vector[stat]--;
        plus3Remaining++;
      }
      for (let d = 0; d < directionalAssignments.length; d++) {
        if (used[d]) continue;
        const assignment = directionalAssignments[d];
        if (piece.allowedTo && !piece.allowedTo.includes(assignment.to)) continue;
        used[d] = true;
        assignments[index] = { mode: "+5-5", from: assignment.from, to: assignment.to };
        recurse(index + 1);
        used[d] = false;
      }
      assignments[index] = { mode: "none", from: null, to: null };
    };
    recurse(0);
    return best;
  }

  function evaluateSelection(selection, frames, tertiaries) {
    const ownedItems = [];
    const farmSlots = [];
    for (const slot of INVENTORY_PLAN_SLOTS) {
      const pick = selection.get(slot);
      if (pick === MACRO_FARM) farmSlots.push(slot);
      else ownedItems.push(pick.item);
    }
    if (!canCompleteSetRequirement(ownedItems,
      farmSlots.map(slot => ({ requirement: { slot, exotic: slot === exoticSlot } })), setRequirement)) {
      return null;
    }
    const pairings = enumerateFarmPairings(frames, tertiaries);
    if (farmSlots.length && !pairings.length) return null;
    for (const pairing of pairings) {
      // Farm slots receive the remaining bag's legal pairing in slot order,
      // both for the masterwork contributions and the farmed configs.
      const pieces = [];
      const itemStates = [];
      let pieceCursor = 0;
      for (const slot of INVENTORY_PLAN_SLOTS) {
        const pick = selection.get(slot);
        if (pick === MACRO_FARM) {
          const source = slot === exoticSlot ? context.farmExotic : pairing[pieceCursor++];
          pieces.push({ allowedTo: null, masterwork: getMasterworkStats(source) || [] });
          itemStates.push({ tuningInstalled: false, armorModSize: 0 });
        } else {
          pieces.push({
            allowedTo: getItemDirectionalStats(pick.item) || [],
            masterwork: getMasterworkStats(pick.item) || [],
          });
          itemStates.push(pick.item);
        }
      }
      const tuning = solveTuningPlacement(itemStates, pieces);
      if (!tuning) continue;
      let configCursor = 0;
      const config = INVENTORY_PLAN_SLOTS.map(slot => {
        const pick = selection.get(slot);
        if (pick !== MACRO_FARM) return context.physical(pick.item);
        if (slot === exoticSlot) return { ...context.farmExotic };
        const pair = pairing[configCursor++];
        return { ...getCanonicalFrameConfig(pair.archetypeId, pair.tertiary), slot };
      });
      const candidate = {
        config,
        tuningAssignments: tuning.assignments,
        modAssignments,
        totals: solution.totals,
      };
      const certified = certifyPlan(plan, context, candidate,
        INVENTORY_PLAN_SLOTS.map(slot => {
          const pick = selection.get(slot);
          return pick === MACRO_FARM ? null : pick.item;
        }), INVENTORY_PLAN_SLOTS, setRequirement);
      if (!certified) continue;
      const comparison = comparePlanMacroProfiles(solution, certified.matchedSolution,
        { fixedExotic: fixedExotic || undefined });
      if (!comparison.equal) continue; // defensive: never certify a non-equivalent plan
      certified.matchingProof = {
        scope: "source-macro-equivalence",
        complete: true,
        slotIndependent: true,
        equivalence: comparison.equivalence,
        sourceMacroId: createPlanMacroId(solution, { fixedExotic: fixedExotic || undefined }),
        candidateMacroId: stableSerialize(comparison.candidateProfile),
      };
      const exoticPiece = fixedExotic
        ? certified.pieces.find(piece => piece.slot === fixedExotic.slot) : null;
      certified.fixedExoticDistance = !fixedExotic || exoticPiece?.item
        ? 0
        : exoticPiece?.closestMismatch?.score ?? Number.MAX_SAFE_INTEGER;
      return certified;
    }
    return null;
  }

  // --- Exact-k DFS over the free slots -----------------------------------
  const selection = new Map();
  const floorTotal = plan.feasible ? plan.ownedCount + 1 : 0;
  const pinnedOwnedCount = pinnedItems.size;

  function searchAttempt(exoticOwned, k) {
    selection.clear();
    if (exoticSlot) {
      selection.set(exoticSlot, exoticOwned && exoticCandidates.length
        ? { item: exoticCandidates[0] } : MACRO_FARM);
    }
    for (const [slot, item] of pinnedItems) selection.set(slot, { item });
    // Directional Hall bound: every remaining destination must still fit on
    // decided pieces, decided farm pieces (wildcards) and the undecided slots
    // (any of which may farm). This prunes capability-blocked branches long
    // before the leaf checks.
    const decidedCapability = new Map();
    let wildcardPieces = 0;
    const countCapability = item => {
      for (const stat of getItemDirectionalStats(item) || []) {
        decidedCapability.set(stat, (decidedCapability.get(stat) || 0) + 1);
      }
    };
    if (exoticSlot) {
      // A farmed Exotic accepts every destination; an owned one uses its
      // immutable capability list.
      if (selection.get(exoticSlot) === MACRO_FARM) wildcardPieces++;
      else countCapability(exoticCandidates[0]);
    }
    for (const item of pinnedItems.values()) countCapability(item);
    const capabilityReachable = undecided => STATS.every(stat =>
      (directionalNeed.get(stat) || 0)
        <= (decidedCapability.get(stat) || 0) + wildcardPieces + undecided);
    let found = null;
    const walk = (position, ownedSoFar, frames, tertiaries) => {
      budget.tick();
      if (found) return;
      const slotsLeft = orderedFreeSlots.length - position;
      if (ownedSoFar + slotsLeft < k) return;
      if (!capabilityReachable(slotsLeft)) return;
      if (position === orderedFreeSlots.length) {
        if (ownedSoFar === k) found = evaluateSelection(selection, frames, tertiaries);
        return;
      }
      const candidates = candidatesBySlot.get(orderedFreeSlots[position]);
      if (ownedSoFar < k) {
        for (const candidate of candidates) {
          if (chosenClassId && candidate.item.classId
              && candidate.item.classId !== chosenClassId) continue;
          const frameCount = frames.get(candidate.archetypeId) || 0;
          const tertiaryCount = tertiaries.get(candidate.tertiary) || 0;
          if (!frameCount || !tertiaryCount) continue;
          frames.set(candidate.archetypeId, frameCount - 1);
          tertiaries.set(candidate.tertiary, tertiaryCount - 1);
          const previousClass = chosenClassId;
          if (!chosenClassId && candidate.item.classId) chosenClassId = candidate.item.classId;
          for (const stat of candidate.capability) {
            decidedCapability.set(stat, (decidedCapability.get(stat) || 0) + 1);
          }
          selection.set(orderedFreeSlots[position], candidate);
          walk(position + 1, ownedSoFar + 1, frames, tertiaries);
          chosenClassId = previousClass;
          selection.set(orderedFreeSlots[position], null);
          for (const stat of candidate.capability) {
            decidedCapability.set(stat, decidedCapability.get(stat) - 1);
          }
          frames.set(candidate.archetypeId, frameCount);
          tertiaries.set(candidate.tertiary, tertiaryCount);
          if (found) return;
        }
      }
      selection.set(orderedFreeSlots[position], MACRO_FARM);
      wildcardPieces++;
      walk(position + 1, ownedSoFar, frames, tertiaries);
      wildcardPieces--;
      selection.set(orderedFreeSlots[position], null);
    };
    walk(0, 0, new Map(frameBag), new Map(tertiaryBag));
    return found;
  }

  const exoticOptions = exoticCandidates.length ? [true, false] : [false];
  const attempts = [];
  for (const exoticOwned of exoticOptions) {
    for (let k = maxK; k >= 0; k--) {
      attempts.push({ exoticOwned, k, total: pinnedOwnedCount + Number(exoticOwned) + k });
    }
  }
  attempts.sort((left, right) => right.total - left.total
    || Number(right.exoticOwned) - Number(left.exoticOwned));
  for (const attempt of attempts) {
    if (attempt.total < floorTotal) break;
    const found = searchAttempt(attempt.exoticOwned, attempt.k);
    if (found) return found;
  }
  return null;
}

// ============================================================
// PHASE 3: RESIDUAL CONSTRAINT RE-SOLVE (original-constraint-model)
// ============================================================
// The residual phase re-solves the *original* ProblemSpec/constraintModel
// against the owned inventory. It may produce a plan whose macro composition
// (frameworks, tertiaries, Tuning) differs from the source witness; that is a
// different plan in the same problem, never a macro-equivalent realization of
// the source. Its results are bounded and always reported as incomplete.
function reoptimizeConstraintPlan(plan, context, pool, setRequirement, checkpoint) {
  const rows = INVENTORY_PLAN_SLOTS.map(slot => {
    const seen = new Set();
    const candidates = pool.filter(item => item.slot === slot && context.eligible(item))
      .sort((a, b) => sortCandidates(a, b, setRequirement)).filter(item => {
        const c = createPieceCapability(item);
        const key = `${c.mathEquivalenceKey}|${c.classId}|${item.setHash || 0}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return {slot, candidates};
  });
  const chosen = [];
  let found = null;
  const inspect = () => {
    checkpoint();
    const owned = chosen.filter(Boolean);
    const missing = rows.map(r => ({requirement: {slot: r.slot,
      exotic: r.slot === context.farmExotic?.slot}})).filter((_, i) => !chosen[i]);
    if (!canCompleteSetRequirement(owned, missing, setRequirement)) return;
    const fixedEntries = owned.map(item => ({config: context.physical(item), allowBalanced: true,
      allowedDirectionalStats: getItemDirectionalStats(item) || []}));
    if (context.farmExotic && !chosen[INVENTORY_PLAN_SLOTS.indexOf(context.farmExotic.slot)]) {
      fixedEntries.push({config: context.farmExotic, allowBalanced: true, allowedDirectionalStats: [...STATS]});
    }
    const freePieceCount = 5 - fixedEntries.length;
    const rules = context.problem.constraintModel.rules;
    const witnesses = findExactPartialConfigWitnesses({fixedEntries, freePieceCount,
      minimums: rules.map(r => r.armorMinimum), maximums: rules.map(r => r.armorMaximum),
      ...context.problem.budget, allowedFreePlus3Counts: Array.from({length: freePieceCount + 1}, (_, i) => i),
      maxWitnesses: 1, checkpoint});
    for (const candidate of witnesses) {
      const freeSlots = INVENTORY_PLAN_SLOTS.filter(slot => !fixedEntries.some(e => e.config.slot === slot));
      const slots = candidate.config.map((_, i) => i < fixedEntries.length
        ? fixedEntries[i].config.slot : freeSlots[i - fixedEntries.length]);
      const assigned = slots.map(slot => chosen[INVENTORY_PLAN_SLOTS.indexOf(slot)] || null);
      found = certifyPlan(plan, context, candidate, assigned, slots, setRequirement);
      if (found) return;
    }
  };
  const walk = (index, remaining) => {
    checkpoint();
    if (found || remaining < 0 || remaining > 5 - index) return;
    if (index === 5) { inspect(); return; }
    if (remaining) for (const item of rows[index].candidates) {
      if (chosen.some(p => p && (getItemKey(p) === getItemKey(item) || p.classId !== item.classId))) continue;
      chosen[index] = item;
      walk(index + 1, remaining - 1);
      chosen[index] = null;
      if (found) return;
    }
    chosen[index] = null;
    walk(index + 1, remaining);
  };
  const maximum = rows.filter(r => r.candidates.length).length;
  for (let count = maximum; count > (plan.feasible ? plan.ownedCount : 0); count--) {
    walk(0, count);
    if (found) return found;
  }
  return null;
}

export function rankInventoryPlans({
  solutions = [],
  items = [],
  classId = null,
  fixedExotic = null,
  setRequirement = { type: "none" },
  maxResults = 12,
  residualSearchLimits = {},
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
  const deadline = performance.now() + (residualSearchLimits.maxTimeMs ?? 1500);
  let nodes = 0;
  const exhausted = Symbol('inventory-plan search limit');
  const checkpoint = () => {
    if (++nodes > (residualSearchLimits.maxNodes ?? 200000) || performance.now() > deadline) throw exhausted;
  };
  // The macro-equivalence phase owns its budget: whether a macro-equivalent
  // realization exists must never depend on the residual search limits above.
  const macroBudget = createMacroSearchBudget(solutions.length);

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
    let matchingLimited = false;
    const usedSlots = new Set();
    const mapped = [];
    const searchSlots = index => {
      checkpoint();
      if (assignment?.feasible && assignment.ownedCount === 5) return;
      if (index === 5) {
        const candidate = chooseBestAssignment(solution, mapped, mapped.map(candidatesFor), normalizedSetRequirement, checkpoint);
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
      const fixed = original.exotic || solution.config[index].sourceId;
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
    try { searchSlots(0); }
    catch (error) { if (error !== exhausted) throw error; matchingLimited = true; }
    if (!assignment && matchingLimited) {
      // Retain the already-proved all-farm fallback without entering another
      // combinatorial search. A tiny budget must not erase every plan or its
      // incomplete-search explanation.
      requirements = originalRequirements;
      assignment = chooseBestAssignment(solution, requirements, requirements.map(() => [null]), normalizedSetRequirement);
    }
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
    let plan = {
      solution,
      slotByConfig: requirements.map(requirement => requirement.slot),
      matchingProof: {scope: "provided-theoretical-witness", complete: !matchingLimited, slotPermutations: true,
        ...(matchingLimited ? {matchingSearchLimited: true} : {})},
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
      assignmentCost: getAssignmentCost(assignment.chosen.map(item => item || {tuningInstalled: false, armorModSize: 0}), solution),
    };
    const context = planningContext(solution, pool, classId, fixedExotic, normalizedSetRequirement);
    if (context) {
      const certified = certifyPlan(plan, context, solution, assignment.chosen,
        requirements.map(r => r.slot), normalizedSetRequirement);
      if (certified) plan = certified;
      else plan.feasible = false;

      // Phase 2 — macro-equivalent matching. The macro search covers a strict
      // superset of the exact-template phase, so a completed run settles the
      // owned/farm question for this solution even when the template
      // permutation search above was truncated.
      if (!(plan.feasible && plan.ownedCount === 5)) {
        const macro = matchMacroEquivalentPlan({
          plan, solution, context, pool, classId, fixedExotic,
          setRequirement: normalizedSetRequirement, budget: macroBudget,
        });
        if (macro.plan
            && (macro.plan.ownedCount > plan.ownedCount
              || (macro.plan.ownedCount === plan.ownedCount && macro.plan.feasible && !plan.feasible)
              || (macro.plan.ownedCount === plan.ownedCount && macro.plan.feasible === plan.feasible
                && macro.plan.setCoverage > plan.setCoverage))) {
          plan = macro.plan;
        } else if (macro.complete) {
          plan.matchingProof = {...plan.matchingProof, complete: true, macroEquivalenceSearched: true};
        } else {
          plan.matchingProof = {...plan.matchingProof, complete: false, macroSearchLimited: true};
        }
      }

      // Phase 3 — residual re-solve of the original constraint model. A
      // bounded miss never demotes a proven macro/template result: it only
      // means alternative (different-macro) plans were not exhausted.
      try {
        const optimized = reoptimizeConstraintPlan(plan, context, pool, normalizedSetRequirement, checkpoint);
        if (optimized) plan = {...optimized, matchingProof: {scope: 'original-constraint-model',
          complete: false, macroEquivalent: false, slotPermutations: true, residualResolve: true}};
      } catch (error) {
        if (error !== exhausted) throw error;
        plan.matchingProof = {...plan.matchingProof,
          ...(plan.matchingProof.scope === 'source-macro-equivalence'
            || plan.matchingProof.macroEquivalenceSearched
            ? {residualSearchLimited: true}
            : {complete: false, residualSearchLimited: true})};
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
