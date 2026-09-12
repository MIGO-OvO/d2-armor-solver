# Architecture

## Goals

The application remains a framework-free static site while separating browser
orchestration from computation. A production build may be hosted on GitHub
Pages, Cloudflare Static Assets, or any equivalent static host.

## Module Map

| Module | Interface | Implementation kept behind the Interface |
| --- | --- | --- |
| `ArmorEngine` | `solveLoadout`, `calculateReachability`, `analyzeUpgrade`, `solveInventory` | Solver V3 `ProblemSpec`, constraint/capability normalization, certificates, exact/fallback search, replacement planning |
| `Budget` | `createBalancedTargetPlan` | exact-budget dynamic programming and balanced tie-breaking |
| `BuildRepository` | typed read/write methods for drafts, mode, language, and builds | storage keys, JSON parsing, schema version, storage errors |
| `DIM CSV` | `parseCsv`, `normalizeDimItem`, inventory filters | CSV quoting/BOM handling, real-stat reconstruction, Tuning and Armor Mod inference |
| `InventoryPlanner` | owned/farm plans and owned-only loadouts | slot assignment, fixed Exotic matching, set requirements, farming gaps |
| `ArmorSets` | set lookup and active bonuses | generated Bungie Manifest catalog and localized perk text |
| portal | route selection and shared language preference | static copy, online/offline navigation, Release and Actions links |
| browser workbench | global action Adapter used by existing HTML handlers | DOM state, translation, rendering, mode switching |
| Worker client | Promise-based engine calls | request IDs, structured cloning, Worker errors, inline fallback |

`ArmorEngine` is intentionally deep: callers learn four request-object
Interfaces while the search Implementation stays local. The Worker and inline
fallback are two Adapters at the execution Seam. This creates Leverage for the
UI and tests, and Locality for future rule changes.

## Solver V3 correctness boundary

The PR #3 consistency follow-up is documented in
[v3-consistency-audit.md](v3-consistency-audit.md), including reproduced bugs,
reference test domains and remaining limits. `sealWitness` and
`assertSolutionConsistency` form the serialization/presentation boundary;
`createSolutionDisplayModel` provides concrete per-piece data and recomputed
armor/visible totals. UI display and execution projections are not alternate
sources of Solver totals. Upgrade steps carry full verified snapshots.
The subsequent algorithm optimizations and acceptance results are recorded in
[algorithm-optimization.md](algorithm-optimization.md).
The V3.1 search extensions and paired simulations are recorded in
[solver-v31-optimization.md](solver-v31-optimization.md).

`solver-v3-contract.mjs` owns `ProblemSpec`, the armor-domain `ConstraintModel`,
`PieceCapability`, integer lexicographic comparison, canonical witness ids, and
the five result statuses. Fragment bonuses are an explicit projection from the
unclamped armor domain through `clamp(armor + fragment, 0, 200)`; clamp-boundary
misses remain `SEARCH_LIMIT_REACHED` unless the full armor interval was proved.

Exact-target search uses a bounded TypedArray residual index. Fixed-five
production evaluation uses target-directed Tuning/mod joins and a hard-rule
feasibility fallback; nearest fuzzy ranking remains bounded. Scratch fuzzy search first
solves an integer total-budget relaxation and sends candidates through the same
exact-target oracle; legacy greedy/local search is only an incumbent. Inventory
uses a streaming 2+3 join for fixed-assignment point targets and conservative
stat/set bounds in DFS otherwise. Retained pairs, nodes, evaluations and time
have explicit limits. Exhaustion or an exact-witness quota marks coverage
incomplete; a witness still proves existence. Unknown or stale physical data
cannot consume a verified result slot or authorize negative evidence.

