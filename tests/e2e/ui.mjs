/**
 * DOM-driven end-to-end UI suite for the Xaya Roguelike frontend.
 *
 * Spins up an ISOLATED full stack (its own anvil + xayax + GSP + move proxy +
 * static server on alt ports, see stack.mjs) so it never touches a live devnet,
 * then drives the REAL browser DOM (clicks / keypresses) through the core user
 * flows and asserts the observable outcome of each. The ?e2e=1 window.__rog
 * hook is used only to read state and to perform SETUP navigation (walking a
 * dungeon), never to stand in for the feature under test.
 *
 * Run:  npm run e2e:ui
 * Env:  ROG_HEADED=1 to watch, ROG_STACK_VERBOSE=1 for stack logs,
 *       ROG_KEEP=1 to leave the stack up on exit (debugging),
 *       ROG_ONLY="T1,T6" to run a subset by id.
 */
import { chromium } from "playwright";
import { RogStack, PAGE_URL, PROXY_URL, GSP_URL } from "./stack.mjs";
import {
  ctx, summary, sleep, domConnectAndRegister,
  openModalViaKey, openModalViaButton, closeModal, modalOpen,
  clickTab, activeTab, runOutViaGate, dieInChannel, neighbourInDir, resetOverlays,
  handleStrayModal, discoverFreshFrontier, returnToHub, waitDiscoverReady,
} from "./helpers.mjs";
import { bfsStep } from "./agentcore.mjs";

const NAME = "e2e" + Date.now().toString(36).slice(-6);
const results = [];   // { id, name, status: pass|fail|skip, checks: [...] }

class SkipError extends Error {}

/** POST a JSON action to the isolated move proxy; returns { status, body }. */
async function proxy(action, extra = {}) {
  const resp = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
  });
  const body = await resp.text();
  return { status: resp.status, body };
}

/** Read a player straight from the GSP (used to assert on-chain existence). */
async function gspPlayer(name) {
  const resp = await fetch(GSP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "getplayerinfo", params: [name], id: 1 }),
  });
  const json = await resp.json();
  const r = json.result;
  return r && typeof r === "object" && "data" in r ? r.data : r;
}

// --- Take damage until hurt below `ratio` of max hp (setup). ---
// Approach the nearest monster and WAIT next to it, letting it hit us without
// killing it (moving INTO a monster attacks it, so at shallow depth the
// character would one-shot weak monsters and never get hurt). Waiting adjacent
// reliably accrues damage from even a weak monster.
async function takeDamage(c, ratio = 0.7, budget = 120) {
  const walls = (await c.map())?.walls;
  let noMon = 0;
  for (let t = 0; t < budget; t++) {
    const s = await c.state();
    if (!s.player?.in_channel) return s;
    if (s.modal) { await handleStrayModal(c); await sleep(150); continue; }
    if (s.busy) { await sleep(120); continue; }
    const sess = s.session;
    if (!sess || sess.gameOver) return s;
    const liveHp = sess.hp ?? s.player.hp, liveMax = sess.maxHp ?? s.player.max_hp;
    if (liveHp <= liveMax * ratio) return s;
    let nearest = null, nd = Infinity;
    for (const m of sess.monsters) {
      const d = Math.abs(m.x - sess.playerX) + Math.abs(m.y - sess.playerY);
      if (d < nd) { nd = d; nearest = m; }
    }
    if (!nearest) { if (++noMon > 12) return s; await c.call("input", "wait"); await sleep(120); continue; }
    noMon = 0;
    if (nd <= 1) {
      // Adjacent: WAIT so the monster attacks us (do not move into it).
      await c.call("input", "wait");
    } else {
      const step = bfsStep(walls, sess.playerX, sess.playerY, nearest.x, nearest.y);
      if (!step) await c.call("input", "wait");
      else await c.call("input", "move", step[0] || 0, step[1] || 0);
    }
    await sleep(120);
  }
  return c.state();
}

// --- Enter the (discoverer's) provisional/confirmed neighbour via the hook. --
async function enterNeighbour(c, dir) {
  await c.call("gateWalk", dir);
  return c.waitState((s) => s.player?.in_channel, `entered channel ${dir}`, 40000);
}

