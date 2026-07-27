/**
 * Multi-agent harness: N self-playing players in N separate browser
 * contexts against ONE devnet stack, competing in the same world. A
 * referee polls the global GSP state and asserts cross-player invariants
 * (coordinate uniqueness, player/segment sanity) while they play.
 *
 * Exercises the multiplayer checklist: discovery & coordinate contention,
 * provisional access control, shared confirmed segments, and concurrent
 * load. Per-agent expected feedback (cooldowns, "coord occupied",
 * provisional-access blocks) is treated as normal, not a finding.
 *
 * Prerequisites (rate limit must be off — it's off locally by default):
 *   1. source ~/Explore/xayax/.venv/bin/activate && python3 devnet/frontend_devnet.py
 *   2. python3 serve.py 8000        (in this repo)
 * Run:  npm run multi
 * Env:  ROG_AGENTS (default 3), ROG_URL, ROG_PROXY (default
 *       http://localhost:18380), ROG_HEADED=1, ROG_OUTBOUND, ROG_TICKS.
 */
import { chromium } from "playwright";
import { playAgent, sleep } from "./agentcore.mjs";

const URL = `${process.env.ROG_URL || "http://localhost:8000"}/?e2e=1`;
const PROXY = process.env.ROG_PROXY || "http://localhost:18380";
const N = Number(process.env.ROG_AGENTS || 3);
const STAMP = Date.now().toString(36).slice(-5);
const findings = [];
const violations = [];

async function gsp(method, params = []) {
  const r = await fetch(`${PROXY}/gsp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await r.json()).result;
}

/** Cross-player invariants checked against one snapshot of global state. */
function check(gs) {
  if (!gs) return;
  const coords = new Map();
  for (const s of gs.segments || []) {
    const k = `${s.world_x},${s.world_y}`;
    if (s.world_x === 0 && s.world_y === 0)
      violations.push(`segment ${s.id} occupies hub coord (0,0)`);
    if (coords.has(k))
      violations.push(`two segments share coord (${k}): #${coords.get(k)} & #${s.id}`);
    else coords.set(k, s.id);
  }
  const ids = new Set((gs.segments || []).map(s => s.id));
  for (const p of gs.players || []) {
    if (p.hp < 0 || p.hp > p.max_hp)
      violations.push(`${p.name} hp out of range: ${p.hp}/${p.max_hp}`);
    if (p.current_segment !== 0 && !ids.has(p.current_segment))
      violations.push(`${p.name} is on nonexistent segment ${p.current_segment}`);
  }
}

let stop = false;
async function referee() {
  while (!stop) {
    try { check((await gsp("getcurrentstate"))?.gamestate); } catch { /* transient */ }
    await sleep(2000);
  }
}

const browser = await chromium.launch({ headless: !process.env.ROG_HEADED });
const refPromise = referee();

const agents = [];
for (let i = 0; i < N; i++) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const name = `m${STAMP}_${i}`;
  page.on("pageerror", (e) => findings.push(`[${name}] pageerror: ${e.message}`));
  await page.goto(URL);
  await page.waitForFunction(() => !!globalThis.__rog, null, { timeout: 20000 });
  agents.push({ page, name });
}
console.log(`multi: ${N} agents — ${agents.map(a => a.name).join(", ")}`);

const summaries = await Promise.all(agents.map((a, i) =>
  sleep(i * 800).then(() => playAgent(a.page, {
    name: a.name, findings,
    outbound: Number(process.env.ROG_OUTBOUND || 3),
    maxTicks: Number(process.env.ROG_TICKS || 500),
  })).catch(e => { findings.push(`[${a.name}] ERROR: ${e.message}`); return null; })
));

stop = true;
await refPromise;
check((await gsp("getcurrentstate").catch(() => null))?.gamestate); // final consistency snapshot
await browser.close();

console.log("\nsummaries:");
for (const s of summaries) if (s) console.log("  " + JSON.stringify(s));

const refViol = [...new Set(violations)];
console.log(`\nreferee violations: ${refViol.length}`);
for (const v of refViol) console.log("  - " + v);

const all = [...findings, ...refViol.map(v => `REFEREE: ${v}`)];
if (all.length) {
  console.log(`\n${all.length} FINDING(S):`);
  for (const f of all) console.log("  - " + f);
  process.exit(1);
}
console.log("\nNo anomalies. Multi-agent world stayed consistent.");
