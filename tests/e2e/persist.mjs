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

// Manhattan distance of a segment from the hub (0,0). This is the DEPTH proxy
// and the "how far can a character get" metric the soak is measuring.
const segDist = (s) => Math.abs(s.world_x) + Math.abs(s.world_y);
let maxDistEver = 0;
let maxDistFirstSeen = null;

async function referee() {
  let beats = 0;
  while (!stop) {
    try {
      const gs = (await gsp("getcurrentstate"))?.gamestate;
      check(gs);
      if (beats % 6 === 0 && gs) {
        const segments = gs.segments || [];
        const players = gs.players || [];
        const conf = segments.filter((s) => s.confirmed);
        const inCh = players.filter((p) => p.in_channel).length;

        // Max distance reached (confirmed segments are places you can actually
        // stand; provisionals are unconfirmed claims, tracked separately).
        const maxConf = conf.reduce((m, s) => Math.max(m, segDist(s)), 0);
        const maxAny = segments.reduce((m, s) => Math.max(m, segDist(s)), 0);
        if (maxConf > maxDistEver) { maxDistEver = maxConf; maxDistFirstSeen = ts(); }

        // Distribution of CONFIRMED segments by distance ring.
        const byDist = {};
        for (const s of conf) byDist[segDist(s)] = (byDist[segDist(s)] || 0) + 1;
        const dist = Object.keys(byDist).map(Number).sort((a, b) => a - b)
          .map((d) => `d${d}:${byDist[d]}`).join(" ");

        // Per-player level + current distance from hub.
        const segById = new Map(segments.map((s) => [s.id, s]));
        const perBot = players.map((p) => {
          const seg = p.current_segment === 0 ? null : segById.get(p.current_segment);
          const d = seg ? segDist(seg) : 0;
          return `${p.name}=L${p.level}@d${d}`;
        }).join(" ");

        console.log(`${ts()} .. world: ${players.length} players (${inCh} in dungeons), ${segments.length} segments (${conf.length} confirmed), ${seenViol.size} violations`);
        console.log(`${ts()} ** MAX DIST: ${maxDistEver} (confirmed; live max ${maxConf}, incl. provisional ${maxAny}); first reached ${maxDistFirstSeen}`);
        console.log(`${ts()} ** rings (confirmed): ${dist || "(none)"}`);
        console.log(`${ts()} ** bots: ${perBot}`);
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
  // Fixed names (no run stamp) so restarting the harness REUSES the same
  // on-chain identities instead of minting a fresh set each time and
  // leaving old bots parked at the hub forever, cluttering the world.
  const name = `bot_${i}`;
  await page.goto(URL);
  await page.waitForFunction(() => !!globalThis.__rog, null, { timeout: 20000 });
  agents.push({ page, name });
}
console.log(`${ts()} persist: ${N} bots live (${agents.map((a) => a.name).join(", ")}), outbound=${OUTBOUND}, ticks/cycle=${TICKS}`);

referee();
// Stagger starts so they do not all hammer the hub on the same tick.
await Promise.all(agents.map((a, i) => sleep(i * 1200).then(() => runAgent(a.page, a.name))));

await browser.close();
