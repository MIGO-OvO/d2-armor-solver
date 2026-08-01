# Domain Context

## Product

Destiny 2 T5 Armor Solver helps players plan Armor 3.0 stat targets, verify
reachability, compare farmable armor sets, and improve an armor set they
already own. All calculations and saved data remain in the browser.

## Domain Language

- **Stat**: one of `health`, `melee`, `grenade`, `super`, `class`, or
  `weapons`. Their order is stable and is part of the calculation format.
- **Archetype**: the pair of primary and secondary stats that defines an armor
  framework.
- **Tertiary stat**: the 20-point stat selected from the four stats outside an
  archetype's primary/secondary pair.
- **Tuning**: either a free `+3` mode or a `+5/-5` shift. The `+5` destination
  (`tuningTo`) is rolled on owned armor; the `-5` source may be reassigned.
- **Armor mod**: a `+5` or `+10` bonus assigned to one armor piece.
- **Fragment**: an external stat delta applied after armor totals.
- **Target**: the player's desired final value after Fragments.
- **Target lock**: a target the automatic budget balancer must not change.
- **Exotic Class Item**: one fixed armor configuration derived from two perks;
  the remaining four pieces are Legendary armor.
- **Owned armor identity**: archetype, tertiary stat, tuning mode, and rolled
  `tuningTo`. Changing any of these means farming a different piece.
- **Replacement plan**: an ordered set of armor swaps whose printed tuning,
  mods, and intermediate totals must be reproducible.

## Invariants

- A Legendary base configuration totals 90 points; five pieces total 450
  before Tuning, armor mods, and Fragments.
- Automatic target changes land on multiples of five and preserve locked
  targets.
- A target of zero is calibrated zero: it contributes zero armor requirement
  even when a Fragment is negative.
- `tuningTo` is never silently reassigned on armor the player already owns.
- Locked or Exotic armor is never included in a replacement step.
- Every displayed replacement step must reconstruct the displayed totals.
- Existing browser storage keys and legacy unversioned records remain readable.
- The deployed application is static and does not transmit player inputs.

## Main Workflows

1. **Solve a loadout**: targets + Fragments + mod budget -> ranked solutions.
2. **Check reachability**: fixed Exotic configuration + locked targets ->
   feasible ranges or a nearest-target suggestion.
3. **Improve owned armor**: five owned pieces + targets -> baseline, ranked
   single swaps, and an ordered replacement plan.
4. **Persist work**: language, current draft, calculator mode, upgrade draft,
   and named builds are stored under the existing origin-scoped keys.
