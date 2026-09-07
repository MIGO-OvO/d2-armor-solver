# Algorithm audit follow-up

Base: PR #3 `203830f8d41a7aefbbc913418e1f4d3d5bd25767`.
Implementation: `codex/algorithm-optimization`, separate from the dirty
`develop` checkout. No deployment or live Bungie writes are part of validation.

## Acceptance checklist

- [x] F1: 185-item late exact witness and ID relabeling regression.
- [x] F2: target-directed fixed-five Tuning/mod join in the production evaluator.
- [x] F3: hard-feasible candidates before priority fit and presentation limits.
- [x] F4: derive Balanced stats consistently; consume normalized budgets;
  reject conflicting probe/locks; separate mathematical and execution evidence.
- [x] F5: search physical slot permutations, preserve fixed Exotic/source slots,
  retain full candidate domains, and bind a separate displayed witness.
- [x] Visible clamp preimages constrained by total budget; interval range DP
  with explicit resource exhaustion and no negative proof on incomplete work.
- [x] Upgrade clamp-boundary replacement proof extension: smaller depths exhaust
  all budget-consistent preimages; exceeding the 128-point domain budget removes
  the minimum claim.
- [x] Independent audit regressions and existing differential tests.
- [x] Paired benchmark records (three fresh-process runs per version/scenario).
- [x] Full-suite/integration gate records below.

## Correctness boundaries

The streaming inventory search retains a five-piece path and a bounded result
list. Exact fixed-assignment point queries index two slots and stream three;
physical alternatives remain in matching buckets. DFS ordering is heuristic,
but pruning uses conservative remaining stat/set bounds. Node, retained-pair,
evaluation and time limits are distinct; a stopped search is incomplete.

An exact witness proves existence, not globally preferred identity or complete
enumeration. The fixed-five point join searches the declared Balanced/directional
domain. Nearest fuzzy reassignment remains explicitly bounded and cannot prove
global optimality or infeasibility.

Slot matching proves the best ownership count for each **provided** theoretical
witness and its legal permutations, not minimum farming over all theoretical
rolls hidden by upstream presentation grouping. The original witness is never
mutated. A mapped display witness is resealed with its actual slot mapping.

The default mod budget remains the selected items' installed +5/+10 counts.
This work does not silently redefine inventory queries as five arbitrary +10
mods, nor does an aggregate Fragment vector prove a legal subclass selection.

The API accepts numeric strings, so piece vectors and counts are normalized
before arithmetic. Unknown/stale candidates are verified before occupying an
Engine result slot or exact quota. Reachability caches which carry a witness
bind the complete fixed input, not only its mathematical stat signature.

The mask-equivalence optimization preserves Balanced contributions and the
ordered remaining directional capabilities. One hundred seeded evaluations
were compared directly against PR HEAD with identical full results. A safe
total-budget lower bound skips a redundant all-goals Upgrade fallback when it
is mathematically impossible; it does not rule out the user's smaller required
domain and never mints a negative certificate.

## Test updates with changed semantics

The two Legendary-direction negative fixtures now choose a direction incompatible
with **every equal-base descriptor**, because another legal slot permutation can
otherwise reuse the item. Their expected farming counts are unchanged.

Old clamp tests requiring SEARCH_LIMIT_REACHED unconditionally are replaced by
checks for an actual interval-complete producer. The independent no-false-proof
tests still reject point-only evidence for an interval and reject unknown data.

The full-masterwork Upgrade regression still requires exactly two replacements,
retains the locked Exotic and exact six visible totals, and now verifies the
projected base of every retained piece. Its hard-coded old heuristic pair is
not retained as a rule: complete preimage search may choose another equally
minimal legal pair. The Health=225 fuzzy test now requires a verified matching
armor value after the relaxation domain was corrected from 0..200 to 0..budget.

## Benchmarks

Hot-cache samples repeat mode 3 immediately, before the two-entry LRU can evict
it. Five samples report median and empirical P95. The 1300-item harness now also
places known solutions in the middle and at the end, and reports exact hits for
legacy engines without V3 certificates. "no-exact" is a perturbed target label,
not a claim that the fixture is mathematically infeasible.

Measured results and remaining limits follow.

### Paired 1300-item measurements

Windows, Ryzen 7 5700X3D, Node v24.14.0. Median of three fresh child-process
runs; empirical samples, not population confidence intervals. Each operation
includes Engine certificate/execution assessment. Raw input seeds, targets,
status, coverage and OS peak RSS are in
[algorithm-optimization-paired.json](benchmarks/algorithm-optimization-paired.json).

| Scenario | PR HEAD ms | Optimized ms | Before → after | Peak RSS MiB before → after |
| --- | ---: | ---: | --- | ---: |
| Easy exact | 151.9 | 159.3 | exact → exact | 95.4 → 96.5 |
| Varied / early known witness | 487.8 | 900.2 | exact → exact | 282.7 → 102.0 |
| Middle known witness | 499.6 | 365.5 | limited miss → exact | 281.1 → 147.7 |
| Late known witness | 507.7 | 322.4 | limited miss → exact | 282.1 → 138.6 |
| Perturbed target | 503.3 | 755.3 | limited miss → exact | 282.2 → 138.7 |
| Hard rules + reassignment | 621.0 | 3148.9 | limited miss → rule-feasible | 288.5 → 138.9 |
| Exotic + set | 498.7 | 866.0 | exact → exact | 253.5 → 123.1 |
| Equivalent items | 151.1 | 149.8 | exact → exact | 95.4 → 96.6 |
| Retained Upgrade setup | 12.6 | 10.3 | exact → exact | 44.7 → 43.0 |

