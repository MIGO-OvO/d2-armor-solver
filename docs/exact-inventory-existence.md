# Exact inventory existence regression (2026-09-15)

Baseline: develop `d331817978283a8a0ff8515edcca20ad93abbb72`, also verified as
the remote develop HEAD before modification.

## Reproduction and loss boundary

`tests/helpers/dim-exact-inventory.mjs` retains the second physical witness from
the existing, anonymized reported DIM Mask of Fealty fixture. It adds copies of
the same rolls and class-item decoys with +1 weapons/-1 super (all other
capabilities unchanged). The 79-piece inventory has 15 class items and 16 per
other slot. The valid original class item remains available.

With directional-only tuning, all assignment deltas are multiples of five, so
the decoy's residual cannot be repaired. The original solver sorts the smaller
class-item row first and enters a decoy subtree. Both baseline reproductions
terminated at 50,000 evaluations: **1 mathematical evaluation, 49,999 cache
hits, no exact witness**, despite the unchanged DIM positive. This is a
deterministic evaluation-quota failure, not a machine-dependent timing test.

Data-flow checks:

- DIM normalization retains base/masterwork projection, immutable directional
  destination, fixed Exotic hash/class and set hashes. The five original
  records solve exactly alone; changing installed mod counts does not remove
  automatic stat-mod capability (existing DIM regressions).
- Fixed-five reassignment already has a complete point tuning/mod oracle and a
  clamp-preimage rule oracle. The missing physical combination never reaches
  those oracles: a cache speeds repeated evaluation but does not compress DFS.
- Joint bounds are conservative but do not reject all modular impossibilities.
  The existing 2+3 join only handles fixed assignments, not reassignment.
- `inventory-plan` is a bounded match/residual farming planner, not a complete
  inventory existence test. A theoretical exact plan is not evidence that no
  fully owned exact plan exists.
- A second confirmed loss boundary was UI deduplication: an inventory near miss
  could erase a fully owned exact theory assignment using the same five IDs.
  The new regression failed before sorting by witness quality ahead of dedup.
- An additional model gap: the owned V3 verifier permits empty Tuning (unless
  directional-only is requested), while automatic fixed-five assignment did
  not search it. A regression with known bases and unknown directional sockets
  proves exact witnesses with 0/2/5 Balanced slots and the other slots empty.

## DIM implementation comparison

Inspected upstream revision `4ddd5ec0b3212037efaf16ab36210014735d90ff`:

