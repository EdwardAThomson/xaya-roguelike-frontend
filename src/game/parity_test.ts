/**
 * Cross-language determinism parity check.
 *
 * Mirrors the C++ test `DungeonTests.CrossLanguageParity` in
 * xayaroguelike/tests/dungeon_tests.cpp.  Both build a canonical signature
 * of a constrained dungeon + entry-gate spawn and hash it with the shared
 * SHA-256 `HashSeed`/`hashSeedSync`.  If the TS and C++ dungeon generators
 * ever drift, the two baked constants diverge and one side fails — catching
 * a determinism break before it silently rejects channel settlements.
 *
 * Run:  npx tsc && node dist/game/parity_test.js
 */
import { hashSeedSync } from "./hash.js";
import { Dungeon, Gate, Tile, WIDTH, HEIGHT } from "./dungeon.js";
import { DungeonSession, GameAction, EntryInvItem, PlayerSetup,
         LoggedAction, duelCommitHash, duelCommitPreimage } from "./session.js";
import { PlayerStats } from "./combat.js";
import {
  canonicalActionLine, computeClaims, parseCanonicalLog, settleLogHash,
  splitPool, encodeCompactLog, decodeCompactLog, DUEL_XP_BASE,
} from "./settle.js";

/**
 * Canonical signature: depth, entry-gate spawn, gates (sorted by direction),
 * and the row-major tile grid.  MUST match the C++ DungeonSignature() byte
 * for byte.
 */
export function dungeonSignature(
  seed: string, depth: number, constraints: Gate[], entryDir: string,
): string {
  const d = Dungeon.generate(seed, depth, constraints);

  // Entry-gate spawn — mirrors DungeonGame::Create / DungeonSession.
  let sx = Math.floor(WIDTH / 2), sy = Math.floor(HEIGHT / 2);
  let spawned = false;
  if (entryDir) {
    const g = d.gates.find(gate => gate.direction === entryDir);
    if (g) {
      sx = g.x;
      sy = g.y;
      if (entryDir === "north") sy += 1;
      else if (entryDir === "south") sy -= 1;
      else if (entryDir === "east") sx -= 1;
      else if (entryDir === "west") sx += 1;
      spawned = true;
    }
  }
  if (!spawned && d.rooms.length > 0) {
    const r = d.rooms[0];
    sx = r.x + Math.floor(r.width / 2);
    sy = r.y + Math.floor(r.height / 2);
  }

  const gates = [...d.gates].sort((a, b) =>
    a.direction < b.direction ? -1 : a.direction > b.direction ? 1 : 0);

  let s = `depth=${depth};spawn=${sx},${sy};gates=`;
  for (const g of gates) s += `${g.direction}:${g.x},${g.y};`;
  s += ";tiles=";
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++)
      s += String(d.getTile(x, y));
  return s;
}

export function runParityTest(): boolean {
  // Fixed inputs shared with the C++ test: a segment whose WEST gate is
  // aligned to a neighbour at row 20, entered from the west.
  const constraints: Gate[] = [{ x: 0, y: 20, direction: "west" }];
  const got = hashSeedSync(dungeonSignature("paritytest", 3, constraints, "west"));
  const expected = 1455554007;
  const ok = got === expected;
  console.log(
    `[parity] dungeon hash: got ${got}, expected ${expected} ` +
    `${ok ? "✓ OK" : "✗ FAIL — C++/TS dungeon generation diverged"}`);
  return ok;
}

/**
 * Mid-run equip parity vector (see equip_spec.md "Parity test vector").
 * Constructs a run with a known settled inventory, replays a fixed action
 * sequence that equips/unequips gear mid-run, and prints the final outcome.
 * The C++ side (DungeonGame) replays the IDENTICAL vector; the two printed
 * lines must match byte-for-byte, or equip determinism has drifted.
 *
 * Fixed action sequence (pinned, both sides identical):
 *   equip rowid10 slot "weapon"; equip rowid11 slot "body";
 *   40x move (dx=0,dy=1); unequip rowid11; gate.
 */
export function runEquipParityVector(): void {
  const stats: PlayerStats = {
    level: 3,
    strength: 12,
    dexterity: 11,
    constitution: 10,
    intelligence: 10,
    equipAttack: 0,
    equipDefense: 0,
  };
  const entryInventory: EntryInvItem[] = [
    { rowid: 10, itemId: "short_sword",   slot: "bag" },
    { rowid: 11, itemId: "scale_mail",    slot: "bag" },
    { rowid: 12, itemId: "leather_armor", slot: "body" },
  ];

  const s = new DungeonSession(
    "parity-equip", 3, stats, /*hp=*/80, /*maxHp=*/100,
    /*startingPotions=*/[], /*constraints=*/[], /*entryDir=*/"south",
    entryInventory);

  // PINNED all-valid corridor walk (matches the C++ GSP ParityEquipVector).
  // Every move is a valid step in this layout, so no blocked-move stop occurs.
  const actions: GameAction[] = [
    { type: "equip", rowid: 10, slot: "weapon" },   // short_sword
    { type: "equip", rowid: 11, slot: "body" },     // scale_mail (+1 con), displaces rowid12
    { type: "move", dx: -1, dy: 0 },                // west out of the south-gate mouth
  ];
  for (let i = 0; i < 10; i++) actions.push({ type: "move", dx: 0, dy: -1 }); // north
  actions.push({ type: "unequip", rowid: 11 });     // scale_mail back to bag
  for (let i = 0; i < 10; i++) actions.push({ type: "move", dx: 0, dy: 1 });  // back south
  actions.push({ type: "move", dx: 1, dy: 0 });     // east to the mouth
  actions.push({ type: "move", dx: 0, dy: 1 });     // onto the south gate tile
  actions.push({ type: "gate" });

  // The GSP replay STOPS on the first false action (blocked move / invalid).
  // Mirror that here so the harness matches consensus, not a no-op-and-continue.
  for (const a of actions) if (!s.processAction(a)) break;

  console.log(
    `[equip-parity] survived=${s.survived ? 1 : 0}` +
    `,totalXp=${s.totalXp}` +
    `,totalGold=${s.totalGold}` +
    `,totalKills=${s.totalKills}` +
    `,playerHp=${s.playerHp}` +
    `,playerMaxHp=${s.playerMaxHp}` +
    `,exitGate=${s.exitGate}`);
}

/**
 * Multiplayer parity vectors (backend tests/coop_parity_tests.cpp,
 * SPEC_multiplayer_coop.md section 9).  Everything below is pinned on
 * both sides; the summary line must match byte-for-byte.
 */

/* Pinned 2-player co-op run (generated once by a scripted greedy policy on
   this engine; both sides now replay this exact log).  Seed
   "coop-parity-4", depth 2, no entry gates (so participant 1 takes the
   ring spawn).  Covers every action type: an equip, a wait, potion use,
   raced pickups, kills by both participants, and both exits.  */
