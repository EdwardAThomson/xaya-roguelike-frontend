# Roadmap — Xaya Roguelike Frontend

_Status: active · updated 2026-07-29_

Zero-dependency TypeScript + Canvas browser client for the Xaya Roguelike
blockchain game. Renders the on-chain overworld, runs dungeon sessions locally
with deterministic RNG, and submits action-replay proofs on-chain. Pairs with the
`xayaroguelike` C++ backend. See `PLAN.md` for the full phase plan.

## Shipped

- [x] Dual-mode UI (dungeon gameplay + overworld segment map)
- [x] Full local dungeon play (deterministic generation verified vs C++ backend)
- [x] 12 monster types, 31 items, turn-based combat matching backend formulas
- [x] 8-directional movement, fog of war, item pickup/use, monster loot drops
- [x] Action-log recording for replay verification
- [x] JSON-RPC client (typed methods, 2s auto-polling)
- [x] On-chain player stats display (level, HP, XP, equipment)
- [x] Overworld segment-graph rendering (BFS layout, provisional-segment markers, drag-pan / wheel-zoom / recenter)
- [x] Channel play (enter with on-chain stats, submit results on-chain)
- [x] Move submission via devnet proxy (register, discover, travel, equip, use, allocate)
- [x] Client-side pre-validation mirroring backend rules + post-submit revalidation
- [x] UI — stats panel, inventory, message log, modals, reconnect prompt, forfeit
- [x] Dark monospace theme; `tsc` build with source maps

## Next

- [ ] MetaMask wallet integration (Phase F4b) — `window.ethereum`, ABI encoding, tx tracking
- [ ] Wire multiplayer visit moves to the UI (currently stubbed in the parser)

## Backlog

- [ ] Visual polish (Phase F6) — sprite tiles, monster/item art, camera scrolling, attack/particle animations, sound
- [ ] Multi-player dungeon visits (co-op / PvP)
