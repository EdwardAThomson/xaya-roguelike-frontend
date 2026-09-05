/**
 * Multiplayer settlement helpers — TS mirror of the settlement layer in
 * the backend's moveprocessor.cpp (docs/SPEC_multiplayer_coop.md,
 * sections 5a, 6 and 7).  Everything here must stay byte-for-byte in step
 * with the C++ side; parity_test.ts pins fixed vectors for each function.
 */

import { sha256Hex } from "./hash.js";
import { DungeonSession, GameAction, LoggedAction } from "./session.js";

/**
 * Wire encoding of one merged-log entry: the solo action object plus the
 * acting participant's canonical index (spec section 6).  "itemId" becomes
 * "item" on the wire, exactly as the solo `xc` settlement does.
 */
export function toWireAction(la: LoggedAction): object {
  const a = la.action;
  switch (a.type) {
    case "move":    return { i: la.actor, type: "move", dx: a.dx ?? 0, dy: a.dy ?? 0 };
    case "use":     return { i: la.actor, type: "use", item: a.itemId ?? "" };
    case "equip":   return { i: la.actor, type: "equip", rowid: a.rowid ?? 0, slot: a.slot ?? "" };
    case "unequip": return { i: la.actor, type: "unequip", rowid: a.rowid ?? 0 };
    default:        return { i: la.actor, type: a.type };
  }
}

/**
 * Canonical one-line encoding of a merged-log entry (spec section 7):
 * "<i> <type>[ <args>]\n".  Mirrors CanonicalActionLine in
 * moveprocessor.cpp.
 */
export function canonicalActionLine(actor: number, a: GameAction): string {
  let line = String(actor);
  switch (a.type) {
    case "move":    line += ` move ${a.dx ?? 0} ${a.dy ?? 0}`; break;
    case "pickup":  line += " pickup"; break;
    case "use":     line += ` use ${a.itemId ?? ""}`; break;
    case "gate":    line += " gate"; break;
    case "wait":    line += " wait"; break;
    case "equip":   line += ` equip ${a.rowid ?? 0} ${a.slot ?? ""}`; break;
    case "unequip": line += ` unequip ${a.rowid ?? 0}`; break;
  }
  return line + "\n";
}

/**
 * Canonical settlement-consent hash (spec section 7): SHA-256 hex over
 * "rog-settle-v1\n<visitId>\n" followed by one canonical line per entry.
 * This is the `h` of the `sc` confirm move.  Mirrors SettleLogHash in
 * moveprocessor.cpp.
 */
export function settleLogHash(visitId: number, log: LoggedAction[]): string {
  let data = `rog-settle-v1\n${visitId}\n`;
  for (const la of log) data += canonicalActionLine(la.actor, la.action);
  return sha256Hex(data);
}

/**
 * Parses canonical lines back into a merged log (the inverse of
 * canonicalActionLine).  Used by the parity fixtures, which pin a scripted
 * run in this exact encoding; unknown lines throw.
 */
export function parseCanonicalLog(text: string): LoggedAction[] {
  const out: LoggedAction[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(" ");
    const actor = Number(parts[0]);
    let action: GameAction;
    switch (parts[1]) {
      case "move":    action = { type: "move", dx: Number(parts[2]), dy: Number(parts[3]) }; break;
      case "pickup":  action = { type: "pickup" }; break;
      case "use":     action = { type: "use", itemId: parts[2] }; break;
      case "gate":    action = { type: "gate" }; break;
      case "wait":    action = { type: "wait" }; break;
      case "equip":   action = { type: "equip", rowid: Number(parts[2]), slot: parts[3] }; break;
      case "unequip": action = { type: "unequip", rowid: Number(parts[2]) }; break;
      default: throw new Error("bad canonical log line: " + line);
    }
    out.push({ actor, action });
  }
  return out;
}

/**
 * Pro-rata pool split (spec section 5a): each index gets
 * floor(pool * damages[i] / totalDamage); the leftover units go one each
 * to the largest remainders, ties to the lower index.  All-zero damages
 * yield all-zero shares.  Exact integer math; mirrors SplitPool in
 * moveprocessor.cpp.  Inputs are small integers (well under 2^53 for
 * pool * damage), so plain JS arithmetic is exact.
 */
export function splitPool(pool: number, damages: number[]): number[] {
  const n = damages.length;
  const shares = new Array<number>(n).fill(0);

  let totalDamage = 0;
  for (const d of damages) totalDamage += d;
  if (totalDamage === 0 || pool === 0) return shares;

  let assigned = 0;
  const remainders: { rem: number; idx: number }[] = [];
  for (let i = 0; i < n; i++) {
    const prod = pool * damages[i];
    shares[i] = Math.floor(prod / totalDamage);
    assigned += shares[i];
    remainders.push({ rem: prod % totalDamage, idx: i });
  }

  remainders.sort((a, b) => (a.rem !== b.rem ? b.rem - a.rem : a.idx - b.idx));
  for (let k = 0; k < pool - assigned; k++) shares[remainders[k].idx]++;

  return shares;
}

/** One participant's claimed outcome, as the GSP verifies it. */
export interface ParticipantClaim {
  survived: boolean;
  xp: number;
  gold: number;
  kills: number;
}

/**
 * Computes every participant's settlement claims from a finished (or
 * in-progress, for the projected HUD) session exactly as ProcessSettle
 * recomputes them: `xp` is the XP-pool share, `gold` is raced pickups
 * plus the kill-gold-pool share, `kills` the finishing blows, `survived`
 * whether the participant exited through a gate.  Indexed by canonical
 * participant index.
 */
