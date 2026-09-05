import { BASE_CONFIGS, STATS } from "./armor-model.mjs";

// The exact-target path is deliberately target-directed. Materializing the
// complete five-piece state space creates far more intermediate objects than
// the browser needs. Instead, enumerate the 48-config base multiset and probe
// a compact table containing every aggregate Tuning + stat-mod adjustment.

const ADJUSTMENT_MIN = -5;
const ADJUSTMENT_MAX = 15;
const ADJUSTMENT_RADIX = ADJUSTMENT_MAX - ADJUSTMENT_MIN + 1;
const ADJUSTMENT_TABLE_SIZE = ADJUSTMENT_RADIX ** 5;
const MAX_ADJUSTMENT_CACHE_ENTRIES = 2;

const adjustmentCache = new Map();

const BASE_VECTORS = BASE_CONFIGS.map(config =>
  STATS.map(stat => config.baseStats[stat]));
const MASTERWORK_VECTORS = BASE_CONFIGS.map(config =>
  STATS.map(stat => Number(config.masterworkStats.includes(stat))));
const PLUS3_VECTORS = BASE_VECTORS.map((vector, configIndex) =>
  vector.map((value, statIndex) =>
    value + MASTERWORK_VECTORS[configIndex][statIndex]));

const SHIFT_ACTIONS = [];
for (let from = 0; from < STATS.length; from++) {
  for (let to = 0; to < STATS.length; to++) {
    if (from === to) continue;
    const delta = STATS.map(() => 0);
    delta[from] = -1;
    delta[to] = 1;
    SHIFT_ACTIONS.push({ from, to, delta });
  }
}

function packAdjustment(values) {
  let key = 0;
  for (let index = 0; index < 5; index++) {
    const digit = values[index] - ADJUSTMENT_MIN;
    if (digit < 0 || digit >= ADJUSTMENT_RADIX) return -1;
    key = key * ADJUSTMENT_RADIX + digit;
  }
  return key;
}

function stateKey(values) {
  return values.join(",");
}

function buildShiftStates(count) {
  let states = new Map([["0,0,0,0,0", {
    values: [0, 0, 0, 0, 0],
    code: 0,
  }]]);

  for (let pieceIndex = 0; pieceIndex < count; pieceIndex++) {
    const next = new Map();
    for (const state of states.values()) {
      for (let actionIndex = 0; actionIndex < SHIFT_ACTIONS.length; actionIndex++) {
        const action = SHIFT_ACTIONS[actionIndex];
        const values = state.values.map((value, index) =>
          value + action.delta[index]);
        const key = stateKey(values);
        const code = state.code * SHIFT_ACTIONS.length + actionIndex;
        const existing = next.get(key);
        if (!existing || code < existing.code) next.set(key, { values, code });
      }
    }
    states = next;
  }

  return [...states.values()].sort((left, right) => left.code - right.code);
}

function buildRestrictedShiftStates(targets) {
  let states = new Map([["0,0,0,0,0,0", {
    values: [0, 0, 0, 0, 0, 0],
    code: 0,
  }]]);
  for (const target of targets) {
    const allowedTargets = Array.isArray(target)
      ? new Set(target.filter(stat => STATS.includes(stat)))
      : STATS.includes(target)
        ? new Set([target])
        : null;
    const next = new Map();
    for (const state of states.values()) {
      for (let actionIndex = 0; actionIndex < SHIFT_ACTIONS.length; actionIndex++) {
        const action = SHIFT_ACTIONS[actionIndex];
        if (allowedTargets && !allowedTargets.has(STATS[action.to])) continue;
        const values = state.values.map((value, index) =>
          value + action.delta[index]);
        const key = stateKey(values);
        const code = state.code * SHIFT_ACTIONS.length + actionIndex;
        const existing = next.get(key);
        if (!existing || code < existing.code) next.set(key, { values, code });
      }
    }
    states = next;
  }
  return [...states.values()].sort((left, right) => left.code - right.code);
}

function buildModifierStates(numPlus5, numPlus10) {
  const sizes = [
    ...Array(numPlus10).fill(10),
    ...Array(numPlus5).fill(5),
  ];
  let states = new Map([["0,0,0,0,0", {
    values: [0, 0, 0, 0, 0],
    code: 0,
  }]]);

  for (const size of sizes) {
    const units = size / 5;
    const next = new Map();
    for (const state of states.values()) {
      for (let statIndex = 0; statIndex < STATS.length; statIndex++) {
        const values = [...state.values];
        if (statIndex < 5) values[statIndex] += units;
        const key = stateKey(values);
        const code = state.code * STATS.length + statIndex;
        const existing = next.get(key);
        if (!existing || code < existing.code) next.set(key, { values, code });
      }
    }
    states = next;
  }

  return {
    sizes,
    states: [...states.values()].sort((left, right) => left.code - right.code),
  };
}

