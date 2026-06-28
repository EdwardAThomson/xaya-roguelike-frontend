/**
 * Heuristic self-playing agent for the roguelike frontend (a soak/monkey
 * tester). Drives the REAL browser game via the ?e2e=1 debug hook: it
 * explores segment to segment, fights monsters, picks up loot, equips
 * better gear, and exercises both directions of travel — going deeper into
 * NEW segments (discovery, confirm-by-reaching-a-gate) and coming back
 * through OLD confirmed segments (free transit). It checks invariants every
 * tick and reports anything anomalous (rejections, stuck states, errors).
 *
 * Prerequisites (run a FRESH stack for isolation):
 *   1. source ~/Explore/xayax/.venv/bin/activate && python3 devnet/frontend_devnet.py
 *   2. python3 serve.py 8000        (in this repo)
 * Run:  npm run agent
 * Env:  ROG_URL (default http://localhost:8000), ROG_HEADED=1 to watch,
 *       ROG_OUTBOUND (default 4) how many segments deep to push.
 */
import { chromium } from "playwright";

const BASE = process.env.ROG_URL || "http://localhost:8000";
const URL = `${BASE}/?e2e=1`;
const NAME = "bot" + Date.now().toString(36).slice(-6);
const OUTBOUND = Number(process.env.ROG_OUTBOUND || 4);
const MAX_TICKS = Number(process.env.ROG_TICKS || 600);
const OPP = { north: "south", south: "north", east: "west", west: "east" };

const browser = await chromium.launch({ headless: !process.env.ROG_HEADED });
const page = await browser.newPage();
const findings = [];
page.on("pageerror", (e) => findings.push("pageerror: " + e.message));

const state = () => page.evaluate(() => globalThis.__rog.state());
const getMap = () => page.evaluate(() => globalThis.__rog.map());
const call = (fn, ...a) =>
  page.evaluate(([f, args]) => globalThis.__rog[f](...args), [fn, a]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitIdle(ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await state();
    if (!s.busy) return s;
    await sleep(150);
  }
  return state();
}

/** BFS first step from (fx,fy) toward (tx,ty) over non-wall tiles. */
function bfsStep(walls, fx, fy, tx, ty) {
  const H = walls.length, W = walls[0].length;
  const key = (x, y) => y * W + x;
  const q = [[fx, fy]];
  const parent = new Map([[key(fx, fy), -1]]);
  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
  while (q.length) {
    const [cx, cy] = q.shift();
    if (cx === tx && cy === ty) {
      let cur = key(tx, ty);
      while (parent.get(cur) !== key(fx, fy) && parent.get(cur) !== -1) cur = parent.get(cur);
      if (parent.get(cur) === -1) return [0, 0];
      return [(cur % W) - fx, Math.floor(cur / W) - fy];
    }
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      if (walls[ny][nx]) continue;
      const k = key(nx, ny);
      if (parent.has(k)) continue;
      parent.set(k, key(cx, cy));
      q.push([nx, ny]);
    }
  }
  return null;
}

async function handleModal(s) {
  if (!s.modal) return false;
  const confirm = await page.$(".modal-confirm");
  if (confirm) { await confirm.click(); await sleep(300); return true; }
  // An error/info modal: record genuine anomalies; ignore expected game
  // feedback (cooldowns, completion, respawn, coord-claim races).
  if (!/dungeon complete|respawn|welcome|cooldown|already claimed/i.test(s.modal))
    findings.push("modal: " + s.modal.slice(0, 120).replace(/\s+/g, " ").trim());
  await call("dismissModal");
  await sleep(300);
  return true;
}

