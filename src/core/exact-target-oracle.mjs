import { BASE_CONFIGS, STATS, getMasterworkStats } from "./armor-model.mjs";

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
const diagnostics = {cacheHits: 0, cacheMisses: 0, buildMs: 0};
export function getOracleDiagnostics() { return {...diagnostics}; }

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
  // The sixth coordinate is fixed by the conserved total at each DP layer.
  // Number arithmetic (not 32-bit bitwise packing) preserves the full key.
  return packAdjustment(values);
}

function buildShiftStates(count, checkpoint = null) {
  let states = new Map([["0,0,0,0,0", {
    values: [0, 0, 0, 0, 0],
    code: 0,
  }]]);

  for (let pieceIndex = 0; pieceIndex < count; pieceIndex++) {
    const next = new Map();
    for (const state of states.values()) {
      checkpoint?.(0);
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

function buildRestrictedShiftStates(targets, checkpoint = null) {
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
      checkpoint?.(0);
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

function buildAdjustmentIndexFromShiftStates(shiftStates, numPlus5, numPlus10, checkpoint = null) {
  const modifier = getModifierStates(numPlus5, numPlus10);
  // Zero means unreachable. Every stored witness is offset by one.
  const witnesses = new Int32Array(ADJUSTMENT_TABLE_SIZE);
  // Collect reachable keys while filling instead of scanning all ~4.08M slots
  // twice afterwards. The table is fill-once (the guard below skips any key
  // that already has a witness), so every key lands here exactly once.
  const reachedKeys = [];

  for (let shiftIndex = 0; shiftIndex < shiftStates.length; shiftIndex++) {
    checkpoint?.(0);
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
      reachedKeys.push(key);
    }
  }

  // The dense scan produced keys in ascending order and later queries rely on
  // that order (the first in-box key wins), so restore it explicitly.
  reachedKeys.sort((left, right) => left - right);
  const reachableCount = reachedKeys.length;
  const reachableKeys = new Int32Array(reachableCount);
  const reachableUnits = new Int8Array(reachableCount * STATS.length);
  for (let cursor = 0; cursor < reachableCount; cursor++) {
    const key = reachedKeys[cursor];
    reachableKeys[cursor] = key;
    const units = unpackAdjustment(key);
    units[5] = modifier.sizes.reduce((sum, size) => sum + size / 5, 0)
      - units.slice(0, 5).reduce((sum, value) => sum + value, 0);
    for (let statIndex = 0; statIndex < STATS.length; statIndex++) {
      reachableUnits[cursor * STATS.length + statIndex] = units[statIndex];
    }
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

// Shift states depend only on the number of shifted pieces; modifier states
// depend only on (numPlus5, numPlus10). Deriving both separately means asking
// for a new modifier budget no longer rebuilds the shift layer, and vice versa.
const MAX_DERIVED_STATE_CACHE_ENTRIES = 3;
const shiftStateCache = new Map();
const modifierStateCache = new Map();

function getShiftStates(count, checkpoint = null) {
  const cached = shiftStateCache.get(count);
  if (cached) {
    shiftStateCache.delete(count);
    shiftStateCache.set(count, cached);
    return cached;
  }
  const states = buildShiftStates(count, checkpoint);
  shiftStateCache.set(count, states);
  while (shiftStateCache.size > MAX_DERIVED_STATE_CACHE_ENTRIES) {
    shiftStateCache.delete(shiftStateCache.keys().next().value);
  }
  return states;
}

function getModifierStates(numPlus5, numPlus10) {
  const cacheKey = `${numPlus5}|${numPlus10}`;
  const cached = modifierStateCache.get(cacheKey);
  if (cached) {
    modifierStateCache.delete(cacheKey);
    modifierStateCache.set(cacheKey, cached);
    return cached;
  }
  const modifier = buildModifierStates(numPlus5, numPlus10);
  modifierStateCache.set(cacheKey, modifier);
  while (modifierStateCache.size > MAX_DERIVED_STATE_CACHE_ENTRIES) {
    modifierStateCache.delete(modifierStateCache.keys().next().value);
  }
  return modifier;
}

function buildAdjustmentIndex(shiftCount, numPlus5, numPlus10, checkpoint = null) {
  const index = buildAdjustmentIndexFromShiftStates(
    getShiftStates(shiftCount, checkpoint),
    numPlus5,
    numPlus10,
    checkpoint,
  );
  index.shiftCount = shiftCount;
  return index;
}

function buildSparseAdjustmentIndex(shiftStates, numPlus5, numPlus10, checkpoint = null) {
  const modifier = getModifierStates(numPlus5, numPlus10);
  const witnesses = new Map();
  for (let shiftIndex = 0; shiftIndex < shiftStates.length; shiftIndex++) {
    checkpoint?.(0);
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

function getAdjustmentIndex(shiftCount, numPlus5, numPlus10, checkpoint = null) {
  const cacheKey = `${shiftCount}|${numPlus5}|${numPlus10}`;
  const cached = adjustmentCache.get(cacheKey);
  if (cached) {
    diagnostics.cacheHits++;
    adjustmentCache.delete(cacheKey);
    adjustmentCache.set(cacheKey, cached);
    return cached;
  }

  diagnostics.cacheMisses++;
  const started = performance.now();
  const index = buildAdjustmentIndex(shiftCount, numPlus5, numPlus10, checkpoint);
  diagnostics.buildMs += performance.now() - started;
  adjustmentCache.set(cacheKey, index);
  while (adjustmentCache.size > MAX_ADJUSTMENT_CACHE_ENTRIES) {
    adjustmentCache.delete(adjustmentCache.keys().next().value);
  }
  return index;
}

const restrictedAdjustmentCache = new Map();
const MAX_RESTRICTED_ADJUSTMENT_CACHE_ENTRIES = 2;
const restrictedShiftStateCache = new Map();

function getRestrictedShiftStates(targets, checkpoint = null) {
  const cacheKey = targets.map(target => Array.isArray(target)
    ? `[${target.join(",")}]`
    : target || "*").join(";");
  const cached = restrictedShiftStateCache.get(cacheKey);
  if (cached) {
    restrictedShiftStateCache.delete(cacheKey);
    restrictedShiftStateCache.set(cacheKey, cached);
    return cached;
  }
  const states = buildRestrictedShiftStates(targets, checkpoint);
  restrictedShiftStateCache.set(cacheKey, states);
  while (restrictedShiftStateCache.size > MAX_RESTRICTED_ADJUSTMENT_CACHE_ENTRIES) {
    restrictedShiftStateCache.delete(restrictedShiftStateCache.keys().next().value);
  }
  return states;
}

function getRestrictedAdjustmentIndex(targets, numPlus5, numPlus10, checkpoint = null) {
  if (targets.every(target => target === undefined || target === null)) {
    return getAdjustmentIndex(targets.length, numPlus5, numPlus10, checkpoint);
  }
  const cacheKey = `${targets.map(target => Array.isArray(target)
    ? `[${target.join(",")}]`
    : target || "*").join(";")}|${numPlus5}|${numPlus10}`;
  const cached = restrictedAdjustmentCache.get(cacheKey);
  if (cached) {
    diagnostics.cacheHits++;
    restrictedAdjustmentCache.delete(cacheKey);
    restrictedAdjustmentCache.set(cacheKey, cached);
    return cached;
  }
  diagnostics.cacheMisses++;
  const started = performance.now();
  const index = buildSparseAdjustmentIndex(
    getRestrictedShiftStates(targets, checkpoint),
    numPlus5,
    numPlus10,
    checkpoint,
  );
  diagnostics.buildMs += performance.now() - started;
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

function queryAdjustmentBox(index, base, minimums, maximums, totalUnits, checkpoint) {
  const low = base.map((value, stat) => Math.max(-5, minimums[stat] === null ? -5 : Math.ceil((minimums[stat] - value) / 5)));
  const high = base.map((value, stat) => Math.min(15, maximums[stat] === null ? 15 : Math.floor((maximums[stat] - value) / 5)));
  if (low.some((value, stat) => value > high[stat])) return null;
  const volume = low.slice(0, 5).reduce((product, value, stat) => product * (high[stat] - value + 1), 1);
  if (volume <= index.reachableKeys.length) {
    const suffixLow = Array(7).fill(0), suffixHigh = Array(7).fill(0);
    for (let stat = 5; stat >= 0; stat--) {
      suffixLow[stat] = suffixLow[stat + 1] + low[stat];
      suffixHigh[stat] = suffixHigh[stat + 1] + high[stat];
    }
    const values = [];
    const visit = (stat, remaining) => {
      if (remaining < suffixLow[stat] || remaining > suffixHigh[stat]) return null;
      if (stat === 5) {
        checkpoint?.(0);
        values[5] = remaining;
        return getPackedWitness(index, packAdjustment(values)) ? [...values] : null;
      }
      for (let value = Math.max(low[stat], remaining - suffixHigh[stat + 1]);
        value <= Math.min(high[stat], remaining - suffixLow[stat + 1]); value++) {
        values[stat] = value;
        const result = visit(stat + 1, remaining - value);
        if (result) return result;
      }
      return null;
    };
    return visit(0, totalUnits);
  }
  for (let row = 0; row < index.reachableKeys.length; row++) {
    if ((row & 1023) === 0) checkpoint?.(0);
    const values = unpackAdjustment(index.reachableKeys[row]);
    values[5] = totalUnits - values.slice(0, 5).reduce((sum, value) => sum + value, 0);
    if (values.every((value, stat) => value >= low[stat] && value <= high[stat])) return values;
  }
  return null;
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

const pointShiftCache = new Map();
const pointModifierCache = new Map();

// Enumerate the preimage of a full visible target under clamp, intersected
// with the conserved armor budget. A single boundary reduces to one point.
// The caller must inspect complete before using a miss as negative evidence.
export function visibleArmorTargets(target, fragments, total, limit = 128) {
  const bounds = STATS.map(stat => {
    const visible = Number(target[stat]);
    const fragment = Number(fragments[stat] || 0);
    return visible === 0 ? [0, Math.min(total, -fragment)]
      : visible === 200 ? [Math.max(0, 200 - fragment), total]
      : [visible - fragment, visible - fragment];
  });
  const targets = [];
  let complete = true;
  if (!Number.isSafeInteger(total) || bounds.some(([min, max]) => !Number.isSafeInteger(min)
      || !Number.isSafeInteger(max) || min < 0 || max < min)) return {targets, complete};
  const suffixMin = Array(7).fill(0), suffixMax = Array(7).fill(0);
  for (let index = 5; index >= 0; index--) {
    suffixMin[index] = suffixMin[index + 1] + bounds[index][0];
    suffixMax[index] = suffixMax[index + 1] + bounds[index][1];
  }
  const values = [];
  const visit = (index, remaining) => {
    if (remaining < suffixMin[index] || remaining > suffixMax[index]) return;
    if (index === 6) {
      if (targets.length >= limit) { complete = false; return; }
      targets.push(Object.fromEntries(STATS.map((stat, i) => [stat, values[i]])));
      return;
    }
    const low = Math.max(bounds[index][0], remaining - suffixMax[index + 1]);
    const high = Math.min(bounds[index][1], remaining - suffixMin[index + 1]);
    for (let value = low; value <= high; value++) {
      values[index] = value;
      visit(index + 1, remaining - value);
      if (!complete) return;
    }
  };
  visit(0, total);
  return {targets, complete};
}

// Target-directed join: do not materialize every shift × mod pair for each
// owned capability pattern. The sixth coordinate follows from the total.
export function findFixedTargetWitness({configs, target, numPlus5, numPlus10, numPlus3 = null, tuningCapabilities, checkpoint = null}) {
  if (configs?.length !== 5 || tuningCapabilities?.length !== 5
      || !STATS.every(stat => Number.isSafeInteger(target?.[stat]))) return null;
  const modKey = `${numPlus5}|${numPlus10}`;
  if (!pointModifierCache.has(modKey)) pointModifierCache.set(modKey, buildModifierStates(numPlus5, numPlus10));
  const modifier = pointModifierCache.get(modKey);
  const base = STATS.map(stat => configs.reduce((sum, config) => sum + config.baseStats[stat], 0));
  const targetTotal = STATS.reduce((sum, stat) => sum + target[stat], 0);
  const count = (targetTotal - base.reduce((sum, value) => sum + value, 0)
    - numPlus5 * 5 - numPlus10 * 10) / 3;
  if (!Number.isInteger(count) || count < 0 || count > 5 || numPlus3 !== null && count !== numPlus3) return null;
  for (const {mask} of getMasks(5, count)) {
    checkpoint?.(0);
    const totals = [...base];
    const destinations = [];
    let allowed = true;
    for (let index = 0; index < 5; index++) {
      const capability = tuningCapabilities[index];
      if ((mask >> index) & 1) {
        const masterwork = getMasterworkStats(configs[index]);
        if (!capability.allowBalanced || !masterwork) { allowed = false; break; }
        for (const stat of masterwork) totals[STATS.indexOf(stat)]++;
      } else {
        if (!capability.allowedDirectionalStats?.length) { allowed = false; break; }
        destinations.push([...capability.allowedDirectionalStats].sort());
      }
    }
    if (!allowed) continue;
    const residual = STATS.map((stat, index) => (target[stat] - totals[index]) / 5);
    if (residual.some(value => !Number.isInteger(value) || value < -5 || value > 15)) continue;
    const key = JSON.stringify(destinations);
    let shift = pointShiftCache.get(key);
    if (!shift) {
      const states = buildRestrictedShiftStates(destinations, checkpoint);
      shift = {states, byVector: new Map(states.map((state, index) => [state.values.slice(0, 5).join(","), index]))};
      pointShiftCache.set(key, shift);
      if (pointShiftCache.size > 64) pointShiftCache.delete(pointShiftCache.keys().next().value);
    }
    for (let modIndex = 0; modIndex < modifier.states.length; modIndex++) {
      const mod = modifier.states[modIndex];
      const needed = residual.slice(0, 5).map((value, index) => value - mod.values[index]);
      const shiftIndex = shift.byVector.get(needed.join(","));
      if (shiftIndex === undefined) continue;
      return {totals: {...target}, ...materializeWitness(configs, mask, {
        shiftCount: destinations.length, shiftStates: shift.states,
        modifierStates: modifier.states, modifierSizes: modifier.sizes,
      }, shiftIndex * modifier.states.length + modIndex + 1)};
    }
  }
  return null;
}

export function findFixedRuleWitness({configs, numPlus5, numPlus10, numPlus3 = null, tuningCapabilities, minimums, maximums, checkpoint = null}) {
  const constrained = STATS.map((_, index) => index).filter(index => minimums[index] !== null || maximums[index] !== null);
  if (!constrained.length) return null;
  const modKey = `${numPlus5}|${numPlus10}`;
  if (!pointModifierCache.has(modKey)) pointModifierCache.set(modKey, buildModifierStates(numPlus5, numPlus10));
  const modifier = pointModifierCache.get(modKey);
  const units = numPlus5 + numPlus10 * 2;
  const modVectors = modifier.states.map(state => [...state.values, units - state.values.reduce((sum, value) => sum + value, 0)]);
  const projectedMods = new Map();
  modVectors.forEach((vector, index) => {
    const key = constrained.map(stat => vector[stat]).join(",");
    if (!projectedMods.has(key)) projectedMods.set(key, index);
  });
  for (let mask = 0; mask < 32; mask++) {
    if (numPlus3 !== null && getMasks(5, numPlus3).every(entry => entry.mask !== mask)) continue;
    checkpoint?.(0);
    const base = STATS.map(stat => configs.reduce((sum, config) => sum + config.baseStats[stat], 0));
    const destinations = [];
    let allowed = true;
    for (let index = 0; index < 5; index++) {
      if ((mask >> index) & 1) {
        if (!tuningCapabilities[index].allowBalanced) { allowed = false; break; }
        for (const stat of getMasterworkStats(configs[index])) base[STATS.indexOf(stat)]++;
      } else {
        if (!tuningCapabilities[index].allowedDirectionalStats?.length) { allowed = false; break; }
        destinations.push([...tuningCapabilities[index].allowedDirectionalStats].sort());
      }
    }
    const total = base.reduce((sum, value) => sum + value, 0) + units * 5;
    const minTotal = base.reduce((sum, value, index) => sum + Math.max(minimums[index] ?? -Infinity, value - destinations.length * 5), 0);
    const maxTotal = base.reduce((sum, value, index) => sum + Math.min(maximums[index] ?? Infinity, value + destinations.length * 5 + units * 5), 0);
    if (!allowed || total < minTotal || total > maxTotal
      || constrained.some(index => minimums[index] !== null && base[index] + 25 + units * 5 < minimums[index]
      || maximums[index] !== null && base[index] - 25 > maximums[index])) continue;
    const key = JSON.stringify(destinations);
    let shift = pointShiftCache.get(key);
    if (!shift) {
      const states = buildRestrictedShiftStates(destinations, checkpoint);
      shift = {states, byVector: new Map(states.map((state, index) => [state.values.slice(0, 5).join(","), index]))};
      pointShiftCache.set(key, shift);
      if (pointShiftCache.size > 64) pointShiftCache.delete(pointShiftCache.keys().next().value);
    }
    for (let shiftIndex = 0; shiftIndex < shift.states.length; shiftIndex++) {
      checkpoint?.(0);
      const values = shift.states[shiftIndex].values;
      for (const modIndex of projectedMods.values()) {
        const mod = modVectors[modIndex];
        if (constrained.some(index => {
          const value = base[index] + (values[index] + mod[index]) * 5;
          return minimums[index] !== null && value < minimums[index] || maximums[index] !== null && value > maximums[index];
        })) continue;
        return {totals: Object.fromEntries(STATS.map((stat, index) => [stat, base[index] + (values[index] + mod[index]) * 5])),
          ...materializeWitness(configs, mask, {shiftCount: destinations.length, shiftStates: shift.states,
            modifierStates: modifier.states, modifierSizes: modifier.sizes}, shiftIndex * modifier.states.length + modIndex + 1)};
      }
    }
  }
  return null;
}

export function findBestFixedConfigWitness({
  configs,
  target,
  numPlus5,
  numPlus10,
  numPlus3,
  fixedTuningTargets = null,
  tuningCapabilities = null,
  requiredNumPlus3 = null,
  rankTotals,
  compareRanks,
  checkpoint = null,
  onWitness = null,
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
    // With capabilities, legacy numPlus3 is only the fallback mode count.
    // Explicit inventory budgets use a separate constraint to preserve callers.
    if (Number.isInteger(requiredNumPlus3) && maskEntry.positions.length !== requiredNumPlus3) continue;
    checkpoint?.(0);
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
      ? getRestrictedAdjustmentIndex(shiftTargets, numPlus5, numPlus10, checkpoint)
      : getAdjustmentIndex(shiftPieceIndices.length, numPlus5, numPlus10, checkpoint);
    const modifierUnits = numPlus5 + numPlus10 * 2;

    for (const key of adjustmentIndex.reachableKeys) {
      checkpoint?.(0);
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
      onWitness?.(best);
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

function visitModeSelections(count, vectors, visit, canVisit = null) {
  if (count === 0) {
    visit({ indices: [], totals: STATS.map(() => 0) });
    return;
  }
  const indices = Array(count).fill(0);
  const totals = STATS.map(() => 0);
  const enumerate = (start, depth) => {
    if (canVisit && !canVisit(totals, count - depth)) return false;
    if (depth === count) {
      return visit({ indices: [...indices], totals: [...totals] }) === true;
    }
    for (let configIndex = start; configIndex < BASE_CONFIGS.length; configIndex++) {
      indices[depth] = configIndex;
      const vector = vectors[configIndex];
      for (let statIndex = 0; statIndex < STATS.length; statIndex++) {
        totals[statIndex] += vector[statIndex];
      }
      if (enumerate(configIndex, depth + 1)) return true;
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
  searchStats = {},
  checkpoint = null,
  onWitness = null,
}) {
  searchStats.statesExamined = 0;
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
      checkpoint,
    );
    const adjustmentValueSets = getAdjustmentValueSets(adjustmentIndex);
    if (!adjustmentIndex.pairValueSets) {
      const pairs = Array.from({length: 3}, () => new Map());
      for (let row = 0; row < adjustmentIndex.reachableKeys.length; row++) {
        if ((row & 1023) === 0) checkpoint?.(0);
        for (let pair = 0; pair < 3; pair++) {
          const a = adjustmentIndex.reachableUnits[row * 6 + pair * 2];
          const b = adjustmentIndex.reachableUnits[row * 6 + pair * 2 + 1];
          pairs[pair].set(`${a},${b}`, [a, b]);
        }
      }
      adjustmentIndex.pairValueSets = pairs.map(pair => [...pair.values()]);
    }
    const boundCache = new Map();
    const fixedTotals = STATS.map((_, statIndex) => {
      if (!fixed) return 0;
      return fixed.base[statIndex]
        + Number(fixedPlus3 && fixed.masterwork[statIndex]);
    });

    const inspect = (plus3, shift) => {
      searchStats.statesExamined++;
      if ((searchStats.statesExamined & 1023) === 0) checkpoint?.(1024);
      const baseTotals = fixedTotals.map((value, statIndex) =>
        value + plus3.totals[statIndex] + shift.totals[statIndex]);
      const lowerRank = lowerBoundRank(baseTotals, adjustmentValueSets);
      if (incumbentRank && compareRanks(lowerRank, incumbentRank) > 0) return;
      const baseKey = baseTotals.join(',');
      let jointRank = boundCache.get(baseKey);
      if (!jointRank) {
        jointRank = lowerBoundRank(baseTotals, adjustmentValueSets, adjustmentIndex.pairValueSets);
        if (boundCache.size >= 8192) boundCache.delete(boundCache.keys().next().value);
        boundCache.set(baseKey, jointRank);
      }
      if (incumbentRank && compareRanks(jointRank, incumbentRank) > 0) {
        searchStats.prunedJoint = (searchStats.prunedJoint || 0) + 1;
        return;
      }

      for (let row = 0; row < adjustmentIndex.reachableKeys.length; row++) {
        searchStats.statesExamined++;
        if ((searchStats.statesExamined & 1023) === 0) checkpoint?.(1024);
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
        onWitness?.(best);
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
  const masterworkStats = getMasterworkStats(config);
  return {
    config: {...config, masterworkStats},
    base: STATS.map(stat => Number(config.baseStats?.[stat]) || 0),
    masterwork: STATS.map(stat =>
      Number(masterworkStats?.includes(stat))),
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
  searchStats = {},
  onWitness = null,
  checkpoint = null,
}) {
  searchStats.statesExamined = 1; // Includes arithmetic/residue rejection.
  const normalizedTarget = STATS.map(stat => Number(target?.[stat]));
  if (normalizedTarget.some(value => !Number.isInteger(value))) return [];
  if (!Number.isInteger(numPlus3) || numPlus3 < 0 || numPlus3 > 5) return [];
  if (!Number.isInteger(numPlus5) || numPlus5 < 0 ||
      !Number.isInteger(numPlus10) || numPlus10 < 0 ||
      numPlus5 + numPlus10 > 5) return [];
  // Base armor, directional Tuning, and +5/+10 stat mods are all multiples of
  // five. With no +3 pieces, residue rejection is a complete O(1) proof and
  // avoids enumerating 2.6M five-config multisets for an impossible target.
  const fixed = normalizeFixedConfig(fixedConfig);
  if (numPlus3 === 0 && normalizedTarget.some((value, index) =>
    (value - (fixed?.base[index] || 0)) % 5 !== 0)) return [];
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
    checkpoint,
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
    const witness = {
      config: [...configs],
      ...materializeWitness(configs, mask, adjustmentIndex, packedWitness),
    };
    witnessesByGroup.set(groupKey, witness);
    onWitness?.(witness);
  };

  // When both modes are present, enumerating their multisets independently is
  // substantially cheaper than visiting each five-config multiset and all of
  // its C(5, numPlus3) masks. The two groups are still exhaustive because a
  // piece's base config may repeat independently in either Tuning mode.
  if (!fixed && numPlus3 > 0 && numPlus3 < 5) {
    const mask = (1 << numPlus3) - 1;
    // Directional bases and every adjustment are multiples of five. Filter
    // before the Cartesian product; preserve the surviving canonical order.
    const matchesResidue = selection => selection.totals.every((value, index) =>
      (normalizedTarget[index] - value) % 5 === 0);
    const inspectPair = (plus3, shift) => {
      searchStats.statesExamined++;
      if ((searchStats.statesExamined & 1023) === 0) checkpoint?.(1024);
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
      const plus3Selections = buildModeSelections(numPlus3, PLUS3_VECTORS).filter(matchesResidue);
      visitModeSelections(shiftCount, BASE_VECTORS, shift => {
        for (const plus3 of plus3Selections) inspectPair(plus3, shift);
      });
    } else {
      const shiftSelections = buildModeSelections(shiftCount, BASE_VECTORS);
      visitModeSelections(numPlus3, PLUS3_VECTORS, plus3 => {
        if (!matchesResidue(plus3)) return;
        for (const shift of shiftSelections) inspectPair(plus3, shift);
      });
    }
    return [...witnessesByGroup.values()];
  }

  const inspectSelection = () => {
    if ((searchStats.statesExamined & 1023) === 1) checkpoint?.(1024);
    for (const maskEntry of masks) {
      searchStats.statesExamined++;
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
  minimums = null,
  maximums = null,
  numPlus5,
  numPlus10,
  allowedFreePlus3Counts,
  maxWitnesses = 16,
  checkpoint = null,
}) {
  if (fixedEntries.length + freePieceCount !== 5) return [];
  const interval = Array.isArray(minimums) && Array.isArray(maximums);
  const normalizedTarget = interval ? null : STATS.map(stat => Number(target?.[stat]));
  if (!interval && normalizedTarget.some(value => !Number.isInteger(value))) return [];
  if (interval && (minimums.length !== 6 || maximums.length !== 6
    || [...minimums, ...maximums].some(value => value !== null && !Number.isSafeInteger(value)))) return [];
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
      if (!interval && normalizedTarget.reduce((sum, value) => sum + value, 0) !== expectedTotal) {
        continue;
      }
      if (interval && (minimums.every(value => value !== null) && minimums.reduce((a, b) => a + b, 0) > expectedTotal
        || maximums.every(value => value !== null) && maximums.reduce((a, b) => a + b, 0) < expectedTotal)) continue;
      let queryLow = minimums, queryHigh = maximums;
      if (interval) {
        // Intersect the box with physical extrema and the conserved total
        // before building any residual table. Fixed pieces may have real,
        // non-catalog (even negative) stats, so derive their envelope explicitly.
        const shifts = fixedSelection.shiftTargets.length + freeShiftCount;
        queryLow = STATS.map((_, i) => Math.max(minimums[i] ?? -Infinity,
          fixedSelection.baseTotals[i] + freePieceCount * Math.min(...BASE_VECTORS.map(v => v[i])) - shifts * 5));
        queryHigh = STATS.map((_, i) => Math.min(maximums[i] ?? Infinity,
          fixedSelection.baseTotals[i] + freePieceCount * Math.max(...BASE_VECTORS.map(v => v[i]))
          + freePlus3Count + shifts * 5 + modifierUnits * 5));
        const minTotal = queryLow.reduce((a, b) => a + b, 0), maxTotal = queryHigh.reduce((a, b) => a + b, 0);
        if (expectedTotal < minTotal || expectedTotal > maxTotal) continue;
        const low = queryLow, high = queryHigh;
        queryLow = low.map((value, i) => Math.max(value, expectedTotal - maxTotal + high[i]));
        queryHigh = high.map((value, i) => Math.min(value, expectedTotal - minTotal + low[i]));
        if (queryLow.some((value, i) => value > queryHigh[i])) continue;
      }
      const adjustmentIndex = getRestrictedAdjustmentIndex(
        [...fixedSelection.shiftTargets, ...Array(freeShiftCount).fill(undefined)],
        numPlus5,
        numPlus10,
        checkpoint,
      );

      const inspect = (plus3, shift) => {
        checkpoint?.();
        if (witnesses.length >= maxWitnesses) return true;
        const baseTotals = fixedSelection.baseTotals.map((value, statIndex) =>
          value + plus3.totals[statIndex] + shift.totals[statIndex]);
        let units = normalizedTarget?.map((value, statIndex) => {
          const residual = value - baseTotals[statIndex];
          return residual % 5 === 0 ? residual / 5 : Number.NaN;
        });
        if (interval) {
          // Reject the box against a conservative residual envelope before
          // probing its joint lattice; no enumeration of armor preimages.
          if (baseTotals.some((value, index) => value + 75 < queryLow[index]
            || value - 25 > queryHigh[index])) return;
          units = queryAdjustmentBox(adjustmentIndex, baseTotals, queryLow, queryHigh, modifierUnits, checkpoint);
          if (!units) return;
        }
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
          totals: interval ? Object.fromEntries(STATS.map((stat, index) => [stat, baseTotals[index] + units[index] * 5])) : { ...target },
          fixedCount: fixedEntries.length,
          fixedPlus3Count: fixedSelection.fixedPlus3Count,
          freePlus3Count,
          ...materializeWitness(configs, mask, adjustmentIndex, packedWitness),
        });
        return witnesses.length >= maxWitnesses;
      };

      const stream = (count, vectors, otherSelections, visit) => {
        const low = STATS.map((_, i) => Math.min(...vectors.map(vector => vector[i])));
        const high = STATS.map((_, i) => Math.max(...vectors.map(vector => vector[i])));
        const otherLow = STATS.map((_, i) => otherSelections ? Math.min(...otherSelections.map(selection => selection.totals[i])) : 0);
        const otherHigh = STATS.map((_, i) => otherSelections ? Math.max(...otherSelections.map(selection => selection.totals[i])) : 0);
        const shiftCount = fixedSelection.shiftTargets.length + freeShiftCount;
        visitModeSelections(count, vectors, visit, interval ? (running, remaining) => {
          checkpoint?.(0);
          return STATS.every((_, i) => fixedSelection.baseTotals[i] + running[i] + otherLow[i]
            + remaining * low[i] - shiftCount * 5 <= queryHigh[i]
            && fixedSelection.baseTotals[i] + running[i] + otherHigh[i] + remaining * high[i]
            + shiftCount * 5 + modifierUnits * 5 >= queryLow[i]);
        } : null);
      };

      if (freePlus3Count > 0 && freeShiftCount > 0) {
        const plus3Selections = buildModeSelections(freePlus3Count, PLUS3_VECTORS)
          .filter(selection => interval || selection.totals.every((value, index) =>
            (normalizedTarget[index] - fixedSelection.baseTotals[index] - value) % 5 === 0));
        stream(freeShiftCount, BASE_VECTORS, plus3Selections, shift => {
          for (const plus3 of plus3Selections) {
            if (inspect(plus3, shift)) return true;
          }
        });
      } else if (freePlus3Count > 0) {
        stream(freePlus3Count, PLUS3_VECTORS, null, plus3 =>
          inspect(plus3, { indices: [], totals: STATS.map(() => 0) }));
      } else {
        stream(freeShiftCount, BASE_VECTORS, null, shift =>
          inspect({ indices: [], totals: STATS.map(() => 0) }, shift));
      }
    }
    if (witnesses.length >= maxWitnesses) break;
  }
  return witnesses;
}