function buildAdjustmentIndexFromShiftStates(shiftStates, numPlus5, numPlus10) {
  const modifier = buildModifierStates(numPlus5, numPlus10);
  // Zero means unreachable. Every stored witness is offset by one.
  const witnesses = new Int32Array(ADJUSTMENT_TABLE_SIZE);

  for (let shiftIndex = 0; shiftIndex < shiftStates.length; shiftIndex++) {
    const shift = shiftStates[shiftIndex];
    for (let modifierIndex = 0;
      modifierIndex < modifier.states.length;
      modifierIndex++) {
      const mod = modifier.states[modifierIndex];
      const values = shift.values.map((value, index) =>
        value + mod.values[index]);
      const key = packAdjustment(values);
      if (key < 0 || witnesses[key] !== 0) continue;
      witnesses[key] = shiftIndex * modifier.states.length + modifierIndex + 1;
    }
  }

  let reachableCount = 0;
  for (let key = 0; key < witnesses.length; key++) {
    if (witnesses[key] !== 0) reachableCount++;
  }
  const reachableKeys = new Int32Array(reachableCount);
  const reachableUnits = new Int8Array(reachableCount * STATS.length);
  let cursor = 0;
  for (let key = 0; key < witnesses.length; key++) {
    if (witnesses[key] === 0) continue;
    reachableKeys[cursor] = key;
    const units = unpackAdjustment(key);
    units[5] = modifier.sizes.reduce((sum, size) => sum + size / 5, 0)
      - units.slice(0, 5).reduce((sum, value) => sum + value, 0);
    for (let statIndex = 0; statIndex < STATS.length; statIndex++) {
      reachableUnits[cursor * STATS.length + statIndex] = units[statIndex];
    }
    cursor++;
  }

  return {
    shiftCount: Math.max(0, ...shiftStates.map(state => {
      let code = state.code;
      let count = 0;
      while (code > 0) {
        code = Math.floor(code / SHIFT_ACTIONS.length);
        count++;
      }
      return count;
    })),
    shiftStates,
    modifierSizes: modifier.sizes,
    modifierStates: modifier.states,
    witnesses,
    reachableKeys,
    reachableUnits,
  };
}

function buildAdjustmentIndex(shiftCount, numPlus5, numPlus10) {
  const index = buildAdjustmentIndexFromShiftStates(
    buildShiftStates(shiftCount),
    numPlus5,
    numPlus10,
  );
  index.shiftCount = shiftCount;
  return index;
}

function buildSparseAdjustmentIndex(shiftStates, numPlus5, numPlus10) {
  const modifier = buildModifierStates(numPlus5, numPlus10);
  const witnesses = new Map();
  for (let shiftIndex = 0; shiftIndex < shiftStates.length; shiftIndex++) {
    const shift = shiftStates[shiftIndex];
    for (let modifierIndex = 0;
      modifierIndex < modifier.states.length;
      modifierIndex++) {
      const mod = modifier.states[modifierIndex];
      const values = shift.values.map((value, index) =>
        value + mod.values[index]);
      const key = packAdjustment(values);
      if (key < 0 || witnesses.has(key)) continue;
      witnesses.set(key, shiftIndex * modifier.states.length + modifierIndex + 1);
    }
  }
  return {
    shiftStates,
    modifierSizes: modifier.sizes,
    modifierStates: modifier.states,
    witnesses,
    reachableKeys: Int32Array.from([...witnesses.keys()].sort((left, right) => left - right)),
  };
}

function getAdjustmentIndex(shiftCount, numPlus5, numPlus10) {
  const cacheKey = `${shiftCount}|${numPlus5}|${numPlus10}`;
  const cached = adjustmentCache.get(cacheKey);
  if (cached) {
    adjustmentCache.delete(cacheKey);
    adjustmentCache.set(cacheKey, cached);
    return cached;
  }

  const index = buildAdjustmentIndex(shiftCount, numPlus5, numPlus10);
  adjustmentCache.set(cacheKey, index);
  while (adjustmentCache.size > MAX_ADJUSTMENT_CACHE_ENTRIES) {
    adjustmentCache.delete(adjustmentCache.keys().next().value);
  }
  return index;
}

