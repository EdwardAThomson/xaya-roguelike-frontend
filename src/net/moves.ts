/**
 * Move submission client.
 *
 * Talks to the devnet move proxy (devnet/move_proxy.py) which translates
 * simple HTTP requests into XayaAccounts smart contract calls.
 * This avoids needing ABI encoding or wallet signing in the browser.
 *
 * For production, this will be replaced by direct window.ethereum calls.
 */

import { GAME_ID } from "../config.js";

export class MoveClient {
  constructor(public proxyUrl: string) {}

  /** Register a new player (creates Xaya name + sends register move). */
  async register(name: string): Promise<void> {
    await this.send({ action: "register", name });
  }

  /** Submit a game move and mine a block. */
  async move(name: string, gameMove: object): Promise<void> {
    await this.send({
      action: "move",
      name,
      game: GAME_ID,
      data: gameMove,
    });
  }

  /** Mine N blocks (advance the chain). */
  async mine(blocks: number = 1): Promise<void> {
    await this.send({ action: "mine", blocks });
  }

  /** Check if the proxy is reachable. */
  async ping(): Promise<boolean> {
    try {
      const resp = await fetch(this.proxyUrl + "/ping", { method: "GET" });
      return resp.ok;
    } catch {
      return false;
    }
  }

  // --- Convenience methods for specific game moves ---

  async registerPlayer(name: string): Promise<void> {
    await this.register(name);
    await this.move(name, { r: {} });
    await this.mine();
  }

  async discover(name: string, depth: number, dir: string): Promise<void> {
    await this.move(name, { d: { depth, dir } });
    await this.mine();
  }

  async travel(name: string, dir: string): Promise<void> {
    await this.move(name, { t: { dir } });
    await this.mine();
  }

  async enterChannel(name: string, segmentId: number): Promise<void> {
    await this.move(name, { ec: { id: segmentId } });
    await this.mine();
  }

  async exitChannel(
    name: string,
    visitId: number,
    results: { survived: boolean; xp: number; gold: number; kills: number },
    actions: object[],
  ): Promise<void> {
    await this.move(name, { xc: { id: visitId, results, actions } });
    await this.mine();
  }

  async useItem(name: string, itemId: string): Promise<void> {
    await this.move(name, { ui: { item: itemId } });
    await this.mine();
  }

  async equip(name: string, rowid: number, slot: string): Promise<void> {
    await this.move(name, { eq: { rowid, slot } });
    await this.mine();
  }

  async allocateStat(name: string, stat: string): Promise<void> {
    await this.move(name, { as: { stat } });
    await this.mine();
  }

  // --- Internal ---

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
