/**
 * Dungeon game session — TS port of dungeongame.cpp.
 * Manages a complete dungeon play session with turn-based actions.
 */

import { MT19937 } from "./rng.js";
import { hashSeedSync } from "./hash.js";
import { Dungeon, Tile, WIDTH, HEIGHT } from "./dungeon.js";
import { Monster, spawnMonsters } from "./monsters.js";
import { PlayerStats, playerAttackMonster, monsterAttackPlayer } from "./combat.js";
import { lookupItem, getSpawnableItems } from "./items.js";

export interface GroundItem {
  x: number;
  y: number;
  itemId: string;
  quantity: number;
}

export interface CollectedItem {
  itemId: string;
  quantity: number;
}

export type ActionType = "move" | "pickup" | "use" | "gate" | "wait";

export interface GameAction {
  type: ActionType;
  dx?: number;
  dy?: number;
  itemId?: string;
}

export interface GameMessage {
  text: string;
  type: "combat" | "pickup" | "info" | "warning";
}

export class DungeonSession {
  dungeon: Dungeon;
  rng: MT19937;

  playerX: number = 0;
  playerY: number = 0;
  playerHp: number = 100;
  playerMaxHp: number = 100;
  stats: PlayerStats;

  monsters: Monster[] = [];
  groundItems: GroundItem[] = [];
  loot: CollectedItem[] = [];

  turnCount: number = 0;
  totalXp: number = 0;
  totalGold: number = 0;
  totalKills: number = 0;

  gameOver: boolean = false;
  survived: boolean = false;
  exitGate: string = "";
  depth: number;

  messages: GameMessage[] = [];

  constructor(seed: string, depth: number, stats: PlayerStats,
              hp: number, maxHp: number, startingPotions: CollectedItem[] = []) {
    this.depth = depth;
    this.stats = stats;
    this.playerHp = hp;
    this.playerMaxHp = maxHp;

    // Seed the RNG — must match C++ dungeongame.cpp.
    this.rng = new MT19937(hashSeedSync(seed + ":game:" + depth));

    // Generate dungeon.
    this.dungeon = Dungeon.generate(seed, depth);

    // Player starts at center of first room.
    if (this.dungeon.rooms.length > 0) {
      const r = this.dungeon.rooms[0];
      this.playerX = r.x + Math.floor(r.width / 2);
      this.playerY = r.y + Math.floor(r.height / 2);
    }

    // Spawn monsters (must match C++ order).
    this.monsters = spawnMonsters(this.dungeon, depth, this.rng);
    // Remove monsters too close to player.
    this.monsters = this.monsters.filter(m =>
      Math.abs(m.x - this.playerX) + Math.abs(m.y - this.playerY) >= 5
    );

    // Spawn ground items.
    this.spawnGroundItems();

    // Starting potions.
    for (const p of startingPotions) {
      if (p.quantity > 0) {
        this.loot.push({ ...p });
      }
    }

    this.addMessage("You enter the dungeon. Depth " + depth + ".", "info");
  }

  addMessage(text: string, type: GameMessage["type"]): void {
    this.messages.push({ text, type });
    if (this.messages.length > 50) this.messages.shift();
  }

