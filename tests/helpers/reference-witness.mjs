// Test-only reference: no production normalizers, evaluators, verifier,
// residual tables, memoization, pruning or search imports.
import { ARCHETYPES, STATS } from "../../src/core/armor-model.mjs";

export const SLOTS = ["helmet", "arms", "chest", "legs", "classItem"];
export const ZERO = Object.fromEntries(STATS.map(stat => [stat, 0]));
export function seeded(seed) {
  let state = seed >>> 0;
  return n => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) % n);
}

export function rebuildReference(pieces, tuning, mods, fragments = ZERO) {
  const armor = { ...ZERO };
  pieces.forEach((piece, index) => {
    const base = piece.effectiveBaseStats || piece.baseStats;
    for (const stat of STATS) armor[stat] += base[stat];
    const action = tuning[index];
    if (action.mode === "+3") {
      const frame = ARCHETYPES.find(a => a.id === (piece.archetype || piece.archetypeId));
      for (const stat of STATS) if (![frame.primary, frame.secondary, piece.tertiary].includes(stat)) armor[stat]++;
    } else if (action.mode === "+5-5") {
      armor[action.from] -= 5;
      armor[action.to] += 5;
    } else if (action.mode !== "none") throw new Error("unknown reference assignment");
    if (mods[index]) armor[mods[index].stat] += mods[index].size;
  });
  return { armor, visible: Object.fromEntries(STATS.map(stat =>
    [stat, Math.max(0, Math.min(200, armor[stat] + (fragments[stat] || 0)))])) };
}

export function legalReference(totals, target, constraints = {}, fragments = ZERO) {
  return STATS.every(stat => {
    const value = totals[stat];
    if (constraints.exact?.[stat] && value !== target[stat]) return false;
    if (constraints.force0?.[stat] && value !== 0) return false;
    if (constraints.le100?.[stat] && value > 100) return false;
    if (constraints.minimums?.[stat] !== undefined && value < constraints.minimums[stat] + (fragments[stat] || 0)) return false;
    if (constraints.maximums?.[stat] !== undefined && value > constraints.maximums[stat] + (fragments[stat] || 0)) return false;
    return true;
  });
}

// Exactly the declared tiny domain; integer tuple ranking, written without
// production scoring helpers. Fixtures use six exact rules plus optional bounds.
function rankReference(totals, target, constraints, fragments) {
  const result = Array(9).fill(0);
  STATS.forEach(s => {
    const clamp = value => Math.max(0, Math.min(200, value));
    const explicitLow = constraints.minimums?.[s];
    const explicitHigh = constraints.maximums?.[s];
    let low = explicitLow === undefined ? explicitHigh === undefined && !constraints.force0?.[s]
      && !constraints.le100?.[s] ? target[s] : -Infinity : clamp(explicitLow + (fragments[s] || 0));
    let high = explicitHigh === undefined ? Infinity : clamp(explicitHigh + (fragments[s] || 0));
    if (constraints.exact?.[s]) { low = Math.max(low, target[s]); high = Math.min(high, target[s]); }
    if (constraints.force0?.[s]) { low = Math.max(low, 0); high = Math.min(high, 0); }
    if (constraints.le100?.[s]) high = Math.min(high, 100);
    const gap = Math.max(0, low - totals[s]) + Math.max(0, totals[s] - high);
    const order = constraints.priorityOrder?.indexOf(s) ?? -1;
    const level = constraints.priorityLevels?.[s] || (order >= 0 ? Math.min(3, order + 1) : constraints.priorities?.[s] ? 1 : 0);
    const index = level ? 1 + (level - 1) * 2 : 7;
    if (gap > 0) {
      if (constraints.exact?.[s] || constraints.force0?.[s] || constraints.le100?.[s]
          || explicitLow !== undefined || explicitHigh !== undefined) result[0] = 1;
      result[index]++; result[index + 1] += gap;
    }
  });
  return result;
}
export function compareReference(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

export function exhaustiveInventory({items, target, fragments = ZERO, constraints = {}, setRequirement = {type: "none"}, reassign = false}) {
  let best = null;
  let feasible = false;
  let exact = false;
  let examined = 0;
  const chosen = [];
  const inspect = (tuning, mods) => {
    examined++;
    const rebuilt = rebuildReference(chosen, tuning, mods, fragments);
    const rank = rankReference(rebuilt.visible, target, constraints, fragments);
    const key = chosen.map(p => `${p.slot}:${p.id}`).sort().join("|");
    feasible ||= legalReference(rebuilt.visible, target, constraints, fragments);
    exact ||= STATS.every(s => rebuilt.visible[s] === target[s]);
    if (!best || compareReference(rank, best.rank) < 0 || compareReference(rank, best.rank) === 0 && key < best.key) {
      best = {rank, key, totals: rebuilt.visible, pieces: [...chosen]};
    }
  };
  const visitAssignment = (index, tuning, mods) => {
    if (index === 5) { inspect(tuning, mods); return; }
    const p = chosen[index];
    const tunings = reassign ? [{mode: 'none', from: null, to: null}, {mode: "+3", from: null, to: null}, ...(p.allowedTuningStats || []).flatMap(to =>
      STATS.filter(from => from !== to).map(from => ({mode: "+5-5", from, to})))]
      : [p.tuningMode === 'none' || p.tuningInstalled === false ? {mode: 'none', from: null, to: null}
        : p.tuningMode === "plus3" ? {mode: "+3", from: null, to: null} : {mode: "+5-5", from: p.tuningFrom, to: p.tuningTo}];
    const statMods = !p.armorModSize ? [null] : (reassign ? STATS : [p.armorModStat]).map(stat => ({size: p.armorModSize, stat}));
    for (const action of tunings) for (const mod of statMods) visitAssignment(index + 1, [...tuning, action], [...mods, mod]);
  };
  const visit = index => {
    if (index === 5) {
      if (chosen.filter(p => p.exotic).length > 1) return;
      const count = hash => chosen.filter(p => p.setHash === hash).length;
      if (setRequirement.type === "set" && count(setRequirement.setHash) < setRequirement.count) return;
      if (setRequirement.type === "split" && (setRequirement.a === setRequirement.b || count(setRequirement.a) < 2 || count(setRequirement.b) < 2)) return;
      visitAssignment(0, [], []);
      return;
    }
    for (const p of items.filter(p => p.slot === SLOTS[index])) { chosen[index] = p; visit(index + 1); }
  };
  visit(0);
  return {best, feasible, exact, examined};
}
