/**
 * Dungeon game session — TS port of dungeongame.cpp.
 *
 * The engine holds N participants (docs/SPEC_multiplayer_coop.md in the
 * backend repo): rounds of one action per active participant in canonical
 * order, then one monster pass.  The long-standing single-player surface
 * (playerX, playerHp, processAction(action), ...) is preserved as a view of
 * participant 0, and with one participant every code path degenerates to
 * the original solo behaviour byte-for-byte (this is consensus: settled
 * solo runs re-verify against the C++ twin of this class).
 */

import { MT19937 } from "./rng.js";
import { hashSeedSync } from "./hash.js";
import { Dungeon, Gate, Tile, WIDTH, HEIGHT } from "./dungeon.js";
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

/**
 * An already-settled inventory item known at run start (bag + equipped),
 * mirroring the on-chain `inventory` rows.  Only these items can be
 * equipped/unequipped mid-run; this-run pickups (`loot`/`collected`) cannot.
 */
export interface EntryInvItem {
  rowid: number;
  itemId: string;
  slot: string;
}

/** A gear item currently occupying an equipment slot. */
export interface EquippedItem {
  rowid: number;
  itemId: string;
}

/** A settled item sitting in the bag, available to equip mid-run. */
export interface BagItem {
  rowid: number;
  itemId: string;
}

export type ActionType =
  "move" | "pickup" | "use" | "gate" | "wait" | "equip" | "unequip";

export interface GameAction {
  type: ActionType;
  dx?: number;
  dy?: number;
  itemId?: string;
  /** Inventory rowid for equip/unequip. */
  rowid?: number;
  /** Target equipment slot for equip. */
  slot?: string;
}

/**
 * One entry of a multiplayer merged action log: which participant
 * (canonical index) performed the action.  Mirrors C++ LoggedAction.
 */
export interface LoggedAction {
  actor: number;
  action: GameAction;
}

/**
 * Everything one participant carries into a run.  `stats` arrive ALREADY
 * effective (base + entry-equipped bonuses).  Mirrors C++ PlayerSetup.
 */
export interface PlayerSetup {
  stats: PlayerStats;
  hp: number;
  maxHp: number;
  potions?: CollectedItem[];
  inventory?: EntryInvItem[];
  /** Entry gate direction ("" = spawn at the room centre / ring). */
  entryDir?: string;
  /** Display name for messages (not part of consensus). */
  name?: string;
}

/**
 * Per-participant state.  `loot` holds this-run pickups plus carried
 * potions (never equippable); `bag` is the banked un-equipped inventory
 * carried in.  Mirrors C++ PlayerState.
 */
export interface PlayerState {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  stats: PlayerStats;
  equipped: Map<string, EquippedItem>;
  bag: BagItem[];
  totalXp: number;
  totalGold: number;
  totalKills: number;
  /**
   * Total damage dealt to monsters, capped at each target's remaining HP
   * (spec section 5): the basis of the pro-rata pool split at settlement.
   */
  damageDealt: number;
  loot: CollectedItem[];
  /**
   * Items picked up during this run, tracked separately from `loot`
   * (which is seeded with carried potions and decremented as they are
   * drunk).  Display-only; not part of determinism.
   */
  collected: CollectedItem[];
  dead: boolean;
  exited: boolean;
  /**
   * Marked absent by an abandonment settle (spec section 11): inactive
   * from that point on, banked as a forfeit.
   */
  absent: boolean;
  /** Direction of the exit gate, or "". */
  exitGate: string;
  /** Display name for messages. */
  name: string;
}

/** maxHp = BASE_HP + effectiveConstitution*HP_PER_CON (must match items.cpp). */
const BASE_HP = 50;
const HP_PER_CON = 5;

export interface GameMessage {
  text: string;
  type: "combat" | "pickup" | "info" | "warning";
}

