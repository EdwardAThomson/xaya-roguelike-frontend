/**
 * Configuration defaults for GSP and devnet connections.
 */

export const DEFAULT_GSP_URL = "http://localhost:18332";
export const DEFAULT_PROXY_URL = "http://localhost:18380";
export const POLL_INTERVAL_MS = 2000;
export const GAME_ID = "rog";

/**
 * Which move transport to use. "proxy" routes moves through the devnet
 * HTTP proxy (active). "wallet" routes them through window.ethereum
 * signing (wired in but not yet enabled — see net/walletTransport.ts).
 */
export type MoveTransportKind = "proxy" | "wallet";
export const MOVE_TRANSPORT: MoveTransportKind = "proxy";

/**
 * Wallet (production) settings. Only consulted when MOVE_TRANSPORT is
 * "wallet". Left as placeholders until the wallet path is enabled.
 */
export const XAYA_ACCOUNTS_ADDRESS = ""; // XayaAccounts contract address
export const EVM_CHAIN_ID = 0; // target chain id (e.g. 137 for Polygon)
