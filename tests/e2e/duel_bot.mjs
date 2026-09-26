/**
 * A headless duel opponent, so one person can test a duel.
 *
 * Nothing else plays ONE side of a duel: `npm run duel` drives two browsers
 * as bots, `playAgent` only knows solo dungeons, and `duel_adversarial.mjs`
 * plays both sides in-process. A human who hosts a duel therefore has
 * nobody to fight, and a duellist who joins without a client running
 * freezes their opponent until the 1000-block void timeout. This bot is the
 * missing half.
 *
 * It drives the REAL CoopRunner over the REAL relay rather than
 * reimplementing the round protocol. That matters: commit, reveal and apply
 * have to be byte-identical with the browser or the settlement replay
 * rejects the run, and the way to guarantee that is to run the same code.
 * All it adds is a hand on the keyboard and the checkpoint confirms the
 * browser sends from main.ts (without them the human cannot settle at all).
 *
 * Prerequisites: a devnet running (`python3 devnet/frontend_devnet.py`) and
 * a confirmed arena to fight in.
 * Run:  npm run duel:bot
 * Env:  ROG_BOT      bot's character name (default duelbot<stamp>)
 *       ROG_HOST     only join duels opened by this player (default: any)
 *       ROG_BOT_STAKE_ITEMS=0  do not stake the bot's bag (default: stake it,
 *                    so the human sees items in the pot and gets the
 *                    "they have put up ..." line and the bag-space warning)
 *       ROG_BOT_WAIT seconds to wait for a duel to appear (default 300)
 *       ROG_BOT_CONCEDE=1  walk out and concede instead of fighting, to
 *                    exercise the concession path
 *       ROG_BOT_OPEN=1  HOST a duel and wait to be joined, instead of
 *                    looking for one to join. Mostly so two bots can play
 *                    each other, which is how this bot is tested: a bot
 *                    whose only opponent is another script deadlocks in
 *                    exactly the way it exists to prevent.
 *       ROG_BOT_DIR  gate to host through / join by (default east)
 */
import {
  PROXY, sleep, gsp, move, mine, register, installStorageShim, installClaim,
  setupFromPlayer, constraintsFor, canonicalNames, visitUntil, tokens,
} from "./duelcore.mjs";

installStorageShim();

const { DungeonSession } = await import("../../dist/game/session.js");
const { settleLogHash, toWireResults, encodeCompactLog }
  = await import("../../dist/game/settle.js");
const { CoopRunner, ProxyRelayTransport } = await import("../../dist/net/coop.js");

const STAMP = Date.now().toString(36).slice(-4);
const BOT = process.env.ROG_BOT || `duelbot${STAMP}`;
const HOST_ONLY = process.env.ROG_HOST || "";
const STAKE_ITEMS = process.env.ROG_BOT_STAKE_ITEMS !== "0";
const WAIT_S = Number(process.env.ROG_BOT_WAIT || 300);
const CONCEDE = process.env.ROG_BOT_CONCEDE === "1";
const OPEN = process.env.ROG_BOT_OPEN === "1";
const GATE = process.env.ROG_BOT_DIR || "east";

const log = (m) => console.log(`[bot] ${m}`);

/* ------------------------------------------------------------------ setup */

log(`I am ${BOT}. Registering.`);
await register(BOT);
installClaim(BOT, tokens[BOT]);

/* --------------------------------------------- open one, or find one to take */

let active = null;

