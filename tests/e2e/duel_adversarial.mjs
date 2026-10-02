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
 * rejections prove nothing, and once it settles the staked rows must be in
 * the winner's bag.
 *
 * Two groups of cheats. The stake cheats come first, against the duel as it
 * opens (a row you do not own, one row counted twice, equipped gear, gold
 * you do not have, a row already in escrow, a stake below the floor, and a
 * challenger with no room for what they would win). Then the settlement
 * cheats, against the finished fight.
 *
 * The full-bag case needs a third player with 50 bag rows, filled the
 * honest way by running the arena about a dozen times, which is most of
 * this script's running time. ROG_SKIP_FULL_BAG=1 skips it; ROG_C names a
 * character to reuse (one already full skips the runs).
 *
 * Prerequisites: a devnet running (the static server is not needed).
 * Run:  npm run duel:evil
 */
import { DungeonSession, duelCommitHash } from "../../dist/game/session.js";
import { settleLogHash, toWireResults, toWireAction, computeClaims }
  from "../../dist/game/settle.js";
import { lookupItem } from "../../dist/game/items.js";
import { MAX_BAG_ROWS } from "../../dist/config.js";
import { sleep } from "./agentcore.mjs";
import { setupFromPlayer, constraintsFor, planLootRun } from "./bagfill.mjs";
import { bagTotals, potTotals, minus, describe, stakeTransferFailures }
  from "./stakes.mjs";

const PROXY = process.env.ROG_PROXY || "http://localhost:18380";
const STAMP = Date.now().toString(36).slice(-4);
const A = process.env.ROG_A || `evilA${STAMP}`;
const B = process.env.ROG_B || `evilB${STAMP}`;
const C = process.env.ROG_C || `evilC${STAMP}`;

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
/** The GSP's own view of where it is: `{state, height}`. */
async function gspTip() {
  const r = await fetch(`${PROXY}/gsp`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getcurrentstate", params: [] }),
  });
  const res = (await r.json()).result ?? {};
  return { state: res.state, height: res.height ?? 0 };
}

/**
 * Submits a move and waits until the GSP has processed the block holding
 * it, so a refusal can be read off the state rather than timed out. The
 * proxy mines the move's own block before answering; one more block and an
 * up-to-date GSP past both means the move has been seen.
 */
async function moveSeen(name, data) {
  const h0 = (await gspTip()).height;
  await move(name, data);
  await proxy({ action: "mine", blocks: 1 });
  for (let i = 0; i < 60; i++) {
    const t = await gspTip();
    if ((t.state ?? "up-to-date") === "up-to-date" && t.height >= h0 + 2) return;
    await sleep(300);
  }
  throw new Error(`the GSP never caught up after ${name}'s ${Object.keys(data)[0]} move`);
}

const player = (n) => gsp("getplayerinfo", [n]);
const bagRow = (p, id) => p.inventory.find((i) => i.slot === "bag" && i.item_id === id);
const bagRows = (p) => p.inventory.filter((i) => i.slot === "bag").length;
const worthOf = (row) => (lookupItem(row.item_id)?.value ?? 0) * row.quantity;

/** Moves `id` from its equipment slot to the bag, where it can be staked. */
async function unequip(name, id) {
  const p = await player(name);
  if (bagRow(p, id)) return bagRow(p, id).rowid;
  const row = p.inventory.find((i) => i.item_id === id && i.slot !== "bag");
  if (!row) throw new Error(`${name} has no ${id} to unequip`);
  await moveSeen(name, { uq: { rowid: row.rowid } });
  const after = bagRow(await player(name), id);
  if (!after) throw new Error(`${name}'s ${id} never reached the bag`);
  return after.rowid;
}

/**
 * Fills `name`'s bag to MAX_BAG_ROWS by running the arena east of the hub
 * and walking out with everything on its floor. Throws if the arena gives
 * nothing to keep, or if a run the planner believed in is refused.
 */
