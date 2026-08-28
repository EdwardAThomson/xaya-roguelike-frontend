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

import { PlayerInfo, SegmentInfo, SegmentRef, segKey, sameSeg, isHub }
  from "./rpc.js";

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: ValidationErrorCode; title: string; message: string };

export type ValidationErrorCode =
  | "no_settlement"
  | "provisional_transit"
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
  | "wrong_slot"
  | "equipped";

export interface ValidatorContext {
  player: PlayerInfo;
  /** Known segments, keyed by coordinate (see segKey). */
  segments: Map<string, SegmentInfo>;
  currentHeight: number;
}

export const DISCOVERY_COOLDOWN_BLOCKS = 50;

const OPPOSITE: Record<string, string> = {
  north: "south", south: "north", east: "west", west: "east",
};
const DIR_DX: Record<string, number> = { east: 1, west: -1, north: 0, south: 0 };
const DIR_DY: Record<string, number> = { north: 1, south: -1, east: 0, west: 0 };
const VALID_DIRS = new Set(["north", "south", "east", "west"]);

/** The cell one step from `from` in `dir` (mirrors segmentkey.hpp). */
export function neighbour(from: SegmentRef, dir: string): SegmentRef {
  return { x: from.x + (DIR_DX[dir] ?? 0), y: from.y + (DIR_DY[dir] ?? 0) };
}

/** Human-readable coordinate, e.g. "(1, -2)". */
export function segName(seg: SegmentRef): string {
  return `(${seg.x}, ${seg.y})`;
}

/**
 * Whether a gate link is recorded out of `from` in `dir`.  The hub keeps no
 * segment record of its own, so its links are read off the neighbour's link
 * back to (0, 0).
 */
function linkedThrough(
  ctx: ValidatorContext, from: SegmentRef, dir: string,
): boolean {
  const info = ctx.segments.get(segKey(from));
  if (info) return !!info.links[dir];

  const target = neighbour(from, dir);
  const back = ctx.segments.get(segKey(target));
  const lnk = back?.links[OPPOSITE[dir]];
  return !!lnk && sameSeg(lnk.to, from);
}

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

  // Direction already linked from the current segment?  The hub keeps no
  // segment record of its own, so we read the link off the neighbour.
  const curSeg = p.segment;
  if (!isHub(curSeg) && !ctx.segments.has(segKey(curSeg))) {
    return err("unknown_segment", "Unknown segment",
      `Your current segment ${segName(curSeg)} is not in the frontend's cache. Try reconnecting.`);
  }

  const target = neighbour(curSeg, dir);
  if (linkedThrough(ctx, curSeg, dir)) {
    return err("dir_linked", "Direction already explored",
      `There is already a segment to the ${dir} from here. Travel there or pick a different direction.`);
  }

  // The coordinate is the identity, so an occupied cell cannot be claimed.
  if (ctx.segments.has(segKey(target))) {
    return err("coord_occupied", "Coordinate already claimed",
      `Another player has already claimed the segment at ${segName(target)}. Pick a different direction.`);
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

  const curSeg = p.segment;
  if (!isHub(curSeg) && !ctx.segments.has(segKey(curSeg))) {
    return err("unknown_segment", "Unknown segment",
      "Your current segment is not in the frontend's cache. Try reconnecting.");
  }
  if (!linkedThrough(ctx, curSeg, dir)) {
    return err("no_link", "No path that way",
      `There is no segment to the ${dir} from here. Discover one first.`);
  }

  return { ok: true };
}

