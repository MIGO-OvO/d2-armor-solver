import assert from "node:assert/strict";
import test from "node:test";

import { rankInventoryPlans } from "../src/core/inventory-plan.mjs";
import { STATS } from "../src/core/armor-model.mjs";
import {
  MACRO_SLOTS, buildMacroSolution, buildVaultPiece, assertMacroOwnedPlan,
} from "./helpers/macro-fixtures.mjs";

// ============================================================
// MACRO SEARCH BUDGET SCHEDULING
// ============================================================
// Every source solution must get its own macro search session: its own node
// counter and its own time slice, started when it enters phase 2. The batch
// keeps an additional safety ceiling. Everything here is deterministic — all
// limits are injected through `macroSearchLimits`, no wall-clock sleeps.
//
// The pool is shared by every solution in one call, so each fixture uses its
// own frameworks. That keeps one solution's rich vault from enlarging another
// solution's search space.

// A directional-permutation witness: identical pairs at identical slots whose
// immutable +5 rolls only cover the source's (from, to) multiset globally.
const PERMUTED_PAIRS = [["Bulwark", "melee"], ["Bulwark", "grenade"], ["Specialist", "super"],
  ["Specialist", "health"], ["Brawler", "weapons"]];
const PERMUTED_TUNING = [
  { mode: "+5-5", from: "health", to: "melee" },
  { mode: "+5-5", from: "health", to: "grenade" },
  { mode: "+5-5", from: "weapons", to: "super" },
  { mode: "+5-5", from: "melee", to: "health" },
  { mode: "+5-5", from: "grenade", to: "weapons" },
];
// Immutable rolls that cover {melee, grenade, super, health, weapons} only as
// a multiset, never config-by-config.
const PERMUTED_CAPABILITIES = ["grenade", "melee", "weapons", "super", "health"];

function richSolution() {
  return buildMacroSolution({ pairs: PERMUTED_PAIRS, tuning: PERMUTED_TUNING });
}

// Every slot offers every source pair under three immutable rolls, so the
// ownership search has thousands of branches and cannot finish inside a small
// per-solution cap.
function richVault(prefix) {
  const items = [];
  for (const slot of MACRO_SLOTS) {
    for (const [archetypeId, tertiary] of PERMUTED_PAIRS) {
      for (const tunedStat of [null, "melee", "super"]) {
        items.push(buildVaultPiece({
          slot, archetypeId, tertiary, tunedStat,
          id: `${prefix}-${slot}-${archetypeId}-${tertiary}-${tunedStat || "none"}`,
        }));
      }
    }
  }
  return items;
}

// A one-candidate-per-slot fixture on its own frameworks: the ownership search
// is tiny and must complete within its own bound.
function simpleFixture(prefix, pairs, destination) {
  const tuning = pairs.map(() => ({ mode: "none" }));
  tuning[0] = { mode: "+5-5", from: "health", to: destination };
  return {
    solution: buildMacroSolution({ pairs, tuning }),
    items: pairs.map(([archetypeId, tertiary], index) => buildVaultPiece({
      slot: MACRO_SLOTS[index], archetypeId, tertiary,
      tunedStat: index === 0 ? destination : null,
      id: `${prefix}-${index}`,
    })),
  };
}

// A fixture the exact-template phase cannot satisfy: every piece keeps its
// (framework, tertiary) roll but its immutable +5 points elsewhere, so only a
// global re-placement of the (from, to) multiset owns all five pieces. The
// macro search for it stays small.
function macroRequiredFixture(prefix, pairs, destinations) {
  const tuning = destinations.map(to => ({
    mode: "+5-5",
    from: STATS[(STATS.indexOf(to) + 1) % STATS.length],
    to,
  }));
  return {
    solution: buildMacroSolution({ pairs, tuning }),
    items: pairs.map(([archetypeId, tertiary], index) => buildVaultPiece({
      slot: MACRO_SLOTS[index], archetypeId, tertiary,
      tunedStat: destinations[(index + 3) % destinations.length],
      id: `${prefix}-${index}`,
    })),
  };
}

const SIMPLE_A_PAIRS = [["Siegebreaker", "melee"], ["Siegebreaker", "super"], ["Paragon", "health"],
  ["Paragon", "grenade"], ["Colossus", "weapons"]];
const SIMPLE_B_PAIRS = [["Reaver", "health"], ["Reaver", "grenade"], ["Gunner", "super"],
  ["Gunner", "health"], ["Demolitionist", "super"]];
const SIMPLE_A = simpleFixture("sa", SIMPLE_A_PAIRS, "melee");
const SIMPLE_B = simpleFixture("sb", SIMPLE_B_PAIRS, "grenade");

