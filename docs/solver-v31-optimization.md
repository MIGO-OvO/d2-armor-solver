# V3.1 search optimization

Base: `develop@f2fcf55793de1cc5ffe43378be833a45dc94e62d`.
This is an incremental algorithm upgrade; the package/release version remains
3.0.1. No schema migration, account mutation or deployment to main is included.
Upgrade retains installed +5/+10 budgets. Inventory supports automatic stat
mods independently of installed counts; explicit budgets always take precedence.

## Implemented

- Scratch mixed-mode exact search filters Balanced selections by target residue
  before the Cartesian product. Surviving selections keep their canonical order
  and archetype representatives. Partial fixed-configuration point search uses
  the same necessary condition. Existential streams stop after their witness quota.
- Adjustment DP uses integer keys; unrestricted capability patterns reuse the
  bounded dense cache instead of constructing duplicate sparse indexes.
  Diagnostic counters expose completed build time, cache hits and misses.
- Fixed-target, fixed-rule, fixed-ranking and residual-index construction loops
  accept cancellation/time checkpoints. Interrupted builds never enter caches.
  Upgrade publishes a verified manual baseline before cancellable reassignment.
- Inventory uses signed singleton/pair/multi-stat support bounds. Each projection
  keeps directional +5/-5 coupling and spends the chosen items' mod budget once.
  Suffix maxima are a conservative remaining-slot relaxation. A full six-dimensional
  DP is deliberately unnecessary here: the projection bound avoids state explosion.
- Inventory retains physical candidates and shares only math evaluations in a
  512-entry cache. Math keys retain actual bases, tuning capability/current assignment
  and mod sizes. Each physical alternative is independently materialized/verified.
  Fixed-assignment 2+3 joins do not pay for the new reassignment-only structures.
- The existing complete fixed-five search now supports production-metric refinement.
  Upgrade refines its baseline within a time slice, and finished Inventory frontiers
  can refine three incumbents with remaining session time. Improvements are published
  as found. Local optimality is marked only after exhaustion with known math/capabilities.
- Fixed-five visible clamp targets query the existing rule interval Oracle directly.
  Partial fixed-configuration Oracle now accepts six-dimensional armor intervals:
  it tightens by physical bounds and conserved totals, prunes the configuration tree,
  and adaptively probes a bounded adjustment lattice box or reachable vectors.
  Upgrade no longer enumerates only 8/128 armor preimage points.
- Upgrade replacement-depth completion now handles range/fuzzy goals without changing
  partial-plan ranking. Range completion has a 1.5-second local slice (30 ms in Fast),
  also subject to the outer profile budget; legacy fuzzy refinement remains a fallback.
  Fully exhausted smaller depths can support a minimum-replacement claim, while an
  interrupted pass cannot. The full-target feasibility-first route remains available.
- Deep global fuzzy search adds disjoint joint-pair score bounds after its cheap
  coordinate bound, with an 8192-entry per-mode base-query cache. This is a relaxation
  in the existing integer lexicographic score, not unsafe numerical Pareto dominance.

## Correctness boundaries

The witness/certificate trust boundary is unchanged. In particular, Inventory
reassignment still does not claim complete negative or global-optimality evidence.
An exact local assignment is not a global inventory optimum. A replacement proof
covers full goal completion, not the best partial fuzzy score at the fewest swaps.
Unknown math/capabilities cannot acquire stronger evidence through caching.
Cold cancellation retains the baseline instead of returning an empty UI snapshot.

The retained heuristic and time slices mean some difficult direct/unbudgeted
Upgrade queries can still be slow. No universal latency guarantee is claimed.
Similarly, offline inline checkpoints cannot service DOM events until JavaScript
yields; this change does not introduce an asynchronous/resumable inline solver.

## Simulation results

Three fresh-process runs per version/case, Node 24.14.0 on the same Windows host.
Raw records: [solver-v31.json](benchmarks/solver-v31.json).
Synthetic inventory uses 1300 items and seed `0x1300cafe`; no account access.

| Case / metric | Baseline median | Optimized median |
| --- | ---: | ---: |
| Inventory hard rules, first feasible | 1610.8 ms | 145.3 ms |
| Inventory hard rules, five-piece evaluations | 496 | 1435 |
| Inventory hard rules, total search | 3000.5 ms | 3000.9 ms |
| Inventory late exact, total search | 544.5 ms | 545.1 ms |
| Inventory equivalent items, total search | 199.0 ms | 199.5 ms |
| Scratch mixed +3=2, exact Oracle | 593.0 ms | 66.1 ms |
| Scratch mixed +3=3, exact Oracle | 539.7 ms | 39.1 ms |

Scratch witnesses remain 86/32 respectively; pair visits fall from 23,049,601
to 117,601 / 21,169 for these targets. Inventory exact/rebuild statuses are
preserved. The hard-rule search still consumes its budget and is incomplete;
it returns a verified rule-feasible witness. Its measured cache hit count is zero:
that varied fixture's improvement is not attributed to duplicate math compression.
A separate 32-physical-loadout regression verifies 31 shared-math cache hits while
retaining and verifying all physical alternatives.

The existing adversarial high-stat cap regression passed in 485 ms in an isolated
final algorithm probe. An intermediate implementation took 52 seconds, and an
earlier unbounded range attempt was stopped; neither was shipped. Historical
69-second results are not presented as a fresh paired baseline measurement.

The original benchmark also passed: same-domain 8^5 Inventory completed in 7.4 ms;
five hot mode-3 samples had median 25.5 ms and empirical P95 29.6 ms. Maximum
per-operation retained JS/ArrayBuffer memory was 19.5 MiB, not peak process RSS.

## Validation

Local full Node suite: **333/333 passed**, zero failures/skips (123.2 seconds).
The upgrade simulation gate verified 50 plans in the preceding complete check;
the final code also reruns this gate in CI. Lint, the original performance gate,
browser smoke and file-protocol offline verification passed. The browser smoke
was rerun after one timeout during concurrent local builds; build and browser
verification must not mutate the same dist directory concurrently.

Commands:

```text
npm run check
node --test tests/solver-v31.test.mjs tests/upgrade-v3-budget.test.mjs
node scripts/benchmark-solver-v31.mjs . <baseline-worktree>
npm run benchmark:v3
npm run test:browser
npm run verify:offline
git diff --check
```

New tests cover generated witnesses, 160 prefix-wise pruning checks, shared-budget
rejection, physical variants, finite interval enumeration, exact local ranking,
joint-bound admissibility, cancellation, multiple-clamp preimages beyond 128,
and baseline publication before cold cancellation. Existing independent randomized
witness/Inventory/Upgrade tests remain enabled. Browser account routes are mocked.

Deployment uses the existing GitHub Pages workflow triggered by develop, serving
the development channel at `/d2-armor-solver/dev/`. The stable branch is not merged
or pushed. The later develop integration also includes the shared Windows desktop build.