const COOP_FIXTURE_SEED = "coop-parity-4";
const COOP_FIXTURE_DEPTH = 2;
const COOP_FIXTURE_VISIT_ID = 7;
const COOP_FIXTURE_LOG =
  "0 equip 3 weapon;1 wait;0 move 1 0;1 move 1 0;0 move 1 0;1 move 0 -1;" +
  "0 move 1 0;1 move 0 -1;0 move 1 -1;1 move 0 1;0 move 0 -1;1 move 1 1;" +
  "0 move 0 -1;1 move 1 1;0 move 0 -1;1 move 1 0;0 use health_potion;" +
  "1 move 1 0;0 move 0 -1;1 move 1 0;0 move 1 0;1 move 1 0;0 move 1 0;" +
  "1 move 1 0;0 move 1 0;1 move 1 0;0 move 1 0;1 pickup;0 move 1 0;" +
  "1 move 1 0;0 move 1 0;1 move 1 0;0 move 1 0;1 move 1 0;0 move 1 0;" +
  "1 move 1 0;0 move 1 0;1 move 1 0;0 move 1 0;1 move 1 0;0 move 1 0;" +
  "1 move 1 0;0 move 1 0;1 move 1 0;0 move 1 0;1 move 1 0;0 move 1 0;" +
  "1 move 1 0;0 move 1 1;1 move 1 0;0 move 1 -1;1 move 1 -1;0 move 1 -1;" +
  "1 move 1 -1;0 move 0 -1;1 move 1 -1;0 move 0 -1;1 move 0 -1;0 move 1 0;" +
  "1 move 1 -1;0 move 1 -1;1 move 1 -1;0 move 1 -1;1 move 0 -1;0 move 0 -1;" +
  "1 move 0 -1;0 move 1 -1;1 move 0 -1;0 move -1 -1;1 move 0 -1;" +
  "0 move -1 1;1 move 0 -1;0 move -1 1;1 move 0 -1;0 move -1 1;1 move 0 -1;" +
  "0 move -1 1;1 move 0 -1;0 move -1 1;1 move 0 -1;0 move -1 0;1 move 0 1;" +
  "0 move -1 1;1 move 0 1;0 move -1 1;1 move 0 1;0 move -1 1;1 move 1 1;" +
  "0 move 0 1;1 move 1 1;0 move 0 1;1 move 1 1;0 move 0 1;1 move 1 1;" +
  "0 move 0 1;1 move 1 0;0 move 0 1;1 move 1 0;0 move 0 1;1 move 1 0;" +
  "0 move 0 1;1 move 1 0;0 move 0 1;1 move 1 0;0 gate;1 move 1 0;" +
  "1 use health_potion;1 move 1 0;1 move -1 0;1 move -1 0;1 move -1 0;" +
  "1 move -1 0;1 move -1 0;1 move -1 0;1 move -1 0;1 move -1 0;1 move -1 0;" +
  "1 move -1 0;1 move -1 0;1 move -1 0;1 move -1 0;1 move -1 1;1 move -1 1;" +
  "1 move 0 1;1 move 0 1;1 move 0 1;1 move 0 1;1 move 0 1;1 move 0 1;" +
  "1 move 0 1;1 move 0 1;1 gate;";

function coopFixtureSetups(): PlayerSetup[] {
  return [
    {
      name: "alice",
      stats: { level: 2, strength: 10, dexterity: 11, constitution: 10,
               intelligence: 10, equipAttack: 5, equipDefense: 2 },
      hp: 90, maxHp: 100,
      potions: [{ itemId: "health_potion", quantity: 2 }],
      inventory: [
        { rowid: 1, itemId: "short_sword", slot: "weapon" },
        { rowid: 2, itemId: "leather_armor", slot: "body" },
        { rowid: 3, itemId: "iron_sword", slot: "bag" },
      ],
    },
    {
      name: "bob",
      stats: { level: 1, strength: 12, dexterity: 9, constitution: 11,
               intelligence: 9, equipAttack: 5, equipDefense: 2 },
      hp: 105, maxHp: 105,
      potions: [{ itemId: "health_potion", quantity: 3 }],
      inventory: [
        { rowid: 11, itemId: "short_sword", slot: "weapon" },
        { rowid: 12, itemId: "leather_armor", slot: "body" },
      ],
    },
  ];
}

export function runCoopParityVector(): boolean {
  const log = parseCanonicalLog(COOP_FIXTURE_LOG.replace(/;/g, "\n"));
  const s = DungeonSession.replayMulti(
    COOP_FIXTURE_SEED, COOP_FIXTURE_DEPTH, coopFixtureSetups(), log);

  // The whole log must replay (a prefix stop means the engines disagree
  // on validity somewhere).
  if (s.mergedLog.length !== log.length) {
    console.log(`[coop-parity] ✗ FAIL — replay stopped at action ` +
                `${s.mergedLog.length} of ${log.length}`);
    return false;
  }

  const claims = computeClaims(s);
  let line = "PARITY-COOP";
  for (let i = 0; i < s.playerCount; i++) {
    const p = s.players[i];
    const c = claims[i];
    line += ` p${i}[survived=${c.survived ? 1 : 0} xp=${c.xp} gold=${c.gold}` +
            ` kills=${c.kills} hp=${p.hp} maxHp=${p.maxHp} dmg=${p.damageDealt}` +
            ` exit=${p.exitGate}]`;
  }
  line += ` pools[xp=${s.xpPool} gold=${s.killGoldPool}]`;
  line += ` turns=${s.turnCount}`;
  line += ` hash=${settleLogHash(COOP_FIXTURE_VISIT_ID, s.mergedLog)}`;
  console.log(line);

  const expected =
    "PARITY-COOP" +
    " p0[survived=1 xp=44 gold=2 kills=3 hp=95 maxHp=100 dmg=106 exit=south]" +
    " p1[survived=1 xp=58 gold=6 kills=3 hp=102 maxHp=105 dmg=137 exit=south]" +
    " pools[xp=102 gold=4] turns=132" +
    " hash=3d92df40b001849551cc05dd5efc77905a9fe9dc59c92e46313e639425b6ab71";
  const ok = line === expected;
  console.log(`[coop-parity] ${ok ? "✓ OK" : "✗ FAIL — C++/TS co-op engine diverged"}`);
  return ok;
}

/* Abandonment vector (spec section 11): the first ABSENT_PREFIX actions of
   the co-op fixture, participant 1 marked absent, then participant 0's
   pinned solo continuation to a gate. */
const ABSENT_PREFIX = 60;
const ABSENT_SUFFIX_LOG =
  "0 move -1 0;0 move -1 1;0 move -1 0;0 move -1 1;0 move -1 1;0 move -1 1;" +
  "0 move 0 1;0 move 0 1;0 move 0 1;0 move 0 1;0 move 0 1;0 move 0 1;" +
  "0 move 0 1;0 move 0 1;0 gate;";

