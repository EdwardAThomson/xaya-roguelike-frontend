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
 * Both players host and join from the hub, walking east into the segment
 * through its west gate (co-op is local: you meet by converging on a
 * segment from your own sides, backend spec section 8a), and steer their
 * exits back west so they end up at the hub again for the next scenario.
 *
 * Scenario 2 (abandonment, backend spec section 11): a second visit on the
 * same segment; a few rounds in, Bob's browser closes.  Alice's client
 * sees Bob's last checkpoint go stale (the test mines the window), takes
 * "continue alone", finishes the dungeon solo, and settles with solo_from.
 * Asserts Alice survived and Bob was banked as a death.
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
const OPPOSITE = { north: "south", south: "north", east: "west", west: "east" };
const PROXY = process.env.ROG_PROXY || "http://localhost:18380";
const STAMP = Date.now().toString(36).slice(-5);
const findings = [];
const fail = (m) => { findings.push(m); console.log("  ✗ " + m); };
const ok = (m) => console.log("  ✓ " + m);

async function proxy(body) {
  const r = await fetch(PROXY, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

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
async function coopTick(d, walls, huntTurns, exitDir = null) {
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
    const wanted = exitDir ? sess.gates.find(g => g.direction === exitDir) : null;
    const onGate = sess.gates.find(g => g.x === meP.x && g.y === meP.y);
    if (onGate && (!wanted || onGate.direction === exitDir)) {
      await d.call("coopExit");
      return "exit";
    }
    target = wanted ?? sess.gates
      .map(g => ({ g, dist: Math.abs(g.x - meP.x) + Math.abs(g.y - meP.y) }))
      .sort((a, b) => a.dist - b.dist)[0].g;
  }
  const step = bfsStep(grid, meP.x, meP.y, target.x, target.y);
  if (!step || (!step[0] && !step[1])) { await d.call("input", "wait"); return "wait"; }
  await d.call("input", "move", step[0], step[1]);
  return "move";
}

async function playCoop(d, walls, label, exitDir = null) {
  let lastHash = null, ticks = 0, lastTurns = -1, idle = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    const r = await coopTick(d, walls, 30, exitDir);
    ticks++;
    const s = await d.state();
    if (s.coop) {
      // Sample the hash only once this client's run is over: mid-run the two
      // pages are legitimately a relay hop apart.
      if (s.session?.gameOver || lastHash === null) lastHash = s.coop.logHash;
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
    // World already full around the hub: use any confirmed neighbour, and
    // remember which of the hub's gates leads to it (co-op is by direction).
    const conf = s.segments.find(g => g.confirmed && Math.abs(g.x) + Math.abs(g.y) === 1);
    if (conf) {
      segCoord = { x: conf.x, y: conf.y };
      dir = Object.keys(dirs).find(k => dirs[k][0] === conf.x && dirs[k][1] === conf.y);
    }
  }
  if (!dir) { fail("no hub direction leads to a confirmed segment"); throw new Error("setup"); }
  if (!segCoord) { fail("no confirmed segment available to host on"); throw new Error("setup"); }
  s = await A.state();
  if (!s.segments.some(g => g.x === segCoord.x && g.y === segCoord.y && g.confirmed))
    fail(`segment (${segCoord.x},${segCoord.y}) is not confirmed`);
  else ok(`segment (${segCoord.x},${segCoord.y}) confirmed`);
  if (s.player.in_channel) fail("alice still in a channel after confirming");

  console.log(`3. alice hosts through the hub's ${dir} gate, bob joins from his side`);
  // Co-op is local: both are standing at the hub, so both walk east into
  // the confirmed segment through its west gate.
  s = await A.until(st => (st.coopTargets ?? []).some(t => t.dir === dir), 20000,
                    "the confirmed segment to show up in alice's lobby");
  if (!s.coopTargets?.some(t => t.dir === dir))
    fail(`alice cannot host ${dir} from the hub: ${JSON.stringify(s.coopTargets)}`);
  await A.call("coopHost", dir);
  s = await A.until(st => !!st.player?.active_visit, 30000, "host visit");
  const visitId = s.player?.active_visit?.visit_id;
  if (!visitId) { fail("no visit id after hosting"); throw new Error("host"); }
  ok(`visit #${visitId} open`);
  // Bob's client has to see the open run in his own lobby before he can
  // walk into it; his state poll is a couple of seconds behind the chain.
  const bLobby = await B.until(st => (st.joinable ?? []).some(j => j.visit.id === visitId),
                               20000, "the run to appear in bob's lobby");
  if (!bLobby.joinable?.some(j => j.visit.id === visitId))
    fail(`bob cannot reach visit ${visitId}: ${JSON.stringify(bLobby.joinable)}`);
  await B.call("coopJoin", visitId, dir);
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
  const homeDir = OPPOSITE[dir];
  const [hashA, hashB] = await Promise.all([
    playCoop(A, walls, "alice", homeDir),
    playCoop(B, walls, "bob", homeDir),
  ]);
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

  // ---------------------------------------------------------------------
  console.log("7. abandonment: host again, bob vanishes mid-run");
  for (const d of [A, B]) {
    const st = await d.state();
    if (st.modal) await d.call("dismissModal");
  }
  await A.call("coopHost", dir);
  s = await A.until(st => !!st.player?.active_visit, 30000, "host visit 2");
  const visit2 = s.player?.active_visit?.visit_id;
  if (!visit2) { fail("no second visit id"); throw new Error("host2"); }
  await B.call("coopJoin", visit2, dir);
  await Promise.all([
    A.until(st => !!st.coop, 30000, "alice coop runner (2)"),
    B.until(st => !!st.coop, 30000, "bob coop runner (2)"),
  ]);
  ok(`visit #${visit2} active, both runners up`);

  // Play a few rounds together so bob has a checkpoint beyond the start.
  const walls2 = (await A.map()).walls;
  const t1 = Date.now();
  while (Date.now() - t1 < 20000) {
    const [ra, rb] = await Promise.all([coopTick(A, walls2, 400, null), coopTick(B, walls2, 400, null)]);
    const sa2 = await A.state();
    if (!sa2.coop || sa2.coop.turns >= 24 || ra === "done" || rb === "done") break;
    await sleep(80);
  }
  await B.call("coopCheckpoint");
  await sleep(1500);
  let sb2 = await B.state();
  const bobName = B.name;
  const beforeClose = await A.state();
  console.log(`   bob leaves at ${beforeClose.coop?.turns} turns; his checkpoint: ${JSON.stringify(beforeClose.coopVisit?.confirms?.[bobName] ?? null)}`);
  await B.page.context().close();

  // Alice keeps playing on her own turn until bob's checkpoint is stale.
  // Mine the window (the devnet auto-mines slowly), then abandon.
  await proxy({ action: "mine", blocks: 25 });
  s = await A.until(st => !!st.partnerCheckpoint && st.partnerCheckpoint.stale, 60000, "bob's checkpoint to go stale");
  console.log(`   partner checkpoint: ${JSON.stringify(s.partnerCheckpoint)}`);
  if (!s.partnerCheckpoint?.stale) throw new Error("not stale");
  const soloFrom = s.partnerCheckpoint.n;
  await A.call("coopAbandon");
  s = await A.until(st => !!st.coopSolo, 10000, "solo continuation");
  if (!s.coopSolo) { fail(`continue-alone did not start: ${s.modal ?? ""}`); throw new Error("abandon"); }
  ok(`alice continues alone from action ${s.coopSolo.from} (bob confirmed ${soloFrom})`);

  // Solo play: same driver, but the state comes from the session directly.
  const t2 = Date.now();
  let soloTicks = 0;
  while (Date.now() - t2 < 180000) {
    const st = await A.state();
    if (st.modal) { const c = await A.page.$(".modal-confirm"); if (c) await c.click(); else await A.call("dismissModal"); continue; }
    if (!st.coopSolo) break;                       // settled and torn down
    if (st.session?.gameOver || st.busy) { await sleep(400); continue; }
    const sess = st.session;
    const px = sess.playerX, py = sess.playerY;
    const adj = sess.monsters.find(m => Math.abs(m.x - px) <= 1 && Math.abs(m.y - py) <= 1);
    if (sess.hp < sess.maxHp * 0.5 && st.player.inventory.some(i => i.slot === "bag" && i.item_id === "health_potion")) {
      await A.call("input", "use_potion");
    } else if (adj) {
      await A.call("input", "move", adj.x - px, adj.y - py);
    } else if (sess.gates.some(g => g.x === px && g.y === py)) {
      await A.call("input", "gate");
    } else {
      const gate = sess.gates.map(g => ({ g, d: Math.abs(g.x - px) + Math.abs(g.y - py) })).sort((a, b) => a.d - b.d)[0].g;
      const step = bfsStep(walls2, px, py, gate.x, gate.y);
      if (!step || (!step[0] && !step[1])) await A.call("input", "wait");
      else await A.call("input", "move", step[0], step[1]);
    }
    soloTicks++;
    await sleep(40);
  }
  console.log(`   solo ticks: ${soloTicks}`);

  const t3 = Date.now();
  let v2 = null;
  while (Date.now() - t3 < 90000) {
    v2 = await gsp("getvisitinfo", [visit2]);
    if (v2 && v2.status !== "active") break;
    await sleep(1000);
  }
  if (!v2 || v2.status !== "completed") fail(`abandonment visit did not complete (status ${v2?.status})`);
  else {
    ok(`visit #${visit2} completed via abandonment settle`);
    for (const r of v2.results ?? [])
      console.log(`   ${r.name}: survived=${r.survived} xp=${r.xp_gained} gold=${r.gold_gained} kills=${r.kills}`);
    const ra = (v2.results ?? []).find(r => r.name === A.name);
    const rb = (v2.results ?? []).find(r => r.name === bobName);
    if (!ra?.survived) fail("alice did not survive the solo continuation");
    if (!rb || rb.survived) fail("bob should be banked as a death");
  }
  const pb = await gsp("getplayerinfo", [bobName]);
  if (pb?.active_visit) fail("bob still has an active visit after abandonment");
  await A.until(st => !st.coop && !st.coopSolo && !st.player?.active_visit, 30000, "alice teardown (2)");
  ok("alice tore the run down");
} catch (e) {
  fail(`exception: ${e.message}`);
} finally {
  await browser.close();
}

console.log(findings.length ? `\nFAIL (${findings.length} findings)` : "\nPASS");
for (const f of findings) console.log(" - " + f);
process.exit(findings.length ? 1 : 0);