Visible 0/200 targets are budget-constrained armor intervals. Upgrade queries
these intervals directly, using total-budget tightening and residual-box queries,
instead of a limited list of preimage points. Reachability retains interval DP;
incomplete work cannot certify infeasibility. Upgrade completion iterates replacement
counts from zero upward for point/range goals. Its minimum proof requires
reassignment, known Tuning capabilities and complete coverage of all smaller
replacement depths. A range-search time slice or global budget stop cannot
authorize a minimum claim; partial fuzzy ranking retains the existing comparator.

Owned/farm matching searches legal slot permutations of each supplied theory
witness, keeping the original immutable and resealing the mapped display.
Matching equivalence is mathematical/ownership equivalence, not an execution
certificate. `mathDataKnown` and `executionKnown` are separate predicates.

Rule satisfaction is the single ranking axis shared by every plan kind. A bound
`ProblemSpec.constraintModel` decides it: `satisfiesConstraintModel` partitions
the theory witnesses in `armor-engine.mjs`, and `rankInventoryPlans` marks each
physical plan with `rulesFeasible` before `feasible` is computed as
`rulesFeasible && setFeasible && assignmentCanReachExact`. No plan that satisfies
every exact *and* fuzzy rule can be ranked below an approximation, whether or not
the fuzzy search proved its bound, so a proven fuzzy rule set no longer collapses
to a single witness and approximate plans can never displace satisfying ones.
The UI renders one merged list: owned-armor entries and theoretical skeletons
share `compareUnifiedEntries` (satisfying → exact → more owned pieces → fewer
farm gaps → search rank → farmability), and dedup keeps the inventory entry,
which carries the execution preflight, when both describe the same armor.

Result proof status and execution status are orthogonal. `assignArmorMods`
round-trips a concrete owned witness through sockets, energy, plug availability,
and fixed Tuning. It returns `VERIFIED`, `UNVERIFIED`, or `BLOCKED`; Scratch and
pure projection results use `NOT_APPLICABLE`. Worker and inline Adapters clone
the same certificate and canonical id.

## Dependency Direction

```text
index.html (portal)
  -> portal.mjs -> shared language preference
  -> app/index.html

app/index.html
  -> app.mjs (browser Adapter)
       -> armor-engine-client.mjs
            -> Worker Adapter -> ArmorEngine -> solver/reachability/upgrade/inventory
            -> inline Adapter -> ArmorEngine -> solver/reachability/upgrade/inventory
       -> Budget
       -> BuildRepository -> localStorage
       -> DIM CSV -> ArmorSets

ArmorEngine -> armor model
ArmorEngine -> InventoryPlanner -> ArmorSets
ArmorEngine -X-> DOM / localStorage
```

Algorithm Modules are checked in `tests/structure.test.mjs` to prevent browser
state from leaking back across the Seam.

## Performance

Request-scoped execution, effort profiles, cancellation and progressive-result
semantics are described in [staged-search.md](staged-search.md). UI renders
`certificate.statResults` and the certificate projection; progress/coverage is
separate from mathematical truth. Search callbacks never enter ProblemSpec.

- Standard solving, priority refinement, reachability, inventory search, armor
  inference, and owned-armor analysis execute through a module Worker.
- The upgrade optimizer memoizes identical piece evaluations for the lifetime
  of one analysis request; cache entries cannot leak across target/Fragment
  inputs.
- Base configurations precompute the three masterwork stats used by hot
  evaluation loops.
- Vite emits minified, content-hashed JavaScript/CSS and a separate Worker
  asset. The engine is loaded on the main thread for inline fallback or to
  reconstruct and certify parallel inventory witnesses; search stays in Workers.
- Realtime reachability uses a revision number so stale asynchronous results
  cannot overwrite newer input.

## Persistence

`BuildRepository` owns the following keys:

- `d2_armor_page_language_v1` (shared across channels)
- `d2_armor_current_draft_v1` (channel-scoped)
- `d2_armor_upgrade_draft_v1` (channel-scoped)
- `d2_armor_calculator_mode_v1` (channel-scoped)
- `d2_armor_saved_builds_v3` (**shared across channels**)

