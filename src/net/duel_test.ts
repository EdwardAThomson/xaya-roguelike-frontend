/**
 * Convergence test for the duel runtime: two CoopRunners in duel mode, each
 * with its own DungeonSession, joined only by an in-memory relay with random
 * delivery delays.  Both players choose at random moments, the fixed tick
 * fills in rounds nobody chose in, and at the end both clients must hold the
 * SAME merged log (same settle hash), the same winner, and the same final
 * state.
 *
 * What this covers that the parity vectors cannot: the vectors drive a
 * SCRIPTED duel with pinned salts through the engine directly, so they say
 * nothing about whether two independent clients, each generating its own
 * secret salt and seeing the other's messages out of order and late, still
 * converge.  That is the runner's job (spec §2 and §2c) and this is where
 * it is checked.
 *
 * Run:  npx tsc && node dist/net/duel_test.js
 */
import { DungeonSession, GameAction, PlayerSetup } from "../game/session.js";
import { settleLogHash } from "../game/settle.js";
import { CoopMessage, CoopRunner, CoopTransport } from "./coop.js";

/** Deterministic LCG so a failure reproduces (the SALTS stay random). */
class Lcg {
  constructor(private s: number) {}
  next(): number { this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0; return this.s / 4294967296; }
  int(n: number): number { return Math.floor(this.next() * n); }
}

/** In-memory relay: a shared log with per-transport cursors and delays. */
class MemoryRelay {
  log: CoopMessage[] = [];
  constructor(private rng: Lcg, private maxDelayMs: number) {}
  transport(name: string): CoopTransport {
    let cursor = 0;
    const relay = this;
    return {
      async send(msg) {
        await sleep(relay.rng.int(relay.maxDelayMs));
        relay.log.push({ from: name, n: msg.n, action: msg.action });
      },
      async poll() {
        await sleep(relay.rng.int(relay.maxDelayMs));
        const out = relay.log.slice(cursor);
        cursor = relay.log.length;
        return out;
      },
    };
  }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

const VISIT_ID = 4242;

/** Two duellists who spawn one tile apart (same entry gate). */
function setups(): PlayerSetup[] {
  const base = {
    level: 3, strength: 13, dexterity: 11, constitution: 12,
    intelligence: 10, equipAttack: 5, equipDefense: 2,
  };
  return [
    { name: "alice", stats: { ...base }, hp: 120, maxHp: 120, entryDir: "south",
      potions: [{ itemId: "health_potion", quantity: 1 }],
      inventory: [{ rowid: 1, itemId: "short_sword", slot: "weapon" }] },
    { name: "bob", stats: { ...base }, hp: 120, maxHp: 120, entryDir: "south",
      potions: [{ itemId: "health_potion", quantity: 1 }],
      inventory: [{ rowid: 11, itemId: "short_sword", slot: "weapon" }] },
  ];
}

/** Step toward the opponent: adjacent means the move lands as an attack. */
function towardOpponent(s: DungeonSession, me: number): GameAction {
  const p = s.players[me];
  const o = s.players[1 - me];
  const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  const dx = sign(o.x - p.x);
  const dy = sign(o.y - p.y);
  if (dx === 0 && dy === 0) return { type: "wait" };
  return { type: "move", dx, dy };
}

async function runScenario(seed: number): Promise<void> {
  const rng = new Lcg(seed);
  const names = ["alice", "bob"];
  const relay = new MemoryRelay(rng, 12);
  const sessions = names.map(() =>
    DungeonSession.createDuel("duel-runtime-" + seed, 3, setups(), VISIT_ID));

  const runners = names.map((n, i) => new CoopRunner({
    session: sessions[i],
    me: i,
    names,
    transport: relay.transport(n),
    tickMs: 120,
    pollMs: 15,
    onChange: () => {},
  }));
  for (const r of runners) r.start();

  // Both players mostly attack, but each round either may decide to sit the
  // WHOLE round out, so the fixed tick has to commit a wait for them.  The
  // decision is per round and sticky: a dawdle that only delays by one loop
  // iteration would never reach the deadline, and the tick would go
  // untested while the test still claimed to cover it.
  let choices = 0;
  const dawdleUntil = [-1, -1];
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && !sessions.every(s => s.gameOver)) {
    for (let i = 0; i < 2; i++) {
      const r = runners[i];
      if (!r.myChoicePending) continue;
      const round = sessions[i].roundIndex;
      if (dawdleUntil[i] === round) continue;
      if (rng.next() < 0.25) { dawdleUntil[i] = round; continue; }
      if (r.submitLocal(towardOpponent(sessions[i], i))) choices++;
    }
    await sleep(8);
  }