// ============================ TEST DEFINITIONS ============================
// Each test: { id, name, fn(t) }. `t` gives { c, page, check, skip, world }.
// Tests run sequentially against ONE page/player, building world state.

const tests = [];
const test = (id, name, fn) => tests.push({ id, name, fn });

// ---- T1: landing -> play -> connect + register + re-register recovery ----
test("T1", "register a fresh player, then re-register the same name (no 500)", async (t) => {
  const { c, page, check } = t;
  const s = await domConnectAndRegister(c, NAME);
  check("player exists after register", !!s.player);
  check("registered at the hub (segment 0)", s.player?.current_segment === 0);
  check("full HP on a fresh character", s.player?.hp === s.player?.max_hp);

  // Re-register the SAME name. The proxy `register` re-mints; the shipped fix
  // makes an already-minted name return 200 (not 500) so the retry's register
  // move can still land. Assert both proxy calls succeed and the player stays.
  const r1 = await proxy("register", { name: NAME });
  const r2 = await proxy("register", { name: NAME });
  check("2nd proxy register does NOT 500 (already-minted recovery)", r2.status === 200,
    `status=${r2.status} body=${r2.body}`);
  check("1st proxy register also ok", r1.status === 200);

  // And drive the frontend's own register path again (doRegister) for the same
  // name: it must not raise the "Registration failed" modal, and the player
  // must still exist on-chain afterwards.
  await c.call("register");
  await sleep(1500);
  const modalTxt = await c.rootModalText();
  check("no 'Registration failed' modal on re-register",
    !(modalTxt && /Registration failed|rejected/i.test(modalTxt)), `modal=${modalTxt}`);
  const onchain = await gspPlayer(NAME);
  check("player still exists on-chain after re-register", !!onchain && onchain.name === NAME);
  await c.acceptRootModal();
  t.world.registered = true;
});

// ---- T6: modal tabs / Players / Help / world map (pure DOM) ----
test("T6", "modal tabs switch, Players lists the player, help + map toggle", async (t) => {
  const { c, page, check } = t;

  // Open via the I key.
  await openModalViaKey(c);
  check("I key opens the tabbed game modal", await modalOpen(c));
  check("opens on the Inventory tab", (await activeTab(c)) === "Inventory");

  // Switch tabs by clicking the tab buttons.
  await clickTab(c, "players");
  check("Players tab activates on click", (await activeTab(c)) === "Players");
  const playersText = await page.$eval("#game-modal .modal-tab-body", (e) => e.textContent);
  check("Players tab lists our player", playersText.includes(NAME), playersText.slice(0, 160));

  await clickTab(c, "help");
  check("Help tab activates on click", (await activeTab(c)) === "Help");
  const helpText = await page.$eval("#game-modal .modal-tab-body", (e) => e.textContent);
  check("in-game Help tab shows controls", /Drink health potion|Toggle the world map/i.test(helpText));

  // Close via the ✕ button.
  await closeModal(c);
  check("✕ closes the modal", !(await modalOpen(c)));

  // Topbar Manage (I) button opens it too.
  await openModalViaButton(c);
  check("sidebar Manage button opens the modal", await modalOpen(c));
  await closeModal(c);

  // Standalone help overlay from the title screen: only reachable pre-connect,
  // so assert the in-game topbar Help path here, plus that the standalone
  // overlay markup is wired (open-help-home present on the landing screen was
  // clicked past; open the in-game Help overlay via the ? key instead).
  await c.focusGame();
  await page.keyboard.press("?");
  await page.waitForSelector("#game-modal", { timeout: 5000 }).catch(() => {});
  check("? key opens help (in-game -> Help tab)",
    (await modalOpen(c)) && (await activeTab(c)) === "Help");
  await closeModal(c);

  // M toggles the world map (overworld) vs the dungeon view.
  const before = (await c.state()).mode;
  await c.focusGame();
  await page.keyboard.press("m");
  await sleep(300);
  const afterM = (await c.state()).mode;
  check("M toggles the world map view", afterM !== before, `${before} -> ${afterM}`);
  await c.focusGame();
  await page.keyboard.press("m");
  await sleep(300);
  check("M toggles back", (await c.state()).mode === before);
});