New draft writes include `schemaVersion: 1`. Existing unversioned drafts are
accepted without migration, so deployments do not make origin-scoped browser data
disappear.

### Saved Builds are user data, not channel state

A loadout the player explicitly saved must survive a stable/develop switch, a
page update and a Solver schema bump. Saved Builds therefore live in
`d2_armor_saved_builds_v3`, which never passes through `channelStorageKey()`, and
are written as a versioned envelope:

```
{ schemaVersion: 3, legacyMergedAt, builds: [SavedBuild] }
```

A `SavedBuild` separates two lifetimes:

- `input` — targets, fragments, budget, Exotic and set constraints. Long-term
  durable; a future Solver must be able to restore it and re-solve.
- `solutionSnapshot` plus `result` — canonical id, pieces, assignments, totals
  and the raw sealed witness. A **cache**: when the Solver contract moves on and
  the snapshot no longer re-verifies, the build is kept and the reader is told to
  re-solve with the current algorithm. Nothing about the snapshot can delete a
  build.

The two historical channel keys `d2_armor_saved_builds` (stable) and
`d2_armor_dev_saved_builds` (develop) are read once and merged on first load.
Dedupe priority is stable build id → `canonicalId` → 保存时间 + 名称 + solution
fingerprint. Legacy records get a *deterministic* derived id, which is what makes
the migration idempotent across reloads. The legacy keys are read but never
deleted, and the new version only ever writes the shared key.

`writeSavedBuilds()` returns `false` when the write did not land (storage
unavailable, quota exceeded). The UI must surface that: reporting a save that did
not happen is how a user loses a loadout without being told.

The `develop` Pages build rewrites mutable solver, Bungie token, display-name,
and OAuth-state keys into the `d2_armor_dev_*` namespace. The language key and the
Saved Builds key are shared intentionally so a portal language choice and the
player's saved loadouts follow them into either channel, without allowing
development drafts or credentials to overwrite stable state.

## Styling

The former inline CSS is externalized as `src/styles/app.css`. Compatibility
styles preserve the historical cascade while workbench-specific sections own
the DIM import, inventory results, and upgrade-planning surfaces. UI changes are
verified at desktop and 390px widths before release.

## Commands

```bash
npm run dev           # Vite development server
npm run lint          # static JavaScript checks
npm test              # fast Node tests
npm run test:upgrade  # randomized replacement-plan regression
npm run test:browser  # installed Chrome/Edge Worker and responsive smoke test
npm run check         # lint, deterministic tests, regression, production build
npm run preview       # serve dist locally
npm run deploy        # build and deploy with Wrangler
```

On Windows, `start_windows.bat` wraps `npm run dev`, installs missing
dependencies on first launch, and opens the local site in the default browser.
`start_windows.bat --no-open` starts the same server without opening a browser.

## Deployment

The Pages workflow checks out and validates both release channels. The `main`
build supplies the root portal and `/app/` stable solver, while the `develop`
build is nested under `/dev/`. `scripts/compose-pages.mjs` adds the developer
entry to the published stable portal, removes the now-redundant nested entry,
and records both commit SHAs in `versions.json`. Each Vite build receives its
channel and commit at build time, so the development solver can show a visible
DEV marker and select isolated storage keys.

Both online channels use the same Bungie application because they share an
origin. Bungie returns OAuth codes to the registered stable `/app/` callback;
the composed stable HTML relays only callbacks whose state begins with
`develop.` to `/dev/app/`. The development app then performs the normal
session-state comparison before exchanging the code, preserving the CSRF
boundary while keeping stable callbacks on the stable channel.

Every pushed branch also produces a solver-only offline artifact. Published
Releases ship the Windows desktop installer as the offline package; the
standalone browser ZIP stays available from Actions artifacts instead of being
attached to Releases. Cloudflare
Workers Static Assets can still consume a standalone `dist/` through Wrangler,
with automatic canonical HTML paths and explicit 404 handling.
