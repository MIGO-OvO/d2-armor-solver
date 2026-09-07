import { BASE_CONFIGS, STATS, getMasterworkStats } from "./armor-model.mjs";
import { findExactTargetWitnesses, visibleArmorTargets } from "./exact-target-oracle.mjs";
import {
  RESULT_STATUS, STAT_DOMAIN, createProblemSpec, createProofEvidence,
  getArmorSolverInput, visibleStatFromArmor, createConstraintModel,
  stableSerialize,
} from "./solver-v3-contract.mjs";

const reachableRangeCache = new Map();

function cacheReachableRange(key, result) {
  reachableRangeCache.set(key, structuredClone(result));
  while (reachableRangeCache.size > 24) {
    reachableRangeCache.delete(reachableRangeCache.keys().next().value);
  }
  return result;
}

export function buildPieceStateOptions(configs, usePlus3) {
  const options = [];
  for (const config of configs) {
    if (usePlus3) {
      const totals = { ...config.baseStats };
      for (const stat of getMasterworkStats(config) || []) totals[stat]++;
      options.push(totals);
      continue;
    }
    for (const from of STATS) {
      for (const to of STATS) {
        if (from === to) continue;
        const totals = { ...config.baseStats };
        totals[from] -= 5;
        totals[to] += 5;
        options.push(totals);
      }
    }
  }
  return options;
}
export const PURPLE_STATE_OPTIONS = [
  buildPieceStateOptions(BASE_CONFIGS, false),
  buildPieceStateOptions(BASE_CONFIGS, true),
];

export function compressStateOptions(options, lockedStats, objectiveStat) {
  const compressed = new Map();
  for (const totals of options) {
    const lockValues = lockedStats.map(stat => totals[stat]);
    const key = lockValues.join(',');
    const objectiveValue = objectiveStat ? totals[objectiveStat] : 0;
    const existing = compressed.get(key);
    if (!existing) {
      compressed.set(key, {
        lockValues,
        values: new Set([objectiveValue]),
      });
    } else {
      existing.values.add(objectiveValue);
    }
  }
  return [...compressed.values()].map(option => ({
    lockValues: option.lockValues,
    values: [...option.values],
  }));
}

export function buildModifierStateOptions(numPlus5, numPlus10, lockedStats, objectiveStat) {
  let states = new Map([['', {
    lockValues: lockedStats.map(() => 0),
    values: new Set([0]),
    modAssignments: {},
  }]]);
  const sizes = [
    ...Array(numPlus10).fill(10),
    ...Array(numPlus5).fill(5),
  ];

  for (const size of sizes) {
    const next = new Map();
    for (const state of states.values()) {
      for (const stat of STATS) {
        const lockValues = state.lockValues.map((value, index) =>
          value + (lockedStats[index] === stat ? size : 0)
        );
        const key = lockValues.join(',');
        const objectiveGain = objectiveStat === stat ? size : 0;
        const existing = next.get(key);
        if (!existing) {
          next.set(key, {
            lockValues,
            values: new Set([...state.values].map(value => value + objectiveGain)),
            modAssignments: {...state.modAssignments,
              [Object.keys(state.modAssignments).length]: {size, stat}},
          });
        } else {
          for (const value of state.values) existing.values.add(value + objectiveGain);
        }
      }
    }
    states = next;
  }
  return [...states.values()].map(option => ({
    lockValues: option.lockValues,
    values: [...option.values],
    modAssignments: option.modAssignments,
  }));
}

export function addReachableValues(leftValues, rightValues) {
  const sums = new Set();
  for (const left of leftValues) {
    for (const right of rightValues) sums.add(left + right);
  }
  return sums;
}

