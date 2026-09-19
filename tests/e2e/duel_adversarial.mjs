/**
 * Adversarial duel tests: a client that lies.
 *
 * The backend's duel unit tests construct malicious input directly in C++.
 * This proves the same rules hold against the real chain, submitted by a
 * real client over the real move path, because the gap between "the rule is
 * tested" and "a client cannot reach a bad state" is where the duel
 * settlement bug lived.
 *
 * There is no browser here on purpose. A Playwright page runs honest code
 * and cannot be made to lie; a Node actor holding its own copy of the engine
 * can build any log it likes and submit it. Both duellists are such actors,
 * so the honest duel is played in-process and only the on-chain moves are
 * real.
 *
 * Every case asserts a REJECTION, so a pass means the chain refused. The
 * last case is the honest control: it must be accepted, otherwise the
 * rejections prove nothing.
 *
 * Prerequisites: a devnet running (the static server is not needed).
 * Run:  npm run duel:evil
 */
import { DungeonSession, duelCommitHash } from "../../dist/game/session.js";
import { settleLogHash, toWireResults, toWireAction, computeClaims }
  from "../../dist/game/settle.js";
import { sleep } from "./agentcore.mjs";

const PROXY = process.env.ROG_PROXY || "http://localhost:18380";
const STAMP = Date.now().toString(36).slice(-4);
const A = process.env.ROG_A || `evilA${STAMP}`;
const B = process.env.ROG_B || `evilB${STAMP}`;

const findings = [];
const fail = (m) => { findings.push(m); console.log("  ✗ " + m); };
const ok = (m) => console.log("  ✓ " + m);
const tokens = {};

