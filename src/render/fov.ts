/**
 * Field of View — circular FOV with Bresenham line-of-sight.
 * Matches the JS roguelike: radius 8, walls block vision.
 *
 * Three states:
 *   - Visible (currently in FOV): render at full brightness
 *   - Explored (seen before, not in FOV): render at 50% opacity
 *   - Hidden (never seen): don't render
 */

import { Dungeon, Tile, WIDTH, HEIGHT } from "../game/dungeon.js";

const FOV_RADIUS = 8;

export class FovMap {
  /** Currently visible tiles. */
  visible: Set<number> = new Set();

  /** All tiles ever seen. */
  explored: Set<number> = new Set();

  private static key(x: number, y: number): number {
    return y * WIDTH + x;
  }

  /** Recompute FOV from a position. */
  update(px: number, py: number, dungeon: Dungeon): void {
    this.visible.clear();

    // The player's tile is always visible.
    this.markVisible(px, py);

    // Cast rays in all directions.
    for (let angle = 0; angle < 360; angle += 1) {
      const rad = angle * Math.PI / 180;
      const dx = Math.cos(rad);
      const dy = Math.sin(rad);

      for (let dist = 1; dist <= FOV_RADIUS; dist++) {
        const tx = Math.round(px + dx * dist);
        const ty = Math.round(py + dy * dist);

        if (tx < 0 || tx >= WIDTH || ty < 0 || ty >= HEIGHT) break;

        this.markVisible(tx, ty);

        // Walls block further vision.
        if (dungeon.getTile(tx, ty) === Tile.Wall) break;
      }
    }
  }

  private markVisible(x: number, y: number): void {
    const k = FovMap.key(x, y);
    this.visible.add(k);
    this.explored.add(k);
  }

  /** Check if a tile is currently visible. */
  isVisible(x: number, y: number): boolean {
    return this.visible.has(FovMap.key(x, y));
  }

  /** Check if a tile has ever been seen. */
  isExplored(x: number, y: number): boolean {
    return this.explored.has(FovMap.key(x, y));
  }

  /** Get the render alpha for a tile. */
  getAlpha(x: number, y: number): number {
    if (this.isVisible(x, y)) return 1.0;
    if (this.isExplored(x, y)) return 0.35;
    return 0;
  }
}
