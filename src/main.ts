/**
 * Main entry point — Phase F1: Render a dungeon and pan with keyboard.
 */

import { Dungeon } from "./game/dungeon.js";
import { GameRenderer } from "./render/canvas.js";
import { InputHandler, Direction } from "./game/input.js";
import { runHashTests } from "./game/hash_test.js";

console.log("Main: starting...");
console.log("Hash verification:");
const hashOk = runHashTests();
console.log(hashOk ? "All hash tests PASSED" : "Hash tests FAILED");

// MT19937 verification against C++.
import { MT19937 } from "./game/rng.js";
import { hashSeedSync } from "./game/hash.js";
const testSeed = hashSeedSync("hello_world:1");
console.log("MT19937 seed:", testSeed, "(0x" + testSeed.toString(16) + ")");
const testRng = new MT19937(testSeed);
const expected = [3715977427, 2037900038, 1597496797, 2282518739, 3751484099,
                  2356626247, 1625781333, 2059247412, 3748425691, 784824438];
let rngOk = true;
for (let i = 0; i < 10; i++) {
  const got = testRng.next();
  const match = got === expected[i];
  if (!match) rngOk = false;
  console.log(`  MT[${i}]: got ${got}, expected ${expected[i]} ${match ? "✓" : "✗ FAIL"}`);
}
console.log(rngOk ? "All MT19937 tests PASSED" : "MT19937 tests FAILED");

// Test nextRange matches C++ uniform_int_distribution.
const distRng = new MT19937(1872746867);
const roomCount = distRng.nextRange(8, 15);  // C++ gives 14
console.log(`nextRange(8,15): got ${roomCount}, expected 14 ${roomCount === 14 ? "✓" : "✗"}`);
const rw = distRng.nextRange(4, 8);  // C++ gives 6
const rh = distRng.nextRange(4, 7);  // C++ gives 5
const rx = distRng.nextRange(1, 80 - rw - 2);  // C++ gives 39
const ry = distRng.nextRange(1, 40 - rh - 2);  // C++ gives 29
console.log(`Room 0: w=${rw} h=${rh} x=${rx} y=${ry} (C++: w=6 h=5 x=39 y=29)`);

try {
  const renderer = new GameRenderer("game-canvas");
  console.log("Main: renderer created");

  // Generate a dungeon from a test seed.
  const dungeon = Dungeon.generate("hello_world", 1);
  console.log("Main: dungeon generated, rooms:", dungeon.rooms.length,
              "gates:", dungeon.gates.length);
  renderer.setDungeon(dungeon);
  console.log("Main: player at", renderer.playerX, renderer.playerY);
  console.log("Main: gates:",
    dungeon.gates.map(g => `${g.direction} at (${g.x}, ${g.y})`).join(", "));

  // Stats display.
  const statsEl = document.getElementById("stats-display");
  if (statsEl) {
    statsEl.innerHTML = `
      <div>Seed: hello_world</div>
      <div>Depth: ${dungeon.depth}</div>
      <div>Rooms: ${dungeon.rooms.length}</div>
      <div>Gates: ${dungeon.gates.length}</div>
      <div style="margin-top: 8px">
        <strong>Controls</strong><br>
        WASD / Arrows: Move<br>
        Q/E/Z/C: Diagonal<br>
        G: Pickup &nbsp; P: Potion<br>
        Space: Wait &nbsp; Enter: Gate
      </div>
    `;
  }

  // Input: move the player.
  new InputHandler((action: string, dir?: Direction) => {
    if (action === "move" && dir) {
      const nx = renderer.playerX + dir.dx;
      const ny = renderer.playerY + dir.dy;
      const tile = dungeon.getTile(nx, ny);
      // Allow walking on floor and gate tiles.
      if (tile !== 0) { // 0 = Wall
        renderer.playerX = nx;
        renderer.playerY = ny;
        renderer.camera.centerOn(renderer.playerX, renderer.playerY);
      }
    }
    renderer.render();
  });

  // Initial render.
  renderer.render();
  console.log("Main: initial render done");

  // Message log.
  const msgLog = document.getElementById("message-log");
  if (msgLog) {
    msgLog.innerHTML = `
      <div class="msg-info">Welcome to the dungeon.</div>
      <div class="msg-info">Use WASD or arrows to move.</div>
    `;
  }

} catch (e) {
  console.error("Main: error:", e);
}
