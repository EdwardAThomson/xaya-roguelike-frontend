/**
 * Canvas setup and main render loop.
 */

import { Dungeon, WIDTH, HEIGHT } from "../game/dungeon.js";
import { Camera } from "./camera.js";
import { TILE_SIZE, drawTile, initSprites } from "./tiles.js";

export class GameRenderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  camera: Camera;
  dungeon: Dungeon | null = null;

  /** Player position (for rendering @ symbol). */
  playerX: number = 0;
  playerY: number = 0;

  constructor(canvasId: string) {
    this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d")!;
    this.camera = new Camera();
    initSprites();
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize(): void {
    const parent = this.canvas.parentElement!;
    this.canvas.width = parent.clientWidth;
    this.canvas.height = parent.clientHeight;
    this.camera.resize(this.canvas.width, this.canvas.height);
  }

  setDungeon(dungeon: Dungeon): void {
    this.dungeon = dungeon;
    // Default player position: center of first room.
    if (dungeon.rooms.length > 0) {
      const r = dungeon.rooms[0];
      this.playerX = r.x + Math.floor(r.width / 2);
      this.playerY = r.y + Math.floor(r.height / 2);
    }
    this.camera.centerOn(this.playerX, this.playerY);
  }

  render(): void {
    const { ctx, canvas, camera, dungeon } = this;
    if (!dungeon) return;

    // Clear.
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw tiles.
    for (let y = camera.y; y < camera.y + camera.viewH && y < HEIGHT; y++) {
      for (let x = camera.x; x < camera.x + camera.viewW && x < WIDTH; x++) {
        const tile = dungeon.getTile(x, y);
        const [px, py] = camera.toScreen(x, y);
        drawTile(ctx, tile, px, py);
      }
    }

    // Draw player.
    if (camera.isVisible(this.playerX, this.playerY)) {
      const [px, py] = camera.toScreen(this.playerX, this.playerY);

      // Gold circle.
      ctx.fillStyle = "#daa520";
      ctx.beginPath();
      ctx.arc(px + TILE_SIZE / 2, py + TILE_SIZE / 2,
              TILE_SIZE / 2 - 2, 0, Math.PI * 2);
      ctx.fill();

      // @ symbol.
      ctx.fillStyle = "#000";
      ctx.font = `bold ${TILE_SIZE - 6}px monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("@", px + TILE_SIZE / 2, py + TILE_SIZE / 2 + 1);
    }

    // Draw gate direction indicators.
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
  }
}
