# Solver V3 consistency audit

Baseline: PR #3, `d221721c60bd1fd3136d4c209ece56dba6edeae0`.
Implementation workspace: `codex/v3-consistency`. The original dirty `develop`
worktree is deliberately unchanged. No deployment, push, or live Bungie write
is part of this verification.

## Data flow and ownership

`DIM/Bungie/manual input -> normalization -> ProblemSpec -> existing V3 search
-> candidate -> verifyWitness -> sealWitness -> certificate -> display model
-> saved result / upgrade snapshots / execution preflight -> read-back`.

`baseStats` on imported inventory items is the raw roll. `effectiveBaseStats`
adds actual masterwork, and `optimizationBaseStats` is the explicit full-masterwork
projection. Witness pieces use masterwork-inclusive, modifier-free `baseStats`.
They bind `physicalBaseStats` and `requiresMasterwork` when projected. Projection
does not authorize changing a rolled stat or claiming it is executable now.

`tunedStat` is a Legendary physical destination, including explicit `null`.
`allowedTuningStats` is a physical set, including unknown (`null`) and known-empty
(`[]`). The top-level Tuning/mod assignment arrays are the proposed setup. The
input's installed assignment is not a second proposed assignment. The stale
`tuningAssignment` duplicate on normalized Upgrade pieces is removed.
`tuningInstalled: false` explicitly means no installed Tuning; it is not a
directional assignment with a fabricated source. Legacy imported data without
evidence stays unknown. Manual roll editing detaches instance identity.

## Audit findings

| Severity | Finding at PR HEAD | Root cause / correction |
| --- | --- | --- |
| P0 | Verifier accepted Legendary destination drift, changed source IDs, changed base stats, multiple Exotics and wrong set membership | It checked arithmetic shape but not the input capability registry. Bind selected sources, compare immutable fields, check locks/slots/sets/budgets and catalog membership. |
| P0 | Old owned draft with no Tuning evidence acquired `melee` / `health` | Default UI editor values leaked into imported physical state. Preserve null; selection occurs only in an explicit assignment operation. |
| P0 | Mixed inventory plan claimed theoretical totals for a different real roll | Archetype/tertiary matching and existential modifier re-optimization stood in for a concrete witness. Require identical concrete bases and rebuild the already-selected assignment. |
| P0 | Scratch display omitted upper clamp; Bungie display replaced Solver totals but kept Solver metrics | The UI owned separate arithmetic. Render the sealed display model and expose per-piece verification rows. |
| P0 | Empty equipment input or incomplete energy evidence could be `VERIFIED` | Missing loop entries and unknown capacity bypassed checks. Missing pieces block; missing evidence is unverified; live totals must equal the witness. |
| P1 | Global Upgrade cache omitted instance IDs, perks, Exotic/source state; cached objects could be reused by reference | Cache keys modeled only optimization descriptors, but values held physical pieces. Key the complete request and clone on read/write. |
| P1 | Reachability cache retained prior probes / caller mutations; packed lock keys assumed byte-sized nonnegative values | Caller mutated cached objects and key range was implicit. Clone cache records; use lossless integer-vector keys. |
| P1 | Small inventory ties depended on insertion order | Metrics alone did not total-order identities. Add a stable identity tie-breaker. |
| P1 | Matching dedup omitted real bases, sockets, energy, perks and execution context | Equivalence was too coarse. Extend capability equivalence; keep physical capability and assignment together. |
| P1 | Read-back verified only changed/attempted sockets and could report success without complete evidence | Verify every expected equipment ID/socket and compare live item totals with expected armor totals. UI success requires verified read-back and no failed writes. |
| P1 | `onlyPlus5` + no reassignment + owned Balanced piece could produce a null `from` | Mode coercion depended on normalization inventing an assignment. Explicitly resolve the allowed minus source in the requested conversion; regression seed `0xa1160`, trial 15. |
| P2 | 1300 varied inventory exhausted the 512 MiB process heap | Unbounded materialized frontier. Add deterministic resource ceilings and expose incompleteness; never use the ceiling as negative evidence. |
| P2 | Prefix ranking used fractional target ratios; scalar legacy scores remained in one plan tie | Use scaled integer tuples for prefix ordering; remove the scalar tie. Legacy scalar score is compatibility/display data only. |

The first ten added regressions all failed on the baseline and all passed after
the initial repair. Existing expected values were not rewritten to excuse a
wrong result. Two test fixtures were made physically concrete: the DIM Exotic
matching fixture now actually has the 90-point masterworked base it claimed;
browser inventory fixtures no longer use empty base objects as exact items.
Browser vault/equipped copies now differ in Weapons so a transfer assertion
does not rely on incidental tie order.

## Verification argument

1. The independent arithmetic boundary accumulates six safe integers from five
   concrete bases, five legal assignments and the mod budget, then applies
   `clamp(armor + fragment, 0, 200)` exactly. Search totals do not authorize proof.
2. A source ID binds the immutable capability record. An assignment cannot
   rewrite that record. `getUpgradeReplacements` asserts this for retained IDs.
