import { BASE_CONFIGS, STATS } from "./armor-model.mjs";
import { runSolver } from "./solver.mjs";

const reachableRangeCache = new Map();

export function buildPieceStateOptions(configs, usePlus3) {
  const options = [];
  for (const config of configs) {
    if (usePlus3) {
      const totals = { ...config.baseStats };
      for (const stat of STATS) {
        if (stat !== config.primary && stat !== config.secondary && stat !== config.tertiary) {
          totals[stat] += 1;
        }
      }
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
  fixedPiece, numPlus5, numPlus10, numPlus3, fragments, lockedTargets, objectiveStat
) {
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
  const values = [...reachableValues]
    .map(value => Math.max(0, Math.min(200, value + fragment)))
    .filter((value, index, array) => array.indexOf(value) === index)
    .sort((a, b) => a - b);
  return {
    min: values[0],
    max: values[values.length - 1],
    values,
  };
}

export function calculateDenseLockRanges(
  fixedPiece, numPlus5, numPlus10, numPlus3, fragments, lockedTargets
) {
  const lockedStats = Object.keys(lockedTargets);
  const unlockedStats = STATS.filter(stat => !lockedStats.includes(stat));
  const totalFinal = 450 + numPlus3 * 3 + numPlus5 * 5 + numPlus10 * 10 +
    STATS.reduce((sum, stat) => sum + (fragments[stat] || 0), 0);
  const lockedFinalSum = lockedStats.reduce(
    (sum, stat) => sum + lockedTargets[stat], 0
  );
  const remainingFinal = totalFinal - lockedFinalSum;
  if (remainingFinal < 0) return { feasible: false, ranges: {} };

  const lockedArmorTargets = Object.fromEntries(lockedStats.map(stat => [
    stat, lockedTargets[stat] - (fragments[stat] || 0),
  ]));
  if (Object.values(lockedArmorTargets).some(value => value < 0)) {
    return { feasible: false, ranges: {} };
  }

  function solveDenseTarget(finalTargets, priorityStat = null) {
    const armorTarget = Object.fromEntries(STATS.map(stat => [
      stat, finalTargets[stat] - (fragments[stat] || 0),
    ]));
    if (Object.values(armorTarget).some(value => value < 0)) return null;
    const exact = Object.fromEntries(STATS.map(stat => [
      stat, lockedStats.includes(stat),
    ]));
    const settings = {
      config: fixedPiece,
      classId: 'range-probe',
      classLabel: '',
      primaryPerkId: '',
      primaryPerkName: '',
      secondaryPerkId: '',
      secondaryPerkName: '',
    };
    const result = runSolver(
      armorTarget, numPlus5, numPlus10, numPlus3,
      {
        exact,
        priorityOrder: priorityStat ? [priorityStat] : [],
      },
      settings
    )[0];
    if (!result) return null;
    const locksSatisfied = lockedStats.every(stat =>
      result.totals[stat] === lockedArmorTargets[stat]
    );
    return locksSatisfied ? result : null;
  }

  if (unlockedStats.length <= 1) {
    if (unlockedStats.length === 0 && remainingFinal !== 0) {
      return { feasible: false, ranges: {} };
    }
    const finalTargets = { ...lockedTargets };
    if (unlockedStats.length === 1) {
      const stat = unlockedStats[0];
      if (remainingFinal < 0 || remainingFinal > 200) {
        return { feasible: false, ranges: {} };
      }
      finalTargets[stat] = remainingFinal;
    }
    const result = solveDenseTarget(finalTargets);
    if (!result) return { feasible: false, ranges: {} };
    return {
      feasible: true,
      ranges: Object.fromEntries(STATS.map(stat => {
        const value = finalTargets[stat];
        return [stat, { min: value, max: value, values: [value] }];
      })),
    };
  }

  const objective = unlockedStats[0];
  const companion = unlockedStats[1];
  const objectiveFloor = Math.max(0, fragments[objective] || 0);
  const companionFloor = Math.max(0, fragments[companion] || 0);
  const minimumGoal = Math.max(objectiveFloor, remainingFinal - 200);
  const maximumGoal = Math.min(200, remainingFinal - companionFloor);
  if (minimumGoal > maximumGoal) return { feasible: false, ranges: {} };
  const minimumTargets = {
    ...lockedTargets,
    [objective]: minimumGoal,
    [companion]: remainingFinal - minimumGoal,
  };
  const maximumTargets = {
    ...lockedTargets,
    [objective]: maximumGoal,
    [companion]: remainingFinal - maximumGoal,
  };
  const minimumResult = solveDenseTarget(minimumTargets, objective);
  const maximumResult = solveDenseTarget(maximumTargets, objective);
  const witnesses = [minimumResult, maximumResult].filter(Boolean);
  if (witnesses.length === 0) return { feasible: false, ranges: {} };

  const objectiveValues = witnesses.map(result =>
    result.totals[objective] + (fragments[objective] || 0)
  );
  const objectiveMin = Math.min(...objectiveValues);
  const objectiveMax = Math.max(...objectiveValues);
  const ranges = Object.fromEntries(lockedStats.map(stat => [
    stat, { min: lockedTargets[stat], max: lockedTargets[stat], values: [lockedTargets[stat]] },
  ]));
  ranges[objective] = {
    min: objectiveMin,
    max: objectiveMax,
    exactValuesKnown: false,
  };
  ranges[companion] = {
    min: remainingFinal - objectiveMax,
    max: remainingFinal - objectiveMin,
    exactValuesKnown: false,
  };
  return { feasible: true, ranges };
}

export function calculateReachableRanges(
  fixedPiece, numPlus5, numPlus10, numPlus3, fragments, lockedTargets
) {
  const fixedKey = STATS.map(stat => fixedPiece.baseStats[stat]).join(',');
  const fragmentKey = STATS.map(stat => fragments[stat] || 0).join(',');
  const lockKey = STATS
    .filter(stat => lockedTargets[stat] !== undefined)
    .map(stat => `${stat}:${lockedTargets[stat]}`)
    .join(',');
  const cacheKey = [
    fixedKey, numPlus5, numPlus10, numPlus3, fragmentKey, lockKey,
  ].join('|');
  const cached = reachableRangeCache.get(cacheKey);
  if (cached) return cached;

  const lockedStats = Object.keys(lockedTargets);
  if (lockedStats.length >= 4) {
    const result = calculateDenseLockRanges(
      fixedPiece, numPlus5, numPlus10, numPlus3, fragments, lockedTargets
    );
    reachableRangeCache.set(cacheKey, result);
    return result;
  }
  const unlockedStats = STATS.filter(stat => !lockedStats.includes(stat));
  const feasibilityProbe = calculateReachableStatRange(
    fixedPiece, numPlus5, numPlus10, numPlus3, fragments, lockedTargets,
    unlockedStats[0] || null
  );
  if (!feasibilityProbe) {
    const result = { feasible: false, ranges: {} };
    reachableRangeCache.set(cacheKey, result);
    return result;
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
      fixedPiece, numPlus5, numPlus10, numPlus3, fragments, lockedTargets, stat
    );
  }

  const result = { feasible: true, ranges };
  reachableRangeCache.set(cacheKey, result);
  if (reachableRangeCache.size > 24) {
    reachableRangeCache.delete(reachableRangeCache.keys().next().value);
  }
  return result;
}