export function runAbsentParityVector(): boolean {
  const full = parseCanonicalLog(COOP_FIXTURE_LOG.replace(/;/g, "\n"));
  const suffix = parseCanonicalLog(ABSENT_SUFFIX_LOG.replace(/;/g, "\n"));
  const s = DungeonSession.replayMulti(
    COOP_FIXTURE_SEED, COOP_FIXTURE_DEPTH, coopFixtureSetups(), full.slice(0, ABSENT_PREFIX));
  if (s.mergedLog.length !== ABSENT_PREFIX) {
    console.log("[absent-parity] ✗ FAIL — prefix did not replay");
    return false;
  }
  s.markAbsent(1);
  for (const la of suffix) {
    if (!s.processActionBy(la.actor, la.action)) {
      console.log(`[absent-parity] ✗ FAIL — suffix action rejected: ${JSON.stringify(la)}`);
      return false;
    }
  }
  const claims = computeClaims(s);
  let line = "PARITY-COOP-ABSENT";
  for (let i = 0; i < s.playerCount; i++) {
    const p = s.players[i];
    const c = claims[i];
    line += ` p${i}[survived=${c.survived ? 1 : 0} absent=${p.absent ? 1 : 0} xp=${c.xp}` +
            ` gold=${c.gold} kills=${c.kills} hp=${p.hp} dmg=${p.damageDealt} exit=${p.exitGate}]`;
  }
  line += ` turns=${s.turnCount}`;
  line += ` hash=${settleLogHash(COOP_FIXTURE_VISIT_ID, s.mergedLog)}`;
  console.log(line);
  const expected =
    "PARITY-COOP-ABSENT" +
    " p0[survived=1 absent=0 xp=43 gold=0 kills=2 hp=95 dmg=101 exit=south]" +
    " p1[survived=0 absent=1 xp=0 gold=4 kills=1 hp=105 dmg=1 exit=]" +
    " turns=75 hash=fc4fa9c95fa60f93a14798ae4da7a618995deb07f6927ced08521bdcf998c602";
  const ok = line === expected && s.gameOver;
  console.log(`[absent-parity] ${ok ? "✓ OK" : "✗ FAIL — C++/TS absent-partner handling diverged"}`);
  return ok;
}

/* Pinned compact form of the co-op fixture (backend
   tests/compact_actions_tests.cpp): the encoder must emit exactly this. */
const COOP_FIXTURE_COMPACT =
  "0:e3,weapon;1:w;0:m6;1:m6;0:m6;1:m8;0:m6;1:m8;0:m9;1:m2;0:m8;1:m3;0:m8;" +
  "1:m3;0:m8;1:m6;0:uhealth_potion;1:m6;0:m8;1:m6;0:m6;1:m6;0:m6;1:m6;0:m6;" +
  "1:m6;0:m6;1:p;0:m6;1:m6;0:m6;1:m6;0:m6;1:m6;0:m6;1:m6;0:m6;1:m6;0:m6;" +
  "1:m6;0:m6;1:m6;0:m6;1:m6;0:m6;1:m6;0:m6;1:m6;0:m3;1:m6;0:m9;1:m9;0:m9;" +
  "1:m9;0:m8;1:m9;0:m8;1:m8;0:m6;1:m9;0:m9;1:m9;0:m9;1:m8;0:m8;1:m8;0:m9;" +
  "1:m8;0:m7;1:m8;0:m1;1:m8;0:m1;1:m8;0:m1;1:m8;0:m1;1:m8;0:m1;1:m8;0:m4;" +
  "1:m2;0:m1;1:m2;0:m1;1:m2;0:m1;1:m3;0:m2;1:m3;0:m2;1:m3;0:m2;1:m3;0:m2;" +
  "1:m6;0:m2;1:m6;0:m2;1:m6;0:m2;1:m6;0:m2;1:m6;0:g;1:m6;1:uhealth_potion;" +
  "1:m6;1:m4*13;1:m1*2;1:m2*8;1:g";

export function runCompactEncodingVector(): boolean {
  const log = parseCanonicalLog(COOP_FIXTURE_LOG.replace(/;/g, "\n"));
  const encoded = encodeCompactLog(log, true);
  const encodeOk = encoded === COOP_FIXTURE_COMPACT;
  let decodeOk = false;
  try {
    const decoded = decodeCompactLog(COOP_FIXTURE_COMPACT, true);
    decodeOk = decoded.length === log.length
      && settleLogHash(COOP_FIXTURE_VISIT_ID, decoded) === settleLogHash(COOP_FIXTURE_VISIT_ID, log);
  } catch (e) {
    console.log("[compact] decode threw: " + (e instanceof Error ? e.message : String(e)));
  }
  // Solo form round-trips too (no actor prefixes).
  const solo = log.map(la => la.action);
  let soloOk = false;
  try {
    const back = decodeCompactLog(encodeCompactLog(solo.map(a => ({ actor: 0, action: a })), false), false);
    soloOk = back.length === solo.length
      && settleLogHash(1, back) === settleLogHash(1, solo.map(a => ({ actor: 0, action: a })));
  } catch { /* reported below */ }
  const ok = encodeOk && decodeOk && soloOk;
  console.log(`[compact] ${encoded.length} bytes for ${log.length} actions ` +
    `${ok ? "✓ OK" : `✗ FAIL (encode=${encodeOk} decode=${decodeOk} solo=${soloOk})`}`);
  return ok;
}

/**
 * Same-gate and mixed-entry spawns (backend CoopParityTests
 * SameGateSpawnVector / MixedEntrySpawnVector).  Two participants who walk
 * in through the SAME gate cannot share the mouth tile: the first takes it
 * (solo behaviour), the second falls through to the ring scan.
 */
export function runSpawnParityVectors(): boolean {
  const gateSetups = coopFixtureSetups();
  gateSetups[0].entryDir = "south";
  gateSetups[1].entryDir = "south";
  const same = DungeonSession.createMulti("parity-equip", 3, gateSetups);
  const solo = DungeonSession.createMulti("parity-equip", 3, [gateSetups[0]]);

  const mixedSetups = coopFixtureSetups();
  mixedSetups[0].entryDir = "south";
  mixedSetups[1].entryDir = "";
  const mixed = DungeonSession.createMulti("parity-equip", 3, mixedSetups);

  const line1 = `PARITY-SAMEGATE p0[${same.players[0].x},${same.players[0].y}]` +
                ` p1[${same.players[1].x},${same.players[1].y}]`;
  const line2 = `PARITY-MIXEDGATE p0[${mixed.players[0].x},${mixed.players[0].y}]` +
                ` p1[${mixed.players[1].x},${mixed.players[1].y}]`;
  console.log(line1);
  console.log(line2);

  const soloSame = same.players[0].x === solo.players[0].x
    && same.players[0].y === solo.players[0].y;
  const ok = line1 === "PARITY-SAMEGATE p0[14,38] p1[13,37]"
    && line2 === "PARITY-MIXEDGATE p0[14,38] p1[65,29]"
    && soloSame;
  console.log(`[spawn-parity] ${ok ? "✓ OK" : "✗ FAIL — C++/TS spawn placement diverged"}`);
  return ok;
}

/**
 * Duel claim shape (frontend-only; the cross-language vectors cover the
 * engine).  A duel banks on the fight, not on reaching a gate, so the
 * winner claims survived with the pot and the XP bonus while never having
 * exited.  Getting this wrong does not diverge the engines, it just gets
 * every duel rejected at settlement with "claims duel= but the replay
 * says ...", which is exactly what shipped once.
 */
