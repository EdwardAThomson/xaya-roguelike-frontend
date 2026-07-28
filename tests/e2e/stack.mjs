/**
 * Isolated full-stack harness for the Playwright UI E2E suite.
 *
 * Spins up a COMPLETE, self-contained roguelike stack on ports that do NOT
 * collide with a live devnet (18332 / 18380 / 8000 / 8545):
 *
 *   - anvil + xayax + GSP daemon + move proxy  -> devnet/frontend_devnet.py
 *     driven on alt ports via ROG_GSP_PORT / ROG_PROXY_PORT / ROG_BASE_PORT.
 *   - a static server for the built frontend    -> serve.py on an alt port.
 *
 * Playwright then opens the frontend with ?e2e=1&gsp=...&proxy=... so the
 * browser talks to THIS stack, never the live one. The chain is brand new,
 * so the suite owns the whole world and can set up state deterministically.
 *
 * Everything launches in its own process group; stop() SIGINTs the group so
 * frontend_devnet.py runs its graceful teardown (stops the GSP, tears down
 * anvil/xayax, removes its temp dir), then hard-kills as a fallback.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

// Repo layout. Overridable via env for unusual checkouts.
export const FRONTEND_DIR =
  process.env.ROG_FRONTEND_DIR || path.resolve(HOME, "Projects/xaya-roguelike-frontend");
export const BACKEND_DIR =
  process.env.ROG_BACKEND_DIR || path.resolve(HOME, "Projects/xayaroguelike");
const VENV_PY =
  process.env.ROG_VENV_PY || path.resolve(HOME, "Explore/xayax/.venv/bin/python3");

// Alt ports. Chosen to avoid the live devnet (18332/18380/8000/8545) and its
// anvil/xayax pool (observed around 26516+). The pool base (23100) sits well
// clear of both.
export const PORTS = {
  gsp: Number(process.env.ROG_ALT_GSP_PORT || 18432),
  proxy: Number(process.env.ROG_ALT_PROXY_PORT || 18480),
  frontend: Number(process.env.ROG_ALT_FRONTEND_PORT || 8100),
  base: Number(process.env.ROG_ALT_BASE_PORT || 23100),
};

export const GSP_URL = `http://localhost:${PORTS.gsp}`;
export const PROXY_URL = `http://localhost:${PORTS.proxy}`;
export const FRONTEND_URL = `http://localhost:${PORTS.frontend}`;
export const PAGE_URL =
  `${FRONTEND_URL}/?e2e=1&gsp=${encodeURIComponent(GSP_URL)}&proxy=${encodeURIComponent(PROXY_URL)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeoutMs, intervalMs = 500) {
  const t0 = Date.now();
  let lastErr;
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await fn()) return;
    } catch (e) {
      lastErr = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? ` (${lastErr.message})` : ""}`);
}

async function httpOk(url, opts) {
  const resp = await fetch(url, opts);
  return resp.ok;
}

async function gspSynced(url) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "getcurrentstate", params: [], id: 1 }),
  });
  if (!resp.ok) return false;
  const json = await resp.json();
  return !!json.result;
}

export class RogStack {
  constructor(opts = {}) {
    this.log = opts.log ?? ((m) => console.log(`[stack] ${m}`));
    this.procs = [];
  }

  _spawn(name, cmd, args, cwd, extraEnv = {}) {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      detached: true, // own process group, so we can signal the whole tree
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tag = `[${name}]`;
    const onData = (buf) => {
      if (process.env.ROG_STACK_VERBOSE)
        process.stderr.write(`${tag} ${buf}`);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code, sig) => {
      this.log(`${name} exited (code=${code} sig=${sig})`);
    });
    this.procs.push({ name, child });
    return child;
  }

  async start() {
    if (!existsSync(VENV_PY))
      throw new Error(`xayax venv python not found at ${VENV_PY} (set ROG_VENV_PY)`);
    if (!existsSync(path.join(BACKEND_DIR, "build", "rogueliked")))
      throw new Error(`GSP binary missing; build the backend first (${BACKEND_DIR}/build/rogueliked)`);
    if (!existsSync(path.join(FRONTEND_DIR, "dist", "main.js")))
      throw new Error(`frontend not built; run 'npx tsc' in ${FRONTEND_DIR}`);

    this.log(`starting backend stack (GSP ${PORTS.gsp}, proxy ${PORTS.proxy}, pool ${PORTS.base}+)`);
    this._spawn(
      "devnet",
      VENV_PY,
      [path.join(BACKEND_DIR, "devnet", "frontend_devnet.py")],
      BACKEND_DIR,
      {
        ROG_GSP_PORT: String(PORTS.gsp),
        ROG_PROXY_PORT: String(PORTS.proxy),
        ROG_BASE_PORT: String(PORTS.base),
        // Keep the chain ticking so block-timers (discovery cooldown) advance,
        // but fast, so tests do not wait long.
        ROG_MINE_INTERVAL: process.env.ROG_MINE_INTERVAL || "1",
        // Rate limit OFF: automated play must not be throttled.
        ROG_RATE_LIMIT_MAX: "0",
      },
    );

    this.log(`starting static frontend server on ${PORTS.frontend}`);
    this._spawn(
      "serve",
      VENV_PY,
      [path.join(FRONTEND_DIR, "serve.py"), String(PORTS.frontend)],
      FRONTEND_DIR,
    );

    this.log("waiting for move proxy...");
    await waitFor(() => httpOk(`${PROXY_URL}/ping`), "move proxy /ping", 90000);
    this.log("waiting for GSP to sync...");
    await waitFor(() => gspSynced(GSP_URL), "GSP getcurrentstate", 90000);
    this.log("waiting for frontend...");
    await waitFor(() => httpOk(`${FRONTEND_URL}/index.html`), "frontend static server", 30000);
    this.log("stack ready");
  }

  async stop() {
    this.log("stopping stack...");
    for (const { child } of this.procs) {
      try {
        process.kill(-child.pid, "SIGINT"); // graceful: signal the group
      } catch { /* already gone */ }
    }
    // Give frontend_devnet.py time to tear anvil/xayax/GSP down cleanly.
    await sleep(4000);
    for (const { child } of this.procs) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch { /* already gone */ }
    }
    await sleep(500);
  }
}