  processAction(action: GameAction): boolean {
    if (this.gameOver) return false;

    let valid = false;

    switch (action.type) {
      case "move": {
        const dx = action.dx ?? 0;
        const dy = action.dy ?? 0;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0))
          return false;

        const nx = this.playerX + dx;
        const ny = this.playerY + dy;

        // Attack monster?
        const target = this.monsterAt(nx, ny);
        if (target) {
          const result = playerAttackMonster(this.stats, target.defense, this.rng);
          if (result.hit) {
            target.hp -= result.damage;
            const critText = result.critical ? " CRIT!" : "";
            this.addMessage(
              `You hit ${target.name} for ${result.damage}${critText}`, "combat");
            if (target.hp <= 0) {
              target.alive = false;
              this.totalXp += target.xpValue;
              this.totalKills++;
              this.addMessage(`${target.name} defeated! +${target.xpValue} XP`, "combat");

              // Monster drops (35% chance).
              if (this.rng.nextRange(1, 100) <= 35) {
                const dropRoll = this.rng.nextRange(1, 100);
                let dropId: string;
                let dropQty: number;

                if (dropRoll <= 50) {
                  dropId = "gold_coins";
                  dropQty = this.rng.nextRange(1, 5 + this.depth * 3);
                } else if (dropRoll <= 75) {
                  dropId = "health_potion";
                  dropQty = 1;
                } else {
                  const spawnable = getSpawnableItems(this.depth);
                  if (spawnable.length > 0) {
                    dropId = spawnable[this.rng.nextInt(spawnable.length)].id;
                    dropQty = 1;
                  } else {
                    dropId = "health_potion";
                    dropQty = 1;
                  }
                }

                this.groundItems.push({
                  x: target.x, y: target.y,
                  itemId: dropId, quantity: dropQty,
                });
                const def = lookupItem(dropId);
                this.addMessage(`${target.name} dropped ${def?.name ?? dropId}!`, "pickup");
              }
            }
          } else {
            this.addMessage(`You miss ${target.name}!`, "combat");
          }
          valid = true;
        } else if (this.isWalkable(nx, ny)) {
          this.playerX = nx;
          this.playerY = ny;
          valid = true;
        } else {
          return false;
        }
        break;
      }

      case "pickup": {
        const item = this.itemAt(this.playerX, this.playerY);
        if (!item) return false;

        if (item.itemId === "gold_coins") {
          this.totalGold += item.quantity;
          this.addMessage(`Picked up ${item.quantity} gold`, "pickup");
        } else {
          const existing = this.loot.find(l => l.itemId === item.itemId);
          if (existing) {
            existing.quantity += item.quantity;
          } else {
            this.loot.push({ itemId: item.itemId, quantity: item.quantity });
          }
          const def = lookupItem(item.itemId);
          this.addMessage(`Picked up ${def?.name ?? item.itemId}`, "pickup");
        }

        this.groundItems = this.groundItems.filter(gi =>
          !(gi.x === this.playerX && gi.y === this.playerY
            && gi.itemId === item.itemId));
        valid = true;
        break;
      }

      case "use": {
        const itemId = action.itemId ?? "health_potion";
        const def = lookupItem(itemId);
        if (!def || !def.consumable || def.healAmount <= 0) return false;

        const lootEntry = this.loot.find(l => l.itemId === itemId && l.quantity > 0);
        if (!lootEntry) return false;

        lootEntry.quantity--;
        this.playerHp = Math.min(this.playerHp + def.healAmount, this.playerMaxHp);
        this.addMessage(`Used ${def.name}. HP restored by ${def.healAmount}.`, "info");
        valid = true;
        break;
      }

      case "gate": {
        if (this.dungeon.getTile(this.playerX, this.playerY) !== Tile.Gate)
          return false;

        for (const gate of this.dungeon.gates) {
          if (gate.x === this.playerX && gate.y === this.playerY) {
            this.exitGate = gate.direction;
            break;
          }
        }
        this.gameOver = true;
        this.survived = true;
        this.addMessage(`You exit through the ${this.exitGate} gate!`, "info");
        valid = true;
        break;
      }

