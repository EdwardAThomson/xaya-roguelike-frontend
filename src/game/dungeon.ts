/**
 * Deterministic dungeon generation — TypeScript port of dungeon.cpp.
 * Must produce identical output to the C++ version for the same seed.
 */

import { MT19937 } from "./rng.js";

export enum Tile {
  Wall = 0,
  Floor = 1,
  Gate = 2,
}

export interface Room {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Gate {
  x: number;
  y: number;
  direction: string;
}

export const WIDTH = 80;
export const HEIGHT = 40;
const MIN_ROOMS = 8;
const MAX_ROOMS = 15;
const MIN_ROOM_WIDTH = 4;
const MAX_ROOM_WIDTH = 8;
const MIN_ROOM_HEIGHT = 4;
const MAX_ROOM_HEIGHT = 7;
const ROOM_BUFFER = 1;
const GATE_MARGIN = 2;

export class Dungeon {
  tiles: Uint8Array; // WIDTH * HEIGHT, row-major [y * WIDTH + x]
  rooms: Room[] = [];
  gates: Gate[] = [];
  depth: number;

  constructor() {
    this.tiles = new Uint8Array(WIDTH * HEIGHT);
    this.depth = 0;
  }

  getTile(x: number, y: number): Tile {
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return Tile.Wall;
    return this.tiles[y * WIDTH + x] as Tile;
  }

  setTile(x: number, y: number, t: Tile): void {
    if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) {
      this.tiles[y * WIDTH + x] = t;
    }
  }

  static generate(seed: string, depth: number, constraints: Gate[] = []): Dungeon {
    const d = new Dungeon();
    d.depth = depth;
    d.clear();

    // TODO: replace with SHA-256 hash once debugged.
    // For now, use a simple string-to-number hash.
    let h = 0;
    const s = seed + ":" + depth;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    const rng = new MT19937((h >>> 0));
    d.generateRooms(rng);
    d.connectRooms(rng);

    if (constraints.length > 0) {
      d.placeConstrainedGates(rng, constraints);
    } else {
      d.placeGates(rng);
    }

    return d;
  }

  private clear(): void {
    this.tiles.fill(Tile.Wall);
  }

  private carveRoom(room: Room): void {
    for (let y = room.y; y < room.y + room.height; y++) {
      for (let x = room.x; x < room.x + room.width; x++) {
        this.setTile(x, y, Tile.Floor);
      }
    }
  }

  private static roomsOverlap(a: Room, b: Room): boolean {
    return a.x <= b.x + b.width + ROOM_BUFFER
        && a.x + a.width + ROOM_BUFFER >= b.x
        && a.y <= b.y + b.height + ROOM_BUFFER
        && a.y + a.height + ROOM_BUFFER >= b.y;
  }

  private carveHorizontalCorridor(x1: number, x2: number, y: number): void {
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    for (let x = minX; x <= maxX; x++) {
      if (y >= 0 && y < HEIGHT && x >= 0 && x < WIDTH) {
        this.tiles[y * WIDTH + x] = Tile.Floor;
      }
    }
  }