export function runDuelClaimVector(): boolean {
  const stats = {
    level: 3, strength: 10, dexterity: 10, constitution: 10,
    intelligence: 10, equipAttack: 5, equipDefense: 2,
  };
  const setups: PlayerSetup[] = [
    { name: "a", stats: { ...stats }, hp: 100, maxHp: 100, potions: [], inventory: [] },
    { name: "b", stats: { ...stats }, hp: 100, maxHp: 100, potions: [], inventory: [] },
  ];
  const s = DungeonSession.createDuel("duel-claims", 1, setups, 7);
  const salt = (i: number, r: number) =>
    (i.toString(16) + r.toString(16)).padStart(32, "0");

  // Walk them into each other until one falls: each takes the first step
  // of a shortest floor path to the other (they spawn eight steps apart,
  // pvp spec §2d, so a straight line can hit a wall), and stepping onto the
  // foe's tile is the attack.  Fixed salts, so the whole run is
  // reproducible.
  const stepToward = (i: number): GameAction => {
    const me = s.players[i], foe = s.players[1 - i];
    const prev = new Map<number, number>();
    const key = (x: number, y: number) => y * WIDTH + x;
    const queue: [number, number][] = [[foe.x, foe.y]];
    prev.set(key(foe.x, foe.y), -1);
    for (let h = 0; h < queue.length; h++) {
      const [x, y] = queue[h];
      if (Math.max(Math.abs(x - me.x), Math.abs(y - me.y)) === 1)
        return { type: "move", dx: x - me.x, dy: y - me.y };
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) continue;
          if (s.dungeon.getTile(nx, ny) === Tile.Wall || prev.has(key(nx, ny))) continue;
          prev.set(key(nx, ny), key(x, y));
          queue.push([nx, ny]);
        }
    }
    return { type: "wait" };
  };
  for (let round = 0; round < 400 && !s.gameOver; round++) {
    const r = s.roundIndex;
    const acts: GameAction[] = [0, 1].map(stepToward);
    for (const i of [0, 1])
      if (s.isPlayerActive(i))
        s.processActionBy(i, { type: "commit", hex: duelCommitHash(7, r, i, acts[i], salt(i, r)) });
    for (const i of [0, 1])
      if (s.isPlayerActive(i)) s.processActionBy(i, { type: "reveal", hex: salt(i, r) });
    for (const i of [0, 1])
      if (s.isPlayerActive(i)) s.processActionBy(i, acts[i]);
  }

  const POT = 20;
  const claims = computeClaims(s, POT);
  const w = s.duelWinner;
  const l = w === 0 ? 1 : 0;
  const problems: string[] = [];
  if (!s.gameOver || w < 0) problems.push("the duel never resolved");
  if (claims[w]?.duel !== "won") problems.push(`winner claims duel=${claims[w]?.duel}`);
  if (claims[l]?.duel !== "lost") problems.push(`loser claims duel=${claims[l]?.duel}`);
  // The winner is banked as survived WITHOUT having exited through a gate.
  if (claims[w]?.survived !== true) problems.push("winner does not claim survived");
  if (s.players[w]?.exited) problems.push("winner exited, so this vector proves nothing");
  if (claims[l]?.survived !== false) problems.push("loser claims survived");
  if (claims[w]?.gold !== s.players[w].totalGold + POT)
    problems.push(`winner gold ${claims[w]?.gold} excludes the pot`);
  if (claims[l]?.gold !== s.players[l].totalGold)
    problems.push(`loser gold ${claims[l]?.gold} is not just their pickups`);
  const expectXp = DUEL_XP_BASE * s.players[l].stats.level;
  if (claims[w]?.xp !== expectXp) problems.push(`winner xp ${claims[w]?.xp}, expected ${expectXp}`);
  if (claims[l]?.xp !== 0) problems.push(`loser xp ${claims[l]?.xp}, expected 0`);

  const ok = problems.length === 0;
  console.log(`[duel-claims] winner ${w}, pot ${POT}, xp ${claims[w]?.xp} ` +
    `${ok ? "✓ OK" : "✗ FAIL — " + problems.join("; ")}`);
  return ok;
}

export function runSettleHashVector(): boolean {
  // One entry of every action type, so the whole canonical encoding is
  // locked (pinned in coop_parity_tests.cpp as well).
  const text =
    "0 move 1 0\n1 move -1 -1\n0 pickup\n1 use health_potion\n" +
    "0 equip 5 weapon\n1 unequip 12\n0 wait\n1 gate\n0 gate\n";
  const log = parseCanonicalLog(text);
  let data = "rog-settle-v1\n42\n";
  for (const la of log) data += canonicalActionLine(la.actor, la.action);
  const encodingOk = data === "rog-settle-v1\n42\n" + text;

  const got = settleLogHash(42, log);
  const expected = "7ce422e908ecfe7bd587de2740aa91f94a8631ead9bd80f794166b0ad5267297";
  const gotEmpty = settleLogHash(42, []);
  const expectedEmpty = "892bdea5bc97abd2bc0d0b4991d445aaf42c6d5ee7e68fa572ec5e1ea3d81ffd";
  const ok = encodingOk && got === expected && gotEmpty === expectedEmpty;
  console.log(`[settle-hash] got ${got} ${ok ? "✓ OK" : "✗ FAIL — settle hash encoding diverged"}`);
  return ok;
}

export function runSplitPoolVectors(): boolean {
  // Mirrors the SplitPoolTests cases in the backend's moveprocessor_tests.
  const cases: [number, number[], number[]][] = [
    [100, [50, 50], [50, 50]],
    [100, [75, 25], [75, 25]],
    [100, [40, 0], [100, 0]],
    [7, [0, 3], [0, 7]],
    [10, [1, 2], [3, 7]],
    [3, [1, 1], [2, 1]],
    [100, [0, 0], [0, 0]],
    [0, [5, 3], [0, 0]],
  ];
  let ok = true;
  for (const [pool, damages, expected] of cases) {
    const got = splitPool(pool, damages);
    const same = got.length === expected.length && got.every((v, i) => v === expected[i]);
    if (!same) {
      console.log(`[split-pool] ✗ FAIL splitPool(${pool}, [${damages}]) = [${got}], expected [${expected}]`);
      ok = false;
    }
  }
  // Conservation: shares always sum to the pool when anyone dealt damage.
  const shares = splitPool(101, [7, 11, 3]);
  if (shares.reduce((a, b) => a + b, 0) !== 101) { console.log("[split-pool] ✗ FAIL conservation"); ok = false; }
  if (ok) console.log("[split-pool] ✓ OK");
  return ok;
}


/* ============================================================
 * Duel vectors (SPEC_multiplayer_pvp.md section 10).  The C++ twin is
 * tests/duel_parity_tests.cpp in the backend repo; every PARITY line below
 * must match its printed line byte for byte.
 *
 * The fixtures pin the SALTS and the ACTIONS; the commitments are DERIVED
 * through duelCommitHash, so the commitment encoding is covered too -- a
 * commitment built differently here produces different commit entries, a
 * different settle-log hash, and a failing line.
 * ============================================================ */