3. `sealWitness` records the normalized problem and a canonical identity.
   `assertSolutionConsistency` rebuilds serialized data, checks presentation
   totals and rejects a mismatching certificate/canonical identity.
4. Upgrade steps retain old Tuning until a replacement exists, otherwise use
   the fixed final assignment. Every step has its full snapshot and verified
   witness. The last step's canonical identity must equal the final witness.
5. The UI uses the display model, including visible per-piece base/Tuning/mod
   rows. The browser test reads those DOM rows and independently reconstructs
   displayed totals. Saved old results without a witness require re-solving.
6. Algorithm proof and executability remain separate. Socket/energy evidence
   does not upgrade an invalid mathematical result. A mathematically valid
   masterwork projection cannot execute as though the upgrade already happened.

This is executable validation, not a cryptographic signature or a machine-checked
formal proof of the entire program. A party changing both a saved problem and
its witness is changing the input, not presenting the original result.

## Pruning / proof audit

| Mechanism | Preserved correctness argument / limitation |
| --- | --- |
| Exact-target TypedArray residual index | First five adjustment coordinates plus the conserved total determine the sixth. Each retained vector carries a decodable assignment. Kept unchanged. |
| Restricted shift states | Merge only equal deltas after the same ordered capabilities; retained action sequence uses those same capabilities. Covered by a separate exhaustive tiny-domain oracle. |
| Base multisets / mode multisets | Theoretical free pieces are interchangeable before slot materialization. Fixed configs stay distinguished. Kept unchanged. |
| Archetype presentation grouping | Applied after exact existence search; does not justify negative results or enumerate every witness. |
| Fuzzy K-best, refinement and Upgrade beams | Incomplete candidate producers. They can supply verified witnesses but cannot prove infeasibility or global optimality. |
| Inventory frontier | Key includes contribution, per-piece capability, set coverage and Exotic state. Expanded physical/execution fields prevent unsafe merges. Resource exhaustion marks frontier incomplete. |
| Reachability DP | Point-rule producer remains limited at visible 0/200. Cache and integer key are fixed; no new interval-completeness claim is made. |
| Upgrade minimum replacement | Existing point-target iterative deepening is retained; unknown capabilities and clamp/fuzzy domains do not get its minimality claim. |

## Changed files

| Files | Main change |
| --- | --- |
| `src/core/solver-v3-contract.mjs` | Capability/source validation, canonical binding, serialization/display model, consistency assertion, strict integer input and rule intersection. |
| `src/core/armor-engine.mjs` | Single verified return boundary; no invalid Scratch/Inventory witness reaches the renderer; Upgrade snapshots and explicit execution comparison. `orderByRuleSatisfaction` partitions satisfied witnesses ahead of approximations. |
| `src/core/upgrade-optimizer.mjs` | Preserve null physical data, distinguish no installed Tuning, retained-identity assertion, assignment validation, complete cache keys and cloning, snapshot payloads. |
| `src/core/inventory-plan.mjs` | Physical-base matching, capability-aware dedup, reconstruct the existing assignment without re-optimizing it. Plans are additionally marked `rulesFeasible` from the bound `constraintModel` and ranked on it first. |
| `src/core/solver.mjs` | A proven fuzzy rule set returns every verified candidate behind the globally proven witness instead of collapsing the plan list to one entry. |
| `src/core/inventory-solver.mjs` | Resource ceilings/statistics, deterministic ties, explicit incomplete proof metadata. |
| `src/core/solver.mjs`, `target-constraints.mjs`, `reachability.mjs` | Integer prefix ranking, centralized visible/armor conversion, isolated/lossless reachability cache. |
| `src/core/dim-csv.mjs`, `bungie-inventory.mjs` | Canonical fixed Tuning and confidence/no-installed-assignment information. |
| `src/core/armor-mod-assignment.mjs`, `bungie-loadout.mjs` | Missing-piece/evidence failures, source binding, expected sockets and actual-total read-back. |
| `src/app.mjs` | Display/save/export verification, per-piece rows, remove pre-search rule reimplementation, keep unknown results out of success UI. Owned-armor and theoretical plans render as one rule-ordered list with per-entry owned/gap pieces; the old theoretical picker and the partial owned-gear list are gone. |
| `tests/witness-consistency.test.mjs`, `tests/v3-differential.test.mjs`, `tests/helpers/reference-witness.mjs` | New regressions, independent oracle, seeded tests, corruption and round trips. |
| `tests/unified-loadout-list.test.mjs` | Unified-entry comparator and dedup-key regressions, plus a proven fuzzy rule set that must keep every rule-satisfying plan. |
| `tests/inventory-plan.test.mjs`, `scripts/browser-smoke.mjs`, `check-upgrade-plan.js` | Concrete physical fixtures and integration assertions without relaxing existing expectations. |
| `scripts/benchmark-v3-realistic.mjs`, `package.json`, `docs/benchmarks/*` | Reproducible stress harness, commands, measured raw records and comparison. |
| `docs/architecture.md`, this document | Updated boundary and explicit merge limitations. |

