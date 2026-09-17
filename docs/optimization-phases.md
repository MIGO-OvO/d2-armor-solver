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

### Stage 4 — experience and maintainability

The scratch workflow moves the existing target controls before optional inventory
and fragment inputs, preserving keyboard/visual order in both browser and desktop.
Phone layouts retain the original command bar at the bottom with a scrollable
secondary-action row; no core action is removed. Rule and priority controls are
native direct-choice selects with the same persisted values and three languages.

The inventory mapper is separated from its catalog-backed adapter. Existing
synchronous importers/tests retain their interface; the app imports the large
catalog only on profile import or execution read-back. The browser regression
asserts that theoretical solving and saved plans do not fetch the catalog.
The secret-less online app chunk changes from ~1.80 MB / 438 KB gzip to
~507 KB / 173 KB gzip. The deferred catalog is still ~1.30 MB; Vite's large-chunk
warning remains. Offline builds intentionally retain all data in one self-contained
bundle and continue to use their embedded Worker.

Added catalog version/identity/localization contract checks and CI execution of
the keyboard regression. Corrected outdated offline Worker and download-channel
documentation. No new dependency, framework migration or runtime data download
was introduced.

Full browser validation also caught two integration regressions, reproduced
before correction: modal background isolation hid the Undo action, and hover
details could move the saved-loadout Apply target between pointer-down and up.
Toasts now belong to the active modal; loadout details open only through their
explicit button. Regressions cover save/delete/undo and actual pointer clicks.
`BROWSER_SMOKE_SCOPE=bungie` runs only the fully mocked account integration loop
for focused diagnostics; ordinary smoke runs still execute every phase.

Final verification: 538/538 Node tests; lint; production build; V3 benchmark;
49 randomized upgrade plans; complete browser smoke (44 mocked Bungie requests,
zero unhandled/escaped requests); keyboard/Undo/mobile regression; browser
scheduling regression; file:// offline verification; desktop frontend build and
six-window-size verification. The final online output was rebuilt after the
fake-credential smoke build, so test credentials are not the delivered preview.

### Remaining boundaries

- OAuth client-secret exposure and token-refresh behavior are unchanged, by request.
- Exact existence still has exponential worst cases and is cancellable, not resumable.
- No real account writes, native Windows installer build, or physical-phone test
  was performed. Desktop verification covers its frontend/WebView contract.
- The design detector fell back to text scanning because optional parser
  dependencies were unavailable; browser observations are the visual evidence.
