/**
 * Shared helpers for the DOM-driven UI E2E suite (ui.mjs).
 *
 * The philosophy: drive the FLOW UNDER TEST through the real DOM (click real
 * buttons, press real keys) and assert the observable result. The ?e2e=1
 * `window.__rog` hook is used only for (a) reading game state to assert on and
 * (b) SETUP navigation to reach a state (walking a dungeon, which is not the
 * feature under test in most cases). Anything that IS the feature under test
 * (register button, inventory buttons, modal tabs, discover buttons, keys) is
 * exercised through genuine DOM events.
 */
import { bfsStep, HUB, isHub, sameSeg, segStr, stepCoord } from "./agentcore.mjs";

// Re-exported so the suites can import all their segment-coordinate helpers
// from one place. A segment IS its {x, y} coordinate; the hub is (0, 0).
export { HUB, isHub, sameSeg, segStr, stepCoord };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wrap a Playwright page with the state/call/DOM helpers the tests use. */
export function ctx(page) {
  const state = () => page.evaluate(() => globalThis.__rog.state());
  const map = () => page.evaluate(() => globalThis.__rog.map());
  const call = (fn, ...args) =>
    page.evaluate(([f, a]) => globalThis.__rog[f](...a), [fn, args]);

  async function waitState(pred, label, ms = 30000, intervalMs = 300) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < ms) {
      last = await state();
      if (pred(last)) return last;
      await sleep(intervalMs);
    }
    throw new Error(`timeout waiting for: ${label}\n  last: ${JSON.stringify(summary(last))}`);
  }

  // --- Generic modal helpers (#modal-root: error / confirm dialogs) ---

  /** Text of the error/confirm modal, or null. */
  const rootModalText = () =>
    page.$eval("#modal-root", (e) => e.textContent).catch(() => null);

  /** Click the confirm/dismiss button of an error/confirm modal if present. */
  async function acceptRootModal() {
    const btn = await page.$("#modal-root .modal-confirm, #modal-root .modal-dismiss");
    if (btn) { await btn.click(); await sleep(200); return true; }
    return false;
  }
  async function cancelRootModal() {
    const btn = await page.$("#modal-root .modal-cancel");
    if (btn) { await btn.click(); await sleep(200); return true; }
    return false;
  }

  /** Focus the game canvas so keyboard shortcuts are not swallowed by inputs. */
  async function focusGame() {
    await page.$eval("#game-canvas", (el) => el.click());
    await sleep(100);
  }

  return {
    page, state, map, call, waitState, sleep,
    rootModalText, acceptRootModal, cancelRootModal, focusGame,
  };
}

export function summary(s) {
  if (!s) return null;
  return {
    status: s.status,
    seg: segStr(s.player?.segment),
    inChannel: s.player?.in_channel,
    hp: s.player?.hp,
    maxHp: s.player?.max_hp,
    mode: s.mode,
    busy: s.busy,
    modal: s.modal ? s.modal.slice(0, 120) : null,
  };
}

/**
 * Connect + register a fresh player entirely through the DOM: Play button,
 * type the name, Connect button, then the sidebar Register button. Returns
 * once the player exists on-chain. `gspUrl` is already prefilled from the
 * ?gsp override, so we do not touch that field.
 */
export async function domConnectAndRegister(c, name) {
  const { page, state, waitState } = c;
  // Landing -> Play (real click) reveals the game and focuses the name input.
  const play = await page.$("#landing-play-btn");
  if (play) await play.click();
  await page.fill("#player-name", name);
  await page.click("#connect-btn");
  await waitState((s) => s.status === "connected", "connected");

  let s = await state();
  if (!s.player) {
    // Sidebar shows the Register button when the player does not exist.
    await page.waitForSelector('[data-action="register"]', { timeout: 15000 });
    await page.click('[data-action="register"]');
    s = await waitState((x) => !!x.player, "player registered", 40000);
  }
  return s;
}

/** Open the tabbed game modal via the I key (real keypress). */
export async function openModalViaKey(c) {
  await c.focusGame();
  await c.page.keyboard.press("i");
  await c.page.waitForSelector("#game-modal", { timeout: 5000 });
}

/** Open the tabbed game modal via the sidebar "Manage (I)" button. */
export async function openModalViaButton(c) {
  await c.page.click('[data-action="open-inventory"]');
  await c.page.waitForSelector("#game-modal", { timeout: 5000 });
}

/** Close the tabbed game modal via its ✕ button if open. */
export async function closeModal(c) {
  const btn = await c.page.$('#game-modal [data-action="close-modal"]');
  if (btn) { await btn.click(); await sleep(200); }
}

export async function modalOpen(c) {
  return (await c.page.$("#game-modal")) !== null;
}

/**
 * Force every overlay closed between tests so a lingering modal never
 * intercepts the next test's clicks. Presses Escape (dismisses game modal /
 * help / confirm) and, as a hard fallback, removes any overlay nodes.
 */
