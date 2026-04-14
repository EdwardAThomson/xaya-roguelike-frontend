/**
 * Post-submission watcher — detects moves that were accepted by the
 * contract but silently rejected by the GSP's move parser.
 *
 * The backend's move parser logs a warning and drops invalid moves
 * without returning an error through the contract call.  To surface
 * these to the user we:
 *
 *   1. Submit the move (contract call returns, one block mined)
 *   2. Trigger an immediate GSP refresh
 *   3. Watch for the expected state change with a short timeout
 *   4. If the change doesn't materialise, diagnose via the validator
 *      and show a modal
 *
 * Pre-validation (validator.ts) catches most cases; this handles the
 * races that slip through: another player grabbed the coordinate first,
 * the cooldown window advanced between click and inclusion, etc.
 */

import { Connection } from "./connection.js";
import { PlayerInfo, SegmentInfo } from "./rpc.js";

export interface PendingState {
  player: PlayerInfo | null;
  segments: Map<number, SegmentInfo>;
  currentHeight: number;
}

export type Predicate = (s: PendingState) => boolean;

/**
 * Waits for `pred` to become true against the connection's state.
 * Triggers an immediate refresh at start and then re-checks every
 * `pollMs` until the predicate holds or the total elapsed time
 * exceeds `timeoutMs`.
 */
export async function waitFor(
  connection: Connection,
  pred: Predicate,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = opts.pollMs ?? 250;

  connection.refresh();

  const start = Date.now();
  while (true) {
    const s: PendingState = {
      player: connection.state.player,
      segments: connection.state.segments,
      currentHeight: connection.state.currentHeight,
    };
    if (pred(s)) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, pollMs));
    // Encourage another refresh so we don't wait for the scheduled
    // poll interval.  No-op if one is already in flight.
    connection.refresh();
  }
}
