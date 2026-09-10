# Inventory solver audit

## Acceptance target

For a known, finite armor inventory, a Deep run must enumerate the complete
legal five-slot domain, including Tuning and automatic stat-mod assignments.
Top-K output is only a presentation limit; it must not stop the frontier.

## Findings

| Priority | Finding | Action |
| --- | --- | --- |
| P0 | Reassigned inventory always reported `assignmentComplete: false`, even after a full traversal. | Deep exhaustive runs now mark assignment coverage complete. |
| P0 | Deep inventory budget was 15 seconds / 20M nodes / 250k evaluations. Large vaults could return a search-limit result despite available witnesses. | Deep budget is 120 seconds / 500M nodes / 5M evaluations. |
| P1 | `maxResults` is mixed with search termination in non-exhaustive profiles. | Deep keeps scanning after Top-K is full; Balanced remains bounded for interactive use. |
| P1 | Current installed `+5/+10` mods cannot represent DIM Auto Stat Mods. | Inventory reassignment uses capability budget, while explicit Upgrade/Scratch requests retain explicit budgets. |
| P1 | Theory matching and inventory feasibility were conflated in the UI. | Inventory search is an independent result set and theory matching is labelled as such. |
| P2 | A complete frontier does not imply globally optimal fuzzy scoring when the evaluator itself is bounded. | Certificates retain separate frontier and optimization claims. |

## Proof boundary

Deep can claim complete inventory coverage only when the frontier is exhausted,
all piece math is known, and every candidate witness verifies. Search limits,
unknown sockets/stat data, or bounded evaluator paths must produce
`SEARCH_LIMIT_REACHED`, never `INFEASIBLE_PROVEN`.

## Verification

- Real DIM CSV: two distinct exact 510 loadouts recovered for the reported
  `忠诚面具 + 渴望回响 4pc` target.
- Regression: automatic stat-mod assignments remain available when imported
  armor currently has zero installed stat mods.
- Regression: fixed ordinary Exotic is enforced during enumeration.
- Full Node suite, lint, and production build pass after the change.
