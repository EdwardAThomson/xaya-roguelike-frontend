/**
 * Main entry point — Phase F2: Playable dungeon in the browser.
 */

import { WIDTH, HEIGHT } from "./game/dungeon.js";
import { DungeonSession, GameAction } from "./game/session.js";
import { PlayerStats } from "./game/combat.js";
import { Camera } from "./render/camera.js";
import { TILE_SIZE, drawTile, initSprites } from "./render/tiles.js";
import { drawMonsters, drawGroundItems, drawPlayer } from "./render/entities.js";
import { InputHandler, Direction } from "./game/input.js";
import { FovMap } from "./render/fov.js";

// --- Setup ---

const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const camera = new Camera();
initSprites();

const stats: PlayerStats = {
  level: 1,
  strength: 10,
  dexterity: 10,
  constitution: 10,
  intelligence: 10,
  equipAttack: 5,
  equipDefense: 2,
};

const session = new DungeonSession(
  "hello_world", 1, stats, 100, 100,
  [{ itemId: "health_potion", quantity: 3 }]
);

const fov = new FovMap();
fov.update(session.playerX, session.playerY, session.dungeon);

// --- Resize ---

function resize(): void {
  const parent = canvas.parentElement!;
  canvas.width = parent.clientWidth;
  canvas.height = parent.clientHeight;
  camera.resize(canvas.width, canvas.height);
  camera.centerOn(session.playerX, session.playerY);
  render();
}
window.addEventListener("resize", resize);
resize();

// --- Render ---

function render(): void {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const dungeon = session.dungeon;

  // Tiles (with FOV).
  for (let y = camera.y; y < camera.y + camera.viewH && y < HEIGHT; y++) {
    for (let x = camera.x; x < camera.x + camera.viewW && x < WIDTH; x++) {
      const alpha = fov.getAlpha(x, y);
      if (alpha <= 0) continue; // Hidden — don't render.
      const [px, py] = camera.toScreen(x, y);
      drawTile(ctx, dungeon.getTile(x, y), px, py, alpha);
    }
  }

  // Ground items (only visible tiles).
  drawGroundItems(ctx, camera,
    session.groundItems.filter(gi => fov.isVisible(gi.x, gi.y)));

  // Monsters (only visible tiles).
  drawMonsters(ctx, camera,
    session.monsters.filter(m => m.alive && fov.isVisible(m.x, m.y)));

  // Player.
  drawPlayer(ctx, camera, session.playerX, session.playerY);

  // Gate direction arrows.
  ctx.font = "bold 14px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const gate of dungeon.gates) {
    if (camera.isVisible(gate.x, gate.y)) {
      const [gx, gy] = camera.toScreen(gate.x, gate.y);
      ctx.fillStyle = "#ffd700";
      const arrow = gate.direction === "north" ? "↑"
                  : gate.direction === "south" ? "↓"
                  : gate.direction === "east" ? "→" : "←";
      ctx.fillText(arrow, gx + TILE_SIZE / 2, gy + TILE_SIZE / 2);
    }
  }

  // Update UI.
  updateStats();
  updateMessages();
}

// --- Input ---

new InputHandler((action: string, dir?: Direction) => {
  if (session.gameOver) return;

  let gameAction: GameAction | null = null;

  switch (action) {
    case "move":
      if (dir) gameAction = { type: "move", dx: dir.dx, dy: dir.dy };
      break;
    case "pickup":
      gameAction = { type: "pickup" };
      break;
    case "wait":
      gameAction = { type: "wait" };
      break;
    case "gate":
      gameAction = { type: "gate" };
      break;
    case "use_potion":
      gameAction = { type: "use", itemId: "health_potion" };
      break;
  }

  if (gameAction) {
    session.processAction(gameAction);
    fov.update(session.playerX, session.playerY, session.dungeon);
    camera.centerOn(session.playerX, session.playerY);
    render();
  }
});

// --- Stats Panel ---

function updateStats(): void {
  const el = document.getElementById("stats-display");
  if (!el) return;

  const hpPct = Math.max(0, session.playerHp / session.playerMaxHp * 100);
  const hpColor = hpPct > 60 ? "#4a4" : hpPct > 30 ? "#aa4" : "#c44";

  el.innerHTML = `
    <div>Turn: ${session.turnCount}</div>
    <div class="hp-bar">
      <div class="hp-bar-fill" style="width:${hpPct}%; background:${hpColor}"></div>
      <div class="hp-bar-text">HP ${session.playerHp} / ${session.playerMaxHp}</div>
    </div>
    <div>XP: ${session.totalXp} &nbsp; Gold: ${session.totalGold}</div>
    <div>Kills: ${session.totalKills}</div>
    <div>Depth: ${session.depth}</div>
    ${session.gameOver
      ? `<div style="margin-top:8px;color:${session.survived ? '#4a4' : '#c44'};font-weight:bold">
           ${session.survived ? 'SURVIVED — Exited ' + session.exitGate : 'YOU DIED'}
         </div>`
      : ''}
    <div style="margin-top:8px;font-size:11px;color:#888">
      WASD/Arrows: Move &nbsp; G: Pickup<br>
      P: Potion &nbsp; Space: Wait &nbsp; Enter: Gate
    </div>
  `;
}

// --- Inventory Panel ---

function updateInventory(): void {
  const el = document.getElementById("inventory-display");
  if (!el) return;

  if (session.loot.length === 0) {
    el.innerHTML = '<div style="color:#666">Empty</div>';
    return;
  }

  el.innerHTML = session.loot
    .filter(l => l.quantity > 0)
    .map(l => `<div>${l.itemId} x${l.quantity}</div>`)
    .join("");
}

// --- Message Log ---

function updateMessages(): void {
  const el = document.getElementById("message-log");
  if (!el) return;

  // Show last 8 messages.
  const recent = session.messages.slice(-8);
  el.innerHTML = recent.map(m =>
    `<div class="msg-${m.type}">${m.text}</div>`
  ).join("");

  el.scrollTop = el.scrollHeight;

  updateInventory();
}

// Initial render.
render();
console.log("Game ready. Seed: hello_world, Depth: 1");
console.log(`Monsters: ${session.monsters.length}, Items: ${session.groundItems.length}`);
