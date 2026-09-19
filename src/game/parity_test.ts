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
import { Dungeon, Gate, WIDTH, HEIGHT } from "./dungeon.js";
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

  // Walk them into each other until one falls.  Fixed salts, so the whole
  // run is reproducible.
  for (let round = 0; round < 400 && !s.gameOver; round++) {
    const r = s.roundIndex;
    const acts: GameAction[] = [0, 1].map(i => {
      const me = s.players[i], foe = s.players[1 - i];
      const dx = Math.sign(foe.x - me.x), dy = Math.sign(foe.y - me.y);
      return (dx || dy) ? { type: "move", dx, dy } : { type: "wait" };
    });
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

/* A fought-out duel: both walk in through the SAME gate, so they spawn one
   tile apart and trade blows every round.  Generated once on the C++ side by
   a scripted mutual-attack policy searched over salt nonces until the run
   covered every player-vs-player outcome the spec requires a vector for -- a
   hit, a miss, a dodge and a critical -- and ended in a death.  Round 3
   drinks participant 1's only potion; round 4 commits to drinking another it
   no longer holds, which the duel applies as a wait while the log keeps the
   action the commitment covers. */
const DUEL_FIXTURE_ROUNDS: string[] = [
  "move 0 -1,46fe29bd55091bac1f585e9361040b60|move 0 1,505b34f6f400bb66c1e6575e3381ae98",
  "move 0 -1,24a4f60012bc28931beaf295e8afc0d5|move 0 1,f30ac68cf470f7aa149551476f12fe59",
  "move 0 -1,b6fb3ceade09780b8cbe23823372c8da|move 0 1,4828070ebb765574dc2421c459fbfee3",
  "move 0 -1,d1be09e4055c76bf0f0c62408908a51e|use health_potion,2d75ca6c55176aaf48d360498dc64c22",
  "move 0 -1,2a09226e39f3009bb3f3a3cede8c5d76|use health_potion,144f587a3222c320763b64abdada5753",
  "move 0 -1,c56982aa6abb747bc31a9952393698fc|move 0 1,e02ce7a7cc372690d870c5429abc8db4",
  "move 0 -1,1900b6e92fb00dee570004971afa8eba|move 0 1,28426d0d232c3f62d536cc7e79f6c1e2",
  "move 0 -1,417bd4cd0528ae7ac0b085aaf9b22feb|move 0 1,ddc0231256211c53de48480cf21e0b0d",
  "move 0 -1,1a24b03a4ae3f9e69c3c21e5436c89b0|move 0 1,62430b8ec12b2c2c7b8cbb154cd294aa",
  "move 0 -1,8a962e81c7ee23d1321eb8abe87f0fee|move 0 1,5a3d1d71d010a2ab19230fa04f706c0b",
  "move 0 -1,ec759f88c6c13b83f843e4ef88198a22|move 0 1,9713c120118acda4aebcd908583ed8fb",
  "move 0 -1,2fcc9a2378f4d83813354b92a76cc9aa|move 0 1,a18f8a943e79ef26e4138a1073cd7a50",
  "move 0 -1,f3b27594550b419515aa46eea5a8bc08|move 0 1,449f379e39f4f25a2f90849248297619",
  "move 0 -1,5d7ae7e5edd453caf4c60b2eb1ddf9f6|move 0 1,e2176b074dc1ca94edcb10bf9f6e5a49",
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

  // Both walk in through the south gate, so the ring scan puts them one
  // tile apart: a duel starts in contact.
  let ok = s.players[0].x === 56 && s.players[0].y === 38
        && s.players[1].x === 56 && s.players[1].y === 37;
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
    " p0[dead=1 exited=0 absent=0 xp=0 gold=0 kills=0 hp=0 dmg=0" +
    " pvp=107 death=1 exit=]" +
    " p1[dead=0 exited=0 absent=0 xp=0 gold=0 kills=0 hp=17 dmg=0" +
    " pvp=100 death=0 exit=]" +
    " winner=1 rounds=13 entries=84" +
    " hash=63712921fdf060e8cb3c29a4a9c14ff2e4b34a9eb2a538885a3518beb647448a";
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
const STALL_PREFIX_ROUNDS = 5;

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
    " p0[dead=0 exited=0 absent=0 xp=0 gold=0 kills=0 hp=80 dmg=0" +
    " pvp=27 death=0 exit=]" +
    " p1[dead=0 exited=0 absent=1 xp=0 gold=0 kills=0 hp=97 dmg=0" +
    " pvp=20 death=0 exit=]" +
    " winner=0 rounds=5 entries=30" +
    " hash=89297c9ba2febf01df5ba39fae36c835cb589d17d44a10df0a1359aa6fa4f510";
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
  runDuelConcessionVector(),
  runDuelStallVector(),
  runDuelCommitHashVector(),
  runDuelEntryEncodingVectors(),
];
runEquipParityVector();
// A thrown error makes `node dist/game/parity_test.js` exit non-zero.
if (results.some(r => !r)) throw new Error("parity vectors FAILED");
