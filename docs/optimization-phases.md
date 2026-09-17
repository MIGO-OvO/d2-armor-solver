# Four-stage optimization

Baseline: `develop@49ffc5b`. Each stage is a separate commit on develop.
No remote push, deployment, dependency installation, real account operation,
or user-data migration is part of this work.

## Scope

1. Reliability: correct Cross Save platform selection and fail honestly when
   browser persistence or serialization is unavailable.
2. Interaction: truthful search states, modal focus isolation, stable editor
   focus, keyboard result navigation and complete table semantics.
3. Computation: compact proof identities, prepared cross-worker requests and
   conservative total-stat reachability pruning; preserve witness verification.
4. Experience and maintainability: target-first narrow-screen layout, direct
   rule selection, deferred inventory catalog loading, data/document checks.

OAuth changes are explicitly deferred by the user, including client type,
secret handling, token exchange/refresh and deployment configuration. Existing
security limitations remain; these commits must not be described as fixing them.

## Validation

Use focused failing regressions before fixes, Node tests and lint at each stage.
Run production/browser verification for interaction changes and differential,
resource-budget and transport tests for algorithm changes. Finish with offline
and desktop frontend verification. Performance timings are observations, not
portable guarantees; semantic and payload-size assertions are the stable gates.

## Stage results

Results and remaining limitations are recorded as each stage is completed.

### Stage 1 — reliability

Cross Save now compares platform types, with ordering/int64 regression fixtures.
Unavailable storage and serialization errors report failure without overwriting
the last valid record. The four targeted regressions failed before the fix.
OAuth and token handling are unchanged.

### Stage 2 — interaction

Search initialization now announces idle instead of a fictitious cancellation.
Running/cancelled candidates no longer display budget-exhaustion warnings.
Shared overlay focus isolation works through the desktop bridge's nesting;
armor edits restore logical-field focus. The result list has a single Tab stop
and arrow/Home/End navigation; armor rows expose cell/rowheader semantics.
`npm run test:interaction` exercises these behaviors in an isolated browser with
external requests blocked. Initial browser and lifecycle regressions failed
before the fix; focused checks now pass at desktop and 390px widths.

### Stage 3 — computation

Proof identities now use SHA-256 over the entire canonical domain, not a reduced
capability projection. Internal producer provenance and witness rebuilding are
unchanged. RFC 6234 constants/rounds are checked against Node's independent
crypto implementation over UTF-8 and padding boundaries. Caller-owned proof
inputs are snapshotted and frozen before caching; replacing a budget/context or
operation invalidates the identity. Older saved snapshots remain user data.

Verification Workers retain one prepared inventory per batch; later merges send
only the batch id and results. Restart/recovery sends the complete request again;
stale ids reject, and batch cleanup terminates the registry-owning Worker.

Exact interior-point inventory queries gain a capped suffix total-stat set.
Directional/empty tuning conserves total, Balanced contributes three, and mods
contribute their explicit or conservatively relaxed budget. Clamp intervals,
unknown data and oversized sets disable this pruning instead of truncating it.
The exact-existence budget contract and conservative negative-proof status stay
unchanged. Resumable search is not introduced in this change.

Measured with the existing synthetic fixtures (Node v24.20.0, local Windows):

| Metric | Baseline | Updated |
| --- | ---: | ---: |
| 1300-item / one-result JSON bytes | ~14,153,000 | 41,245 |
| One saved witness JSON bytes | 4,737,793 | 33,872 |
| Proof identity characters | 3,817,172 | 109 |
| 150-item conserved-total negative exact nodes | 3,636,481 | 1 |

These are structural/resource measurements, not a promise of faster CPU time
for every cold query. Full Node suite: 536 passing. V3 benchmark, lint,
production build and browser interaction regression passed.