// ---- T2a: hub inventory full-HP potion guard (DOM, non-destructive) ----
test("T2a", "hub inventory: full-HP potion guard shows its message", async (t) => {
  const { c, page, check } = t;
  await openModalViaKey(c);
  await clickTab(c, "inventory");

  const s = await c.state();
  const potionQty = (s.player.inventory || [])
    .filter((i) => i.slot === "bag" && i.item_id === "health_potion")
    .reduce((a, i) => a + i.quantity, 0);
  if (potionQty < 1 || s.player.hp !== s.player.max_hp) {
    await closeModal(c);
    t.skip(`need a potion at full HP (have ${potionQty} @ ${s.player.hp}/${s.player.max_hp})`);
  }

  // Full-HP guard: clicking Use on a health potion at full HP must show the
  // "Already at full HP" modal rather than silently wasting it.
  const useBtn = await page.$('#game-modal .inv-btn.use[data-item="health_potion"]');
  check("a Use button exists for the health potion", !!useBtn);
  if (useBtn) {
    await useBtn.click();
    await sleep(600);
    const m = await c.rootModalText();
    check("full-HP guard message shown", !!m && /full (health|HP)/i.test(m), `modal=${m}`);
    await c.acceptRootModal();
  }
  await closeModal(c);
});

// ---- T4a: discover a frontier segment + cooldown message (DOM) ----
test("T4a", "discover a frontier segment; cooldown blocks a too-soon retry", async (t) => {
  const { c, page, check, world } = t;
  const before = await c.state();
  const segCountBefore = before.segments.length;

  // Ensure we are at the hub view with discover buttons in the sidebar.
  await page.waitForSelector('[data-action="discover"]', { timeout: 15000 });
  const dir = await page.$eval('[data-action="discover"]', (e) => e.dataset.dir);
  await page.click(`[data-action="discover"][data-dir="${dir}"]`);

  const after = await c.waitState((s) => s.segments.length > segCountBefore,
    "a new provisional segment appears", 30000);
  const newSeg = after.segments.find((x) => !before.segments.some((b) => b.id === x.id));
  check("discover created a new segment", !!newSeg, JSON.stringify(newSeg));
  check("the new segment is provisional (unconfirmed)", newSeg && newSeg.confirmed === false);
  world.discoverDir = dir;
  world.provisionalSeg = newSeg?.id;

  // A second discovery now is too-soon: the sidebar must show the cooldown.
  await sleep(500);
  const statsText = await page.$eval("#stats-display", (e) => e.textContent);
  check("cooldown message shown after discovering", /cooldown/i.test(statsText),
    statsText.replace(/\s+/g, " ").slice(0, 160));
});

