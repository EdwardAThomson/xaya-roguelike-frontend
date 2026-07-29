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
import { DungeonSession, GameAction, EntryInvItem } from "./session.js";
import { PlayerStats } from "./combat.js";

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

runParityTest();
runEquipParityVector();
