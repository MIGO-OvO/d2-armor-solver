import {STATS} from "./armor-model.mjs";
import {STAT_DOMAIN, createPieceCapability, createProblemSpec, createProofEvidence,
  satisfiesConstraintModel, hasCompletePieceMath, verifyWitness, matchesFixedExotic} from "./solver-v3-contract.mjs";
import {applyManualUpgradeModifiers, compareUpgradeMetrics, createUpgradePieceFromItem,
  evaluateUpgradePieces, getUpgradeConfig, getUpgradeTuningCapability} from "./upgrade-optimizer.mjs";
import {getUpgradeMathKey, refineUpgradeAssignment} from './upgrade-optimizer.mjs';
import {createResidualBounds} from './residual-bounds.mjs';

const SLOTS = ["helmet", "arms", "chest", "legs", "classItem"];
const keyOf = pieces => pieces.map(piece => `${piece.slot}:id:${piece.sourceId || piece.id || ""}`).sort().join("|");
export const compareInventoryResults = (a, b) => Number(b.feasible) - Number(a.feasible)
  || compareUpgradeMetrics((a.evaluation || a).metrics, (b.evaluation || b).metrics)
  || keyOf(a.pieces).localeCompare(keyOf(b.pieces));
const compare = compareInventoryResults;

function project(piece) {
  return piece.optimizationBaseStats ? {...piece,
    physicalBaseStats: {...(piece.physicalBaseStats || piece.baseStats)},
    requiresMasterwork: STATS.some(stat => piece.optimizationBaseStats[stat] !== piece.baseStats[stat]),
    baseStats: {...piece.optimizationBaseStats},
  } : {...piece};
}
function coverage(piece, requirement) {
  const hash = Number(piece.setHash);
  return requirement.type === "set" ? [Number(hash === Number(requirement.setHash)), 0]
    : requirement.type === "split" ? [Number(hash === Number(requirement.a)), Number(hash === Number(requirement.b))] : [0, 0];
}
function legal(pieces, requirement) {
  if (pieces.length !== 5 || pieces.some(piece => !piece)
      || new Set(pieces.map(piece => piece.slot)).size !== 5
      || pieces.filter(piece => piece.exotic).length > 1) return false;
  if (new Set(pieces.map(piece => piece.classId).filter(Boolean)).size > 1) return false;
  const counts = pieces.map(piece => coverage(piece, requirement));
  return requirement.type === "set" ? counts.reduce((sum, value) => sum + value[0], 0) >= requirement.count
    : requirement.type === "split" ? Number(requirement.a) !== Number(requirement.b)
      && counts.reduce((sum, value) => sum + value[0], 0) >= 2
      && counts.reduce((sum, value) => sum + value[1], 0) >= 2 : true;
}
function bounds(piece, reassign, onlyPlus5) {
  const config = getUpgradeConfig(piece);
  const manual = applyManualUpgradeModifiers(config, piece);
  if (!reassign) return {min: STATS.map(stat => manual[stat]), max: STATS.map(stat => manual[stat])};
  const capability = getUpgradeTuningCapability(piece, onlyPlus5);
  const destinations = capability.allowedDirectionalStats || [];
  const tuningOnly = stat => manual[stat] - (piece.armorModStat === stat ? piece.armorModSize || 0 : 0);
  return {
    min: STATS.map(stat => Math.min(tuningOnly(stat), config.baseStats[stat]
      - Number(destinations.some(to => to !== stat)) * 5)),
    // Mod sizes may move between pieces; add the global budget only once.
    max: STATS.map(stat => Math.max(tuningOnly(stat), config.baseStats[stat]
      + Math.max(Number(destinations.includes(stat)) * 5,
        Number(capability.allowBalanced && config.masterworkStats.includes(stat))))),
  };
}

