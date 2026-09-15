/**
 * Co-op play driver: two players, one dungeon, cleared to the last monster.
 *
 * Not an assertion suite. This drives two real browser contexts through a
 * full co-op run against a devnet you already have running, so you can watch
 * (or leave) a long session and see whether the round protocol, the relay and
 * the settlement hold up over hundreds of turns rather than a handful.
 *
 * It will, in order: connect and register both players, make sure a confirmed
 * segment borders the hub (discovering and confirming one if not), host and
 * join a co-op run into it from the hub, then hunt every monster and pick up
 * every item before walking both players back out through the gate they came
 * in by. It prints a progress line per round and the settled result.
 *
 * Prerequisites: a devnet and the static server already up, i.e.
 *   python3 devnet/frontend_devnet.py     (in the backend repo, xayax venv)
 *   python3 serve.py 8000                 (here)
 *
 * Run:   npm run coop:play
 * Env:   ROG_HEADLESS=1   run without windows (default is headed, to watch)
 *        ROG_A / ROG_B    player names (default: fresh ones per run)
 *        ROG_URL          default http://localhost:8000
 *        ROG_MAX_MIN      wall-clock budget in minutes (default 20)
 */
import { chromium } from "playwright";
import { bfsStep, sleep } from "./agentcore.mjs";

const URL = `${process.env.ROG_URL || "http://localhost:8000"}/?e2e=1`;
const STAMP = Date.now().toString(36).slice(-4);
const NAME_A = process.env.ROG_A || `playA${STAMP}`;
const NAME_B = process.env.ROG_B || `playB${STAMP}`;
const MAX_MS = Number(process.env.ROG_MAX_MIN || 20) * 60000;
const OPPOSITE = { north: "south", south: "north", east: "west", west: "east" };
const DIRS = { east: [1, 0], west: [-1, 0], north: [0, 1], south: [0, -1] };

const log = (m) => console.log(m);
const die = (m) => { console.error("\n✗ " + m); process.exitCode = 1; };

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
  async function idle(ms = 20000) {
    return until((s) => !s.busy, ms, "the client to go idle");
  }
  async function clearModal() {
    const s = await state();
    if (!s.modal) return false;
    const confirm = await page.$(".modal-confirm");
    if (confirm) await confirm.click();
    else await call("dismissModal");
    await sleep(250);
    return true;
  }
  async function start() {
    await page.goto(URL);
    await call("connect", name);
    await until((s) => s.status === "connected", 25000, "connect");
    if (!(await state()).player) { await call("register"); await idle(30000); }
    await until((s) => !!s.player, 35000, "the player to exist on-chain");
    log(`  ${name}: connected`);
  }
  return { page, name, state, call, map, until, idle, clearModal, start };
}

/** A confirmed segment bordering the hub, discovering one if there is none. */
async function ensureConfirmedNeighbour(d) {
  let s = await d.state();
  const known = new Set(s.segments.map((g) => `${g.x},${g.y}`));
  const confirmed = Object.keys(DIRS).find((k) => {
    const [x, y] = DIRS[k];
    return s.segments.some((g) => g.x === x && g.y === y && g.confirmed);
  });
  if (confirmed) {
    log(`  a confirmed segment already borders the hub to the ${confirmed}`);
    return confirmed;
  }

  const dir = Object.keys(DIRS).find((k) => !known.has(`${DIRS[k][0]},${DIRS[k][1]}`));
  if (!dir) throw new Error("no free direction out of the hub to discover");
  log(`  discovering ${dir} of the hub, then walking straight back out to confirm it`);
  await d.call("gateWalk", dir);
  await d.until((x) => !!x.player?.in_channel, 40000, "to be inside the new segment");
  await d.idle(30000);

  // Straight back out the way we came: surviving to a gate confirms it.
  const home = OPPOSITE[dir];
  const walls = (await d.map()).walls;
  for (let i = 0; i < 400; i++) {
    if (await d.clearModal()) continue;
    const s2 = await d.state();
    if (!s2.player?.in_channel) break;
    if (s2.busy) { await sleep(200); continue; }
    const sess = s2.session;
    if (!sess) { await sleep(200); continue; }
    const gate = sess.gates.find((g) => g.direction === home) ?? sess.gates[0];
    if (sess.playerX === gate.x && sess.playerY === gate.y) {
      await d.call("gateWalk", gate.direction);
      await d.idle(30000);
      continue;
    }
    const step = bfsStep(walls, sess.playerX, sess.playerY, gate.x, gate.y);
    if (!step || (!step[0] && !step[1])) await d.call("input", "wait");
    else await d.call("input", "move", step[0], step[1]);
    await sleep(90);
  }
  await d.until((x) => !x.player?.in_channel, 40000, "to be back at the hub");
  return dir;
}

/**
 * One action for whoever's turn it is: heal, fight what is adjacent, grab
 * what is underfoot, otherwise walk toward the nearest monster, then the
 * nearest item, then the way out.
 */