// ---- T5: loot pickup + persist (also BANKS the settled bag gear that the
// mid-run-equip test, T3, later acts on). This is the first test to enter the
// provisional frontier discovered in T4a, so it enters the channel itself. ----
test("T5", "loot: pick up an item in a run and it persists into the bag on exit", async (t) => {
  const { c, check, world } = t;
  let s = await c.state();
  if (!s.player?.in_channel) {
    // Enter the provisional frontier discovered in T4a to run the loot flow.
    await enterNeighbour(c, world.discoverDir || "north").catch(() => {});
    s = await c.state();
  }
  if (!s.player?.in_channel) t.skip("not in a channel to collect loot");

  // A fresh player's bag is only health potions, so ANY non-potion item in the
  // bag after the run proves collected loot was banked (robust against the
  // potion-in / potion-drunk accounting that leaves the raw count unchanged).
  const nonPotionBefore = s.player.inventory.filter(
    (i) => i.slot === "bag" && i.item_id !== "health_potion").length;
  const hadGround = (s.session?.groundItems?.length ?? 0) > 0;

  // Collect a ground item, then walk out through the entry gate (real G-key
  // pickup; the gate-confirm "Walk" is a real click). Ending on a gate makes it
  // a survived run, which banks the loot/xp and confirms the segment.
  const dir = world.discoverDir || "north";
  const out = await runOutViaGate(c, { collect: true });
  check("run exited through a gate (survived back to overworld)",
    out.player?.in_channel === false, JSON.stringify(summary(out)));

  // A survived run banks its loot/xp AND confirms the previously-provisional
  // segment. The confirmed flag propagates a poll after the player state, so
  // wait for it rather than reading a possibly-stale snapshot.
  const confd = await c.waitState((s) => {
    const nb = neighbourInDir(s, 0, dir);
    return nb && nb.confirmed === true;
  }, "frontier segment confirmed", 20000).catch(() => null);
  check("the survived run confirmed the frontier segment (banked its results)",
    !!confd, confd ? "" : "segment did not confirm within timeout");
  world.confirmedSeg = neighbourInDir(out, 0, dir)?.id;

  const nonPotionAfter = out.player.inventory.filter(
    (i) => i.slot === "bag" && i.item_id !== "health_potion");
  if (!hadGround) {
    t.skip(`no ground loot spawned in this segment to bank`);
  }
  check("collected loot (a non-potion item) persisted into the bag after the gate exit",
    nonPotionAfter.length > nonPotionBefore,
    `non-potion bag items ${nonPotionBefore} -> ${nonPotionAfter.length}: ${nonPotionAfter.map((i) => i.item_id).join(",")}`);
  world.gear = nonPotionAfter[0];
});

// ---- T2b: hub equip/unequip a bag item (DOM), drink while hurt ----
test("T2b", "hub inventory: equip a bag item to its slot, then unequip", async (t) => {
  const { c, page, check, world } = t;
  await c.waitState((s) => s.player && !s.player.in_channel, "back at hub", 20000);
  await openModalViaKey(c);
  if (!(await modalOpen(c))) await openModalViaButton(c);
  await clickTab(c, "inventory");
  const equipBtn = await page.$('#game-modal .inv-btn.equip');
  if (!equipBtn) { await closeModal(c); t.skip("no equippable gear in the bag to equip"); }

  const rowid = Number(await equipBtn.evaluate((e) => e.dataset.rowid));
  const slot = await equipBtn.evaluate((e) => e.dataset.slot);
  await equipBtn.click();
  const equipped = await c.waitState((s) => {
    const it = s.player.inventory.find((i) => i.rowid === rowid);
    return it && it.slot === slot;
  }, "item moved to its slot", 20000);
  check(`equip moved the item to the ${slot} slot`,
    equipped.player.inventory.find((i) => i.rowid === rowid)?.slot === slot);

  // Unequip it back to the bag via the Unequip button.
  if (!(await modalOpen(c))) { await openModalViaButton(c); await clickTab(c, "inventory"); }
  const unequipBtn = await page.$(`#game-modal .inv-btn.unequip[data-rowid="${rowid}"]`);
  check("an Unequip button appears for the equipped item", !!unequipBtn);
  if (unequipBtn) {
    await unequipBtn.click();
    const back = await c.waitState((s) => {
      const it = s.player.inventory.find((i) => i.rowid === rowid);
      return it && it.slot === "bag";
    }, "item back in bag", 20000);
    check("unequip returned the item to the bag",
      back.player.inventory.find((i) => i.rowid === rowid)?.slot === "bag");
  }
  await closeModal(c);
});