  private carveVerticalCorridor(y1: number, y2: number, x: number): void {
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);
    for (let y = minY; y <= maxY; y++) {
      if (y >= 0 && y < HEIGHT && x >= 0 && x < WIDTH) {
        this.tiles[y * WIDTH + x] = Tile.Floor;
      }
    }
  }

  private carveLCorridor(x1: number, y1: number, x2: number, y2: number,
                          rng: MT19937): void {
    if (rng.nextRange(0, 1) === 0) {
      this.carveHorizontalCorridor(x1, x2, y1);
      this.carveVerticalCorridor(y1, y2, x2);
    } else {
      this.carveVerticalCorridor(y1, y2, x1);
      this.carveHorizontalCorridor(x1, x2, y2);
    }
  }

  private generateRooms(rng: MT19937): void {
    const numRooms = rng.nextRange(MIN_ROOMS, MAX_ROOMS);
    const maxAttempts = numRooms * 3;

    for (let attempt = 0; attempt < maxAttempts && this.rooms.length < numRooms;
         attempt++) {
      const room: Room = {
        width: rng.nextRange(MIN_ROOM_WIDTH, MAX_ROOM_WIDTH),
        height: rng.nextRange(MIN_ROOM_HEIGHT, MAX_ROOM_HEIGHT),
        x: 0,
        y: 0,
      };
      room.x = rng.nextRange(1, WIDTH - room.width - 2);
      room.y = rng.nextRange(1, HEIGHT - room.height - 2);

      let overlaps = false;
      for (const existing of this.rooms) {
        if (Dungeon.roomsOverlap(room, existing)) {
          overlaps = true;
          break;
        }
      }

      if (!overlaps) {
        this.carveRoom(room);
        this.rooms.push(room);
      }
    }
  }

  private connectRooms(rng: MT19937): void {
    if (this.rooms.length < 2) return;

    for (let i = 0; i + 1 < this.rooms.length; i++) {
      const a = this.rooms[i];
      const b = this.rooms[i + 1];
      this.carveLCorridor(
        a.x + Math.floor(a.width / 2), a.y + Math.floor(a.height / 2),
        b.x + Math.floor(b.width / 2), b.y + Math.floor(b.height / 2),
        rng);
    }

    if (this.rooms.length > 2) {
      const first = this.rooms[0];
      const last = this.rooms[this.rooms.length - 1];
      this.carveLCorridor(
        first.x + Math.floor(first.width / 2),
        first.y + Math.floor(first.height / 2),
        last.x + Math.floor(last.width / 2),
        last.y + Math.floor(last.height / 2),
        rng);
    }
  }

  private placeGate(x: number, y: number, direction: string,
                     rng: MT19937): void {
    this.gates.push({ x, y, direction });
    this.setTile(x, y, Tile.Gate);
    this.connectGateToNearestRoom({ x, y, direction }, rng);
  }

  private placeGates(rng: MT19937): void {
    this.placeGate(rng.nextRange(GATE_MARGIN, WIDTH - GATE_MARGIN - 1),
                   0, "north", rng);
    this.placeGate(rng.nextRange(GATE_MARGIN, WIDTH - GATE_MARGIN - 1),
                   HEIGHT - 1, "south", rng);
    this.placeGate(0, rng.nextRange(GATE_MARGIN, HEIGHT - GATE_MARGIN - 1),
                   "west", rng);
    this.placeGate(WIDTH - 1, rng.nextRange(GATE_MARGIN, HEIGHT - GATE_MARGIN - 1),
                   "east", rng);
  }

  private placeConstrainedGates(rng: MT19937, constraints: Gate[]): void {
    let hasN = false, hasS = false, hasE = false, hasW = false;

    for (const c of constraints) {
      this.placeGate(c.x, c.y, c.direction, rng);
      if (c.direction === "north") hasN = true;
      else if (c.direction === "south") hasS = true;
      else if (c.direction === "east") hasE = true;
      else if (c.direction === "west") hasW = true;
    }

    if (!hasN) this.placeGate(rng.nextRange(GATE_MARGIN, WIDTH - GATE_MARGIN - 1),
                               0, "north", rng);
    if (!hasS) this.placeGate(rng.nextRange(GATE_MARGIN, WIDTH - GATE_MARGIN - 1),
                               HEIGHT - 1, "south", rng);
    if (!hasW) this.placeGate(0, rng.nextRange(GATE_MARGIN, HEIGHT - GATE_MARGIN - 1),
                               "west", rng);
    if (!hasE) this.placeGate(WIDTH - 1, rng.nextRange(GATE_MARGIN, HEIGHT - GATE_MARGIN - 1),
                               "east", rng);
  }

  private connectGateToNearestRoom(gate: Gate, rng: MT19937): void {
    if (this.rooms.length === 0) return;

    let bestDist = Infinity;
    let bestIdx = 0;
    for (let i = 0; i < this.rooms.length; i++) {
      const r = this.rooms[i];
      const cx = r.x + Math.floor(r.width / 2);
      const cy = r.y + Math.floor(r.height / 2);
      const dist = Math.abs(gate.x - cx) + Math.abs(gate.y - cy);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    let startX = gate.x, startY = gate.y;
    if (gate.direction === "north") startY = 1;
    else if (gate.direction === "south") startY = HEIGHT - 2;
    else if (gate.direction === "west") startX = 1;
    else if (gate.direction === "east") startX = WIDTH - 2;

    const r = this.rooms[bestIdx];
    this.carveLCorridor(startX, startY,
                         r.x + Math.floor(r.width / 2),
                         r.y + Math.floor(r.height / 2), rng);
  }

  /** Get a random floor position. */
  getRandomFloorPosition(rng: MT19937): [number, number] {
    const floors: [number, number][] = [];
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        if (this.getTile(x, y) === Tile.Floor) {
          floors.push([x, y]);
        }
      }
    }
    if (floors.length === 0) return [-1, -1];
    return floors[rng.nextInt(floors.length)];
  }
}
