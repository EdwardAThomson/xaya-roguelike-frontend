/**
 * Two players, one duel, fought to the finish (spec docs/SPEC_multiplayer_pvp.md).
 *
 * Drives the REAL UI path rather than a debug shortcut, because hosting a
 * duel has no hook: the player walks onto a gate, picks "Wait here for a
 * duel" from the gate dialog, and chooses a stake from the modal that
 * follows. The challenger walks onto their own side of the same gate and
 * takes the join choice. Both then bump into each other until one falls.
 *
 * Prerequisites: a devnet and the static server already running.
 * Run:  npm run duel
 * Env:  ROG_HEADLESS=1 (default is headed), ROG_URL, ROG_MAX_MIN (default 12),
 *        ROG_A / ROG_B to reuse existing characters (they need gold to stake)
 */
import { chromium } from "playwright";
import { bfsStep, sleep } from "./agentcore.mjs";

const URL = `${process.env.ROG_URL || "http://localhost:8000"}/?e2e=1`;
const PROXY = process.env.ROG_PROXY || "http://localhost:18380";
const STAMP = Date.now().toString(36).slice(-4);
const MAX_MS = Number(process.env.ROG_MAX_MIN || 12) * 60000;
const NAME_A = process.env.ROG_A || `duelA${STAMP}`;
const NAME_B = process.env.ROG_B || `duelB${STAMP}`;
const OPPOSITE = { north: "south", south: "north", east: "west", west: "east" };
const DIRS = { east: [1, 0], west: [-1, 0], north: [0, 1], south: [0, -1] };

const findings = [];
const fail = (m) => { findings.push(m); console.log("  ✗ " + m); };
const ok = (m) => console.log("  ✓ " + m);

async function gsp(method, params = []) {
  const r = await fetch(`${PROXY}/gsp`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const res = (await r.json()).result;
  return res && typeof res === "object" && "data" in res ? res.data : res;
}

function driver(page, name) {
  const state = () => page.evaluate(() => globalThis.__rog.state());
  const call = (fn, ...a) =>
    page.evaluate(([f, args]) => globalThis.__rog[f](...args), [fn, a]);
  const map = () => page.evaluate(() => globalThis.__rog.map());

  async function until(pred, ms, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = await state();
      if (pred(s)) return s;
      await sleep(250);
    }
    throw new Error(`[${name}] timed out waiting for ${label}`);
  }
  const idle = (ms = 25000) => until((s) => !s.busy, ms, "the client to be idle");

  /** Click the choice button whose text contains `needle`. */
  async function pickChoice(needle, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const btns = await page.$$(".modal-choice");
      for (const b of btns) {
        const t = (await b.innerText()).toLowerCase();
        if (t.includes(needle.toLowerCase())) { await b.click(); return true; }
      }
      await sleep(200);
    }
    const seen = await page.$$eval(".modal-choice", (els) =>
      els.map((e) => e.innerText.replace(/\s+/g, " ").slice(0, 60)));
    throw new Error(`[${name}] no choice matching "${needle}"; saw ${JSON.stringify(seen)}`);
  }

  /** Close whatever modal is up, whichever kind it is. */
  async function closeModal() {
    // A choice modal (the gate dialog) has .modal-cancel and no
    // .modal-dismiss, so the debug hook's dismiss is a no-op on it.
    for (const sel of [".modal-cancel", ".modal-dismiss"]) {
      const b = await page.$(sel);
      if (b) { await b.click(); await sleep(200); return true; }
    }
    return false;
  }

  /** Walk onto the gate in `dir` of the current room and open its dialog. */
  async function standOnGate(dir) {
    const walls = (await map()).walls;
    for (let i = 0; i < 300; i++) {
      const s = await state();
      const sess = s.session;
      if (!sess) { await sleep(200); continue; }
      const gate = sess.gates.find((g) => g.direction === dir);
      if (!gate) throw new Error(`[${name}] no ${dir} gate here`);
      const onGate = sess.playerX === gate.x && sess.playerY === gate.y;
      // Stepping onto a gate opens its dialog by itself, so if we are
      // there and it is up, we are done.
      if (s.modal && onGate) return;
      if (s.modal) { await closeModal(); continue; }
      if (onGate) {
        await call("input", "gate");           // opens the gate dialog
        await sleep(400);
        return;
      }
      const step = bfsStep(walls, sess.playerX, sess.playerY, gate.x, gate.y);
      if (!step || (!step[0] && !step[1])) await call("input", "wait");
      else await call("input", "move", step[0], step[1]);
      await sleep(70);
    }
    throw new Error(`[${name}] could not reach the ${dir} gate`);
  }

  async function start() {
    await page.goto(URL);
    await call("connect", name);
    await until((s) => s.status === "connected", 25000, "connect");
    if (!(await state()).player) { await call("register"); await idle(30000); }
    await until((s) => !!s.player, 35000, "the player on-chain");
  }
  return { page, name, state, call, map, until, idle, pickChoice, standOnGate, closeModal, start };
}

