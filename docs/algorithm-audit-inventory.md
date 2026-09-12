# Inventory solver audit

## Acceptance target

For a known, finite armor inventory, a Deep run must enumerate the complete
legal five-slot domain, including Tuning and automatic stat-mod assignments.
Top-K output is only a presentation limit; it must not stop the frontier.

## Findings

| Priority | Finding | Action |
| --- | --- | --- |
| P0 | Frontier traversal and modifier assignment coverage were conflated. | Deep traverses the physical frontier within its budget; bounded reassignment still reports `assignmentComplete: false` and cannot prove global infeasibility. |
| P0 | Deep inventory budget was 15 seconds / 20M nodes / 250k evaluations. Large vaults could return a search-limit result despite available witnesses. | Deep budget is 120 seconds / 500M nodes / 5M evaluations. |
| P1 | `maxResults` is mixed with search termination in non-exhaustive profiles. | Deep keeps scanning after Top-K is full; Balanced remains bounded for interactive use. |
| P0 | The client wrapper (`solveInventoryParallelAsync`) injected `searchLimits.exhaustive = true` into every shard, so Fast/Balanced paid Deep's cost and the `exact-witness-quota` early stop never ran in the browser. | The wrapper forwards the caller's limits unchanged; only an explicit caller flag (or the Deep profile) may force exhaustive. Covered by `tests/parallel-inventory.test.mjs`. |
| P0 | Progressive publication re-derived the ProblemSpec, the capability index, the ruleset id and the whole certificate chain for every shard callback, costing ~530 ms per merge on a 1300-piece vault. A 3 s Balanced search took ~27 s of wall clock. | Spec/index/ruleset-id caches plus a 150 ms progressive merge interval. `benchmark:v3-client` now records wall time, aggregate worker effort and per-shard termination. |
| P1 | Current installed `+5/+10` mods cannot represent DIM Auto Stat Mods. | Inventory reassignment uses capability budget, while explicit Upgrade/Scratch requests retain explicit budgets. |
| P1 | Theory matching and inventory feasibility were conflated in the UI. | Inventory search is an independent result set and theory matching is labelled as such. |
| P2 | A complete frontier does not imply globally optimal fuzzy scoring when the evaluator itself is bounded. | Certificates retain separate frontier and optimization claims. |

## Proof boundary

Fixed-assignment, unsharded search can claim complete coverage only when the frontier is exhausted,
all piece math is known, and every candidate witness verifies. Reassignment does
not claim complete negative evidence, even after physical frontier exhaustion.
Serialized parallel shard coverage never becomes a global negative proof. Search limits,
unknown sockets/stat data, or bounded evaluator paths must produce
`SEARCH_LIMIT_REACHED`, never `INFEASIBLE_PROVEN`.

## Search budget scope (parallel client)

Each shard runs the profile's **full** budget (`maxNodes`, `maxEvaluations`,
`maxStates`, `maxTimeMs`). The search budget is therefore *per-shard*, not
global: a 4-worker Balanced batch can spend up to 4x the single-thread effort,
and the profiler's aggregate counters (`aggregateNodes`,
`coverage.statesExamined`) are sums across shards. The client metadata exposes
`parallelism`, `workerCount`, `budgetScope: "per-shard"` and a per-shard
`shards[]` breakdown so this is measurable rather than implied. Replacing it
with a global wall-clock deadline plus proportional quotas is a possible future
optimisation, but shard workloads are unbalanced, so a naive divide-by-N would
starve the slowest shard.

## Verification

- Real DIM CSV: two distinct exact 510 loadouts recovered for the reported
  `忠诚面具 + 渴望回响 4pc` target.
- Regression: automatic stat-mod assignments remain available when imported
  armor currently has zero installed stat mods.
- Regression: fixed ordinary Exotic is enforced during enumeration.
- Full Node suite, lint, and production build pass after the change.
