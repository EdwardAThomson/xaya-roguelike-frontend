/**
 * Convergence test for the co-op runtime: two CoopRunners, each with its
 * own DungeonSession, joined only by an in-memory relay with random
 * delivery delays.  Both players press keys at random moments (some ahead
 * of their turn), the auto-wait fills in idle rounds, and at the end both
 * clients must hold the SAME merged log (same settle hash) and the same
 * final state.  Exercises the round structure, ahead-of-turn queuing, the
 * invalid-action substitution, and the reload path (a third runner joins
 * late and rebuilds everything from the relay history).
 *
 * Run:  npx tsc && node dist/net/coop_test.js
 */
import { DungeonSession, GameAction, PlayerSetup } from "../game/session.js";
import { settleLogHash, computeClaims } from "../game/settle.js";
import { CoopMessage, CoopRunner, CoopTransport } from "./coop.js";

/** Deterministic LCG so a failure reproduces. */
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

function setups(): PlayerSetup[] {
  const base = { level: 2, strength: 11, dexterity: 10, constitution: 12, intelligence: 10, equipAttack: 5, equipDefense: 2 };
  return [
    { name: "alice", stats: { ...base }, hp: 110, maxHp: 110, potions: [{ itemId: "health_potion", quantity: 2 }],
      inventory: [{ rowid: 1, itemId: "short_sword", slot: "weapon" }, { rowid: 2, itemId: "leather_armor", slot: "body" }] },
    { name: "bob", stats: { ...base }, hp: 110, maxHp: 110, potions: [{ itemId: "health_potion", quantity: 2 }],
      inventory: [{ rowid: 11, itemId: "short_sword", slot: "weapon" }, { rowid: 12, itemId: "leather_armor", slot: "body" }] },
  ];
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** A random plausible key press: mostly moves, sometimes pickup/wait/gate. */
function randomAction(rng: Lcg, s: DungeonSession, me: number): GameAction {
  const p = s.players[me];
  const r = rng.next();
  if (r < 0.06 && s.dungeon.gates.some(g => g.x === p.x && g.y === p.y)) return { type: "gate" };
  if (r < 0.12) return { type: "pickup" };
  if (r < 0.18) return { type: "wait" };
  if (r < 0.22) return { type: "use", itemId: "health_potion" };
  const [dx, dy] = DIRS[rng.int(DIRS.length)];
  return { type: "move", dx, dy };
}

async function runScenario(seed: number): Promise<void> {
  const rng = new Lcg(seed);
  const relay = new MemoryRelay(rng, 40);
  const names = ["alice", "bob"];
  const sessions = names.map(() => DungeonSession.createMulti("coop-runtime-" + seed, 2, setups()));
  const notes: string[][] = [[], []];
  const runners = names.map((_, i) => new CoopRunner({
    session: sessions[i], me: i, names, transport: relay.transport(names[i]),
    graceMs: 120, pollMs: 25, onChange: () => {}, onNote: t => notes[i].push(t),
  }));
  runners.forEach(r => r.start());

  // Both players mash keys at random intervals for a while, then walk to a
  // gate is not scripted: we just cap the run and settle whatever state
  // both reached (the invariant is agreement, not survival).
  const deadline = Date.now() + 2500;
  let presses = 0;
  while (Date.now() < deadline && !sessions.every(s => s.gameOver)) {
    for (let i = 0; i < 2; i++) {
      if (rng.next() < 0.5) {
        const s = sessions[i];
        if (!s.gameOver && s.isPlayerActive(i)) {
          if (runners[i].submitLocal(randomAction(rng, s, i))) presses++;
        }
      }
    }
    await sleep(rng.int(60));
  }
  // Stop pressing; let the relay drain and the auto-waits settle down.
  const quiet = Date.now() + 1200;
  while (Date.now() < quiet) await sleep(50);
  runners.forEach(r => r.stop());

  const hashes = sessions.map(s => settleLogHash(1, s.mergedLog));
  const turns = sessions.map(s => s.turnCount);
  const claims = sessions.map(s => JSON.stringify(computeClaims(s)));
  const ok = hashes[0] === hashes[1] && turns[0] === turns[1] && claims[0] === claims[1]
    && sessions[0].mergedLog.length > 0;
  console.log(`[coop-runtime] seed ${seed}: ${presses} presses, ${turns[0]}/${turns[1]} turns, ` +
    `${notes[0].length}/${notes[1].length} substitutions, hash ${hashes[0].slice(0, 12)}... ` +
    `${ok ? "✓ OK" : "✗ FAIL — clients diverged"}`);
  if (!ok) {
    console.log("  alice:", claims[0], "\n  bob:  ", claims[1]);
    throw new Error("co-op runtime diverged");
  }

  // Reload path: a fresh client for bob rebuilds the same state from the
  // relay history alone (no local state), as after a page refresh.
  const rebuilt = DungeonSession.createMulti("coop-runtime-" + seed, 2, setups());
  const late = new CoopRunner({
    session: rebuilt, me: 1, names, transport: relay.transport("bob"),
    graceMs: 100000, pollMs: 20, onChange: () => {},
  });
  late.start();
  const until = Date.now() + 800;
  while (Date.now() < until && rebuilt.turnCount < turns[1]) await sleep(20);
  late.stop();
  const rebuiltOk = settleLogHash(1, rebuilt.mergedLog) === hashes[1];
  console.log(`[coop-runtime] seed ${seed}: reload rebuilt ${rebuilt.turnCount} turns ` +
    `${rebuiltOk ? "✓ OK" : "✗ FAIL — relay history did not reproduce the run"}`);
  if (!rebuiltOk) throw new Error("co-op reload diverged");
}

async function main(): Promise<void> {
  for (const seed of [1, 2, 3]) await runScenario(seed);
}

main().catch(e => { console.error(e); throw e; });
