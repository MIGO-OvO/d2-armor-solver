# Math Capability Equivalence Compression

Status: **keys implemented, compression not shipped**. This document records the
audit, the data model that is now in place, the measured benefit, and the exact
invariants a future implementation must preserve.

## 1. What the inventory solver does today

`inventory-solver.mjs` builds one row per armor slot:

```
rows[slot] = every eligible physical instance
             → { piece, min[6], max[6], cover[2], identity, minKey }
```

Every physical instance enters the DFS/join. `createPieceCapability()` already
computed an `equivalenceKey`, but it was only used to increment
`searchStats.equivalentItems`; the search tree never consumed it.

The consequence: the search cost is the product of the *physical* item counts
(260 per slot for a 1300-piece vault → 260^5 combinations before pruning), even
when many of those items are mathematically identical.

## 2. The three identity levels

`createPieceCapability()` now exposes three keys, in the order a compressed
search would consume them:

| Key | Contains | Excludes |
| --- | --- | --- |
| `mathEquivalenceKey` | six stats, archetype, tertiary, set membership, Exotic flag, class, locked, tunedStat, allowedTuningStats, tuning assignment/confidence, installed stat mod, Exotic perk ids, masterwork stats | instance id, owner, equipped state, energy, sockets, equippability |
| `executionEquivalenceKey` | energy, socket capability/plug sets, tuning executability, equippability, installed mods, data confidence | six stats, archetype, tertiary, set membership |
| `physicalIdentity` | instance id, item hash, owner, equipped | everything mathematical |

`equivalenceKey` is retained unchanged as the union of all three, so existing
counters and callers keep their meaning.

`searchStats` now reports both `equivalentItems` (full identity, as before) and
`mathEquivalentItems` (mathematical duplicates that are *not* already counted by
the stricter key).

## 3. Measured headroom

`npm run benchmark:v3-client` prints `equivalentItems` / `mathEquivalentItems`
for the 1300-piece fixture. In the current fixture **450 of 1300 candidates
(34.6%)** are duplicates under the math key, and the two counters are equal
because the benchmark fixture carries no owner/equipped data.

A real vault is different: the same roll can exist on two characters or on one
character and in the vault, so `owner`/`equipped` differ while the math does
not. `mathEquivalenceKey` is what makes those instances collapse.

This is real headroom, but it is a *constant-factor* win on the branching
factor, not an asymptotic one: after compression the row still has one
representative per distinct roll.

## 4. Why the compression was not shipped in this change

Search *order* is part of the observable contract of a bounded search:

1. `stop("exact-witness-quota")` fires as soon as `maxResults` exact witnesses
   exist, so the identity of the Top-K depends on traversal order.
2. `compareInventoryResults` breaks ties on the physical `keyOf(pieces)` string,
   so which of two identical rolls is reported changes if the representative
   changes.
3. The witness carried into execution/preflight, DIM export and Bungie equip is
   a *physical* instance; substituting an equivalent one silently changes what
   the player is told to wear.

Collapsing rows without solving those three points would trade a measurable
optimisation for a silent change in results — unacceptable under the project
priority order (正确性 > 用户数据安全 > 前后端状态一致性 > 性能 > UI 细节).

## 5. Design of the compressed pipeline

```
physical items
  → group by mathEquivalenceKey                 (row build)
  → search over math classes (min/max/cover unchanged)
  → Top-K mathematical loadouts
  → for each slot, expand back to the physical instances of that class
  → execution / preflight / DIM / equip ranking
  → final Top-K
```

Invariants the implementation must hold:

1. **Coverage.** A math class is admissible for the *next* depth only through
   its representative; the class's min/max/cover is the same for every member,
   so frontier completeness is unaffected.
2. **Proof.** `createProofEvidence(... complete)` may only be set when the search
   covered every math class. Negative proofs are about classes, and a class with
   no admissible representative is empty by construction.
3. **Top-K identity.** `compareInventoryResults` must keep the physical tie-break
   *after* expansion. Either expansion must be exhaustive for the retained Top-K
   classes, or the comparator must be redefined to be class-based first.
4. **Determinism.** The class representative must be chosen by a stable rule
   (lexicographic `keyOf` is what the current comparator already uses for ties).
5. **Sharding.** `belongs()` partitions on physical identity today; after
   compression it must partition on the class key, otherwise shards can drop
   classes entirely.

## 6. Suggested incremental path

1. Keep the current physical search; add
   `benchmark:v3-client` metrics for `mathEquivalentItems` per slot (done).
2. Add an opt-in comparison harness that runs the compressed search on the small
   fixtures used by `tests/algorithm-oracles.test.mjs` and
   `tests/v3-differential.test.mjs` and asserts identical Top-K, identical
   canonical ids for every retained row, and identical certificate status.
3. Only then enable compression for the `deep`/exhaustive path, where the result
   set is order-independent, and finally for the bounded profiles.

Until step 3 lands, `mathEquivalenceKey` is a *measurement* and a documented
prerequisite, not an active optimisation.