const browser = await chromium.launch({ headless: !!process.env.ROG_HEADLESS });
const A = driver(await (await browser.newContext()).newPage(), NAME_A);
const B = driver(await (await browser.newContext()).newPage(), NAME_B);
for (const d of [A, B]) {
  d.page.on("pageerror", (e) => fail(`[${d.name}] page error: ${e.message}`));
  // Settlement runs as a floating promise, so a throw inside it surfaces
  // as an unhandled rejection on the console rather than a page error.
  d.page.on("console", (m) => {
    if (m.type() === "error") console.log(`   [${d.name}] console error: ${m.text().slice(0, 300)}`);
  });
}

try {
  console.log("1. connect + register");
  await A.start();
  await B.start();
  ok(`${A.name} and ${B.name} are on-chain`);

  console.log("2. confirm an arena next to the hub");
  let s = await A.state();
  const taken = new Set(s.segments.map((g) => `${g.x},${g.y}`));
  let dir = Object.keys(DIRS).find((k) => {
    const [x, y] = DIRS[k];
    return s.segments.some((g) => g.x === x && g.y === y && g.confirmed);
  });
  if (!dir) {
    dir = Object.keys(DIRS).find((k) => !taken.has(`${DIRS[k][0]},${DIRS[k][1]}`));
    await A.call("gateWalk", dir);
    await A.until((x) => !!x.player?.in_channel, 40000, "to be inside the new segment");
    await A.idle(30000);
    const home = OPPOSITE[dir];
    const walls = (await A.map()).walls;
    for (let i = 0; i < 400; i++) {
      const st = await A.state();
      if (st.modal) { const c = await A.page.$(".modal-confirm"); if (c) { await c.click(); await sleep(200); } else await A.closeModal(); continue; }
      if (!st.player?.in_channel) break;
      if (st.busy) { await sleep(200); continue; }
      const sess = st.session;
      if (!sess) { await sleep(200); continue; }
      const gate = sess.gates.find((g) => g.direction === home) ?? sess.gates[0];
      if (sess.playerX === gate.x && sess.playerY === gate.y) { await A.call("gateWalk", gate.direction); await A.idle(30000); continue; }
      const step = bfsStep(walls, sess.playerX, sess.playerY, gate.x, gate.y);
      if (!step || (!step[0] && !step[1])) await A.call("input", "wait");
      else await A.call("input", "move", step[0], step[1]);
      await sleep(80);
    }
    await A.until((x) => !x.player?.in_channel, 40000, "to be back at the hub");
  }
  const arena = { x: DIRS[dir][0], y: DIRS[dir][1] };
  s = await A.state();
  if (!s.segments.some((g) => g.x === arena.x && g.y === arena.y && g.confirmed))
    fail(`arena (${arena.x}, ${arena.y}) is not confirmed`);
  else ok(`arena (${arena.x}, ${arena.y}) confirmed, through the hub's ${dir} gate`);

  console.log("3. host a duel from the gate dialog");
  await A.standOnGate(dir);
  await A.pickChoice("wait here for a duel");
  await sleep(400);
  // Whatever stake this character can actually afford.
  const stakes = await A.page.$$eval(".modal-choice", (els) =>
    els.map((e) => e.innerText.replace(/\s+/g, " ")));
  console.log(`   stakes offered: ${JSON.stringify(stakes.map((t) => t.split(" ").slice(0, 3).join(" ")))}`);
  await A.pickChoice(stakes.length > 1 ? stakes[stakes.length - 1].split(" ")[0] : "no stake");
  const hosted = await A.until((x) => !!x.player?.active_visit, 35000, "the duel to open");
  const visitId = hosted.player.active_visit.visit_id;
  const onChain = await gsp("getvisitinfo", [visitId]);
  if (onChain?.mode !== "duel") fail(`visit ${visitId} mode is ${onChain?.mode}, not duel`);
  else ok(`duel #${visitId} open, stake ${onChain.stake ?? 0}, pot ${onChain.pot ?? 0}`);

  console.log("4. challenger walks in from their own side");
  await B.until((x) => (x.joinable ?? []).some((j) => j.visit.id === visitId), 25000,
                "the duel to reach the challenger's lobby");
  await B.standOnGate(dir);
  await B.pickChoice("duel");
  await B.until((x) => x.player?.active_visit?.visit_id === visitId, 35000, "to join");
  const joined = await gsp("getvisitinfo", [visitId]);
  ok(`both in, status ${joined.status}, pot ${joined.pot ?? 0}`);

  console.log("5. both clients open the arena");
  await Promise.all([
    A.until((x) => !!x.coop, 45000, "the duel to start for the host"),
    B.until((x) => !!x.coop, 45000, "the duel to start for the challenger"),
  ]);
  const sa = await A.state(), sb = await B.state();
  if (sa.coop.me === sb.coop.me) fail("both clients think they are the same duellist");
  ok(`${sa.coop.names.join(" vs ")}; host is index ${sa.coop.me}`);

  console.log("6. fight");
  const walls = (await A.map()).walls;
  const t0 = Date.now();
  let lastTurn = -1;
  let reportedDeath = false;
  while (Date.now() - t0 < MAX_MS) {
    for (const d of [A, B]) {
      const st = await d.state();
      if (st.modal) { await d.closeModal(); continue; }
      if (!st.coop) continue;
      const c = st.coop;
      const self = c.players[c.me];
      const foe = c.players[1 - c.me];
      if (self.dead || self.exited || c.settling || c.pendingOwn || !c.myTurn) continue;
      const sess = st.session;
      if (!sess) continue;

      if (Math.abs(self.x - foe.x) <= 1 && Math.abs(self.y - foe.y) <= 1) {
        await d.call("input", "move", foe.x - self.x, foe.y - self.y);
        continue;
      }
      const mon = sess.monsters.find(
        (m) => Math.abs(m.x - self.x) <= 1 && Math.abs(m.y - self.y) <= 1);
      if (mon) { await d.call("input", "move", mon.x - self.x, mon.y - self.y); continue; }
      const step = bfsStep(walls, self.x, self.y, foe.x, foe.y);
      if (!step || (!step[0] && !step[1])) await d.call("input", "wait");
      else await d.call("input", "move", step[0], step[1]);
    }

    const st = (await A.state()).coop ? await A.state() : await B.state();
    if (!st.coop) break;
    if (st.coop.turns >= lastTurn + 10) {
      lastTurn = st.coop.turns;
      const hp = st.coop.players.map((p, i) =>
        `${st.coop.names[i]} ${p.dead ? "DEAD" : p.hp}`).join("  ");
      console.log(`   round ${String(st.coop.turns).padStart(3)}  ${hp}`);
    }
    if (st.coop.players.some((p) => p.dead) && !reportedDeath) {
      reportedDeath = true;
      for (let k = 0; k < 8; k++) {
        const line = [];
        for (const d of [A, B]) {
          const x = await d.state();
          line.push(`${d.name} turns=${x.coop?.turns ?? "-"} waitingOn=${x.coop?.waitingOn ?? "-"} ` +
                    `myTurn=${x.coop?.myTurn} pending=${x.coop?.pendingOwn} ` +
                    `over=${x.session?.gameOver} settling=${x.coop?.settling} ` +
                    `err=${x.coop?.settleError ?? x.coop?.transportError ?? "none"}`);
        }
        console.log(`   t+${k}s  ${line.join("  |  ")}`);
        await sleep(1000);
      }
    }
    await sleep(120);
  }

  console.log("7. settlement");
  let v = null;
  for (let i = 0; i < 150; i++) {
    v = await gsp("getvisitinfo", [visitId]);
    if (v && v.status !== "active") break;
    await sleep(1000);
  }
  if (!v || v.status !== "completed") fail(`duel did not complete (status ${v?.status})`);
  else {
    ok(`duel #${visitId} completed on-chain`);
    for (const r of v.results ?? [])
      console.log(`   ${r.name}: survived=${r.survived} xp=${r.xp_gained} gold=${r.gold_gained}`);
  }
  for (const d of [A, B]) {
    const p = await gsp("getplayerinfo", [d.name]);
    console.log(`   ${d.name}: ${p.gold} gold, ${p.xp} xp, hp ${p.hp}/${p.max_hp}, at (${p.segment.x}, ${p.segment.y})`);
    if (p.active_visit) fail(`${d.name} still has an active visit`);
  }
} catch (e) {
  fail(`exception: ${e.message}`);
} finally {
  if (!process.env.ROG_KEEP) await browser.close();
}

console.log(findings.length ? `\nFAIL (${findings.length})` : "\nPASS");
for (const f of findings) console.log(" - " + f);
process.exit(findings.length ? 1 : 0);
