// ============================================================
// PLAN MACRO-EQUIVALENCE (Inventory Planner scope only)
// ============================================================
// A Solver V3 theory witness binds framework, tertiary stat, base stats,
// Tuning and Armor Mods to concrete config indexes. Mathematically only the
// *macro* invariants of a five-piece plan matter:
//
//   total stats = Σ pinned bases
//               + Σ_movable f(archetype, tertiary)   (f = frame distribution)
//               + Σ directional (from, to) shifts
//               + Σ +3 masterwork contributions
//               + Σ armor mods
//
// For a T5 legendary, f(archetype, tertiary) = 5·allStats + 25·primary
// + 20·secondary + 15·tertiary, so the movable base contribution depends only
// on the archetype multiset and the tertiary multiset — never on how the two
// are legally paired, nor on which physical slot wears them. This module
// extracts those invariants as a `PlanMacroProfile` and compares two witnesses
// for macro equivalence.
//
// Scope guard: this identity is INDEPENDENT of Solver V3 `createCanonicalId`,
// the global `mathEquivalenceKey` and witness certificates. Those remain the
// canonical representation of a single concrete plan; a macro profile instead
// describes the whole equivalence class of inventories that realize a plan.

import { STATS, normalizeArchetypeId } from "./armor-model.mjs";
import { getArchetypeDefinition } from "./terminology.mjs";
import { stableSerialize } from "./solver-v3-contract.mjs";

export const PLAN_EQUIVALENCE_SCHEMA_VERSION = 1;

const PLAN_SLOTS = Object.freeze(["helmet", "arms", "chest", "legs", "classItem"]);

// A tertiary is legal for a framework only when it is neither the archetype's
// primary nor its secondary stat. Everything else in the frame distribution
// follows from (archetype, tertiary).
export function isLegalFrameworkTertiaryPair(archetype, tertiary) {
  const definition = getArchetypeDefinition(archetype);
  if (!definition || !STATS.includes(tertiary)) return false;
  return tertiary !== definition.primary && tertiary !== definition.secondary;
}

// The physical slot each config occupies. Sealed witnesses carry explicit
// slots; raw theory witnesses fall back to the canonical default order, where
// an Exotic Class Item config sits at classItem and the legendaries fill the
// four legendary slots in config order.
export function resolvePlanSlots(solution) {
  const config = solution?.config || [];
  const exoticIndex = solution?.exoticIndex ?? null;
  const hasExoticClassItem = exoticIndex !== null && exoticIndex !== undefined;
  let legendaryIndex = 0;
  return config.map((piece, index) => {
    if (piece?.slot) return piece.slot;
    if (hasExoticClassItem && index === exoticIndex) return "classItem";
    if (hasExoticClassItem) return PLAN_SLOTS[legendaryIndex++];
    return PLAN_SLOTS[index];
  });
}

function getConfigArchetypeId(config) {
  return normalizeArchetypeId(config?.archetype || config?.archetypeId);
}

// Per-config roles for profile extraction. A config is pinned when its
// physical identity is a hard constraint:
//   * the Exotic Class Item config (exoticIndex),
//   * any config flagged exotic (a fixed regular Exotic or a planned farm
//     Exotic in a re-sealed witness),
//   * a config bound to a concrete owned piece via sourceId,
//   * the config occupying the requested fixed-Exotic slot.
// Everything else is a movable legendary whose framework/tertiary only
// contribute to the multisets.
export function getPlanPieceRoles(solution, fixedExotic) {
  const slots = resolvePlanSlots(solution);
  return (solution?.config || []).map((config, index) => {
    const slot = slots[index];
    const exoticSlot = fixedExotic && slot === fixedExotic.slot;
    const isExoticSlot = solution?.exoticIndex === index || Boolean(config?.exotic) || Boolean(exoticSlot);
    return {
      index,
      slot,
      exotic: isExoticSlot,
      pinned: isExoticSlot || Boolean(config?.sourceId),
      sourceId: config?.sourceId || null,
    };
  });
}

function toCountEntries(keys) {
  const counts = new Map();
  for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
  return [...counts.entries()].sort((left, right) =>
    String(left[0]).localeCompare(String(right[0])) || left[1] - right[1]);
}

function movableConfigs(solution, fixedExotic) {
  const roles = getPlanPieceRoles(solution, fixedExotic);
  return (solution?.config || []).filter((_, index) => !roles[index].pinned);
}

