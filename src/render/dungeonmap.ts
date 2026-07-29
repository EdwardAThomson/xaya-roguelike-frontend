/**
 * Dungeon minimap renderer.
 *
 * Draws a static, fit-to-canvas overview of the CURRENT dungeon session:
 * the explored grid (fog-of-war aware, so only what the player has seen is
 * revealed), walls / floor / gates (with direction), the player, and the
 * monsters and items currently in view.  This is the "Dungeon" tab of the
 * Map view; it reuses the live session data (dungeon tiles, gates, entities)
 * and the FovMap rather than regenerating anything.
 *
 * Unlike the live tile view (render/tiles.ts + a camera viewport), this draws
 * the whole 80x40 grid scaled down to a single fixed frame, with no pan/zoom.
 */

import { Tile, WIDTH, HEIGHT } from "../game/dungeon.js";
import { FovMap } from "./fov.js";
import { DungeonSession } from "../game/session.js";
import { lookupItem } from "../game/items.js";

/** Outer padding (px) between the canvas edge and the drawn grid. */
const PAD = 40;

/**
 * Draws the dungeon minimap.  When `session`/`fov` are null (player at the
 * hub or not in a run) a clear placeholder is shown instead.
 */
export function drawDungeonMap(
  ctx: CanvasRenderingContext2D,
  session: DungeonSession | null,
  fov: FovMap | null,
  canvasW: number,
  canvasH: number,
): void {
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Inset panel frame (matching the world map) so this reads as a contained
  // MAP, not the live playable dungeon view.
  const FRAME = 16;
  const fw = Math.max(0, canvasW - FRAME * 2);
  const fh = Math.max(0, canvasH - FRAME * 2);
  ctx.fillStyle = "#0c0c14";
  roundRect(ctx, FRAME, FRAME, fw, fh, 10);
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#2c2c3c";
  roundRect(ctx, FRAME, FRAME, fw, fh, 10);
  ctx.stroke();

  // Title, so it is unmistakably the MAP and not the dungeon you play in.
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#8ec";
  ctx.font = "bold 13px monospace";
  ctx.fillText("DUNGEON MAP", FRAME + 10, FRAME + 8);

  if (!session || !fov) {
    ctx.fillStyle = "#666";
    ctx.font = "16px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No active dungeon. Enter a segment to see its layout.",
                 canvasW / 2, canvasH / 2);
    return;
  }

  const dungeon = session.dungeon;

  // Fit the whole 80x40 grid into the padded frame, keeping square cells.
  const cell = Math.max(1, Math.floor(
    Math.min((canvasW - PAD * 2) / WIDTH, (canvasH - PAD * 2) / HEIGHT)));
  const gridW = cell * WIDTH;
  const gridH = cell * HEIGHT;
  const offX = Math.floor((canvasW - gridW) / 2);
  const offY = Math.floor((canvasH - gridH) / 2);

  // Tile colours (echoing the live sprites, flattened for the minimap).
  const WALL_VISIBLE = "#5a5a5a";
  const WALL_EXPLORED = "#333";
  const FLOOR_VISIBLE = "#2b2b2b";
  const FLOOR_EXPLORED = "#181818";

  // Draw explored/visible tiles.  Hidden tiles (never seen) are left dark.
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (!fov.isExplored(x, y)) continue;
      const visible = fov.isVisible(x, y);
      const tile = dungeon.getTile(x, y);

      let color: string;
      if (tile === Tile.Gate) {
        color = visible ? "#daa520" : "#6b5410";
      } else if (tile === Tile.Wall) {
        color = visible ? WALL_VISIBLE : WALL_EXPLORED;
      } else {
        color = visible ? FLOOR_VISIBLE : FLOOR_EXPLORED;
      }

      ctx.fillStyle = color;
      ctx.fillRect(offX + x * cell, offY + y * cell, cell, cell);
    }
  }

  // Gate direction markers: a small arrow next to each explored gate.
  ctx.font = `bold ${Math.max(8, cell + 2)}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const gate of dungeon.gates) {
    if (!fov.isExplored(gate.x, gate.y)) continue;
    const arrow = gate.direction === "north" ? "↑"
                : gate.direction === "south" ? "↓"
                : gate.direction === "east" ? "→" : "←";
    ctx.fillStyle = fov.isVisible(gate.x, gate.y) ? "#ffd700" : "#8a6d1c";
    // Nudge the arrow just outside the gate toward its wall edge.
    const gx = offX + gate.x * cell + cell / 2
             + (gate.direction === "east" ? cell : gate.direction === "west" ? -cell : 0);
    const gy = offY + gate.y * cell + cell / 2
             + (gate.direction === "south" ? cell : gate.direction === "north" ? -cell : 0);
    ctx.fillText(arrow, gx, gy);
  }

  // Ground items currently in view (fog-of-war: only what the player sees).
  const dot = Math.max(2, cell - 1);
  for (const gi of session.groundItems) {
    if (!fov.isVisible(gi.x, gi.y)) continue;
    const def = lookupItem(gi.itemId);
    ctx.fillStyle = def ? def.color : "#ff0";
    const cx = offX + gi.x * cell + cell / 2;
    const cy = offY + gi.y * cell + cell / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, dot / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Monsters currently in view.
  for (const m of session.monsters) {
    if (!m.alive || !fov.isVisible(m.x, m.y)) continue;
    ctx.fillStyle = m.color;
    const cx = offX + m.x * cell + cell / 2;
    const cy = offY + m.y * cell + cell / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, dot / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Player position (always drawn on top).
  const px = offX + session.playerX * cell + cell / 2;
  const py = offY + session.playerY * cell + cell / 2;
  ctx.fillStyle = "#daa520";
  ctx.beginPath();
  ctx.arc(px, py, Math.max(2.5, cell / 1.4), 0, Math.PI * 2);
  ctx.fill();
  if (cell >= 5) {
    ctx.fillStyle = "#000";
    ctx.font = `bold ${cell + 1}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("@", px, py + 1);
  }

  // Legend (bottom, clear of the title and the tab bar over the top-centre).
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#666";
  ctx.font = "11px monospace";
  ctx.fillText(
    "@ you · gold = gates · dim = explored, bright = in view",
    FRAME + 10, canvasH - FRAME - 20,
  );
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
