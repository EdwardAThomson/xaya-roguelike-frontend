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

async function main(): Promise<void> {
  for (const seed of [1, 2, 3]) await runScenario(seed);
  console.log("[duel-runtime] ✓ OK");
}

// An unhandled rejection makes `node dist/net/duel_test.js` exit non-zero,
// which is how the other suites here signal failure (no @types/node, so no
// process.exit).
main().catch(e => { console.error(String(e)); throw e; });