  // Let the last round settle out.
  const quiet = Date.now() + 800;
  while (Date.now() < quiet) await sleep(20);
  for (const r of runners) r.stop();

  const hashes = sessions.map(s => settleLogHash(VISIT_ID, s.mergedLog));
  const rounds = sessions.map(s => s.roundIndex);
  const winners = sessions.map(s => s.duelWinner);
  const entries = sessions.map(s => s.mergedLog.length);

  // Rounds actually played, from the log: one commit per active
  // participant opens each round.
  const roundsPlayed = sessions[0].mergedLog.filter(
    la => la.action.type === "commit" && la.actor === 0).length;
  const ticked = roundsPlayed * 2 - choices;

  console.log(`[duel-runtime] seed ${seed}: ${choices} choices, ` +
              `${ticked} tick-waits, ${entries[0]}/${entries[1]} entries, ` +
              `round ${rounds[0]}/${rounds[1]}, ` +
              `winner ${winners[0]}/${winners[1]}, hash ${hashes[0].slice(0, 12)}...`);

  // The whole point of section 2c: a player who does not choose gets a wait
  // committed for them.  If this never fired the scenario is not covering
  // the tick and the assertions below prove less than they look like they do.
  if (ticked <= 0)
    throw new Error(`[duel-runtime] seed ${seed}: the commit tick never fired ` +
                    `(${choices} choices for ${roundsPlayed} rounds)`);

  if (hashes[0] !== hashes[1])
    throw new Error(`[duel-runtime] seed ${seed}: clients diverged\n  ${hashes[0]}\n  ${hashes[1]}`);
  if (winners[0] !== winners[1])
    throw new Error(`[duel-runtime] seed ${seed}: winners disagree ${winners[0]} vs ${winners[1]}`);
  for (let i = 0; i < 2; i++) {
    if (sessions[0].players[i].hp !== sessions[1].players[i].hp)
      throw new Error(`[duel-runtime] seed ${seed}: HP disagrees for p${i}`);
    if (sessions[0].players[i].pvpDamage !== sessions[1].players[i].pvpDamage)
      throw new Error(`[duel-runtime] seed ${seed}: pvp damage disagrees for p${i}`);
  }

  // The log both clients hold must replay to exactly the same place: this
  // is what the GSP will do at settlement, and the only thing that makes
  // the run bankable.
  const replay = DungeonSession.replayDuel(
    "duel-runtime-" + seed, 3, setups(), VISIT_ID, sessions[0].mergedLog);
  if (replay.mergedLog.length !== sessions[0].mergedLog.length)
    throw new Error(`[duel-runtime] seed ${seed}: replay stopped at ` +
                    `${replay.mergedLog.length}/${sessions[0].mergedLog.length}`);
  if (replay.duelWinner !== winners[0])
    throw new Error(`[duel-runtime] seed ${seed}: replay winner ${replay.duelWinner}`);
  console.log(`[duel-runtime] seed ${seed}: replay agrees ✓ OK`);

  // Every round in the log is well formed: commits, then reveals, then
  // actions.  A client that emitted them out of order would have been
  // rejected by the engine, but this pins the SHAPE independently.
  let i = 0;
  const log = sessions[0].mergedLog;
  while (i < log.length) {
    const commits = countRun(log, i, "commit");
    const reveals = countRun(log, i + commits, "reveal");
    if (commits === 0 || reveals !== commits)
      throw new Error(`[duel-runtime] seed ${seed}: malformed round at entry ${i} ` +
                      `(${commits} commits, ${reveals} reveals)`);
    i += commits + reveals;
    // Then up to `commits` ordinary actions (fewer if the duel ended).
    let acts = 0;
    while (i < log.length && log[i].action.type !== "commit" && acts < commits) { i++; acts++; }
  }
}

function countRun(log: { action: GameAction }[], from: number, type: string): number {
  let n = 0;
  while (from + n < log.length && log[from + n].action.type === type) n++;
  return n;
}