// ---- T3: in-dungeon mid-run equip of banked bag gear + drink from modal ----
// Mid-run equip is now a SHIPPED feature: a player can equip already-banked bag
// gear during a run. It calls the live session locally (no on-chain move), takes
// effect immediately in the session, and only lands on-chain when the run
// settles on exit. This runs AFTER T5 (which banks the gear into the bag) and
// AFTER T2b (hub equip/unequip of that same bag gear), so settling this run with
// the item equipped does not starve T2b of a bag item to act on.
test("T3", "in-dungeon: mid-run equip of banked bag gear is local + immediate; drink raises HP", async (t) => {
  const { c, page, check, world } = t;
  const dir = world.discoverDir || "north";

  // Enter a FRESH run in the (now confirmed) neighbour. Its bag carries the gear
  // T5 banked, which mid-run equip can act on (this-run pickups never can).
  await c.waitState((s) => s.player && !s.player.in_channel, "at hub before entering", 20000);
  await enterNeighbour(c, dir);
  const entered = await c.state();
  check("entered a dungeon channel", entered.player?.in_channel === true, JSON.stringify(summary(entered)));

  // A banked BAG equippable item renders an [equip-local] button (distinct from
  // the hub's [equip]). If nothing banked is available, skip honestly rather
  // than assert the OLD read-only invariant, which is no longer true.
  await openModalViaKey(c);
  await clickTab(c, "inventory");
  const equipBtn = await page.$('#game-modal [data-action="equip-local"]');
  if (!equipBtn) {
    await closeModal(c);
    await returnToHub(c);
    t.skip("no banked equippable bag gear available to equip mid-run");
  }
  const rowid = Number(await equipBtn.evaluate((e) => e.dataset.rowid));
  const slot = await equipBtn.evaluate((e) => e.dataset.slot);
  const slotBefore = entered.player.inventory.find((i) => i.rowid === rowid)?.slot;
  check("the banked item starts in the bag (on-chain)", slotBefore === "bag", `slot=${slotBefore}`);

  // Clicking [equip-local] calls the session locally: NO on-chain move, so the
  // player stays in the channel and the on-chain inventory slot is unchanged.
  // The effect is immediate in the live session, which the re-rendered modal
  // reflects: the item moves into its equipped slot, surfacing [unequip-local].
  await equipBtn.click();
  await sleep(400);
  const afterEquip = await c.state();
  check("mid-run equip did NOT leave the channel (local, no settle)",
    afterEquip.player?.in_channel === true, JSON.stringify(summary(afterEquip)));
  check("mid-run equip did NOT change on-chain inventory (still bagged until settle)",
    afterEquip.player.inventory.find((i) => i.rowid === rowid)?.slot === "bag");
  const unequipLocal = await page.$(
    `#game-modal .inv-btn.unequip[data-action="unequip-local"][data-rowid="${rowid}"]`);
  check("the item took effect immediately in the live session (an [unequip-local] button appeared)",
    !!unequipLocal, `rowid=${rowid} slot=${slot}`);
  const stillEquipLocal = await page.$(
    `#game-modal [data-action="equip-local"][data-rowid="${rowid}"]`);
  check("the equipped item no longer offers [equip-local] in the bag", !stillEquipLocal);
  await closeModal(c);

  // Drink from the modal raises live HP (unchanged behaviour). Take a little
  // damage first; if we cannot reach a hurt+potion state, skip only the drink
  // sub-check (the equip assertions above already stand) rather than the test.
  const hurt = await takeDamage(c, 0.8, 80);
  const liveBefore = hurt.session?.hp ?? hurt.player?.hp;
  const maxHp = hurt.session?.maxHp ?? hurt.player?.max_hp;
  const hasPotion = hurt.player?.inventory?.some(
    (i) => i.slot === "bag" && i.item_id === "health_potion");
  if (hurt.player?.in_channel && liveBefore < maxHp && hasPotion) {
    await openModalViaKey(c);
    await clickTab(c, "inventory");
    const drink = await page.$('#game-modal .inv-btn.use[data-action="use-potion-local"]');
    check("a Drink button is available in the dungeon modal", !!drink);
    if (drink) {
      await drink.click();
      await sleep(500);
      const liveAfter = (await c.state()).session?.hp ?? 0;
      check("drinking in-dungeon raised live HP", liveAfter > liveBefore, `${liveBefore} -> ${liveAfter}`);
    }
    await closeModal(c);
  } else {
    console.log(`   note: drink sub-check not set up (hp ${liveBefore}/${maxHp}, potion=${hasPotion}, inChannel=${hurt.player?.in_channel})`);
  }

  // Settle the run by walking out through a gate. The equip action rides the
  // exit proof (the GSP replays it), so the loadout must PERSIST on-chain: the
  // item's slot flips from "bag" to its equipment slot once the run settles.
  // Only assert this when we settle via a survived gate exit (a death mid-setup
  // takes a different xc path and is not what this test covers).
  if (hurt.player?.in_channel) {
    const out = await runOutViaGate(c);
    check("run settled and returned to the overworld", out.player?.in_channel === false,
      JSON.stringify(summary(out)));
    const persisted = await c.waitState(
      (s) => s.player && !s.player.in_channel
        && s.player.inventory.find((i) => i.rowid === rowid)?.slot === slot,
      "equipped loadout persisted on-chain", 20000).catch(() => null);
    check("the mid-run equip persisted on-chain after settling (item now in its slot)",
      !!persisted, persisted ? "" : `slot did not become ${slot} within timeout`);
  }

  // Hand off cleanly to the next hub-based test: the exit gate-walk is only
  // fully done (the frontend's busy flag cleared) once it finishes tearing the
  // run down, and a gate-walk issued while busy is silently a no-op.
  await c.waitState((s) => s.player && !s.player.in_channel
    && s.player.current_segment === 0 && !s.busy,
    "settled idle at the hub", 20000).catch(() => {});
});

