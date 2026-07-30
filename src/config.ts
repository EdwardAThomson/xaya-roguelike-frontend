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

/**
 * Optional endpoint overrides. A test harness (or a hosted deploy) can point
 * the frontend at a different GSP / move proxy without touching the defaults,
 * via `?gsp=` / `?proxy=` query params or globals set before this module
 * loads (`window.__ROG_GSP` / `window.__ROG_PROXY`). Returns null when no
 * override is present, so default behaviour is unchanged. Purely additive.
 */
function endpointOverrides(): { gsp?: string; proxy?: string } {
  const out: { gsp?: string; proxy?: string } = {};
  if (typeof location !== "undefined") {
    const q = new URLSearchParams(location.search);
    const gsp = q.get("gsp");
    const proxy = q.get("proxy");
    if (gsp) out.gsp = gsp;
    if (proxy) out.proxy = proxy;
  }
  const g = globalThis as unknown as { __ROG_GSP?: string; __ROG_PROXY?: string };
  if (!out.gsp && typeof g.__ROG_GSP === "string" && g.__ROG_GSP) out.gsp = g.__ROG_GSP;
  if (!out.proxy && typeof g.__ROG_PROXY === "string" && g.__ROG_PROXY) out.proxy = g.__ROG_PROXY;
  return out;
}

/**
 * True when served from a real domain (a hosted deploy), false for
 * localhost / 127.0.0.1 / file:// and non-browser contexts (tests). Used to
 * decide endpoint defaults and to hide the manual GSP box on hosted builds,
 * where the endpoint is fixed and same-origin.
 */
export function isHostedOrigin(): boolean {
  if (typeof location === "undefined") return false;
  const host = location.hostname;
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "" ||
    location.protocol === "file:";
  return !isLocal;
}

function defaultEndpoints(): { gsp: string; proxy: string } {
  // Hosted: same-origin paths handled by the reverse proxy.
  if (isHostedOrigin()) {
    return { gsp: `${location.origin}/gsp`, proxy: `${location.origin}/proxy` };
  }
  // Local dev / tests: the fixed devnet ports.
  return { gsp: "http://localhost:18332", proxy: "http://localhost:18380" };
}

const overrides = endpointOverrides();
const base = defaultEndpoints();
const endpoints = {
  gsp: overrides.gsp ?? base.gsp,
  proxy: overrides.proxy ?? base.proxy,
};

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