if (OPEN) {
  // An open visit is swept after VISIT_OPEN_TIMEOUT blocks (100), which on
  // a devnet mining every 3 seconds is about five minutes. A bot that hosts
  // once and then waits half an hour is offering a duel that stopped
  // existing before anyone could walk to it, which is exactly what it
  // looked like from the other side: "where is the duel?". So re-host for
  // as long as we were asked to wait.
  const giveUpAt = Date.now() + WAIT_S * 1000;
  let hosted = 0;

  while (Date.now() < giveUpAt && !active) {
    const me1 = await gsp("getplayerinfo", [BOT]);
    const bag0 = me1.inventory.filter(i => i.slot === "bag");
    const v = { dir: GATE, mode: "duel", stake: 0, min_stake: 0 };
    if (STAKE_ITEMS && bag0.length > 0) v.stake_items = bag0.map(i => i.rowid);
    await move(BOT, { v });
    await mine(1);

    let opened = null;
    for (let i = 0; i < 20 && !opened; i++) {
      const open = (await gsp("listvisits", ["open"])) || [];
      opened = open.find(x => x.mode === "duel" && x.initiator === BOT) ?? null;
      if (!opened) await sleep(500);
    }
    if (!opened) {
      log("My host move did not open a duel. Check the GSP log.");
      process.exit(1);
    }
    hosted++;
    log(`Duel ${opened.id} is open${hosted > 1 ? ` (re-host #${hosted})` : ""}, ` +
        `staking ${v.stake_items?.length ?? 0} bag row(s). ` +
        `It expires in about 5 minutes if nobody comes.`);

    // Wait until somebody joins, or the chain takes it back.
    while (Date.now() < giveUpAt) {
      const v2 = await gsp("getvisitinfo", [opened.id]);
      if (v2?.status === "active") { active = v2; break; }
      if (v2 && v2.status !== "open") {
        log(`Duel ${opened.id} went ${v2.status} before anyone joined. ` +
            `Opening another.`);
        break;
      }
      await sleep(1500);
    }
  }
  if (!active) { log("Nobody joined. Nothing to do."); process.exit(0); }
} else {
  log(HOST_ONLY
    ? `Waiting for an open duel hosted by ${HOST_ONLY}...`
    : "Waiting for any open duel...");

  let target = null;
  for (let i = 0; i < WAIT_S * 2 && !target; i++) {
    const open = (await gsp("listvisits", ["open"])) || [];
    target = open.find(v => v.mode === "duel"
      && v.initiator !== BOT
      && (!HOST_ONLY || v.initiator === HOST_ONLY)) ?? null;
    if (!target) await sleep(500);
  }
  if (!target) { log("No duel appeared. Nothing to do."); process.exit(0); }

  const staked = target.staked_items ?? [];
  log(`Found duel ${target.id} from ${target.initiator} on (${target.segment.x}, ` +
      `${target.segment.y}): stake ${target.stake ?? 0}, floor ` +
      `${target.min_stake ?? 0}, items ${staked.length
        ? staked.map(i => `${i.quantity}x ${i.item_id} (${i.worth})`).join(", ")
        : "none"}`);

  // Walk in through the gate facing the arena from wherever the bot stands.
  const me0 = await gsp("getplayerinfo", [BOT]);
  const dx = target.segment.x - me0.segment.x;
  const dy = target.segment.y - me0.segment.y;
  const dir = dx === 1 ? "east" : dx === -1 ? "west"
            : dy === 1 ? "north" : dy === -1 ? "south" : null;
  if (!dir) {
    log(`I am at (${me0.segment.x}, ${me0.segment.y}) and the arena is not ` +
        `next door. Move me adjacent to it and run again.`);
    process.exit(1);
  }

  const bag = me0.inventory.filter(i => i.slot === "bag");
  const stakeItems = STAKE_ITEMS ? bag.map(i => i.rowid) : [];
  const j = { id: target.id, dir, stake: 0 };
  if (stakeItems.length > 0) j.stake_items = stakeItems;
  log(`Joining through the ${dir} gate` +
      (stakeItems.length ? `, staking ${stakeItems.length} bag row(s)` : " with nothing"));
  await move(BOT, { j });
  await mine(1);

  active = await visitUntil(target.id, v => v?.status === "active", 60000);
  if (!active) {
    log("The duel never went active. Was the join refused? Check the GSP log.");
    process.exit(1);
  }
}
log(`Duel ${active.id} is active. Pot ${active.pot ?? 0}.`);

/* -------------------------------------------------------- build the session */

const segInfo = await gsp("getsegmentinfo", [active.segment.x, active.segment.y]);
const names = canonicalNames(active.participants);
const meIdx = names.indexOf(BOT);
const setups = [];
for (const n of names) {
  setups.push(setupFromPlayer(await gsp("getplayerinfo", [n]),
                              active.entry_directions?.[n] ?? ""));
}
const session = DungeonSession.createDuel(
  segInfo.seed, segInfo.depth, setups, active.id, constraintsFor(segInfo));

const runner = new CoopRunner({
  session,
  me: meIdx,
  names,
  transport: new ProxyRelayTransport(PROXY, active.id, BOT),
  onChange: () => {},
  onNote: () => {},
});
log(`Playing as participant ${meIdx} of ${names.join(", ")}.`);
runner.start();

/* ------------------------------------------------------------- the strategy */

/** The opposing participant's live position, or null when it cannot act. */
function foe() {
  for (let i = 0; i < names.length; i++) {
    if (i === meIdx) continue;
    if (!session.isPlayerActive(i)) continue;
    const p = session.players[i];
    return { x: p.x, y: p.y };
  }
  return null;
}

/**
 * Walk at the opponent and bump them, which in a duel attacks.
 *
 * ORTHOGONALLY, one axis at a time, and this is not a detail. The obvious
 * greedy step is `Math.sign(dx), Math.sign(dy)`, which is diagonal, and a
 * bot that does that parks itself diagonally adjacent and beats a human to
 * death from a square their keyboard cannot reach: arrow keys and WASD are
 * orthogonal, diagonals are Q/E/Z/C, and nobody thinks to try them
 * mid-fight. Bot versus bot hid it completely, because both bots used
 * diagonals and met each other happily.
 *
 * A sparring partner has to fight where its opponent can answer. Closing
 * on the longer axis first also means it arrives orthogonally adjacent,
 * which is the square an arrow key can hit back from.
 */
function nextAction() {
  const f = foe();
  const m = session.players[meIdx];
  if (!f) return { type: "wait" };
  const dx = f.x - m.x, dy = f.y - m.y;
  if (dx === 0 && dy === 0) return { type: "wait" };
  // One axis only, the longer one first.
  if (Math.abs(dx) >= Math.abs(dy))
    return { type: "move", dx: Math.sign(dx), dy: 0 };
  return { type: "move", dx: 0, dy: Math.sign(dy) };
}

/* ----------------------------------------------------- checkpoint confirms */

// The browser sends these from main.ts, and without them the human's client
// cannot settle: a normal settle needs every OTHER participant's confirm to
// match the whole submitted log. A bot that fought well and never confirmed
// would be just as unsettleable as one that never showed up.
let lastN = -1;
let confirmBusy = false;

async function checkpoint(force) {
  // A forced confirm must not be skippable. The first version returned
  // early when a periodic one was in flight, which lost the FINAL confirm
  // and left the log 5 actions short: the GSP then refused the settle with
  // "confirm from X covers 102 actions but the submitted log has 107", and
  // neither side could bank a duel they had both finished.
  if (force) {
    for (let i = 0; i < 100 && confirmBusy; i++) await sleep(100);
  } else if (confirmBusy || session.gameOver) {
    return;
  }
  const n = session.mergedLog.length;
  if (!force && n - lastN < 8) return;
  confirmBusy = true;
  lastN = n;
  try {
    const h = settleLogHash(active.id, session.mergedLog.slice(0, n));
    await move(BOT, { sc: { id: active.id, h, n } });
    await mine(1);
  } catch (e) {
    log(`checkpoint failed: ${e.message ?? e}`);
  }
  confirmBusy = false;
  return n;
}

/**
 * Waits for every other participant to have confirmed the whole log.
 *
 * A normal settle needs their confirm to match it exactly, so submitting
 * before they have caught up is simply rejected. The browser waits the same
 * way in main.ts before it settles.
 */
async function waitForTheirConfirms(total, ms = 120000) {
  const others = names.filter(n => n !== BOT);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await gsp("getvisitinfo", [active.id]);
    if (!v || v.status !== "active") return true;   // someone else settled it
    const behind = others.filter(n => (v.confirms?.[n]?.n ?? -1) !== total);
    if (behind.length === 0) return true;
    await sleep(800);
  }
  return false;
}