// The multiset of movable framework archetypes, e.g. [["Bulwark", 3],
// ["Specialist", 2]]. Independent of config order, physical slots and pairing.
export function getFrameworkMultiset(solution, { fixedExotic = null } = {}) {
  return toCountEntries(movableConfigs(solution, fixedExotic)
    .map(getConfigArchetypeId).filter(Boolean));
}

// The multiset of movable tertiary stats. Tertiaries may be re-paired onto any
// framework as long as each pair is legal (see isLegalFrameworkTertiaryPair).
export function getTertiaryMultiset(solution, { fixedExotic = null } = {}) {
  return toCountEntries(movableConfigs(solution, fixedExotic)
    .map(config => config?.tertiary).filter(stat => STATS.includes(stat)));
}

function readModAssignments(solution) {
  const mods = solution?.modAssignments || solution?.evaluation?.modAssignments;
  if (!mods) return [];
  return [0, 1, 2, 3, 4].map(index => mods[index] ?? mods[String(index)] ?? null);
}

// Armor mods are globally redistributable: only the (size, stat) multiset is
// invariant. Which piece currently hosts a mod is execution state.
export function getArmorModMultiset(solution) {
  return toCountEntries(readModAssignments(solution)
    .filter(mod => mod && [5, 10].includes(Number(mod.size)) && STATS.includes(mod.stat))
    .map(mod => `${Number(mod.size)}:${mod.stat}`));
}

function readTuningAssignments(solution) {
  const tuning = solution?.tuningAssignments || solution?.evaluation?.tuningAssignments;
  if (!Array.isArray(tuning)) return [];
  return tuning;
}

// Directional +5/-5 Tuning as an unordered (from, to) multiset. Assignments may
// move to any physical piece whose immutable capability allows the `to` side.
export function getDirectionalTuningMultiset(solution) {
  return toCountEntries(readTuningAssignments(solution)
    .filter(assignment => ["+5-5", "shift"].includes(assignment?.mode)
      && STATS.includes(assignment.from) && STATS.includes(assignment.to))
    .map(assignment => `${assignment.from}>${assignment.to}`));
}

// +3 (Balanced) Tuning adds +1 to each of a piece's three masterwork stats, so
// the aggregate six-dimension contribution vector — not the +3 count alone —
// is the invariant. Two plans with equal counts but different vectors produce
// different final stats and are NOT macro-equivalent.
export function getPlus3Contribution(solution) {
  const vector = Object.fromEntries(STATS.map(stat => [stat, 0]));
  let count = 0;
  const configs = solution?.config || [];
  readTuningAssignments(solution).forEach((assignment, index) => {
    if (!["+3", "plus3"].includes(assignment?.mode)) return;
    const config = configs[index] || {};
    count++;
    const definition = getArchetypeDefinition(config.archetype || config.archetypeId);
    for (const stat of STATS) {
      if (definition && stat === definition.primary) continue;
      if (definition && stat === definition.secondary) continue;
      if (stat === config.tertiary) continue;
      vector[stat]++;
    }
  });
  return { count, vector };
}

function normalizedBaseStats(config) {
  return Object.fromEntries(STATS.map(stat => [stat, Number(config?.baseStats?.[stat]) || 0]));
}

// Pinned pieces are recorded with their full mathematical identity: the slot,
// the Exotic hash (when known) or the source-bound instance id, and the exact
// framework roll. An unowned (farm) Exotic and the same owned Exotic produce
// the same descriptor: ownership is a planning outcome, not an invariant.
function getPinnedPieceDescriptors(solution, fixedExotic) {
  const roles = getPlanPieceRoles(solution, fixedExotic);
  const descriptors = [];
  (solution?.config || []).forEach((config, index) => {
    const role = roles[index];
    if (!role.pinned) return;
    const archetypeId = getConfigArchetypeId(config);
    if (role.exotic) {
      const hash = Number(fixedExotic?.hash ?? config?.hash) > 0
        ? Number(fixedExotic?.hash ?? config?.hash) : null;
      descriptors.push({
        kind: "exotic", slot: role.slot, sourceId: null, hash,
        archetypeId, tertiary: STATS.includes(config?.tertiary) ? config.tertiary : null,
        baseStats: normalizedBaseStats(config),
      });
    } else {
      descriptors.push({
        kind: "source", slot: role.slot, sourceId: String(config?.sourceId || ""), hash: null,
        archetypeId, tertiary: STATS.includes(config?.tertiary) ? config.tertiary : null,
        baseStats: normalizedBaseStats(config),
      });
    }
  });
  return descriptors.sort((left, right) =>
    PLAN_SLOTS.indexOf(left.slot) - PLAN_SLOTS.indexOf(right.slot)
    || String(left.sourceId).localeCompare(String(right.sourceId))
    || String(left.hash).localeCompare(String(right.hash)));
}