      case "wait":
        valid = true;
        break;
    }

    if (!valid) return false;

    this.turnCount++;

    // Monsters act.
    if (!this.gameOver) {
      this.processMonsterTurns();
    }

    return true;
  }

  private processMonsterTurns(): void {
    for (const m of this.monsters) {
      if (!m.alive) continue;
      this.monsterAct(m);
      if (this.gameOver) return;
    }
  }

  private monsterAct(m: Monster): void {
    const dist = Math.abs(m.x - this.playerX) + Math.abs(m.y - this.playerY);

    // Check awareness.
    if (!m.awareOfPlayer && dist <= m.detectionRange
        && this.hasLineOfSight(m.x, m.y, this.playerX, this.playerY)) {
      m.awareOfPlayer = true;
    }

    if (!m.awareOfPlayer) {
      // Random movement (25% chance).
      if (this.rng.nextRange(1, 4) === 1) {
        const dx = this.rng.nextRange(-1, 1);
        const dy = this.rng.nextRange(-1, 1);
        const nx = m.x + dx;
        const ny = m.y + dy;
        if (nx >= 0 && nx < WIDTH && ny >= 0 && ny < HEIGHT
            && this.dungeon.getTile(nx, ny) !== Tile.Wall
            && !(nx === this.playerX && ny === this.playerY)
            && !this.monsterAt(nx, ny)) {
          m.x = nx;
          m.y = ny;
        }
      }
      return;
    }

    // Adjacent? Attack.
    if (Math.abs(m.x - this.playerX) <= 1 && Math.abs(m.y - this.playerY) <= 1) {
      const result = monsterAttackPlayer(m.attack, m.critChance, this.stats, this.rng);
      if (result.hit) {
        this.playerHp -= result.damage;
        const critText = result.critical ? " CRIT!" : "";
        this.addMessage(
          `${m.name} hits you for ${result.damage}${critText}`, "combat");
        if (this.playerHp <= 0) {
          this.playerHp = 0;
          this.gameOver = true;
          this.survived = false;
          this.addMessage("You have been slain!", "warning");
        }
      } else {
        this.addMessage(`${m.name} misses you`, "combat");
      }
      return;
    }

    // Move toward player.
    let bestDist = dist;
    let bestX = m.x, bestY = m.y;
    for (let ddx = -1; ddx <= 1; ddx++) {
      for (let ddy = -1; ddy <= 1; ddy++) {
        if (ddx === 0 && ddy === 0) continue;
        const nx = m.x + ddx;
        const ny = m.y + ddy;
        if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) continue;
        if (this.dungeon.getTile(nx, ny) === Tile.Wall) continue;
        if (nx === this.playerX && ny === this.playerY) continue;
        if (this.monsterAt(nx, ny)) continue;
        const d = Math.abs(nx - this.playerX) + Math.abs(ny - this.playerY);
        if (d < bestDist) {
          bestDist = d;
          bestX = nx;
          bestY = ny;
        }
      }
    }
    m.x = bestX;
    m.y = bestY;
  }

  private isWalkable(x: number, y: number): boolean {
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return false;
    if (this.dungeon.getTile(x, y) === Tile.Wall) return false;
    for (const m of this.monsters)
      if (m.alive && m.x === x && m.y === y) return false;
    return true;
  }

  private monsterAt(x: number, y: number): Monster | null {
    for (const m of this.monsters)
      if (m.alive && m.x === x && m.y === y) return m;
    return null;
  }

  private itemAt(x: number, y: number): GroundItem | null {
    for (const gi of this.groundItems)
      if (gi.x === x && gi.y === y) return gi;
    return null;
  }

  private hasLineOfSight(x1: number, y1: number, x2: number, y2: number): boolean {
    let dx = Math.abs(x2 - x1);
    let dy = -Math.abs(y2 - y1);
    const sx = x1 < x2 ? 1 : -1;
    const sy = y1 < y2 ? 1 : -1;
    let err = dx + dy;
    let cx = x1, cy = y1;

    while (cx !== x2 || cy !== y2) {
      if (this.dungeon.getTile(cx, cy) === Tile.Wall && !(cx === x1 && cy === y1))
        return false;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; cx += sx; }
      if (e2 <= dx) { err += dx; cy += sy; }
    }
    return true;
  }

  private spawnGroundItems(): void {
    const count = this.rng.nextRange(6, 12);
    const spawnable = getSpawnableItems(this.depth);

    for (let i = 0; i < count; i++) {
      const [x, y] = this.dungeon.getRandomFloorPosition(this.rng);
      if (x < 0) continue;
      if (x === this.playerX && y === this.playerY) continue;

      const roll = this.rng.nextRange(1, 100);
      let itemId: string;
      let qty: number;

      if (roll <= 30) {
        itemId = "gold_coins";
        qty = this.rng.nextRange(1 + this.depth, 5 + this.depth * 3);
      } else if (roll <= 55) {
        itemId = "health_potion";
        qty = 1;
      } else if (spawnable.length > 0) {
        itemId = spawnable[this.rng.nextInt(spawnable.length)].id;
        qty = 1;
      } else {
        continue;
      }

      this.groundItems.push({ x, y, itemId, quantity: qty });
    }
  }
}