// ---- T4b: free transit between confirmed segments; land on the other side ----
test("T4b", "transit hub <-> confirmed segment is free and lands on the other side", async (t) => {
  const { c, check, world } = t;
  const dir = world.discoverDir || "north";
  const s0 = await c.waitState((x) => x.player && !x.player.in_channel, "at hub", 20000);
  const target = neighbourInDir(s0, 0, dir);
  if (!target || !target.confirmed) t.skip("no confirmed neighbour to transit into");

  // Free transit from the hub into the confirmed segment: lands us ON the other
  // side (inside that segment's channel), no survive-requirement, no penalty.
  await c.call("gateWalk", dir);
  const inSeg = await c.waitState((x) => x.player?.in_channel
    && x.player.active_visit?.segment_id === target.id, "transited into confirmed seg", 40000);
  check("free transit landed us inside the confirmed segment",
    inSeg.player.active_visit?.segment_id === target.id);
  check("we entered via the matching (opposite) gate",
    !!inSeg.player.active_visit?.entry_direction, JSON.stringify(inSeg.player.active_visit));

  // Transit straight back to the hub (confirmed -> hub is also free).
  const opposite = { north: "south", south: "north", east: "west", west: "east" }[dir];
  await c.call("gateWalk", opposite);
  const back = await c.waitState((x) => x.player && !x.player.in_channel
    && x.player.current_segment === 0, "returned to hub", 40000);
  check("transit back returned us to the hub (segment 0)", back.player.current_segment === 0);
});

// ---- T7: death and respawn at the hub with reduced HP ----
// Death is only reliable where monsters can actually kill the character, so we
// open a FRESH provisional frontier (which reliably spawns monsters), stand
// next to one and take hits without fighting back until we die. If discovery is
// unavailable or the character somehow survives, we skip honestly. Runs before
// T2c so its respawn (reduced HP) also provides that test's hurt state.
test("T7", "death in a dungeon respawns the player at the hub with reduced HP", async (t) => {
  const { c, check, world } = t;
  const start = await c.waitState((x) => x.player && !x.player.in_channel, "at hub", 20000);
  const maxHp = start.player.max_hp;

  // A fresh provisional frontier reliably has monsters. Wait out any discovery
  // cooldown and open one; only such a segment gives a genuine death attempt.
  await waitDiscoverReady(c).catch(() => {});
  const dir = await discoverFreshFrontier(c);
  if (!dir) { t.skip("discovery unavailable, cannot open a fresh frontier to die in"); }
  await enterNeighbour(c, dir);

  const dead = await dieInChannel(c);
  if (dead.player?.in_channel) {
    await returnToHub(c);
    t.skip("character too strong to die at the available frontier depth");
  }
  check("player is back out of the channel after dying", dead.player?.in_channel === false,
    JSON.stringify(summary(dead)));
  check("respawned at the hub (segment 0)", dead.player?.current_segment === 0);
  check("respawn HP is reduced (< max) but alive (> 0)",
    dead.player?.hp > 0 && dead.player?.hp < maxHp, `hp ${dead.player?.hp}/${maxHp}`);
  world.hurtAtHub = dead.player?.hp < maxHp;
});