// Streaming target-directed search. No materialized Cartesian frontier.
// Resource exhaustion is explicit and never authorizes a negative proof.
export function solveInventoryLoadout({
  items = [], targets, fragments = {}, setRequirement, reassignModifiers = true,
  currentPieces = null, requiredStats = [], onlyPlus5Tuning = false,
  maxResults = 12, userConstraints = {}, searchLimits = {},
  fixedExotic = null, autoStatMods = reassignModifiers, modifierBudget = null,
  shardIndex = 0, shardCount = 1,
}, problemSpec = createProblemSpec({operation: "solveInventory", targets, fragments, constraints: userConstraints,
  targetDomain: STAT_DOMAIN.VISIBLE, pieces: items,
  inventoryContext: {setRequirement, reassignModifiers, onlyPlus5Tuning, requiredStats, currentPieces,
    fixedExotic, autoStatMods: reassignModifiers && autoStatMods, modifierBudget},
}), search = null) {
  if (!setRequirement) return null;
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || !Number.isSafeInteger(shardIndex)
      || shardIndex < 0 || shardIndex >= shardCount) throw new RangeError('invalid inventory shard');
  const eligible = piece => !fixedExotic || (piece.slot === fixedExotic.slot
    ? matchesFixedExotic(piece, fixedExotic) : !piece.exotic);
  const limit = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;
  maxResults = limit(maxResults, 12);
  const started = performance.now();
  search?.checkpoint(0);
  const searchStats = {frontierComplete: true, assignmentComplete: !reassignModifiers,
    shardIndex, shardCount,
    mathCacheHits: 0, mathEvaluations: 0, evaluationMs: 0, prunedJoint: 0, refinedAssignments: 0,
    statesExamined: 0, equivalentItems: 0, mergedStates: 0, peakStates: 0,
    prunedBounds: 0, prunedSets: 0, layers: [0, 0, 0, 0, 0], firstFeasibleMs: null, firstExactMs: null,
    maxStates: limit(searchLimits.maxStates, 50000), maxNodes: limit(searchLimits.maxNodes, 2000000),
    maxEvaluations: limit(searchLimits.maxEvaluations, 50000),
    maxTimeMs: limit(searchLimits.maxTimeMs, 3000), termination: "exhausted"};
  const required = [...new Set(requiredStats)].filter(stat => STATS.includes(stat));
  const locked = new Map((currentPieces || []).filter(piece => piece.locked).map(piece => {
    const source = items.find(item => String(item.id) === String(piece.sourceId || piece.id) && item.slot === piece.slot);
    const current = source ? {...createUpgradePieceFromItem(source, SLOTS.indexOf(piece.slot)), locked: true, classId: source.classId} : piece;
    return [piece.slot, project(current)];
  }));
  const currentKey = currentPieces?.length === 5 ? keyOf(currentPieces) : null;
  const rows = [];
  for (let index = 0; index < 5; index++) {
    const slot = SLOTS[index];
    const candidates = locked.has(slot) ? [locked.get(slot)]
      : items.filter(item => item.slot === slot).map(item => ({...project(createUpgradePieceFromItem(item, index)), classId: item.classId}));
    const equivalent = new Set();
    const physical = [];
    for (const piece of candidates.filter(eligible)) {
      const key = createPieceCapability(piece, index).equivalenceKey;
      const candidate = {piece, ...bounds(piece, reassignModifiers, onlyPlus5Tuning), cover: coverage(piece, setRequirement)};
      if (equivalent.has(key)) searchStats.equivalentItems++;
      equivalent.add(key);
      physical.push(candidate);
    }
    rows.push({slotIndex: index, candidates: physical});
  }
  rows.sort((a, b) => a.candidates.length - b.candidates.length || a.slotIndex - b.slotIndex);
  const belongs = piece => {
    let hash = 0;
    for (const char of keyOf([piece])) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return hash % shardCount === shardIndex;
  };
  const combinations = rows.reduce((count, row) => count * row.candidates.length, 1);
  const globalModBudget = modifierBudget ? modifierBudget.numPlus5 * 5 + modifierBudget.numPlus10 * 10
    : autoStatMods ? 50 : null;
  const modMaximum = !reassignModifiers ? 0 : globalModBudget ?? rows.reduce((sum, row) => sum
    + Math.max(0, ...row.candidates.map(candidate => candidate.piece.armorModSize || 0)), 0);
  const suffix = Array.from({length: 6}, () => ({min: Array(6).fill(0), max: Array(6).fill(0), cover: [0, 0]}));
  for (let depth = 4; depth >= 0; depth--) {
    const candidates = rows[depth].candidates;
    for (let stat = 0; stat < 6; stat++) {
      suffix[depth].min[stat] = suffix[depth + 1].min[stat] + Math.min(Infinity, ...candidates.map(candidate => candidate.min[stat]));
      suffix[depth].max[stat] = suffix[depth + 1].max[stat] + Math.max(-Infinity, ...candidates.map(candidate => candidate.max[stat]));
    }
    for (let index = 0; index < 2; index++) suffix[depth].cover[index] = suffix[depth + 1].cover[index]
      + Number(candidates.some(candidate => candidate.cover[index]));
  }
  const minimumCoverage = setRequirement.type === "set" ? [Number(setRequirement.count), 0]
    : setRequirement.type === "split" ? [2, 2] : [0, 0];
  const rules = problemSpec.constraintModel.rules;
  const joint = reassignModifiers ? createResidualBounds(rows, rules, true, onlyPlus5Tuning, globalModBudget) : null;
  searchStats.jointProjections = joint?.projections || 0;
  const results = [];
  let examined = 0;
  let feasibleFound = false;
  let exactCount = 0;
  let rejectedWitnesses = 0;
  let stopped = false;
  const seen = new Set();
  const mathCache = new Map();
  const evaluate = (pieces, refined = null) => {
    if (!legal(pieces, setRequirement) || !pieces.every(eligible) || !belongs(pieces[rows[0].slotIndex])) return;
    const key = keyOf(pieces);
    if (!refined && seen.has(key)) return;
    const mathKey = reassignModifiers ? getUpgradeMathKey(pieces, onlyPlus5Tuning) : null;
    let evaluation = refined || (mathKey && mathCache.get(mathKey));
    if (!evaluation) {
      const before = performance.now();
      evaluation = evaluateUpgradePieces(pieces, targets, fragments, reassignModifiers, required, onlyPlus5Tuning, userConstraints,
        {checkpoint: search?.checkpoint, autoStatMods, modifierBudget});
      searchStats.evaluationMs += performance.now() - before;
      searchStats.mathEvaluations++;
      // Cache only math/assignments. Physical identities are always taken from
      // this path and verified again before entering the result list.
      if (mathKey) {
        if (mathCache.size >= 512) mathCache.delete(mathCache.keys().next().value);
        mathCache.set(mathKey, evaluation);
      }
    } else if (!refined) searchStats.mathCacheHits++;
    evaluation = {...evaluation, configs: pieces.map(getUpgradeConfig)};
    examined++;
    // A stale current assignment or unknown item must not occupy the identity
    // cache, Top-K list or exact quota and hide a verifiable inventory result.
    const feasible = satisfiesConstraintModel({visibleTotals: evaluation.finalTotals}, problemSpec.constraintModel, STAT_DOMAIN.VISIBLE);
    const exact = feasible && STATS.every(stat => evaluation.finalTotals[stat] === Number(targets[stat]));
    const entry = {pieces: [...pieces], evaluation, key, feasible};
    const old = results.findIndex(result => result.key === key);
    if (old >= 0 && compare(entry, results[old]) >= 0) return;
    if (results.length >= maxResults && compare(entry, results.at(-1)) >= 0) {
      return;
    }
    if (problemSpec.runtimeOptions.verifyInventoryCandidates && !verifyWitness(problemSpec, {pieces,
      tuningAssignments: evaluation.tuningAssignments, modAssignments: evaluation.modAssignments}).valid) {
      rejectedWitnesses++;
      return;
    }
    seen.add(key);
    if (old >= 0) results.splice(old, 1);
    if (feasible) { feasibleFound = true; searchStats.firstFeasibleMs ??= performance.now() - started; }
    if (exact) { exactCount++; searchStats.firstExactMs ??= performance.now() - started; }
    results.push(entry);
    results.sort(compare);
    if (results.length > maxResults) results.length = maxResults;
    search?.publish({requirement: setRequirement, requiredStats: required, examined,
      searchStats: {...searchStats, frontierComplete: false}, results: results.map(result => ({
        pieces: result.pieces, ...result.evaluation,
      }))});
  };
  if (currentPieces?.length === 5 && legal(currentPieces, setRequirement)) evaluate(currentPieces.map(project));
  const chosen = Array(5);
  const partialMin = Array(6).fill(0);
  const partialMax = Array(6).fill(0);
  const canReachRules = depth => rules.every((rule, index) =>
    (rule.armorMaximum === null || partialMin[index] + suffix[depth].min[index] <= rule.armorMaximum)
    && (rule.armorMinimum === null || partialMax[index] + suffix[depth].max[index] + modMaximum >= rule.armorMinimum));
  const stop = reason => {
    stopped = true; searchStats.frontierComplete = false; searchStats.termination = reason;
  };
  const pointTarget = !reassignModifiers && rules.every(rule => rule.armorMinimum !== null
    && rule.armorMinimum === rule.armorMaximum);
  // Exact fixed-assignment inventory is a 2+3 sum join, not five nested
  // evaluations. Index two slots; stream the other three and keep identities
  // in the bucket so sets, Exotics, classes and execution alternatives survive.
  const meetInMiddle = () => {
    const table = new Map();
    let retained = 0;
    for (const a of rows[0].candidates) for (const b of rows[1].candidates) {
      if (!belongs(a.piece)) continue;
      if ((retained & 1023) === 0) search?.checkpoint(0, searchStats);
      if (retained >= searchStats.maxStates) return false;
      const sum = a.min.map((value, index) => value + b.min[index]);
      const key = sum.join(",");
      const bucket = table.get(key) || [];
      bucket.push([a, b]); table.set(key, bucket); retained++;
    }
    searchStats.peakStates = retained;
    searchStats.method = "fixed-assignment-2+3-join";
    const target = rules.map(rule => rule.armorMinimum);
    for (const c of rows[2].candidates) for (const d of rows[3].candidates) for (const e of rows[4].candidates) {
      if ((searchStats.statesExamined & 1023) === 0) search?.checkpoint(1024, searchStats);
      if (searchStats.statesExamined >= searchStats.maxNodes || performance.now() - started >= searchStats.maxTimeMs) {
        stop("join-resource-limit"); return true;
      }
      searchStats.statesExamined++;
      const key = target.map((value, index) => value - c.min[index] - d.min[index] - e.min[index]).join(",");
      const bucket = table.get(key);
      if (!bucket) continue;
      for (const [a, b] of bucket) {
        [a, b, c, d, e].forEach((candidate, index) => { chosen[rows[index].slotIndex] = candidate.piece; });
        if (examined >= searchStats.maxEvaluations) { stop("evaluation-limit"); return true; }
        evaluate(chosen);
      }
      if (searchLimits.exhaustive !== true && combinations > 4096 && exactCount >= maxResults) { stop("exact-witness-quota"); return true; }
    }
    return true;
  };
  const visit = (depth, exotics, cover, classId, strict) => {
    if (stopped) return;
    if (strict && joint && !joint.canReach(depth)) { searchStats.prunedJoint++; return; }
    if (depth === 5) { evaluate(chosen); return; }
    if (strict && !canReachRules(depth)) { searchStats.prunedBounds++; return; }
    if (minimumCoverage.some((value, index) => cover[index] + suffix[depth].cover[index] < value)) {
      searchStats.prunedSets++; return;
    }
    const row = rows[depth];
    const ordered = row.candidates.map(candidate => {
      let distance = 0;
      for (let index = 0; index < 6; index++) {
        const target = rules[index].preferredArmor;
        const low = partialMin[index] + candidate.min[index] + suffix[depth + 1].min[index];
        const high = partialMax[index] + candidate.max[index] + suffix[depth + 1].max[index] + modMaximum;
        const gap = Math.max(low - target, target - high, 0);
        const center = (low + high) / 2 - target;
        distance += gap * gap * 1000 + center * center;
      }
      return {candidate, distance};
    }).sort((a, b) => a.distance - b.distance
      || a.candidate.min.join(",").localeCompare(b.candidate.min.join(","))
      || keyOf([a.candidate.piece]).localeCompare(keyOf([b.candidate.piece])));
    for (const {candidate} of ordered) {
      if (depth === 0 && !belongs(candidate.piece)) continue;
      search?.checkpoint(1, searchStats);
      // DFS/streamed primitive budget is maxNodes, not maxStates (maxStates
      // only bounds the retained meet-in-the-middle join table).
      if (searchStats.statesExamined >= searchStats.maxNodes || examined >= searchStats.maxEvaluations) {
        stop("node-or-evaluation-limit"); break;
      }
      if (performance.now() - started >= searchStats.maxTimeMs) { stop("time-limit"); break; }
      if (searchLimits.exhaustive !== true && combinations > 4096 && exactCount >= maxResults) { stop("exact-witness-quota"); break; }
      searchStats.statesExamined++; searchStats.layers[depth]++;
      const exoticCount = exotics + Number(candidate.piece.exotic);
      if (exoticCount > 1 || classId && candidate.piece.classId && classId !== candidate.piece.classId) continue;
      chosen[row.slotIndex] = candidate.piece;
      joint?.add(candidate, 1);
      for (let index = 0; index < 6; index++) {
        partialMin[index] += candidate.min[index]; partialMax[index] += candidate.max[index];
      }
      searchStats.peakStates = Math.max(searchStats.peakStates, depth + 1);
      visit(depth + 1, exoticCount, cover.map((value, index) => value + candidate.cover[index]),
        classId || candidate.piece.classId, strict);
      joint?.add(candidate, -1);
      for (let index = 0; index < 6; index++) {
        partialMin[index] -= candidate.min[index]; partialMax[index] -= candidate.max[index];
      }
      if (stopped) break;
    }
  };
  let joined = false;
  if (combinations > 4096 && pointTarget) joined = meetInMiddle();
  if (combinations > 0 && !joined) visit(0, 0, [0, 0], null, combinations > 4096);
  // After proving no rule-feasible combination, spend remaining resources on
  // a nearest incumbent. This second pass cannot strengthen a negative proof.
  if (!stopped && !feasibleFound && combinations > 4096) visit(0, 0, [0, 0], null, false);
  // Refinement never narrows the frontier or authorizes a global proof.
  // Small/finished frontiers can spend their remaining time on local quality.
  if (reassignModifiers && search && performance.now() - started < searchStats.maxTimeMs) {
    for (const entry of results.slice(0, 3)) {
      const refined = refineUpgradeAssignment(entry.pieces, targets, fragments, required, onlyPlus5Tuning, userConstraints,
        entry.evaluation, {checkpoint: search.checkpoint, autoStatMods, modifierBudget,
          onImprovement: value => evaluate(entry.pieces, value)});
      searchStats.refinedAssignments++;
      evaluate(entry.pieces, refined);
    }
  }
  const unknown = problemSpec.pieceCapabilities.some(capability => !hasCompletePieceMath(capability, reassignModifiers));
  const complete = shardCount === 1 && searchStats.frontierComplete && searchStats.assignmentComplete && !unknown;
  return {requirement: setRequirement, requiredStats: required, examined, searchStats, rejectedWitnesses,
    proof: createProofEvidence(problemSpec, {
      producer: "inventory-frontier", method: "complete-inventory-frontier", complete,
      truncated: shardCount !== 1 || !searchStats.frontierComplete || !searchStats.assignmentComplete, statesExamined: searchStats.statesExamined,
      assumptions: unknown ? [] : ["known-data", "fixed-modifier-assignments"],
      outcome: feasibleFound ? "feasible" : "infeasible",
      limitation: unknown ? "one or more inventory capabilities contain unknown data"
        : !searchStats.frontierComplete ? `inventory resource limit: ${searchStats.termination}`
        : reassignModifiers ? "nearest modifier assignment evaluator is bounded" : null,
    }),
    results: results.map(entry => ({pieces: entry.pieces, isCurrent: entry.key === currentKey,
      score: entry.evaluation.score, metrics: entry.evaluation.metrics, finalTotals: entry.evaluation.finalTotals,
      tuningAssignments: entry.evaluation.tuningAssignments, modAssignments: entry.evaluation.modAssignments})),
  };
}
