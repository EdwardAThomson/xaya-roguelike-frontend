/**
 * Connection manager — connects to a GSP, fetches state,
 * and polls for changes via waitforchange.
 */

import { RpcClient, PlayerInfo, SegmentInfo, SegmentRef, FullState, segKey }
  from "./rpc.js";
import { POLL_INTERVAL_MS } from "../config.js";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface ConnectionState {
  status: ConnectionStatus;
  error?: string;
  playerName: string;
  player: PlayerInfo | null;
  /** Known segments, keyed by their coordinate ("x,y" -- see segKey). */
  segments: Map<string, SegmentInfo>;
  fullState: FullState | null;
  /** Block height that the game state corresponds to (0 until known). */
  currentHeight: number;
}

export type StateChangeCallback = (state: ConnectionState) => void;

export class Connection {
  rpc: RpcClient | null = null;
  private polling = false;
  private pollInFlight = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private onChange: StateChangeCallback;

  state: ConnectionState = {
    status: "disconnected",
    playerName: "",
    player: null,
    segments: new Map(),
    fullState: null,
    currentHeight: 0,
  };

  constructor(onChange: StateChangeCallback) {
    this.onChange = onChange;
  }

  private notify(): void {
    this.onChange(this.state);
  }

  async connect(url: string, playerName: string): Promise<void> {
    this.disconnect();

    this.rpc = new RpcClient(url);
    this.state.status = "connecting";
    this.state.playerName = playerName;
    this.state.error = undefined;
    this.notify();

    try {
      // Test connection by fetching current state (with height).
      const envelope = await this.rpc.getCurrentStateEnvelope();
      this.state.fullState = envelope.state;
      this.state.currentHeight = envelope.height;

      // Fetch player info if name provided.
      if (playerName) {
        this.state.player = await this.rpc.getplayerinfo(playerName);
      }

      // Fetch full segment details (with links/gates) for each segment.
      await this.fetchSegmentDetails(envelope.state.segments);

      this.state.status = "connected";
      this.notify();

      // Start polling for changes.
      this.startPolling();
    } catch (e) {
      this.state.status = "error";
      this.state.error = e instanceof Error ? e.message : String(e);
      this.notify();
    }
  }

  disconnect(): void {
    this.stopPolling();
    this.rpc = null;
    this.state = {
      status: "disconnected",
      playerName: "",
      player: null,
      segments: new Map(),
      fullState: null,
      currentHeight: 0,
    };
    this.notify();
  }

  /**
   * Refreshes the cached detail for every segment the GSP currently knows,
   * and forgets the ones it no longer does.
   *
   * `segs` is authoritative: it is the segment list from the state snapshot
   * we just fetched. A segment can genuinely disappear, because a
   * provisional one is PRUNED when its discoverer fails or abandons the run
   * that would have confirmed it, releasing the world coordinate. Without
   * the delete the client kept the last snapshot of it for the life of the
   * page, so the map went on drawing a segment that no longer exists (and
   * drew it as provisional, since that is what it was when it died).
   * Provisional segments that really are provisional are still cached and
   * still shown; only vanished ones are dropped.
   */
  private async fetchSegmentDetails(segs: SegmentRef[]): Promise<void> {
    if (!this.rpc) return;
    const live = new Set(segs.map(segKey));
    for (const seg of segs) {
      const info = await this.rpc.getsegmentinfo(seg);
      if (info) {
        this.state.segments.set(segKey(seg), info);
      }
    }
    for (const key of [...this.state.segments.keys()]) {
      if (!live.has(key)) this.state.segments.delete(key);
    }
  }

  private startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    this.poll();
  }

  private stopPolling(): void {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async poll(): Promise<void> {
    if (!this.polling || !this.rpc || this.pollInFlight) return;
    this.pollInFlight = true;

    try {
      const envelope = await this.rpc.getCurrentStateEnvelope();
      this.state.fullState = envelope.state;
      this.state.currentHeight = envelope.height;

      if (this.state.playerName) {
        this.state.player = await this.rpc.getplayerinfo(this.state.playerName);
      }

      // Refresh segment details for new AND existing segments — links
      // and `confirmed` can change as other players act.
      await this.fetchSegmentDetails(envelope.state.segments);

      this.state.status = "connected";
      this.state.error = undefined;
      this.notify();
    } catch (e) {
      this.state.status = "error";
      this.state.error = e instanceof Error ? e.message : String(e);
      this.notify();
    } finally {
      this.pollInFlight = false;
    }

    // Schedule next poll.
    if (this.polling) {
      this.pollTimer = setTimeout(() => this.poll(), POLL_INTERVAL_MS);
    }
  }

  /**
   * Forces an immediate poll — used after submitting a move so callers
   * don't have to wait for the next scheduled tick.  No-op if a poll is
   * already in flight or the connection is not active.
   */
  refresh(): void {
    if (!this.polling || this.pollInFlight) return;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    void this.poll();
  }

  /**
   * One-shot, awaited re-fetch of the current player's info (updates state
   * and notifies). Lets a caller make an authoritative decision right after
   * submitting a move without depending on the pending watcher's block
   * budget — used by registration, where the new player can take several
   * blocks to become visible.
   */
  async refreshPlayer(): Promise<PlayerInfo | null> {
    if (!this.rpc || !this.state.playerName) return this.state.player;
    this.state.player = await this.rpc.getplayerinfo(this.state.playerName);
    this.notify();
    return this.state.player;
  }
}