async function proxy(body) {
  const r = await fetch(PROXY, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function gsp(method, params = []) {
  const r = await fetch(`${PROXY}/gsp`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const res = (await r.json()).result;
  return res && typeof res === "object" && "data" in res ? res.data : res;
}
async function move(name, data) {
  return proxy({ action: "move", name, game: "rog", data, token: tokens[name] });
}
async function register(name) {
  const r = await proxy({ action: "register", name });
  tokens[name] = r.body.token ?? "";
  await move(name, { r: {} });
  for (let i = 0; i < 40; i++) {
    if (await gsp("getplayerinfo", [name])) return;
    await sleep(500);
  }
  throw new Error(`${name} never appeared on-chain`);
}
/** Waits for a predicate over getvisitinfo, returning the visit or null. */
async function visitUntil(id, pred, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await gsp("getvisitinfo", [id]);
    if (pred(v)) return v;
    await sleep(600);
  }
  return null;
}
const height = async () => (await gsp("getcurrentstate", []), (await (await fetch(`${PROXY}/gsp`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getcurrentstate", params: [] }),
})).json()).result.height);

/** Rebuilds a participant's engine setup from chain state, as the GSP does. */
function setupFromPlayer(p, entryDir) {
  return {
    name: p.name,
    stats: {
      level: p.level,
      strength: p.effective_stats.strength,
      dexterity: p.effective_stats.dexterity,
      constitution: p.effective_stats.constitution,
      intelligence: p.effective_stats.intelligence,
      equipAttack: p.effective_stats.equip_attack,
      equipDefense: p.effective_stats.equip_defense,
    },
    hp: p.hp, maxHp: p.max_hp,
    potions: p.inventory
      .filter((i) => i.slot === "bag" && /health_potion/.test(i.item_id))
      .map((i) => ({ itemId: i.item_id, quantity: i.quantity })),
    inventory: p.inventory
      .map((i) => ({ rowid: i.rowid, itemId: i.item_id, slot: i.slot }))
      .sort((x, y) => x.rowid - y.rowid),
    entryDir,
  };
}
function constraintsFor(seg) {
  if (!seg.constraint_dir) return [];
  const g = seg.gates?.[seg.constraint_dir];
  return g ? [{ x: g.x, y: g.y, direction: seg.constraint_dir }] : [];
}

/** Ensures a confirmed segment east of the hub, walking a run in and out. */
async function ensureArena(name) {
  let segs = await gsp("listsegments", []);
  if (segs.some((s) => s.x === 1 && s.y === 0 && s.confirmed)) return;
  if (!segs.some((s) => s.x === 1 && s.y === 0)) {
    await move(name, { gw: { dir: "east" } });
    for (let i = 0; i < 40; i++) {
      const p = await gsp("getplayerinfo", [name]);
      if (p?.in_channel) break;
      await sleep(500);
    }
  }
  const p = await gsp("getplayerinfo", [name]);
  if (!p?.in_channel) throw new Error("could not enter the frontier segment");
  const seg = await gsp("getsegmentinfo", [1, 0]);
  const s = new DungeonSession(seg.seed, seg.depth,
    setupFromPlayer(p, "").stats, p.hp, p.max_hp,
    setupFromPlayer(p, "").potions, constraintsFor(seg),
    p.active_visit.entry_direction, setupFromPlayer(p, "").inventory);

  // Walk back to the gate we came in by; surviving to a gate confirms it.
  const gate = s.dungeon.gates.find((g) => g.direction === p.active_visit.entry_direction)
    ?? s.dungeon.gates[0];
  for (let i = 0; i < 80 && !(s.playerX === gate.x && s.playerY === gate.y); i++) {
    const dx = Math.sign(gate.x - s.playerX), dy = Math.sign(gate.y - s.playerY);
    if (!s.processAction({ type: "move", dx, dy })
        && !s.processAction({ type: "move", dx, dy: 0 })
        && !s.processAction({ type: "move", dx: 0, dy })) s.processAction({ type: "wait" });
  }
  await move(name, {
    gw: {
      dir: gate.direction,
      settlement: {
        results: { survived: true, xp: s.totalXp, gold: s.totalGold, kills: s.totalKills },
        actions: [...s.actionLog, { type: "gate" }].map((a) =>
          a.type === "use" ? { type: "use", item: a.itemId } : a),
      },
    },
  });
  for (let i = 0; i < 40; i++) {
    segs = await gsp("listsegments", []);
    if (segs.some((x) => x.x === 1 && x.y === 0 && x.confirmed)) return;
    await sleep(600);
  }
  throw new Error("the arena never became confirmed");
}

console.log("setup: two players and a confirmed arena");
await register(A);
await register(B);
await ensureArena(A);
// ensureArena may leave A inside the neighbour's run; walk home if so.
for (let i = 0; i < 40; i++) {
  const p = await gsp("getplayerinfo", [A]);
  if (!p.in_channel && p.segment.x === 0 && p.segment.y === 0) break;
  if (p.in_channel) await move(A, { xc: { id: p.active_visit.visit_id,
    results: { survived: false, xp: 0, gold: 0, kills: 0 }, actions: "" } });
  await sleep(600);
}
ok(`${A} and ${B} registered, arena (1, 0) confirmed`);

console.log("open a staked duel and play it out honestly, in process");
const STAKE = 0;
await move(A, { v: { dir: "east", mode: "duel", stake: STAKE } });
const opened = await visitUntil(null ?? 0, () => false, 0) ?? null;
let visitId = null;
for (let i = 0; i < 40 && visitId === null; i++) {
  const p = await gsp("getplayerinfo", [A]);
  if (p?.active_visit) visitId = p.active_visit.visit_id;
  await sleep(500);
}
if (visitId === null) { fail("the duel never opened"); process.exit(1); }
await move(B, { j: { id: visitId, dir: "east" } });
const active = await visitUntil(visitId, (v) => v?.status === "active", 40000);
if (!active) { fail("the duel never activated"); process.exit(1); }
ok(`duel #${visitId} active, mode ${active.mode}, pot ${active.pot ?? 0}`);

// Build the same session the GSP will replay, and fight it to a finish.
const names = [...active.participants].sort();
const infos = Object.fromEntries(await Promise.all(
  names.map(async (n) => [n, await gsp("getplayerinfo", [n])])));
const segInfo = await gsp("getsegmentinfo", [1, 0]);
const setups = names.map((n) =>
  setupFromPlayer(infos[n], active.entry_directions?.[n] ?? ""));
const game = DungeonSession.createDuel(segInfo.seed, segInfo.depth, setups,
                                        visitId, constraintsFor(segInfo));
// 16 bytes of hex; the engine rejects anything else, so keep it hex.
const salt = (i, r) => (BigInt(i + 1) * 1000003n + BigInt(r)).toString(16).padStart(32, "0");
console.log(`   entry dirs: ${JSON.stringify(active.entry_directions)}`);
console.log(`   spawns: ${game.players.map((p) => `${p.x},${p.y}`).join(" | ")} ` +
            `mode=${game.isDuel()} phase=${game.phase} next=${game.nextActor}`);
let rejected = 0;
for (let round = 0; round < 400 && !game.gameOver; round++) {
  const r = game.roundIndex;
  const acts = [0, 1].map((i) => {
    const me = game.players[i], foe = game.players[1 - i];
    const dx = Math.sign(foe.x - me.x), dy = Math.sign(foe.y - me.y);
    return (dx || dy) ? { type: "move", dx, dy } : { type: "wait" };
  });
  for (const i of [0, 1])
    if (game.isPlayerActive(i))
      if (!game.processActionBy(i, { type: "commit", hex: duelCommitHash(visitId, r, i, acts[i], salt(i, r)) })) rejected++;
  for (const i of [0, 1])
    if (game.isPlayerActive(i) && !game.processActionBy(i, { type: "reveal", hex: salt(i, r) })) rejected++;
  for (const i of [0, 1])
    if (game.isPlayerActive(i) && !game.processActionBy(i, acts[i])) rejected++;
}
const winner = game.duelWinner, loser = winner === 0 ? 1 : 0;
if (!game.gameOver || winner < 0) {
  fail(`the in-process duel never resolved (rejected=${rejected} log=${game.mergedLog.length} ` +
       `round=${game.roundIndex} phase=${game.phase} hp=${game.players.map((p) => p.hp).join("/")})`);
  process.exit(1);
}
ok(`fought ${game.mergedLog.length} entries; ${names[winner]} wins`);

const log = game.mergedLog;
const honestHash = settleLogHash(visitId, log);
const wire = log.map(toWireAction);
const honestResults = toWireResults(game, names, active.pot ?? 0);
const stillActive = async (label) => {
  const v = await visitUntil(visitId, (x) => x?.status !== "active", 12000);
  if (v) { fail(`${label}: the chain ACCEPTED it (status ${v.status})`); return false; }
  ok(`${label}: refused`);
  return true;
};

console.log("\nadversarial cases");

/** Every case must leave the duel unsettled; the control at the end settles it. */
async function mustRefuse(label) {
  const v = await visitUntil(visitId, (x) => x?.status !== "active", 12000);
  if (v) { fail(`${label}: the chain ACCEPTED it (status ${v.status})`); return false; }
  ok(`${label}: refused`);
  return true;
}
async function assertStillOpen(label) {
  const v = await gsp("getvisitinfo", [visitId]);
  if (v?.status !== "active") {
    fail(`${label}: skipped, an earlier case already settled the duel`);
    return false;
  }
  return true;
}

// 1. Relay spoofing: post a message as the other player.
{
  const r = await proxy({ action: "relay_send", name: names[loser],
                          token: (tokens[names[winner]] || "") + "x", visit: visitId,
                          msg: { n: 999, action: { type: "wait" } } });
  if (r.status === 200) {
    console.log("  - relay spoofing: SKIPPED, this devnet has claim tokens off " +
                "(ROG_REQUIRE_CLAIM_TOKEN=1 to test it; the hosted sandbox sets it)");
  } else ok(`relay refused a spoofed sender (${r.status})`);
}

// 2. Settle with no confirm from the opponent at all.
if (await assertStillOpen("no confirm on file")) {
  await move(names[winner], { s: { id: visitId, results: honestResults, actions: wire } });
  await mustRefuse("settle with no confirm on file");
}

// 3. Abandonment against an opponent who is plainly alive. Their only
//    confirm is a short prefix, seconds old, and a duel's abandonment
//    settle carries no solo suffix, so the staleness window is what stands
//    between a loser and simply declaring the other side absent.
if (await assertStillOpen("live abandonment")) {
  const prefix = log.slice(0, 6);
  const pHash = settleLogHash(visitId, prefix);
  await move(names[loser], { sc: { id: visitId, h: pHash, n: prefix.length } });
  await visitUntil(visitId, (v) => v?.confirms?.[names[loser]]?.n === prefix.length, 25000);
  await move(names[winner], { s: { id: visitId, results: honestResults,
                                   actions: prefix.map(toWireAction),
                                   solo_from: prefix.length } });
  await mustRefuse("abandoning an opponent who is still checkpointing");
}

// From here the opponent has consented to the whole, honest log.
await move(names[loser], { sc: { id: visitId, h: honestHash, n: log.length } });
await visitUntil(visitId, (v) => v?.confirms?.[names[loser]]?.h === honestHash, 25000);

// 4. The loser claims the win over a log they did consent to.
if (await assertStillOpen("wrong winner")) {
  const flipped = computeClaims(game, active.pot ?? 0).map((c, i) => ({
    p: names[i], ...c,
    survived: i === loser,
    duel: i === loser ? "won" : "lost",
  }));
  await move(names[loser], { s: { id: visitId, results: flipped, actions: wire } });
  await mustRefuse("the loser claiming the win");
}

// 5. A truncated log: the confirm no longer covers what is submitted.
if (await assertStillOpen("tampered log")) {
  await move(names[winner], { s: { id: visitId, results: honestResults,
                                   actions: wire.slice(0, -1) } });
  await mustRefuse("a log the opponent never confirmed");
}

// 6. A reveal that does not open its commitment. The wire field for a
//    reveal's salt is `s`; changing it changes the log, so this is both a
//    consent mismatch and a protocol violation.
if (await assertStillOpen("forged reveal")) {
  let swapped = false;
  const forged = wire.map((e) => {
    if (e.type !== "reveal" || swapped) return e;
    swapped = true;
    return { ...e, s: "f".repeat(32) };
  });
  if (!swapped) fail("no reveal found in the log to forge");
  await move(names[winner], { s: { id: visitId, results: honestResults, actions: forged } });
  await mustRefuse("a reveal that does not open its commitment");
}

// 7. A commitment lifted from a different round, which the preimage binds
//    against, so it can never open.
if (await assertStillOpen("replayed commitment")) {
  const idx = wire.findIndex((e) => e.type === "commit");
  const later = wire.slice(idx + 1).find((e) => e.type === "commit" && e.h !== wire[idx].h);
  if (!later) fail("no second commitment to replay");
  else {
    const forged = wire.map((e, k) => (k === idx ? { ...e, h: later.h } : e));
    await move(names[winner], { s: { id: visitId, results: honestResults, actions: forged } });
    await mustRefuse("a commitment replayed from another round");
  }
}

// 8. Control: the honest settlement must go through, or the refusals above
//    prove nothing.
if (await assertStillOpen("control")) {
  await move(names[winner], { s: { id: visitId, results: honestResults, actions: wire } });
  const v = await visitUntil(visitId, (x) => x?.status !== "active", 60000);
  if (!v || v.status !== "completed") fail(`CONTROL: the honest settlement was refused (${v?.status})`);
  else {
    ok("control: the honest settlement was accepted");
    for (const r of v.results ?? [])
      console.log(`     ${r.name}: survived=${r.survived} xp=${r.xp_gained} gold=${r.gold_gained}`);
  }
}

console.log(findings.length ? `\nFAIL (${findings.length})` : "\nPASS");
for (const f of findings) console.log(" - " + f);
process.exit(findings.length ? 1 : 0);
