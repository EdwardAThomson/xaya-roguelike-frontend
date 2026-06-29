/**
 * Move submission.
 *
 * `MoveClient` exposes the high-level game moves the UI calls. It delegates
 * the actual on-chain submission to a `MoveTransport`, so the same client
 * works whether moves go through the devnet HTTP proxy or (eventually) a
 * browser wallet.
 *
 * Two transports exist:
 *   - ProxyMoveTransport  — active: talks to the devnet move proxy, which
 *     translates HTTP requests into XayaAccounts contract calls.
 *   - WalletMoveTransport — dormant: direct window.ethereum signing for
 *     production. Wired in but not enabled (see walletTransport.ts).
 *
 * `createMoveClient` selects the transport from MOVE_TRANSPORT in config.
 */

import { GAME_ID, MOVE_TRANSPORT } from "../config.js";
import { WalletMoveTransport } from "./walletTransport.js";

/** The on-chain submission primitives a MoveClient is built on. */
export interface MoveTransport {
  /** Register a Xaya name for the player. */
  register(name: string): Promise<void>;
  /** Submit a game move under GAME_ID for the given name. */
  submitMove(name: string, gameMove: object): Promise<void>;
  /** Advance the chain. No-op on networks that mine their own blocks. */
  mine(blocks?: number): Promise<void>;
  /** Whether the transport is reachable/available. */
  ping(): Promise<boolean>;
}

export class MoveClient {
  constructor(private transport: MoveTransport) {}

  /** Check if the underlying transport is reachable. */
  ping(): Promise<boolean> {
    return this.transport.ping();
  }

  // --- Convenience methods for specific game moves ---

  async registerPlayer(name: string): Promise<void> {
    await this.transport.register(name);
    await this.transport.submitMove(name, { r: {} });
    await this.transport.mine();
  }

  async discover(name: string, depth: number, dir: string): Promise<void> {
    await this.transport.submitMove(name, { d: { depth, dir } });
    await this.transport.mine();
  }

  async travel(name: string, dir: string): Promise<void> {
    await this.transport.submitMove(name, { t: { dir } });
    await this.transport.mine();
  }

  async enterChannel(name: string, segmentId: number): Promise<void> {
    await this.transport.submitMove(name, { ec: { id: segmentId } });
    await this.transport.mine();
  }

  async exitChannel(
    name: string,
    visitId: number,
    results: { survived: boolean; xp: number; gold: number; kills: number },
    actions: object[],
  ): Promise<void> {
    await this.transport.submitMove(name, { xc: { id: visitId, results, actions } });
    await this.transport.mine();
  }

  async useItem(name: string, itemId: string): Promise<void> {
    await this.transport.submitMove(name, { ui: { item: itemId } });
    await this.transport.mine();
  }

  async equip(name: string, rowid: number, slot: string): Promise<void> {
    await this.transport.submitMove(name, { eq: { rowid, slot } });
    await this.transport.mine();
  }

  async unequip(name: string, rowid: number): Promise<void> {
    await this.transport.submitMove(name, { uq: { rowid } });
    await this.transport.mine();
  }

  /** Permanently destroys a bag item. */
  async discard(name: string, rowid: number): Promise<void> {
    await this.transport.submitMove(name, { di: { rowid } });
    await this.transport.mine();
  }

  /**
   * Atomic gate-walk: optionally settles the current dungeon and
   * transits into the neighbour in `dir` (discovering it first if
   * unexplored), entering its channel in the same on-chain move.
   *
   * From a channel, pass either a `settlement` (a played run, settles
   * rewards) or `transit: true` (a free, no-reward pass — allowed by the
   * GSP only out of a confirmed segment). From the hub/overworld, pass
   * neither.
   */
  async gateWalk(
    name: string,
    dir: string,
    settlement?: {
      results: { survived: boolean; xp: number; gold: number; kills: number };
      actions: object[];
    },
    transit = false,
  ): Promise<void> {
    const op: { dir: string; settlement?: object; transit?: boolean } = { dir };
    if (settlement) op.settlement = settlement;
    else if (transit) op.transit = true;
    await this.transport.submitMove(name, { gw: op });
    await this.transport.mine();
  }

  async allocateStat(name: string, stat: string): Promise<void> {
    await this.transport.submitMove(name, { as: { stat } });
    await this.transport.mine();
  }
}

/**
 * Talks to the devnet move proxy (devnet/frontend_devnet.py), which
 * translates simple HTTP requests into XayaAccounts contract calls so the
 * browser needs no ABI encoding or wallet signing.
 */
export class ProxyMoveTransport implements MoveTransport {
  constructor(public proxyUrl: string) {}

  async register(name: string): Promise<void> {
    await this.send({ action: "register", name });
  }

  async submitMove(name: string, gameMove: object): Promise<void> {
    await this.send({ action: "move", name, game: GAME_ID, data: gameMove });
  }

  async mine(blocks: number = 1): Promise<void> {
    await this.send({ action: "mine", blocks });
  }

  async ping(): Promise<boolean> {
    try {
      const resp = await fetch(this.proxyUrl + "/ping", { method: "GET" });
      return resp.ok;
    } catch {
      return false;
    }
  }

  private async send(body: object): Promise<unknown> {
    const resp = await fetch(this.proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Proxy error ${resp.status}: ${text}`);
    }

    return resp.json();
  }
}

/**
 * Builds a MoveClient with the transport selected by MOVE_TRANSPORT.
 * Defaults to the proxy; the wallet path is wired in but inactive.
 */
export function createMoveClient(opts: { proxyUrl: string }): MoveClient {
  switch (MOVE_TRANSPORT) {
    case "wallet":
      return new MoveClient(new WalletMoveTransport());
    case "proxy":
    default:
      return new MoveClient(new ProxyMoveTransport(opts.proxyUrl));
  }
}
