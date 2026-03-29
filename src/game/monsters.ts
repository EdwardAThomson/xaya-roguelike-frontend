/**
 * Monster database and spawning — TS port of monsters.cpp.
 * Must match C++ exactly for determinism.
 */

import { MT19937 } from "./rng.js";
import { Dungeon, Tile, WIDTH, HEIGHT } from "./dungeon.js";

export interface Monster {
  name: string;
  symbol: string;
  color: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  attack: number;
  defense: number;
  critChance: number;
  detectionRange: number;
  xpValue: number;
  alive: boolean;
  awareOfPlayer: boolean;
}

interface MonsterTemplate {
  name: string;
  symbol: string;
  color: string;
  minDepth: number;
  maxHp: number;
  attack: number;
  defense: number;
  critChance: number;
  detectionRange: number;
  xpValue: number;
}

const TEMPLATES: MonsterTemplate[] = [
  /* Depth 1 */
  { name: "Giant Rat",    symbol: "r", color: "#bb9944", minDepth: 1, maxHp: 24, attack: 5,  defense: 2, critChance: 3,  detectionRange: 5, xpValue: 10 },
  { name: "Giant Spider", symbol: "s", color: "#5522aa", minDepth: 1, maxHp: 24, attack: 7,  defense: 3, critChance: 5,  detectionRange: 5, xpValue: 12 },
  { name: "Cave Bat",     symbol: "b", color: "#665544", minDepth: 1, maxHp: 15, attack: 8,  defense: 2, critChance: 12, detectionRange: 6, xpValue: 8 },

  /* Depth 2 */
  { name: "Goblin",   symbol: "g", color: "#55dd55", minDepth: 2, maxHp: 30, attack: 8,  defense: 4, critChance: 5, detectionRange: 6, xpValue: 18 },
  { name: "Skeleton", symbol: "S", color: "#ffffff", minDepth: 2, maxHp: 40, attack: 10, defense: 4, critChance: 3, detectionRange: 5, xpValue: 22 },
  { name: "Kobold",   symbol: "k", color: "#aa8855", minDepth: 2, maxHp: 45, attack: 9,  defense: 3, critChance: 4, detectionRange: 6, xpValue: 20 },
  { name: "Wolf",     symbol: "w", color: "#777777", minDepth: 2, maxHp: 40, attack: 10, defense: 3, critChance: 6, detectionRange: 7, xpValue: 20 },

  /* Depth 3+ */
  { name: "Orc Warrior", symbol: "O", color: "#88cc55", minDepth: 3, maxHp: 65, attack: 12, defense: 6, critChance: 5, detectionRange: 7, xpValue: 35 },
  { name: "Specter",     symbol: "P", color: "#aaddff", minDepth: 3, maxHp: 60, attack: 15, defense: 5, critChance: 8, detectionRange: 8, xpValue: 40 },
  { name: "Centaur",     symbol: "C", color: "#dd8833", minDepth: 3, maxHp: 65, attack: 14, defense: 7, critChance: 5, detectionRange: 7, xpValue: 38 },

  /* Depth 4+ */
  { name: "Minotaur",  symbol: "M", color: "#cc6633", minDepth: 4, maxHp: 85, attack: 16, defense: 8, critChance: 5, detectionRange: 8, xpValue: 55 },
  { name: "Dark Mage", symbol: "D", color: "#9966ff", minDepth: 5, maxHp: 70, attack: 18, defense: 5, critChance: 7, detectionRange: 8, xpValue: 65 },
];

function createMonster(tmpl: MonsterTemplate, x: number, y: number,
                        depth: number): Monster {
  const hpScale = 1.0 + (depth - 1) * 0.4;
  const atkScale = 1.0 + (depth - 1) * 0.3;

  return {
    name: depth >= 7 ? "Elite " + tmpl.name : tmpl.name,
    symbol: tmpl.symbol,
    color: tmpl.color,
    x, y,
    maxHp: Math.floor(tmpl.maxHp * hpScale),
    hp: Math.floor(tmpl.maxHp * hpScale),
    attack: Math.floor(tmpl.attack * atkScale),
    defense: tmpl.defense,
    critChance: tmpl.critChance,
    detectionRange: tmpl.detectionRange,
    xpValue: tmpl.xpValue,
    alive: true,
    awareOfPlayer: false,
  };
}

export function spawnMonsters(dungeon: Dungeon, depth: number,
                               rng: MT19937): Monster[] {
  const eligible = TEMPLATES.filter(t => t.minDepth <= depth);
  if (eligible.length === 0) return [];

  const count = 8 + depth * 2;
  const monsters: Monster[] = [];

  // Collect floor tiles.
  const floors: [number, number][] = [];
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++)
      if (dungeon.getTile(x, y) === Tile.Floor)
        floors.push([x, y]);

  if (floors.length === 0) return [];

  const occupied: [number, number][] = [];

  for (let i = 0; i < count && floors.length > 0; i++) {
    const tmpl = eligible[rng.nextInt(eligible.length)];
    const posIdx = rng.nextInt(floors.length);
    const [mx, my] = floors[posIdx];

    let taken = false;
    for (const [ox, oy] of occupied) {
      if (ox === mx && oy === my) { taken = true; break; }
    }
    if (taken) continue;

    monsters.push(createMonster(tmpl, mx, my, depth));
    occupied.push([mx, my]);
  }

  return monsters;
}
