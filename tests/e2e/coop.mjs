/**
 * End-to-end co-op run: two players in two browser contexts against ONE
 * devnet stack.  Alice confirms a segment (gate-walks in and out), hosts a
 * co-op visit on it; Bob joins; both play the shared dungeon over the
 * proxy relay (each client applies both players' actions in the canonical
 * round order); both exit through a gate; Bob confirms the merged log
 * (`sc`) and Alice settles it (`s`).  Asserts the two clients held the
 * same log hash at the end, the visit completed on-chain with a result
 * row per player, and both players' visits_completed advanced.
 *
 * Prerequisites (rate limit must be off — it's off locally by default):
 *   1. source ~/Explore/xayax/.venv/bin/activate && python3 devnet/frontend_devnet.py
 *   2. python3 serve.py 8000        (in this repo)
 * Run:  node tests/e2e/coop.mjs
 * Env:  ROG_URL, ROG_PROXY (default http://localhost:18380), ROG_HEADED=1.
 */
import { chromium } from "playwright";
import { bfsStep, navigateOut, sleep } from "./agentcore.mjs";

const URL = `${process.env.ROG_URL || "http://localhost:8000"}/?e2e=1`;
const PROXY = process.env.ROG_PROXY || "http://localhost:18380";
const STAMP = Date.now().toString(36).slice(-5);
const findings = [];
const fail = (m) => { findings.push(m); console.log("  ✗ " + m); };
const ok = (m) => console.log("  ✓ " + m);