/**
 * A press per round must fight, and a press mid-round must not be lost.
 *
 * Two bugs live here, both of which a player felt as "I cannot hit him":
 *
 *  1. A press has to REACH the runner. main.ts refuses a key when
 *     `inputFull` says so and never calls submitLocal, and a duel reported
 *     full for most of every round, so a press landing mid-round was gone.
 *
 *  2. A press must be ONE round's choice. Repeating it as a standing order
 *     was worse than losing it: a player who pressed east once committed
 *     `move 1,0` for eleven straight rounds while their opponent circled
 *     and killed them, never landing a blow, with the client cheerfully
 *     reporting that they were acting.
 *
 * So: press toward the opponent once per round, through the same guard the
 * UI uses, and require real damage. Acting is not fighting.
 */
async function pressingEachRoundLandsBlows(): Promise<void> {
  const rng = new Lcg(99);
  const names = ["alice", "bob"];
  const relay = new MemoryRelay(rng, 12);
  const sessions = names.map(() =>
    DungeonSession.createDuel("duel-held-intent", 3, setups(), VISIT_ID));
  const runners = names.map((n, i) => new CoopRunner({
    session: sessions[i],
    me: i,
    names,
    transport: relay.transport(n),
    tickMs: 120,
    pollMs: 15,
    onChange: () => {},
  }));
  for (const r of runners) r.start();

  /** Exactly what main.ts does with a keypress, guard and all. */
  const press = (i: number, a: GameAction): boolean => {
    if (runners[i].inputFull) return false;
    return runners[i].submitLocal(a);
  };

  // alice presses once per round, always freshly aimed at bob. Crucially
  // she presses whether or not the window is open, which is what a person
  // does: a press that arrives mid-round must be held, not dropped.
  let presses = 0;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && !sessions.every(s => s.gameOver)) {
    if (runners[1].myChoicePending) press(1, towardOpponent(sessions[1], 1));
    if (!sessions[0].gameOver && press(0, towardOpponent(sessions[0], 0))) presses++;
    await sleep(40);
  }
  const quiet = Date.now() + 800;
  while (Date.now() < quiet) await sleep(20);
  for (const r of runners) r.stop();

  const mine = sessions[0].mergedLog.filter(e => e.actor === 0);
  const moves = mine.filter(e => e.action.type === "move").length;
  const waits = mine.filter(e => e.action.type === "wait").length;
  const dealt = sessions[0].players[0].pvpDamage;
  console.log(`[duel-input] ${presses} presses -> ${moves} moves, ${waits} ` +
              `tick-waits, ${dealt} damage over ${sessions[0].roundIndex} rounds`);
  if (moves === 0)
    throw new Error("[duel-input] no action of the player's own reached the log");
  if (waits > moves)
    throw new Error(`[duel-input] more tick-waits (${waits}) than the ` +
                    `player's own moves (${moves}): presses are being eaten`);
  if (dealt === 0)
    throw new Error("[duel-input] the player acted but dealt no damage: " +
                    "acting is not fighting");

  console.log("[duel-input] ✓ OK");
}

/**
 * One press is ONE round's choice, and must not repeat itself.
 *
 * Direction alone cannot show this: two duellists standing adjacent and
 * trading blows correctly aim the same way every round. So press exactly
 * once and then never again, and count. A standing order gave eleven
 * actions from one press and marched the player into a wall; a consumed
 * buffer gives one.
 */