export function calculateReachableStatRange(
  fixedPiece, numPlus5, numPlus10, numPlus3, fragments, lockedTargets, objectiveStat,
  searchStats = { statesExamined: 0 },
) {
  if (Object.values(lockedTargets).some(value => value === 0 || value === 200)) {
    return calculateIntervalStatRange(fixedPiece, numPlus5, numPlus10, numPlus3,
      fragments, lockedTargets, objectiveStat, searchStats);
  }
  searchStats.statesExamined++;
  if ((searchStats.statesExamined & 1023) === 0) searchStats.checkpoint?.(1024);
  const lockedStats = Object.keys(lockedTargets).sort();
  const armorTargets = lockedStats.map(stat =>
    lockedTargets[stat] - (fragments[stat] || 0)
  );
  if (armorTargets.some(value => value < 0)) return null;

  const fixedOptions = [
    compressStateOptions(buildPieceStateOptions([fixedPiece], false), lockedStats, objectiveStat),
    compressStateOptions(buildPieceStateOptions([fixedPiece], true), lockedStats, objectiveStat),
  ];
  const purpleOptions = [
    compressStateOptions(PURPLE_STATE_OPTIONS[0], lockedStats, objectiveStat),
    compressStateOptions(PURPLE_STATE_OPTIONS[1], lockedStats, objectiveStat),
  ];
  const modifierOptions = buildModifierStateOptions(
    numPlus5, numPlus10, lockedStats, objectiveStat
  );
  const modifierMap = new Map(
    modifierOptions.map(option => [option.lockValues.join(','), option])
  );
  if (lockedStats.length >= 4) {
    const stateKey = (usedPlus3, lockValues) => {
      return `${usedPlus3}|${lockValues.join(',')}`;
    };
    const mergeState = (map, usedPlus3, lockValues, values) => {
      const key = stateKey(usedPlus3, lockValues);
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          usedPlus3,
          lockValues,
          values: new Set(values),
        });
      } else {
        for (const value of values) existing.values.add(value);
      }
    };
    const extendWithPurplePiece = states => {
      const next = new Map();
      for (const state of states.values()) {
        for (let mode = 0; mode <= 1; mode++) {
          const usedPlus3 = state.usedPlus3 + mode;
          if (usedPlus3 > numPlus3) continue;
          for (const option of purpleOptions[mode]) {
            searchStats.statesExamined++;
            if ((searchStats.statesExamined & 1023) === 0) searchStats.checkpoint?.(1024);
            const lockValues = state.lockValues.map((value, index) =>
              value + option.lockValues[index]
            );
            if (lockValues.some((value, index) => value > armorTargets[index])) {
              continue;
            }
            mergeState(
              next,
              usedPlus3,
              lockValues,
              addReachableValues(state.values, option.values),
            );
          }
        }
      }
      return next;
    };

    let purplePairStates = new Map([[stateKey(0, lockedStats.map(() => 0)), {
      usedPlus3: 0,
      lockValues: lockedStats.map(() => 0),
      values: new Set([0]),
    }]]);
    purplePairStates = extendWithPurplePiece(purplePairStates);
    purplePairStates = extendWithPurplePiece(purplePairStates);

    const leftStates = new Map();
    for (let mode = 0; mode <= 1; mode++) {
      if (mode > numPlus3) continue;
      for (const option of fixedOptions[mode]) {
        for (const pair of purplePairStates.values()) {
          searchStats.statesExamined++;
          if ((searchStats.statesExamined & 1023) === 0) searchStats.checkpoint?.(1024);
          const usedPlus3 = mode + pair.usedPlus3;
          if (usedPlus3 > numPlus3) continue;
          const lockValues = option.lockValues.map((value, index) =>
            value + pair.lockValues[index]
          );
          if (lockValues.some((value, index) => value > armorTargets[index])) {
            continue;
          }
          mergeState(
            leftStates,
            usedPlus3,
            lockValues,
            addReachableValues(option.values, pair.values),
          );
        }
      }
    }

    const reachableValues = new Set();
    for (const left of leftStates.values()) {
      const rightPlus3 = numPlus3 - left.usedPlus3;
      if (rightPlus3 < 0 || rightPlus3 > 2) continue;
      for (const modifier of modifierOptions) {
        searchStats.statesExamined++;
        if ((searchStats.statesExamined & 1023) === 0) searchStats.checkpoint?.(1024);
        const rightLocks = armorTargets.map((targetValue, index) =>
          targetValue - left.lockValues[index] - modifier.lockValues[index]
        );
        if (rightLocks.some(value => value < 0)) continue;
        const right = purplePairStates.get(stateKey(rightPlus3, rightLocks));
        if (!right) continue;
        const armorValues = addReachableValues(left.values, right.values);
        for (const value of addReachableValues(armorValues, modifier.values)) {
          reachableValues.add(value);
        }
      }
    }
    if (reachableValues.size === 0) return null;
    const fragment = objectiveStat ? (fragments[objectiveStat] || 0) : 0;
    const rawValues = [...reachableValues].sort((a, b) => a - b);
    const values = rawValues
      .map(value => Math.max(0, Math.min(200, value + fragment)))
      .filter((value, index, array) => array.indexOf(value) === index)
      .sort((a, b) => a - b);
    return {
      min: values[0],
      max: values[values.length - 1],
      values,
      rawValues,
    };
  }
  const modifierTotal = numPlus5 * 5 + numPlus10 * 10;
  const purpleBounds = purpleOptions.map(options =>
    lockedStats.map((stat, index) => ({
      min: Math.min(...options.map(option => option.lockValues[index])),
      max: Math.max(...options.map(option => option.lockValues[index])),
    }))
  );

  function canStillReachLocks(lockValues, usedPlus3, remainingPieces) {
    const remainingPlus3 = numPlus3 - usedPlus3;
    if (remainingPlus3 < 0 || remainingPlus3 > remainingPieces) return false;
    const remainingTuned = remainingPieces - remainingPlus3;
    return lockValues.every((value, index) => {
      const minFuture =
        remainingTuned * purpleBounds[0][index].min +
        remainingPlus3 * purpleBounds[1][index].min;
      const maxFuture =
        remainingTuned * purpleBounds[0][index].max +
        remainingPlus3 * purpleBounds[1][index].max +
        modifierTotal;
      return value + minFuture <= armorTargets[index] &&
        value + maxFuture >= armorTargets[index];
    });
  }

  let states = new Map();
  for (let mode = 0; mode <= 1; mode++) {
    if (mode > numPlus3) continue;
    for (const option of fixedOptions[mode]) {
      searchStats.statesExamined++;
      if ((searchStats.statesExamined & 1023) === 0) searchStats.checkpoint?.(1024);
      if (option.lockValues.some((value, index) => value > armorTargets[index])) continue;
      if (!canStillReachLocks(option.lockValues, mode, 4)) continue;
      const key = `${mode}|${option.lockValues.join(',')}`;
      states.set(key, {
        usedPlus3: mode,
        lockValues: option.lockValues,
        values: new Set(option.values),
      });
    }
  }

  for (let pieceIndex = 0; pieceIndex < 4; pieceIndex++) {
    const next = new Map();
    for (const state of states.values()) {
      for (let mode = 0; mode <= 1; mode++) {
        const usedPlus3 = state.usedPlus3 + mode;
        if (usedPlus3 > numPlus3) continue;
        for (const option of purpleOptions[mode]) {
          searchStats.statesExamined++;
          const lockValues = state.lockValues.map((value, index) =>
            value + option.lockValues[index]
          );
          if (lockValues.some((value, index) => value > armorTargets[index])) continue;
          const remainingPieces = 3 - pieceIndex;
          if (!canStillReachLocks(lockValues, usedPlus3, remainingPieces)) continue;
          const key = `${usedPlus3}|${lockValues.join(',')}`;
          const values = addReachableValues(state.values, option.values);
          const existing = next.get(key);
          if (!existing) {
            next.set(key, { usedPlus3, lockValues, values });
          } else {
            for (const value of values) existing.values.add(value);
          }
        }
      }
    }
    states = next;
  }

  const reachableValues = new Set();
  for (const state of states.values()) {
    if (state.usedPlus3 !== numPlus3) continue;
    const neededModifiers = armorTargets.map((target, index) =>
      target - state.lockValues[index]
    );
    const modifier = modifierMap.get(neededModifiers.join(','));
    if (!modifier) continue;
    for (const value of addReachableValues(state.values, modifier.values)) {
      reachableValues.add(value);
    }
  }

  if (reachableValues.size === 0) return null;
  const fragment = objectiveStat ? (fragments[objectiveStat] || 0) : 0;
  const rawValues = [...reachableValues].sort((a, b) => a - b);
  const values = rawValues
    .map(value => Math.max(0, Math.min(200, value + fragment)))
    .filter((value, index, array) => array.indexOf(value) === index)
    .sort((a, b) => a - b);
  return {
    min: values[0],
    max: values[values.length - 1],
    values,
    rawValues,
  };
}

