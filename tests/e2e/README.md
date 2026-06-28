# Headless E2E (Playwright)

Drives the **real** frontend in headless Chromium against a running devnet
stack, so gameplay-flow bugs (gate-walk, retreat, inventory, death/respawn)
can be caught automatically instead of by hand-clicking the browser.

It uses the `?e2e=1` debug hook (`window.__rog` in `src/main.ts`): read-only
state plus the same orchestration functions the UI calls. The hook is absent
without `?e2e=1`, so it never ships in normal play or the hosted demo.

## Two harnesses

- `npm run e2e` — a fixed scenario (`run.mjs`), good for a quick check.
- `npm run agent` — a heuristic self-playing soak agent (`agent.mjs`) that
  explores segment to segment, fights, equips, discovers NEW segments
  (confirming them on the way back), and freely transits OLD confirmed ones,
  checking invariants every tick and reporting anomalies.

## Run

In three terminals:

```bash
# 1. backend stack (GSP + move proxy). For the agent, disable the public
#    rate limit so automated play isn't throttled:
source ~/Explore/xayax/.venv/bin/activate
ROG_RATE_LIMIT_MAX=0 python3 devnet/frontend_devnet.py   # in the xayaroguelike repo

# 2. frontend static server
python3 serve.py 8000                     # in this repo

# 3. play
npm run agent          # or: npm run e2e
```

Env: `ROG_URL` (default `http://localhost:8000`), `ROG_HEADED=1` to watch the
browser, `ROG_OUTBOUND` (agent, default 4) how many new segments to open,
`ROG_TICKS` (agent, default 600).

Note: leave the public rate limit on (`ROG_RATE_LIMIT_MAX` unset) for the
real demo; only disable it for the agent's fast automated play.

## Isolation caveat

The devnet chain **persists across runs**, so a previous run can leave state
(e.g. a provisional segment owned by a finished player) that affects the next
run. For reliable runs, restart `frontend_devnet.py` (fresh chain) before
each `npm run e2e`. A future improvement is to have the harness reset the
chain per run.