/* The duellists.  Deliberately unequal (level, stats, HP) so an asymmetry
   in either engine's stat handling shows up in the outcome. */
function duelFixtureSetups(): PlayerSetup[] {
  return [
    {
      name: "alice",
      stats: { level: 3, strength: 13, dexterity: 11, constitution: 10,
               intelligence: 10, equipAttack: 5, equipDefense: 2 },
      hp: 100, maxHp: 100,
      potions: [{ itemId: "health_potion", quantity: 1 }],
      inventory: [
        { rowid: 1, itemId: "short_sword", slot: "weapon" },
        { rowid: 2, itemId: "leather_armor", slot: "body" },
      ],
      entryDir: "south",
    },
    {
      name: "bob",
      stats: { level: 2, strength: 12, dexterity: 9, constitution: 11,
               intelligence: 9, equipAttack: 5, equipDefense: 2 },
      hp: 95, maxHp: 105,
      potions: [{ itemId: "health_potion", quantity: 1 }],
      inventory: [
        { rowid: 11, itemId: "short_sword", slot: "weapon" },
        { rowid: 12, itemId: "leather_armor", slot: "body" },
      ],
      entryDir: "south",
    },
  ];
}

const DUEL_FIXTURE_SEED = "duel-parity-1";
const DUEL_FIXTURE_DEPTH = 3;
const DUEL_FIXTURE_VISIT_ID = 11;

/* A fought-out duel.  Both walk in through the SAME gate, so they spawn
   DUEL_SPAWN_SPACING steps apart (pvp spec §2d): participant 0 on the gate
   mouth, participant 1 eight steps in.  The first six rounds walk them into
   contact, one directly above the other, and from then on they trade blows
   every round.  Generated once on the C++ side by a scripted
   approach-then-mutual-attack policy searched over salt nonces until the run
   covered every player-vs-player outcome the spec requires a vector for -- a
   hit, a miss, a dodge and a critical -- and ended in a death.  Fight round 3
   drinks participant 1's only potion; fight round 4 commits to drinking
   another it no longer holds, which the duel applies as a wait while the log
   keeps the action the commitment covers. */
const DUEL_APPROACH_ROUNDS = 6;

const DUEL_FIXTURE_ROUNDS: string[] = [
  "wait,fc5d7a839386676dd0c58055ece5208c|move 1 0,9654e83d8875fa311d18dbf8115b07e0",
  "wait,c323b541f00b5529a937ca6e7b5bfb53|move 1 0,a06788e181760df52fc1fc4291f705ef",
  "wait,4c2bd63f7be9768707b91079437508f4|move 1 0,6d9f6bf1d0ac322e2d38be59350a2879",
  "wait,e0491abff255bd0a042c5d1eef5d62ad|move 1 0,0146d92af24025c7271044eb1cc722c2",
  "wait,cefdcababe10e13b5ac69cccb0d41b51|move 1 1,f5b13083572cc50c9ef519d0b919b6fa",
  "move 0 -1,90bea0e3a280e9a5e3a3af00d9da04f9|move 0 1,2c3722144e0ca78bd16640dbf7748124",
  "move 0 -1,cd8fb474934abe696cfd9a2df81fb0f2|move 0 1,9c5685a8ac9746bdb40b434c1b70af38",
  "move 0 -1,ed2e07dbec1a3bbed0620a28de675198|move 0 1,3c110d1a041ba11d206aea77855edc3e",
  "move 0 -1,3b1989140a5e24eeaaf1eb4703bf8fb3|move 0 1,8fa56e0903b601c920d159afd405c8e0",
  "move 0 -1,93416a7965d501ac646f5b1ee5c07081|use health_potion,fc0a2d428db1037b4830479cde083109",
  "move 0 -1,f8748e80e29e70aa9969525487ecc2dd|use health_potion,5275e2da674cef9bb1cf25db4d21c22c",
  "move 0 -1,ed97cbb182f248ff0efdc714119063b0|move 0 1,c3b95a91bb371cdb20617e69f35d9e1e",
  "move 0 -1,67b30f9a2d20c6a798c16accaafe98e0|move 0 1,f2f5bed8c33465f1e17c729c333d7d78",
  "move 0 -1,83d8db1411753e20a459ceb58b4a430c|move 0 1,dfde49e71bb194ae75a5bfd89649a9d0",
  "move 0 -1,0572e2d77f3b5fa5516e15b2437e7381|move 0 1,b5f06366a1761206b24d6864644f0f17",
  "move 0 -1,d88d2dcd5562c859adb918017f601a95|move 0 1,c0db836e308c99b812677a0f372c1d54",
  "move 0 -1,7c449d071d5ad6c7c5178140d0bd8f37|move 0 1,80786f26f49fc31a1a731b8cb0e168cf",
  "move 0 -1,a0234ce30f044a1e1d2f1e5ea26a50e3|move 0 1,17f6bdbb6c24ab8225ac7f171844f8fe",
  "move 0 -1,8eb0a3c974631890b9250440b9a2cbd6|move 0 1,63c1c7106b6f2b0ea49f8c86ba785d6d",
  "move 0 -1,9b996b762013fbc1a3e3a7f900427744|move 0 1,214cdb680040cac8f6f400c8cf1f070a",
  "move 0 -1,9d8114f58bae15a65e7160949b2c081c|move 0 1,dc830de521263594af9daf59c5bea594",
];

const DUEL_CONCEDE_ROUNDS: string[] = [
  "move 0 1,00112233445566778899aabbccddeeff|move 0 1,ffeeddccbbaa99887766554433221100",
  "gate,0123456789abcdef0123456789abcdef|wait,fedcba9876543210fedcba9876543210",
];

/** One participant's choice for a round: what they do and the salt. */
interface DuelChoice { action: GameAction; salt: string; }

/** Parses "move 0 -1,<salt>|use health_potion,<salt>" into one round. */
function parseDuelRound(row: string): DuelChoice[] {
  return row.split("|").filter(e => e !== "").map(entry => {
    const comma = entry.lastIndexOf(",");
    if (comma < 0) throw new Error("bad duel fixture row entry: " + entry);
    const body = entry.slice(0, comma);
    const parts = body.split(" ");
    let action: GameAction;
    switch (parts[0]) {
      case "move":    action = { type: "move", dx: Number(parts[1]), dy: Number(parts[2]) }; break;
      case "travel":  action = { type: "travel", dx: Number(parts[1]), dy: Number(parts[2]) }; break;
      case "pickup":  action = { type: "pickup" }; break;
      case "use":     action = { type: "use", itemId: parts[1] }; break;
      case "gate":    action = { type: "gate" }; break;
      case "wait":    action = { type: "wait" }; break;
      case "equip":   action = { type: "equip", rowid: Number(parts[1]), slot: parts[2] }; break;
      case "unequip": action = { type: "unequip", rowid: Number(parts[1]) }; break;
      default: throw new Error("bad canonical action body: " + body);
    }
    return { action, salt: entry.slice(comma + 1) };
  });
}