## Added test domains

- `tests/helpers/reference-witness.mjs`: independent forward rebuild and exhaustive
  armor/Tuning/mod enumeration. It imports only model constants, not production
  normalization, scoring, search, or verification.
- Scratch: 120 generated-reachable cases, seed `0xc0ffee`, all six Balanced
  counts, +5/+10 mods; repeated inline/direct canonical comparison; JSON
  presentation round trip.
- Inventory: 8 randomized inventories, 2..6 items per slot, seed `0xc0ffef`;
  exhaustive optimum/feasibility, Exotic/set combinations, priority tiers,
  reversed-input determinism and independent result rebuild.
- Restricted residual oracle: 16 exhaustive Tuning/mod domains, seed `0x0fac1e`.
- Upgrade: 256 immutable-assignment cases (`0x51a7e`) and 64 production evaluator
  cases (`0xa1160`) covering manual/reassign/onlyPlus5/Exotic/unknown data.
- Corruption: all six fixed destinations, source/base/Exotic/missing armor,
  mod stat/size, fragment, displayed total and masterwork metadata.
- Clamp matrix: 20 combinations of fragments -20/-10/0/+10/+20 and visible
  0/1/199/200. Cache poisoning, identity replay and resource-limit regressions.
- Existing randomized Upgrade script: seed 4242, 80 input loadouts plus its
  dedicated +5-roll scenario; now also calls the consistency assertion.
- Browser DOM round trips on Scratch, Upgrade and owned-inventory displays;
  mocked Bungie write/read-back integration, with no real writes.

Measured Before/After and raw records are in
[the benchmark comparison](benchmarks/v3-comparison.md).

## Executed verification

Final full Node suite: **284 / 284 passed**, 0 failed, skipped or cancelled,
222,662 ms, after the frontier interning change. This includes 120 generated
reachable cases (the previous 24-case run was expanded), the independent
reference domains and the new corruption/identity/cache/snapshot regressions.

| Gate | Actual result |
| --- | --- |
| `npm run lint` | passed, zero warnings |
| `npm test` / `node --test --test-reporter=spec` | 284 passed |
| `npm run test:upgrade` | passed; 80 generated inputs, 50 plans rebuilt, +5-only dedicated case passed |
| `npm run build` | passed; existing large-bundle warning retained |
| `npm run verify:offline` | passed through file:// |
| `npm run test:browser` | passed: portal, Worker, DOM round trips, target sync, 390px and mocked Bungie OAuth/writes/read-back |
| Bungie request isolation | 43 mocked requests handled, 0 escaped requests in final smoke run |
| `node scripts/benchmark-solver-v3.mjs` | passed all existing timing/memory/rebuild assertions |
| realistic 1300 benchmark | completed all 6 Inventory scenarios plus Upgrade; raw outcomes and resource limits recorded |
| `git diff --check` | passed |

Two skill-requested read-only review agents hit a service 429/retry limit. One
returned useful interim findings on missing execution evidence and cache
mutation, independently reproduced locally. Neither agent review is counted
as a passed gate. The independent **test oracle** is implemented and executed;
it is not a substitute for the unfinished human/agent review.

## Remaining limitations and merge gate

The full requested acceptance bar is **not** yet a formal completeness claim:

- Reassigned Inventory still uses the bounded production modifier evaluator.
  The added full-inventory optimality differential domain fixes assignments;
  the separate residual differential covers small reassignment domains. This
  is not exhaustive equivalence of every production inventory/reassignment
  combination. A miss remains `SEARCH_LIMIT_REACHED`.
- The broad Upgrade fuzzy/partial fallback remains heuristic. Verified found
  witnesses are useful, but neither no-result nor nearest-result is a global
  proof. Visible clamp intervals are not searched by a new complete oracle.
- Fragment input is an aggregate vector, not an enumerated legal subclass build.
  Direct equip requires matching the character's existing subclass. Arbitrary
  aggregate Fragment vectors cannot prove that a legal Fragment selection exists.
- DIM shared links carry a bag of mods; DIM may assign them again. They are an
  export, not a per-instance execution certificate. The direct Bungie path is
  stricter and checks identity/socket/totals, but real live-game acceptance has
  not been exercised in this task.
- Compact manual-owned entries without exact six-dimensional base data cannot
  establish a real inventory match. The UI can keep them as user notes; they
  are not an executable physical witness.
- Benchmark heap/ArrayBuffer values are end-of-search samples, not exact V8
  heap high-water telemetry. `maxRSS` is a true OS process high-water measure.
  The varied 1300 cases hit deliberate resource limits, so their timing must
  not be advertised as an equivalent complete-search speedup.

Recommendation: **NEEDS MORE WORK** against the user's complete acceptance
criteria. These changes close reproduced bug classes but do not justify a
blanket claim of formal correctness, global optimality, legal Fragment
selection, or exact DIM execution. Keep uncertain paths explicitly limited or
unverified. Wrong answer is worse than no answer.
