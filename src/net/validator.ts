/**
 * Client-side move validator — mirrors the rules in
 * ~/Projects/xayaroguelike/moveparser.cpp so the frontend can tell the
 * user why a move would be rejected *before* sending it.
 *
 * The backend silently drops invalid moves (LOG(WARNING), no error
 * returned to the caller).  Without client-side pre-validation the user
 * has no way to find out why their action had no effect.
 *
 * Each validator returns either `{ ok: true }` or an error result with
 * a stable machine `code`, a human-readable `title` for the modal
 * heading, and a `message` for the modal body.
 */

import { PlayerInfo, SegmentInfo } from "./rpc.js";

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: ValidationErrorCode; title: string; message: string };

export type ValidationErrorCode =
  | "in_channel"
  | "in_visit"
  | "cooldown"
  | "invalid_dir"
  | "dir_linked"
  | "coord_occupied"
  | "unknown_segment"
  | "no_link"
  | "not_discoverer"
  | "hub_no_channel"
  | "no_item"
  | "not_registered"
  | "no_stat_points"
  | "dead"
  | "invalid_slot"
  | "not_in_bag"
  | "already_in_bag"
  | "invalid_stat"
  | "wrong_slot";

export interface ValidatorContext {
  player: PlayerInfo;
  segments: Map<number, SegmentInfo>;
  currentHeight: number;
}

export const DISCOVERY_COOLDOWN_BLOCKS = 50;

const OPPOSITE: Record<string, string> = {
  north: "south", south: "north", east: "west", west: "east",
};
const DIR_DX: Record<string, number> = { east: 1, west: -1, north: 0, south: 0 };
const DIR_DY: Record<string, number> = { north: 1, south: -1, east: 0, west: 0 };
const VALID_DIRS = new Set(["north", "south", "east", "west"]);

function err(
  code: ValidationErrorCode, title: string, message: string,
): ValidationResult {
  return { ok: false, code, title, message };
}

/** How many blocks until this player can discover again (0 = ready now). */
export function discoveryCooldownRemaining(
  player: PlayerInfo, currentHeight: number,
): number {
  if (player.last_discover_height <= 0) return 0;
  const end = player.last_discover_height + DISCOVERY_COOLDOWN_BLOCKS;
  return Math.max(0, end - currentHeight);
}

/**
 * Checks every rule in moveparser.cpp::HandleDiscover that can be
 * determined client-side from the current observable state.
 */
export function validateDiscover(
  ctx: ValidatorContext, dir: string,
): ValidationResult {
  const p = ctx.player;

  if (p.in_channel) {
    return err("in_channel", "In a dungeon",
      "You are currently in a dungeon channel. Exit it before discovering new segments.");
  }
  if (p.active_visit) {
    return err("in_visit", "In an active visit",
      "You are in an active dungeon visit. Settle it before discovering new segments.");
  }
  if (p.hp <= 0) {
    return err("dead", "Out of HP",
      "You have 0 HP. Heal or respawn before discovering.");
  }

  if (!VALID_DIRS.has(dir)) {
    return err("invalid_dir", "Invalid direction",
      `"${dir}" is not a valid direction. Use north, south, east, or west.`);
  }

  const remaining = discoveryCooldownRemaining(p, ctx.currentHeight);
  if (remaining > 0) {
    return err("cooldown", "Discovery on cooldown",
      `You discovered a segment recently. Wait ${remaining} more block${remaining === 1 ? "" : "s"} before discovering again.`);
  }

  // Direction already linked from the current segment?  For the hub
  // (segment 0) we infer this from other segments that link back to 0.
  const curSeg = p.current_segment;
  if (curSeg === 0) {
    const opp = OPPOSITE[dir];
    for (const seg of ctx.segments.values()) {
      for (const [d, lnk] of Object.entries(seg.links)) {
        if (lnk.to_segment === 0 && d === opp) {
          return err("dir_linked", "Direction already explored",
            `There is already a segment to the ${dir} from the hub. Travel there or pick a different direction.`);
        }
      }
    }
  } else {
    const segInfo = ctx.segments.get(curSeg);
    if (!segInfo) {
      return err("unknown_segment", "Unknown segment",
        `Your current segment (${curSeg}) is not in the frontend's cache. Try reconnecting.`);
    }
    if (segInfo.links[dir]) {
      return err("dir_linked", "Direction already explored",
        `There is already a segment to the ${dir} from here. Travel there or pick a different direction.`);
    }
  }

  // UNIQUE (world_x, world_y) check.  Compute target from current.
  let srcX = 0, srcY = 0;
  if (curSeg !== 0) {
    const segInfo = ctx.segments.get(curSeg)!;
    srcX = segInfo.world_x;
    srcY = segInfo.world_y;
  }
  const targetX = srcX + (DIR_DX[dir] ?? 0);
  const targetY = srcY + (DIR_DY[dir] ?? 0);
  for (const seg of ctx.segments.values()) {
    if (seg.world_x === targetX && seg.world_y === targetY) {
      return err("coord_occupied", "Coordinate already claimed",
        `Another player has already claimed the segment at world (${targetX}, ${targetY}). Pick a different direction.`);
    }
  }

  return { ok: true };
}