export function calculateDenseLockRanges(
  fixedPiece, numPlus5, numPlus10, numPlus3, fragments, lockedTargets,
  searchStats = { statesExamined: 0 },
) {
  const lockedStats = Object.keys(lockedTargets);
  const unlockedStats = STATS.filter(stat => !lockedStats.includes(stat));
  const lockedArmorTargets = Object.fromEntries(lockedStats.map(stat => [
    stat, lockedTargets[stat] - (fragments[stat] || 0),
  ]));
  if (Object.values(lockedArmorTargets).some(value => value < 0)) {
    return { feasible: false, ranges: {} };
  }
  const ranges = Object.fromEntries(lockedStats.map(stat => [
    stat, { min: lockedTargets[stat], max: lockedTargets[stat], values: [lockedTargets[stat]] },
  ]));

  const objective = unlockedStats[0] || null;
  const probe = calculateReachableStatRange(
    fixedPiece, numPlus5, numPlus10, numPlus3, fragments,
    lockedTargets, objective, searchStats,
  );
  if (!probe) return { feasible: false, ranges: {} };
  if (unlockedStats.length === 0) return { feasible: true, ranges };
  ranges[objective] = probe;

  if (unlockedStats.length === 2) {
    const companion = unlockedStats[1];
    const totalArmor = STATS.reduce((sum, stat) => sum + fixedPiece.baseStats[stat], 360)
      + numPlus3 * 3 + numPlus5 * 5 + numPlus10 * 10;
    const lockedArmorSum = Object.values(lockedArmorTargets)
      .reduce((sum, value) => sum + value, 0);
    const remainingArmor = totalArmor - lockedArmorSum;
    const companionValues = [...new Set(probe.rawValues.map(value =>
      Math.max(0, Math.min(
        200,
        remainingArmor - value + (fragments[companion] || 0),
      ))
    ))].sort((left, right) => left - right);
    ranges[companion] = {
      min: companionValues[0],
      max: companionValues[companionValues.length - 1],
      values: companionValues,
    };
  }
  return { feasible: true, ranges };
}