async function fillBag(name) {
  for (let run = 1; run <= 40; run++) {
    let p = await player(name);
    if (bagRows(p) >= MAX_BAG_ROWS) return bagRows(p);
    if (!p.in_channel) {
      await move(name, { gw: { dir: "east" } });
      for (let i = 0; i < 40 && !p.in_channel; i++) { await sleep(500); p = await player(name); }
      if (!p.in_channel) throw new Error(`${name} could not enter the arena (run ${run})`);
    }
    const seg = await gsp("getsegmentinfo", [1, 0]);
    const plan = planLootRun(seg, p, p.active_visit.entry_direction);
    if (!plan) throw new Error(`no run through the arena survives for ${name}`);
    const rowsBefore = bagRows(p);
    await move(name, { gw: { dir: plan.gate.direction,
                             settlement: { results: plan.results, actions: plan.actions } } });
    for (let i = 0; i < 40 && p.in_channel; i++) { await sleep(500); p = await player(name); }
    if (p.in_channel)
      throw new Error(`the GSP refused ${name}'s loot run ${run} (${plan.actions.length} actions)`);
    console.log(`   run ${run}: ${rowsBefore} -> ${bagRows(p)} bag rows, hp ${p.hp}/${p.max_hp}`);
    if (plan.rows === 0) throw new Error("the arena's floor holds nothing that takes a bag row");
  }
  throw new Error(`${name}'s bag was still not full after 40 runs`);
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

// A third player whose bag is full, for the one stake cheat that needs a
// winner with nowhere to put the winnings. Their sword comes off first: it
// is their stake, and once the bag is full there is no room to unequip it.
let bagFull = false;
if (process.env.ROG_SKIP_FULL_BAG) {
  console.log("  - full bag: SKIPPED (ROG_SKIP_FULL_BAG is set)");
} else {
  console.log(`filling ${C}'s bag by running the arena (a few dozen blocks)`);
  try {
    await register(C);
    await unequip(C, "short_sword");
    const rows = await fillBag(C);
    bagFull = true;
    ok(`${C} holds ${rows} bag rows, the most a bag can`);
  } catch (e) {
    fail(`setup: could not fill a bag, so the full-bag cheat went untested: ${e.message}`);
  }
}

// ---------------------------------------------------------------- stakes
// Each cheat below must be refused, and refused WHOLE: a stake that named
// one bad row and escrowed the rest would lock those rows to a visit that
// never opened. So every case checks the pot as well as the refusal.
console.log("\nstake cheats");

// Something non-stackable on each side, so a won row needs a bag row of
// its own (a won potion merges into a stack and needs none).
const swordA = await unequip(A, "short_sword");
const swordB = await unequip(B, "short_sword");
const pa = await player(A), pb = await player(B);
const potA = bagRow(pa, "health_potion")?.rowid;
const potB = bagRow(pb, "health_potion")?.rowid;
const armorA = pa.inventory.find((i) => i.slot !== "bag")?.rowid;
if (!potA || !potB || !armorA) {
  fail(`fresh characters should carry potions and wear armour ` +
       `(potA=${potA} potB=${potB} armorA=${armorA}); use fresh names`);
  process.exit(1);
}
// One more than B's potion stack is worth: the potions alone fall short,
// the potions and the sword clear it, and the potions counted twice would.
const FLOOR = worthOf(bagRow(pb, "health_potion")) + 1;
ok(`swords unequipped; the host will ask for at least ${FLOOR}`);

/** A host move that must open nothing. */
async function hostRefused(label, v) {
  await moveSeen(A, { v: { dir: "east", mode: "duel", ...v } });
  const p = await player(A);
  if (p.active_visit) {
    fail(`${label}: the chain OPENED duel #${p.active_visit.visit_id}`);
    console.log(findings.length ? `\nFAIL (${findings.length})` : "");
    for (const f of findings) console.log(" - " + f);
    process.exit(1);
  }
  ok(`${label}: refused`);
}

await hostRefused("host stakes a row they do not own", { stake: 0, stake_items: [potB] });
await hostRefused("host stakes the same row twice", { stake: 0, stake_items: [potA, potA] });
await hostRefused("host stakes the armour they are wearing", { stake: 0, stake_items: [armorA] });
await hostRefused("host stakes gold they do not have", { stake: (pa.gold ?? 0) + 1000 });

// The honest host: sword and potions, with the floor above.
await moveSeen(A, { v: { dir: "east", mode: "duel", stake: 0, min_stake: FLOOR,
                         stake_items: [swordA, potA] } });
const visitId = (await player(A)).active_visit?.visit_id ?? null;
if (visitId === null) { fail("the honest duel never opened"); process.exit(1); }
const hostPot = potTotals((await gsp("getvisitinfo", [visitId]))?.staked_items);
const bagsBefore = { [A]: bagTotals(await player(A)), [B]: bagTotals(await player(B)) };
ok(`duel #${visitId} open with ${describe(hostPot)} in the pot`);

// A row can only be in escrow while its owner sits in the duel holding it,
// so the one way to stake it again is from inside that duel. The visit
// guard refuses before the escrow check is reached; what is asserted is
// the property, that the row does not end up behind a second duel.
await moveSeen(A, { v: { dir: "east", mode: "duel", stake: 0, stake_items: [swordA] } });
{
  const p = await player(A);
  const pot = potTotals((await gsp("getvisitinfo", [visitId]))?.staked_items);
  if (p.active_visit?.visit_id !== visitId)
    fail(`host re-stakes an escrowed row: now in visit ${p.active_visit?.visit_id}`);
  else if (describe(pot) !== describe(hostPot))
    fail(`host re-stakes an escrowed row: the pot became ${describe(pot)}`);
  else ok("host re-stakes a row already in escrow: refused");
}

/** A join that must leave the duel open, with the host alone and the pot as it was. */
async function joinRefused(label, who, j) {
  await moveSeen(who, { j: { id: visitId, dir: "east", ...j } });
  const v = await gsp("getvisitinfo", [visitId]);
  const pot = potTotals(v?.staked_items);
  if (v?.status !== "open" || (v.participants ?? []).length !== 1) {
    fail(`${label}: the chain let ${who} in (status ${v?.status}, ` +
         `participants ${JSON.stringify(v?.participants)})`);
    console.log(`\nFAIL (${findings.length})`);
    for (const f of findings) console.log(" - " + f);
    process.exit(1);
  }
  if (describe(pot) !== describe(hostPot)) fail(`${label}: refused, but the pot became ${describe(pot)}`);
  else ok(`${label}: refused, pot untouched`);
}

await joinRefused("challenger stakes below the floor", B,
                  { stake: 0, stake_items: [potB] });
// Their own potions and sword clear the floor, so ownership is the only
// thing wrong; and it must not escrow the two rows that were fine.
await joinRefused("challenger stakes the host's escrowed sword", B,
                  { stake: 0, stake_items: [potB, swordB, swordA] });
await joinRefused("challenger counts one row twice to clear the floor", B,
                  { stake: 0, stake_items: [potB, potB] });
await joinRefused("challenger stakes gold they do not have", B,
                  { stake: (pb.gold ?? 0) + 1000, stake_items: [potB, swordB] });
if (bagFull) {
  // Their stake clears the floor; winning would hand them the host's sword
  // and they have no row to put it in. Settlement must never have to drop
  // won property, so the join is where it stops.
  const pc = await player(C);
  await joinRefused("a challenger with no room for the winnings", C,
                    { stake: 0, stake_items: [bagRow(pc, "health_potion").rowid,
                                              bagRow(pc, "short_sword").rowid] });
}

console.log("\nthe honest duel, played out in process");
await moveSeen(B, { j: { id: visitId, dir: "east", stake: 0, stake_items: [swordB, potB] } });
const active = await visitUntil(visitId, (v) => v?.status === "active", 40000);
if (!active) { fail("the duel never activated"); process.exit(1); }
const stakes = {
  [A]: hostPot,
  [B]: minus(potTotals(active.staked_items), hostPot),
};
ok(`duel #${visitId} active, mode ${active.mode}; pot: ${A} ${describe(stakes[A])}, ` +
   `${B} ${describe(stakes[B])}`);

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
    const w = names[winner], l = names[loser];
    const problems = stakeTransferFailures({
      winner: w, loser: l, before: bagsBefore,
      after: { [w]: bagTotals(await player(w)), [l]: bagTotals(await player(l)) },
      loserStake: stakes[l], settledPot: v.staked_items,
    });
    for (const m of problems) fail(`stakes: ${m}`);
    if (!problems.length)
      ok(`stakes: ${w} won ${describe(stakes[l])} from ${l}, and the escrow is empty`);
  }
}

console.log(findings.length ? `\nFAIL (${findings.length})` : "\nPASS");
for (const f of findings) console.log(" - " + f);
process.exit(findings.length ? 1 : 0);