export async function resetOverlays(c) {
  for (let i = 0; i < 3; i++) {
    if (!(await c.page.$("#game-modal, #help-modal, #modal-root"))) break;
    await c.page.keyboard.press("Escape");
    await sleep(150);
  }
  await c.page.evaluate(() => {
    for (const id of ["game-modal", "help-modal", "modal-root"]) {
      document.getElementById(id)?.remove();
    }
    document.body.classList.remove("inv-open");
  });
  await sleep(100);
}

/** Switch the active tab in the game modal by clicking its tab button. */
export async function clickTab(c, tab) {
  await c.page.click(`#game-modal .modal-tab[data-tab="${tab}"]`);
  await sleep(150);
}

/** Active tab label text (the .modal-tab.active button). */
export async function activeTab(c) {
  return c.page.$eval("#game-modal .modal-tab.active", (e) => e.textContent.trim())
    .catch(() => null);
}

/**
 * Walk the player (already in a channel) to a gate and out via genuine keyboard
 * presses where possible; falls back to the __rog input hook for the actual
 * step (navigation is SETUP, not the feature under test). Picks up any ground
 * item on the way. Returns final state (out of channel), or throws on timeout.
 *
 * opts.collect: if true, detour to the nearest reachable ground item first.
 * opts.preferDir: which gate to leave by (default: entry gate / come back).
 */
export async function runOutViaGate(c, opts = {}) {
  const { state, map, call } = c;
  const walls = (await map())?.walls;
  if (!walls) throw new Error("runOutViaGate: no map");
  const tried = new Set();   // ground-item tiles we have already tried to grab

  for (let t = 0; t < 600; t++) {
    const s = await state();
    if (!s.player?.in_channel) return s;
    if (s.modal) { await c.acceptRootModal(); await sleep(200); continue; }
    if (s.busy) { await sleep(150); continue; }
    const sess = s.session;
    if (!sess) { await sleep(150); continue; }
    if (sess.gameOver) { await call("exitChannel"); await sleep(400); continue; }

    const liveHp = sess.hp ?? s.player.hp;
    const liveMax = sess.maxHp ?? s.player.max_hp;
    const havePotion = s.player.inventory.some(
      (i) => i.slot === "bag" && i.item_id === "health_potion");
    if (liveHp < liveMax * 0.45 && liveHp < liveMax && havePotion) {
      await call("input", "use_potion"); await sleep(150); continue;
    }

    // Standing on a ground item -> pick it up with the real G key.
    const onItem = sess.groundItems.find(
      (g) => g.x === sess.playerX && g.y === sess.playerY);
    if (onItem) {
      await c.focusGame();
      await c.page.keyboard.press("g");
      await sleep(200);
      tried.add(`${sess.playerX},${sess.playerY}`);
      continue;
    }

    // Choose a target: an adjacent monster (clear the path), else the nearest
    // not-yet-tried reachable ground item (collect ALL when opts.collect), else
    // a gate.
    const adj = sess.monsters.find(
      (m) => Math.abs(m.x - sess.playerX) <= 1 && Math.abs(m.y - sess.playerY) <= 1);
    let target = null;
    if (adj) {
      target = adj;
    } else if (opts.collect && sess.groundItems.length) {
      let best = null, bestLen = Infinity;
      for (const g of sess.groundItems) {
        if (tried.has(`${g.x},${g.y}`)) continue;
        const st = bfsStep(walls, sess.playerX, sess.playerY, g.x, g.y);
        if (st && (st[0] || st[1])) {
          const len = Math.abs(g.x - sess.playerX) + Math.abs(g.y - sess.playerY);
          if (len < bestLen) { bestLen = len; best = g; }
        }
      }
      target = best;
    }
    if (!target) {
      if (opts.preferNonEntry) {
        // Leave via a gate OTHER than the one we entered by, so the player
        // genuinely traverses the segment. An instant exit back through the
        // entry gate does not count as a survived run (so it never confirms a
        // provisional segment); a real traversal does.
        const entry = s.player.active_visit?.entry_direction;
        let best = null, bestLen = -1;
        for (const g of sess.gates) {
          if (g.direction === entry) continue;
          const st = bfsStep(walls, sess.playerX, sess.playerY, g.x, g.y);
          if (st && (st[0] || st[1])) {
            const len = Math.abs(g.x - sess.playerX) + Math.abs(g.y - sess.playerY);
            if (len > bestLen) { bestLen = len; best = g; }
          }
        }
        target = best;
      }
      if (!target) {
        const dir = opts.preferDir || s.player.active_visit?.entry_direction
          || sess.gates[0]?.direction;
        target = sess.gates.find((g) => g.direction === dir) || sess.gates[0];
      }
    }

    const step = bfsStep(walls, sess.playerX, sess.playerY, target.x, target.y);
    if (!step || (!step[0] && !step[1])) { await call("input", "wait"); await sleep(120); continue; }
    await call("input", "move", step[0], step[1]);
    await sleep(120);
  }
  throw new Error("runOutViaGate: timed out still in channel");
}