// ---- T2c: drink a health potion while hurt at the hub (DOM) ----
test("T2c", "hub inventory: drink a potion while hurt raises HP and drops the count", async (t) => {
  const { c, page, check, world } = t;
  let s = await c.waitState((x) => x.player && !x.player.in_channel, "at hub", 20000);

  // We need a hurt state. The death/respawn test (T7) runs first and normally
  // leaves the player hurt at the hub; if for some reason we are at full HP,
  // take damage on a fresh frontier run and survive out to bank reduced HP.
  if (s.player.hp >= s.player.max_hp) {
    await waitDiscoverReady(c).catch(() => {});
    const dir = await discoverFreshFrontier(c);
    if (dir) {
      await enterNeighbour(c, dir).catch(() => {});
      if ((await c.state()).player?.in_channel) {
        await takeDamage(c, 0.6, 120);
        await returnToHub(c);
      }
      s = await c.waitState((x) => x.player && !x.player.in_channel, "back at hub", 40000)
        .catch(() => c.state());
    }
  }

  const potions = s.player.inventory.filter((i) => i.slot === "bag" && i.item_id === "health_potion");
  const qty = potions.reduce((a, i) => a + i.quantity, 0);
  if (s.player.hp >= s.player.max_hp) t.skip(`could not reach a hurt state at the hub (hp ${s.player.hp}/${s.player.max_hp})`);
  if (qty < 1) t.skip("no health potion in the bag to drink");

  const hpBefore = s.player.hp;
  await openModalViaKey(c);
  if (!(await modalOpen(c))) await openModalViaButton(c);
  await clickTab(c, "inventory");
  const useBtn = await page.$('#game-modal .inv-btn.use[data-item="health_potion"]');
  check("a Use button exists for the health potion (hurt at hub)", !!useBtn);
  if (useBtn) {
    await useBtn.click();
    const healed = await c.waitState((x) => x.player.hp > hpBefore, "HP rose after drinking", 20000);
    check("drinking raised HP", healed.player.hp > hpBefore, `${hpBefore} -> ${healed.player.hp}`);
    const qtyAfter = healed.player.inventory
      .filter((i) => i.slot === "bag" && i.item_id === "health_potion")
      .reduce((a, i) => a + i.quantity, 0);
    check("potion count dropped by one", qtyAfter === qty - 1, `${qty} -> ${qtyAfter}`);
  }
  await closeModal(c);
});

// ---- T2d: discard a bag item (DOM) ----
test("T2d", "hub inventory: discard removes a bag item", async (t) => {
  const { c, page, check } = t;
  await c.waitState((s) => s.player && !s.player.in_channel, "at hub", 20000);
  await openModalViaKey(c);
  if (!(await modalOpen(c))) await openModalViaButton(c);
  await clickTab(c, "inventory");

  const dropBtn = await page.$('#game-modal .inv-btn.discard');
  if (!dropBtn) { await closeModal(c); t.skip("no bag item to discard"); }
  const rowid = Number(await dropBtn.evaluate((e) => e.dataset.rowid));
  await dropBtn.click();
  // Discard raises a confirm modal ("Discard item?"): click Discard.
  await sleep(300);
  await c.acceptRootModal();
  const after = await c.waitState(
    (x) => !x.player.inventory.some((i) => i.rowid === rowid),
    "discarded row removed from inventory", 20000);
  check("discard removed the chosen bag row",
    !after.player.inventory.some((i) => i.rowid === rowid), `rowid ${rowid}`);
  await closeModal(c);
});