/** Equip a clearly-better weapon/armor from the bag (hub/overworld only). */
async function manageInventory(s) {
  const p = s.player;
  if (!p) return;
  // Heal if hurt and we have a potion.
  const potions = p.inventory.filter(i => i.slot === "bag"
    && (i.item_id === "health_potion" || i.item_id === "greater_health_potion"));
  if (p.hp < p.max_hp * 0.5 && potions.length) {
    await call("useItem", potions[0].item_id); await waitIdle(); return;
  }
  // Spend any stat points (strength, keeps the bot punchier).
  if (p.stat_points > 0) { await call("allocateStat", "strength"); await waitIdle(); return; }
  // Equip the first weapon/armor sitting in the bag (the GSP recomputes
  // effective stats; this exercises eq + the effective-stat path).
  const gear = p.inventory.find(i => i.slot === "bag"
    && /sword|axe|mace|staff|armor|mail|plate|helmet|cap|boots|shield|ring|amulet|necklace/.test(i.item_id));
  if (gear) {
    // Infer slot from id (weapon-ish vs the rest map to known slots).
    let slot = "weapon";
    if (/cap|helmet/.test(gear.item_id)) slot = "head";
    else if (/armor|mail|plate|leather$/.test(gear.item_id)) slot = "body";
    else if (/boots/.test(gear.item_id)) slot = "feet";
    else if (/shield/.test(gear.item_id)) slot = "offhand";
    else if (/ring/.test(gear.item_id)) slot = "ring";
    else if (/amulet|necklace/.test(gear.item_id)) slot = "amulet";
    await call("equip", gear.rowid, slot); await waitIdle(); return;
  }
}

const fail = (m) => findings.push(m);
let mapCache = { visitId: null, walls: null };

