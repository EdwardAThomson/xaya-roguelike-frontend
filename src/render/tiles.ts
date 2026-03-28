/**
 * Tile renderer — draws dungeon tiles to canvas.
 * Procedural sprites matching the JS roguelike style.
 */

import { Tile } from "../game/dungeon.js";

export const TILE_SIZE = 24;

/** Pre-rendered tile sprites (canvas elements). */
let wallSprite: HTMLCanvasElement;
let floorSprite: HTMLCanvasElement;
let gateSprite: HTMLCanvasElement;

/** Create the procedural tile sprites. */
export function initSprites(): void {
  wallSprite = createWallSprite();
  floorSprite = createFloorSprite();
  gateSprite = createGateSprite();
}

function createWallSprite(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = TILE_SIZE;
  c.height = TILE_SIZE;
  const ctx = c.getContext("2d")!;

  // Base.
  ctx.fillStyle = "#555";
  ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);

  // Brick pattern.
  ctx.fillStyle = "#444";
  ctx.fillRect(1, 1, 10, 5);
  ctx.fillRect(13, 1, 10, 5);
  ctx.fillRect(6, 8, 10, 5);
  ctx.fillRect(18, 8, 5, 5);
  ctx.fillRect(0, 8, 4, 5);
  ctx.fillRect(1, 15, 10, 5);
  ctx.fillRect(13, 15, 10, 5);

  // Mortar.
  ctx.fillStyle = "#333";
  ctx.fillRect(0, 0, TILE_SIZE, 1);
  ctx.fillRect(0, 7, TILE_SIZE, 1);
  ctx.fillRect(0, 14, TILE_SIZE, 1);
  ctx.fillRect(0, 21, TILE_SIZE, 1);
  ctx.fillRect(12, 0, 1, 7);
  ctx.fillRect(5, 7, 1, 7);
  ctx.fillRect(17, 7, 1, 7);
  ctx.fillRect(12, 14, 1, 7);

  return c;
}

function createFloorSprite(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = TILE_SIZE;
  c.height = TILE_SIZE;
  const ctx = c.getContext("2d")!;

  ctx.fillStyle = "#222";
  ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);

  // Stone texture details.
  ctx.fillStyle = "#272727";
  ctx.fillRect(3, 3, 8, 6);
  ctx.fillRect(14, 12, 7, 5);
  ctx.fillRect(5, 16, 6, 4);

  ctx.fillStyle = "#1d1d1d";
  ctx.fillRect(2, 2, 1, 1);
  ctx.fillRect(18, 5, 1, 1);
  ctx.fillRect(8, 19, 1, 1);
  ctx.fillRect(15, 2, 1, 1);

  return c;
}

function createGateSprite(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = TILE_SIZE;
  c.height = TILE_SIZE;
  const ctx = c.getContext("2d")!;

  // Dark background.
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);

  // Gold glow.
  ctx.fillStyle = "#332800";
  ctx.fillRect(2, 2, TILE_SIZE - 4, TILE_SIZE - 4);

  // Iron bars.
  ctx.fillStyle = "#777";
  for (let x = 4; x < TILE_SIZE; x += 6) {
    ctx.fillRect(x, 0, 2, TILE_SIZE);
  }
  ctx.fillRect(0, 6, TILE_SIZE, 2);
  ctx.fillRect(0, 16, TILE_SIZE, 2);

  // Gold accent.
  ctx.fillStyle = "#daa520";
  ctx.fillRect(10, 10, 4, 4);

  return c;
}

/** Draw a single tile at pixel position. */
export function drawTile(ctx: CanvasRenderingContext2D,
                          tile: Tile, px: number, py: number,
                          alpha: number = 1.0): void {
  ctx.globalAlpha = alpha;

  switch (tile) {
    case Tile.Wall:
      ctx.drawImage(wallSprite, px, py);
      break;
    case Tile.Floor:
      ctx.drawImage(floorSprite, px, py);
      break;
    case Tile.Gate:
      ctx.drawImage(gateSprite, px, py);
      break;
  }

  ctx.globalAlpha = 1.0;
}