test("each solution in a batch gets its own bounded macro search session", () => {
  const rich = richSolution();
  const simpleA = SIMPLE_A.solution;
  const simpleB = SIMPLE_B.solution;
  const plans = rankInventoryPlans({
    solutions: [rich, simpleA, simpleB],
    items: [...richVault("rich"), ...SIMPLE_A.items, ...SIMPLE_B.items],
    classId: "hunter",
    residualSearchLimits: { maxNodes: 0 },
    macroSearchLimits: {
      maxNodesPerSolution: 200,
      maxNodesPerBatch: 100000,
      maxTimeMsPerSolution: 60000,
      maxTimeMsPerBatch: null,
    },
  });

  const richPlan = plans.find(plan => plan.solution === rich);
  // The rich solution is truncated by its own cap, and the reason says so.
  assert.equal(richPlan.matchingProof.complete, false);
  assert.equal(richPlan.matchingProof.macroSearchLimited, true);
  assert.equal(richPlan.matchingProof.macroSearchLimitReason, "solution-nodes");

  // The later solutions started with fresh counters and completed.
  assertMacroOwnedPlan(plans.find(plan => plan.solution === simpleA), simpleA);
  assertMacroOwnedPlan(plans.find(plan => plan.solution === simpleB), simpleB);

  const diagnostics = plans.macroDiagnostics;
  assert.equal(diagnostics.solutionsAttempted, 3);
  assert.equal(diagnostics.solutionsCompleted, 2);
  assert.equal(diagnostics.solutionsLimited, 1);
  assert.deepEqual(diagnostics.limitReasons, ["solution-nodes"]);
  assert.ok(diagnostics.maxSolutionNodes <= 201,
    `per-solution cap must bound each session, saw ${diagnostics.maxSolutionNodes}`);
  assert.ok(diagnostics.nodes < 100000,
    "batch accounting stays well below the batch ceiling");
});

test("the batch ceiling is enforced separately from the per-solution cap", () => {
  const solutionA = richSolution();
  const solutionB = richSolution();
  const plans = rankInventoryPlans({
    solutions: [solutionA, solutionB],
    items: richVault("shared"),
    classId: "hunter",
    residualSearchLimits: { maxNodes: 0 },
    // A generous per-solution cap with a batch ceiling of a single node: the
    // reason must be the batch, never the solution cap.
    macroSearchLimits: {
      maxNodesPerSolution: 100000,
      maxNodesPerBatch: 1,
      maxTimeMsPerSolution: 60000,
      maxTimeMsPerBatch: null,
    },
  });
  for (const plan of plans) {
    assert.equal(plan.matchingProof.macroSearchLimited, true);
    assert.equal(plan.matchingProof.macroSearchLimitReason, "batch-nodes");
    assert.equal(plan.matchingProof.complete, false);
    // A truncated phase must never fabricate a negative ownership proof: the
    // plan keeps the best evidence found so far.
    assert.notEqual(plan.matchedSolution?.certificate?.status, "INFEASIBLE_PROVEN");
  }
  assert.deepEqual(plans.macroDiagnostics.limitReasons, ["batch-nodes"]);
  assert.equal(plans.macroDiagnostics.solutionsCompleted, 0);
  assert.ok(plans.macroDiagnostics.solutionsLimited >= 1);
});

test("per-solution and batch time ceilings are reported distinctly", () => {
  const solution = SIMPLE_A.solution;
  const items = SIMPLE_A.items;
  const common = { maxNodesPerSolution: 100000, maxNodesPerBatch: 100000 };
  // A deadline already in the past: the timer starts when the solution enters
  // phase 2, so the first tick observes it.
  const solutionTime = rankInventoryPlans({
    solutions: [solution], items, classId: "hunter",
    residualSearchLimits: { maxNodes: 0 },
    macroSearchLimits: {...common, maxTimeMsPerSolution: -1},
  });
  assert.equal(solutionTime[0].matchingProof.macroSearchLimitReason, "solution-time");
  assert.equal(solutionTime[0].matchingProof.complete, false);

  const batchTime = rankInventoryPlans({
    solutions: [solution], items, classId: "hunter",
    residualSearchLimits: { maxNodes: 0 },
    macroSearchLimits: {...common, maxTimeMsPerBatch: -1},
  });
  assert.equal(batchTime[0].matchingProof.macroSearchLimitReason, "batch-time");
  assert.equal(batchTime[0].matchingProof.complete, false);
});

