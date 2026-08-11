# Architecture

## Goals

The application remains a framework-free static site while separating browser
orchestration from computation. A production build may be hosted on GitHub
Pages, Cloudflare Static Assets, or any equivalent static host.

## Module Map

| Module | Interface | Implementation kept behind the Interface |
| --- | --- | --- |
| `ArmorEngine` | `solveLoadout`, `calculateReachability`, `analyzeUpgrade`, `solveInventory` | enumeration, scoring, tuning, range dynamic programming, inventory search, replacement planning |
| `Budget` | `createBalancedTargetPlan` | exact-budget dynamic programming and balanced tie-breaking |
| `BuildRepository` | typed read/write methods for drafts, mode, language, and builds | storage keys, JSON parsing, schema version, storage errors |
| `DIM CSV` | `parseCsv`, `normalizeDimItem`, inventory filters | CSV quoting/BOM handling, real-stat reconstruction, Tuning and Armor Mod inference |
| `InventoryPlanner` | owned/farm plans and owned-only loadouts | slot assignment, fixed Exotic matching, set requirements, farming gaps |
| `ArmorSets` | set lookup and active bonuses | generated Bungie Manifest catalog and localized perk text |
| portal | route selection and shared language preference | static copy, online/offline navigation, Release and Actions links |
| browser workbench | global action Adapter used by existing HTML handlers | DOM state, translation, rendering, mode switching |
| Worker client | Promise-based engine calls | request IDs, structured cloning, Worker errors, inline fallback |

`ArmorEngine` is intentionally deep: callers learn four request-object
Interfaces while the search Implementation stays local. The Worker and inline
fallback are two Adapters at the execution Seam. This creates Leverage for the
UI and tests, and Locality for future rule changes.

## Dependency Direction

```text
index.html (portal)
  -> portal.mjs -> shared language preference
  -> app/index.html

app/index.html
  -> app.mjs (browser Adapter)
       -> armor-engine-client.mjs
            -> Worker Adapter -> ArmorEngine -> solver/reachability/upgrade/inventory
            -> inline Adapter -> ArmorEngine -> solver/reachability/upgrade/inventory
       -> Budget
       -> BuildRepository -> localStorage
       -> DIM CSV -> ArmorSets

ArmorEngine -> armor model
ArmorEngine -> InventoryPlanner -> ArmorSets
ArmorEngine -X-> DOM / localStorage
```

Algorithm Modules are checked in `tests/structure.test.mjs` to prevent browser
state from leaking back across the Seam.

## Performance

- Standard solving, priority refinement, reachability, inventory search, armor
  inference, and owned-armor analysis execute through a module Worker.
- The upgrade optimizer memoizes identical piece evaluations for the lifetime
  of one analysis request; cache entries cannot leak across target/Fragment
  inputs.
- Base configurations precompute the three masterwork stats used by hot
  evaluation loops.
- Vite emits minified, content-hashed JavaScript/CSS and a separate Worker
  asset. The engine fallback is loaded only when Worker support is unavailable.
- Realtime reachability uses a revision number so stale asynchronous results
  cannot overwrite newer input.

## Persistence

`BuildRepository` owns the following existing keys:

- `d2_armor_page_language_v1`
- `d2_armor_current_draft_v1`
- `d2_armor_saved_builds`
- `d2_armor_upgrade_draft_v1`
- `d2_armor_calculator_mode_v1`

New draft writes include `schemaVersion: 1`. Existing unversioned drafts and
saved-build arrays are accepted without migration, so deployments do not make
origin-scoped browser data disappear.

The `develop` Pages build rewrites mutable solver, Bungie token, display-name,
and OAuth-state keys into the `d2_armor_dev_*` namespace. The language key is
shared intentionally so a portal language choice follows the user into either
channel without allowing development drafts or credentials to overwrite stable
state.

## Styling

The former inline CSS is externalized as `src/styles/app.css`. Compatibility
styles preserve the historical cascade while workbench-specific sections own
the DIM import, inventory results, and upgrade-planning surfaces. UI changes are
verified at desktop and 390px widths before release.

## Commands

```bash
npm run dev           # Vite development server
npm run lint          # static JavaScript checks
npm test              # fast Node tests
npm run test:upgrade  # randomized replacement-plan regression
npm run test:browser  # installed Chrome/Edge Worker and responsive smoke test
npm run check         # lint, deterministic tests, regression, production build
npm run preview       # serve dist locally
npm run deploy        # build and deploy with Wrangler
```

On Windows, `start_windows.bat` wraps `npm run dev`, installs missing
dependencies on first launch, and opens the local site in the default browser.
`start_windows.bat --no-open` starts the same server without opening a browser.

## Deployment

The Pages workflow checks out and validates both release channels. The `main`
build supplies the root portal and `/app/` stable solver, while the `develop`
build is nested under `/dev/`. `scripts/compose-pages.mjs` adds the developer
entry to the published stable portal, removes the now-redundant nested entry,
and records both commit SHAs in `versions.json`. Each Vite build receives its
channel and commit at build time, so the development solver can show a visible
DEV marker and select isolated storage keys.

Every pushed branch also produces a solver-only offline artifact; published
Releases receive the same offline archive as a downloadable asset. Cloudflare
Workers Static Assets can still consume a standalone `dist/` through Wrangler,
with automatic canonical HTML paths and explicit 404 handling.
