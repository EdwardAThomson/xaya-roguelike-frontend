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
import { DungeonSession, GameAction, EntryInvItem, PlayerSetup } from "./session.js";
import { PlayerStats } from "./combat.js";
import {
  canonicalActionLine, computeClaims, parseCanonicalLog, settleLogHash,
  splitPool, encodeCompactLog, decodeCompactLog,
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

const results = [
  runParityTest(),
  runSettleHashVector(),
  runSplitPoolVectors(),
  runCoopParityVector(),
  runAbsentParityVector(),
  runCompactEncodingVector(),
  runSpawnParityVectors(),
];
runEquipParityVector();
// A thrown error makes `node dist/game/parity_test.js` exit non-zero.
if (results.some(r => !r)) throw new Error("parity vectors FAILED");