The optimized early/set cases intentionally inspect up to two million streamed
triples and therefore take longer despite finding their first exact witness in
about 68 ms. The hard-rule case spends its 3-second budget improving verified
candidates. This is **not** a claim that every query became faster. Middle,
late and perturbed exact misses are eliminated in all three runs, and varied
inventory memory falls materially. These large searches remain explicitly
incomplete. A small 8-per-slot same-domain benchmark disables the witness quota
(`searchLimits.exhaustive=true`) and requires full frontier completion.

Final same-domain 8-per-slot query: **6.9 ms**, with `frontierComplete=true`;
the PR's original benchmark was about 565 ms in the initial audit. Exact
existence and the complete fixed-assignment domain were preserved, not replaced
with an early-witness cutoff for this measurement.

Final Scratch samples were 309.1–594.7 ms; five genuinely hot mode-3 samples
had median 466.1 ms and empirical P95 482.0 ms. Retained
per-operation post-GC delta remained 19.4 MiB, not a peak-heap measurement.

### Remaining product/model limits

- General Scratch fuzzy global optimality is opt-in and potentially expensive;
  K-best and bounded incumbent paths remain explicitly non-global.
- Fixed-five rule feasibility does not claim the best soft score among all
  feasible assignments. Inventory reassignment therefore still withholds a
  global negative/optimality certificate unless the producing domain supports it.
- Large Inventory uses limits rather than claiming full vault enumeration.
  `maxStates` bounds retained join pairs (and DFS work for compatibility),
  `maxNodes` bounds streamed triple probes, `maxEvaluations` bounds expensive
  five-piece evaluations, and `maxTimeMs` bounds interactive exploration.
- A provided theoretical witness's best owned matching is not the global
  minimum farming cost across unpresented rolls. Changing that objective or
  the installed-mod budget is a separate product/domain expansion.
- Very hard fuzzy Upgrade fallback can still take tens of seconds. The
  adversarial high-stat cap fixture remains roughly 69 seconds locally; no
  responsiveness/global-completeness claim is made for that legacy path.
- This worktree is based on PR #3. The user's 11 dirty develop files were not
  copied over or overwritten; integration with their partial/full socket policy
  remains a separate merge step. The math/execution known-data predicate now
  recognizes both legacy `known` and future `full` socket evidence.

## Independent review

### Standards

Two initially reproduced P1s (stale incumbent identity de-duplication and
fixed-source cache replay) were fixed and independently re-tested. The bounded
final review reported no remaining confirmed hard-standard violation. It
explicitly distinguished witness existence, completed coverage and global
optimality. The reviewer encountered one service retry failure, then resumed
and delivered its final report; the failed pass was not counted as approval.

### Spec

The reviewer independently reproduced then re-tested numeric-vector,
invalid-Top-K, partial-hard-rule and multiple-clamp findings, then confirmed the
final `force0 + partial exact` regression (~21 ms). All correctness counterexamples
it raised were closed. The ownership-matching performance concern was fixed by
the primary agent and has a 200-item execution-variant regression (~4 ms); that
performance result was not independently rerun. Its final summary retained the
explicit search-domain limits and made no unlimited global-optimality claim.
Persistent regressions are in `tests/solver-audit.test.mjs`.

## Executed gates

| Gate | Result |
| --- | --- |
| Full Node suite | 299/299 passed, zero failed/skipped, 134,383 ms |
| Final incumbent/lock change | affected Inventory/audit tests passed; focused stale-lock and force0 checks passed |
| `npm run test:upgrade` | 50 plans verified; dedicated fixed +5 one-replacement scenario passed |
| `npm run lint` | passed, zero warnings |
| `git diff --check` | passed |
| `npm run build` | passed; existing large-chunk warning remains |
| `npm run test:browser` | passed: portal, Worker, DOM round trips, 390px, mocked Bungie; 0 escaped requests |
| Built Worker clamp probe | numeric counts + raw Health 225 / visible Health 200 verified |
| `npm run verify:offline` | passed through `file://` |
| `npm run benchmark:v3` | all timing/rebuild/retained-memory assertions passed |
| Paired 1300 scenarios | 3 runs × 9 scenarios × 2 versions; raw records retained |

The full suite preceded the final small locked-incumbent source-resolution
change; the affected Inventory and audit files were rerun after it. Browser
and offline verification were rerun for the implementation and source build;
no live account mutation, deployment, commit or push was performed.

Independent-review summary: Standards closed two confirmed issues, with no
remaining confirmed hard violation at its bounded final pass; Spec closed five
correctness counterexamples and retained one performance result verified only
by the primary agent. The worst discovered issue was false infeasibility from
stale/unknown data, now covered by persistent regressions.