async function onePressIsOneRound(): Promise<void> {
  const rng = new Lcg(7);
  const names = ["alice", "bob"];
  const relay = new MemoryRelay(rng, 12);
  const sessions = names.map(() =>
    DungeonSession.createDuel("duel-one-press", 3, setups(), VISIT_ID));
  const runners = names.map((n, i) => new CoopRunner({
    session: sessions[i],
    me: i,
    names,
    transport: relay.transport(n),
    tickMs: 120,
    pollMs: 15,
    onChange: () => {},
  }));
  for (const r of runners) r.start();

  const first = towardOpponent(sessions[0], 0);
  if (runners[0].inputFull || !runners[0].submitLocal(first))
    throw new Error("[duel-one-press] the UI path refused the first press");

  // bob keeps the rounds turning; alice never presses again.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !sessions.every(s => s.gameOver)) {
    if (runners[1].myChoicePending) runners[1].submitLocal(towardOpponent(sessions[1], 1));
    await sleep(8);
  }
  const quiet = Date.now() + 600;
  while (Date.now() < quiet) await sleep(20);
  for (const r of runners) r.stop();

  const mine = sessions[0].mergedLog.filter(e => e.actor === 0);
  const own = mine.filter(e => e.action.type === first.type).length;
  const waits = mine.filter(e => e.action.type === "wait").length;
  console.log(`[duel-one-press] 1 press -> ${own} own action(s), ${waits} ` +
              `tick-wait(s) over ${sessions[0].roundIndex} rounds`);
  if (own !== 1)
    throw new Error(`[duel-one-press] one press produced ${own} actions; a ` +
                    `choice is repeating into rounds the player never chose`);
  if (runners[0].heldIntent !== null)
    throw new Error("[duel-one-press] the buffer still holds the press after " +
                    "it was committed");
  console.log("[duel-one-press] ✓ OK");
}

/**
 * A player with only arrow keys must be able to fight back.
 *
 * Every other test here aims with towardOpponent, which returns a DIAGONAL
 * step, and so does the obvious greedy bot. Two diagonal fighters meet and
 * trade blows, which is why bot versus bot passed while a real player could
 * not land a single hit in four separate duels: the bot sat diagonally
 * adjacent and the player's arrow keys swung into empty floor every round.
 * Diagonals are Q/E/Z/C and nobody finds them mid-fight.
 *
 * So: alice may only move orthogonally, like the arrow keys and WASD. She
 * must still deal damage.
 */
async function arrowKeysCanFight(): Promise<void> {
  const rng = new Lcg(5);
  const names = ["alice", "bob"];
  const relay = new MemoryRelay(rng, 12);
  const sessions = names.map(() =>
    DungeonSession.createDuel("duel-orthogonal", 3, setups(), VISIT_ID));
  const runners = names.map((n, i) => new CoopRunner({
    session: sessions[i],
    me: i,
    names,
    transport: relay.transport(n),
    tickMs: 120,
    pollMs: 15,
    onChange: () => {},
  }));
  for (const r of runners) r.start();

  /** Orthogonal only: what an arrow key or WASD can express. */
  const orthogonalAt = (me: number): GameAction => {
    const p = sessions[me].players[me];
    const q = sessions[me].players[me === 0 ? 1 : 0];
    const dx = q.x - p.x, dy = q.y - p.y;
    if (dx === 0 && dy === 0) return { type: "wait" };
    if (Math.abs(dx) >= Math.abs(dy))
      return { type: "move", dx: Math.sign(dx), dy: 0 };
    return { type: "move", dx: 0, dy: Math.sign(dy) };
  };

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !sessions.every(s => s.gameOver)) {
    if (runners[1].myChoicePending) runners[1].submitLocal(orthogonalAt(1));
    if (!runners[0].inputFull && !sessions[0].gameOver)
      runners[0].submitLocal(orthogonalAt(0));
    await sleep(40);
  }
  const quiet = Date.now() + 800;
  while (Date.now() < quiet) await sleep(20);
  for (const r of runners) r.stop();

  const dealt = sessions[0].players[0].pvpDamage;
  const taken = sessions[0].players[1].pvpDamage;
  console.log(`[duel-orthogonal] arrow-key player dealt ${dealt}, took ${taken}, ` +
              `over ${sessions[0].roundIndex} rounds`);
  if (dealt === 0)
    throw new Error("[duel-orthogonal] a player restricted to arrow keys " +
                    "never landed a blow: the opponent is unreachable from " +
                    "an orthogonal keyboard");
  console.log("[duel-orthogonal] ✓ OK");
}

async function main(): Promise<void> {
  for (const seed of [1, 2, 3]) await runScenario(seed);
  console.log("[duel-runtime] ✓ OK");
  await pressingEachRoundLandsBlows();
  await onePressIsOneRound();
  await arrowKeysCanFight();
}

// An unhandled rejection makes `node dist/net/duel_test.js` exit non-zero,
// which is how the other suites here signal failure (no @types/node, so no
// process.exit).
main().catch(e => { console.error(String(e)); throw e; });