function newPlayerState(name: string): PlayerState {
  return {
    x: 0, y: 0, hp: 0, maxHp: 0,
    stats: {
      level: 1, strength: 0, dexterity: 0, constitution: 0, intelligence: 0,
      equipAttack: 0, equipDefense: 0,
    },
    equipped: new Map(), bag: [],
    totalXp: 0, totalGold: 0, totalKills: 0, damageDealt: 0,
    loot: [], collected: [],
    dead: false, exited: false, absent: false, exitGate: "",
    name,
  };
}

export class DungeonSession {
  dungeon!: Dungeon;
  rng!: MT19937;

  /** Participants in canonical order (index = canonical index). */
  players: PlayerState[] = [];

  /** Next participant expected to act (round structure, spec section 2). */
  curTurn: number = 0;

  monsters: Monster[] = [];
  groundItems: GroundItem[] = [];

  turnCount: number = 0;

  /**
   * Run-level kill-reward pools (spec sections 5/5a).  XP accrues here for
   * every kill in addition to the killer's own counter; monster gold drops
   * accrue here instead of the floor ONLY with more than one participant
   * (solo keeps floor drops: solo replay must stay byte-identical).
   */
  xpPool: number = 0;
  killGoldPool: number = 0;

  gameOver: boolean = false;
  depth: number = 0;

  messages: GameMessage[] = [];

  /** Action log for replay verification proof (solo view, no actor). */
  actionLog: GameAction[] = [];

  /** Same history with actor indices (multiplayer merged log). */
  mergedLog: LoggedAction[] = [];

  /**
   * Single-player constructor (original API, byte-identical behaviour):
   * builds one participant and delegates to the shared initialiser.
   */
  constructor(seed: string, depth: number, stats: PlayerStats,
              hp: number, maxHp: number, startingPotions: CollectedItem[] = [],
              constraints: Gate[] = [], entryDirection: string = "",
              entryInventory: EntryInvItem[] = []) {
    this.init(seed, depth, [{
      stats, hp, maxHp, potions: startingPotions, inventory: entryInventory,
      entryDir: entryDirection,
    }], constraints);
  }

  /**
   * Creates a session with N participants in canonical order.  Mirrors
   * DungeonGame::CreateMulti.
   */
  static createMulti(seed: string, depth: number, setups: PlayerSetup[],
                     constraints: Gate[] = []): DungeonSession {
    const s: DungeonSession = Object.create(DungeonSession.prototype);
    s.players = [];
    s.curTurn = 0;
    s.monsters = [];
    s.groundItems = [];
    s.turnCount = 0;
    s.xpPool = 0;
    s.killGoldPool = 0;
    s.gameOver = false;
    s.messages = [];
    s.actionLog = [];
    s.mergedLog = [];
    s.init(seed, depth, setups, constraints);
    return s;
  }

  /**
   * Replays a merged multiplayer log on a fresh session.  Stops at the
   * first invalid action (including a wrong-turn actor), like the GSP.
   * Mirrors DungeonGame::ReplayMulti.
   */
  static replayMulti(seed: string, depth: number, setups: PlayerSetup[],
                     log: LoggedAction[], constraints: Gate[] = []): DungeonSession {
    const s = DungeonSession.createMulti(seed, depth, setups, constraints);
    for (const la of log)
      if (!s.processActionBy(la.actor, la.action)) break;
    return s;
  }

