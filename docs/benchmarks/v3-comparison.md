# PR #3 baseline / consistency follow-up benchmark

Host: Windows, AMD Ryzen 7 5700X3D (8 cores / 16 threads), Node v24.14.0.
Baseline `d221721`. All values below are measured,
not estimated. The baseline checkout was kept separate. These are single-run
local measurements, not confidence intervals; verification jobs on the same
machine introduce scheduling noise. No claim of a statistically significant
Scratch speedup is made.

## Existing V3 benchmark (milliseconds)

| Query | Before | After |
| --- | ---: | ---: |
| Scratch cold +3=0 | 769.7 | 666.4 |
| Scratch cold +3=1 | 631.2 | 605.1 |
| Scratch cold +3=2 | 679.2 | 745.5 |
| Scratch cold +3=3 | 542.7 | 599.8 |
| Scratch cold +3=4 | 365.4 | 363.1 |
| Scratch cold +3=5 | 788.2 | 682.1 |
| Scratch hot +3=3 | 751.7 | 732.2 |
| Inventory 8^5, fixed assignments | 866.7 | 889.7 |
| Maximum per-operation retained heap + ArrayBuffer, MiB | 19.3 | 19.4 |

All original benchmark assertions passed. The exact oracle, TypedArray residual
representation and mathematical domain are unchanged. Extra capability checking,
cloning, canonicalization and certificate verification add real work; +3=2,
+3=3 and Inventory show measured regressions, not silently omitted results.

The first pre-edit sample was cold `[988.2, 585, 748.6, 566.3, 446.3, 617.3]`,
hot 612.6, Inventory 949.6 ms, retained memory 19.1 MiB. The table is a later
paired baseline-checkout/follow-up measurement, showing the expected run-to-run
variation rather than selecting only favorable samples.

## 1300-item scenarios and Upgrade

The table below is the correctness-boundary build before the subsequent exact
capability-key interning optimization. The final measurements follow it, so
both regressions and the optimization's equal-domain comparison stay visible.

Seed: `318819070` (`0x1300cafe`). Five slots, 260 items each. Directional/Balanced
assignments, +5/+10 mods, varied physical bases, Exotic and set scenarios.
Each scenario runs in a fresh child with a 512 MiB old-space cap and 30-second
external deadline. Limits are identical for baseline/follow-up harnesses.

| Scenario | Before ms / outcome | After ms / outcome | Complete frontier after? |
| --- | --- | --- | --- |
| Easy exact | 73.9 / exact | 161.2 / exact | yes |
| Varied generated exact | heap exhaustion | 899.8 / exact witness | no |
| Perturbed target | heap exhaustion | 884.5 / SEARCH_LIMIT_REACHED | no |
| Multiple hard rules, reassignment | heap exhaustion | 993.6 / SEARCH_LIMIT_REACHED | no |
| Exotic + four-piece set | heap exhaustion | 749.6 / exact witness | no |
| Many equivalent items | 68.9 / exact | 157.1 / exact | yes |
| Five-piece Upgrade, retained reachable setup | 8.1 / exact | 14.7 / exact | not an Inventory query |

The two equivalent-item scenarios regress because normalization, full source
binding and verification now do work that the baseline omitted. They still
finish well below one second. The varied cases are **not comparable complete
search speedups**: the baseline exhausts its process heap and the follow-up
explicitly limits resources. A verified exact witness proves existence, not
that the incomplete frontier found the globally best canonical solution.

After: varied queries peak at 50,000 retained frontier states; 84,416 attempted
state extensions in three scenarios, 60,072 in Exotic+set. Equivalent scenarios
compress 1,295 duplicate items to one item per slot. End heap samples range
~11–304 MiB; ArrayBuffers ~10 KiB on these Inventory/Upgrade queries. Maximum
RSS ranges ~56–445 MiB. RSS is the OS high-water measure; heapUsed is an end
sample, **not peak JS heap**. Exact proof construction is included in searchMs,
not separately timed. `normalizeMs` measures fixture construction plus selected
piece normalization; internal full-pool ProblemSpec normalization remains within
searchMs. These measurement gaps are explicit remaining acceptance items.

Raw records:

- [Before](v3-baseline-realistic.json)
- [After](v3-after-realistic.json)
- [Final, with exact key interning](v3-final-realistic.json)

## Profile-guided exact key interning

CPU profile on the hard-rules scenario identified the frontier loop (223 samples),
GC (87) and `getStateKey` (65) as the largest self-time consumers. Full capability
strings were repeated in every frontier key. They now receive request-local
integer IDs through a Map of the **full** strings. This is lossless interning,
not a probabilistic hash or weaker equivalence. No field, state limit, candidate
or assignment domain was removed. Before/after both examine **84,416** states,
retain at most **50,000**, merge **0** states and return SEARCH_LIMIT_REACHED.

With CPU profiling enabled: 864.4 -> 561.6 ms; maximum RSS
463,319,040 -> 302,956,544 bytes. Final normal measurements:

| Query | Final ms | Final maxRSS MiB |
| --- | ---: | ---: |
| 1300 easy exact | 164.4 | 103.2 |
| 1300 varied exact | 577.0 | 288.0 |
| 1300 perturbed target | 574.2 | 289.7 |
| 1300 hard rules | 674.5 | 295.8 |
| 1300 Exotic + set | 530.5 | 261.9 |
| 1300 equivalent | 152.2 | 103.3 |
| Upgrade retained setup | 13.1 | 56.3 |

Final original benchmark: Scratch cold `[691.9, 566.5, 637.8, 542.7, 345.9, 569.2]`,
hot 546.2, Inventory 613.3 ms, retained heap+ArrayBuffers 19.4 MiB. Only the
frontier representation was optimized; Scratch timing differences remain
run-to-run noise, not evidence of a new exact algorithm.

Reproduce with `npm run benchmark:v3`, and
`node scripts/benchmark-v3-realistic.mjs <checkout-path>`; set `BENCH_OUTPUT` to
retain the JSON record. `searchLimits.maxStates` / `maxEvaluations` may be
provided to Inventory. Raising them expands the explored domain; hitting them
never authorizes `INFEASIBLE_PROVEN`.