// Recompute the armor-domain totals from the concrete config, Tuning and mod
// assignments. The profile never trusts a witness's cached totals.
function computeProfileTotals(solution) {
  const configs = solution?.config || [];
  const tuning = readTuningAssignments(solution);
  const mods = readModAssignments(solution);
  const totals = Object.fromEntries(STATS.map(stat => [stat, 0]));
  configs.forEach((config, index) => {
    const base = config?.baseStats || {};
    for (const stat of STATS) totals[stat] += Number(base[stat]) || 0;
    const assignment = tuning[index];
    if (["+3", "plus3"].includes(assignment?.mode)) {
      const definition = getArchetypeDefinition(config.archetype || config.archetypeId);
      for (const stat of STATS) {
        if (definition && stat === definition.primary) continue;
        if (definition && stat === definition.secondary) continue;
        if (stat === config.tertiary) continue;
        totals[stat] += 1;
      }
    } else if (["+5-5", "shift"].includes(assignment?.mode)
        && STATS.includes(assignment.from) && STATS.includes(assignment.to)) {
      totals[assignment.from] -= 5;
      totals[assignment.to] += 5;
    }
    const mod = mods[index];
    if (mod && [5, 10].includes(Number(mod.size)) && STATS.includes(mod.stat)) {
      totals[mod.stat] += Number(mod.size);
    }
  });
  return totals;
}

// The macro profile of a plan: everything that must be reproduced by any
// physically different but mathematically identical realization.
//
// `fixedExotic` is the fixed-Exotic request (see rankInventoryPlans). When the
// option is omitted, a sealed planning witness contributes its own
// `inventoryContext.fixedExotic`, so re-planning a certified witness yields
// the same profile it was certified under. Passing `null` explicitly disables
// that derivation.
export function createPlanMacroProfile(solution, { fixedExotic } = {}) {
  const resolvedFixedExotic = fixedExotic !== undefined
    ? fixedExotic
    : solution?.problemSpec?.inventoryContext?.fixedExotic ?? null;
  const plus3 = getPlus3Contribution(solution);
  return {
    schemaVersion: PLAN_EQUIVALENCE_SCHEMA_VERSION,
    pinnedPieces: getPinnedPieceDescriptors(solution, resolvedFixedExotic),
    frameworkMultiset: getFrameworkMultiset(solution, { fixedExotic: resolvedFixedExotic }),
    tertiaryMultiset: getTertiaryMultiset(solution, { fixedExotic: resolvedFixedExotic }),
    armorModMultiset: getArmorModMultiset(solution),
    directionalTuningMultiset: getDirectionalTuningMultiset(solution),
    plus3Count: plus3.count,
    plus3Contribution: plus3.vector,
    totals: computeProfileTotals(solution),
  };
}

export function createPlanMacroId(solution, options = {}) {
  return stableSerialize(createPlanMacroProfile(solution, options));
}

function pinnedPiecesEqual(source, candidate) {
  if (source.length !== candidate.length) return false;
  return source.every((piece, index) => {
    const other = candidate[index];
    if (!other || piece.kind !== other.kind || piece.slot !== other.slot
      || piece.archetypeId !== other.archetypeId || piece.tertiary !== other.tertiary) return false;
    if (STATS.some(stat => piece.baseStats[stat] !== other.baseStats[stat])) return false;
    if (piece.kind === "source") return piece.sourceId === other.sourceId;
    // An Exotic identity is pinned by hash when the source knows one; a theory
    // config without a hash pins only the frame (any copy of the same Exotic).
    if (piece.hash !== null && other.hash !== piece.hash) return false;
    return true;
  });
}

