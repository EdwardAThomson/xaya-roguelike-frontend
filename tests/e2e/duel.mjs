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
/** Set once the fight loop is reached; drives one actor's duel move. */
let duelStep = null;
const fail = (m) => { findings.push(m); console.log("  ✗ " + m); };
const ok = (m) => console.log("  ✓ " + m);

/** Mines blocks on the devnet: the staleness window counts in blocks. */
async function mineBlocks(blocks) {
  await fetch(PROXY, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "mine", blocks }),
  });
}

async function gsp(method, params = []) {
  const r = await fetch(`${PROXY}/gsp`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const res = (await r.json()).result;
  return res && typeof res === "object" && "data" in res ? res.data : res;
}


/**
 * Ticks every item tile in the stake dialog, returning how many there are.
 * The dialog is one screen (gold, the item grid, and for a host the floor),
 * so this does not confirm; the caller does once the rest is filled in.
 * Returns 0 for a character whose bag is empty: the grid is not drawn.
 */
async function tickAllStakeItems(page) {
  const rows = await page.$$(".modal-stake-row input[type=checkbox]");
  // The checkbox is visually hidden behind its tile, so click the tile.
  for (const r of rows) {
    if (await r.isChecked()) continue;
    await (await r.evaluateHandle((e) => e.closest(".modal-stake-row"))).click();
  }
  return rows.length;
}

/**
 * Sets the host's floor when the dialog shows one.  It is hidden while the
 * stake is zero, since a friendly duel has nothing to protect.
 */
async function setFloor(page, value) {
  const box = await page.$(".modal-floor:not([hidden])");
  if (!box) return false;
  await page.fill(".modal-floor-input", String(value));
  return true;
}

/** Mirrors page console + errors into the run log, prefixed by actor. */
function wireDiagnostics(page, name) {
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" || /reject|refus|fail|cannot|invalid/i.test(t))
      console.log(`   [${name} console] ${t}`);
  });
  page.on("pageerror", (e) => console.log(`   [${name} pageerror] ${e.message}`));
}