/**
 * Asserts the round protocol is where it should be.  Reads through a
 * widened local because TypeScript narrows `s.phase` to a literal at the
 * first check and cannot see processActionBy move it on.
 */
function expectPhase(s: DungeonSession, want: string, what: string): void {
  const got: string = s.phase;
  if (got !== want) throw new Error(`${what}: phase is ${got}, expected ${want}`);
}

/**
 * Drives a duel through the pinned rounds exactly as a client would: every
 * active participant commits, then every one reveals, then every one acts.
 * Returns the merged log it produced -- commit and reveal entries included.
 * Mirrors DriveDuel in the C++ vectors.
 */
function driveDuel(s: DungeonSession, visitId: number,
                   rounds: DuelChoice[][]): LoggedAction[] {
  const log: LoggedAction[] = [];
  for (const round of rounds) {
    if (s.gameOver) break;

    const t = s.roundIndex;
    const actors: number[] = [];
    for (let i = 0; i < s.players.length; i++)
      if (s.isPlayerActive(i)) actors.push(i);
    if (round.length !== actors.length)
      throw new Error(`fixture round ${t} does not cover the active set`);

    expectPhase(s, "commit", `round ${t}`);
    for (let k = 0; k < actors.length; k++) {
      const a: GameAction = {
        type: "commit",
        hex: duelCommitHash(visitId, t, actors[k], round[k].action, round[k].salt),
      };
      if (!s.processActionBy(actors[k], a)) throw new Error(`commit rejected in round ${t}`);
      log.push({ actor: actors[k], action: a });
    }

    expectPhase(s, "reveal", `round ${t} after commits`);
    for (let k = 0; k < actors.length; k++) {
      const a: GameAction = { type: "reveal", hex: round[k].salt };
      if (!s.processActionBy(actors[k], a)) throw new Error(`reveal rejected in round ${t}`);
      log.push({ actor: actors[k], action: a });
    }

    expectPhase(s, "act", `round ${t} after reveals`);
    for (let k = 0; k < actors.length; k++) {
      // A participant killed earlier in this round's application takes no
      // action, and neither does anyone once the duel is decided.
      if (s.gameOver || !s.isPlayerActive(actors[k])) continue;
      if (!s.processActionBy(actors[k], round[k].action))
        throw new Error(`action rejected in round ${t}`);
      log.push({ actor: actors[k], action: round[k].action });
    }
  }
  return log;
}

/** The canonical summary line, diffed byte-for-byte against the C++ side. */
function duelParityLine(tag: string, s: DungeonSession,
                        log: LoggedAction[]): string {
  const damages = s.players.map(p => p.damageDealt);
  const xpShares = splitPool(s.xpPool, damages);
  const goldShares = splitPool(s.killGoldPool, damages);

  let line = tag;
  for (let i = 0; i < s.players.length; i++) {
    const p = s.players[i];
    line += ` p${i}[dead=${p.dead ? 1 : 0} exited=${p.exited ? 1 : 0}` +
            ` absent=${p.absent ? 1 : 0} xp=${xpShares[i]}` +
            ` gold=${p.totalGold + goldShares[i]} kills=${p.totalKills}` +
            ` hp=${p.hp} dmg=${p.damageDealt} pvp=${p.pvpDamage}` +
            ` death=${p.deathSeq} exit=${p.exitGate}]`;
  }
  line += ` winner=${s.duelWinner}`;
  line += ` rounds=${s.roundIndex}`;
  line += ` entries=${log.length}`;
  line += ` hash=${settleLogHash(DUEL_FIXTURE_VISIT_ID, log)}`;
  return line;
}

export function runDuelParityVector(): boolean {
  const rounds = DUEL_FIXTURE_ROUNDS.map(parseDuelRound);
  const s = DungeonSession.createDuel(
    DUEL_FIXTURE_SEED, DUEL_FIXTURE_DEPTH, duelFixtureSetups(),
    DUEL_FIXTURE_VISIT_ID);

  // Both walk in through the south gate.  Participant 0 takes the mouth,
  // participant 1 is placed eight walking steps further in (pvp spec §2d):
  // a duel no longer starts in contact.
  let ok = s.players[0].x === 56 && s.players[0].y === 38
        && s.players[1].x === 51 && s.players[1].y === 34;
  if (!ok) console.log(`[duel-parity] ✗ FAIL spawn ${s.players[0].x},${s.players[0].y} ` +
                       `${s.players[1].x},${s.players[1].y}`);

  const log = driveDuel(s, DUEL_FIXTURE_VISIT_ID, rounds);
  if (!s.gameOver) { console.log("[duel-parity] ✗ FAIL duel did not finish"); ok = false; }

  // The settlement path replays the log alone; it must land on exactly the
  // same state the live run did.
  const replay = DungeonSession.replayDuel(
    DUEL_FIXTURE_SEED, DUEL_FIXTURE_DEPTH, duelFixtureSetups(),
    DUEL_FIXTURE_VISIT_ID, log);
  if (replay.mergedLog.length !== log.length) {
    console.log("[duel-parity] ✗ FAIL replay stopped early");
    ok = false;
  }

  const line = duelParityLine("PARITY-DUEL", s, log);
  console.log(line);
  if (duelParityLine("PARITY-DUEL", replay, log) !== line) {
    console.log("[duel-parity] ✗ FAIL live run and replay disagree");
    ok = false;
  }

  const expected =
    "PARITY-DUEL" +
    " p0[dead=0 exited=0 absent=0 xp=0 gold=0 kills=0 hp=6 dmg=0" +
    " pvp=130 death=0 exit=]" +
    " p1[dead=1 exited=0 absent=0 xp=0 gold=0 kills=0 hp=0 dmg=0" +
    " pvp=94 death=1 exit=]" +
    " winner=0 rounds=20 entries=125" +
    " hash=7f48c5429e10b8a85bd241fcfec80fbb456026ab0fa94eb4f5bde495b099208c";
  if (line !== expected) ok = false;
  console.log(`[duel-parity] ${ok ? "✓ OK" : "✗ FAIL — C++/TS duel engine diverged"}`);
  return ok;
}

export function runDuelConcessionVector(): boolean {
  const rounds = DUEL_CONCEDE_ROUNDS.map(parseDuelRound);
  const s = DungeonSession.createDuel(
    DUEL_FIXTURE_SEED, DUEL_FIXTURE_DEPTH, duelFixtureSetups(),
    DUEL_FIXTURE_VISIT_ID);
  const log = driveDuel(s, DUEL_FIXTURE_VISIT_ID, rounds);

  // The conceder walked out through a gate, so `exited` is true -- and the
  // duel is still lost.  Settlement banks them as not survived, which is why
  // the winner is read from duelWinner and never from `exited`.
  let ok = s.players[0].exited && s.players[0].exitGate === "south"
        && s.duelWinner === 1 && s.gameOver && log.length === 11;

  const line = duelParityLine("PARITY-DUEL-CONCEDE", s, log);
  console.log(line);
  const expected =
    "PARITY-DUEL-CONCEDE" +
    " p0[dead=0 exited=1 absent=0 xp=0 gold=0 kills=0 hp=100 dmg=0" +
    " pvp=0 death=0 exit=south]" +
    " p1[dead=0 exited=0 absent=0 xp=0 gold=0 kills=0 hp=95 dmg=0" +
    " pvp=0 death=0 exit=]" +
    " winner=1 rounds=1 entries=11" +
    " hash=067c1503278ac61ed7a14bceb315bc65440a4e176a361cecf0e70a4188efaaf2";
  if (line !== expected) ok = false;
  console.log(`[duel-concede] ${ok ? "✓ OK" : "✗ FAIL — concession diverged"}`);
  return ok;
}