async function gsp(method, params = []) {
  const r = await fetch(`${PROXY}/gsp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  // The daemon's custom methods return a state envelope; the payload is .data.
  const res = (await r.json()).result;
  return res && typeof res === "object" && "data" in res ? res.data : res;
}

function driver(page, name) {
  const state = () => page.evaluate(() => globalThis.__rog.state());
  const call = (fn, ...a) => page.evaluate(([f, args]) => globalThis.__rog[f](...args), [fn, a]);
  const map = () => page.evaluate(() => globalThis.__rog.map());
  async function waitIdle(ms = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = await state();
      if (!s.busy) return s;
      await sleep(150);
    }
    return state();
  }
  async function until(pred, ms, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = await state();
      if (pred(s)) return s;
      await sleep(250);
    }
    fail(`[${name}] timed out waiting for ${label}`);
    return state();
  }
  async function connectAndRegister() {
    await page.goto(URL);
    await call("connect", name);
    await until(s => s.status === "connected", 20000, "connect");
    let s = await state();
    if (!s.player) { await call("register"); await waitIdle(); }
    s = await until(s => !!s.player, 30000, "register");
    if (!s.player) fail(`[${name}] no player after register`);
    return s;
  }
  return { page, name, state, call, map, waitIdle, until, connectAndRegister };
}

/**
 * One co-op play tick.  Fights an adjacent monster, hunts the nearest one
 * for the first `huntTurns` turns (so both players deal damage and the
 * pools have something to split), then heads for the nearest gate and
 * exits.  Uses the same keyboard path as a human (the `input` hook).
 */
async function coopTick(d, walls, huntTurns) {
  const s = await d.state();
  if (s.modal) {
    const c = await d.page.$(".modal-confirm");
    if (c) await c.click(); else await d.call("dismissModal");
    return "modal";
  }
  if (!s.coop) return "nocoop";
  const c = s.coop;
  const meP = c.players[c.me];
  if (meP.dead || meP.exited) return "done";
  if (c.settling) return "settling";
  if (c.pendingOwn) return "pending";
  const sess = s.session;
  if (!sess) return "nosession";

  if (sess.hp < sess.maxHp * 0.5
      && s.player.inventory.some(i => i.slot === "bag" && i.item_id === "health_potion")) {
    await d.call("input", "use_potion");
    return "potion";
  }
  const adj = sess.monsters.find(m => Math.abs(m.x - meP.x) <= 1 && Math.abs(m.y - meP.y) <= 1);
  if (adj) { await d.call("input", "move", adj.x - meP.x, adj.y - meP.y); return "attack"; }

  if (sess.groundItems.some(g => g.x === meP.x && g.y === meP.y)) {
    await d.call("input", "pickup");
    return "pickup";
  }

  // Other players block movement: treat their tiles as walls for the BFS.
  const grid = walls.map(row => row.slice());
  c.players.forEach((q, i) => { if (i !== c.me && !q.dead && !q.exited) grid[q.y][q.x] = true; });

  let target = null;
  if (c.turns < huntTurns && sess.monsters.length) {
    target = sess.monsters
      .map(m => ({ m, dist: Math.abs(m.x - meP.x) + Math.abs(m.y - meP.y) }))
      .sort((a, b) => a.dist - b.dist)[0].m;
  }
  if (!target) {
    const onGate = sess.gates.find(g => g.x === meP.x && g.y === meP.y);
    if (onGate) { await d.call("coopExit"); return "exit"; }
    target = sess.gates
      .map(g => ({ g, dist: Math.abs(g.x - meP.x) + Math.abs(g.y - meP.y) }))
      .sort((a, b) => a.dist - b.dist)[0].g;
  }
  const step = bfsStep(grid, meP.x, meP.y, target.x, target.y);
  if (!step || (!step[0] && !step[1])) { await d.call("input", "wait"); return "wait"; }
  await d.call("input", "move", step[0], step[1]);
  return "move";
}

async function playCoop(d, walls, label) {
  let lastHash = null, ticks = 0, lastTurns = -1, idle = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    const r = await coopTick(d, walls, 30);
    ticks++;
    const s = await d.state();
    if (s.coop) {
      lastHash = s.coop.logHash;
      if (s.coop.turns === lastTurns) idle++; else { idle = 0; lastTurns = s.coop.turns; }
      if (s.coop.settleError) { fail(`[${label}] settle error: ${s.coop.settleError}`); }
    }
    if (r === "nocoop" && ticks > 5) break;      // run settled and torn down
    if (r === "done" || r === "settling") { await sleep(500); continue; }
    if (idle > 400) { fail(`[${label}] no progress for ${idle} ticks`); break; }
    await sleep(r === "pending" ? 120 : 60);
  }
  return lastHash;
}

const browser = await chromium.launch({ headless: !process.env.ROG_HEADED });
const A = driver(await (await browser.newContext()).newPage(), `coopA${STAMP}`);
const B = driver(await (await browser.newContext()).newPage(), `coopB${STAMP}`);
for (const d of [A, B]) d.page.on("pageerror", e => fail(`[${d.name}] page error: ${e.message}`));

try {
  console.log("1. connect + register");
  // Sequential: the dev static server is single-threaded, and two module
  // graphs loading at once can stall one page's load event.
  await A.connectAndRegister();
  await B.connectAndRegister();

  console.log("2. alice confirms a segment (gate-walk out of the hub and back)");
  // Pick a hub direction whose neighbour is not yet taken.
  let s = await A.state();
  const taken = new Set(s.segments.map(g => `${g.x},${g.y}`));
  const dirs = { east: [1, 0], west: [-1, 0], north: [0, 1], south: [0, -1] };
  let dir = Object.keys(dirs).find(k => !taken.has(`${dirs[k][0]},${dirs[k][1]}`));
  let segCoord = null;
  if (dir) {
    segCoord = { x: dirs[dir][0], y: dirs[dir][1] };
    await A.call("gateWalk", dir);
    s = await A.until(st => !!st.player?.in_channel, 30000, "enter provisional segment");
    if (s.player?.in_channel) {
      s = await navigateOut(A.page, { name: A.name, findings });
    }
    s = await A.until(st => st.segments.some(g => g.x === segCoord.x && g.y === segCoord.y && g.confirmed),
                      30000, "segment confirmed");
  } else {
    // World already full around the hub: use any confirmed neighbour.
    const conf = s.segments.find(g => g.confirmed && Math.abs(g.x) + Math.abs(g.y) === 1);
    if (conf) segCoord = { x: conf.x, y: conf.y };
  }
  if (!segCoord) { fail("no confirmed segment available to host on"); throw new Error("setup"); }
  s = await A.state();
  if (!s.segments.some(g => g.x === segCoord.x && g.y === segCoord.y && g.confirmed))
    fail(`segment (${segCoord.x},${segCoord.y}) is not confirmed`);
  else ok(`segment (${segCoord.x},${segCoord.y}) confirmed`);
  if (s.player.in_channel) fail("alice still in a channel after confirming");

  console.log("3. alice hosts, bob joins");
  await A.call("coopHost", segCoord.x, segCoord.y);
  s = await A.until(st => !!st.player?.active_visit, 30000, "host visit");
  const visitId = s.player?.active_visit?.visit_id;
  if (!visitId) { fail("no visit id after hosting"); throw new Error("host"); }
  ok(`visit #${visitId} open`);
  await B.call("coopJoin", visitId);
  await B.until(st => st.player?.active_visit?.visit_id === visitId, 30000, "join visit");
  const vinfo = await gsp("getvisitinfo", [visitId]);
  if (vinfo?.status !== "active") fail(`visit status after join: ${vinfo?.status}`);
  else ok("visit active on-chain");

  console.log("4. both clients start the run");
  await Promise.all([
    A.until(st => !!st.coop, 30000, "alice coop runner"),
    B.until(st => !!st.coop, 30000, "bob coop runner"),
  ]);
  const sa = await A.state(), sb = await B.state();
  if (!sa.coop || !sb.coop) throw new Error("runners did not start");
  if (JSON.stringify(sa.coop.names) !== JSON.stringify(sb.coop.names)) fail("participant order differs");
  if (sa.coop.me === sb.coop.me) fail("both clients think they are the same participant");
  ok(`participants ${sa.coop.names.join(", ")}; alice=${sa.coop.me}, bob=${sb.coop.me}`);
  const walls = (await A.map()).walls;

  console.log("5. play (shared run over the relay)");
  const [hashA, hashB] = await Promise.all([playCoop(A, walls, "alice"), playCoop(B, walls, "bob")]);
  console.log(`   final hashes: alice=${hashA?.slice(0, 16)} bob=${hashB?.slice(0, 16)}`);
  if (!hashA || !hashB || hashA !== hashB) fail("clients ended with different merged logs");
  else ok("both clients hold the same merged log");

  console.log("6. settlement");
  const t0 = Date.now();
  let v = null;
  while (Date.now() - t0 < 120000) {
    v = await gsp("getvisitinfo", [visitId]);
    if (v && v.status !== "active") break;
    await sleep(1000);
  }
  if (!v || v.status !== "completed") fail(`visit did not complete (status ${v?.status})`);
  else {
    ok(`visit #${visitId} completed on-chain`);
    const names = (v.results ?? []).map(r => r.name).sort();
    if (names.length !== 2) fail(`expected 2 result rows, got ${names.length}`);
    for (const r of v.results ?? [])
      console.log(`   ${r.name}: survived=${r.survived} xp=${r.xp_gained} gold=${r.gold_gained} kills=${r.kills}`);
  }
  for (const d of [A, B]) {
    const p = await gsp("getplayerinfo", [d.name]);
    if (!p) { fail(`[${d.name}] missing after settle`); continue; }
    if (p.active_visit) fail(`[${d.name}] still has an active visit`);
    if (p.combat_record.visits_completed < 1) fail(`[${d.name}] visits_completed did not advance`);
  }
  await Promise.all([
    A.until(st => !st.coop && !st.player?.active_visit, 30000, "alice teardown"),
    B.until(st => !st.coop && !st.player?.active_visit, 30000, "bob teardown"),
  ]);
  ok("both clients tore the run down");
} catch (e) {
  fail(`exception: ${e.message}`);
} finally {
  await browser.close();
}

console.log(findings.length ? `\nFAIL (${findings.length} findings)` : "\nPASS");
for (const f of findings) console.log(" - " + f);
process.exit(findings.length ? 1 : 0);
