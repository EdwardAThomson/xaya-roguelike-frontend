/**
 * Main entry point — Phase F1: Render a dungeon and pan with keyboard.
 */

import { Dungeon } from "./game/dungeon.js";
import { GameRenderer } from "./render/canvas.js";
import { InputHandler, Direction } from "./game/input.js";

console.log("Main: starting...");

try {
  const renderer = new GameRenderer("game-canvas");
  console.log("Main: renderer created");

  // Generate a dungeon from a test seed.
  const dungeon = Dungeon.generate("hello_world", 1);
  console.log("Main: dungeon generated, rooms:", dungeon.rooms.length,
              "gates:", dungeon.gates.length);
  renderer.setDungeon(dungeon);
  console.log("Main: dungeon set, player at",
              renderer.playerX, renderer.playerY);

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
