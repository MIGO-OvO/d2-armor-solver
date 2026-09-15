# Solver responsiveness and recovery regression

## Scope and audited causes

Base: `develop` at `1d4b7c5`, with exact-inventory correctness from
`07915db`. No search-math module, domain, oracle, verifier, residue table,
pressure ordering, or certificate constructor is changed by this repair.

The ordinary call chain was `solve()` → **await inventory** → theory.
Inventory called the adaptive scheduler, cloned the vault into a worker pool,
and gave every physical shard the full profile budget. Non-point constraints
used physical Cartesian size in the scheduling estimate. On the 16-thread
test machine a 1300-item fuzzy vault selected seven workers, even for Fast.
The Balanced negative control visited 351,372 aggregate nodes with automatic
scheduling versus 50,196 with one worker: exactly seven copies of the budgeted
work pattern. CPU availability was inadvertently being treated as permission
to increase search effort.

Cross-shard progress re-created the whole-vault problem and verified retained
witnesses on the UI thread every 150 ms. A catch handler aborted sibling
requests without retaining the merge/import error; the public promise then
reported `AbortError`. Theory had no runtime transport fallback. The inventory
fallback could move a complete exact-existence traversal directly onto the UI
thread after a worker pool failed.

## Repair

- Automatic inventory admission: Fast/Balanced one worker and one shard;
  Deep at most four, still respecting CPU, memory and task estimates. Explicit
  benchmark/test overrides remain available. Per-shard budgets are disclosed;
  this is not presented as a new batch-global budget implementation.
- Theory starts first; owned existence starts independently and updates its
  own results/messages. Theory completion releases its controls without
  cancelling owned existence. Search and inventory revisions guard progress,
  terminal messages and cleanup; a new search cancels previous operations.
  Stop stays available while either search is pending. New searches clear
  old theory witnesses so an early owned result cannot project old targets.
  Changing set/inventory inputs cancels an invalidated background inventory
  request without cancelling an otherwise valid theory request.
- Single-shard results retain worker verification and skip cross-shard merge.
  Multi-shard progressive merge requires a newly seen verified positive
  canonical witness and is coalesced at one second. This admission signal
  does not trust serialized evidence: every published merged witness is still
  reconstructed and verified against the whole vault. Final merge is complete.
- Progressive/import errors are retained through sibling cancellation; the
  publication promise is drained before final return. Original error identity
  and stack survive. `solverFailure` distinguishes transport, solver and merge;
  a solver error cannot opt into retry merely by using a transport-like name.
- Ordinary transport failure retries once on a replacement worker, then uses
  inline execution. A failed inventory pool first drains surviving workers,
  then tries one replacement worker, then one sequential inline consumer.
  Only failed shards are replayed. Cancellation, stale generations and logic
  exceptions never retry. Late events from a terminated worker cannot kill
  its replacement.
- Inline inventory recovery waits for theory handoff and yields before
  entering synchronous search. Once synchronous inline exact search starts,
  it remains non-preemptible; Worker execution is the responsive normal path.

## Proof boundaries retained

Exact mathematical quotient existence is still independent of Top-K,
evaluation quota and ordinary Fast/Balanced deadline. No exact-inventory hard
timeout was added. Residue pruning, signed joint bounds, Empty/Balanced/
Directional Tuning, modifier counts, fixed Exotic identity, class/slot and
4pc/2+2 set constraints, physical witness expansion, and V3 witness sealing
are unchanged. Unknown capability data cannot create a complete negative
proof. Serialized shard coverage is never promoted to a global infeasibility
certificate, even when all workers finish.

The new no-witness stress fixture has 12 groups in each of five slots
(248,832 quotient tuples). Every residue is compatible modulo five; mandatory
directional tuning makes Weapons 0 modulo ten, whereas the target is 95.
It visits 15,757 exact states, prunes none by residue and exhausts exact
existence even with a deterministically expired ranking clock. Tests assert
state/domain properties, not fragile wall-time thresholds.

## Benchmark method and interpretation

`scripts/benchmark-solver-recovery.mjs` runs isolated Node worker-thread
processes with the production client and production search profiles. It
compares one worker with automatic admission for Fast/Balanced/Deep, five-item
inventory, 1300-item ordinary duplicate-heavy inventory, 1300-item crowded DIM
inventory, and a Fast/Balanced fuzzy large-inventory control. Positive and no-exact cases
use the same source items. The fuzzy negative control means no exact target;
it may legitimately return `RULE_FEASIBLE_PROVEN` because its constraints are
not all exact.

Reported wall time includes both solvers. `inventoryMs` is inventory completion;
`firstTheoryMs` is the first theory publication (or completion if none was
published), and `firstExactMs` is the first verified owned exact witness.
Nodes, exact states and mathematical evaluations are separate because session
`nodes` can be zero during a nonzero exact-existence traversal. Memory is
process RSS sampled every 10 ms, including worker threads; merge time includes
witness verification; event-loop delay uses a 10-ms timer. Worker count is the
inventory pool, excluding the independent theory worker. No DOM-render cost
is included in these numbers; browser tests exercise the real UI separately.