async function act(d, walls, exitDir, phase) {
  const s = await d.state();
  if (s.modal) { await d.clearModal(); return "modal"; }
  if (!s.coop) return "ended";
  const c = s.coop;
  const self = c.players[c.me];
  if (self.dead) return "dead";
  if (self.exited) return "exited";
  if (c.settling) return "settling";
  if (c.pendingOwn || !c.myTurn) return "waiting";
  const sess = s.session;
  if (!sess) return "waiting";

  if (sess.hp < sess.maxHp * 0.55 &&
      s.player.inventory.some((i) => i.slot === "bag" && i.item_id === "health_potion")) {
    await d.call("input", "use_potion");
    return "potion";
  }

  const adj = sess.monsters.find(
    (m) => Math.abs(m.x - self.x) <= 1 && Math.abs(m.y - self.y) <= 1);
  if (adj) { await d.call("input", "move", adj.x - self.x, adj.y - self.y); return "attack"; }

  if (sess.groundItems.some((g) => g.x === self.x && g.y === self.y)) {
    await d.call("input", "pickup");
    return "loot";
  }

  // Partners block movement, so treat their tiles as walls.
  const grid = walls.map((r) => r.slice());
  c.players.forEach((q, i) => {
    if (i !== c.me && !q.dead && !q.exited) grid[q.y][q.x] = true;
  });

  const nearest = (list) => list
    .map((t) => ({ t, d: Math.abs(t.x - self.x) + Math.abs(t.y - self.y) }))
    .sort((a, b) => a.d - b.d)[0]?.t;

  let target = null;
  if (phase === "clear") target = nearest(sess.monsters) ?? nearest(sess.groundItems);
  if (!target) {
    const gate = sess.gates.find((g) => g.direction === exitDir) ?? sess.gates[0];
    if (self.x === gate.x && self.y === gate.y) { await d.call("coopExit"); return "exit"; }
    target = gate;
  }

  const step = bfsStep(grid, self.x, self.y, target.x, target.y);
  if (!step || (!step[0] && !step[1])) { await d.call("input", "wait"); return "wait"; }
  await d.call("input", "move", step[0], step[1]);
  return "move";
}

const browser = await chromium.launch({ headless: !!process.env.ROG_HEADLESS });
const A = driver(await (await browser.newContext()).newPage(), NAME_A);
const B = driver(await (await browser.newContext()).newPage(), NAME_B);
for (const d of [A, B]) d.page.on("pageerror", (e) => die(`[${d.name}] page error: ${e.message}`));

try {
  log("connecting both players");
  await A.start();
  await B.start();

  log("finding somewhere to meet");
  const dir = await ensureConfirmedNeighbour(A);
  const target = { x: DIRS[dir][0], y: DIRS[dir][1] };

  log(`hosting a co-op run through the hub's ${dir} gate`);
  await A.until((s) => (s.coopTargets ?? []).some((t) => t.dir === dir), 25000,
                "the segment to appear in the lobby");
  await A.call("coopHost", dir);
  const hosted = await A.until((s) => !!s.player?.active_visit, 30000, "the run to open");
  const visitId = hosted.player.active_visit.visit_id;

  await B.until((s) => (s.joinable ?? []).some((j) => j.visit.id === visitId), 25000,
                "the run to reach the other player's lobby");
  await B.call("coopJoin", visitId, dir);

  await A.until((s) => !!s.coop, 40000, "the run to start for the host");
  await B.until((s) => !!s.coop, 40000, "the run to start for the joiner");
  const opened = await A.state();
  log(`run #${visitId} live in (${target.x}, ${target.y}) with ${opened.coop.names.join(" and ")}`);
  log(`${opened.session.monsters.length} monsters, ${opened.session.groundItems.length} items to clear\n`);

  const walls = (await A.map()).walls;
  const home = OPPOSITE[dir];
  const t0 = Date.now();
  let phase = "clear";
  let lastReport = 0;

  while (Date.now() - t0 < MAX_MS) {
    const [ra, rb] = await Promise.all([act(A, walls, home, phase), act(B, walls, home, phase)]);
    if (ra === "ended" && rb === "ended") break;

    const s = (await A.state()).coop ? await A.state() : await B.state();
    if (!s.coop) break;

    if (phase === "clear" && s.session &&
        s.session.monsters.length === 0 && s.session.groundItems.length === 0) {
      log("\nsegment cleared, heading for the gate");
      phase = "leave";
    }

    if (s.coop.turns - lastReport >= 20) {
      lastReport = s.coop.turns;
      const hp = s.coop.players.map((p, i) =>
        `${s.coop.names[i]} ${p.dead ? "dead" : p.exited ? "out" : p.hp}`).join(", ");
      log(`  turn ${String(s.coop.turns).padStart(4)}  ` +
          `monsters ${String(s.session?.monsters.length ?? 0).padStart(2)}  ` +
          `items ${String(s.session?.groundItems.length ?? 0).padStart(2)}  ${hp}`);
    }
    await sleep(ra === "waiting" && rb === "waiting" ? 120 : 45);
  }

  log("\nwaiting for the settlement");
  for (let i = 0; i < 120; i++) {
    const [sa, sb] = await Promise.all([A.state(), B.state()]);
    if (!sa.coop && !sb.coop && !sa.coopSolo && !sb.coopSolo) break;
    await sleep(1000);
  }
  for (const d of [A, B]) {
    const s = await d.state();
    const p = s.player;
    log(`  ${d.name}: level ${p.level}, ${p.xp} xp, ${p.gold} gold, ` +
        `${p.combat_record.kills} kills, ${p.combat_record.visits_completed} runs, ` +
        `at (${p.segment.x}, ${p.segment.y})`);
    if (s.coop || s.coopSolo) die(`${d.name} never finished the run`);
  }
  log("\ndone");
} catch (e) {
  die(e.message);
} finally {
  if (!process.env.ROG_KEEP) await browser.close();
}
