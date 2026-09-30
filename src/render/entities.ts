/**
 * Entity rendering — monsters, items, and player on canvas.
 */

import { TILE_SIZE } from "./tiles.js";
import { Camera } from "./camera.js";
import { Monster } from "../game/monsters.js";
import { GroundItem } from "../game/session.js";
import { lookupItem } from "../game/items.js";

export function drawMonsters(ctx: CanvasRenderingContext2D, camera: Camera,
                              monsters: Monster[]): void {
  ctx.font = `bold ${TILE_SIZE - 6}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const m of monsters) {
    if (!m.alive) continue;
    if (!camera.isVisible(m.x, m.y)) continue;

    const [px, py] = camera.toScreen(m.x, m.y);

    // Background circle.
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.beginPath();
    ctx.arc(px + TILE_SIZE / 2, py + TILE_SIZE / 2,
            TILE_SIZE / 2 - 1, 0, Math.PI * 2);
    ctx.fill();

    // Symbol.
    ctx.fillStyle = m.color;
    ctx.fillText(m.symbol, px + TILE_SIZE / 2, py + TILE_SIZE / 2 + 1);

    // HP bar (if damaged).
    if (m.hp < m.maxHp) {
      const barW = TILE_SIZE - 4;
      const barH = 3;
      const bx = px + 2;
      const by = py + TILE_SIZE - 5;
      ctx.fillStyle = "#333";
      ctx.fillRect(bx, by, barW, barH);
      ctx.fillStyle = "#c44";
      ctx.fillRect(bx, by, barW * (m.hp / m.maxHp), barH);
    }
  }
}

export function drawGroundItems(ctx: CanvasRenderingContext2D, camera: Camera,
                                 items: GroundItem[]): void {
  ctx.font = `${TILE_SIZE - 8}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const gi of items) {
    if (!camera.isVisible(gi.x, gi.y)) continue;

    const [px, py] = camera.toScreen(gi.x, gi.y);
    const def = lookupItem(gi.itemId);

    if (def) {
      ctx.fillStyle = def.color;
      ctx.fillText(def.icon, px + TILE_SIZE / 2, py + TILE_SIZE / 2);
    } else {
      ctx.fillStyle = "#ff0";
      ctx.fillText("!", px + TILE_SIZE / 2, py + TILE_SIZE / 2);
    }
  }
}

export function drawPlayer(ctx: CanvasRenderingContext2D, camera: Camera,
                            x: number, y: number, color: string = "#daa520",
                            self: boolean = true): void {
  if (!camera.isVisible(x, y)) return;

  const [px, py] = camera.toScreen(x, y);
  const cx = px + TILE_SIZE / 2;
  const cy = py + TILE_SIZE / 2;

  // Gold circle (a co-op partner or a duel opponent gets another colour).
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, TILE_SIZE / 2 - 2, 0, Math.PI * 2);
  ctx.fill();

  // Which one is YOU cannot rest on the fill colour alone. Two figures with
  // the same glyph on a floor of coloured items is genuinely hard to read
  // mid-fight, and it is unreadable to anyone who does not separate gold
  // from teal at all. So your own figure gets two marks that survive
  // without colour: a bright ring, and a caret pointing down at you.
  if (self) {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, TILE_SIZE / 2 - 1, 0, Math.PI * 2);
    ctx.stroke();

    const tip = py - 1;             // just above the tile
    const halfW = Math.max(3, TILE_SIZE / 6);
    const h = Math.max(4, TILE_SIZE / 5);
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.moveTo(cx, tip);            // point, aimed at the figure
    ctx.lineTo(cx - halfW, tip - h);
    ctx.lineTo(cx + halfW, tip - h);
    ctx.closePath();
    ctx.fill();
  }

  // @ symbol.
  ctx.fillStyle = "#000";
  ctx.font = `bold ${TILE_SIZE - 6}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("@", cx, cy + 1);
}

/**
 * Someone else in the run: the same glyph, and deliberately WITHOUT the
 * ring and caret, so the marked figure is always you.  Teal for a co-op
 * partner, red for a duel opponent, because an enemy reading as a
 * teammate is its own kind of confusion.
 */
export function drawPartner(ctx: CanvasRenderingContext2D, camera: Camera,
                            x: number, y: number,
                            hostile: boolean = false): void {
  drawPlayer(ctx, camera, x, y, hostile ? "#d9534f" : "#3cb8b0", false);
}
