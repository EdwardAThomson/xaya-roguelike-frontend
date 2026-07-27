/**
 * Persistent multi-agent population. Keeps N self-playing bots alive in the
 * shared world indefinitely: each bot restarts a fresh play cycle when its
 * previous one ends (or errors), so the world stays populated and active for
 * observing multiplayer behaviour over time. A referee polls the global GSP
 * state and logs any cross-player invariant violation the moment it appears
 * (coordinate uniqueness, no segment on the hub coord, players on valid
 * segments, hp in range), plus a periodic heartbeat of the world size.
 *
 * The bots are paced (they do not rush): each action has a short delay and
 * discoveries are throttled by the on-chain cooldown. A higher OUTBOUND lets
 * them discover deeper (from inside confirmed segments, not just the hub).
 *
 * Prereqs (rate limit off, which is the local default):
 *   1. source ~/Explore/xayax/.venv/bin/activate && python3 devnet/frontend_devnet.py
 *   2. python3 serve.py 8000
 * Run:   node tests/e2e/persist.mjs      (or: npm run persist)
 * Env:   ROG_AGENTS (default 4), ROG_OUTBOUND (default 8), ROG_TICKS
 *        (ticks per cycle, default 1200), ROG_URL, ROG_PROXY, ROG_HEADED.
 * Stop:  Ctrl-C / SIGTERM (kills the process; bots leave the world as-is).
 */
import { chromium } from "playwright";
import { playAgent, sleep } from "./agentcore.mjs";

const URL = `${process.env.ROG_URL || "http://localhost:8000"}/?e2e=1`;
const PROXY = process.env.ROG_PROXY || "http://localhost:18380";
const N = Number(process.env.ROG_AGENTS || 4);
const OUTBOUND = Number(process.env.ROG_OUTBOUND || 8);
const TICKS = Number(process.env.ROG_TICKS || 1200);
const STAMP = Date.now().toString(36).slice(-4);
const seenViol = new Set();

const ts = () => new Date().toISOString().slice(11, 19);

async function gsp(method, params = []) {
  const r = await fetch(`${PROXY}/gsp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await r.json()).result;
}

/** Cross-player invariants; logs each distinct violation once, as it appears. */
function check(gs) {
  if (!gs) return;
  const out = [];
  const coords = new Map();
  for (const s of gs.segments || []) {
    const k = `${s.world_x},${s.world_y}`;
    if (s.world_x === 0 && s.world_y === 0)
      out.push(`segment ${s.id} occupies hub coord (0,0)`);
    if (coords.has(k))
      out.push(`two segments share coord (${k}): #${coords.get(k)} & #${s.id}`);
    else coords.set(k, s.id);
  }
  const ids = new Set((gs.segments || []).map((s) => s.id));
  for (const p of gs.players || []) {
    if (p.hp < 0 || p.hp > p.max_hp)
      out.push(`${p.name} hp out of range: ${p.hp}/${p.max_hp}`);
    if (p.current_segment !== 0 && !ids.has(p.current_segment))
      out.push(`${p.name} on nonexistent segment ${p.current_segment}`);
  }
  for (const v of out) {
    if (!seenViol.has(v)) {
      seenViol.add(v);
      console.log(`${ts()} !! VIOLATION: ${v}`);
    }
  }
}

let stop = false;
process.on("SIGINT", () => { stop = true; });
process.on("SIGTERM", () => { stop = true; });

async function referee() {
  let beats = 0;
  while (!stop) {
    try {
      const gs = (await gsp("getcurrentstate"))?.gamestate;
      check(gs);
      if (beats % 6 === 0 && gs) {
        const segs = (gs.segments || []).length;
        const conf = (gs.segments || []).filter((s) => s.confirmed).length;
        const inCh = (gs.players || []).filter((p) => p.in_channel).length;
        console.log(`${ts()} .. world: ${(gs.players || []).length} players (${inCh} in dungeons), ${segs} segments (${conf} confirmed), ${seenViol.size} violations so far`);
      }
    } catch { /* transient */ }
    beats++;
    await sleep(5000);
  }
}

async function runAgent(page, name) {
  let cycle = 0;
  while (!stop) {
    cycle++;
    try {
      const s = await playAgent(page, { name, findings: [], outbound: OUTBOUND, maxTicks: TICKS });
      console.log(`${ts()} [${name}] cycle ${cycle} done ${JSON.stringify(s)}`);
    } catch (e) {
      console.log(`${ts()} [${name}] cycle ${cycle} ERROR ${e.message}`);
      try {
        await page.reload();
        await page.waitForFunction(() => !!globalThis.__rog, null, { timeout: 20000 });
      } catch { /* will retry next cycle */ }
    }
    await sleep(1500);
  }
}

const browser = await chromium.launch({ headless: !process.env.ROG_HEADED });
const agents = [];
for (let i = 0; i < N; i++) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const name = `bot${STAMP}_${i}`;
  await page.goto(URL);
  await page.waitForFunction(() => !!globalThis.__rog, null, { timeout: 20000 });
  agents.push({ page, name });
}
console.log(`${ts()} persist: ${N} bots live (${agents.map((a) => a.name).join(", ")}), outbound=${OUTBOUND}, ticks/cycle=${TICKS}`);

referee();
// Stagger starts so they do not all hammer the hub on the same tick.
await Promise.all(agents.map((a, i) => sleep(i * 1200).then(() => runAgent(a.page, a.name))));

await browser.close();
