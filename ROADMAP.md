# Roadmap — Xaya Roguelike Frontend

_Status: active · updated 2026-07-30_

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
- [x] In-game Map view — overworld segment graph plus a fog-of-war dungeon minimap tab
- [x] Character sheet tab (base + effective stats, XP progress) and mid-run equip of banked gear
- [x] Crash-safe runs — persist/resume in-progress runs, auto-recover server-side timeouts and death knock-back
- [x] Dark monospace theme; `tsc` build with source maps
- [x] Multiplayer engine mirror: N-participant `session.ts` (round structure, per-participant spawn at the gate they entered through with the backend's gate-mouth ring scan, multi-target monster AI, damage tracking and reward pools) plus `settle.ts` (consent hash, pool split, claims), with pinned 2-player parity fixtures against the C++ backend (`npm test`)
- [x] Compact settlement proofs: `xc`, `gw` and `s` send the action log as the compact string (about a quarter of the JSON size), pinned against the backend's parser
- [x] 2-player co-op, end to end: `net/coop.ts` transport + runner over the devnet proxy relay, local host/join by direction (gate choices when you step onto a gate, plus the Co-op tab lobby listing only what is reachable from where you stand) with leave/cancel, shared run with a partner sprite and projected reward shares, mutual-consent settlement (`sc` + `s`), runner convergence test and a two-browser Playwright run (`npm run coop`)

## Next

- [ ] MetaMask wallet integration (Phase F4b) — `window.ethereum`, ABI encoding, tx tracking
- [x] Co-op Phase 2 robustness: checkpoint confirms with a heartbeat, partner-staleness detection, "continue alone" from the last checkpoint and the abandonment settle (`solo_from`); covered by the absent-partner parity vector and the second scenario of `npm run coop`

## Backlog

- [ ] Co-op: WebRTC transport (the relay is the only `CoopTransport` today); true state channels (backend Phase 3)

- [ ] Visual polish (Phase F6) — sprite tiles, monster/item art, camera scrolling, attack/particle animations, sound
- [ ] Multi-player robustness (mid-run checkpoints) and PvP