/* Refusal to reveal (spec section 7).  A duellist who dislikes the round it
   can already see can only stall, and stalling is indistinguishable from
   vanishing: the opponent settles from the last checkpoint with the staller
   marked absent, and an absent duellist loses.  The unrevealed round is
   simply not in the settled log, which is why the prefix ends on a round
   boundary. */
const STALL_PREFIX_ROUNDS = DUEL_APPROACH_ROUNDS + 5;

export function runDuelStallVector(): boolean {
  const rounds = DUEL_FIXTURE_ROUNDS.slice(0, STALL_PREFIX_ROUNDS)
                                    .map(parseDuelRound);
  const s = DungeonSession.createDuel(
    DUEL_FIXTURE_SEED, DUEL_FIXTURE_DEPTH, duelFixtureSetups(),
    DUEL_FIXTURE_VISIT_ID);
  const log = driveDuel(s, DUEL_FIXTURE_VISIT_ID, rounds);

  const stalledPhase: string = s.phase;
  let ok = !s.gameOver && s.duelWinner === -1 && stalledPhase === "commit";

  // Participant 1 stops revealing; participant 0 settles past the window.
  s.markAbsent(1);
  if (!s.gameOver || s.duelWinner !== 0) ok = false;

  const line = duelParityLine("PARITY-DUEL-STALL", s, log);
  console.log(line);
  const expected =
    "PARITY-DUEL-STALL" +
    " p0[dead=0 exited=0 absent=0 xp=0 gold=0 kills=0 hp=68 dmg=0" +
    " pvp=40 death=0 exit=]" +
    " p1[dead=0 exited=0 absent=1 xp=0 gold=0 kills=0 hp=90 dmg=0" +
    " pvp=32 death=0 exit=]" +
    " winner=0 rounds=11 entries=66" +
    " hash=29c70ce3a9035bc01dd6875f89a6c22415cd8011fe01df9c9585a359da12dce1";
  if (line !== expected) ok = false;
  console.log(`[duel-stall] ${ok ? "✓ OK" : "✗ FAIL — abandonment diverged"}`);
  return ok;
}

/**
 * The commitment preimage, pinned literally.  Every other duel vector
 * depends on this string, so pinning it here makes a cross-language
 * mismatch report itself directly instead of as a settle-hash difference.
 */
export function runDuelCommitHashVector(): boolean {
  const move: GameAction = { type: "move", dx: 1, dy: -1 };
  const salt = "00112233445566778899aabbccddeeff";

  const preimage = duelCommitPreimage(11, 7, 1, move, salt);
  let ok = preimage ===
    "rog-duel-commit-v1\n11\n7\n1\nmove 1 -1\n00112233445566778899aabbccddeeff";
  if (!ok) console.log("[duel-commit] ✗ FAIL preimage: " + JSON.stringify(preimage));

  const h = duelCommitHash(11, 7, 1, move, salt);
  console.log(`PARITY-DUEL-COMMIT ${h}`);
  if (h !== "08b987326245a8e68dd716b02f79a801812cc7db9a7069b0b835001b07f445f3") ok = false;
  console.log(`[duel-commit] ${ok ? "✓ OK" : "✗ FAIL — commitment encoding diverged"}`);
  return ok;
}

/**
 * The settle-log encoding with the two duel entry kinds in it (spec
 * section 6), and the compact codes c<h> / r<s>.
 */
export function runDuelEntryEncodingVectors(): boolean {
  const commit: GameAction = { type: "commit", hex: "a".repeat(64) };
  const reveal: GameAction = { type: "reveal", hex: "b".repeat(32) };
  const move: GameAction = { type: "move", dx: 0, dy: 1 };
  const wait: GameAction = { type: "wait" };

  const log: LoggedAction[] = [
    { actor: 0, action: commit }, { actor: 1, action: commit },
    { actor: 0, action: reveal }, { actor: 1, action: reveal },
    { actor: 0, action: move },   { actor: 1, action: wait },
  ];

  let ok = canonicalActionLine(0, commit) === `0 commit ${"a".repeat(64)}\n`
        && canonicalActionLine(1, reveal) === `1 reveal ${"b".repeat(32)}\n`;
  if (!ok) console.log("[duel-entries] ✗ FAIL canonical line encoding");

  const h = settleLogHash(11, log);
  console.log(`PARITY-DUEL-SETTLEHASH ${h}`);
  if (h !== "6756cb0830f2e74460a9459d09acda930a685469903aaed3ac384c3b9c6b247f") ok = false;

  // The compact form expands before anything else sees the log, so it
  // hashes exactly as the verbose form does.
  const compact = encodeCompactLog(log, true);
  const round = decodeCompactLog(compact, true);
  if (settleLogHash(11, round) !== h) {
    console.log("[duel-entries] ✗ FAIL compact round-trip: " + compact);
    ok = false;
  }

  console.log(`[duel-entries] ${ok ? "✓ OK" : "✗ FAIL — duel entry encoding diverged"}`);
  return ok;
}

/**
 * Duel spawn spacing (pvp spec §2d), pinned on its own so a mismatch in the
 * breadth-first placement reports itself directly rather than as a
 * settle-hash difference.  Three participants through one gate land 0, 8
 * and 16 walking steps in.
 */
export function runDuelSpawnVector(): boolean {
  const setups = duelFixtureSetups();
  setups.push({ ...setups[1] });
  const s = DungeonSession.createDuel(
    DUEL_FIXTURE_SEED, DUEL_FIXTURE_DEPTH, setups, DUEL_FIXTURE_VISIT_ID);
  const pos = s.players.map((p, i) => `p${i}[${p.x},${p.y}]`).join(" ");
  const line = `PARITY-DUEL-SPAWN ${pos} monsters=${s.monsters.length}`;
  console.log(line);
  const ok = line === "PARITY-DUEL-SPAWN p0[56,38] p1[51,34] p2[43,34] monsters=13";
  console.log(`[duel-spawn] ${ok ? "✓ OK" : "✗ FAIL — duel spawn spacing diverged"}`);
  return ok;
}

/* Closing the gap with travel (pvp spec §2e).  Participant 1 walks east
   along its corridor and stops the moment participant 0 is in view, five
   steps in rather than eight; participant 0 then walks up its own corridor
   one tile per round, because its opponent never leaves view.  In round 3
   participant 1 commits to travelling into a tile participant 0 takes first,
   which the duel applies as a wait (travel never attacks), and then they
   fight with plain moves. */
