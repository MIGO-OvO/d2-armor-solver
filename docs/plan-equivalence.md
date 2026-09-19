# Plan Macro Equivalence

The Inventory Planner answers "which pieces of this theoretical plan do I
already own, and what is left to farm?" for a Solver V3 theory witness. This
document defines when a physical inventory counts as *the same plan* even
though its pieces, slots and assignments differ from the witness.

The implementation lives in `src/core/plan-equivalence.mjs` (pure profile
extraction and comparison) and the matcher in `src/core/inventory-plan.mjs`.

## Mathematical invariants

For a five-piece plan the armor-domain totals decompose as:

```
totals = Σ pinned bases
       + Σ_movable f(archetype, tertiary)
       + Σ directional (from → to) shifts        (±5 each)
       + Σ +3 masterwork contributions           (+1 × 3 stats per piece)
       + Σ armor mods                            (+5 / +10)
```

A T5 legendary's base distribution is
`f = 5·allStats + 25·primary + 20·secondary + 15·tertiary`, so the movable
base contribution depends only on two multisets:

* the **framework multiset** (how many pieces of each archetype), and
* the **tertiary multiset** (how many pieces roll each tertiary stat).

### Why frameworks and tertiaries are separable

Fix the framework multiset and the tertiary multiset. Any two legal pairings
of them produce the same per-piece base sum, because each piece contributes
`25·primary(a) + 20·secondary(a) + 15·t` and both terms are counted once per
piece regardless of which `(a, t)` pair a piece wears. Legality
(`t` is neither the archetype's primary nor secondary — see
`isLegalFrameworkTertiaryPair`) decides whether a pairing is *realizable*, not
whether it changes the sum. Slot placement is irrelevant for the same reason:
each physical slot receives exactly one piece.

So the planner may accept an inventory whose HighEnergy frames live on
different slots, or whose tertiary stats pair with different frameworks, as
long as both multisets match and every concrete pairing is legal.

### Why +3 must be compared by contribution

A `+3` (Balanced) assignment adds +1 to each of the piece's three masterwork
stats — the three stats outside its `{primary, secondary, tertiary}` set.
Different pieces have different masterwork sets, so two plans with the same
`numPlus3` can produce different final stats. The macro profile therefore
compares the **aggregate six-dimension contribution vector**
(`plus3Contribution`), plus the count. A `+3` may move to any piece (or slot)
as long as the total vector is unchanged.

### Directional Tuning and Armor Mods

`+5/-5` assignments form an unordered `(from, to)` multiset. They may move to
any physical piece whose *real* capability allows the destination: a
Legendary's immutable `tunedStat`, or an Exotic's `allowedTuningStats`. Farm
(theoretical) pieces are assumed farmable with the required roll; the fresh
witness must still verify.

Armor Mods are a global resource: only the `(size, stat)` multiset is
invariant. Where a mod is currently installed is execution state and never
changes the mathematical conclusion.

### Pinned pieces

Not everything joins the free exchange pool. A config is **pinned** when:

* it is the Exotic Class Item config (perk-derived, `exoticIndex`),
* it is flagged `exotic` (a fixed regular Exotic, or a planned farm Exotic),
* it carries a `sourceId` binding it to a concrete owned piece, or
* it occupies the requested fixed-Exotic slot.

Pinned pieces keep slot, identity (Exotic hash / source instance) and exact
base roll. A pinned Exotic may be owned or farmed — ownership is a planning
outcome, not an invariant — but a different Exotic identity or a different
roll is a different plan.

## Mathematical vs execution equivalence

Macro equivalence is a statement about *mathematics*: two realizations produce
identical armor-domain totals under the same constraint model. It deliberately
ignores installed sockets, energy, currently equipped mods and tuning
installation — those belong to execution preflight (`assignArmorMods`,
`executionKnown`), which re-runs on the concrete pieces of whatever plan the
user selects.

## Matching pipeline

`rankInventoryPlans` runs three phases per theory witness:

1. **Exact template** (`searchSlots` + `chooseBestAssignment`) — fast path
   over legal slot permutations, replaying the source configs per index.
   `assignmentCanReachExact` keeps its narrow "replay, never re-optimize"
   semantics.
2. **Macro equivalence** (`matchMacroEquivalentPlan`) — consumes the movable
   framework/tertiary bags piece by piece (canonical T5 bases only), resolves
   pinned identities, re-pairs the bag remainder legally for farmed slots,
   re-places directional Tuning by real capability, reproduces the +3
   contribution vector and redistributes Armor Mods. The search is exhaustive
   for at most five pieces and uses its own budget: the answer never depends on
   `residualSearchLimits`.
