# Frontend Parity & Error-Handling Plan

Audit date: 2026-04-14 (original), last reconciled 2026-09-01
Backend reference: `~/Projects/xayaroguelike` at commit `0532b41`,
re-checked against `32e635b`
Frontend reference: `~/Projects/xaya-roguelike-frontend` (this repo)

## Summary

The deterministic core of the TypeScript port is in sync with the C++
backend — same SHA-256, same MT19937 (with Lemire's method), same
seed format, same monster database, action-log replay correctly
recorded. The gaps the original audit found were in **newer backend
features** the frontend hadn't picked up yet, and in **error-handling
UX** for moves the backend silently rejects.

All three implementation passes below have since shipped:
[src/net/validator.ts](../src/net/validator.ts) does the client-side
pre-validation and [src/net/pending.ts](../src/net/pending.ts) the
post-submission watch. The only feature gap still open is multi-player
visit moves, which remain out of scope.

The on-chain stat-fabrication attack vector documented in
`~/Projects/xayaroguelike/docs/SECURITY_Attack_and_Mitigations.md`
does **not** apply to this frontend — it correctly uses
`effective_stats` from `getplayerinfo` rather than trusting local
state.

## Verified-correct (no action needed)

- [src/game/hash.ts](../src/game/hash.ts) — SHA-256 padding (8-byte
  bit-length push) is correct
- [src/game/rng.ts](../src/game/rng.ts) — MT19937 `nextInt` uses
  Lemire's method `(uint64(raw) * n) >> 32`, not `raw % n`
- [src/game/session.ts](../src/game/session.ts) — seed format
  `seed + ":game:" + depth` matches `dungeon.cpp`
- [src/game/session.ts](../src/game/session.ts) — `actionLog[]` is
  recorded per turn and sent in the `xc` settlement move for replay
  verification
- Monster database: 12 monsters, stats and depth-scaling identical
  to backend `monsters.cpp`
- Item database: 31 items, ids identical to backend `items.cpp`
- Stats display uses GSP `effective_stats`, not local state — anti-
  fabrication contract is preserved

## Feature gaps

### Closed since the audit

| # | Gap | Where it landed |
|---|-----|-----------------|
| 1 | Provisional segments always rendered as confirmed (`provisional: false` was hardcoded) | [src/game/overworld.ts](../src/game/overworld.ts) populates `provisional` from `confirmed`; [src/render/overworld.ts](../src/render/overworld.ts) draws a dashed border and a "?" label |
| 2 | `SegmentInfo` type missing `confirmed` / coordinate / `discoverer` fields | [src/net/rpc.ts](../src/net/rpc.ts) — `SegmentInfo` carries `x`, `y`, `confirmed`, `discoverer`, `constraint_dir`; `PlayerInfo` carries `last_discover_height` |
| 3 | No discoverer-privilege check before `enterChannel` | `validateEnterChannel` in [src/net/validator.ts](../src/net/validator.ts) returns `not_discoverer` before the move is sent |
| 4 | Missing item: `ring_of_strength` | [src/game/items.ts](../src/game/items.ts) — item list matches the backend's 31 |
| 5 | No discovery cooldown UI | `discoveryCooldownRemaining` drives a topbar block countdown and a disabled/annotated Discover control in [src/main.ts](../src/main.ts) |
| 6 | Segments laid out by BFS grid instead of the authoritative on-chain coordinate | [src/game/overworld.ts](../src/game/overworld.ts) places each segment at its own `(x, y)`, negating Y because the GSP uses north = +Y |
| 7 | Item stat bonuses not exposed in `ItemDef` | [src/game/items.ts](../src/game/items.ts) — `strength`/`dexterity`/`constitution`/`intelligence`/`maxHealth` carried for the inventory UI (informational; the GSP still owns the math) |
| 8 | Missing move type: `uq` (unequip) | [src/net/moves.ts](../src/net/moves.ts) — `unequip`, plus `discard` and `gateWalk` |

### Low — out of current scope

| # | Gap | File |
|---|-----|------|
| 9 | Multi-player visit moves: `v` (start), `j` (join), `s` (settle), `lv` (leave) — Phase 14+ | [src/net/moves.ts](../src/net/moves.ts) |

## Error handling

The backend's move processor logs `LOG(WARNING)` and drops invalid
moves silently. Nothing comes back through the contract call, so the
frontend has to work out a move's fate itself. It now does so in two
layers:

- **Before sending**, [src/net/validator.ts](../src/net/validator.ts)
  mirrors the `moveparser.cpp` rules and returns a coded failure
  (`cooldown`, `dir_linked`, `coord_occupied`, `not_discoverer`,
  `in_channel`, …) that becomes a blocking modal — the move is never
  submitted.
- **After sending**, [src/net/pending.ts](../src/net/pending.ts)
  watches for the expected state change and resolves to `applied`,
  `rejected`, or `pending`. Rejection is measured in **blocks**, not
  seconds: only once the GSP has processed two blocks past the
  submission height without the change is the move called rejected.
  `pending` (an idle chain) is reported as "still waiting", not as a
  failure. On a genuine rejection, `diagnoseRejection` in
  [src/main.ts](../src/main.ts) re-runs the validator to name the
  reason, falling back to a generic likely-causes message.

Action buttons are disabled while a move is in flight, so failed moves
can't be stacked.

## Implementation plan (all three passes shipped)

### Pass 1 — Close the type/data gaps (small) — DONE

Foundation for Pass 2. Mostly mechanical.

- [x] Add `confirmed: boolean`, the segment coordinate, and
      `discoverer: string` to `SegmentInfo` in
      [src/net/rpc.ts](../src/net/rpc.ts)
- [x] Add `last_discover_height: number` to `PlayerInfo` in
      [src/net/rpc.ts](../src/net/rpc.ts)
- [x] Add `ring_of_strength` to [src/game/items.ts](../src/game/items.ts)
      (str +2, value 80)
- [x] Extend `ItemDef` with optional stat-bonus fields:
      `strength?`, `dexterity?`, `constitution?`, `intelligence?`,
      `maxHealth?`. Backfill values from
      `~/Projects/xayaroguelike/items.cpp`
- [x] Populate `provisional` from real `confirmed` flag in
      [src/game/overworld.ts](../src/game/overworld.ts)
- [x] Render provisional segments visually (dashed border + "?"
      marker — match the Python multi-explorer test's ASCII output)

### Pass 2 — Client-side pre-validation + error modal (medium) — DONE

- [x] New module `src/net/validator.ts` mirroring
      `~/Projects/xayaroguelike/moveparser.cpp` rules:
  - cooldown check (50 blocks since `last_discover_height`)
  - direction-already-linked check (segment's `links` field)
  - coord-occupied check (the segment coordinate `(x, y)` is unique)
  - discoverer privilege check for `ec` on provisional segments
  - slot conflict for `eq`
  - `in_channel` exclusion
- [x] Each validator returns `{ ok: true } | { ok: false, code: string, title: string, message: string }`
- [x] Wire validator calls into every action handler in
      [src/main.ts](../src/main.ts) — call before submitting; if it
      fails, show modal and don't submit
- [x] New modal component ([src/ui/modal.ts](../src/ui/modal.ts)) —
      a blocking dialog, not a toast, so the user must acknowledge
      before continuing
- [x] Keep the existing message log for success/info; reserve the
      modal for blocking errors

Suggested error messages (concrete enough to be useful):

| Code | Modal copy |
|------|------------|
| `cooldown` | "Discovery is on cooldown. Wait `N` more blocks before discovering again." |
| `dir_linked` | "There is already a segment to the `<dir>`. Travel there or pick another direction." |
| `coord_occupied` | "Another player has already claimed the segment to the `<dir>`. Pick a different direction." |
| `not_discoverer` | "Only the discoverer (`<name>`) can enter this provisional segment. Wait for them to confirm it, then you can join." |
| `slot_taken` | "You already have `<item>` equipped in `<slot>`. Unequip it first." |
| `in_channel` | "You are currently in a channel. Exit it before doing this." |

### Pass 3 — Post-submission revalidation (medium) — DONE

Catches race conditions where a move passed pre-validation but failed
on-chain (another player beat us to a coord; cooldown advanced
between client-side validation and chain inclusion).

- [x] After every move, watch for the expected state change
      ([src/net/pending.ts](../src/net/pending.ts)). The deadline is
      counted in blocks (two past the submission height), not poll
      cycles, so a slow or idle chain reports `pending` rather than a
      false rejection
- [x] If the expected change doesn't materialise, run the validator
      retroactively to diagnose (`diagnoseRejection` in
      [src/main.ts](../src/main.ts))
- [x] Show a modal with the diagnosed reason
- [x] Disable the move buttons during the "pending" window so users
      don't stack failed moves
