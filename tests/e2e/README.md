# Headless E2E (Playwright)

Drives the **real** frontend in headless Chromium against a running devnet
stack, so gameplay-flow bugs (gate-walk, retreat, inventory, death/respawn)
can be caught automatically instead of by hand-clicking the browser.

It uses the `?e2e=1` debug hook (`window.__rog` in `src/main.ts`): read-only
state plus the same orchestration functions the UI calls. The hook is absent
without `?e2e=1`, so it never ships in normal play or the hosted demo.

## `npm run e2e:ui` — self-contained DOM UI suite (recommended)

`ui.mjs` is the **ship-with-confidence** suite. Unlike the harnesses below it
needs **nothing** running first: it spins up its OWN isolated full stack on
alt ports and drives the flows through the **real DOM** (clicking real buttons,
pressing real keys), asserting each feature genuinely works.

```bash
npm run e2e:ui
```

- **Isolated stack** (`stack.mjs`): its own anvil + xayax + GSP daemon + move
  proxy (via `devnet/frontend_devnet.py` with `ROG_GSP_PORT` / `ROG_PROXY_PORT`
  / `ROG_BASE_PORT`) plus a static server (`serve.py`), on ports
  **18432 / 18480 / 23100+ / 8100**. These never collide with a live devnet
  (18332 / 18380 / 8545 / 8000), so it is safe to run alongside one. The whole
  stack is torn down on exit.
- **Endpoint override**: the browser opens
  `http://localhost:8100/?e2e=1&gsp=...&proxy=...`. `src/config.ts` reads the
  `?gsp=` / `?proxy=` query params (or `window.__ROG_GSP` / `window.__ROG_PROXY`
  globals) so the page talks to THIS stack. Defaults are unchanged when the
  params are absent.
- **DOM-driven**: each flow clicks the actual buttons / presses the actual keys
  and asserts the observable outcome. The `window.__rog` hook is used only to
  read state to assert on and for setup navigation (walking a dungeon), never
  to stand in for the feature under test.

Flows covered (each an entry in `ui.mjs`, easy to extend):

| id  | flow |
|-----|------|
| T1  | landing → Play → connect + register; re-register the same name does **not** 500 (already-minted recovery) and the player persists |
| T6  | modal tabs switch (Inventory/Players/Help), Players tab lists the player, `?`/`I`/`M` keys, help + world-map toggles |
| T2a | hub inventory: full-HP potion guard shows its message |
| T4a | discover a frontier segment (provisional); cooldown message on a too-soon second discovery |
| T3  | in-dungeon: modal equip is read-only, drink a potion from the modal raises HP |
| T5  | pick up loot in a run (real `G` key), exit via a gate, loot persists into the bag; the survived run confirms the segment |
| T2b | hub inventory: equip a bag item to its slot, then unequip |
| T4b | free transit hub ↔ confirmed segment, landing on the other side of the gate, and back to the hub |
| T7  | die in a dungeon → respawn at the hub with reduced HP |
| T2c | hub inventory: drink a potion while hurt raises HP and drops the count |
| T2d | hub inventory: discard removes a bag item |
| T1b | interrupted register (name pre-minted, no player) still registers via the DOM |

Env: `ROG_HEADED=1` to watch the browser, `ROG_STACK_VERBOSE=1` to stream the
stack's stdout/stderr, `ROG_ONLY="T1,T6"` to run a subset by id (note most
gameplay tests share state and must run in order), `ROG_KEEP=1` to leave the
stack running on exit for debugging. Alt ports are overridable via
`ROG_ALT_GSP_PORT` / `ROG_ALT_PROXY_PORT` / `ROG_ALT_FRONTEND_PORT` /
`ROG_ALT_BASE_PORT`.

Prerequisites: the backend built (`build/rogueliked`, `build/roguelike-play`),
the frontend built (`npx tsc` → `dist/`), the xayax venv at
`~/Explore/xayax/.venv`, and Foundry (anvil). Paths are overridable via
`ROG_FRONTEND_DIR` / `ROG_BACKEND_DIR` / `ROG_VENV_PY`.

## Harnesses (require a stack already running)

- `npm run e2e` — a fixed scenario (`run.mjs`), good for a quick check.
- `npm run agent` — one heuristic self-playing soak agent (`agent.mjs`,
  policy in `agentcore.mjs`): explores segment to segment, fights, equips,
  discovers NEW segments (confirming them on the way back) and freely
  transits OLD confirmed ones, checking invariants every tick.
- `npm run multi` — N agents in N browser contexts against one stack,
  competing in the same world (`multi.mjs`), plus a referee that polls the
  global GSP state and asserts cross-player invariants (coordinate
  uniqueness, player/segment sanity). Env: `ROG_AGENTS` (default 3).
- `npm run compete` — scripted competition tests with hard assertions
  (`compete.mjs`): coordinate race (one winner), provisional access +
  confirm-unlocks-others, concurrent reward/ownership isolation. Needs a
  fresh chain (uses fixed hub-adjacent coords).

## Run

In three terminals:

```bash
# 1. backend stack (GSP + move proxy). The per-IP rate limit defaults OFF
#    locally, so automated play isn't throttled — no flag needed.
source ~/Explore/xayax/.venv/bin/activate
python3 devnet/frontend_devnet.py         # in the xayaroguelike repo

# 2. frontend static server
python3 serve.py 8000                     # in this repo

# 3. play
npm run agent          # or: npm run e2e
```

Env: `ROG_URL` (default `http://localhost:8000`), `ROG_HEADED=1` to watch the
browser, `ROG_OUTBOUND` (agent, default 4) how many new segments to open,
`ROG_TICKS` (agent, default 600).

Note: the rate limit is OFF for the local devnet by default; the hosted
deploy (`run_sandbox.sh`) turns it on. Set `ROG_RATE_LIMIT_MAX=N` to enable
it locally if you want to test that path.

## Isolation caveat

The devnet chain **persists across runs**, so a previous run can leave state
(e.g. a provisional segment owned by a finished player) that affects the next
run. For reliable runs, restart `frontend_devnet.py` (fresh chain) before
each `npm run e2e`. A future improvement is to have the harness reset the
chain per run.