3. **Residual constraint re-solve** (`reoptimizeConstraintPlan` via
   `findExactPartialConfigWitnesses`) — bounded re-solve of the *original*
   `problemSpec`/`constraintModel`. It may produce a different macro
   composition (a different plan in the same problem), never a macro-equivalent
   realization of the source, and its results are always reported incomplete.

Within a settled ownership level the matcher keeps the best realization:
rule feasibility first, then set coverage, then the cheaper Tuning/Armor-Mod
assignment, and finally a stable identity order (`compareMacroCandidates`).
Armor Mods are placed per candidate so the multiset stays exact while pieces
whose installed mod is still in the multiset keep it, which lowers
`changedSocketCount` without touching the mathematics.

Certifying a candidate is expensive — a witness seal, a certificate and the
macro comparison — so the leaf search ranks candidates by cheap metrics only
and each ownership level certifies a small ranked shortlist
(`MACRO_CERTIFY_ATTEMPTS`). `diagnostics.certifications` tracks that count;
ranking every leaf through the full V3 boundary instead would spend the whole
budget on certification alone.

A candidate becomes the displayed plan only after the full V3 correctness
boundary passes: `verifyMacroEquivalent(source, candidate)`, `sealWitness`,
`satisfiesConstraintModel` and a fresh `createResultCertificate`. The source
witness is never mutated.

## Search budget and scheduling

Every source solution gets its own macro search session:

* a per-solution node counter and time slice, both started when the solution
  *enters phase 2* — phase 1 template search and certification time can never
  consume them;
* a batch-wide node counter and a batch ceiling on accumulated macro work
  (not on the wall clock of the surrounding call), so a 50-solution batch
  cannot stall and one hopeless solution cannot eat the whole budget.

Defaults are tuned for both ends: near-template vaults finish in well under a
thousand nodes with a couple of certifications, while a pathological batch
stays bounded near a second of macro work per call. `macroSearchLimits`
injects the limits for tests and benchmarks. A truncated search records which
budget stopped it (`solution-nodes`, `solution-time`, `batch-nodes`,
`batch-time`), and `rankInventoryPlans` exposes per-batch diagnostics
(`solutionsAttempted/Completed/Limited`, `nodes`, `maxSolutionNodes`,
`timeMs`, `certifications`, `limitReasons`) for audits. The diagnostics ride on
the returned array, so the worker transport drops them instead of paying for
them.

## Proof semantics (`matchingProof`)

```js
// Macro-equivalent realization (phase 2 succeeded):
{
  scope: "source-macro-equivalence",
  complete: true,
  slotIndependent: true,
  equivalence: {
    frameworkMultiset: true, tertiaryMultiset: true, armorModMultiset: true,
    directionalTuningMultiset: true, plus3Contribution: true,
  },
  sourceMacroId, candidateMacroId,
}

// Residual re-solve (phase 3 replaced the plan):
{
  scope: "original-constraint-model",
  complete: false, macroEquivalent: false, residualResolve: true,
}

// Truncated ownership search:
{
  scope: "provided-theoretical-witness",   // or source-macro-equivalence
  complete: false,
  macroSearchLimited: true,
  macroSearchLimitReason: "solution-nodes" | "solution-time" | "batch-nodes" | "batch-time",
  // plus matchingSearchLimited / residualSearchLimited when those phases were cut
}
```

A completed macro search settles the owned/farm question for that solution
even when phases 1 and 3 were truncated (`macroEquivalenceSearched`). A
bounded residual miss never demotes an already-proven macro/template result —
it only means alternative plans were not exhausted, and only adds
`residualSearchLimited`.

## Provisional vs settled plans

`isOwnedPlanSettled(plan)` is the single authority: a plan is settled when
`matchingProof.complete !== false`. A completed macro proof stays settled even
when the alternative-plan residual search was truncated, and a fully-owned
plan needs no caveat.

The owned-plan cache stores both kinds. Provisional entries keep serving the
list, but they are never final: when the reader opens that solution, the app
issues one dedicated foreground retry for that solution alone (a fresh macro
session instead of the shared batch slice) and replaces the entry with the
settled result. At most one automatic retry per input revision prevents
render/retry loops; an inventory, filter or constraint change re-arms it. The
UI shows a "search incomplete" notice only while the owned/farm conclusion is
genuinely provisional.

## Relationship to Solver V3 identity

`PlanMacroProfile`/`PlanMacroId` are Inventory-Planner-scoped. They do not
touch `createCanonicalId`, the global `mathEquivalenceKey`, Top-K dedupe or
witness certificates: those describe one concrete plan, while a macro profile
describes the class of inventories that realize it.