export function computeClaims(session: DungeonSession): ParticipantClaim[] {
  const damages = session.players.map(p => p.damageDealt);
  const xpShares = splitPool(session.xpPool, damages);
  const goldShares = splitPool(session.killGoldPool, damages);
  return session.players.map((p, i) => ({
    survived: p.exited,
    xp: xpShares[i],
    gold: p.totalGold + goldShares[i],
    kills: p.totalKills,
  }));
}

/**
 * Wire `results` array for the multiplayer `s` move: one entry per
 * participant, tagged with the player name, in canonical order.
 */
export function toWireResults(
  session: DungeonSession, names: string[],
): object[] {
  return computeClaims(session).map((c, i) => ({ p: names[i], ...c }));
}

/**
 * Compact settlement encoding (backend docs/STRATEGY_action_proofs.md
 * option A, parsed by ParseCompactActions in moveprocessor.cpp): entries
 * separated by ";", each "[<i>:]<code><args>[*<count>]" with codes
 * m<numpad digit> (move), p (pickup), w (wait), g (gate), u<item> (use),
 * e<rowid>,<slot> (equip), q<rowid> (unequip).  The actor prefix is used
 * for merged (multiplayer) logs only.  Maximal runs of identical entries
 * collapse to "*<n>": the GSP expands them before anything else sees the
 * log, so the canonical hash lines are unaffected.  Roughly a quarter of
 * the JSON array's size.
 */
const NUMPAD: Record<string, string> = {
  "-1,-1": "7", "0,-1": "8", "1,-1": "9",
  "-1,0": "4",               "1,0": "6",
  "-1,1": "1",  "0,1": "2",  "1,1": "3",
};
const NUMPAD_INV: Record<string, [number, number]> = {
  "7": [-1, -1], "8": [0, -1], "9": [1, -1],
  "4": [-1, 0],                "6": [1, 0],
  "1": [-1, 1],  "2": [0, 1],  "3": [1, 1],
};

function compactEntry(a: GameAction): string {
  switch (a.type) {
    case "move": {
      const code = NUMPAD[`${a.dx ?? 0},${a.dy ?? 0}`];
      if (!code) throw new Error(`bad move delta ${a.dx},${a.dy}`);
      return "m" + code;
    }
    case "pickup":  return "p";
    case "wait":    return "w";
    case "gate":    return "g";
    case "use":     return "u" + (a.itemId ?? "");
    case "equip":   return `e${a.rowid ?? 0},${a.slot ?? ""}`;
    case "unequip": return `q${a.rowid ?? 0}`;
  }
}

/** Encodes a solo action log (no actor prefixes). */
export function encodeCompactActions(actions: GameAction[]): string {
  return encodeCompactLog(actions.map(a => ({ actor: 0, action: a })), false);
}

/** Encodes a merged log; `withActor` adds the "<i>:" prefix to every entry. */
export function encodeCompactLog(log: LoggedAction[], withActor: boolean): string {
  const entries = log.map(la => (withActor ? `${la.actor}:` : "") + compactEntry(la.action));
  const out: string[] = [];
  for (let k = 0; k < entries.length;) {
    let j = k;
    while (j + 1 < entries.length && entries[j + 1] === entries[k]) j++;
    const n = j - k + 1;
    out.push(entries[k] + (n > 1 ? `*${n}` : ""));
    k = j + 1;
  }
  return out.join(";");
}

/** Decodes the compact encoding (mirrors the GSP parser; throws on bad input). */
export function decodeCompactLog(text: string, withActor: boolean): LoggedAction[] {
  const out: LoggedAction[] = [];
  if (text === "") return out;
  for (let entry of text.split(";")) {
    let count = 1;
    const star = entry.indexOf("*");
    if (star >= 0) {
      count = Number(entry.slice(star + 1));
      if (!/^[0-9]+$/.test(entry.slice(star + 1)) || count < 1 || count > 10000)
        throw new Error("bad repeat: " + entry);
      entry = entry.slice(0, star);
    }
    let actor = 0;
    const colon = entry.indexOf(":");
    if (withActor) {
      if (colon < 0 || !/^[0-9]+$/.test(entry.slice(0, colon))) throw new Error("missing actor: " + entry);
      actor = Number(entry.slice(0, colon));
      entry = entry.slice(colon + 1);
    } else if (colon >= 0) {
      throw new Error("unexpected actor: " + entry);
    }
    if (!entry) throw new Error("empty entry");
    const arg = entry.slice(1);
    let action: GameAction;
    switch (entry[0]) {
      case "m": {
        const d = NUMPAD_INV[arg];
        if (arg.length !== 1 || !d) throw new Error("bad move: " + entry);
        action = { type: "move", dx: d[0], dy: d[1] };
        break;
      }
      case "p": if (arg) throw new Error("bad pickup"); action = { type: "pickup" }; break;
      case "w": if (arg) throw new Error("bad wait"); action = { type: "wait" }; break;
      case "g": if (arg) throw new Error("bad gate"); action = { type: "gate" }; break;
      case "u": if (!arg) throw new Error("bad use"); action = { type: "use", itemId: arg }; break;
      case "e": {
        const comma = arg.indexOf(",");
        if (comma < 1 || comma + 1 >= arg.length || !/^-?[0-9]+$/.test(arg.slice(0, comma)))
          throw new Error("bad equip: " + entry);
        action = { type: "equip", rowid: Number(arg.slice(0, comma)), slot: arg.slice(comma + 1) };
        break;
      }
      case "q":
        if (!/^-?[0-9]+$/.test(arg)) throw new Error("bad unequip: " + entry);
        action = { type: "unequip", rowid: Number(arg) };
        break;
      default: throw new Error("bad code: " + entry);
    }
    for (let k = 0; k < count; k++) out.push({ actor, action });
  }
  return out;
}
