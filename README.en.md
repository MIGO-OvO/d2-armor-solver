# Destiny 2 Armor Solver v2

[English](README.en.md) · [简体中文](README.md)

[![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?logo=javascript&logoColor=black)](https://developer.mozilla.org/docs/Web/JavaScript)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Deploy GitHub Pages](https://github.com/MIGO-OvO/d2-armor-solver/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/MIGO-OvO/d2-armor-solver/actions/workflows/deploy-pages.yml)
[![GitHub Pages](https://img.shields.io/badge/Use%20online-GitHub%20Pages-222?logo=github)](https://migo-ovo.github.io/d2-armor-solver/)
[![Release](https://img.shields.io/github/v/release/MIGO-OvO/d2-armor-solver?display_name=tag&sort=semver)](https://github.com/MIGO-OvO/d2-armor-solver/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## Overview

A six-stat armor solver for Destiny 2 Armor 3.0. You can work out whether a target is reachable from the theory alone, or import a DIM armor list, or log into Bungie to read your real inventory; from there it picks the best combination from gear you own, holds your set constraints, and lists what you still need to farm.

It's a fully static browser app: no backend, and no signup for this project. The root path is a portal with online and offline entry points, and the solver lives under `app/`. Stat targets, DIM lists, and saved builds stay in the current browser. Bungie login only reads your real inventory; when a build is made entirely of items you own, you can equip it in game in one click.

## Live Site

Portal: [https://migo-ovo.github.io/d2-armor-solver/](https://migo-ovo.github.io/d2-armor-solver/)

Solver: [https://migo-ovo.github.io/d2-armor-solver/app/](https://migo-ovo.github.io/d2-armor-solver/app/)

Development build: [https://migo-ovo.github.io/d2-armor-solver/dev/app/](https://migo-ovo.github.io/d2-armor-solver/dev/app/)

> `main` is the stable channel, `develop` is the development channel. The two online versions share the language preference, but drafts, saved builds, and Bungie login state use separate storage keys so they don't overwrite each other. Browser data isn't migrated automatically between other deployments either.

![Destiny 2 Armor Solver workbench](./asset/web-input.png)

## Offline Use

A standalone build that runs fully offline, no Node, npm, or server required:

1. Download the [latest offline package](https://github.com/MIGO-OvO/d2-armor-solver/releases/latest/download/d2-armor-solver-offline-v2.0.6.zip), or grab a pre-release build from the [Actions](https://github.com/MIGO-OvO/d2-armor-solver/actions/workflows/deploy-pages.yml) artifacts on any push.
2. Unzip it and open `index.html` in a browser over the `file://` protocol.

The offline package matches the online version, with one difference: it doesn't inject Bungie secrets at build time, so the login entry is hidden. DIM CSV import, solving, and saving builds all run fully offline; the DIM Loadout export link is just a URL, so opening it still needs a network connection.

Browser support:

- Chrome and Edge are fully supported.
- In Firefox over `file://`, `localStorage` is unavailable, so drafts and saved builds don't survive a refresh. The rest of the app is unaffected.

The offline build runs on the main thread (it doesn't start a Web Worker under `__OFFLINE_MODE__`), so the UI may freeze briefly during a heavy inventory solve. That's expected. Data stays 100% on your machine, same as the online version; the offline build hits no CDN at all.

## Changelog

### v2.0.6 (latest)

- Fixed stat rules in the "optimize existing loadout" path to match the from-scratch solver: at most / at least / range / exact now all take effect. Ceiling rules judge normality as a ceiling (at or below the cap is met with no shortfall, exceeding shows "over cap" instead of "met"), the search no longer parks a capped stat at its cap, and the "no farming" inventory results share the same rule-aware met markers.

### v2.0.5

- Fixed the "at most / range upper bound" stat rule: when the target total is below the budget and surplus must be spilled somewhere, the capped stat is no longer treated as the cheapest squared-difference dump — the cap is strictly enforced.
- Fixed the 2+2 dual-set requirement: the two set pickers now build their own options, so the "second set" choice survives re-renders and can actually be selected.

### v2.0.4

- Fixed target rule enforcement: priority and fuzzy constraints (exact / at least / at most / range) now apply strictly, and replacement planning allocates farmable armor to must-meet stats first, never breaking a must-meet constraint to reduce swap count.
- Fixed tuning roll matching: a Legendary piece's `+5` roll must match the plan, otherwise it's downgraded to farm; an Exotic's `+5` direction stays freely selectable.
- Fixed Bungie equip: when the character is full, non-plan items are moved aside; per-item equip failures are recorded instead of aborting the whole sequence; per-socket write failures are handled softly; the app re-reads the profile to verify the applied plugs.

### v2.0.3

- Added a portal home page and moved the solver to the `app/` subpath; the root portal offers online / offline entries and three languages.
- Added Bungie OAuth login and real inventory: cross-save resolution, a pre-generated armor catalog, and inventory deduplication. Builds made entirely of owned items can be equipped in game.
- Added per-stat priority (high / mid / low) and fuzzy constraints (exact / at least / at most / range) for from-scratch targets. The solver maximizes reachable stats in priority order, then balances the rest.
- Reworked the stat mode controls: symbol badges became labeled priority / rule controls, and inventory sync moved out of the account menu with a 10-second auto-refresh.
- Fixed Bungie inventory issues: double-counted mods, aligning actual totals with the DIM export, skipped mods, single-Exotic constraints, and vault slot recovery.

### v2.0.2 algorithm optimization

- Improved upgrade planning: once must-meet stats are satisfied, it prefers plans with fewer swaps.
- Planning seeds now keep owned armor so exact swap combinations can be found.
- Added an "only +5/-5 tuning" option.

### v2.0.1 optimized edition

- Renamed to "命运2 T5配装求解器·优化版" with updated footer credits (Ver 2.0.1).
- Fixed DIM import so bare armor (no tuning or armor mod installed) resolves its fixed +5 roll.
- Exotic Class Items are recognized by their fixed 30/25/20 roll (frame + tertiary).
- Planning no longer rejects owned pieces over a different +5 roll. A whole-assignment feasibility check (pinned +5, free -5, free mods) decides matching and downgrades infeasible pieces back to farm.

### v2.0.0 inventory planning

v2 was a major upgrade around real-inventory builds:

- Import DIM Armor CSV and recognize class, slot, Tier, Exotic, equipped state, base stats, sets, and masterwork level.
- Infer installed `+3` / `+5/-5` tuning and `+5` / `+10` armor mods from the stats DIM displays.
- New owned-armor solving: prefer exact matches from inventory and show which slots, frames, and tuning directions still need farming.
- Support fixed normal Exotics, Exotic Class Items, and closest-stat comparison between multiple copies of the same Exotic.
- Support `4-piece`, `2-piece`, and `2+2` set constraints, with 56 built-in Bungie Manifest sets.
- Export owned-armor builds as DIM loadout links carrying armor instances, stat mods, and tuning mods.
- "Optimize current build" supports must-meet stats, real armor distribution, pinned pieces, and replacement plans sorted by benefit.
- Reworked the DIM import, inventory results, and replacement-planning UI for desktop, 390px narrow screens, keyboard focus, and status feedback.
- Solving, reachability, inventory search, and replacement analysis all run in a Web Worker to keep the UI responsive.

See the [v2.0.0 release](https://github.com/MIGO-OvO/d2-armor-solver/releases/tag/v2.0.0) for the full notes.

## Features

### From-scratch builds

- Set six stat targets: Health, Melee, Grenade, Super, Class, and Weapons.
- Give each stat a priority (high / mid / low) and a fuzzy constraint (exact / at least / at most / range). The solver maximizes reachable stats in priority order, then balances the rest.
- Apply Fragment stat changes, `+5` / `+10` armor mods, and `+3` / `+5/-5` tuning.
- Lock targets, or limit plans to `+5/-5` tuning only.
- Enumerate five-piece armor frames and show the target delta, theoretical reachable range, and farming needs.
- Support Exotic Class Items with class, left/right-column perks, and the fixed `30/25/20` frame.

### DIM inventory planning

- Filter imported armor by class and Tier 5.
- Match owned armor first, then sort plans by farming count and stat closeness.
- Pin a normal Exotic by slot and name; multiple copies of the same Exotic are compared automatically by frame, tertiary stat, and tuning.
- Set set requirements for a target plan and make sure the inventory combination or farming suggestion meets the piece count.
- View plans made entirely of owned armor, or a mixed "owned + to-farm" plan.

### Optimize current build

- Auto-fill the five armor pieces from DIM's currently equipped, or configure each piece by hand.
- Pin Exotics or any pieces you don't want replaced.
- Check "must meet" for key stats to satisfy hard constraints before comparing total shortfall.
- Show current state, the six stats after replacement, the step-by-step replacement order, tuning assignment, and armor mod assignment.
- When the current gear is already good enough, it says so with a keep-everything plan.

### Equip in game via Bungie (online)

- After logging into Bungie and importing your real inventory, builds made entirely of owned instances show an "Equip to game" action. You can pick the target character if you have several of the same class.
- Before applying, it checks the five instances, class, Exotic Class Item perks, mod unlock state, exact sockets, and armor energy. Stat mods that don't fit the energy are listed as skipped.
- Custom results are applied as `TransferItem → EquipItems → InsertSocketPlugFree`. Bungie's public API has no endpoint for creating an arbitrary in-game loadout; `EquipLoadout` only applies loadouts you've already saved in game.
- Saved in-game loadouts are read from `CharacterLoadouts`, so you can apply them directly or load their armor, mods, and Fragment stats back into the optimizer.
- Custom plans keep the target character's current subclass, aspects, and Fragments. The UI only stores the total Fragment stat change, so it can't reconstruct specific Fragments unambiguously; direct apply is allowed only when the total matches the character's current exact config. To fully switch subclass setups, apply a saved in-game loadout instead.

Limitations:

- The character must be in orbit, a social space, or offline; Bungie rejects equipment writes during an activity.
- Writes depend on the Bungie app having `MoveEquipDestinyItems` enabled. Bungie's OAuth URL doesn't accept a `scope` parameter; permissions are fixed by the app registration.
- When energy is short, the corresponding mods are skipped and counted; the app doesn't change armor elements on its own, and doesn't promise success for operations that consume materials.
- Exotic Class Items can only equip an existing instance whose perks match exactly; random perks can't be rewritten.
- Only the five armor slots and armor mods are handled, not weapons, Ghost, or other slots. If a manual sequence fails partway through, the UI says so, to avoid reporting a full success when only some transfers went through.

### Other features

- Simplified Chinese, Traditional Chinese, and English UI.
- Drafts, language, mode, and named builds auto-save to `localStorage`.
- Reduced motion, keyboard operation, clear focus, and `aria-live` status announcements.
- GitHub Pages and Cloudflare Workers Static Assets share the same production build.

## Usage: import and export DIM

### Import your armor list

In DIM, go through:

```text
DIM → Settings → Spreadsheets → Armor → Export CSV
```

Back in the solver, click "Choose DIM CSV". The file is parsed only in your browser, never uploaded.

After importing, it helps to:

1. Pick your class and decide whether to use only Tier 5 armor.
2. If you want to pin a normal Exotic, choose its slot and name.
3. Set your six targets, Fragments, and set constraints.
4. Run the solve and compare owned pieces against what still needs farming.

### Export a DIM loadout

Builds made entirely of owned armor can generate a DIM Loadout link. The link carries DIM instance IDs, stat mods, and tuning mods; make sure your browser is logged into DIM before opening it.

DIM ignores mods your account doesn't own, and armor needs to meet the in-game energy and masterwork requirements before mods can be applied.

## Getting Started

### Prerequisites

- Node.js `22.13.0` or later
- npm
- Optional: Chrome or Edge for the browser regression tests

### Install

```bash
git clone https://github.com/MIGO-OvO/d2-armor-solver.git
cd d2-armor-solver
npm ci
```

### Dev server

```bash
npm run dev
```

Open the local address shown in the terminal. On Windows you can also run `start_windows.bat`, which installs missing dependencies and opens a browser.

### Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Build `dist/` for production |
| `npm run build:offline` | Build the solver-only `dist-offline/` offline bundle |
| `npm run preview` | Preview the production build locally |
| `npm run lint` | Run ESLint |
| `npm test` | Run the deterministic algorithm tests |
| `npm run test:upgrade` | Run the randomized replacement-planning regression tests |
| `npm run test:browser` | Verify the Worker, interactions, and 390px layout in local Chrome/Edge |
| `npm run verify:offline` | Build and verify the offline bundle over `file://` |
| `npm run check` | Run lint, tests, replacement regression, and build in order |
| `npm run deploy` | Deploy Cloudflare static assets with Wrangler |

## Repository Structure

```text
d2-armor-solver/
├─ .github/workflows/        # GitHub Pages continuous deployment
├─ app/
│  └─ index.html             # Online solver page (/app/)
├─ asset/                    # Icon sources and README screenshots
├─ docs/architecture.md      # Modules, Worker, and storage boundaries
├─ scripts/
│  ├─ build.mjs              # Production build and static asset handling
│  ├─ build-offline.mjs      # Single-entry offline build that runs over file://
│  ├─ verify-offline.mjs     # Offline bundle browser verification
│  ├─ browser-smoke.mjs      # Browser regression checks
│  └─ fetch-armor-mod-data.mjs
├─ src/
│  ├─ portal.mjs             # Trilingual portal switching
│  ├─ app.mjs                # Browser workbench and UI orchestration
│  ├─ core/
│  │  ├─ armor-engine.mjs    # Unified solver interface
│  │  ├─ dim-csv.mjs         # DIM CSV parsing and mod inference
│  │  ├─ inventory-solver.mjs # Owned-armor combination search
│  │  ├─ inventory-plan.mjs  # Owned / to-farm mixed planning
│  │  ├─ bungie-api.mjs      # OAuth, requests, rate limiting, error classification
│  │  ├─ bungie-inventory.mjs # Bungie inventory and instance/socket mapping
│  │  ├─ bungie-loadout.mjs  # Equip pre-check, write sequence, saved loadouts
│  │  ├─ armor-sets.mjs      # Set catalog and activation rules
│  │  └─ upgrade-optimizer.mjs
│  ├─ workers/               # Non-blocking algorithm Workers
│  └─ styles/
│     ├─ portal.css          # Portal visuals and responsive styles
│     └─ app.css             # Solver responsive UI styles
├─ tests/                    # Algorithm, DIM, inventory, and structure tests
├─ index.html                # Root portal page
└─ package.json
```

For more detail on module relationships, see the [architecture notes](./docs/architecture.md).

## Deployment

On push, [Deploy stable and development Pages](.github/workflows/deploy-pages.yml):

1. Builds an offline zip on every branch push and uploads it as an Actions artifact kept for 14 days, for early access.
2. Installs locked dependencies and runs `npm run check` for both `main` and `develop`, injecting each channel's name and commit at build time.
3. Places `main`'s portal and solver at the root path and `/app/`, and `develop`'s full build under `/dev/`. The portal's "use online" link always points to stable, with an extra development-build entry.
4. Verifies both entries, compatibility redirects, static assets, and `versions.json`, then publishes the combined output to a single GitHub Pages site. When a Release is published, the offline zip is attached to it.

Branch convention: day-to-day work goes to `develop`, and merges to `main` only after on-device verification. If either channel's publish fails, GitHub Pages keeps the last successful deploy rather than overwriting the live site with an incomplete build.

Cloudflare deployment:

```bash
npx wrangler login
npm run deploy
```

`dist/`, `node_modules/`, Wrangler local state, and agent working files are excluded from version control.

## Data, privacy, and disclaimer

- Armor sets, item hashes, and mod data come from the Bungie Manifest; the generated static data ships with each release.
- Destiny, Destiny 2, and related names, trademarks, and game art belong to Bungie and its rights holders.
- This project is not affiliated with or endorsed by Bungie or Destiny Item Manager.
- The app never sends your targets, inventory, or builds to a project server.
- Clearing this site's browser data also deletes drafts and saved builds.

## Bungie login setup

Bungie login (OAuth) is used to fetch your real inventory and needs to be configured on the deployment side. Registration and setup are done manually by the repo maintainer:

1. Open [bungie.net/en/Application](https://www.bungie.net/en/Application) and create a Bungie app:
   - Set the client type to `Confidential`.
   - Register redirect URLs `https://migo-ovo.github.io/d2-armor-solver/app/` and `http://localhost:5173/app/`.
   - Register origins `https://migo-ovo.github.io` and `http://localhost:5173`. An origin is just protocol, host, and port, without the `/d2-armor-solver/app/` path; the browser's Origin header must match a registered value (no wildcards), or Bungie rejects it with CORS.
   - When upgrading from an old version, change the redirect URL that pointed at the repo root to the `app/` subpath above, or the OAuth callback lands on the portal and login fails.
2. Get the three credentials from the app page: `API Key`, `OAuth Client ID`, and `OAuth Client Secret`.
3. Enable the `MoveEquipDestinyItems` permission in the app console; without it, inventory reads still work but transfers, equipping, and writing mods return permission errors. Have players log in again after changing permissions.
4. In the GitHub repo, go to `Settings → Secrets and variables → Actions` and add the stable secrets: `BUNGIE_API_KEY`, `BUNGIE_OAUTH_CLIENT_ID`, `BUNGIE_OAUTH_CLIENT_SECRET`.
5. The development channel reuses the same Bungie app and GitHub secrets. Bungie still calls back to the registered stable `/app/` path; the combined output recognizes OAuth state with the `develop.` prefix and forwards the code and state unchanged to `/dev/app/`, where the development build does its normal state check. Stable state is not forwarded.
6. Cloudflare deployment has Bungie login off by default (that origin isn't registered on the portal). The build still succeeds without the secrets, and the login and "equip to game" entries hide themselves; the offline build forcibly clears these settings.

> Never put real secret values in the repo, issues, or any docs; GitHub secrets are injected only during Actions runs.

## Quality assurance

The pre-release quality gates cover:

- Armor rules, budget balancing, reachability, and replacement planning.
- DIM CSV BOM, quoting, CRLF, multilingual fields, and real-stat inference.
- Set membership, `2-piece / 4-piece / 2+2` constraints, and pinned Exotics.
- Same-hash different instances, owned-piece priority, and farming suggestions.
- Worker requests, mode switching, target sync, and the 390px responsive layout.
- Bungie write request bodies, partial-apply errors, energy skips, saved loadouts, and browser-side write-route mocks.

## Issues and Contributing

Report problems or suggestions through [GitHub Issues](https://github.com/MIGO-OvO/d2-armor-solver/issues). For calculation errors, please include:

- The six stat targets and Fragment changes
- Mod, Exotic, and set settings
- Slot and stats of the relevant armor in the DIM CSV
- Expected vs. actual results
- Browser and OS versions

Before submitting a pull request, run:

```bash
npm run check
npm run test:browser
```

## License

Released under the [MIT License](./LICENSE).

## Acknowledgements

- [liheng-Huang](https://github.com/liheng-Huang) provided the initial version and source repository.
- [MIGO-OvO](https://github.com/MIGO-OvO) maintains this fork and its later versions.
- [Destiny Item Manager](https://destinyitemmanager.com/) provides armor list export and the Loadout workflow.
- Bungie provides the Destiny 2 Manifest and game data API.

## Contact

Maintainer: [@MIGO-OvO](https://github.com/MIGO-OvO)

For feature and calculation-rule discussions, prefer [GitHub Issues](https://github.com/MIGO-OvO/d2-armor-solver/issues).
