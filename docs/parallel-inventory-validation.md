# Parallel inventory validation

Run `node --test tests/parallel-inventory.test.mjs tests/search-session.test.mjs`.

The thread test uses Node worker_threads as a transport adapter for the real
browser worker entry point, including its start/profile/result envelopes. It
compares canonical Top-K results for 1, 2, 4 and 8 workers with reversed input.
Controlled workers separately exercise reverse completion, progressive verified
witnesses before sibling completion, abort, stale replies,
worker failure, missing coverage and invalid concurrency counts. A six-per-slot
fixture checks that the 2+3 join partitions its results without overlap.
DFS partition tests include the current build and verify that the combined
evaluation count equals a serial traversal. Ordinary requests supersede old
work; only batch-owned workers run concurrently. Abort terminates their workers.

Each shard retains K candidates. With the same total ordering and a complete
search this is sufficient: an omitted candidate already has at least K better
candidates in its own shard. Retaining every candidate is unnecessary.

## Boundaries

- A completed finite search supports deterministic canonical ordering. Wall-clock
  limits and cancellation may change the available candidate set; sorting alone
  cannot guarantee identical interrupted results.
- Parallel requests use independent workers. Inline/offline fallback runs one
  full search; it does not claim multicore acceleration.
- Positive merged witnesses are reconstructed and certified against the original
  inventory. Serialized shard evidence is deliberately not promoted to a trusted
  global negative proof. Parallel negative results remain SEARCH_LIMIT_REACHED
  until an internally trusted aggregate proof producer is implemented.
- These tests establish correctness for the covered fixtures, not a speedup or
  universal no-miss guarantee. Large-vault benchmarks and built-browser tests
  remain separate release checks.
