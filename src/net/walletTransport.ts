/**
 * Wallet-based move transport (production path) — WIRED IN BUT DORMANT.
 *
 * The intent: submit moves by having the user's browser wallet sign
 * XayaAccounts.move(ns, name, value) transactions directly, replacing the
 * devnet HTTP proxy. The connection flow below is real; actual move
 * submission is intentionally not implemented yet and throws.
 *
 * To enable: set MOVE_TRANSPORT = "wallet" in config.ts, fill in
 * XAYA_ACCOUNTS_ADDRESS / EVM_CHAIN_ID, and implement submitMove/register.
 */

import { EVM_CHAIN_ID, XAYA_ACCOUNTS_ADDRESS } from "../config.js";
import type { MoveTransport } from "./moves.js";

const NOT_ENABLED =
  "Wallet move submission is not enabled yet. Use the devnet proxy " +
  "(MOVE_TRANSPORT = 'proxy') for now.";

/** Minimal shape of an EIP-1193 provider (e.g. MetaMask). */
interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function getProvider(): Eip1193Provider | undefined {
  return (globalThis as { ethereum?: Eip1193Provider }).ethereum;
}

export class WalletMoveTransport implements MoveTransport {
  private account: string | null = null;

  /**
   * Prompts the wallet for account access and records the selected
   * address. Safe to call now; nothing downstream uses it until move
   * submission is implemented.
   */
  async connect(): Promise<string> {
    const provider = getProvider();
    if (!provider) {
      throw new Error("No EVM wallet found (window.ethereum missing). Install MetaMask.");
    }
    const accounts = (await provider.request({
      method: "eth_requestAccounts",
    })) as string[];
    const account = accounts?.[0];
    if (!account) {
      throw new Error("Wallet returned no account.");
    }
    this.account = account;
    return account;
  }

  get connectedAccount(): string | null {
    return this.account;
  }

  async register(_name: string): Promise<void> {
    // TODO: register/acquire the Xaya name on XAYA_ACCOUNTS_ADDRESS via the wallet.
    void XAYA_ACCOUNTS_ADDRESS;
    throw new Error(NOT_ENABLED);
  }

  async submitMove(_name: string, _gameMove: object): Promise<void> {
    // TODO: ABI-encode XayaAccounts.move(ns="p", name, value=JSON{g:{rog:move}})
    // and send via provider.request({ method: "eth_sendTransaction", ... }).
    void EVM_CHAIN_ID;
    throw new Error(NOT_ENABLED);
  }

  async mine(_blocks: number = 1): Promise<void> {
    // No-op: a production EVM network mines its own blocks.
  }

  async ping(): Promise<boolean> {
    return getProvider() !== undefined;
  }
}
