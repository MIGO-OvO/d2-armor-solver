import {STATS} from "./armor-model.mjs";
import {STAT_DOMAIN, createPieceCapability, createProblemSpec, createProofEvidence,
  satisfiesConstraintModel, hasCompletePieceMath, verifyWitness} from "./solver-v3-contract.mjs";
import {applyManualUpgradeModifiers, compareUpgradeMetrics, createUpgradePieceFromItem,
  evaluateUpgradePieces, getUpgradeConfig, getUpgradeTuningCapability} from "./upgrade-optimizer.mjs";

const SLOTS = ["helmet", "arms", "chest", "legs", "classItem"];
const keyOf = pieces => pieces.map(piece => `${piece.slot}:id:${piece.sourceId || piece.id || ""}`).sort().join("|");
const compare = (a, b) => Number(b.feasible) - Number(a.feasible)
  || compareUpgradeMetrics(a.evaluation.metrics, b.evaluation.metrics) || a.key.localeCompare(b.key);

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
  return {
    min: STATS.map(stat => Math.min(manual[stat], config.baseStats[stat]
      - Number(destinations.some(to => to !== stat)) * 5)),
    // Mod sizes may move between pieces; add the global budget only once.
    max: STATS.map(stat => Math.max(manual[stat], config.baseStats[stat]
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
}, problemSpec = createProblemSpec({operation: "solveInventory", targets, fragments, constraints: userConstraints,
  targetDomain: STAT_DOMAIN.VISIBLE, pieces: items,
  inventoryContext: {setRequirement, reassignModifiers, onlyPlus5Tuning, requiredStats, currentPieces},
})) {
  if (!setRequirement) return null;
  const limit = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;
  maxResults = limit(maxResults, 12);
  const started = performance.now();
  const searchStats = {frontierComplete: true, assignmentComplete: !reassignModifiers,
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
    const compressed = new Map();
    for (const piece of candidates) {
      const key = createPieceCapability(piece, index).equivalenceKey;
      const previous = compressed.get(key);
      const candidate = {piece, ...bounds(piece, reassignModifiers, onlyPlus5Tuning), cover: coverage(piece, setRequirement)};
      if (previous) searchStats.equivalentItems++;
      if (!previous || keyOf([piece]).localeCompare(keyOf([previous.piece])) < 0) compressed.set(key, candidate);
    }
    rows.push({slotIndex: index, candidates: [...compressed.values()]});
  }
  rows.sort((a, b) => a.candidates.length - b.candidates.length || a.slotIndex - b.slotIndex);
  const combinations = rows.reduce((count, row) => count * row.candidates.length, 1);
  const modMaximum = reassignModifiers ? rows.reduce((sum, row) => sum
    + Math.max(0, ...row.candidates.map(candidate => candidate.piece.armorModSize || 0)), 0) : 0;
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
  const results = [];
  let examined = 0;
  let feasibleFound = false;
  let exactCount = 0;
  let rejectedWitnesses = 0;
  let stopped = false;
  const seen = new Set();
  const evaluate = pieces => {
    if (!legal(pieces, setRequirement)) return;
    const key = keyOf(pieces);
    if (seen.has(key)) return;
    const evaluation = evaluateUpgradePieces(pieces, targets, fragments, reassignModifiers, required, onlyPlus5Tuning, userConstraints);
    examined++;
    // A stale current assignment or unknown item must not occupy the identity
    // cache, Top-K list or exact quota and hide a verifiable inventory result.
    const feasible = satisfiesConstraintModel({visibleTotals: evaluation.finalTotals}, problemSpec.constraintModel, STAT_DOMAIN.VISIBLE);
    const exact = feasible && STATS.every(stat => evaluation.finalTotals[stat] === Number(targets[stat]));
    const entry = {pieces: [...pieces], evaluation, key, feasible};
    if (results.length >= maxResults && compare(entry, results.at(-1)) >= 0) {
      return;
    }
    if (problemSpec.runtimeOptions.verifyInventoryCandidates && !verifyWitness(problemSpec, {pieces,
      tuningAssignments: evaluation.tuningAssignments, modAssignments: evaluation.modAssignments}).valid) {
      rejectedWitnesses++;
      return;
    }
    seen.add(key);
    if (feasible) { feasibleFound = true; searchStats.firstFeasibleMs ??= performance.now() - started; }
    if (exact) { exactCount++; searchStats.firstExactMs ??= performance.now() - started; }
    results.push(entry);
    results.sort(compare);
    if (results.length > maxResults) results.length = maxResults;
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
      if (searchStats.statesExamined >= searchStats.maxStates || examined >= searchStats.maxEvaluations) {
        stop("node-or-evaluation-limit"); break;
      }
      if (performance.now() - started >= searchStats.maxTimeMs) { stop("time-limit"); break; }
      if (searchLimits.exhaustive !== true && combinations > 4096 && exactCount >= maxResults) { stop("exact-witness-quota"); break; }
      searchStats.statesExamined++; searchStats.layers[depth]++;
      const exoticCount = exotics + Number(candidate.piece.exotic);
      if (exoticCount > 1 || classId && candidate.piece.classId && classId !== candidate.piece.classId) continue;
      chosen[row.slotIndex] = candidate.piece;
      for (let index = 0; index < 6; index++) {
        partialMin[index] += candidate.min[index]; partialMax[index] += candidate.max[index];
      }
      searchStats.peakStates = Math.max(searchStats.peakStates, depth + 1);
      visit(depth + 1, exoticCount, cover.map((value, index) => value + candidate.cover[index]),
        classId || candidate.piece.classId, strict);
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
  const unknown = problemSpec.pieceCapabilities.some(capability => !hasCompletePieceMath(capability, reassignModifiers));
  const complete = searchStats.frontierComplete && searchStats.assignmentComplete && !unknown;
  return {requirement: setRequirement, requiredStats: required, examined, searchStats, rejectedWitnesses,
    proof: createProofEvidence(problemSpec, {
      producer: "inventory-frontier", method: "complete-inventory-frontier", complete,
      truncated: !searchStats.frontierComplete || !searchStats.assignmentComplete, statesExamined: searchStats.statesExamined,
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