/* ------------------------------------------------------------- the main loop */

if (CONCEDE) log("ROG_BOT_CONCEDE=1: I will walk out and hand them the win.");

let rounds = 0;
const deadline = Date.now() + 20 * 60000;
while (!session.gameOver && Date.now() < deadline) {
  // A duel takes exactly one sealed choice per round, in the commit phase.
  if (runner.myChoicePending && !runner.inputFull) {
    const a = CONCEDE ? { type: "gate" } : nextAction();
    if (runner.submitLocal(a)) {
      rounds++;
      if (rounds % 5 === 0) {
        const f = foe();
        const m = session.players[meIdx];
        log(`round ${session.roundIndex}: me ${m.hp}hp at (${m.x}, ${m.y})` +
            (f ? `, them at (${f.x}, ${f.y})` : ", them gone"));
      }
    }
  }
  await checkpoint(false);
  await sleep(150);
}

runner.stop();

// The combat log is the only ground truth about who hit what: a duellist
// can be annihilated by the ARENA rather than by their opponent, and from
// the outside those look identical (one player dead, the other untouched).
// The opponent's ACTUAL committed actions, round by round. Guessing from
// the outside has been wrong four times: what a player pressed, what got
// committed, and what applied are three different things, and only the
// merged log knows the third one.
{
  const foeIdx = meIdx === 0 ? 1 : 0;
  const rows = session.mergedLog
    .map((e, i) => ({ i, e }))
    .filter(({ e }) => e.actor === foeIdx)
    .map(({ i, e }) => {
      const a = e.action;
      const d = a.type === "move" ? ` ${a.dx},${a.dy}` : "";
      return `${String(i).padStart(3)} ${a.type}${d}`;
    });
  log(`${names[foeIdx]}'s log entries (${rows.length}):`);
  for (const r of rows) console.log(`       ${r}`);
}

