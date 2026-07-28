# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install            # installs TypeScript, the only dependency (dev-only)
npx tsc                # compile src/ → dist/ (strict mode; treat warnings as build failures)
npx tsc --watch        # recompile on change during development
python3 -m http.server 8000   # serve the app; open http://localhost:8000
```

There is no test framework, linter, or bundler. The only automated checks are
the compiler and `src/game/hash_test.ts`, whose `runHashTests()` is meant to be
called from the browser console.

To run against a live backend (connected mode), start the devnet from the
companion repo: `python3 devnet/frontend_devnet.py` in `~/Projects/xayaroguelike`
(see README.md for the full walkthrough). Standalone dungeon play needs no backend:
click Play on the title screen and press N.

## Critical constraint: determinism parity with the C++ backend

This frontend is the browser client for the Xaya Roguelike blockchain game; the
authoritative game logic lives in the C++ GSP at `~/Projects/xayaroguelike`.
Dungeon sessions run locally in the browser, and on exit the full action log is
submitted on-chain, where the GSP **replays it deterministically** to verify the
result. Any divergence between TS and C++ makes the chain reject legitimate play.

The parity-critical files — do not change behavior without verifying against the backend:

- `src/game/hash.ts` — SHA-256, matches backend `hash.hpp` byte-for-byte
- `src/game/rng.ts` — MT19937; `nextInt` uses Lemire's method `(uint64(raw) * n) >> 32`, **not** `raw % n`
- `src/game/dungeon.ts` — dungeon generation, verified tile-for-tile against `dungeon.cpp`
- `src/game/session.ts` — port of `dungeongame.cpp`; seed format is `seed + ":game:" + depth`; records `actionLog[]` per turn for the `xc` settlement move
- `src/game/monsters.ts` / `src/game/items.ts` — databases must match the backend's

`docs/PARITY_AND_ERRORS.md` is the parity audit and lists known gaps.

## Architecture

Zero runtime dependencies: plain TypeScript compiled by `tsc` to native ES2020
modules that the browser loads directly from `dist/`. Because of this, **all
imports must use `.js` extensions** (e.g. `import { MT19937 } from "./rng.js"`)
even though the sources are `.ts`.

`src/main.ts` (~1500 lines) is the entry point and owns all DOM wiring, app
state, and the render loop. The app has two modes:

- **Overworld mode** — connected to the GSP via JSON-RPC. Renders the segment
  graph, shows on-chain player stats/inventory, and submits moves (register,
  discover, travel, equip, use, allocate stat).
- **Dungeon mode** — runs a local `DungeonSession`. Either standalone (random
  seed, no backend) or a *channel session* seeded from on-chain segment seed
  and real player stats, settled on-chain afterwards.

Layers under `src/`:

- `game/` — deterministic game engine (see parity section above) plus
  `overworld.ts` (BFS segment-graph layout) and `input.ts` (keyboard).
- `render/` — Canvas 2D drawing: procedural sprites (`tiles.ts`, `entities.ts`),
  camera, fog of war, overworld map renderer. No image assets.
- `net/` —
  - `rpc.ts`: typed JSON-RPC 2.0 client for GSP read methods
  - `connection.ts`: connection manager polling the GSP every 2s and pushing
    `ConnectionState` into the main-loop callback
  - `moves.ts`: move submission via the devnet HTTP proxy (port 18380), which
    signs XayaAccounts contract calls; to be replaced by `window.ethereum`
    (MetaMask) in production (Phase F4b)
  - `validator.ts`: client-side pre-validation mirroring the backend's
    `moveparser.cpp`. This exists because the backend **silently drops**
    invalid moves (no error returned) — every new move type needs a validator
    here or the user gets no feedback on rejection
  - `pending.ts`: `waitFor` helpers to detect whether a submitted move actually
    took effect on-chain (post-submit revalidation)
- `ui/` — `modal.ts` (error/confirm dialogs) and `overlay.ts`.
- `config.ts` — default GSP URL (`localhost:18332`), proxy URL (`localhost:18380`),
  poll interval, game id `"rog"`.

Player stats shown in the UI must come from the GSP's `effective_stats`
(`getplayerinfo`), never from local state — this is the anti-stat-fabrication
contract documented in the backend's security docs.

ROADMAP.md tracks shipped/next work; PLAN.md has the full phase plan.
