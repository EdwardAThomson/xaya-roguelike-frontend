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

### Phase F1: Project Setup + Dungeon Renderer

Get a canvas rendering a dungeon from a seed.

- `index.html` with canvas + basic layout
- `tsconfig.json` for strict TS compilation
- Canvas setup with resize handling
- Tile renderer: walls (brick pattern), floors (stone), gates (gold)
- Render an 80x40 dungeon grid from a hardcoded seed
- Camera/viewport centered on a position
- Keyboard input (arrow keys / WASD) to pan the camera
- Dark theme CSS

**Test**: Open `index.html`, see a rendered dungeon, pan around with keys.

### Phase F2: Local Dungeon Play

Play a dungeon session entirely in the browser.

- Port the dungeon generation algorithm to TypeScript (or compile C++ to WASM)
- Monster rendering (colored text symbols, matching JS roguelike)
- Item rendering (emoji icons)
- Player rendering (@ symbol or sprite)
- Input: arrow keys move the player, actions happen per-turn
- Combat: show damage numbers, monster death
- Fog of war: visible (bright) / explored (dim) / hidden (black)
- Stats panel: HP bar, kills, XP, gold
- Message log: combat messages, pickups, events

**Decision**: TS port (decided). Players can read and inspect the source code —
important for trust in a crypto game. C++ backend remains authoritative for
channel settlement. SHA-256 hash + MT19937 RNG ported and verified to match
C++ output. WASM remains an option for future performance optimization.

**Test**: Open in browser, play through a dungeon with keyboard, fight monsters, exit via gate.

### Phase F3: GSP Connection

Connect to a running GSP for on-chain state.

- RPC client: `getplayerinfo`, `getsegmentinfo`, `listsegments`, `listvisits`
- WebSocket client: subscribe to state changes via gsp-websocket-server.py
- Display on-chain player stats (HP, level, inventory, current segment)
- Overworld view: segment map showing the world graph (nodes + edges)
- Travel UI: click a linked segment to submit travel move

**Test**: Connect to local devnet GSP, see player state update in real-time.

### Phase F4: Wallet Integration + Move Submission

Submit game moves via MetaMask.

- Wallet connector: `window.ethereum` for MetaMask
- Connect wallet, detect Xaya accounts contract
- Submit moves: register, discover, travel, equip, use item, enter/exit channel
- Transaction status: pending → confirmed → state update
- Error handling: rejected transaction, insufficient gas, etc.

**Test**: Register a player, discover a segment, travel — all via browser + MetaMask.

### Phase F5: Channel Play Integration

Full dungeon play through the browser with on-chain settlement.

- Enter channel (on-chain move)
- Play dungeon locally in browser (WASM engine or TS port)
- Exit channel: submit results on-chain
- Show loot summary, XP gained, level-ups after settlement
- Inventory management: equip/unequip between dungeon runs

**Test**: Full loop — enter channel, play dungeon, exit, see results on-chain.

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
