# Frontend Parity & Error-Handling Plan

Audit date: 2026-04-14
Backend reference: `~/Projects/xayaroguelike` at commit `0532b41`
Frontend reference: `~/Projects/xaya-roguelike-frontend` (this repo)

## Summary

The deterministic core of the TypeScript port is in sync with the C++
backend — same SHA-256, same MT19937 (with Lemire's method), same
seed format, same monster database, action-log replay correctly
recorded. The gaps are in **newer backend features** the frontend
hasn't picked up yet, and in **error-handling UX** for moves the
backend silently rejects.

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
- Monster database: 13 monsters, stats and depth-scaling identical
  to backend
- Stats display uses GSP `effective_stats`, not local state — anti-
  fabrication contract is preserved

## Feature gaps

### Critical — breaks a current backend feature

| # | Gap | File |
|---|-----|------|
| 1 | Provisional segments always rendered as confirmed (`provisional: false` is hardcoded) | [src/game/overworld.ts:113](../src/game/overworld.ts#L113) |
| 2 | `SegmentInfo` type is missing `confirmed`, `world_x`, `world_y`, `discoverer` fields | [src/net/rpc.ts](../src/net/rpc.ts) |
| 3 | No discoverer-privilege check before `enterChannel` — non-discoverers click "Enter Dungeon" on a provisional segment, GSP silently rejects | [src/main.ts](../src/main.ts) |
| 4 | Missing item: `ring_of_strength` (28th backend item) | [src/game/items.ts](../src/game/items.ts) |
| 5 | No discovery cooldown UI — buttons always enabled, no countdown after a discover | [src/main.ts](../src/main.ts) |

### Medium — incomplete but not blocking

| # | Gap | File |
|---|-----|------|
| 6 | `world_x` / `world_y` ignored — frontend uses BFS grid layout instead of authoritative on-chain 2D coords | [src/game/overworld.ts](../src/game/overworld.ts) |
| 7 | Item stat bonuses (`strength`/`dexterity`/`constitution`/`intelligence`/`maxHealth`) not exposed in `ItemDef` — combat is correct (GSP does the math) but inventory UI can't explain why an item matters | [src/game/items.ts](../src/game/items.ts) |
| 8 | Missing move type: `uq` (unequip) | [src/net/moves.ts](../src/net/moves.ts) |

### Low — out of current scope

| # | Gap | File |
|---|-----|------|
| 9 | Multi-player visit moves: `v` (start), `j` (join), `s` (settle), `lv` (leave) — Phase 14+ | [src/net/moves.ts](../src/net/moves.ts) |

## Error-handling problem

The backend's move processor logs `LOG(WARNING)` and drops invalid
moves silently. Nothing comes back through the contract call. The
frontend currently:

- Catches network/proxy errors and dumps them to an overworld message
  log (easy to miss)
- Has **no mechanism** to detect a successfully-submitted-but-
  silently-rejected move
- Shows generic messages like `"Travel failed: Proxy error 500"`
  with no reason

The root cause is that the frontend has **no client-side validator**
mirroring the backend rules, so it can't tell the user "you're on
cooldown" or "only the discoverer can enter" before sending, and it
can't diagnose after sending either.

## Implementation plan

### Pass 1 — Close the type/data gaps (small)

Foundation for Pass 2. Mostly mechanical.

- [ ] Add `confirmed: boolean`, `world_x: number`, `world_y: number`,
      `discoverer: string` to `SegmentInfo` in
      [src/net/rpc.ts](../src/net/rpc.ts)
- [ ] Add `last_discover_height: number` to `PlayerInfo` in
      [src/net/rpc.ts](../src/net/rpc.ts)
- [ ] Add `ring_of_strength` to [src/game/items.ts](../src/game/items.ts)
      (str +2, value 80)
- [ ] Extend `ItemDef` with optional stat-bonus fields:
      `strength?`, `dexterity?`, `constitution?`, `intelligence?`,
      `maxHealth?`. Backfill values from
      `~/Projects/xayaroguelike/items.cpp`
- [ ] Populate `provisional` from real `confirmed` flag in
      [src/game/overworld.ts:113](../src/game/overworld.ts#L113)
- [ ] Render provisional segments visually (dashed border + "?"
      marker — match the Python multi-explorer test's ASCII output)

### Pass 2 — Client-side pre-validation + error modal (medium)

- [ ] New module `src/net/validator.ts` mirroring
      `~/Projects/xayaroguelike/moveparser.cpp` rules:
  - cooldown check (50 blocks since `last_discover_height`)
  - direction-already-linked check (segment's `links` field)
  - coord-occupied check (UNIQUE `(world_x, world_y)`)
  - discoverer privilege check for `ec` on provisional segments
  - slot conflict for `eq`
  - `in_channel` exclusion
- [ ] Each validator returns `{ ok: true } | { ok: false, code: string, message: string }`
- [ ] Wire validator calls into every action handler in
      [src/main.ts](../src/main.ts) — call before submitting; if it
      fails, show modal and don't submit
- [ ] New modal component (one per error type if helpful; otherwise
      generic title/body/dismiss). Should be a blocking dialog, not
      a toast — the user must acknowledge before continuing
- [ ] Keep the existing message log for success/info; reserve the
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

### Pass 3 — Post-submission revalidation (medium)

Catches race conditions where a move passed pre-validation but failed
on-chain (another player beat us to a coord; cooldown advanced
between client-side validation and chain inclusion).

- [ ] After every move, register an `ExpectedStateChange` with a
      timeout (~3 poll cycles) describing what should change
- [ ] If the expected change doesn't materialise by the deadline,
      refetch `getplayerinfo` and run the validator retroactively to
      diagnose
- [ ] Show a modal with the diagnosed reason
- [ ] Disable the move button during the "pending" window so users
      don't stack failed moves

### Recommended order

Pass 1 first — it's the foundation for Pass 2 (the validator needs
the new type fields), small in scope, and unblocks visible
improvements on its own (provisional segment rendering, item
recognition). Pass 2 next, then Pass 3 once we have real failure
patterns to handle.