const restrictedAdjustmentCache = new Map();
const MAX_RESTRICTED_ADJUSTMENT_CACHE_ENTRIES = 2;

function getRestrictedAdjustmentIndex(targets, numPlus5, numPlus10) {
  const cacheKey = `${targets.map(target => Array.isArray(target)
    ? `[${target.join(",")}]`
    : target || "*").join(";")}|${numPlus5}|${numPlus10}`;
  const cached = restrictedAdjustmentCache.get(cacheKey);
  if (cached) {
    restrictedAdjustmentCache.delete(cacheKey);
    restrictedAdjustmentCache.set(cacheKey, cached);
    return cached;
  }
  const index = buildSparseAdjustmentIndex(
    buildRestrictedShiftStates(targets),
    numPlus5,
    numPlus10,
  );
  index.shiftCount = targets.length;
  restrictedAdjustmentCache.set(cacheKey, index);
  while (restrictedAdjustmentCache.size > MAX_RESTRICTED_ADJUSTMENT_CACHE_ENTRIES) {
    restrictedAdjustmentCache.delete(restrictedAdjustmentCache.keys().next().value);
  }
  return index;
}

function getPackedWitness(index, key) {
  return index.witnesses instanceof Map
    ? index.witnesses.get(key) || 0
    : index.witnesses[key];
}

function unpackAdjustment(key) {
  const values = Array(6).fill(0);
  let remaining = key;
  for (let index = 4; index >= 0; index--) {
    values[index] = remaining % ADJUSTMENT_RADIX + ADJUSTMENT_MIN;
    remaining = Math.floor(remaining / ADJUSTMENT_RADIX);
  }
  return values;
}

function decodeDigits(code, length, radix) {
  const digits = Array(length).fill(0);
  for (let index = length - 1; index >= 0; index--) {
    digits[index] = code % radix;
    code = Math.floor(code / radix);
  }
  return digits;
}

function getMasks(pieceCount, selectedCount) {
  const masks = [];
  for (let mask = 0; mask < (1 << pieceCount); mask++) {
    const positions = [];
    for (let index = 0; index < pieceCount; index++) {
      if ((mask >> index) & 1) positions.push(index);
    }
    if (positions.length === selectedCount) masks.push({ mask, positions });
  }
  return masks;
}

