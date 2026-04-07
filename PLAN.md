# Xaya Roguelike — Frontend Plan

## Overview

Browser-based frontend for the blockchain roguelike. Connects to the GSP via WebSocket/RPC, renders the dungeon on Canvas, and submits moves via wallet integration. Zero runtime dependencies — pure HTML/CSS/TypeScript compiled with `tsc`.

**Backend repo**: `~/Projects/xayaroguelike/`
**This repo**: `~/Projects/xaya-roguelike-frontend/`

---

## Architecture

```
Browser (this repo)
├── Canvas renderer     ← draws dungeon, monsters, items, player
├── UI panels           ← stats, inventory, messages (HTML/CSS)
├── WebSocket client    ← real-time state updates from GSP
├── RPC client          ← queries (getplayerinfo, getsegmentinfo)
├── Wallet connector    ← MetaMask / window.ethereum for moves
├── Input handler       ← keyboard for movement, hotkeys
└── Game state          ← client-side state management (plain TS)

         │ WebSocket + JSON-RPC
         ▼
GSP (rogueliked) ← running on network or locally
```

## Design Principles

1. **Zero runtime dependencies** — no npm packages in production. Only `tsc` for compilation.
2. **Security first** — no third-party code touches wallet keys. Raw `window.ethereum` calls.
3. **Canvas rendering** — procedural sprites drawn to canvas, text for monsters/items. No image assets initially.
4. **Progressive enhancement** — starts with ASCII-like rendering, upgradeable to sprite images later.
5. **Offline-capable dungeon play** — dungeon sessions run locally (same as roguelike-play), only settlement needs the chain.

---

## Project Structure

```
xaya-roguelike-frontend/
├── index.html              — single page, no framework
├── style.css               — layout, panels, dark theme
├── tsconfig.json           — TypeScript config (strict, ES modules)
├── src/
│   ├── main.ts             — entry point, initialisation
│   ├── config.ts           — GSP URL, chain config, constants
│   │
│   ├── render/
│   │   ├── canvas.ts       — canvas setup, resize handling
│   │   ├── tiles.ts        — wall/floor/gate sprite drawing
│   │   ├── entities.ts     — player, monster, item rendering
│   │   ├── camera.ts       — viewport centered on player
│   │   ├── fov.ts          — fog of war (visible / explored / hidden)
│   │   └── minimap.ts      — overworld segment map
│   │
│   ├── game/
│   │   ├── state.ts        — client-side game state
│   │   ├── dungeon.ts      — dungeon grid + entity tracking
│   │   ├── input.ts        — keyboard handler (WASD / arrows / hotkeys)
│   │   ├── actions.ts      — action construction (move, pickup, use, gate)
│   │   └── session.ts      — dungeon session management (local play)
│   │
│   ├── net/
│   │   ├── rpc.ts          — JSON-RPC client (fetch-based)
│   │   ├── websocket.ts    — WebSocket for real-time updates
│   │   └── wallet.ts       — window.ethereum / MetaMask integration
│   │
│   └── ui/
│       ├── stats.ts        — HP bar, XP, level, gold display
│       ├── inventory.ts    — equipment slots + bag grid
│       ├── messages.ts     — combat log / message area
│       ├── overworld.ts    — segment map / travel UI
│       └── modal.ts        — character sheet, help, overlays
│
├── assets/                 — placeholder for future sprite images
│   └── (empty initially)
│
└── PLAN.md                 — this file
```

---

## Phases

### Phase F1: Project Setup + Dungeon Renderer — DONE

Get a canvas rendering a dungeon from a seed.

- `index.html` with canvas + basic layout
- `tsconfig.json` for strict TS compilation
- Canvas setup with resize handling
- Tile renderer: walls (brick pattern), floors (stone), gates (gold)
- Render an 80x40 dungeon grid from a hardcoded seed
- Camera/viewport centered on a position
- Keyboard input (arrow keys / WASD) to pan the camera
- Dark theme CSS

### Phase F2: Local Dungeon Play — DONE

Play a dungeon session entirely in the browser.

- TS port of dungeon generation, verified identical to C++ (3200/3200 tiles match)
- SHA-256 hash + MT19937 RNG ported and verified to match C++ byte-for-byte
- Monster rendering: 14 types, colored text symbols, HP bars
- Item rendering: 35 items, emoji icons
- Player rendering: gold circle + @ symbol
- Turn-based gameplay: 8-dir movement, combat, items, monster AI, gate exits
- Fog of war: 8-tile radius circular LOS (visible / explored / hidden)
- Stats panel: HP bar (color-coded), kills, XP, gold, depth
- Message log: 50-message buffer, color-coded (combat, pickup, info, warning)
- Action log recording for replay proof
- Monster drops (35% chance: gold, potions, equipment)

