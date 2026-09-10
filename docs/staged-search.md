# Request-scoped staged search

Based on develop `fc31d9b`. No model rules change with effort selection.

## Contract

UI requests use `{type:"start", id, generation, operation, payload}`. Worker
responses are `progress`, `result`, or `error` and echo identity/generation.
Progress carries a verified result plus separate `search` metadata; a heartbeat
may carry no result. The UI must never reuse the previous request's certificate
for a heartbeat. New requests terminate the same operation's old Worker;
changing inputs/mode cancels all affected operations. AbortSignal and explicit
cancel are also supported by the inline adapter.

`search` exposes elapsedMs, nodes, firstExactMs, firstFeasibleMs, running,
termination, stageMs and coverage. A certificate alone establishes mathematical
truth. Coverage/run completion is orthogonal. An exact incumbent remains proven
when a budget is reached; no limit can create an infeasibility proof.

## Effort profiles

| Profile | Time budget | Inventory nodes / retained states | Behavior |
| --- | ---: | ---: | --- |
| Fast | 200 ms | 100,000 / 10,000 | bounded verified incumbent |
| Balanced | 3 s | 2,000,000 / 50,000 | default search, progressive candidates |
| Deep | 120 s | 500,000,000 / 2,000,000 | physical inventory frontier within budget; bounded assignment, proveFuzzy for Scratch |

Theoretical searches count much smaller primitive probes, so their Balanced /
Deep node ceilings are 50 million / 500 million. Deep permits up to 5 million
full evaluations, separately from its 2 million retained-state limit.
The 150/500/1500/3000 ms stages
are checkpoints in one live invocation, **not repeated searches from scratch**.
Progress messages are throttled; incumbent retention and first-exact detection
are not. Deep continues after the 3-second stage until its own limits.

100–200 ms is a first-feedback goal, not an existence or timing guarantee.
No qualifying witness is fabricated when none was found. Cold index creation,
normalization, validation and a currently executing primitive can overshoot a
checkpoint budget. The browser can immediately terminate a Worker; offline
inline execution is cooperative and cannot pre-empt a synchronous primitive.
Fast or a budget-limited run need not choose the same canonical representative
as an exhaustive run. Adapter equality tests use a completed Deep domain.

## UI truth boundary

`solver-presentation.mjs` projects certificate status/statResults only; scores,
legacy allReached flags, top-level aliases and missing certificates cannot
promote a result. The UI serializes user controls into a request but does not
recompute constraint satisfaction, clamp inverses or a refined target. Old
results can remain visible after stopping, explicitly labelled stopped/stale.
Generic empty-result copy must not infer missing inventory or impossible sets.

## Single-item Bungie reconciliation

Transfer/equip returns a server read-back status: verified, failed (observed
mismatch), or unverified (missing data/read failure). One retry handles stale
profile data. Non-success or ambiguous write responses are also reconciled;
write requests are never replayed to guess whether a timeout succeeded.
UI ownership/equipped state is updated only from locations returned by the
verified server snapshot, including available auxiliary items. It no longer
predicts move-aside/source-replacement state from the write plan. An uncertain
partial result requires refresh.

## Verification

`tests/search-session.test.mjs` covers profiles, progress/terminal ordering,
node/time limits, retained exact evidence, monotone coverage, certificate-only
presentation, and all-operation generation cancellation. The browser smoke
adds actual built-Worker progress and explicit UI cancellation. Bungie unit tests
cover stale readback, wrong equipment state and missing profile evidence.
`node scripts/benchmark-staged-search.mjs` emits timing/coverage/status records.

Local staged benchmark (Node v24.14.0, single run): the default six-exact Scratch
query published a verified exact incumbent in about 20 ms cold / 7–9 ms warm,
then Balanced continued to ~671 ms; the 100-item fixture published exact at
~10–18 ms and completed at ~20–32 ms. These are measured fixtures, not an SLA
for arbitrary targets. Fast may return an explicitly non-feasible incumbent.

Independent Standards review found incumbent throttling, inline budget error,
unenforced node ceilings and terminal downgrade/coverage regressions. Their
original cases now pass dedicated tests. Independent Spec review found stale
UI generations/empty-result claims, missing refinement lifecycle, Deep DP/cache
limits and ambiguous single-item write paths; these have been corrected.

Existing dependency audit (2 moderate / 2 high at installation) and large-chunk
warnings are not changed by this feature. No dependency versions were changed.

## Validation record

- Full Node suite: **313 passed**, no failures/skips (178,236 ms locally).
- Final read-back snapshot integration: Bungie + session tests **35 passed**.
- `npm run lint`, build and `git diff --check`: passed.
- Browser smoke: built Worker progressive exact messages, generation echo,
  Fast/Deep controls, explicit cancellation, 390px layout and mocked Bungie
  request isolation; passed with zero requests escaping to Bungie.
- `npm run verify:offline`: passed through file://.
- `npm run test:upgrade`: 50 plans verified, including the fixed +5 scenario.
- `node scripts/benchmark-staged-search.mjs`: all profile/result assertions passed.

### Standards review

Four original counterexamples (dropped exact incumbent, inline budget errors,
node-limit enforcement and terminal downgrade) were independently re-tested and
closed. The final coverage inconsistency was fixed by marking budget terminal
coverage incomplete and recording its termination reason.

### Spec review

Stale certificate reuse, button-driven changes, old-finally interference,
refinement lifecycle, Deep DP/cache effort and ambiguous Bungie paths were
reviewed and corrected. The last two follow-ups were closed: applying a target
suggestion invalidates the old request, and Upgrade's internal Scratch fallback
receives Deep `proveFuzzy`. No unlimited/global-completeness guarantee is added.