// A saturated lower-bound coordinate is future-equivalent once reached:
// all subsequent T5 pieces/mods contribute nonnegative amounts. Upper bounds
// retain the exact running value. Thus 0/200 locks are intervals, not points.
function calculateIntervalStatRange(fixed, n5, n10, n3, fragments, locks, objective, stats) {
  stats.intervalDomain = true;
  stats.complete ??= true;
  stats.startedAt ??= performance.now();
  const model = createConstraintModel({target: locks, fragments, targetDomain: STAT_DOMAIN.VISIBLE,
    constraints: {exact: Object.fromEntries(Object.keys(locks).map(stat => [stat, true]))}});
  const locked = STATS.filter(stat => locks[stat] !== undefined);
  const rules = locked.map(stat => model.rules.find(rule => rule.stat === stat));
  const total = STATS.reduce((sum, stat) => sum + fixed.baseStats[stat], 360) + n3 * 3 + n5 * 5 + n10 * 10;
  if (model.rules.reduce((sum, rule) => sum + Math.max(0, rule.armorMinimum ?? 0), 0) > total
      || model.rules.every(rule => rule.armorMaximum !== null)
        && model.rules.reduce((sum, rule) => sum + rule.armorMaximum, 0) < total) return null;
  const tracing = locked.length === 6 && objective === null;
  const traceOptions = (configs, balanced) => {
    const records = new Map();
    for (const config of configs) {
      const tunings = balanced ? [{mode: "+3", from: null, to: null}]
        : STATS.flatMap(from => STATS.filter(to => to !== from).map(to => ({mode: "+5-5", from, to})));
      for (const tuning of tunings) {
        const totals = {...config.baseStats};
        if (balanced) for (const stat of getMasterworkStats(config)) totals[stat]++;
        else { totals[tuning.from] -= 5; totals[tuning.to] += 5; }
        const lockValues = locked.map(stat => totals[stat]);
        const key = lockValues.join(",");
        if (!records.has(key)) records.set(key, {lockValues, values: [0], config, tuning});
      }
    }
    return [...records.values()];
  };
  const fixedOptions = [false, true].map(mode => tracing ? traceOptions([fixed], mode)
    : compressStateOptions(buildPieceStateOptions([fixed], mode), locked, objective));
  const purpleOptions = PURPLE_STATE_OPTIONS.map((options, mode) => tracing ? traceOptions(BASE_CONFIGS, mode)
    : compressStateOptions(options, locked, objective));
  const mods = buildModifierStateOptions(n5, n10, locked, objective);
  let states = new Map([["start", {used: 0, locks: locked.map(() => 0), values: new Set([0])}]]);
  for (let depth = 0; depth < 6; depth++) {
    const next = new Map();
    for (const state of states.values()) {
      for (const mode of depth === 5 ? [0] : [0, 1]) {
        const used = state.used + mode;
        if (used > n3 || used + Math.max(0, 4 - depth) < n3) continue;
        const options = depth === 5 ? mods : depth === 0 ? fixedOptions[mode] : purpleOptions[mode];
        for (const option of options) {
          stats.statesExamined++;
          if ((stats.statesExamined & 1023) === 0) stats.checkpoint?.(1024);
          if ((stats.statesExamined & 1023) === 0 && performance.now() - stats.startedAt > (stats.maxTimeMs || 3000)
              || next.size >= (stats.maxStates || 50000)) {
            stats.complete = false;
            stats.limitation = "interval DP resource limit";
            return null;
          }
          const values = state.locks.map((value, index) => value + option.lockValues[index]);
          if (rules.some((rule, index) => rule.armorMaximum !== null && values[index] > rule.armorMaximum)) continue;
          for (let index = 0; index < rules.length; index++) {
            const rule = rules[index];
            if (rule.armorMaximum === null && rule.armorMinimum !== null) values[index] = Math.min(values[index], rule.armorMinimum);
          }
          const key = `${used}|${values.join(",")}`;
          let entry = next.get(key);
          if (!entry) {
            entry = {used, locks: values, values: new Set(), ...(tracing ? {parent: state, option} : {})};
            next.set(key, entry);
          }
          for (const a of state.values) for (const b of option.values) entry.values.add(a + b);
        }
      }
    }
    states = next;
    if (!states.size) return null;
  }
  const reachable = new Set();
  let witness = null;
  for (const state of states.values()) {
    if (state.used !== n3 || rules.some((rule, index) => rule.armorMinimum !== null && state.locks[index] < rule.armorMinimum)) continue;
    for (const value of state.values) reachable.add(value);
    if (tracing && !witness) {
      const config = [];
      const tuningAssignments = [];
      const modAssignments = state.option.modAssignments;
      let cursor = state.parent;
      while (cursor.option) {
        config.unshift(cursor.option.config);
        tuningAssignments.unshift(cursor.option.tuning);
        cursor = cursor.parent;
      }
      const totals = Object.fromEntries(STATS.map(stat => [stat, 0]));
      config.forEach((piece, index) => {
        for (const stat of STATS) totals[stat] += piece.baseStats[stat];
        const tuning = tuningAssignments[index];
        if (tuning.mode === "+3") for (const stat of getMasterworkStats(piece)) totals[stat]++;
        else { totals[tuning.from] -= 5; totals[tuning.to] += 5; }
        const mod = modAssignments[index];
        if (mod) totals[mod.stat] += mod.size;
      });
      witness = {config, tuningAssignments, modAssignments, totals};
    }
  }
  if (!reachable.size) return null;
  const rawValues = [...reachable].sort((a, b) => a - b);
  const values = [...new Set(rawValues.map(value => visibleStatFromArmor(value, fragments[objective] || 0)))].sort((a, b) => a - b);
  return {min: values[0], max: values.at(-1), values, rawValues, ...(witness ? {witness} : {})};
}