function getArchetypeGroupKey(configs, hasFixedExotic) {
  const counts = new Map();
  for (let index = hasFixedExotic ? 1 : 0; index < configs.length; index++) {
    const id = configs[index].archetype;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const purple = [...counts.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([id, count]) => `${id}:${count}`)
    .join("|");
  return hasFixedExotic ? `exotic:${configs[0].archetype}|${purple}` : purple;
}

function materializeWitness(configs, mask, adjustmentIndex, packedWitness) {
  const witness = packedWitness - 1;
  const modifierCount = adjustmentIndex.modifierStates.length;
  const shiftIndex = Math.floor(witness / modifierCount);
  const modifierIndex = witness % modifierCount;
  const shiftState = adjustmentIndex.shiftStates[shiftIndex];
  const modifierState = adjustmentIndex.modifierStates[modifierIndex];
  const shiftDigits = decodeDigits(
    shiftState.code,
    adjustmentIndex.shiftCount,
    SHIFT_ACTIONS.length,
  );
  const modifierDigits = decodeDigits(
    modifierState.code,
    adjustmentIndex.modifierSizes.length,
    STATS.length,
  );

  const tuningAssignments = [];
  let shiftCursor = 0;
  for (let pieceIndex = 0; pieceIndex < configs.length; pieceIndex++) {
    if ((mask >> pieceIndex) & 1) {
      tuningAssignments.push({ mode: "+3", from: null, to: null });
      continue;
    }
    const action = SHIFT_ACTIONS[shiftDigits[shiftCursor++]];
    tuningAssignments.push({
      mode: "+5-5",
      from: STATS[action.from],
      to: STATS[action.to],
    });
  }

  const modAssignments = {};
  for (let pieceIndex = 0; pieceIndex < configs.length; pieceIndex++) {
    modAssignments[pieceIndex] = pieceIndex < modifierDigits.length
      ? {
        size: adjustmentIndex.modifierSizes[pieceIndex],
        stat: STATS[modifierDigits[pieceIndex]],
      }
      : null;
  }

  return { tuningAssignments, modAssignments };
}

export function findBestFixedConfigWitness({
  configs,
  target,
  numPlus5,
  numPlus10,
  numPlus3,
  fixedTuningTargets = null,
  tuningCapabilities = null,
  rankTotals,
  compareRanks,
}) {
  if (!Array.isArray(configs) || configs.length !== 5) return null;
  if (typeof rankTotals !== "function" || typeof compareRanks !== "function") return null;
  const masks = tuningCapabilities
    ? Array.from({ length: 32 }, (_, mask) => ({
      mask,
      positions: Array.from({ length: 5 }, (__, index) => index)
        .filter(index => (mask >> index) & 1),
    })).filter(({ mask }) => tuningCapabilities.every((capability, index) => {
      const balanced = Boolean((mask >> index) & 1);
      return balanced
        ? capability?.allowBalanced !== false
        : Array.isArray(capability?.allowedDirectionalStats)
          && capability.allowedDirectionalStats.some(stat => STATS.includes(stat));
    }))
    : fixedTuningTargets
    ? [{
      mask: fixedTuningTargets.reduce((mask, value, index) =>
        value === null ? mask | (1 << index) : mask, 0),
      positions: fixedTuningTargets
        .map((value, index) => value === null ? index : -1)
        .filter(index => index >= 0),
    }]
    : getMasks(5, numPlus3);
  let best = null;

  for (const maskEntry of masks) {
    const shiftPieceIndices = [];
    const shiftTargets = [];
    const baseTotals = STATS.map(() => 0);
    for (let pieceIndex = 0; pieceIndex < configs.length; pieceIndex++) {
      const config = configs[pieceIndex];
      for (let statIndex = 0; statIndex < STATS.length; statIndex++) {
        baseTotals[statIndex] += Number(config.baseStats?.[STATS[statIndex]]) || 0;
      }
      if ((maskEntry.mask >> pieceIndex) & 1) {
        for (const stat of config.masterworkStats || []) {
          baseTotals[STATS.indexOf(stat)] += 1;
        }
      } else {
        shiftPieceIndices.push(pieceIndex);
        shiftTargets.push(tuningCapabilities
          ? tuningCapabilities[pieceIndex].allowedDirectionalStats
          : fixedTuningTargets?.[pieceIndex]);
      }
    }
    const adjustmentIndex = fixedTuningTargets || tuningCapabilities
      ? getRestrictedAdjustmentIndex(shiftTargets, numPlus5, numPlus10)
      : getAdjustmentIndex(shiftPieceIndices.length, numPlus5, numPlus10);
    const modifierUnits = numPlus5 + numPlus10 * 2;

    for (const key of adjustmentIndex.reachableKeys) {
      const units = unpackAdjustment(key);
      units[5] = modifierUnits - units.slice(0, 5)
        .reduce((sum, value) => sum + value, 0);
      const totals = Object.fromEntries(STATS.map((stat, statIndex) => [
        stat,
        baseTotals[statIndex] + units[statIndex] * 5,
      ]));
      const rank = rankTotals(totals, target);
      if (best && compareRanks(rank, best.rank) >= 0) continue;
      const materialized = materializeWitness(
        configs,
        maskEntry.mask,
        adjustmentIndex,
        getPackedWitness(adjustmentIndex, key),
      );
      best = {
        totals,
        rank,
        ...materialized,
      };
    }
  }
  return best;
}

function getAdjustmentValueSets(index) {
  const sets = STATS.map(() => new Set());
  for (let row = 0; row < index.reachableKeys.length; row++) {
    const keyUnits = index.reachableUnits
      ? null
      : unpackAdjustment(index.reachableKeys[row]);
    if (keyUnits) {
      keyUnits[5] = index.modifierSizes.reduce((sum, size) => sum + size / 5, 0)
        - keyUnits.slice(0, 5).reduce((sum, value) => sum + value, 0);
    }
    for (let statIndex = 0; statIndex < STATS.length; statIndex++) {
      sets[statIndex].add(index.reachableUnits
        ? index.reachableUnits[row * STATS.length + statIndex]
        : keyUnits[statIndex]);
    }
  }
  return sets.map(set => [...set].sort((left, right) => left - right));
}

function visitModeSelections(count, vectors, visit) {
  if (count === 0) {
    visit({ indices: [], totals: STATS.map(() => 0) });
    return;
  }
  const indices = Array(count).fill(0);
  const totals = STATS.map(() => 0);
  const enumerate = (start, depth) => {
    if (depth === count) {
      visit({ indices: [...indices], totals: [...totals] });
      return;
    }
    for (let configIndex = start; configIndex < BASE_CONFIGS.length; configIndex++) {
      indices[depth] = configIndex;
      const vector = vectors[configIndex];
      for (let statIndex = 0; statIndex < STATS.length; statIndex++) {
        totals[statIndex] += vector[statIndex];
      }
      enumerate(configIndex, depth + 1);
      for (let statIndex = 0; statIndex < STATS.length; statIndex++) {
        totals[statIndex] -= vector[statIndex];
      }
    }
  };
  enumerate(0, 0);
}

export function findBestGlobalWitness({
  target,
  numPlus5,
  numPlus10,
  numPlus3,
  fixedConfig = null,
  rankTotals,
  lowerBoundRank,
  compareRanks,
  initialBest = null,
}) {
  if (typeof rankTotals !== "function" || typeof lowerBoundRank !== "function" ||
      typeof compareRanks !== "function") return initialBest;
  const fixed = normalizeFixedConfig(fixedConfig);
  const freePieceCount = fixed ? 4 : 5;
  let best = null;
  let incumbentRank = initialBest?.rank || null;

  for (const fixedPlus3 of fixed ? [false, true] : [false]) {
    const freePlus3 = numPlus3 - Number(fixedPlus3);
    if (freePlus3 < 0 || freePlus3 > freePieceCount) continue;
    const freeShift = freePieceCount - freePlus3;
    const shiftCount = 5 - numPlus3;
    const adjustmentIndex = getAdjustmentIndex(
      shiftCount,
      numPlus5,
      numPlus10,
    );
    const adjustmentValueSets = getAdjustmentValueSets(adjustmentIndex);
    const fixedTotals = STATS.map((_, statIndex) => {
      if (!fixed) return 0;
      return fixed.base[statIndex]
        + Number(fixedPlus3 && fixed.masterwork[statIndex]);
    });

    const inspect = (plus3, shift) => {
      const baseTotals = fixedTotals.map((value, statIndex) =>
        value + plus3.totals[statIndex] + shift.totals[statIndex]);
      const lowerRank = lowerBoundRank(baseTotals, adjustmentValueSets);
      if (incumbentRank && compareRanks(lowerRank, incumbentRank) > 0) return;

      for (let row = 0; row < adjustmentIndex.reachableKeys.length; row++) {
        const units = adjustmentIndex.reachableUnits;
        const totals = Object.fromEntries(STATS.map((stat, statIndex) => [
          stat,
          baseTotals[statIndex] + units[row * STATS.length + statIndex] * 5,
        ]));
        const rank = rankTotals(totals, target);
        if (incumbentRank && compareRanks(rank, incumbentRank) > 0) continue;
        if (best && compareRanks(rank, best.rank) >= 0) continue;
        const configs = [
          ...(fixed ? [fixed.config] : []),
          ...plus3.indices.map(index => BASE_CONFIGS[index]),
          ...shift.indices.map(index => BASE_CONFIGS[index]),
        ];
        let mask = 0;
        if (fixedPlus3) mask |= 1;
        const plus3Offset = Number(Boolean(fixed));
        for (let index = 0; index < plus3.indices.length; index++) {
          mask |= 1 << (plus3Offset + index);
        }
        best = {
          config: configs,
          totals,
          rank,
          ...materializeWitness(
            configs,
            mask,
            adjustmentIndex,
            adjustmentIndex.witnesses[adjustmentIndex.reachableKeys[row]],
          ),
          exoticIndex: fixed ? 0 : null,
        };
        incumbentRank = rank;
      }
    };

    // Mixed modes have at most 19,600 selections per side. Materialize one
    // side and stream the other so the largest five-piece (2.6M) selection set
    // is never retained in memory.
    if (freePlus3 > 0 && freeShift > 0) {
      if (freePlus3 <= freeShift) {
        const plus3Selections = buildModeSelections(freePlus3, PLUS3_VECTORS);
        visitModeSelections(freeShift, BASE_VECTORS, shift => {
          for (const plus3 of plus3Selections) inspect(plus3, shift);
        });
      } else {
        const shiftSelections = buildModeSelections(freeShift, BASE_VECTORS);
        visitModeSelections(freePlus3, PLUS3_VECTORS, plus3 => {
          for (const shift of shiftSelections) inspect(plus3, shift);
        });
      }
    } else if (freePlus3 > 0) {
      visitModeSelections(freePlus3, PLUS3_VECTORS, plus3 =>
        inspect(plus3, { indices: [], totals: STATS.map(() => 0) }));
    } else {
      visitModeSelections(freeShift, BASE_VECTORS, shift =>
        inspect({ indices: [], totals: STATS.map(() => 0) }, shift));
    }
  }
  return best || initialBest;
}

function normalizeFixedConfig(config) {
  if (!config) return null;
  return {
    config,
    base: STATS.map(stat => Number(config.baseStats?.[stat]) || 0),
    masterwork: STATS.map(stat =>
      Number(config.masterworkStats?.includes(stat))),
  };
}

function buildModeSelections(count, vectors) {
  if (count === 0) return [{ indices: [], totals: STATS.map(() => 0) }];
  const selections = [];
  const indices = Array(count).fill(0);
  const totals = STATS.map(() => 0);
  const enumerate = (start, depth) => {
    if (depth === count) {
      selections.push({ indices: [...indices], totals: [...totals] });
      return;
    }
    for (let configIndex = start; configIndex < BASE_CONFIGS.length; configIndex++) {
      indices[depth] = configIndex;
      const vector = vectors[configIndex];
      for (let statIndex = 0; statIndex < STATS.length; statIndex++) {
        totals[statIndex] += vector[statIndex];
      }
      enumerate(configIndex, depth + 1);
      for (let statIndex = 0; statIndex < STATS.length; statIndex++) {
        totals[statIndex] -= vector[statIndex];
      }
    }
  };
  enumerate(0, 0);
  return selections;
}

export function findExactTargetWitnesses({
  target,
  numPlus5,
  numPlus10,
  numPlus3,
  fixedConfig = null,
}) {
  const normalizedTarget = STATS.map(stat => Number(target?.[stat]));
  if (normalizedTarget.some(value => !Number.isInteger(value))) return [];
  if (!Number.isInteger(numPlus3) || numPlus3 < 0 || numPlus3 > 5) return [];
  if (!Number.isInteger(numPlus5) || numPlus5 < 0 ||
      !Number.isInteger(numPlus10) || numPlus10 < 0 ||
      numPlus5 + numPlus10 > 5) return [];
  // Base armor, directional Tuning, and +5/+10 stat mods are all multiples of
  // five. With no +3 pieces, residue rejection is a complete O(1) proof and
  // avoids enumerating 2.6M five-config multisets for an impossible target.
  if (numPlus3 === 0 && normalizedTarget.some(value => value % 5 !== 0)) return [];

  const fixed = normalizeFixedConfig(fixedConfig);
  const baseTotal = fixed
    ? fixed.base.reduce((sum, value) => sum + value, 0) + 4 * 90
    : 5 * 90;
  const expectedTotal = baseTotal
    + numPlus3 * 3 + numPlus5 * 5 + numPlus10 * 10;
  const targetTotal = normalizedTarget.reduce((sum, value) => sum + value, 0);
  if (targetTotal !== expectedTotal) return [];

  const freePieceCount = fixed ? 4 : 5;
  const masks = getMasks(5, numPlus3);
  const adjustmentIndex = getAdjustmentIndex(
    5 - numPlus3,
    numPlus5,
    numPlus10,
  );
  const modifierUnits = numPlus5 + numPlus10 * 2;
  const selected = Array(freePieceCount).fill(0);
  const runningBaseTotals = fixed ? [...fixed.base] : STATS.map(() => 0);
  const witnessesByGroup = new Map();

  const recordWitness = (configIndices, mask, packedWitness) => {
    const configs = fixed
      ? [fixed.config, ...configIndices.map(index => BASE_CONFIGS[index])]
      : configIndices.map(index => BASE_CONFIGS[index]);
    const groupKey = getArchetypeGroupKey(configs, Boolean(fixed));
    if (witnessesByGroup.has(groupKey)) return;
    witnessesByGroup.set(groupKey, {
      config: [...configs],
      ...materializeWitness(configs, mask, adjustmentIndex, packedWitness),
    });
  };

  // When both modes are present, enumerating their multisets independently is
  // substantially cheaper than visiting each five-config multiset and all of
  // its C(5, numPlus3) masks. The two groups are still exhaustive because a
  // piece's base config may repeat independently in either Tuning mode.
  if (!fixed && numPlus3 > 0 && numPlus3 < 5) {
    const mask = (1 << numPlus3) - 1;
    const inspectPair = (plus3, shift) => {
      const residuals = normalizedTarget.map((value, statIndex) =>
        value - plus3.totals[statIndex] - shift.totals[statIndex]);
      if (residuals.some(value => value % 5 !== 0)) return;
      const units = residuals.map(value => value / 5);
      if (units[5] !== modifierUnits - units.slice(0, 5)
        .reduce((sum, value) => sum + value, 0)) return;
      const adjustmentKey = packAdjustment(units);
      if (adjustmentKey < 0) return;
      const packedWitness = adjustmentIndex.witnesses[adjustmentKey];
      if (!packedWitness) return;
      recordWitness(
        [...plus3.indices, ...shift.indices],
        mask,
        packedWitness,
      );
    };
    const shiftCount = 5 - numPlus3;
    if (numPlus3 <= shiftCount) {
      const plus3Selections = buildModeSelections(numPlus3, PLUS3_VECTORS);
      visitModeSelections(shiftCount, BASE_VECTORS, shift => {
        for (const plus3 of plus3Selections) inspectPair(plus3, shift);
      });
    } else {
      const shiftSelections = buildModeSelections(shiftCount, BASE_VECTORS);
      visitModeSelections(numPlus3, PLUS3_VECTORS, plus3 => {
        for (const shift of shiftSelections) inspectPair(plus3, shift);
      });
    }
    return [...witnessesByGroup.values()];
  }

  const inspectSelection = () => {
    for (const maskEntry of masks) {
      const units = STATS.map((_, statIndex) => {
        let value = normalizedTarget[statIndex] - runningBaseTotals[statIndex];
        for (const pieceIndex of maskEntry.positions) {
          const masterwork = fixed && pieceIndex === 0
            ? fixed.masterwork
            : MASTERWORK_VECTORS[selected[pieceIndex - Number(Boolean(fixed))]];
          value -= masterwork[statIndex];
        }
        return value % 5 === 0 ? value / 5 : Number.NaN;
      });
      if (units.some(value => !Number.isInteger(value))) continue;
      if (units[5] !== modifierUnits - units.slice(0, 5)
        .reduce((sum, value) => sum + value, 0)) continue;
      const adjustmentKey = packAdjustment(units);
      if (adjustmentKey < 0) continue;
      const packedWitness = adjustmentIndex.witnesses[adjustmentKey];
      if (!packedWitness) continue;

      // Base configs, masks, shift states, and modifier states are all visited
      // in canonical order, so the first witness for a presentation group is
      // its deterministic representative.
      recordWitness(selected, maskEntry.mask, packedWitness);
    }
  };

  const enumerate = (start, depth) => {
    if (depth === freePieceCount) {
      inspectSelection();
      return;
    }
    for (let configIndex = start; configIndex < BASE_CONFIGS.length; configIndex++) {
      selected[depth] = configIndex;
      const vector = BASE_VECTORS[configIndex];
      for (let statIndex = 0; statIndex < STATS.length; statIndex++) {
        runningBaseTotals[statIndex] += vector[statIndex];
      }
      enumerate(configIndex, depth + 1);
      for (let statIndex = 0; statIndex < STATS.length; statIndex++) {
        runningBaseTotals[statIndex] -= vector[statIndex];
      }
    }
  };
  enumerate(0, 0);

  return [...witnessesByGroup.values()];
}

export function findExactPartialConfigWitnesses({
  fixedEntries = [],
  freePieceCount,
  target,
  numPlus5,
  numPlus10,
  allowedFreePlus3Counts,
  maxWitnesses = 16,
}) {
  if (fixedEntries.length + freePieceCount !== 5) return [];
  const normalizedTarget = STATS.map(stat => Number(target?.[stat]));
  if (normalizedTarget.some(value => !Number.isInteger(value))) return [];
  const modifierUnits = numPlus5 + numPlus10 * 2;
  const fixedBaseOnly = STATS.map(() => 0);
  for (const entry of fixedEntries) {
    const config = entry.config;
    for (let statIndex = 0; statIndex < STATS.length; statIndex++) {
      fixedBaseOnly[statIndex] += Number(config?.baseStats?.[STATS[statIndex]]) || 0;
    }
  }

  const witnesses = [];
  const seen = new Set();
  const counts = [...new Set(allowedFreePlus3Counts || [])]
    .filter(count => Number.isInteger(count) && count >= 0 && count <= freePieceCount)
    .sort((left, right) => left - right);
  const fixedModeSelections = [];
  for (let mask = 0; mask < (1 << fixedEntries.length); mask++) {
    let allowed = true;
    const baseTotals = [...fixedBaseOnly];
    const shiftTargets = [];
    let fixedPlus3Count = 0;
    for (let index = 0; index < fixedEntries.length; index++) {
      const entry = fixedEntries[index];
      const balanced = Boolean((mask >> index) & 1);
      const allowBalanced = entry.allowBalanced ?? entry.tuningMode === "plus3";
      const allowedDirectionalStats = Array.isArray(entry.allowedDirectionalStats)
        ? entry.allowedDirectionalStats.filter(stat => STATS.includes(stat))
        : STATS.includes(entry.tuningTo) ? [entry.tuningTo] : [];
      if (balanced) {
        if (!allowBalanced) {
          allowed = false;
          break;
        }
        fixedPlus3Count++;
        for (const stat of entry.config.masterworkStats || []) {
          baseTotals[STATS.indexOf(stat)] += 1;
        }
      } else {
        if (allowedDirectionalStats.length === 0) {
          allowed = false;
          break;
        }
        shiftTargets.push(allowedDirectionalStats);
      }
    }
    if (allowed) fixedModeSelections.push({
      mask,
      baseTotals,
      shiftTargets,
      fixedPlus3Count,
    });
  }

  for (const fixedSelection of fixedModeSelections) {
    for (const freePlus3Count of counts) {
      if (witnesses.length >= maxWitnesses) break;
      const freeShiftCount = freePieceCount - freePlus3Count;
      const expectedTotal = fixedSelection.baseTotals
        .reduce((sum, value) => sum + value, 0)
        + freePieceCount * 90
        + freePlus3Count * 3
        + numPlus5 * 5
        + numPlus10 * 10;
      if (normalizedTarget.reduce((sum, value) => sum + value, 0) !== expectedTotal) {
        continue;
      }
      const adjustmentIndex = getRestrictedAdjustmentIndex(
        [...fixedSelection.shiftTargets, ...Array(freeShiftCount).fill(undefined)],
        numPlus5,
        numPlus10,
      );

      const inspect = (plus3, shift) => {
        if (witnesses.length >= maxWitnesses) return;
        const baseTotals = fixedSelection.baseTotals.map((value, statIndex) =>
          value + plus3.totals[statIndex] + shift.totals[statIndex]);
        const units = normalizedTarget.map((value, statIndex) => {
          const residual = value - baseTotals[statIndex];
          return residual % 5 === 0 ? residual / 5 : Number.NaN;
        });
        if (units.some(value => !Number.isInteger(value))) return;
        if (units[5] !== modifierUnits - units.slice(0, 5)
          .reduce((sum, value) => sum + value, 0)) return;
        const key = packAdjustment(units);
        if (key < 0) return;
        const packedWitness = getPackedWitness(adjustmentIndex, key);
        if (!packedWitness) return;

        const configs = [
          ...fixedEntries.map(entry => entry.config),
          ...plus3.indices.map(index => BASE_CONFIGS[index]),
          ...shift.indices.map(index => BASE_CONFIGS[index]),
        ];
        let mask = fixedSelection.mask;
        for (let index = 0; index < plus3.indices.length; index++) {
          mask |= 1 << (fixedEntries.length + index);
        }
        const groupKey = [
          fixedSelection.mask,
          freePlus3Count,
          ...plus3.indices,
          "|",
          ...shift.indices,
        ].join(":");
        if (seen.has(groupKey)) return;
        seen.add(groupKey);
        witnesses.push({
          config: configs,
          totals: { ...target },
          fixedCount: fixedEntries.length,
          fixedPlus3Count: fixedSelection.fixedPlus3Count,
          freePlus3Count,
          ...materializeWitness(configs, mask, adjustmentIndex, packedWitness),
        });
      };

      if (freePlus3Count > 0 && freeShiftCount > 0) {
        const plus3Selections = buildModeSelections(freePlus3Count, PLUS3_VECTORS);
        visitModeSelections(freeShiftCount, BASE_VECTORS, shift => {
          for (const plus3 of plus3Selections) {
            inspect(plus3, shift);
            if (witnesses.length >= maxWitnesses) return;
          }
        });
      } else if (freePlus3Count > 0) {
        visitModeSelections(freePlus3Count, PLUS3_VECTORS, plus3 =>
          inspect(plus3, { indices: [], totals: STATS.map(() => 0) }));
      } else {
        visitModeSelections(freeShiftCount, BASE_VECTORS, shift =>
          inspect({ indices: [], totals: STATS.map(() => 0) }, shift));
      }
    }
    if (witnesses.length >= maxWitnesses) break;
  }
  return witnesses;
}