try {
  await page.goto(URL);
  await page.waitForFunction(() => !!globalThis.__rog, null, { timeout: 15000 });
  console.log("agent:", NAME);

  await call("connect", NAME);
  let s = await waitIdle(15000);
  for (let i = 0; i < 20 && (await state()).status !== "connected"; i++) await sleep(400);
  s = await state();
  if (s.status !== "connected") throw new Error("did not connect: " + JSON.stringify(s));
  if (!s.player) { await call("register"); await waitIdle(); }

  let discoveries = 0;          // count of NEW segments opened this run
  let lastSig = "";
  let stuck = 0;
  const OFFSET = { north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0] };

  for (let tick = 0; tick < MAX_TICKS; tick++) {
    s = await state();

    // Stuck detection: only meaningful inside a dungeon, where not making
    // progress means a real navigation/flow problem.  Out of channel the
    // agent may legitimately wait out the discovery cooldown.
    const sig = `${s.player?.current_segment}:${s.session?.playerX}:${s.session?.playerY}:${s.player?.hp}`;
    if (s.player?.in_channel && sig === lastSig && !s.modal && !s.busy) {
      if (++stuck > 25) { fail(`stuck ${stuck} ticks in dungeon at ${sig}`); break; }
    } else stuck = 0;
    lastSig = sig;

    if (s.modal) { await handleModal(s); continue; }
    if (s.busy) { await sleep(200); continue; }
    if (s.status !== "connected") { fail("disconnected: " + s.status); break; }

    const p = s.player;

    // --- Out of channel (hub or overworld node): manage gear, then go. ---
    if (!s.player.in_channel) {
      await manageInventory(s);
      s = await state();
      const pl = s.player;

      // Map the current node's neighbours from the world graph.
      const curX = pl.current_segment === 0 ? 0
        : (s.segments.find(x => x.id === pl.current_segment)?.world_x ?? 0);
      const curY = pl.current_segment === 0 ? 0
        : (s.segments.find(x => x.id === pl.current_segment)?.world_y ?? 0);
      // Classify each direction: confirmed neighbour (free transit),
      // empty (discoverable), or occupied-but-provisional (avoid — it's
      // someone else's claim, or our own un-confirmed one).
      const confirmedNbr = {};
      const occupied = new Set();
      for (const [dir, [dx, dy]] of Object.entries(OFFSET)) {
        const seg = s.segments.find(x => x.world_x === curX + dx && x.world_y === curY + dy);
        if (seg) { occupied.add(dir); if (seg.confirmed) confirmedNbr[dir] = seg.id; }
      }
      const confirmedDirs = Object.keys(confirmedNbr);
      const emptyDirs = Object.keys(OFFSET).filter(d => !occupied.has(d));
      const cd = Math.max(0, (pl.last_discover_height + 50) - (s.height ?? 0));

      // Discover a NEW segment when the cooldown allows (tests discovery +
      // confirm-on-return); otherwise transit to a CONFIRMED neighbour
      // (tests free transit through old segments and coming back).
      let dir = null;
      let discovering = false;
      if (discoveries < OUTBOUND && cd === 0 && emptyDirs.length) {
        dir = emptyDirs[0]; discovering = true;
      } else if (confirmedDirs.length) {
        dir = confirmedDirs[tick % confirmedDirs.length];
      } else if (emptyDirs.length && cd > 0) {
        await sleep(1500); continue;            // wait out the cooldown
      } else { await sleep(500); continue; }

      await call("gateWalk", dir);
      const after = await waitIdle(15000);
      if (after.player.in_channel && discovering) discoveries++;
      continue;
    }

    // --- In a dungeon channel: play, then leave via a chosen gate. ---
    const sess = s.session;
    if (!sess) { await sleep(200); continue; }

    if (sess.gameOver) {
      // Died: settle the death so we respawn at the hub (tests death path).
      await call("exitChannel"); await waitIdle(15000); continue;
    }

    // Heal when low.
    if (p.hp < p.max_hp * 0.35
        && p.inventory.some(i => i.slot === "bag" && i.item_id.includes("potion"))) {
      await call("input", "use_potion"); await sleep(150); continue;
    }
    // Pick up loot underfoot.
    if (sess.groundItems.some(g => g.x === sess.playerX && g.y === sess.playerY)) {
      await call("input", "pickup"); await sleep(150); continue;
    }

    // Refresh the wall map per visit.
    const vid = p.active_visit?.visit_id ?? null;
    if (mapCache.visitId !== vid) mapCache = { visitId: vid, walls: (await getMap())?.walls };
    const walls = mapCache.walls;
    if (!walls) { await sleep(200); continue; }

    // Choose a target: nearest adjacent monster to fight, else head to the
    // chosen exit gate (return -> entry gate; outbound -> a different gate).
    // Fight an adjacent monster; otherwise head for the entry gate to come
    // back out (a real run to the gate confirms a new/provisional segment;
    // a free transit leaves an old/confirmed one — both directions tested).
    const entryDir = p.active_visit?.entry_direction || "";
    let target = null;
    const adj = sess.monsters.find(m =>
      Math.abs(m.x - sess.playerX) <= 1 && Math.abs(m.y - sess.playerY) <= 1);
    if (adj) target = { x: adj.x, y: adj.y };
    else {
      const gate = sess.gates.find(g => g.direction === entryDir) || sess.gates[0];
      target = { x: gate.x, y: gate.y };
    }

    const step = bfsStep(walls, sess.playerX, sess.playerY, target.x, target.y);
    if (!step || (step[0] === 0 && step[1] === 0)) {
      // No path to the target gate (blocked): try any other reachable gate.
      let moved = false;
      for (const g of sess.gates) {
        const st = bfsStep(walls, sess.playerX, sess.playerY, g.x, g.y);
        if (st && (st[0] || st[1])) { await call("input", "move", st[0], st[1]); moved = true; break; }
      }
      if (!moved) { await call("input", "wait"); }
      await sleep(120); continue;
    }
    await call("input", "move", step[0], step[1]);
    await sleep(120);
  }
} catch (e) {
  fail("ERROR: " + e.message);
} finally {
  const s = await state().catch(() => ({}));
  console.log("final:", JSON.stringify({
    seg: s.player?.current_segment, inChannel: s.player?.in_channel,
    hp: s.player?.hp, level: s.player?.level, deaths: s.player?.combat_record?.deaths,
  }));
  await browser.close();
}

if (findings.length) {
  console.log(`\n${findings.length} FINDING(S):`);
  for (const f of findings) console.log("  - " + f);
  process.exit(1);
} else {
  console.log("\nNo anomalies. Agent played clean.");
}
