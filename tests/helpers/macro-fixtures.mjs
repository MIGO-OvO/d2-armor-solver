// Shared fixtures for the Inventory Planner macro-equivalence tests.
//
// A theory witness binds framework/tertiary/Tuning/mod data to concrete config
// indexes. Mathematically only the *macro* invariants matter: the framework
// multiset, the tertiary multiset (re-paired legally), the directional Tuning
// multiset, the +3 aggregate contribution and the armor-mod multiset. These
// helpers build sealed witnesses whose equivalent realizations are permuted
// across slots, pieces and assignments.
import assert from "node:assert/strict";

import { BASE_CONFIGS, STATS, getMasterworkStats } from "../../src/core/armor-model.mjs";
import { createProblemSpec, sealWitness, verifyWitness,
  satisfiesConstraintModel } from "../../src/core/solver-v3-contract.mjs";
import { verifyMacroEquivalent } from "../../src/core/plan-equivalence.mjs";

export const MACRO_SLOTS = ["helmet", "arms", "chest", "legs", "classItem"];
export const MACRO_TINY_RESIDUAL = { maxTimeMs: 1, maxNodes: 1 };

export function macroConfig(archetypeId, tertiary, slot) {
  const config = BASE_CONFIGS.find(entry =>
    entry.archetype === archetypeId && entry.tertiary === tertiary);
  assert.ok(config, `fixture requires a legal pair ${archetypeId}/${tertiary}`);
  return { ...config, slot };
}

export function macroTotals(config, tuning, mods) {
  return Object.fromEntries(STATS.map(stat => [stat, config.reduce((sum, piece, index) => {
    const assignment = tuning[index];
    const mod = mods[index];
    return sum + piece.baseStats[stat]
      + (assignment.mode === "+3" ? Number(getMasterworkStats(piece).includes(stat)) : 0)
      + (assignment.mode === "+5-5"
        ? Number(assignment.to === stat) * 5 - Number(assignment.from === stat) * 5 : 0)
      + (mod ? Number(mod.stat === stat) * mod.size : 0);
  }, 0)]));
}

// Build a verified theory witness from (frame, tertiary) pairs, per-index
// tuning plans and mod assignments. The witness is sealed against an
// exact-target problem so it is a genuine Solver V3 proof.
export function buildMacroSolution({ pairs, tuning, mods = {} } = {}) {
  const config = pairs.map(([archetypeId, tertiary], index) =>
    macroConfig(archetypeId, tertiary, MACRO_SLOTS[index]));
  const tuningAssignments = tuning.map(entry => entry.mode === "+3"
    ? { mode: "+3", from: null, to: null }
    : entry.mode === "none"
      ? { mode: "none", from: null, to: null }
      : { mode: "+5-5", from: entry.from, to: entry.to });
  const modAssignments = Object.fromEntries(config.map((_, index) => [index, mods[index] || null]));
  const totals = macroTotals(config, tuningAssignments, modAssignments);
  const problem = createProblemSpec({
    target: totals,
    numPlus3: tuning.filter(entry => entry.mode === "+3").length,
    numPlus5: Object.values(mods).filter(mod => mod?.size === 5).length,
    numPlus10: Object.values(mods).filter(mod => mod?.size === 10).length,
    constraints: { exact: Object.fromEntries(STATS.map(stat => [stat, true])) },
  });
  const sealed = sealWitness(problem, {
    config, tuningAssignments, modAssignments, totals, exoticIndex: null,
  });
  assert.equal(sealed.valid, true, sealed.errors.join("; "));
  return sealed.witness;
}

// A physical vault piece. `tunedStat` is the immutable Legendary +5 roll.
export function buildVaultPiece({ slot, archetypeId, tertiary, tunedStat = null, setHash = null, id }) {
  const config = macroConfig(archetypeId, tertiary, slot);
  return {
    id: id || `vault-${slot}-${archetypeId}-${tertiary}`,
    hash: 5000 + MACRO_SLOTS.indexOf(slot),
    name: `Vault ${archetypeId} ${tertiary}`,
    slot,
    classId: "hunter",
    tier: "5",
    exotic: false,
    archetypeId,
    tertiary,
    tunedStat,
    tuningTo: tunedStat,
    baseStats: { ...config.baseStats },
    effectiveBaseStats: { ...config.baseStats },
    optimizationBaseStats: { ...config.baseStats },
    setHash,
    dataConfidence: { stats: "known", tuning: "known" },
  };
}

// A vault realization of `pairs` whose pieces sit at rotated physical slots;
// `capabilities` gives each piece's immutable +5 roll.
export function buildRotatedVault(pairs, capabilities = []) {
  return pairs.map(([archetypeId, tertiary], index) =>
    buildVaultPiece({
      slot: MACRO_SLOTS[(index + 2) % 5],
      archetypeId,
      tertiary,
      tunedStat: capabilities[index] || null,
      id: `rotated-${index}`,
    }));
}

export function assertMacroOwnedPlan(plan, solution, { expectedFarm = 0 } = {}) {
  assert.equal(plan.farmCount, expectedFarm);
  assert.equal(plan.ownedCount, 5 - expectedFarm);
  assert.equal(plan.feasible, true);
  assert.equal(plan.matchingProof.scope, "source-macro-equivalence");
  assert.equal(plan.matchingProof.complete, true);
  assert.equal(plan.matchingProof.slotIndependent, true);
  for (const flag of ["frameworkMultiset", "tertiaryMultiset", "armorModMultiset",
    "directionalTuningMultiset", "plus3Contribution"]) {
    assert.equal(plan.matchingProof.equivalence[flag], true, flag);
  }
  assert.equal(plan.matchingProof.sourceMacroId, plan.matchingProof.candidateMacroId);
  const witness = plan.matchedSolution;
  assert.equal(verifyWitness(witness.problemSpec, witness).valid, true);
  assert.equal(satisfiesConstraintModel(witness, solution.problemSpec.constraintModel), true);
  assert.deepEqual(witness.totals, solution.totals);
  assert.equal(verifyMacroEquivalent(solution, witness), true);
  return witness;
}