/**
 * In a setup loop, handle any modal that pops up WITHOUT accidentally walking
 * through a gate: a gate-walk confirm ("Walk through the ... gate?") is
 * cancelled (so we stay in the run); anything else is dismissed/accepted.
 */
export async function handleStrayModal(c) {
  const txt = await c.rootModalText();
  if (txt && /Walk through the/i.test(txt)) { await c.cancelRootModal(); return; }
  await c.acceptRootModal();
}

/**
 * Drive the player to death inside the current channel: seek out monsters,
 * never heal, and keep attacking until the run is game over, then settle
 * (exitChannel) so the death lands on-chain and the player respawns at the
 * hub. Returns the final state. If the segment has no monsters left and the
 * player is still alive (too shallow to die), returns the still-in-channel
 * state so the caller can skip. Navigation is setup via the hook.
 */
export async function dieInChannel(c) {
  const { state, map, call } = c;
  const walls = (await map())?.walls;
  if (!walls) throw new Error("dieInChannel: no map");
  let noMonsterTicks = 0;

  for (let t = 0; t < 1200; t++) {
    const s = await state();
    if (!s.player?.in_channel) return s;
    if (s.modal) { await handleStrayModal(c); await sleep(200); continue; }
    if (s.busy) { await sleep(150); continue; }
    const sess = s.session;
    if (!sess) { await sleep(150); continue; }
    if (sess.gameOver) { await call("exitChannel"); await sleep(400); continue; }

    let nearest = null, nd = Infinity;
    for (const m of sess.monsters) {
      const d = Math.abs(m.x - sess.playerX) + Math.abs(m.y - sess.playerY);
      if (d < nd) { nd = d; nearest = m; }
    }
    if (!nearest) {
      // Nothing left to kill us here. Give it a few ticks (a monster may be
      // out of view), then give up so the caller can skip this flow.
      if (++noMonsterTicks > 12) return s;
      await call("input", "wait"); await sleep(120); continue;
    }
    noMonsterTicks = 0;
    if (nd <= 1) {
      // Adjacent: WAIT and let the monster hit us. We deliberately do NOT move
      // into it (that would attack and kill it, removing the threat); waiting
      // lets even a weak monster whittle us down to death with no healing.
      await call("input", "wait"); await sleep(120); continue;
    }
    const step = bfsStep(walls, sess.playerX, sess.playerY, nearest.x, nearest.y);
    if (!step || (!step[0] && !step[1])) { await call("input", "wait"); await sleep(120); continue; }
    await call("input", "move", step[0], step[1]);
    await sleep(120);
  }
  throw new Error("dieInChannel: player would not die within budget");
}

/**
 * At the hub, discover a fresh provisional frontier segment via the real
 * DOM discover button (guaranteed to spawn monsters, unlike a re-entered
 * confirmed segment). Returns the direction discovered, or null if discovery
 * is on cooldown or no open direction exists.
 */
export async function discoverFreshFrontier(c) {
  const { page, state, waitState } = c;
  const s = await state();
  const statsText = await page.$eval("#stats-display", (e) => e.textContent).catch(() => "");
  if (/cooldown/i.test(statsText)) return null;
  const btn = await page.$('[data-action="discover"]');
  if (!btn) return null;
  const dir = await btn.evaluate((e) => e.dataset.dir);
  const before = s.segments.length;
  await page.click(`[data-action="discover"][data-dir="${dir}"]`);
  await waitState((x) => x.segments.length > before, `discovered ${dir}`, 30000).catch(() => {});
  return dir;
}

/** Discovery cooldown blocks remaining (0 = ready), from game state. */
export function discoverCooldown(s) {
  const p = s.player;
  if (!p || !p.last_discover_height) return 0;
  return Math.max(0, (p.last_discover_height + 50) - (s.height ?? 0));
}

/** Wait until the discovery cooldown has elapsed (chain auto-mines ~1 blk/s). */
export async function waitDiscoverReady(c, ms = 75000) {
  await c.waitState((s) => discoverCooldown(s) === 0, "discovery cooldown to clear", ms, 1000);
}

/** If the player is in a channel, drink-free walk them out via a gate to the hub. */
export async function returnToHub(c) {
  const s = await c.state();
  if (!s.player?.in_channel) return s;
  return runOutViaGate(c).catch(() => c.state());
}

/**
 * Overworld neighbour segment (confirmed?) in a given direction from a segment
 * coordinate. A gate always leads to the neighbouring cell, so this is just the
 * segment sitting at the offset coordinate. `from` defaults to the hub (0, 0);
 * note the hub itself is not in the segment list, so asking for the neighbour
 * of a hub-adjacent segment in the hubward direction returns null.
 */
export function neighbourInDir(s, from, dir) {
  const target = stepCoord(from ?? HUB, dir);
  return s.segments.find((x) => x.x === target.x && x.y === target.y) || null;
}
