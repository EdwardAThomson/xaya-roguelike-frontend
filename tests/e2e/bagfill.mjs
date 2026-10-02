/**
 * Plans one solo loot run in process, for filling a character's bag.
 *
 * `duel:evil` needs a player whose bag is full, to prove the GSP refuses a
 * duel whose winnings would not fit (backend PVP_item_staking_checklist.md
 * item 17). There is no debug "give item" on the devnet, and there should
 * not be, so the bag fills the honest way: walk into the arena, pick up
 * everything, walk out. The arena's seed does not change between visits, so
 * every run finds the same floor; this module plays one run against the
 * same engine the GSP replays and returns the log to submit.
 *
 * Pure: no chain, no network. The caller submits the result.
 */
import { DungeonSession } from "../../dist/game/session.js";
import { lookupItem } from "../../dist/game/items.js";
import { WIDTH, HEIGHT } from "../../dist/game/dungeon.js";
import { bfsStep } from "./agentcore.mjs";

/** The engine setup the GSP builds for `p` (a getplayerinfo result). */
export function setupFromPlayer(p, entryDir) {
  return {
    name: p.name,
    stats: {
      level: p.level,
      strength: p.effective_stats.strength,
      dexterity: p.effective_stats.dexterity,
      constitution: p.effective_stats.constitution,
      intelligence: p.effective_stats.intelligence,
      equipAttack: p.effective_stats.equip_attack,
      equipDefense: p.effective_stats.equip_defense,
    },
    hp: p.hp, maxHp: p.max_hp,
    potions: p.inventory
      .filter((i) => i.slot === "bag" && /health_potion/.test(i.item_id))
      .map((i) => ({ itemId: i.item_id, quantity: i.quantity })),
    inventory: p.inventory
      .map((i) => ({ rowid: i.rowid, itemId: i.item_id, slot: i.slot }))
      .sort((x, y) => x.rowid - y.rowid),
    entryDir,
  };
}

export function constraintsFor(seg) {
  if (!seg.constraint_dir) return [];
  const g = seg.gates?.[seg.constraint_dir];
  return g ? [{ x: g.x, y: g.y, direction: seg.constraint_dir }] : [];
}

/** Bag rows a run's loot adds to a bag that already holds `bag` rows. */
export function rowsAdded(loot, bag) {
  let rows = 0;
  for (const l of loot) {
    if (l.quantity <= 0) continue;
    if (lookupItem(l.itemId)?.stackable) {
      if (!bag.some((b) => b.slot === "bag" && b.item_id === l.itemId)) rows++;
    } else rows += l.quantity;
  }
  return rows;
}

/**
 * Plays one run: fight what is adjacent, walk to the nearest item, pick it
 * up, and head for the gate we came in by once the floor is clear or HP
 * drops below `bail` of max. Returns null if the run dies, so the caller
 * can retry more cautiously; a death would cost the character, not fill it.
 */
function tryRun(seg, p, entryDir, bail, maxSteps) {
  const su = setupFromPlayer(p, entryDir);
  const s = new DungeonSession(seg.seed, seg.depth, su.stats, p.hp, p.max_hp,
                               su.potions, constraintsFor(seg), entryDir,
                               su.inventory);
  const d = s.dungeon;
  const walls = [];
  for (let y = 0; y < HEIGHT; y++) {
    const row = [];
    for (let x = 0; x < WIDTH; x++) row.push(d.getTile(x, y) === 0);
    walls.push(row);
  }
  const gate = s.dungeon.gates.find((g) => g.direction === entryDir) ?? s.dungeon.gates[0];
  const unreachable = new Set();
  const key = (x, y) => `${x},${y}`;

  for (let i = 0; i < maxSteps; i++) {
    if (s.gameOver || s.playerHp <= 0) return null;
    const px = s.playerX, py = s.playerY;

    const foe = s.monsters.find((m) => m.alive && Math.abs(m.x - px) <= 1 && Math.abs(m.y - py) <= 1);
    if (foe) { s.processAction({ type: "move", dx: foe.x - px, dy: foe.y - py }); continue; }

    if (s.groundItems.some((g) => g.x === px && g.y === py)) {
      s.processAction({ type: "pickup" });
      continue;
    }

    const homeward = s.playerHp < s.playerMaxHp * bail;
    const items = homeward ? [] : s.groundItems
      .filter((g) => !unreachable.has(key(g.x, g.y)))
      .sort((a, b) => Math.max(Math.abs(a.x - px), Math.abs(a.y - py))
                    - Math.max(Math.abs(b.x - px), Math.abs(b.y - py)));
    const target = items[0] ?? gate;
    if (target === gate && px === gate.x && py === gate.y) {
      return {
        session: s,
        gate,
        results: { survived: true, xp: s.totalXp, gold: s.totalGold, kills: s.totalKills },
        actions: [...s.actionLog, { type: "gate" }].map((a) =>
          a.type === "use" ? { type: "use", item: a.itemId } : a),
      };
    }
    const step = bfsStep(walls, px, py, target.x, target.y);
    if (!step) {
      if (target === gate) return null;
      unreachable.add(key(target.x, target.y));
      continue;
    }
    // A monster or a closed tile in the way: try the axis-aligned halves,
    // then let the monsters come to us.
    if (!s.processAction({ type: "move", dx: step[0], dy: step[1] })
        && !(step[0] && s.processAction({ type: "move", dx: step[0], dy: 0 }))
        && !(step[1] && s.processAction({ type: "move", dx: 0, dy: step[1] })))
      s.processAction({ type: "wait" });
  }
  return null;
}

/**
 * The run to submit for `p` standing in `seg`, having entered from
 * `entryDir`: tried at increasing caution until one survives. Null if none
 * does, in which case the character cannot farm this arena.
 */
export function planLootRun(seg, p, entryDir, maxSteps = 1500) {
  for (const bail of [0.5, 0.7, 0.9, 1.01]) {
    const run = tryRun(seg, p, entryDir, bail, maxSteps);
    if (run) return { ...run, rows: rowsAdded(run.session.collected, p.inventory), bail };
  }
  return null;
}
