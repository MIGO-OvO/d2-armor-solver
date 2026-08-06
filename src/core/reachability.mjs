import { BASE_CONFIGS, STATS } from "./armor-model.mjs";

const reachableRangeCache = new Map();

function cacheReachableRange(key, result) {
  reachableRangeCache.set(key, result);
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
  if (lockedStats.length >= 4) {
    const stateKey = (usedPlus3, lockValues) => {
      let key = usedPlus3;
      for (const value of lockValues) key = key * 256 + value;
      return key;
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
  fixedPiece, numPlus5, numPlus10, numPlus3, fragments, lockedTargets
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
    lockedTargets, objective
  );
  if (!probe) return { feasible: false, ranges: {} };
  if (unlockedStats.length === 0) return { feasible: true, ranges };
  ranges[objective] = probe;

  if (unlockedStats.length === 2) {
    const companion = unlockedStats[1];
    const totalArmor = 450 + numPlus3 * 3 + numPlus5 * 5 + numPlus10 * 10;
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
    return cacheReachableRange(cacheKey, result);
  }
  const unlockedStats = STATS.filter(stat => !lockedStats.includes(stat));
  const feasibilityProbe = calculateReachableStatRange(
    fixedPiece, numPlus5, numPlus10, numPlus3, fragments, lockedTargets,
    unlockedStats[0] || null
  );
  if (!feasibilityProbe) {
    const result = { feasible: false, ranges: {} };
    return cacheReachableRange(cacheKey, result);
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
  return cacheReachableRange(cacheKey, result);
}