/** Whatever dialog is on screen, for when a step times out silently. */
async function visibleModal(page) {
  return page.evaluate(() =>
    document.getElementById("modal-root")?.innerText?.replace(/\s+/g, " ")?.slice(0, 300) ?? null);
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
wireDiagnostics(A.page, NAME_A);
wireDiagnostics(B.page, NAME_B);
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
  // Hosting is one dialog: what you stake in gold, which bag items go in
  // with it, and the least a challenger may put up.  Stake everything, and
  // set a floor of 1 so the ASYMMETRIC path is what gets exercised rather
  // than matched stakes.  Ticking the items is what makes the floor
  // non-zero for a character with no gold.
  await A.page.waitForSelector(".modal-amount-input", { timeout: 10000 });
  const maxStake = await A.page.$eval(".modal-amount-input", (e) => Number(e.max));
  console.log(`   stake field offers up to ${maxStake} gold`);
  await A.page.fill(".modal-amount-input", String(maxStake));
  const stakedItems = await tickAllStakeItems(A.page);
  if (stakedItems > 0) console.log(`   host also staked ${stakedItems} bag row(s)`);
  const floor = maxStake > 0 || stakedItems > 0 ? 1 : 0;
  if (await setFloor(A.page, floor))
    console.log(`   host staked ${maxStake}, will accept ${floor} or more`);
  else if (floor > 0) fail("the floor field did not appear for a non-zero stake");
  await A.page.click(".modal-confirm");
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
  // The challenger names their own stake, which need not match the host's.
  await B.page.waitForSelector(".modal-amount-input", { timeout: 10000 });
  const myMin = await B.page.$eval(".modal-amount-input", (e) => Number(e.min));
  await B.page.fill(".modal-amount-input", String(myMin));
  // The item grid is on the same screen, and the floor is cleared by gold
  // and items TOGETHER, so a player with no gold can still take the duel.
  await tickAllStakeItems(B.page);
  if (await B.page.$eval(".modal-confirm", (e) => e.disabled))
    console.log(`   [${NAME_B} modal] ${await visibleModal(B.page)}`);
  await B.page.click(".modal-confirm");
  try {
    await B.until((x) => x.player?.active_visit?.visit_id === visitId, 35000, "to join");
  } catch (e) {
    // The join move never reached the chain. Say what the client is showing
    // and what it thinks its own state is, instead of only "timed out".
    console.log(`   [${NAME_B} modal] ${await visibleModal(B.page)}`);
    console.log(`   [${NAME_B} state] ${JSON.stringify(await B.state()).slice(0, 400)}`);
    throw e;
  }
  const joined = await gsp("getvisitinfo", [visitId]);
  if (maxStake > 0 && joined.pot === maxStake * 2)
    fail(`pot ${joined.pot} looks like matched stakes; the uneven join did not take`);
  else ok(`both in, status ${joined.status}, pot ${joined.pot ?? 0} ` +
          `(host ${maxStake} + challenger ${myMin})`);

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
  // One duel move for one actor: attack an adjacent foe, otherwise an
  // adjacent monster, otherwise step toward the foe. Hoisted so the stall
  // scenario below can drive a single side with the same logic.
  duelStep = async (d, wallsFor) => {
    const st = await d.state();
    if (st.modal) { await d.closeModal(); return; }
    if (!st.coop) return;
    const c = st.coop;
    const self = c.players[c.me];
    const foe = c.players[1 - c.me];
    if (self.dead || self.exited || c.settling || c.pendingOwn || !c.myTurn) return;
    const sess = st.session;
    if (!sess) return;
    if (Math.abs(self.x - foe.x) <= 1 && Math.abs(self.y - foe.y) <= 1)
      return d.call("input", "move", foe.x - self.x, foe.y - self.y);
    const mon = sess.monsters.find(
      (m) => Math.abs(m.x - self.x) <= 1 && Math.abs(m.y - self.y) <= 1);
    if (mon) return d.call("input", "move", mon.x - self.x, mon.y - self.y);
    const step = bfsStep(wallsFor, self.x, self.y, foe.x, foe.y);
    if (!step || (!step[0] && !step[1])) return d.call("input", "wait");
    return d.call("input", "move", step[0], step[1]);
  };
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
  // ---------------------------------------------------------------- stall
  // The other half of the checklist item: a duellist who stops responding.
  // Co-op answers this with "continue alone"; a duel does not, because an
  // absent duellist has ALREADY LOST -- the duel is over the moment at most
  // one participant is active, and the survivor banks it. That difference
  // is the whole reason this needs its own scenario rather than trusting
  // the co-op one.
  console.log("8. stall: a second duel where the challenger vanishes");
  for (const d of [A, B]) {
    const st = await d.state();
    if (st.modal) await d.closeModal();
  }

  // Put both back at the hub first. A duel leaves its two sides in
  // DIFFERENT places -- the winner stands in the arena (banked as having
  // survived without reaching a gate), the loser is knocked back to the
  // segment they came from -- so after one duel they are no longer both
  // next door to the arena, and neither can host or see a duel on it.
  for (const d of [A, B]) {
    const p0 = await gsp("getplayerinfo", [d.name]);
    if (p0.segment.x === 0 && p0.segment.y === 0) continue;
    console.log(`   walking ${d.name} back to the hub from (${p0.segment.x}, ${p0.segment.y})`);
    await d.call("travel", OPPOSITE[dir]);
    await d.until((x) => x.player?.segment?.x === 0 && x.player?.segment?.y === 0,
                  30000, `${d.name} to reach the hub`);
  }
  ok("both back at the hub");

  await A.standOnGate(dir);
  await A.pickChoice("wait here for a duel");
  await sleep(400);
  await A.page.waitForSelector(".modal-amount-input", { timeout: 10000 });
  await A.page.fill(".modal-amount-input", "0");
  await tickAllStakeItems(A.page);
  await setFloor(A.page, 0);
  await A.page.click(".modal-confirm");
  const hosted2 = await A.until((x) => !!x.player?.active_visit, 35000, "the second duel to open");
  const visit2 = hosted2.player.active_visit.visit_id;
  ok(`duel #${visit2} open`);

  await B.until((x) => (x.joinable ?? []).some((j) => j.visit.id === visit2), 25000,
                "the second duel to reach the challenger");
  await B.standOnGate(dir);
  await B.pickChoice("duel");
  await B.page.waitForSelector(".modal-amount-input", { timeout: 10000 });
  await B.page.fill(".modal-amount-input", "0");
  await tickAllStakeItems(B.page);
  await B.page.click(".modal-confirm");
  await B.until((x) => x.player?.active_visit?.visit_id === visit2, 35000, "to join the second duel");
  await Promise.all([
    A.until((x) => !!x.coop, 45000, "the second duel to start for the host"),
    B.until((x) => !!x.coop, 45000, "the second duel to start for the challenger"),
  ]);
  ok(`duel #${visit2} active, both runners up`);

  // A few rounds together, so the vanishing side leaves a checkpoint that
  // is beyond the start and therefore worth going stale.
  //
  // WAIT rather than walk. duelStep paths toward the opponent, and in a
  // duel stepping on a gate is a CONCESSION, not a move: the first version
  // of this scenario had the driver walk the host onto a gate, which
  // conceded the duel and settled it normally with the "vanished" side
  // winning. It looked like an abandonment result and was nothing of the
  // kind.
  const tS = Date.now();
  let roundsTogether = 0;
  while (Date.now() - tS < 25000 && roundsTogether < 4) {
    for (const d of [A, B]) {
      const st = await d.state();
      if (st.modal) { await d.closeModal(); continue; }
      if (st.coop?.myTurn && !st.coop.pendingOwn) await d.call("input", "wait");
    }
    const sa = await A.state();
    if (!sa.coop || sa.coop.gameOver) break;
    roundsTogether = sa.coop.turns ?? roundsTogether + 1;
    await sleep(150);
  }
  // Both sides must have a checkpoint on file, or nobody can settle
  // unilaterally at all: the GSP refuses a settle with no confirm from the
  // other side, which is the 1000-block freeze rather than an abandonment.
  for (const d of [A, B]) await d.call("coopCheckpoint").catch(() => {});
  await sleep(1500);
  const before = await A.state();
  console.log(`   challenger leaves at round ${before.coop?.round ?? "?"}; ` +
              `confirms: ${JSON.stringify(before.coopVisit?.confirms ?? {})}`);
  await B.page.context().close();

  // Mine the staleness window, then abandon deliberately -- the same
  // control a real player is offered once the other side has gone quiet.
  await mineBlocks(25);
  const stalled = await A.until(
    (x) => !x.player?.active_visit || x.coop?.gameOver || !!x.partnerCheckpoint?.stale,
    90000, "the vanished challenger's checkpoint to go stale");
  console.log(`   host sees: gameOver=${stalled.coop?.gameOver} ` +
              `stale=${JSON.stringify(stalled.partnerCheckpoint ?? null)}`);
  if (stalled.partnerCheckpoint?.stale) {
    await A.call("coopAbandon");
    ok(`host abandons from the challenger's last checkpoint ` +
       `(${stalled.partnerCheckpoint.n} actions)`);
  } else if (!stalled.coop?.gameOver) {
    fail("the challenger never went stale, so the host had no way to settle: " +
         "this is the freeze, not an abandonment");
  }

  let v2 = null;
  for (let i = 0; i < 150; i++) {
    v2 = await gsp("getvisitinfo", [visit2]);
    if (v2 && v2.status !== "active") break;
    // Nudge the chain along: the window and the void both count in blocks.
    if (i % 10 === 9) await mineBlocks(5);
    await sleep(1000);
  }
  if (!v2 || v2.status === "active")
    fail(`the stalled duel never resolved (status ${v2?.status})`);
  else {
    ok(`stalled duel #${visit2} resolved as ${v2.status}`);
    for (const r of v2.results ?? [])
      console.log(`   ${r.name}: survived=${r.survived} xp=${r.xp_gained}`);
    // The spec is explicit: an absent duellist has ALREADY LOST. A result
    // where the side that closed its browser wins is the bug this scenario
    // exists to catch.
    if (v2.status === "completed") {
      const host = (v2.results ?? []).find((r) => r.name === A.name);
      const gone = (v2.results ?? []).find((r) => r.name === B.name);
      if (gone?.survived && !host?.survived)
        fail(`${B.name} vanished and still won: an absent duellist must lose`);
      else if (host?.survived)
        ok(`${A.name} took the duel the challenger walked out of`);
    }
  }
  const pa = await gsp("getplayerinfo", [A.name]);
  if (pa.active_visit) fail(`${A.name} is still stuck in a visit after the stall`);
  else ok(`${A.name} is free again, at (${pa.segment.x}, ${pa.segment.y})`);

} catch (e) {
  fail(`exception: ${e.message}`);
} finally {
  if (!process.env.ROG_KEEP) await browser.close();
}

console.log(findings.length ? `\nFAIL (${findings.length})` : "\nPASS");
for (const f of findings) console.log(" - " + f);
process.exit(findings.length ? 1 : 0);
