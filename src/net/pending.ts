/**
 * Post-submission watcher — decides what actually happened to a move.
 *
 * A submitted move has three possible fates, and the difference matters:
 *
 *   applied   the expected state change is visible on chain
 *   rejected  the chain moved on without it — the GSP's move parser
 *             dropped it (it logs a warning and returns no error, so
 *             this is the only way to find out)
 *   pending   not visible yet, and the chain has not advanced far enough
 *             for us to conclude anything.  NOT a rejection.
 *
 * The old version of this file gave every move a flat five seconds and
 * treated the deadline as proof of rejection.  With three-second blocks
 * plus indexing lag that is a coin flip, and it produced confident
 * "the GSP did not apply it" messages for moves that were simply still
 * in flight.  We now measure in BLOCKS: once the GSP has processed
 * `blocks` blocks past the height we submitted at without the state
 * changing, the move genuinely is not going to land.  Success is still
 * reported the instant it is visible.
 */

import { Connection } from "./connection.js";
import { PlayerInfo, SegmentInfo } from "./rpc.js";

export interface PendingState {
  player: PlayerInfo | null;
  segments: Map<string, SegmentInfo>;
  currentHeight: number;
}

export type Predicate = (s: PendingState) => boolean;

/** What became of a submitted move. */
export type MoveOutcome = "applied" | "rejected" | "pending";

/**
 * Watches for `pred` after submitting a move.
 *
 * `blocks` is how many blocks the GSP must process past the submission
 * height before we call it a rejection — two is enough, since the move
 * client mines a block itself right after submitting, so the block
 * carrying the move is always among them.  `timeoutMs` only bounds the
 * wait on an idle chain, where heights never advance and the honest
 * answer is "pending".
 */
export async function waitForMove(
  connection: Connection,
  pred: Predicate,
  opts: { blocks?: number; timeoutMs?: number; pollMs?: number } = {},
): Promise<MoveOutcome> {
  const blocks = opts.blocks ?? 2;
  const timeoutMs = opts.timeoutMs ?? 60000;
  const pollMs = opts.pollMs ?? 250;

  const startHeight = connection.state.currentHeight;
  connection.refresh();

  const start = Date.now();
  while (true) {
    const s: PendingState = {
      player: connection.state.player,
      segments: connection.state.segments,
      currentHeight: connection.state.currentHeight,
    };
    if (pred(s)) return "applied";

    // The chain has had its chance: the move is not coming.
    if (s.currentHeight >= startHeight + blocks) return "rejected";

    if (Date.now() - start >= timeoutMs) return "pending";

    await new Promise((r) => setTimeout(r, pollMs));
    // Encourage another refresh so we don't wait for the scheduled
    // poll interval.  No-op if one is already in flight.
    connection.refresh();
  }
}

/**
 * Back-compat shim for call sites that only care whether the move
 * landed.  A move still in flight counts as "not yet" here, so callers
 * that use this must not report a rejection on `false`.
 */
export async function waitFor(
  connection: Connection,
  pred: Predicate,
  opts: { blocks?: number; timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  return (await waitForMove(connection, pred, opts)) === "applied";
}
