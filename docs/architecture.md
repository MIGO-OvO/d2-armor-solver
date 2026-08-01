# Architecture

## Goals

The application remains a framework-free static site while separating browser
orchestration from computation. A production build may be hosted on GitHub
Pages, Cloudflare Static Assets, or any equivalent static host.

## Module Map

| Module | Interface | Implementation kept behind the Interface |
| --- | --- | --- |
| `ArmorEngine` | `solveLoadout`, `calculateReachability`, `analyzeUpgrade` | enumeration, scoring, tuning, range dynamic programming, replacement planning |
| `Budget` | `createBalancedTargetPlan` | exact-budget dynamic programming and balanced tie-breaking |
| `BuildRepository` | typed read/write methods for drafts, mode, language, and builds | storage keys, JSON parsing, schema version, storage errors |
| browser workbench | global action Adapter used by existing HTML handlers | DOM state, translation, rendering, mode switching |
| Worker client | Promise-based engine calls | request IDs, structured cloning, Worker errors, inline fallback |

`ArmorEngine` is intentionally deep: callers learn three request-object
Interfaces while the search Implementation stays local. The Worker and inline
fallback are two Adapters at the execution Seam. This creates Leverage for the
UI and tests, and Locality for future rule changes.

## Dependency Direction

```text
index.html
  -> app.mjs (browser Adapter)
       -> armor-engine-client.mjs
            -> Worker Adapter -> ArmorEngine -> solver/reachability/upgrade
            -> inline Adapter -> ArmorEngine -> solver/reachability/upgrade
       -> Budget
       -> BuildRepository -> localStorage

ArmorEngine -> armor model
ArmorEngine -X-> DOM / localStorage
```

Algorithm Modules are checked in `tests/structure.test.mjs` to prevent browser
state from leaking back across the Seam.

## Performance

- Standard solving, priority refinement, reachability, armor inference, and
  owned-armor analysis execute through a module Worker.
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

## Styling

The former inline CSS is externalized as `src/styles/app.css`. Its historical
source order is currently load-bearing, so this refactor preserves the cascade
exactly. Semantic CSS layering should be a separate, screenshot-backed change.

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

GitHub Pages and Cloudflare Workers Static Assets consume the same `dist/`
output. The Pages workflow runs `npm ci` and `npm run check`, verifies the main
page, compatibility redirect, bundled assets, and absence of source-module
references, then uploads `dist/`. Wrangler treats the output as a prebuilt
static site with automatic canonical HTML paths and explicit 404 handling.
