/**
 * Camera / viewport management.
 * Centers on a target position, clamps to dungeon boundaries.
 */

import { WIDTH, HEIGHT } from "../game/dungeon.js";
import { TILE_SIZE } from "./tiles.js";

export class Camera {
  /** Top-left tile position of the viewport. */
  x: number = 0;
  y: number = 0;

  /** Viewport size in tiles (computed from canvas size). */
  viewW: number = 40;
  viewH: number = 30;

  /** Update viewport size based on canvas dimensions. */
  resize(canvasWidth: number, canvasHeight: number): void {
    this.viewW = Math.floor(canvasWidth / TILE_SIZE);
    this.viewH = Math.floor(canvasHeight / TILE_SIZE);
  }

  /** Center the camera on a world position. */
  centerOn(worldX: number, worldY: number): void {
    this.x = Math.floor(worldX - this.viewW / 2);
    this.y = Math.floor(worldY - this.viewH / 2);

    // Clamp to dungeon bounds.
    this.x = Math.max(0, Math.min(this.x, WIDTH - this.viewW));
    this.y = Math.max(0, Math.min(this.y, HEIGHT - this.viewH));
  }

  /** Convert world tile coordinates to canvas pixel coordinates. */
  toScreen(worldX: number, worldY: number): [number, number] {
    return [
      (worldX - this.x) * TILE_SIZE,
      (worldY - this.y) * TILE_SIZE,
    ];
  }

  /** Check if a world position is visible in the viewport. */
  isVisible(worldX: number, worldY: number): boolean {
    return worldX >= this.x && worldX < this.x + this.viewW
        && worldY >= this.y && worldY < this.y + this.viewH;
  }
}
