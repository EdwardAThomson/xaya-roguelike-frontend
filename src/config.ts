/**
 * Configuration defaults for GSP and devnet connections.
 *
 * Local dev (served from localhost / file://) talks directly to the
 * devnet GSP and move proxy on their fixed ports. A hosted deployment
 * (served from a real domain) routes both through the SAME origin behind
 * a TLS reverse proxy: `/gsp` relays read-only GSP calls and `/proxy`
 * carries moves. Keeping everything same-origin avoids mixed-content and
 * CORS issues and means the GSP RPC port never has to be public.
 */

function defaultEndpoints(): { gsp: string; proxy: string } {
  // Node / non-browser contexts (tests): fall back to the devnet ports.
  if (typeof location === "undefined") {
    return { gsp: "http://localhost:18332", proxy: "http://localhost:18380" };
  }
  const host = location.hostname;
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "" ||
    location.protocol === "file:";
  if (isLocal) {
    return { gsp: "http://localhost:18332", proxy: "http://localhost:18380" };
  }
  // Hosted: same-origin paths handled by the reverse proxy.
  return { gsp: `${location.origin}/gsp`, proxy: `${location.origin}/proxy` };
}

const endpoints = defaultEndpoints();

export const DEFAULT_GSP_URL = endpoints.gsp;
export const DEFAULT_PROXY_URL = endpoints.proxy;
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