### Phase F3: GSP Connection — DONE

Connect to a running GSP for on-chain state.

- `src/net/rpc.ts`: JSON-RPC 2.0 client with typed responses for all GSP endpoints
  (getplayerinfo, listsegments, getsegmentinfo, listvisits, waitforchange, getcurrentstate)
- `src/net/connection.ts`: Connection manager with auto-polling (2s interval)
- Overworld view: segment map with BFS grid layout, depth-colored nodes, directional links
- Segment 0 (hub) always shown even though it's not in the DB — links inferred from neighbors
- Click-to-select segments on the overworld canvas with hit-testing
- On-chain player stats displayed: HP bar, level, XP, gold, stats, equipment, combat record
- On-chain inventory shown with equipped slot labels
- World info: player count, segment count, active visits, other players
- Dual-mode UI: overworld (on-chain state) vs dungeon (local play)
- Top bar: GSP URL input, player name input, connect/disconnect, mode toggle

### Phase F4a: Devnet Move Submission — DONE

Submit game moves via a devnet HTTP proxy (no MetaMask needed for testing).

- `src/net/moves.ts`: Move submission client with typed convenience methods
  (register, discover, travel, enterChannel, exitChannel, equip, useItem, allocateStat)
- `devnet/frontend_devnet.py`: starts full stack (anvil + Xaya X + rogueliked)
  and runs HTTP move proxy on port 18380 with CORS support
- Proxy translates simple JSON POSTs into XayaAccounts smart contract calls
- Sidebar buttons: Register Player, Discover (per direction), Travel, Enter Dungeon

### Phase F5: Channel Play Integration — DONE

Full dungeon play through the browser with on-chain settlement.

- Enter channel from overworld: on-chain `ec` move via proxy
- Dungeon session created with real on-chain player stats (level, str/dex/con/int,
  equipped attack/defense, HP, potions from inventory)
- Segment seed from GSP used for deterministic dungeon generation
- On dungeon exit (survived or died): "Submit Results On-Chain" button
- Submits `xc` move with results + full action replay proof (actionLog array)
- GSP verifies replay deterministically; results reflected in overworld state
- Channel session label in dungeon sidebar shows segment ID

### Phase F4b: MetaMask / Wallet Integration

Submit game moves via MetaMask (production path, replaces devnet proxy).

- Wallet connector: `window.ethereum` for MetaMask
- ABI encoding for XayaAccounts contract (register, move)
- Connect wallet, detect Xaya accounts contract
- Transaction status: pending → confirmed → state update
- Error handling: rejected transaction, insufficient gas, etc.

**Test**: Register a player, discover a segment, travel — all via browser + MetaMask.

### Phase F6: Visual Polish

Upgrade from ASCII to proper sprites.

- Replace procedural canvas sprites with image-based tiles
- Monster sprites (pixel art or AI-generated)
- Item icons
- Smooth camera scrolling
- Attack/damage animations
- Particle effects (optional)
- Sound effects (optional)

**Test**: Game looks good, animations feel responsive.

---

## Graphics Approach

### Phase F1-F5: Procedural Canvas (matching JS roguelike)

| Element | Rendering | Color |
|---------|-----------|-------|
| Wall | Brick pattern (canvas rects) | #555 / #444 / #333 |
| Floor | Stone texture (canvas rects) | #222 / #272 / #1d1d |
| Gate | Iron bars + gold glow | #777 bars, #FFD700 glow |
| Player | Circle + @ symbol | Gold |
| Monsters | Bold text symbol (r, s, b, g, S, etc.) | Per-type color |
| Items | Emoji icon (🗡️, 🛡️, ⚗️, etc.) | Per-type color |
| FOV | Full opacity / 50% / hidden | — |

### Phase F6: Sprite images

- 24x24 or 32x32 pixel tiles
- Loaded from `assets/` directory
- Sprite sheet or individual PNGs
- Same rendering pipeline, swap `fillRect`/`fillText` for `drawImage`

---

## Build & Dev Workflow

```bash
# Compile TypeScript
npx tsc

# Serve locally (any static server)
npx serve .
# or: python3 -m http.server 8000

# No bundler, no webpack, no node_modules at runtime
```

The only dev dependency is `typescript` itself. The compiled JS files are served directly.

---

## Security Notes

- **No npm runtime dependencies** — eliminates supply chain risk
- **Wallet keys never touch our code** — all signing via `window.ethereum` (MetaMask)
- **Dungeon sessions are local** — no private data sent to server during play
- **On-chain settlement only** — results submitted via standard EVM transactions
- **CSP headers** — Content Security Policy to prevent XSS when hosted
