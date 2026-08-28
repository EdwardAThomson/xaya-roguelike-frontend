/**
 * Headless end-to-end driver for the roguelike frontend.
 *
 * Drives the REAL frontend in headless Chromium against a running devnet
 * stack, using the ?e2e=1 debug hook (window.__rog) so we exercise the
 * same orchestration the UI does and can assert on game state, instead of
 * hand-clicking through the browser.
 *
 * Prerequisites (in two other terminals):
 *   1. source ~/Explore/xayax/.venv/bin/activate && python3 devnet/frontend_devnet.py
 *   2. (in the frontend repo) python3 serve.py
 *
 * Run:  node tests/e2e/run.mjs
 * Env:  ROG_URL (default http://localhost:8000), ROG_HEADED=1 to watch.
 */
import { chromium } from "playwright";
import { isHub, segStr } from "./agentcore.mjs";

const BASE = process.env.ROG_URL || "http://localhost:8000";
const URL = `${BASE}/?e2e=1`;
const NAME = "e2e" + Date.now().toString(36).slice(-6);

const browser = await chromium.launch({ headless: !process.env.ROG_HEADED });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[page error]", e.message));

const state = () => page.evaluate(() => globalThis.__rog.state());
const call = (fn, ...args) =>
  page.evaluate(([f, a]) => globalThis.__rog[f](...a), [fn, args]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, label, ms = 20000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await state();
    if (pred(last)) return last;
    await sleep(300);
  }
  throw new Error(`timeout waiting for: ${label}\n  last state: ${JSON.stringify(last)}`);
}

/** Dismiss/confirm any modal that's up (confirm modals advance the flow). */
async function clearModal() {
  const btn = await page.$(".modal-confirm, .modal-dismiss");
  if (btn) { await btn.click(); return true; }
  return false;
}

function summary(s) {
  return {
    seg: segStr(s.player?.segment),
    inChannel: s.player?.in_channel,
    hp: s.player?.hp,
    mode: s.mode,
    channelSession: s.channelSession,
    survived: s.session?.survived,
    modal: s.modal ? s.modal.slice(0, 160) : null,
  };
}

const fail = [];
function check(desc, cond, s) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${desc}`, s ? JSON.stringify(summary(s)) : "");
  if (!cond) fail.push(desc);
}

try {
  await page.goto(URL);
  await page.waitForFunction(() => !!globalThis.__rog, null, { timeout: 15000 });
  console.log(`player name: ${NAME}`);

  // Connect + register.
  await call("connect", NAME);
  let s = await waitFor((s) => s.status === "connected", "connected");
  if (!s.player) {
    await call("register");
    s = await waitFor((s) => !!s.player, "registered");
  }
  check("registered at hub (0, 0)", isHub(s.player?.segment), s);

  // Go north: gate-walk from the hub into unexplored -> discover + enter (0,1).
  await call("gateWalk", "north");
  await sleep(800);
  await clearModal();
  s = await waitFor(
    (s) => s.player?.in_channel || !isHub(s.player?.segment) || s.modal,
    "north transit",
  );
  console.log("after gw north:", JSON.stringify(summary(s)));
  check("entered a non-hub segment going north", !isHub(s.player?.segment), s);

  // Path 1 (what a "go south" UI trigger does): gate-walk south without
  // standing on the gate.  Reproduces the silent failure.
  await sleep(500);
  await call("gateWalk", "south");
  await sleep(2500);
  await clearModal();
  await sleep(1500);
  s = await state();
  console.log("after direct gw south:", JSON.stringify(summary(s)));
  check("[path1] direct gate-walk south retreats to hub", isHub(s.player?.segment), s);

  // Path 2 (intended): walk onto the south entry gate, confirm, leave.
  if (!isHub(s.player?.segment)) {
    await page.$eval("#game-canvas", (el) => el.click()); // focus game, not inputs
    await sleep(200);
    await page.keyboard.press("s"); // step south onto the entry gate
    await sleep(900);
    s = await state();
    console.log("after step onto gate:", JSON.stringify(summary(s)),
      "tile=", s.session?.tileAtPlayer);
    await clearModal(); // confirm the gate-walk modal
    s = await waitFor(
      (s) => isHub(s.player?.segment)
        || /reject|fail|mismatch/i.test(s.modal || ""),
      "retreat result", 25000,
    );
    console.log("after walk-onto-gate retreat:", JSON.stringify(summary(s)));
    check("[path2] walk-onto-gate retreats to hub", isHub(s.player?.segment), s);
  }
} catch (e) {
  console.log("ERROR:", e.message);
  fail.push(e.message);
} finally {
  await browser.close();
}

console.log(fail.length ? `\n${fail.length} FAILED` : "\nALL PASSED");
process.exit(fail.length ? 1 : 0);
