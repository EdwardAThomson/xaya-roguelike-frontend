/**
 * Single self-playing agent (soak/monkey tester) — drives one player in
 * the real browser game and reports anomalies. See agentcore.mjs for the
 * policy. For several competing players at once, use multi.mjs.
 *
 * Prerequisites:
 *   1. source ~/Explore/xayax/.venv/bin/activate && python3 devnet/frontend_devnet.py
 *   2. python3 serve.py 8000        (in this repo)
 * Run:  npm run agent
 * Env:  ROG_URL (default http://localhost:8000), ROG_HEADED=1 to watch,
 *       ROG_OUTBOUND (default 4), ROG_TICKS (default 600).
 */
import { chromium } from "playwright";
import { playAgent } from "./agentcore.mjs";

const URL = `${process.env.ROG_URL || "http://localhost:8000"}/?e2e=1`;
const NAME = "bot" + Date.now().toString(36).slice(-6);
const findings = [];

const browser = await chromium.launch({ headless: !process.env.ROG_HEADED });
const page = await browser.newPage();
page.on("pageerror", (e) => findings.push(`[${NAME}] pageerror: ${e.message}`));

let summary;
try {
  await page.goto(URL);
  await page.waitForFunction(() => !!globalThis.__rog, null, { timeout: 15000 });
  console.log("agent:", NAME);
  summary = await playAgent(page, {
    name: NAME, findings,
    outbound: Number(process.env.ROG_OUTBOUND || 4),
    maxTicks: Number(process.env.ROG_TICKS || 600),
  });
} catch (e) {
  findings.push(`[${NAME}] ERROR: ${e.message}`);
} finally {
  console.log("final:", JSON.stringify(summary || {}));
  await browser.close();
}

if (findings.length) {
  console.log(`\n${findings.length} FINDING(S):`);
  for (const f of findings) console.log("  - " + f);
  process.exit(1);
}
console.log("\nNo anomalies. Agent played clean.");
