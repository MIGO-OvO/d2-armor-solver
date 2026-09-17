# Optional Tuning, consistent ranking and responsive computation

Baseline: `develop@f2e6a43079e5abe02bf9e35c55e25fa318bb08bf`.
This change does not add dependencies, migrate/delete saved builds, change
Bungie write operations or relax physical armor identity/socket verification.

## Search domain

Every eligible piece can leave its Tuning socket empty. Balanced adds one point
to each of the three framework-defined masterwork stats; directional Tuning
moves five points between distinct stats and retains the owned piece's immutable
destination capability. The no-Balanced (`onlyPlus5Tuning`) filter forbids
Balanced, not empty sockets. Explicit Balanced and +5/+10 armor-mod counts remain
exact budgets, not suggestions.

Point, interval, partial-configuration, fixed-five optimization and theoretical
search use the optional zero action. The reachability DP uses the same domain.
Proof ruleset identities include `optional-tuning-v1`, so a negative proof made
over the old mandatory-Tuning domain cannot be reused for the larger domain.
Unknown directional capability never authorizes a direction; it does not forbid
an empty socket. Unknown base stats still cannot authorize a verified witness.

Equal aggregate states retain the lower installation cost. Contextual fixed-five
optimization also retains current-assignment information in its state/cache
identity: minimizing changed sockets cannot be reconstructed after the relevant
assignment has already been discarded. Stat-mod decompositions and physical
slot placement likewise preserve the lowest mathematical socket-change cost.
This is not a claim about minimum executable cost under unknown game sockets.

## Ranking

Search and Upgrade share a nine-component integer quality tuple:

`[any explicit rule violated, high count/gap, medium count/gap, low count/gap, ordinary count/gap]`

Each count is the number of unsatisfied stats in that priority tier. Gaps are
absolute for exact rules, one-sided for minimum/maximum rules, and zero inside
legal intervals. All explicit rules being satisfied wins before preferences.
Implicit preferred targets are not silently promoted into hard rules. Upgrade's
unqualified targets retain their historical >= satisfaction semantics, while
required-stat flags are translated into explicit floors at the caller boundary.
The leading component is Boolean, never the total count across priority tiers.

The same comparator is used for candidate selection, refinement and admissible
score bounds. Because the leading feasibility bit combines with OR, residual
components and K-best prefixes retain separate feasible/infeasible classes;
ordinary lexicographic truncation before combining them would be unsafe.
A lower-priority surplus cannot pay for a higher-priority miss.
The legacy scalar score is not authoritative mathematical evidence or ranking.
After rule quality and ownership/replacement priorities, installation and socket
change costs are compared separately. A local neighborhood completion flag is
not a proof of global inventory optimality. Truncation cannot certify infeasibility.

## Execution and presentation

- Foreground solving, reachability and nearest-target suggestions have separate
  request ownership. Starting/stopping a search invalidates pending preview timers.
  Suggestions explicitly use the Fast profile.
- Idle workers survive cancellation; active synchronous jobs can still be
  terminated immediately. Test/process teardown uses `dispose: true`.
- Repeated mathematical range inputs reuse a bounded cache, including changes
  to an unlocked target that do not change the range query.
- Owned/farming matching and cross-shard witness verification execute in workers.
  The main thread consumes verified plans rather than running residual searches
  during rendering. Plan-cache keys bind candidate, rules and inventory inputs;
  inventory progress alone cannot invalidate theoretical matching.
- Derived-plan requests are single-flight and revision checked. Progress updates
  are frame-coalesced; unchanged candidate content does not rebuild the workbench.
- The file:// package embeds the same engine as a self-contained Blob worker;
  it does not fetch modules or contact a network. When browser workers are truly
  unavailable, the UI reports unavailable computation instead of freezing in a
  synchronous fallback. Inline execution remains a non-browser testing adapter.
- Reachability shares a locked-state traversal across unlocked-stat projections.
  These are per-stat reachable sets, not an assertion that arbitrary values
  selected independently from every range form one jointly feasible loadout.

## Reproducible checks

`scripts/benchmark-complete-optimization.mjs [source-root]` runs the same synthetic
cases against this checkout or an isolated baseline. It prints JSON and does
not write to the supplied checkout. CPU measurements are not browser INP.

The baseline's four-Balanced/one-empty theoretical point had zero witnesses;
the new domain finds a witness. The locked-five Gunner/super Upgrade case moves
from 4/6 rules met to a verified 6/6 by removing exactly one Tuning mod. The
fixed-five count-versus-gap case moves from 4/6 to 5/6 at the same priority.

On the seeded range fixture, sharing projections reduces visited states from
51,440 to 12,860 for two locks and 2,309,370 to 769,790 for three locks. This is
a deterministic work-count comparison; wall-time and allocation tradeoffs must
be measured separately. The existing dense four-lock join is retained.
The paired observations and browser heartbeat record are retained in
[benchmarks/complete-optimization.json](benchmarks/complete-optimization.json).
The four-lock cold case remains around three seconds on this fixture; the
responsiveness improvement does not imply that every CPU query became faster.

Validation entry points:

```text
npm run lint
npm test
npm run test:upgrade
npm run benchmark:v3
npm run test:browser
npm run build
npm run test:optimization
npm run verify:offline
npm run desktop:test
git diff --check
```

The browser optimization check measures real worker creation/query counts and
event-loop heartbeat latency on synthetic inputs. It asserts cached range reuse,
foreground/preview isolation, no resurrection after stopping, and no remote
requests. Heartbeat latency is not INP and is reported as such. Browser smoke
retains desktop/390px layout and mocked account/write-flow checks. Builds that
write the same output directory must be run sequentially.

Final validation on the frozen source:

- ESLint: zero warnings/errors; full Node suite: **518/518**, zero failures,
  cancellations or skips (serial run, 346.96 seconds).
- Upgrade simulation: 49 returned plans independently reconstructed and verified.
- Full browser smoke: both phases passed, including 44 handled mock Bungie
  requests and zero escaped account requests. Production assets were rebuilt
  afterward to replace the smoke test's mock-credential bundle.
- Desktop verification passed CSP, local resources/Worker, saved-build reload,
  three languages, Upgrade, CSV import/reload, keyboard and six window sizes.
- file:// verification passed with a Blob worker, zero remote requests and no
  page errors. The focused browser scheduling test and original performance
  gate also passed; retained operation memory was 19.6 MiB against 96 MiB.
- Independent integration review rechecked the Worker-unavailable error path,
  optional-Tuning fallback identity, two-class ranking bounds and real socket
  cost baselines. Its actionable findings were fixed and regression tested.
- The UI detector reported no findings; `git diff --check` passed.

## Remaining boundaries

Distinct physical/math combinations can still require exponential search. A
verified positive witness proves existence, not globally optimal Top-K. The
complete exact-inventory phase remains separately cancellable and is not a
universal 200ms/3s timing guarantee. Deep's shard budgets remain per-shard.
Execution can remain UNVERIFIED when imported socket information is unknown.
Large bundle warnings are not suppressed or represented as resolved here.
The browser heartbeat probe observed one 51ms task including presentation work;
this is not a claim that every main-thread task now fits inside 50ms.
