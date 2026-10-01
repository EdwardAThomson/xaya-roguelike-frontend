/**
 * Two bots fight a staked duel, start to finish, in one command.
 *
 * This is the live staked duel the checklist has been asking for
 * (docs/PVP_item_staking_checklist.md item 17, and PVP_4a_checklist.md item
 * 19): until item stakes existed, every duel that ran against a real chain
 * ran at stake 0, because a fresh character has no gold. Two bots with the
 * kit they registered with can now put up real property, fight for it, and
 * have it change hands, which exercises escrow, the floor, the transfer and
 * the settlement in one pass.
 *
 * Prerequisites: a devnet running (`python3 devnet/frontend_devnet.py`).
 * Run:  npm run duel:bots
 * Env:  ROG_BOTS_STAKE=0  fight for nothing instead of staking the bags
 *       ROG_BOTS_TIMEOUT  seconds to allow (default 300)
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  sleep, gsp, register, installStorageShim, ensureArena, clearOpenDuels,
} from "./duelcore.mjs";

installStorageShim();
const { DungeonSession } = await import("../../dist/game/session.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAMP = Date.now().toString(36).slice(-4);
const HOST = `bh${STAMP}`;
const JOIN = `bj${STAMP}`;
const STAKE = process.env.ROG_BOTS_STAKE !== "0";
const TIMEOUT = Number(process.env.ROG_BOTS_TIMEOUT || 300) * 1000;

const findings = [];
const fail = (m) => { findings.push(m); console.log("  ✗ " + m); };
const ok = (m) => console.log("  ✓ " + m);

/** Runs one bot, echoing its lines with a prefix so both are readable. */
function runBot(name, env, tag) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, "duel_bot.mjs")], {
      env: { ...process.env, ROG_BOT: name,
             ROG_BOT_STAKE_ITEMS: STAKE ? "1" : "0", ...env },
    });
    const echo = (buf) => String(buf).split("\n").filter(Boolean)
      .forEach(l => console.log(`  ${tag} ${l.replace(/^\[bot\] /, "")}`));
    p.stdout.on("data", echo);
    p.stderr.on("data", echo);
    p.on("close", (code) => resolve(code));
  });
}

console.log("setup: two bots and a confirmed arena");
await register(HOST);
await register(JOIN);
await ensureArena(HOST, DungeonSession);
ok(`arena (1, 0) confirmed; ${HOST} and ${JOIN} registered`);
const cleared = await clearOpenDuels();
if (cleared > 0) ok(`retired ${cleared} stale open visit(s)`);

const before = {};
for (const n of [HOST, JOIN]) {
  const p = await gsp("getplayerinfo", [n]);
  before[n] = p.inventory.filter(i => i.slot === "bag")
    .reduce((t, i) => t + i.quantity, 0);
}
console.log(`the duel${STAKE ? " (both bots stake their bags)" : ""}`);

const hostRun = runBot(HOST, { ROG_BOT_OPEN: "1", ROG_BOT_WAIT: "120" }, "H|");
await sleep(10000);   // let the host's duel reach the chain before joining
const joinRun = runBot(JOIN, { ROG_HOST: HOST, ROG_BOT_WAIT: "90" }, "J|");

const timer = sleep(TIMEOUT).then(() => "timeout");
const done = await Promise.race([Promise.all([hostRun, joinRun]), timer]);
if (done === "timeout") fail("the duel did not finish in time");

console.log("the outcome");
const visits = (await gsp("listvisits", ["completed"])) || [];
const duel = visits.filter(v => v.mode === "duel").pop();
if (!duel) fail("no completed duel on chain");
else ok(`duel ${duel.id} settled`);

const after = {};
for (const n of [HOST, JOIN]) {
  const p = await gsp("getplayerinfo", [n]);
  after[n] = {
    bag: p.inventory.filter(i => i.slot === "bag")
      .reduce((t, i) => t + i.quantity, 0),
    xp: p.xp, seg: `(${p.segment.x}, ${p.segment.y})`, hp: p.hp,
  };
  console.log(`   ${n}: ${after[n].bag} bag item(s), ${after[n].xp} xp, ` +
              `${after[n].hp} hp, at ${after[n].seg}`);
}

if (STAKE) {
  // Winner takes the loser's staked rows: one bag grew by what the other
  // lost. Anything else means the transfer did not happen.
  const grew = [HOST, JOIN].filter(n => after[n].bag > before[n]);
  const lost = [HOST, JOIN].filter(n => after[n].bag < before[n]);
  if (grew.length === 1 && lost.length === 1) {
    ok(`${grew[0]} took ${lost[0]}'s staked items ` +
       `(${before[lost[0]]} -> ${after[lost[0]].bag})`);
  } else {
    fail(`staked items did not change hands: ` +
         [HOST, JOIN].map(n => `${n} ${before[n]}->${after[n].bag}`).join(", "));
  }
}

console.log();
if (findings.length === 0) console.log("PASS");
else { console.log("FAIL"); findings.forEach(f => console.log("  - " + f)); }
process.exit(findings.length === 0 ? 0 : 1);
