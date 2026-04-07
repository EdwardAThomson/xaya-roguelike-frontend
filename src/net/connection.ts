/**
 * Connection manager — connects to a GSP, fetches state,
 * and polls for changes via waitforchange.
 */

import { RpcClient, PlayerInfo, SegmentInfo, FullState } from "./rpc.js";
import { POLL_INTERVAL_MS } from "../config.js";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface ConnectionState {
  status: ConnectionStatus;
  error?: string;
  playerName: string;
  player: PlayerInfo | null;
  segments: Map<number, SegmentInfo>;
  fullState: FullState | null;
}

export type StateChangeCallback = (state: ConnectionState) => void;

export class Connection {
  rpc: RpcClient | null = null;
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private onChange: StateChangeCallback;

  state: ConnectionState = {
    status: "disconnected",
    playerName: "",
    player: null,
    segments: new Map(),
    fullState: null,
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
      // Test connection by fetching current state.
      const fullState = await this.rpc.getcurrentstate();
      this.state.fullState = fullState;

      // Fetch player info if name provided.
      if (playerName) {
        this.state.player = await this.rpc.getplayerinfo(playerName);
      }

      // Fetch full segment details (with links/gates) for each segment.
      await this.fetchSegmentDetails(fullState.segments.map(s => s.id));

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
    };
    this.notify();
  }

  private async fetchSegmentDetails(ids: number[]): Promise<void> {
    if (!this.rpc) return;
    for (const id of ids) {
      const info = await this.rpc.getsegmentinfo(id);
      if (info) {
        this.state.segments.set(id, info);
      }
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
    if (!this.polling || !this.rpc) return;

    try {
      const fullState = await this.rpc.getcurrentstate();
      this.state.fullState = fullState;

      if (this.state.playerName) {
        this.state.player = await this.rpc.getplayerinfo(this.state.playerName);
      }

      // Refresh segment details if new segments appeared.
      const knownIds = new Set(this.state.segments.keys());
      const newIds = fullState.segments
        .map(s => s.id)
        .filter(id => !knownIds.has(id));
      if (newIds.length > 0) {
        await this.fetchSegmentDetails(newIds);
      }

      this.state.status = "connected";
      this.state.error = undefined;
      this.notify();
    } catch (e) {
      this.state.status = "error";
      this.state.error = e instanceof Error ? e.message : String(e);
      this.notify();
    }

    // Schedule next poll.
    if (this.polling) {
      this.pollTimer = setTimeout(() => this.poll(), POLL_INTERVAL_MS);
    }
  }
}
