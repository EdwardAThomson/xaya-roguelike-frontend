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

runParityTest();