test("phase one time never consumes the macro phase's own budget", () => {
  // A deranged directional fixture forces phase 2 to do the actual ownership
  // work, and a large pool of unrelated pieces makes phase 1 scan real work
  // first. The macro session must still start with a full time slice of its
  // own — and finish.
  const pairs = PERMUTED_PAIRS;
  const solution = buildMacroSolution({ pairs, tuning: PERMUTED_TUNING });
  const vault = pairs.map(([archetypeId, tertiary], index) => buildVaultPiece({
    slot: MACRO_SLOTS[index], archetypeId, tertiary,
    // Every immutable roll points somewhere else; only a global re-placement
    // of the (from, to) multiset can own all five pieces.
    tunedStat: PERMUTED_CAPABILITIES[index],
    id: `p1-${index}`,
  }));
  const filler = [];
  const FILLER_PAIRS = [
    ["Gunner", "super"], ["Skirmisher", "health"], ["Colossus", "class"],
    ["Powerhouse", "melee"], ["Siegebreaker", "melee"], ["Paragon", "grenade"],
  ];
  for (let index = 0; index < 400; index++) {
    const [archetypeId, tertiary] = FILLER_PAIRS[index % FILLER_PAIRS.length];
    filler.push(buildVaultPiece({
      slot: MACRO_SLOTS[index % 5],
      archetypeId,
      tertiary,
      tunedStat: null,
      id: `filler-${index}`,
    }));
  }
  const plans = rankInventoryPlans({
    solutions: [solution],
    items: [...vault, ...filler],
    classId: "hunter",
    residualSearchLimits: { maxTimeMs: 2, maxNodes: 200000 },
    macroSearchLimits: { maxTimeMsPerSolution: 5000, maxTimeMsPerBatch: null },
  });
  assertMacroOwnedPlan(plans[0], solution);
  assert.equal(plans[0].matchingProof.macroSearchLimited, undefined);
  const diagnostics = plans.macroDiagnostics;
  assert.equal(diagnostics.solutionsAttempted, 1);
  assert.equal(diagnostics.solutionsCompleted, 1);
  assert.ok(diagnostics.timeMs >= 0);
});

test("ordinary vaults finish well inside the default budget", () => {
  // The default limits exist to bound pathological batches, not to truncate
  // normal ones: three macro-requiring solutions must complete with a small
  // node count and no limit reason at all.
  const first = macroRequiredFixture("d1", SIMPLE_A_PAIRS,
    ["melee", "grenade", "super", "health", "weapons"]);
  const second = macroRequiredFixture("d2", SIMPLE_B_PAIRS,
    ["weapons", "super", "health", "melee", "grenade"]);
  const third = macroRequiredFixture("d3", PERMUTED_PAIRS,
    ["health", "weapons", "grenade", "super", "melee"]);
  const plans = rankInventoryPlans({
    solutions: [first.solution, second.solution, third.solution],
    items: [...first.items, ...second.items, ...third.items],
    classId: "hunter",
  });
  for (const fixture of [first, second, third]) {
    assertMacroOwnedPlan(plans.find(plan => plan.solution === fixture.solution), fixture.solution);
  }
  const diagnostics = plans.macroDiagnostics;
  assert.equal(diagnostics.solutionsCompleted, 3);
  assert.equal(diagnostics.solutionsLimited, 0);
  assert.deepEqual(diagnostics.limitReasons, []);
  assert.ok(diagnostics.nodes < 20000, `default budget used ${diagnostics.nodes} nodes`);
  assert.ok(diagnostics.maxSolutionNodes <= 20001);
  // Certification is milliseconds per candidate: a level must certify its
  // ranked shortlist, never every leaf it visited.
  assert.ok(diagnostics.certifications <= 12,
    `macro phase certified ${diagnostics.certifications} candidates`);
});

test("a completed macro search settles the answer even when the residual search is cut", () => {
  // One piece cannot host the source shift, so the macro proof owns four
  // pieces and farms one; the residual alternative search then has room to run
  // and is truncated by its own budget.
  const pairs = [["Bulwark", "melee"], ["Bulwark", "grenade"], ["Specialist", "super"],
    ["Specialist", "health"], ["Brawler", "weapons"]];
  const tuning = pairs.map(() => ({ mode: "+5-5", from: "health", to: "melee" }));
  const solution = buildMacroSolution({ pairs, tuning });
  const items = pairs.map(([archetypeId, tertiary], index) => buildVaultPiece({
    slot: MACRO_SLOTS[index], archetypeId, tertiary,
    // The last piece cannot take the melee shift.
    tunedStat: index === 4 ? "grenade" : "melee",
    id: `cut-${index}`,
  }));
  const plans = rankInventoryPlans({
    solutions: [solution], items, classId: "hunter",
    residualSearchLimits: { maxNodes: 0 },
  });
  const [plan] = plans;
  assert.equal(plan.matchingProof.scope, "source-macro-equivalence");
  assert.equal(plan.matchingProof.complete, true);
  assert.equal(plan.matchingProof.macroEquivalenceSearched, undefined);
  assert.equal(plan.matchingProof.residualSearchLimited, true,
    "the truncated alternative-plan search is still reported");
  assert.equal(plan.matchingProof.macroSearchLimited, undefined);
  assert.equal(plan.farmCount, 1);
});