  private init(seed: string, depth: number, setups: PlayerSetup[],
               constraints: Gate[]): void {
    this.depth = depth;
    this.players = [];

    for (let i = 0; i < setups.length; i++) {
      const su = setups[i];
      const p = newPlayerState(su.name ?? (setups.length > 1 ? `P${i}` : ""));
      p.stats = su.stats;
      p.hp = su.hp;
      p.maxHp = su.maxHp;

      // Seed the settled loadout from the on-chain inventory (ORDER BY rowid
      // asc on the caller side).  `stats` arrives ALREADY effective (base +
      // entry-equipped); equip/unequip mutate it by deltas, never re-derived.
      for (const e of su.inventory ?? []) {
        if (e.slot === "bag") p.bag.push({ rowid: e.rowid, itemId: e.itemId });
        else p.equipped.set(e.slot, { rowid: e.rowid, itemId: e.itemId });
      }
      this.players.push(p);
    }

    this.turnCount = 0;
    this.gameOver = false;
    this.curTurn = 0;

    // Seed the RNG — must match C++ dungeongame.cpp.
    this.rng = new MT19937(hashSeedSync(seed + ":game:" + depth));

    // Generate dungeon.  When the segment was discovered with a gate
    // aligned to its neighbour, regenerate with that same constraint so the
    // layout matches the GSP replay byte-for-byte.
    this.dungeon = Dungeon.generate(seed, depth, constraints);

    // Place the participants in canonical order (draws no RNG).
    for (let i = 0; i < setups.length; i++)
      this.placePlayer(i, setups[i].entryDir ?? "");

    // Spawn monsters (must match C++ order).
    this.monsters = spawnMonsters(this.dungeon, depth, this.rng);
    // Remove any monster that spawned on or near any participant.
    this.monsters = this.monsters.filter(m => {
      for (const p of this.players)
        if (Math.abs(m.x - p.x) + Math.abs(m.y - p.y) < 5) return false;
      return true;
    });

    // Spawn ground items.
    this.spawnGroundItems();

    // Each participant's starting potions go into their session loot.
    for (let i = 0; i < setups.length; i++)
      for (const pot of setups[i].potions ?? [])
        if (pot.quantity > 0) this.players[i].loot.push({ ...pot });

    this.addMessage("You enter the dungeon. Depth " + depth + ".", "info");
  }