Before uses an isolated source snapshot of `1d4b7c5` and the audited serial
UI order. After uses the repaired client and independent order. No production
profile limit is shortened for the benchmark. Deep can spend 120 seconds on
inventory and another 120 seconds on theory before this repair; an initial
180-second harness timeout was therefore increased to 330 seconds and timed
out rows rerun. This was a harness timeout, not a solver error or negative proof.

Raw data is saved under `docs/benchmarks/solver-recovery-*.json`. These are
single-run engineering measurements on Windows/Node 24, not statistical
latency guarantees. Some baseline runs overlapped repository validation; node
counts, worker counts and proof results are stronger evidence than small
differences in elapsed time. Worker failure recovery is tested by injected
transport faults, not by claiming an operating-system OOM was reproduced.

Reproduction (PowerShell):

```powershell
$env:BENCH_SOURCE_ROOT = 'C:\path\to\1d4b7c5-source-snapshot'
node scripts/benchmark-solver-recovery.mjs before
Remove-Item Env:BENCH_SOURCE_ROOT
node scripts/benchmark-solver-recovery.mjs after
```

`BENCH_PROFILES`, `BENCH_CASES` and `BENCH_RESUME=1` permit selective reruns
without changing solver budgets. A source snapshot needs `src/` and `tests/`;
the test worker host imports that snapshot's production worker.

## Interactive measurements after repository checks finished

The three additional 32-case runs are sequential, without concurrent repository
tests/builds: [parent `07915db`](benchmarks/solver-recovery-parent.json),
[before `1d4b7c5`](benchmarks/solver-recovery-before-interactive.json), and
[repaired](benchmarks/solver-recovery-after-interactive.json). Parent `auto`
reproduces its UI's explicit `min(4, hardwareConcurrency)` policy, rather than
the old API's default of two. Parent merge timings were not instrumented and
are recorded as `null`, not invented as zero.

Automatic policy, milliseconds rounded. `+` is a generated exact target;
`−` is the no-exact control. `—` means no exact witness. First-owned timings
below compare `1d4b7c5` with the repair, not the parent.

| Profile / inventory / outcome | Parent wall | Before wall | After wall | First theory before → after | First owned exact before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fast / small / + | 402 | 502 | 251 | 499 → 110 | 192 → 116 |
| Fast / small / − | 490 | 441 | 274 | 383 → 121 | — |
| Fast / large / + | 743 | 542 | 382 | 539 → 105 | 408 → 380 |
| Fast / large / − | 1,193 | 540 | 434 | 487 → 110 | — |
| Fast / crowded DIM / + | 850 | 566 | 407 | 555 → 118 | 425 → 406 |
| Fast / crowded DIM / − | 862 | 563 | 488 | 503 → 167 | — |
| Balanced / small / + | 1,551 | 1,636 | 983 | 524 → 116 | 217 → 124 |
| Balanced / small / − | 1,740 | 1,590 | 1,774 | 413 → 112 | — |
| Balanced / large / + | 2,057 | 1,606 | 1,199 | 690 → 118 | 404 → 537 |
| Balanced / large / − | 3,364 | 2,907 | 1,605 | 1,669 → 118 | — |
| Balanced / crowded DIM / + | 3,919 | 3,854 | 3,125 | 3,245 → 128 | 442 → 437 |
| Balanced / crowded DIM / − | 6,429 | 6,258 | 3,141 | 3,276 → 113 | — |
| Fast / fuzzy large / + | 894 | 794 | 444 | 789 → 158 | — |
| Fast / fuzzy large / − | 748 | 845 | 357 | 831 → 113 | — |
| Balanced / fuzzy large / + | 1,764 | 1,983 | 1,125 | 998 → 122 | 793 → 520 |
| Balanced / fuzzy large / − | 2,383 | 3,534 | 1,916 | 2,885 → 112 | — |

Resource regression controls, `1d4b7c5` → repaired:

| Fuzzy 1300-item case | Inventory workers | Aggregate nodes | Peak RSS (MiB) | RSS growth (MiB) | Max event-loop delay (ms) | Merge + verification (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Fast, positive | 7 → 1 | 0 → 5 | 558 → 145 | 510 → 96 | 149 → 87 | 97 → 0 |
| Fast, no-exact | 7 → 1 | 0 → 5 | 553 → 140 | 505 → 92 | 179 → 29 | 102 → 0 |
| Balanced, positive | 7 → 1 | 721 → 103 | 960 → 235 | 912 → 187 | 271 → 47 | 234 → 0 |
| Balanced, no-exact | 7 → 1 | 351,372 → 50,196 | 1,040 → 251 | 992 → 203 | 405 → 31 | 553 → 0 |

The repaired Balanced fuzzy no-exact **one-worker and automatic** runs both
visit exactly 50,196 nodes and perform 48 mathematical evaluations. The old
automatic run performs 351,372 nodes and 336 evaluations. Fast's zero-node
rows exhausted the short ranking budget during setup; zero nodes does not
mean zero CPU cost. The worker/vault setup and merge costs are visible in
wall time, RSS and event-loop delay.

This is not a universal per-inventory speedup claim. Concurrent theory can
increase memory versus an already-single-worker exact input (Balanced large
positive: 197 → 239 MiB) and delay the owned witness (404 → 537 ms), while
making theory available much earlier and reducing total wall time. The small
Balanced no-exact wall-time sample is slower (1,590 → 1,774 ms); single-run
timing variance and concurrent solver contention remain. Cross-shard stalls
are eliminated for interactive profiles, but GC/clone/render stalls are not
proven impossible. Compared with the pre-regression parent UI, the large and
crowded interactive cases all complete faster in this run.

Both full matrices ([before](benchmarks/solver-recovery-before.json),
[after](benchmarks/solver-recovery-after.json)) plus these three runs total
184 completed scenarios: no solver errors, every returned witness verified,
all point-exact positive cases retain exact witnesses, and no no-exact control
is labelled exact. Raw rows include the one-worker controls, inventory-only
completion time, exact states, evaluations and all resource measurements.

## Deep full-budget measurements

Automatic policy, `1d4b7c5` → repaired. Time columns are rounded; `—` means
no exact witness. These rows come from the full `before`/`after` matrices.

| 1300-item case | Both solvers wall (s) | First theory (ms) | First owned exact (ms) | Aggregate nodes |
| --- | ---: | ---: | ---: | ---: |
| Large, positive | 121.803 → 120.213 | 120,435 → 140 | 890 → 699 | 117,922,449 → 79,360,409 |
| Large, no-exact | 240.520 → 120.392 | 120,543 → 144 | — → — | 23,957,399 → 15,710,880 |
| Crowded DIM, positive | 121.539 → 120.153 | 120,405 → 142 | 1,286 → 913 | 20,633,012 → 17,658,900 |
| Crowded DIM, no-exact | 240.578 → 120.344 | 120,593 → 165 | — → — | 2,051,422 → 1,217,563 |

| 1300-item case | Inventory workers | Peak RSS (MiB) | RSS growth (MiB) | Max event-loop delay (ms) | Merge + verification (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Large, positive | 7 → 4 | 1,272 → 841 | 1,223 → 782 | 298 → 183 | 344 → 177 |
| Large, no-exact | 7 → 4 | 1,180 → 773 | 1,121 → 713 | 444 → 232 | 671 → 188 |
| Crowded DIM, positive | 7 → 4 | 1,206 → 780 | 1,149 → 721 | 623 → 258 | 544 → 230 |
| Crowded DIM, no-exact | 7 → 4 | 842 → 618 | 785 → 560 | 202 → 143 | 109 → 110 |

Deep still deliberately spends its full budget on these physical searches;
this repair does not claim every complete search is faster. Its repaired
large-positive one-worker run visits 30,834,543 nodes in 120.131 s versus
79,360,409 in 120.213 s with four workers. These are budgeted aggregate effort
measurements, not a claim that serialized shards prove global completeness.
Deep final verification can still cause noticeable main-thread stalls; the
interactive profiles avoid cross-shard merges altogether.

## Validation

| Check | Result |
| --- | --- |
| `npm test` | 470 passed; no failures/skips |
| Final targeted scheduler/client/UI/exact-inventory suite | 52 passed |
| `npm run lint` | passed |
| `npm run test:upgrade` | passed, 50 plans independently verified |
| `npm run test:browser` | passed, including delayed real inventory replies and crowded DIM witnesses |
| `npm run desktop:test` | passed, including production desktop frontend build and CSP/Worker/offline UI checks |
| `npm run verify:offline` | passed, including `file://` verification |
| Production Web build | passed |
| `git diff --check` | passed |

Existing Vite large-chunk and offline static/dynamic-import warnings remain;
they are not suppressed. No new runtime dependency is introduced.

The browser tests now wait for owned-search completion before asserting the
final owned list: awaiting `solve()` intentionally means theory completion.
The cancellation test holds only actual inventory final replies, allowing
theory and progress through, so it tests pending cancellation deterministically
instead of assuming a completed small search must still be running. The
original certificate, numeric, execution-state and retained-result assertions
remain in place.

Future scheduler changes should be gated on aggregate effort and UI latency,
not worker utilization alone. In particular, raising interactive worker/shard
counts requires a batch-global budget design plus measured responsiveness;
search-order heuristics must remain independent of completeness and resource
admission. The deferred-reply and fault-injection tests protect that boundary.
