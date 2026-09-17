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