/** Mirror of moveparser.cpp::HandleEnterChannel. */
export function validateEnterChannel(
  ctx: ValidatorContext, seg: SegmentRef,
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
  if (isHub(seg)) {
    return err("hub_no_channel", "Hub has no dungeon",
      "The hub, at (0, 0), is a safe zone — there is no dungeon to enter here.");
  }

  const segInfo = ctx.segments.get(segKey(seg));
  if (!segInfo) {
    return err("unknown_segment", "Unknown segment",
      `Segment ${segName(seg)} is not in the frontend's cache. Try reconnecting.`);
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

/**
 * What the caller intends to attach to this gate-walk.  The GSP's rules
 * depend on it, so the validator has to see it too: the two checks below
 * are the ones that used to fail server-side only, with the client left
 * guessing why.
 */
export interface GateWalkPlan {
  /** A settlement (run proof) will be attached. */
  hasSettlement: boolean;
  /** A free transit out of a confirmed segment, carrying no proof. */
  transit: boolean;
}

/** Mirror of moveparser.cpp::HandleGateWalk. */
export function validateGateWalk(
  ctx: ValidatorContext, dir: string, plan?: GateWalkPlan,
): ValidationResult {
  const p = ctx.player;

  if (p.hp <= 0) {
    return err("dead", "Out of HP",
      "You have 0 HP. Heal before walking through a gate.");
  }
  if (!VALID_DIRS.has(dir)) {
    return err("invalid_dir", "Invalid direction",
      `"${dir}" is not a valid direction.`);
  }

  const curSeg = p.segment;
  const curInfo = ctx.segments.get(segKey(curSeg));
  if (!isHub(curSeg) && !curInfo) {
    return err("unknown_segment", "Unknown segment",
      "Your current segment is not in the frontend's cache. Try reconnecting.");
  }

  // Leaving a run must carry something: either a settlement (the proof of
  // what happened), or -- out of an already-confirmed segment -- a free
  // transit.  The GSP drops a bare gate-walk out of a channel, which is
  // what happens when the browser has lost the run it was playing.
  if (plan && p.in_channel && !plan.hasSettlement && !plan.transit) {
    return err("no_settlement", "Run state lost",
      "This run's progress is no longer loaded in the browser, so there is no proof to submit and the chain would refuse the move. Reconnect to resume the run from where it left off.");
  }

  // Surviving a run is what confirms the segment you claimed, so you cannot
  // take the free-transit shortcut out of a provisional one.
  if (plan && plan.transit && curInfo && !curInfo.confirmed) {
    return err("provisional_transit", "Segment not confirmed yet",
      `${segName(curSeg)} is still provisional — it only becomes real once you complete a run here and leave through a gate. Finish the run, or bail out to give up the claim.`);
  }

  // A gate opens onto the cell next door -- always.
  const target = neighbour(curSeg, dir);
  if (isHub(target)) return { ok: true };

  const occupant = ctx.segments.get(segKey(target));
  if (occupant) {
    // Confirmed neighbour -> free transit (the chain records the link if it
    // is missing).  Provisional neighbour -> discoverer-only.
    if (!occupant.confirmed && occupant.discoverer !== p.name) {
      return err("not_discoverer", "Segment is provisional",
        `Only ${occupant.discoverer} can enter the segment at ${segName(target)} while it is provisional. Wait for them to confirm it, then you can join.`);
    }
    return { ok: true };
  }

  // Empty cell -> walking through this gate claims it, which is a discovery.
  const remaining = discoveryCooldownRemaining(p, ctx.currentHeight);
  if (remaining > 0) {
    return err("cooldown", "Cooldown",
      `Walking through an unexplored gate claims new ground, but you're on cooldown for ${remaining} more block${remaining === 1 ? "" : "s"}.`);
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

/** Mirror of moveparser.cpp::HandleDiscard. */
export function validateDiscard(
  ctx: ValidatorContext, rowid: number,
): ValidationResult {
  const p = ctx.player;
  if (p.in_channel) {
    return err("in_channel", "In a dungeon",
      "You are currently in a dungeon channel. Exit it before discarding items.");
  }
  const item = p.inventory.find((i) => i.rowid === rowid);
  if (!item) {
    return err("no_item", "Item not found",
      "That inventory item no longer exists. Refresh and try again.");
  }
  if (item.slot !== "bag") {
    return err("equipped", "Item equipped",
      `${item.item_id} is equipped in the ${item.slot} slot. Unequip it before discarding.`);
  }
  return { ok: true };
}