export function calculateReachableRanges(
  fixedPiece, numPlus5, numPlus10, numPlus3, fragments, lockedTargets, search = null
) {
  const fixedKey = STATS.map(stat => fixedPiece.baseStats[stat]).join(',');
  const fragmentKey = STATS.map(stat => fragments[stat] || 0).join(',');
  const lockKey = STATS
    .filter(stat => lockedTargets[stat] !== undefined)
    .map(stat => `${stat}:${lockedTargets[stat]}`)
    .join(',');
  const cacheKey = [
    fixedKey, getMasterworkStats(fixedPiece)?.join(","), stableSerialize(fixedPiece),
    numPlus5, numPlus10, numPlus3, fragmentKey, lockKey,
  ].join('|');
  const cached = reachableRangeCache.get(cacheKey);
  if (cached) return structuredClone(cached);
  const searchStats = { statesExamined: 0, checkpoint: search?.checkpoint,
    maxStates: search?.limits?.maxStates, maxTimeMs: search?.limits?.maxTimeMs };
  const finish = result => {
    const statistics = {...searchStats};
    delete statistics.checkpoint;
    const value = {...result, searchStats: statistics};
    return statistics.complete === false ? value : cacheReachableRange(cacheKey, value);
  };

  const lockedStats = Object.keys(lockedTargets);
  if (lockedStats.length >= 4 && !Object.values(lockedTargets).some(value => value === 0 || value === 200)) {
    const result = calculateDenseLockRanges(
      fixedPiece, numPlus5, numPlus10, numPlus3, fragments, lockedTargets, searchStats,
    );
    return finish(result);
  }
  const unlockedStats = STATS.filter(stat => !lockedStats.includes(stat));
  const feasibilityProbe = calculateReachableStatRange(
    fixedPiece, numPlus5, numPlus10, numPlus3, fragments, lockedTargets,
    unlockedStats[0] || null, searchStats,
  );
  if (!feasibilityProbe) {
    const result = { feasible: false, ranges: {} };
    return finish(result);
  }

  const ranges = {};
  for (const stat of lockedStats) {
    ranges[stat] = {
      min: lockedTargets[stat],
      max: lockedTargets[stat],
      values: [lockedTargets[stat]],
    };
  }
  if (unlockedStats.length > 0) {
    ranges[unlockedStats[0]] = feasibilityProbe;
  }
  for (const stat of unlockedStats.slice(1)) {
    ranges[stat] = calculateReachableStatRange(
      fixedPiece, numPlus5, numPlus10, numPlus3, fragments, lockedTargets, stat, searchStats,
    );
  }

  const result = { feasible: true, ranges, ...(feasibilityProbe.witness ? {witness: feasibilityProbe.witness} : {}) };
  return finish(result);
}