  /**
   * Places participant i on entry (spec section 2a): gate spawn, or a
   * deterministic ring scan around the first room's centre.  Draws no RNG.
   * Mirrors DungeonGame::PlacePlayer.
   */
  private placePlayer(i: number, entryDir: string): void {
    const p = this.players[i];

    const taken = (x: number, y: number): boolean => {
      for (let j = 0; j < i; j++)
        if (this.players[j].x === x && this.players[j].y === y) return true;
      return false;
    };

    // Gate entry: the tile one step inward from that gate.
    let cx = 0, cy = 0;
    let fromGate = false;
    if (entryDir) {
      const gate = this.dungeon.gates.find(g => g.direction === entryDir);
      if (gate) {
        cx = gate.x;
        cy = gate.y;
        if (entryDir === "north") cy += 1;
        else if (entryDir === "south") cy -= 1;
        else if (entryDir === "east") cx -= 1;
        else if (entryDir === "west") cx += 1;
        fromGate = true;
      }
    }

    if (!fromGate) {
      if (this.dungeon.rooms.length > 0) {
        const r = this.dungeon.rooms[0];
        cx = r.x + Math.floor(r.width / 2);
        cy = r.y + Math.floor(r.height / 2);
      } else {
        cx = Math.floor(WIDTH / 2);
        cy = Math.floor(HEIGHT / 2);
      }
    }

    // The first participant to claim this spot takes it: for a gate entry
    // that is the gate mouth (solo behaviour, byte-identical, deliberately
    // without a wall check so an existing settled run cannot change its
    // spawn), for a centre entry the room centre.
    if (!taken(cx, cy)) {
      p.x = cx;
      p.y = cy;
      return;
    }

    // Contested: a later participant scans outward in a deterministic ring
    // order (spec section 2a): radius 1, 2, ... with dy-major, dx-minor
    // iteration, first in-bounds non-wall tile not already occupied.  Draws
    // no RNG.  Two participants who entered through the SAME gate land here,
    // as do later participants sharing the room centre.
    for (let r = 1; r < Math.max(WIDTH, HEIGHT); r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) continue;
          if (this.dungeon.getTile(nx, ny) === Tile.Wall) continue;
          if (taken(nx, ny)) continue;
          p.x = nx;
          p.y = ny;
          return;
        }
      }
    }

    // Unreachable in practice; keep the anchor as a last resort.
    p.x = cx;
    p.y = cy;
  }

  /**
   * Creates a hub session (segment 0): empty 80x40 room with 4 gates,
   * no monsters, no items, no combat.  Used as the default view when
   * the player is at the hub (not in a real dungeon session).
   */
  static createHub(
    stats: PlayerStats, hp: number, maxHp: number,
    entryDirection: string = "",
  ): DungeonSession {
    const s: DungeonSession = Object.create(DungeonSession.prototype);
    s.depth = 0;
    s.rng = new MT19937(0);  // unused — no procedural content
    s.dungeon = Dungeon.buildHub();

    const p = newPlayerState("");
    p.stats = stats;
    p.hp = hp;
    p.maxHp = maxHp;
    s.players = [p];
    s.curTurn = 0;

    // Spawn one tile inside the gate we entered through (so arriving back
    // at the hub feels like stepping through the door), else room centre.
    // The hub is never replayed, so this is purely cosmetic.
    let spawned = false;
    if (entryDirection) {
      const gate = s.dungeon.gates.find(g => g.direction === entryDirection);
      if (gate) {
        p.x = gate.x;
        p.y = gate.y;
        if (entryDirection === "north") p.y += 1;
        else if (entryDirection === "south") p.y -= 1;
        else if (entryDirection === "east") p.x -= 1;
        else if (entryDirection === "west") p.x += 1;
        spawned = true;
      }
    }
    if (!spawned) {
      const r = s.dungeon.rooms[0];
      p.x = r.x + Math.floor(r.width / 2);
      p.y = r.y + Math.floor(r.height / 2);
    }

    s.monsters = [];
    s.groundItems = [];
    s.turnCount = 0;
    s.xpPool = 0;
    s.killGoldPool = 0;
    s.gameOver = false;
    s.messages = [];
    s.actionLog = [];
    s.mergedLog = [];
    s.addMessage("Welcome to the hub. Walk to a gate to head out.", "info");
    return s;
  }

  // --- Solo view of participant 0 (original API) -------------------------

  get playerX(): number { return this.players[0].x; }
  get playerY(): number { return this.players[0].y; }
  get playerHp(): number { return this.players[0].hp; }
  get playerMaxHp(): number { return this.players[0].maxHp; }
  get stats(): PlayerStats { return this.players[0].stats; }
  get equipped(): Map<string, EquippedItem> { return this.players[0].equipped; }
  get bag(): BagItem[] { return this.players[0].bag; }
  get loot(): CollectedItem[] { return this.players[0].loot; }
  get collected(): CollectedItem[] { return this.players[0].collected; }
  get totalXp(): number { return this.players[0].totalXp; }
  get totalGold(): number { return this.players[0].totalGold; }
  get totalKills(): number { return this.players[0].totalKills; }
  get survived(): boolean { return this.players[0].exited; }
  get exitGate(): string { return this.players[0].exitGate; }

  // --- Multiplayer accessors ---------------------------------------------

  get playerCount(): number { return this.players.length; }
  /** Next participant expected to act. */
  get nextActor(): number { return this.curTurn; }
  isPlayerActive(i: number): boolean { return this.isActive(i); }

  addMessage(text: string, type: GameMessage["type"]): void {
    this.messages.push({ text, type });
    if (this.messages.length > 50) this.messages.shift();
  }

  /** "You" in solo, the participant's name otherwise. */
  private who(i: number): string {
    return this.players.length > 1 ? this.players[i].name : "You";
  }

  private isActive(i: number): boolean {
    const p = this.players[i];
    return !p.dead && !p.exited && !p.absent;
  }

  /**
   * Marks participant i absent (spec section 11): they take no further
   * part, monsters ignore them, and they are banked as not having exited.
   * If it was their turn, the turn passes on exactly as if they had been
   * skipped; if they were the last active participant of the round, the
   * monsters act.  Mirrors DungeonGame::MarkAbsent byte for byte.
   */
  markAbsent(i: number): void {
    if (i < 0 || i >= this.players.length || !this.isActive(i)) return;
    this.players[i].absent = true;

    if (this.firstActive() === -1) {
      this.gameOver = true;
      return;
    }

    if (this.curTurn === i) {
      const next = this.nextActiveAfter(i);
      if (next === -1) {
        this.processMonsterTurns();
        const first = this.firstActive();
        this.curTurn = first === -1 ? 0 : first;
      } else {
        this.curTurn = next;
      }
    }
  }

  private firstActive(): number {
    for (let i = 0; i < this.players.length; i++)
      if (this.isActive(i)) return i;
    return -1;
  }

  private nextActiveAfter(i: number): number {
    for (let j = i + 1; j < this.players.length; j++)
      if (this.isActive(j)) return j;
    return -1;
  }

  /** Active participant occupying (x,y), or -1. */
  private playerAt(x: number, y: number): number {
    for (let i = 0; i < this.players.length; i++)
      if (this.isActive(i) && this.players[i].x === x && this.players[i].y === y)
        return i;
    return -1;
  }

  /** Solo shorthand: participant 0 acts (original API). */
  processAction(action: GameAction): boolean {
    return this.processActionBy(0, action);
  }

  /**
   * Processes one action by participant `actor`.  Returns false (turn not
   * consumed, nothing logged) if the action is invalid or it is not this
   * participant's turn under the round structure.  After the last active
   * participant of a round acts, monsters take their turn.  Mirrors
   * DungeonGame::ProcessAction.
   */
  processActionBy(actor: number, action: GameAction): boolean {
    if (this.gameOver) return false;

    // Round structure (spec section 2): only the expected participant may
    // act.  With one participant this is always index 0.
    if (actor < 0 || actor >= this.players.length) return false;
    if (actor !== this.curTurn || !this.isActive(actor)) return false;

    const p = this.players[actor];
    let valid = false;

    switch (action.type) {
      case "move": {
        const dx = action.dx ?? 0;
        const dy = action.dy ?? 0;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0))
          return false;

        const nx = p.x + dx;
        const ny = p.y + dy;

        // Attack monster?
        const target = this.monsterAt(nx, ny);
        if (target) {
          const result = playerAttackMonster(p.stats, target.defense, this.rng);
          if (result.hit) {
            // Contribution is capped at the target's remaining HP so
            // overkill does not inflate the pro-rata split (spec section 5).
            p.damageDealt += Math.min(result.damage, target.hp);
            target.hp -= result.damage;
            const critText = result.critical ? " CRIT!" : "";
            this.addMessage(
              `${this.who(actor)} hit ${target.name} for ${result.damage}${critText}`, "combat");
            if (target.hp <= 0) {
              target.alive = false;
              // XP per kill scales with depth so pushing deeper levels
              // faster: floor(xpValue * (1 + (depth-1) * 0.15)).  The award
              // goes to the killer's own counter (what solo claims verify
              // against) AND the run pool (the multiplayer pro-rata split).
              const xpGain = Math.floor(
                target.xpValue * (1.0 + (this.depth - 1) * 0.15));
              p.totalXp += xpGain;
              this.xpPool += xpGain;
              p.totalKills++;
              this.addMessage(`${target.name} defeated! +${xpGain} XP`, "combat");

              // Monster drops (35% chance).
              if (this.rng.nextRange(1, 100) <= 35) {
                const dropRoll = this.rng.nextRange(1, 100);
                if (dropRoll <= 50) {
                  // Gold.  Multiplayer: to the kill-gold pool for the
                  // pro-rata split.  Solo: to the floor, byte-identical to
                  // the original behaviour.
                  const amt = this.rng.nextRange(1, 5 + this.depth * 3);
                  if (this.players.length > 1) {
                    this.killGoldPool += amt;
                    this.addMessage(`${target.name} dropped ${amt} gold into the party pool`, "pickup");
                  } else {
                    this.groundItems.push({
                      x: target.x, y: target.y, itemId: "gold_coins", quantity: amt,
                    });
                    this.addMessage(`${target.name} dropped Gold Coins!`, "pickup");
                  }
                } else if (dropRoll <= 75) {
                  this.groundItems.push({
                    x: target.x, y: target.y, itemId: "health_potion", quantity: 1,
                  });
                  this.addMessage(`${target.name} dropped Health Potion!`, "pickup");
                } else {
                  // Random equipment.
                  const spawnable = getSpawnableItems(this.depth);
                  if (spawnable.length > 0) {
                    const dropId = spawnable[this.rng.nextInt(spawnable.length)].id;
                    this.groundItems.push({
                      x: target.x, y: target.y, itemId: dropId, quantity: 1,
                    });
                    const def = lookupItem(dropId);
                    this.addMessage(`${target.name} dropped ${def?.name ?? dropId}!`, "pickup");
                  }
                }
              }
            }
          } else {
            this.addMessage(`${this.who(actor)} miss${this.players.length > 1 ? "es" : ""} ${target.name}!`, "combat");
          }
          valid = true;
        } else if (this.isWalkable(nx, ny, actor)) {
          p.x = nx;
          p.y = ny;
          valid = true;
        } else {
          return false;
        }
        break;
      }

      case "pickup": {
        const item = this.itemAt(p.x, p.y);
        if (!item) return false;

        if (item.itemId === "gold_coins") {
          p.totalGold += item.quantity;
          this.addMessage(`${this.who(actor)} picked up ${item.quantity} gold`, "pickup");
        } else {
          const existing = p.loot.find(l => l.itemId === item.itemId);
          if (existing) {
            existing.quantity += item.quantity;
          } else {
            p.loot.push({ itemId: item.itemId, quantity: item.quantity });
          }
          const got = p.collected.find(l => l.itemId === item.itemId);
          if (got) got.quantity += item.quantity;
          else p.collected.push({ itemId: item.itemId, quantity: item.quantity });
          const def = lookupItem(item.itemId);
          this.addMessage(`${this.who(actor)} picked up ${def?.name ?? item.itemId}`, "pickup");
        }

        const px = p.x, py = p.y, pickedId = item.itemId;
        this.groundItems = this.groundItems.filter(gi =>
          !(gi.x === px && gi.y === py && gi.itemId === pickedId));
        valid = true;
        break;
      }

      case "use": {
        const itemId = action.itemId ?? "health_potion";
        const def = lookupItem(itemId);
        if (!def || !def.consumable || def.healAmount <= 0) return false;

        const lootEntry = p.loot.find(l => l.itemId === itemId && l.quantity > 0);
        if (!lootEntry) return false;

        lootEntry.quantity--;
        p.hp = Math.min(p.hp + def.healAmount, p.maxHp);
        this.addMessage(`${this.who(actor)} used ${def.name}. HP restored by ${def.healAmount}.`, "info");
        valid = true;
        break;
      }

      case "gate": {
        if (this.dungeon.getTile(p.x, p.y) !== Tile.Gate)
          return false;

        for (const gate of this.dungeon.gates) {
          if (gate.x === p.x && gate.y === p.y) {
            p.exitGate = gate.direction;
            break;
          }
        }
        p.exited = true;
        if (this.firstActive() === -1) this.gameOver = true;
        this.addMessage(`${this.who(actor)} exit${this.players.length > 1 ? "s" : ""} through the ${p.exitGate} gate!`, "info");
        valid = true;
        break;
      }

      case "equip": {
        const rowid = action.rowid ?? -1;
        const slot = action.slot ?? "";
        // 1. Must be a settled bag item (this-run pickups live in `loot`, not
        //    `bag`, so equipping them is auto-rejected).
        const idx = p.bag.findIndex(b => b.rowid === rowid);
        if (idx < 0) return false;
        const bagItem = p.bag[idx];
        // 2. Item def must exist and its slot must match the requested slot.
        const def = lookupItem(bagItem.itemId);
        if (!def || def.slot === "" || def.slot !== slot) return false;
        // 3. Displace whatever occupies the slot: subtract its bonuses, bag it.
        const old = p.equipped.get(slot);
        if (old) {
          this.applyItemStats(p, old.itemId, -1);
          p.bag.push({ rowid: old.rowid, itemId: old.itemId });
        }
        // 4. Remove the new item from the bag; add its bonuses; equip it.
        p.bag.splice(idx, 1);
        this.applyItemStats(p, bagItem.itemId, +1);
        p.equipped.set(slot, { rowid: bagItem.rowid, itemId: bagItem.itemId });
        // 5. Recompute maxHp cap (raise = no heal; lower = clamp current hp).
        this.recomputeMaxHp(p);
        this.addMessage(`${this.who(actor)} equipped ${def.name}.`, "info");
        valid = true;
        break;
      }

      case "unequip": {
        const rowid = action.rowid ?? -1;
        let foundSlot: string | null = null;
        for (const [s, it] of p.equipped) {
          if (it.rowid === rowid) { foundSlot = s; break; }
        }
        if (foundSlot === null) return false;
        const it = p.equipped.get(foundSlot)!;
        this.applyItemStats(p, it.itemId, -1);
        p.bag.push({ rowid: it.rowid, itemId: it.itemId });
        p.equipped.delete(foundSlot);
        this.recomputeMaxHp(p);
        const def = lookupItem(it.itemId);
        this.addMessage(`${this.who(actor)} unequipped ${def?.name ?? it.itemId}.`, "info");
        valid = true;
        break;
      }

      case "wait":
        valid = true;
        break;
    }

    if (!valid) return false;

    this.actionLog.push(action);
    this.mergedLog.push({ actor, action });
    this.turnCount++;

    // Round advance (spec section 2): after the last active participant of
    // the round, monsters act once; otherwise pass the turn along.  With
    // one participant this reduces to "monsters act after the player".
    const next = this.nextActiveAfter(actor);
    if (next === -1) {
      if (!this.gameOver) this.processMonsterTurns();
      const first = this.firstActive();
      this.curTurn = first === -1 ? 0 : first;
    } else {
      this.curTurn = next;
    }

    return true;
  }

  /**
   * Equip a settled bag item into a slot mid-run.  Immediate effect (this
   * run), recorded as a replayed action.  Costs a turn (monsters act), just
   * like drinking a potion.  Returns false (and does nothing) if invalid.
   */
  equip(rowid: number, slot: string): boolean {
    return this.processAction({ type: "equip", rowid, slot });
  }

  /** Unequip a worn item back to the bag mid-run.  Costs a turn. */
  unequip(rowid: number): boolean {
    return this.processAction({ type: "unequip", rowid });
  }

  /**
   * Adds (sign=+1) or subtracts (sign=-1) an item's six effective-stat
   * bonuses.  maxHealth is intentionally NOT applied here — maxHp derives
   * only from constitution (matches items.cpp ComputeEffectiveStats).
   */
  private applyItemStats(p: PlayerState, itemId: string, sign: number): void {
    const d = lookupItem(itemId);
    if (!d) return;
    p.stats.equipAttack += sign * d.attackPower;
    p.stats.equipDefense += sign * d.defense;
    p.stats.strength += sign * d.strength;
    p.stats.dexterity += sign * d.dexterity;
    p.stats.constitution += sign * d.constitution;
    p.stats.intelligence += sign * d.intelligence;
  }

  /** Recompute maxHp from constitution and clamp current hp down if needed. */
  private recomputeMaxHp(p: PlayerState): void {
    p.maxHp = BASE_HP + p.stats.constitution * HP_PER_CON;
    if (p.maxHp < p.hp) p.hp = p.maxHp;
  }

  private playerDied(i: number): void {
    const p = this.players[i];
    p.hp = 0;
    p.dead = true;
    if (this.firstActive() === -1) this.gameOver = true;
  }

  private processMonsterTurns(): void {
    for (const m of this.monsters) {
      if (!m.alive) continue;
      this.monsterAct(m);
      if (this.gameOver) return;
    }
  }

  private monsterAct(m: Monster): void {
    // Check awareness: any active participant in range with line of sight
    // (spec section 4).  Iterate in canonical order with an early out.
    if (!m.awareOfPlayer) {
      for (let i = 0; i < this.players.length; i++) {
        if (!this.isActive(i)) continue;
        const p = this.players[i];
        if (Math.abs(m.x - p.x) + Math.abs(m.y - p.y) <= m.detectionRange
            && this.hasLineOfSight(m.x, m.y, p.x, p.y)) {
          m.awareOfPlayer = true;
          break;
        }
      }
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
            && this.playerAt(nx, ny) === -1
            && !this.monsterAt(nx, ny)) {
          m.x = nx;
          m.y = ny;
        }
      }
      return;
    }

    // Monster is aware.  Target the nearest active participant by
    // Manhattan distance, ties to the lower index (spec section 4);
    // recomputed every act.
    let target = -1;
    let targetDist = 0;
    for (let i = 0; i < this.players.length; i++) {
      if (!this.isActive(i)) continue;
      const d = Math.abs(m.x - this.players[i].x) + Math.abs(m.y - this.players[i].y);
      if (target === -1 || d < targetDist) {
        target = i;
        targetDist = d;
      }
    }
    if (target === -1) return;

    const tp = this.players[target];

    // Adjacent (including diagonal)? Attack.
    if (Math.abs(m.x - tp.x) <= 1 && Math.abs(m.y - tp.y) <= 1) {
      const result = monsterAttackPlayer(m.attack, m.critChance, tp.stats, this.rng);
      const whom = this.players.length > 1 ? tp.name : "you";
      if (result.hit) {
        tp.hp -= result.damage;
        const critText = result.critical ? " CRIT!" : "";
        this.addMessage(
          `${m.name} hits ${whom} for ${result.damage}${critText}`, "combat");
        if (tp.hp <= 0) {
          this.playerDied(target);
          this.addMessage(
            this.players.length > 1 ? `${tp.name} has been slain!` : "You have been slain!",
            "warning");
        }
      } else {
        this.addMessage(`${m.name} misses ${whom}`, "combat");
      }
      return;
    }

    // Move toward the target (pick the adjacent tile that minimises
    // Manhattan distance).
    let bestDist = targetDist;
    let bestX = m.x, bestY = m.y;
    for (let ddx = -1; ddx <= 1; ddx++) {
      for (let ddy = -1; ddy <= 1; ddy++) {
        if (ddx === 0 && ddy === 0) continue;
        const nx = m.x + ddx;
        const ny = m.y + ddy;
        if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) continue;
        if (this.dungeon.getTile(nx, ny) === Tile.Wall) continue;
        if (this.playerAt(nx, ny) !== -1) continue;
        if (this.monsterAt(nx, ny)) continue;
        const d = Math.abs(nx - tp.x) + Math.abs(ny - tp.y);
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

  /** Walkable for participant `self`: no wall, monster, or other participant. */
  private isWalkable(x: number, y: number, self: number): boolean {
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return false;
    if (this.dungeon.getTile(x, y) === Tile.Wall) return false;
    for (const m of this.monsters)
      if (m.alive && m.x === x && m.y === y) return false;
    const occ = this.playerAt(x, y);
    if (occ !== -1 && occ !== self) return false;
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
      // Never on a participant's spawn tile.
      let onPlayer = false;
      for (const p of this.players)
        if (x === p.x && y === p.y) { onPlayer = true; break; }
      if (onPlayer) continue;

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