const DUEL_TRAVEL_ROUNDS: string[] = [
  "wait,00000000000000000000000000000001|travel 1 0,10000000000000000000000000000001",
  "travel 0 -1,00000000000000000000000000000002|wait,10000000000000000000000000000002",
  "travel 0 -1,00000000000000000000000000000003|wait,10000000000000000000000000000003",
  "travel 0 -1,00000000000000000000000000000004|travel 0 1,10000000000000000000000000000004",
  "move 0 -1,00000000000000000000000000000005|move 0 1,10000000000000000000000000000005",
  "move 0 -1,00000000000000000000000000000006|move 0 1,10000000000000000000000000000006",
];

export function runDuelTravelVector(): boolean {
  const s = DungeonSession.createDuel(
    DUEL_FIXTURE_SEED, DUEL_FIXTURE_DEPTH, duelFixtureSetups(),
    DUEL_FIXTURE_VISIT_ID);
  const log: LoggedAction[] = [];
  let stops = "";
  for (const row of DUEL_TRAVEL_ROUNDS) {
    log.push(...driveDuel(s, DUEL_FIXTURE_VISIT_ID, [parseDuelRound(row)]));
    stops += ` ${s.players[0].x},${s.players[0].y}/${s.players[1].x},${s.players[1].y}`;
  }

  let ok = true;
  const replay = DungeonSession.replayDuel(
    DUEL_FIXTURE_SEED, DUEL_FIXTURE_DEPTH, duelFixtureSetups(),
    DUEL_FIXTURE_VISIT_ID, log);
  if (replay.mergedLog.length !== log.length
      || duelParityLine("", replay, log) !== duelParityLine("", s, log)) {
    console.log("[duel-travel] ✗ FAIL live run and replay disagree");
    ok = false;
  }

  const line = duelParityLine("PARITY-DUEL-TRAVEL" + stops, s, log);
  console.log(line);
  const expected =
    "PARITY-DUEL-TRAVEL 56,38/56,34 56,37/56,34 56,36/56,34" +
    " 56,35/56,34 56,35/56,34 56,35/56,34" +
    " p0[dead=0 exited=0 absent=0 xp=0 gold=0 kills=0 hp=79 dmg=0" +
    " pvp=11 death=0 exit=]" +
    " p1[dead=0 exited=0 absent=0 xp=0 gold=0 kills=0 hp=84 dmg=0" +
    " pvp=21 death=0 exit=]" +
    " winner=-1 rounds=6 entries=36" +
    " hash=3e90e1a28d025a2c6966a856468c510ee6e9d76a4e2fd065233874824ce26535";
  if (line !== expected) ok = false;
  console.log(`[duel-travel] ${ok ? "✓ OK" : "✗ FAIL — duel travel diverged"}`);
  return ok;
}

/* ============================================================
 * Travel vectors (pvp spec §2e).  The C++ twin is tests/travel_tests.cpp
 * in the backend repo.  Each line lists where the player stood after every
 * action, so a disagreement says which stop rule the engines read
 * differently, then the outcome and the log's consent hash.
 * ============================================================ */

const TRAVEL_FIXTURE_STATS: PlayerStats = {
  level: 3, strength: 12, dexterity: 11, constitution: 10, intelligence: 10,
  equipAttack: 0, equipDefense: 0,
};

function soloTravelLine(tag: string, seed: string, depth: number,
                        entryDir: string, actions: GameAction[]): string | null {
  const s = new DungeonSession(seed, depth, TRAVEL_FIXTURE_STATS, 80, 100,
                               [], [], entryDir);
  let stops = "";
  const log: LoggedAction[] = [];
  for (const a of actions) {
    if (!s.processAction(a)) {
      console.log(`[${tag}] ✗ FAIL action ${log.length} rejected`);
      return null;
    }
    log.push({ actor: 0, action: a });
    stops += ` ${s.playerX},${s.playerY}`;
  }
  return `${tag}${stops} hp=${s.playerHp} xp=${s.totalXp}` +
         ` gold=${s.totalGold} kills=${s.totalKills} turns=${s.turnCount}` +
         ` hash=${settleLogHash(0, log)}`;
}

export function runTravelVectors(): boolean {
  const t = (dx: number, dy: number): GameAction => ({ type: "travel", dx, dy });
  const m = (dx: number, dy: number): GameAction => ({ type: "move", dx, dy });

  const a = soloTravelLine("PARITY-TRAVEL", "parity-equip", 3, "south",
    [t(-1, -1), t(0, -1), t(0, -1), t(0, -1), t(1, 0),
     m(1, 0), m(1, 0), m(1, 0), m(1, 0), t(-1, 0)]);
  console.log(a);
  const b = soloTravelLine("PARITY-TRAVEL-ITEM", "travel-36", 2, "south",
    [t(0, -1), { type: "pickup" }, t(0, -1)]);
  console.log(b);

  let ok = a ===
    "PARITY-TRAVEL 13,37 13,29 13,21 13,17 14,17 14,17 14,17" +
    " 14,17 14,17 13,17 hp=44 xp=0 gold=0 kills=0 turns=10" +
    " hash=9b8c4c22bb48ec923c1b9230e71e17107d9bb706c72e17013552466e2b22a8dc"
    && b ===
    "PARITY-TRAVEL-ITEM 42,31 42,31 42,29 hp=80 xp=0 gold=0 kills=0" +
    " turns=3 hash=a5721c8f8748755a20a32864732194e4bef0340ba1e39dfe26147094f90154c6";

  // Encodings: canonical body and the compact t<numpad> code, which must
  // round-trip and hash like the verbose form.
  if (canonicalActionLine(1, t(0, -1)) !== "1 travel 0 -1\n") ok = false;
  const travelLog: LoggedAction[] = [
    { actor: 0, action: t(-1, -1) }, { actor: 0, action: t(1, 1) },
    { actor: 0, action: t(1, 1) },
  ];
  const compact = encodeCompactLog(travelLog, false);
  if (compact !== "t7;t3*2") { console.log("[travel] ✗ FAIL compact: " + compact); ok = false; }
  if (settleLogHash(3, decodeCompactLog(compact, false)) !== settleLogHash(3, travelLog))
    ok = false;

  console.log(`[travel] ${ok ? "✓ OK" : "✗ FAIL — travel diverged"}`);
  return ok;
}

const results = [
  runParityTest(),
  runSettleHashVector(),
  runSplitPoolVectors(),
  runCoopParityVector(),
  runAbsentParityVector(),
  runCompactEncodingVector(),
  runSpawnParityVectors(),
  runDuelClaimVector(),
  runDuelParityVector(),
  runDuelSpawnVector(),
  runDuelTravelVector(),
  runTravelVectors(),
  runDuelConcessionVector(),
  runDuelStallVector(),
  runDuelCommitHashVector(),
  runDuelEntryEncodingVectors(),
];
runEquipParityVector();
// A thrown error makes `node dist/game/parity_test.js` exit non-zero.
if (results.some(r => !r)) throw new Error("parity vectors FAILED");