const combat = (session.messages ?? [])
  .filter(m => (m.kind ?? m.type) === "combat")
  .map(m => m.text ?? String(m));
if (combat.length > 0) {
  log(`combat log (${combat.length} lines):`);
  for (const line of combat.slice(-40)) console.log(`       ${line}`);
}

if (!session.gameOver) {
  log("Timed out with the duel still live. Leaving it for the void sweeper.");
  process.exit(1);
}

/* ------------------------------------------------------------------- settle */

// Confirm the whole log whatever the outcome, so the human can settle from
// their side even when the bot lost and has nothing to gain by cooperating.
const total = await checkpoint(true);
const winner = session.duelWinner;
log(`Duel over after ${session.roundIndex} rounds. Winner: ` +
    `${winner < 0 ? "nobody" : names[winner]}. ` +
    `Confirmed the full log (${session.mergedLog.length} actions).`);

if (winner === meIdx) {
  log("I won. Waiting for their confirm before I settle.");
  if (!await waitForTheirConfirms(total ?? session.mergedLog.length)) {
    log("They never confirmed the full log, so I cannot settle normally. " +
        "Leaving it; the void sweeper or an abandonment settle is the remedy.");
    process.exit(1);
  }
  try {
    const results = toWireResults(session, names, active.pot ?? 0);
    // Same compact encoding the browser sends (config COMPACT_ACTIONS), with
    // the actor prefix a merged log requires.
    const actions = encodeCompactLog(session.mergedLog, true);
    await move(BOT, { s: { id: active.id, results, actions } });
    await mine(1);
    const done = await visitUntil(active.id, v => v?.status === "completed", 60000);
    log(done ? "Settled on-chain." : "Settle did not land; check the GSP log.");
  } catch (e) {
    log(`settle failed: ${e.message ?? e}`);
  }
} else {
  log("They won. Their client settles; my confirm is on file so it can.");
}
