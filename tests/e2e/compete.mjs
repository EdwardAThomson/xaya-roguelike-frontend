/**
 * Targeted multiplayer competition tests with hard assertions. Unlike
 * multi.mjs (passive soak + referee), this scripts specific contested
 * scenarios and verifies the GSP resolves them correctly:
 *
 *   1. Coordinate race — two players aim at the same empty coord at once;
 *      exactly one segment is created and exactly one player wins it.
 *   2. Provisional access + unlock — A discovers a segment; B is rejected
 *      while it's provisional; A confirms it; B can then enter.
 *   3. Reward isolation — two players confirm their own segments
 *      concurrently; each owns only its own segment, stats stay independent.
 *
 * Prerequisites (rate limit off — it's off locally by default):
 *   1. source ~/Explore/xayax/.venv/bin/activate && python3 devnet/frontend_devnet.py
 *   2. python3 serve.py 8000
 * Run:  npm run compete
 */
import { chromium } from "playwright";
import { navigateOut, sleep } from "./agentcore.mjs";

const URL = `${process.env.ROG_URL || "http://localhost:8000"}/?e2e=1`;
const PROXY = process.env.ROG_PROXY || "http://localhost:18380";
const STAMP = Date.now().toString(36).slice(-5);
const findings = [];
const pass = (d) => console.log("  PASS:", d);
const fail = (d) => { console.log("  FAIL:", d); findings.push(d); };

const browser = await chromium.launch({ headless: !process.env.ROG_HEADED });

async function gsp(method, params = []) {
  const r = await fetch(`${PROXY}/gsp`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await r.json()).result;
}
async function segmentsAt(x, y) {
  const st = await gsp("getcurrentstate");
  return (st?.gamestate?.segments || []).filter(s => s.world_x === x && s.world_y === y);
}
const st = (page) => page.evaluate(() => globalThis.__rog.state());
const act = (page, fn, ...a) =>
  page.evaluate(([f, args]) => globalThis.__rog[f](...args), [fn, a]);

async function newPlayer(name) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => findings.push(`[${name}] pageerror: ${e.message}`));
  await page.goto(URL);
  await page.waitForFunction(() => !!globalThis.__rog, null, { timeout: 20000 });
  await act(page, "connect", name);
  for (let i = 0; i < 30 && (await st(page)).status !== "connected"; i++) await sleep(400);
  if (!(await st(page)).player) {
    await act(page, "register");
    for (let i = 0; i < 20 && !(await st(page)).player; i++) await sleep(400);
  }
  page._name = name;
  return page;
}

try {
  // --- Scenario 1: coordinate race (both go east → coord (1,0)) ---
  console.log("Scenario 1: coordinate race");
  {
    const A = await newPlayer(`r${STAMP}A`);
    const B = await newPlayer(`r${STAMP}B`);
    await Promise.allSettled([act(A, "gateWalk", "east"), act(B, "gateWalk", "east")]);
    await sleep(2500);
    const segs = await segmentsAt(1, 0);
    segs.length === 1
      ? pass("exactly one segment created at (1,0)")
      : fail(`${segs.length} segments at (1,0) — double claim!`);
    const sa = await st(A), sb = await st(B);
    const winners =
      (sa.player?.in_channel && sa.player.current_segment === segs[0]?.id ? 1 : 0) +
      (sb.player?.in_channel && sb.player.current_segment === segs[0]?.id ? 1 : 0);
    winners === 1
      ? pass("exactly one player won and entered the segment")
      : fail(`${winners} players ended up owning (1,0)`);
    await A.context().close(); await B.context().close();
  }

  // --- Scenario 2: provisional access control + unlock (north → (0,1)) ---
  console.log("Scenario 2: provisional access + confirm-unlocks");
  {
    const A = await newPlayer(`p${STAMP}A`);
    const B = await newPlayer(`p${STAMP}B`);
    await act(A, "gateWalk", "north"); await sleep(1500);
    (await st(A)).player?.in_channel
      ? pass("A discovered and entered its provisional segment")
      : fail("A did not enter its new segment");

    await act(B, "gateWalk", "north"); await sleep(2500);
    const sb1 = await st(B);
    (!sb1.player?.in_channel && sb1.player?.current_segment === 0)
      ? pass("B is rejected from A's provisional segment")
      : fail(`B entered another player's provisional segment (in_channel=${sb1.player?.in_channel})`);
    await act(B, "dismissModal");

    await navigateOut(A, { name: A._name, findings }, "south"); // confirm by exiting a gate
    await sleep(1500);
    const segs = await segmentsAt(0, 1);
    segs[0]?.confirmed
      ? pass("A confirmed the segment by completing a run")
      : fail("segment still provisional after A's run");

    await act(B, "gateWalk", "north"); await sleep(2500);
    const sb2 = await st(B);
    (sb2.player?.in_channel && sb2.player.current_segment === segs[0]?.id)
      ? pass("B can enter once it's confirmed")
      : fail(`B still cannot enter the now-confirmed segment (in_channel=${sb2.player?.in_channel})`);
    await A.context().close(); await B.context().close();
  }

  // --- Scenario 3: reward / ownership isolation (A west, B south, concurrent) ---
  console.log("Scenario 3: concurrent runs stay isolated");
  {
    const A = await newPlayer(`i${STAMP}A`);
    const B = await newPlayer(`i${STAMP}B`);
    const before = { A: (await st(A)).player, B: (await st(B)).player };
    // Each discovers its own direction, then confirms by exiting a gate.
    await Promise.allSettled([act(A, "gateWalk", "west"), act(B, "gateWalk", "south")]);
    await sleep(1500);
    await Promise.allSettled([
      navigateOut(A, { name: A._name, findings }, "east"),   // exit back east → hub
      navigateOut(B, { name: B._name, findings }, "north"),  // exit back north → hub
    ]);
    await sleep(1500);
    const wSeg = (await segmentsAt(-1, 0))[0];
    const sSeg = (await segmentsAt(0, -1))[0];
    (wSeg && sSeg && wSeg.id !== sSeg.id)
      ? pass("two distinct segments, one per player")
      : fail("players did not each get a distinct segment");
    (wSeg?.discoverer === A._name && sSeg?.discoverer === B._name)
      ? pass("each segment is owned by its own discoverer (no cross-credit)")
      : fail(`ownership crossed: west=${wSeg?.discoverer} south=${sSeg?.discoverer}`);
    const after = { A: (await st(A)).player, B: (await st(B)).player };
    const ok = (p0, p1) => p1 && p1.xp >= (p0?.xp ?? 0) && p1.gold >= 0
      && p1.hp >= 0 && p1.hp <= p1.max_hp;
    (ok(before.A, after.A) && ok(before.B, after.B))
      ? pass("both players' stats advanced independently and stayed in range")
      : fail("a player's stats went inconsistent");
    await A.context().close(); await B.context().close();
  }
} catch (e) {
  fail("ERROR: " + e.message);
} finally {
  await browser.close();
}

if (findings.length) {
  console.log(`\n${findings.length} FAILURE(S):`);
  for (const f of findings) console.log("  - " + f);
  process.exit(1);
}
console.log("\nAll competition scenarios passed.");