export function findReachabilityWitness({
  fixedPiece,
  numPlus5,
  numPlus10,
  numPlus3,
  fragments = {},
  visibleTarget = {},
  problemSpec = createProblemSpec({
    operation: "calculateReachability",
    target: visibleTarget,
    constraints: { exact: Object.fromEntries(STATS.map(stat => [stat, true])) },
    targetDomain: STAT_DOMAIN.VISIBLE,
    fragments, numPlus5, numPlus10, numPlus3,
    pieces: fixedPiece ? [fixedPiece] : [],
  }),
}) {
  if (!problemSpec.valid || !fixedPiece
      || STATS.some(stat => !Number.isSafeInteger(Number(visibleTarget[stat])))) {
    return {
      status: RESULT_STATUS.INVALID_INPUT,
      witness: null,
      proof: createProofEvidence(problemSpec, { method: "input-validation" }),
    };
  }
  const armorTarget = getArmorSolverInput(problemSpec).target;
  ({numPlus5, numPlus10, numPlus3} = problemSpec.budget);
  fixedPiece = problemSpec.solverContext.fixedConfig;
  const hasClampBoundary = STATS.some(stat =>
    Number(visibleTarget[stat]) === 0 || Number(visibleTarget[stat]) === 200);
  if (hasClampBoundary) {
    const total = STATS.reduce((sum, stat) => sum + fixedPiece.baseStats[stat], 360)
      + numPlus3 * 3 + numPlus5 * 5 + numPlus10 * 10;
    const preimage = visibleArmorTargets(problemSpec.constraintModel.target, problemSpec.constraintModel.fragments, total, 8);
    if (preimage.complete) {
      let witness = null;
      let statesExamined = 0;
      for (const point of preimage.targets) {
        const pointStats = {};
        const found = findExactTargetWitnesses({target: point, numPlus5, numPlus10, numPlus3,
          fixedConfig: fixedPiece, searchStats: pointStats});
        statesExamined += pointStats.statesExamined;
        if (found[0]) { witness = {...found[0], totals: point}; break; }
      }
      if (witness) witness.visibleTotals = Object.fromEntries(STATS.map(stat =>
        [stat, visibleStatFromArmor(witness.totals[stat], problemSpec.constraintModel.fragments[stat])]));
      return {status: witness ? RESULT_STATUS.EXACT_TARGET_PROVEN : RESULT_STATUS.INFEASIBLE_PROVEN, witness,
        proof: createProofEvidence(problemSpec, {producer: "reachability-dp", method: "budget-reduced-interval-oracle",
          complete: true, scope: "rule-domain", outcome: witness ? "feasible" : "infeasible", statesExamined,
          assumptions: ["known-data", "complete-catalog", "exhausted-clamp-preimage"]})};
    }
    const ranged = calculateReachableRanges(fixedPiece, numPlus5, numPlus10, numPlus3,
      problemSpec.constraintModel.fragments, problemSpec.constraintModel.target);
    const complete = ranged.searchStats.complete !== false;
    const witness = ranged.witness || null;
    if (witness) witness.visibleTotals = Object.fromEntries(STATS.map(stat =>
      [stat, visibleStatFromArmor(witness.totals[stat], problemSpec.constraintModel.fragments[stat])]));
    return {
      status: witness ? RESULT_STATUS.EXACT_TARGET_PROVEN
        : complete && !ranged.feasible ? RESULT_STATUS.INFEASIBLE_PROVEN : RESULT_STATUS.SEARCH_LIMIT_REACHED,
      witness,
      proof: createProofEvidence(problemSpec, {producer: "reachability-dp", method: "interval-complete-dynamic-programming",
        complete, truncated: !complete, scope: "rule-domain", outcome: ranged.feasible ? "feasible" : "infeasible",
        statesExamined: ranged.searchStats.statesExamined, assumptions: ["known-data", "complete-catalog", "nonnegative-future-contributions"],
        limitation: ranged.searchStats.limitation}),
    };
  }
  const searchStats = {};
  const witnesses = findExactTargetWitnesses({
    target: armorTarget,
    numPlus5,
    numPlus10,
    numPlus3,
    fixedConfig: fixedPiece,
    searchStats,
  });
  const witness = witnesses[0] || null;
  const proof = createProofEvidence(problemSpec, {
    producer: "exact-target-oracle",
    method: "exact-target-oracle",
    complete: !hasClampBoundary,
    scope: "target-point",
    outcome: witness ? "feasible" : "infeasible",
    statesExamined: searchStats.statesExamined,
    assumptions: ["known-data", "complete-catalog", "point-target-only"],
    limitation: hasClampBoundary ? "clamped boundary requires an interval-complete proof" : null,
  });
  if (witness) {
    witness.totals = { ...armorTarget };
    witness.visibleTotals = Object.fromEntries(STATS.map(stat => [
      stat,
      visibleStatFromArmor(armorTarget[stat], fragments[stat] || 0),
    ]));
    return {
      status: hasClampBoundary ? RESULT_STATUS.SEARCH_LIMIT_REACHED : RESULT_STATUS.EXACT_TARGET_PROVEN,
      witness,
      proof,
    };
  }
  return {
    status: hasClampBoundary
      ? RESULT_STATUS.SEARCH_LIMIT_REACHED
      : RESULT_STATUS.INFEASIBLE_PROVEN,
    witness: null,
    proof,
    reason: hasClampBoundary
      ? "clamped boundary corresponds to an armor-domain interval"
      : null,
  };
}