// A realized candidate carries sourceIds on every owned piece, but ownership
// is not pinning: only the identities the *source* plan required are pinned.
// The comparison therefore aligns the source's pinned descriptors against
// candidate pieces first; every remaining candidate piece — owned or farmed —
// realizes the movable multisets.
function matchesPinnedDescriptor(config, descriptor) {
  if (!config) return false;
  if (descriptor.kind === "exotic") {
    if (!config.exotic) return false;
    if (getConfigArchetypeId(config) !== descriptor.archetypeId
        || config.tertiary !== descriptor.tertiary) return false;
    if (STATS.some(stat => Number(config.baseStats?.[stat] || 0) !== descriptor.baseStats[stat])) return false;
    if (descriptor.hash !== null && Number(config.hash ?? 0) !== descriptor.hash) return false;
    return true;
  }
  return String(config.sourceId || "") === descriptor.sourceId;
}

function alignCandidatePieces(sourceProfile, candidate) {
  const slots = resolvePlanSlots(candidate);
  const configs = candidate?.config || [];
  const taken = configs.map(() => false);
  for (const descriptor of sourceProfile.pinnedPieces) {
    let matched = -1;
    for (let index = 0; index < configs.length; index++) {
      if (taken[index] || slots[index] !== descriptor.slot) continue;
      if (matchesPinnedDescriptor(configs[index], descriptor)) { matched = index; break; }
    }
    if (matched < 0) return null;
    taken[matched] = true;
  }
  return configs.map((config, index) => ({ config, movable: !taken[index] }));
}

// Detailed comparison: which invariants match, which do not. `equivalence`
// carries the five task-level invariants; `differences` also names pinned
// identity and totals regressions. The returned `candidateProfile` is the
// candidate *as a realization of the source's macro class*: pinned entries are
// the aligned descriptors, the bags come from the remaining pieces.
export function comparePlanMacroProfiles(source, candidate, options = {}) {
  const sourceProfile = createPlanMacroProfile(source, options);
  const alignment = alignCandidatePieces(sourceProfile, candidate);
  const movableConfigs = alignment
    ? alignment.filter(entry => entry.movable).map(entry => entry.config)
    : (candidate?.config || []);
  const candidateProfile = {
    schemaVersion: PLAN_EQUIVALENCE_SCHEMA_VERSION,
    pinnedPieces: alignment ? sourceProfile.pinnedPieces : null,
    frameworkMultiset: toCountEntries(movableConfigs.map(getConfigArchetypeId).filter(Boolean)),
    tertiaryMultiset: toCountEntries(movableConfigs
      .map(config => config?.tertiary).filter(stat => STATS.includes(stat))),
    armorModMultiset: getArmorModMultiset(candidate),
    directionalTuningMultiset: getDirectionalTuningMultiset(candidate),
    plus3Count: getPlus3Contribution(candidate).count,
    plus3Contribution: getPlus3Contribution(candidate).vector,
    totals: computeProfileTotals(candidate),
  };
  const equivalence = {
    frameworkMultiset: stableSerialize(sourceProfile.frameworkMultiset)
      === stableSerialize(candidateProfile.frameworkMultiset),
    tertiaryMultiset: stableSerialize(sourceProfile.tertiaryMultiset)
      === stableSerialize(candidateProfile.tertiaryMultiset),
    armorModMultiset: stableSerialize(sourceProfile.armorModMultiset)
      === stableSerialize(candidateProfile.armorModMultiset),
    directionalTuningMultiset: stableSerialize(sourceProfile.directionalTuningMultiset)
      === stableSerialize(candidateProfile.directionalTuningMultiset),
    plus3Contribution: sourceProfile.plus3Count === candidateProfile.plus3Count
      && STATS.every(stat => sourceProfile.plus3Contribution[stat] === candidateProfile.plus3Contribution[stat]),
  };
  const differences = Object.entries(equivalence)
    .filter(([, ok]) => !ok).map(([name]) => name);
  if (!alignment || !pinnedPiecesEqual(sourceProfile.pinnedPieces, candidateProfile.pinnedPieces)) {
    differences.push("pinnedPieces");
  }
  if (STATS.some(stat => sourceProfile.totals[stat] !== candidateProfile.totals[stat])) {
    differences.push("totals");
  }
  return {
    equal: differences.length === 0,
    differences,
    equivalence,
    sourceProfile,
    candidateProfile,
  };
}

export function verifyMacroEquivalent(source, candidate, options = {}) {
  return comparePlanMacroProfiles(source, candidate, options).equal;
}