// ---- T1b: interrupted-register recovery, driven through the DOM ----
test("T1b", "interrupted register (name pre-minted) still registers via the DOM", async (t) => {
  const { c, page, check } = t;
  const recovName = "recov" + Date.now().toString(36).slice(-6);

  // Simulate an interrupted registration: mint the Xaya name via the proxy but
  // send NO register move, so the NFT exists with no player behind it.
  const mint = await proxy("register", { name: recovName });
  check("pre-mint of the recovery name succeeds", mint.status === 200);
  const preState = await gspPlayer(recovName);
  check("no player exists yet for the pre-minted name", !preState);

  // Disconnect the current player, then connect + register the pre-minted name
  // through the real DOM. With the proxy recovery fix, the already-minted mint
  // returns 200 so the register move lands and the player is created.
  if ((await c.state()).status === "connected") {
    await page.click("#connect-btn");
    await c.waitState((s) => s.status !== "connected", "disconnected", 15000);
  }
  await page.fill("#player-name", recovName);
  await page.click("#connect-btn");
  await c.waitState((s) => s.status === "connected", "reconnected", 20000);
  await page.waitForSelector('[data-action="register"]', { timeout: 15000 });
  await page.click('[data-action="register"]');
  const done = await c.waitState((s) => !!s.player, "recovery player registered", 40000);
  check("player created despite the name already being minted", !!done.player);
  const onchain = await gspPlayer(recovName);
  check("recovery player exists on-chain", !!onchain && onchain.name === recovName);
});

// ============================ RUNNER ============================

async function main() {
  const only = process.env.ROG_ONLY ? process.env.ROG_ONLY.split(",").map((x) => x.trim()) : null;
  const stack = new RogStack();
  await stack.start();

  const browser = await chromium.launch({ headless: !process.env.ROG_HEADED });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("[page error]", e.message));
  const c = ctx(page);
  const world = {};

  try {
    await page.goto(PAGE_URL);
    await page.waitForFunction(() => !!globalThis.__rog, null, { timeout: 20000 });
    console.log(`\nPlayer: ${NAME}   Page: ${PAGE_URL}\n`);

    for (const tc of tests) {
      if (only && !only.includes(tc.id)) continue;
      const rec = { id: tc.id, name: tc.name, status: "pass", checks: [] };
      const check = (desc, cond, extra) => {
        rec.checks.push({ desc, cond: !!cond, extra });
        if (!cond) rec.status = "fail";
        console.log(`   ${cond ? "PASS" : "FAIL"}  ${desc}${cond || !extra ? "" : `  [${extra}]`}`);
      };
      const skip = (reason) => { rec.status = "skip"; rec.reason = reason; throw new SkipError(reason); };
      console.log(`\n[${tc.id}] ${tc.name}`);
      try {
        await resetOverlays(c);
        await tc.fn({ c, page, check, skip, world });
      } catch (e) {
        if (e instanceof SkipError) {
          console.log(`   SKIP  ${e.message}`);
        } else {
          rec.status = "fail";
          rec.error = e.message;
          console.log(`   ERROR ${e.message}`);
        }
      }
      // Cascade guard: never let a FAILED/SKIPPED test leave the player stuck
      // in a channel, which would fail every following hub-based test. A test
      // that PASSED is trusted to have returned itself to a sane state (the
      // in-dungeon tests each walk out through a gate before finishing), so we
      // do not disturb a passing test's end state.
      if (rec.status !== "pass") {
        try {
          await resetOverlays(c);
          if ((await c.state()).player?.in_channel) {
            await returnToHub(c);
            await c.waitState((s) => !s.player?.in_channel, "cleanup: back at hub", 30000)
              .catch(() => {});
          }
        } catch { /* best effort */ }
      }
      results.push(rec);
    }
  } finally {
    await browser.close();
    if (!process.env.ROG_KEEP) await stack.stop();
    else console.log("[stack] left running (ROG_KEEP=1)");
  }

  // Summary.
  console.log("\n================ SUMMARY ================");
  let pass = 0, fail = 0, skip = 0;
  for (const r of results) {
    const tag = r.status.toUpperCase().padEnd(4);
    console.log(`${tag}  ${r.id}  ${r.name}${r.status === "skip" ? `  (${r.reason})` : ""}${r.error ? `  ERROR: ${r.error}` : ""}`);
    if (r.status === "pass") pass++;
    else if (r.status === "skip") skip++;
    else fail++;
  }
  console.log("========================================");
  console.log(`${pass} passed, ${fail} failed, ${skip} skipped, of ${results.length}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
