# Xaya Roguelike Frontend

Browser-based frontend for the [Xaya Roguelike](../xayaroguelike/) blockchain game. Connects to the GSP via JSON-RPC, displays the overworld segment map, and runs dungeon sessions locally with on-chain settlement via action replay proofs.

**Zero runtime dependencies** -- pure TypeScript compiled with `tsc`, no npm packages in production. All rendering is Canvas 2D with procedural sprites.

## Features

- **Overworld map**: Segment graph rendered on canvas, click to select, travel between segments
- **On-chain state**: Player stats, inventory, equipment, combat record from the GSP
- **Dungeon play**: Full turn-based roguelike (14 monster types, 35 items, fog of war, 8-dir movement)
- **Channel integration**: Enter dungeons using real on-chain player stats, exit with cryptographic replay proof
- **Deterministic**: Dungeon generation and RNG verified identical to C++ backend (SHA-256 + MT19937)

## Quick start

```bash
# Install TypeScript (only dev dependency)
npm install

# Compile
npx tsc

# Serve
python3 -m http.server 8000
# Open http://localhost:8000
```

### Standalone mode

Open the page, switch to "Dungeon" mode, press N to start a local dungeon session. No backend needed.

### Connected mode (devnet)

```bash
# Terminal 1: Start the backend devnet
source ~/Explore/xayax/.venv/bin/activate
cd ~/Projects/xayaroguelike
python3 devnet/frontend_devnet.py

# Terminal 2: Serve frontend
cd ~/Projects/xaya-roguelike-frontend
python3 -m http.server 8000
```

1. Open `http://localhost:8000`
2. Paste the GSP RPC URL from terminal 1 into the GSP field
3. Enter a player name, click **Connect**
4. Click **Register Player** if the name is new
5. Click a direction button to **Discover** new segments
6. Click a segment, then **Travel** or **Enter Dungeon**
7. Play the dungeon, then click **Submit Results On-Chain**

## Project structure

```
index.html                  Single-page app (canvas + sidebar)
style.css                   Dark theme, monospace layout
tsconfig.json               TypeScript config (strict, ES2020)
src/
  main.ts                   Entry point, dual-mode app (overworld / dungeon)
  config.ts                 GSP URL, proxy URL, constants
  game/
    dungeon.ts              Procedural dungeon generation (80x40 grid)
    session.ts              Turn-based dungeon session engine
    combat.ts               Attack/defense/crit/dodge math
    monsters.ts             14 monster templates scaled by depth
    items.ts                35 item definitions (weapons, armor, potions)
    overworld.ts            Segment graph layout (BFS from origin)
    input.ts                Keyboard handler (WASD/arrows/hotkeys)
    rng.ts                  MT19937 (matches C++ std::mt19937)
    hash.ts                 SHA-256 (matches C++ HashSeed())
  render/
    tiles.ts                Procedural wall/floor/gate sprites (24px)
    entities.ts             Monster symbols, item icons, player
    camera.ts               Viewport management
    fov.ts                  Fog of war (8-tile radius LOS)
    overworld.ts            Segment map canvas renderer
  net/
    rpc.ts                  JSON-RPC 2.0 client (typed GSP methods)
    connection.ts           Connection manager with auto-polling
    moves.ts                Move submission client (devnet proxy)
dist/                       Compiled JS + source maps
```

## Architecture

```
Browser
  |
  |-- JSON-RPC ----------> rogueliked (GSP)     reads state
  |                          on port from devnet
  |
  |-- HTTP POST ---------> move_proxy           submits moves
       (devnet only)         on port 18380
       |
       v
    XayaAccounts contract on Anvil (local EVM)
```

**Overworld mode**: Fetches player info, segments, and visits from the GSP. Renders the segment graph centered on the player's current position. Sidebar shows stats, inventory, and action buttons (travel, discover, enter dungeon).

**Dungeon mode**: Runs a `DungeonSession` locally. In channel mode, uses the real segment seed and player stats from the GSP. On exit, submits the action replay proof on-chain for verification.

## Determinism

All game-critical algorithms are verified to produce identical output in TypeScript and C++:

| Algorithm | TS file | C++ file | Verified |
|-----------|---------|----------|----------|
| SHA-256 | `game/hash.ts` | `hash.hpp` | byte-for-byte |
| MT19937 RNG | `game/rng.ts` | `std::mt19937` | output sequence |
| Dungeon gen | `game/dungeon.ts` | `dungeon.cpp` | 3200/3200 tiles |

This ensures the browser can generate dungeons and record action logs that the GSP will accept during on-chain verification.

## Security

- **Zero npm runtime deps**: No supply chain attack surface in production
- **No wallet keys in code**: Signing via `window.ethereum` (MetaMask) in production
- **Local dungeon play**: No private data leaves the browser during gameplay
- **Replay proofs**: Full action log submitted for on-chain deterministic verification
- **Readable source**: Players can inspect the TypeScript source for trust

## What's next

- **Phase F4b**: MetaMask wallet integration (replace devnet move proxy)
- **Phase F6**: Sprite image assets, animations, sound effects

See [PLAN.md](PLAN.md) for the full development plan.