- [process.ts](https://github.com/DestinyItemManager/DIM/blob/4ddd5ec0b3212037efaf16ab36210014735d90ff/src/app/loadout-builder/process-worker/process.ts)
  enumerates legal armor combinations independently of its retained-result
  heap, checks set/Exotic constraints and uses admissible subtree bounds. Its
  first-set mode stops only after a valid set is found.
- [mappers.ts](https://github.com/DestinyItemManager/DIM/blob/4ddd5ec0b3212037efaf16ab36210014735d90ff/src/app/loadout-builder/process/mappers.ts)
  separates base/masterwork stats from automatic mods, expands Legendary
  tuning variants, and defers Exotic tuning alternatives to the set evaluator.

This comparison informs the existence/ranking separation; it is not a claim
that arbitrary DIM socket/energy models are identical or that DIM itself was
executed during this repair. The positive evidence is the repository's reported
DIM fixture, independently rebuilt and verified by the regression tests.

## Implementation and correctness argument

1. For six exact visible rules with reassignment, partition the existing first
   physical row by shard **before** grouping. Keep a class's physical members;
   the equivalence key includes arithmetic, tuning, installed budget state,
   masterwork, set/class/Exotic restrictions, hash and mathematical confidence.
   Only known base data can supply a verified positive witness.
2. Traverse the quotient inventory completely until a verified exact witness
   exists. Profile deadlines, evaluation quotas and Top-K do not truncate this
   stage. Checkpoints still publish progress, and worker termination cancels it.
3. Per-stat and joint bounds remain conservative relaxations. New suffix residue
   sets represent sums modulo five, including every Balanced +1 masterwork
   pattern. Only finite point coordinates are indexed; visible 0/200 clamp
   intervals remain with the interval oracle. Oversized residue tables become
   unrestricted, never partially retained sets used to reject candidates.
4. At a surviving leaf the existing exact fixed-five oracles test every allowed
   mod budget and tuning choice. `exactOnly` avoids approximate optimization.
   Positive math expands to physical instances and passes the unchanged V3
   verifier before entering results; sets, slots, classes, fixed Exotic,
   directional destinations and explicit Balanced counts are never relaxed.
   Empty-slot masks are handled by an exact reduction: subtract the Balanced
   +1 pattern from that slot's temporary oracle base, force Balanced there and
   increase its oracle Balanced budget accordingly, then restore `mode:none`.
   The paired deltas cancel; the unchanged original pieces—not the temporary
  bases—are what the certificate verifies. Unknown directional capabilities
   cannot be used as directions, but do not disallow Balanced/empty Tuning.
   On a metric tie, exact existence retains the oracle assignment rather than
   replacing it with a stale installed assignment lacking capability evidence.
5. Every legal exact witness has a retained equivalence path. Conservative
   bounds cannot remove it; its fixed-five query must find exact math, and its
   physical realization must pass verification. Thus ordinary ranking budgets
   cannot suppress existence. This guarantees **an** exact witness, not every
   alternative or globally canonical Top-K under a bounded profile.

No new global negative certificate is issued. Unknown data, serialized shards
and bounded alternative/fuzzy ranking retain the existing conservative proof
boundary. `exactExistence`, `exactGroups`, `exactStates` and
`exactPrunedResidues` distinguish this stage from physical frontier completion.
The fixed-assignment 2+3 path and mixed-rule/fuzzy budget semantics are unchanged.

## Statistics and presentation

"Fully owned" count/filter now means `feasible && farmCount === 0`, not merely
five owned pieces. Approximate owned combinations remain visible under All.
Deduplication keeps a stronger assignment before considering source preference;
equal-quality duplicates still favor inventory execution preflight.

## Cost and verification

The adversarial 79-piece regression now visits **7 quotient prefixes, prunes
one residue branch and evaluates one physical witness**, versus 50,000 failed
physical evaluations before. Local observations were roughly 25–86 ms, compared
with approximately 0.8–1.1 s to return no exact solution before (not a timing
assertion). Existing small DIM cases still return both physical builds.
Expanding those equivalence classes to 1,300 physical items took approximately
226 ms locally and still required one mathematical evaluation.

Worst-case time remains exponential in the number of distinct mathematical
rolls; correctness does not imply a fixed response-time bound. Memory for the
new residue tables is capped (4,096 entries per suffix, with safe fallback).
Browser workers remain cancellable. The offline synchronous fallback can block
its page during a long exact query, as it cannot process UI events mid-call.

Tests cover the reported DIM positive, duplicate saturation, reversed input,
Balanced/Deep expired session clocks, physical 2/4/8-way shards, fixed Exotic,
4pc and 2+2, explicit Balanced counts, unknown data, class mismatch, and 96
independently constructed witnesses with non-catalog residues and fragments.
Browser regressions run both the original and crowded DIM inventories through
the real application and verify five owned pieces, six exact bars and execution
tri-state. Separate regressions cover count/filter and assignment-aware dedup.

Final validation: `npm test` 442/442; `npm run lint`; production build;
`npm run test:upgrade` (49 verified plans on the final rerun);
`npm run verify:offline` (file://); and the full `npm run test:browser`, including
mock OAuth (44 intercepted requests, zero escaped Bungie requests), all passed.
The browser run required cleanup of its identified test-only Chrome process
after Windows shutdown stalled; the runner subsequently completed with exit 0.
One earlier concurrent offline build hit a Wasm allocation failure; isolated
reruns passed. The existing large-bundle warning remains, with no new dependency.