/** Mirror of moveparser.cpp::HandleTravel. */
export function validateTravel(
  ctx: ValidatorContext, dir: string,
): ValidationResult {
  const p = ctx.player;

  if (p.in_channel) {
    return err("in_channel", "In a dungeon",
      "You are currently in a dungeon channel. Exit it before traveling.");
  }
  if (!VALID_DIRS.has(dir)) {
    return err("invalid_dir", "Invalid direction",
      `"${dir}" is not a valid direction.`);
  }

  const curSeg = p.current_segment;
  if (curSeg === 0) {
    // Hub: look for a segment that links back to 0 from the opposite direction.
    const opp = OPPOSITE[dir];
    for (const seg of ctx.segments.values()) {
      for (const [d, lnk] of Object.entries(seg.links)) {
        if (lnk.to_segment === 0 && d === opp) {
          return { ok: true };
        }
      }
    }
    return err("no_link", "No path that way",
      `There is nothing to the ${dir} from the hub. Discover a new segment first.`);
  }

  const segInfo = ctx.segments.get(curSeg);
  if (!segInfo) {
    return err("unknown_segment", "Unknown segment",
      "Your current segment is not in the frontend's cache. Try reconnecting.");
  }
  if (!segInfo.links[dir]) {
    return err("no_link", "No path that way",
      `There is no segment to the ${dir} from here. Discover one first.`);
  }

  return { ok: true };
}

/** Mirror of moveparser.cpp::HandleEnterChannel. */
export function validateEnterChannel(
  ctx: ValidatorContext, segmentId: number,
): ValidationResult {
  const p = ctx.player;

  if (p.in_channel) {
    return err("in_channel", "Already in a dungeon",
      "You are already in a dungeon channel. Exit it before entering another.");
  }
  if (p.hp <= 0) {
    return err("dead", "Out of HP",
      "You have 0 HP. Heal or respawn before entering a dungeon.");
  }
  if (segmentId === 0) {
    return err("hub_no_channel", "Hub has no dungeon",
      "The hub (segment 0) is a safe zone — there is no dungeon to enter here.");
  }

  const segInfo = ctx.segments.get(segmentId);
  if (!segInfo) {
    return err("unknown_segment", "Unknown segment",
      `Segment ${segmentId} is not in the frontend's cache. Try reconnecting.`);
  }

  // Provisional segments can only be entered by the discoverer.
  if (!segInfo.confirmed && segInfo.discoverer !== p.name) {
    return err("not_discoverer", "Segment is provisional",
      `Only ${segInfo.discoverer} can enter this segment while it is provisional. Wait for them to confirm it by completing a dungeon run, then you can join.`);
  }

  return { ok: true };
}

/** Mirror of moveparser.cpp::HandleUseItem. */
export function validateUseItem(
  ctx: ValidatorContext, itemId: string,
): ValidationResult {
  const p = ctx.player;
  const item = p.inventory.find(
    (i) => i.item_id === itemId && i.slot === "bag",
  );
  if (!item || item.quantity <= 0) {
    return err("no_item", "No such item",
      `You don't have any "${itemId}" in your bag.`);
  }
  return { ok: true };
}

/** Mirror of moveparser.cpp::HandleAllocateStat. */
export function validateAllocateStat(
  ctx: ValidatorContext, stat: string,
): ValidationResult {
  const p = ctx.player;
  if (!["strength", "dexterity", "constitution", "intelligence"].includes(stat)) {
    return err("invalid_stat", "Unknown stat",
      `"${stat}" is not a valid stat. Use strength, dexterity, constitution, or intelligence.`);
  }
  if (p.stat_points <= 0) {
    return err("no_stat_points", "No stat points available",
      "You don't have any stat points to allocate. Earn more by leveling up.");
  }
  return { ok: true };
}

const EQUIP_SLOTS = new Set([
  "weapon", "offhand", "head", "body", "feet", "ring", "amulet",
]);

/** Mirror of moveparser.cpp::HandleEquip. */
export function validateEquip(
  ctx: ValidatorContext, rowid: number, slot: string,
): ValidationResult {
  const p = ctx.player;
  if (p.in_channel) {
    return err("in_channel", "In a dungeon",
      "You are currently in a dungeon channel. Exit it before changing equipment.");
  }
  if (!EQUIP_SLOTS.has(slot)) {
    return err("invalid_slot", "Invalid slot",
      `"${slot}" is not a valid equipment slot.`);
  }
  const item = p.inventory.find((i) => i.rowid === rowid);
  if (!item) {
    return err("no_item", "Item not found",
      "That inventory item no longer exists. Refresh and try again.");
  }
  if (item.slot !== "bag") {
    return err("already_in_bag", "Item already equipped",
      `${item.item_id} is already equipped in the ${item.slot} slot. Unequip it first if you want to move it.`);
  }
  return { ok: true };
}

/** Mirror of moveparser.cpp::HandleUnequip. */
export function validateUnequip(
  ctx: ValidatorContext, rowid: number,
): ValidationResult {
  const p = ctx.player;
  if (p.in_channel) {
    return err("in_channel", "In a dungeon",
      "You are currently in a dungeon channel. Exit it before changing equipment.");
  }
  const item = p.inventory.find((i) => i.rowid === rowid);
  if (!item) {
    return err("no_item", "Item not found",
      "That inventory item no longer exists. Refresh and try again.");
  }
  if (item.slot === "bag") {
    return err("not_in_bag", "Item not equipped",
      `${item.item_id} is already in your bag.`);
  }
  return { ok: true };
}
