/**
 * Shared heuristic agent core. `playAgent(page, cfg)` drives one player in
 * one Playwright page via the ?e2e=1 debug hook: explore segment to
 * segment, fight, equip, discover NEW segments (confirm on the way back)
 * and freely transit OLD confirmed ones, checking invariants and pushing
 * anomalies to cfg.findings (each tagged with the player name).
 *
 * Used by agent.mjs (one player) and multi.mjs (N concurrent players).
 */

export const OFFSET = { north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0] };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** BFS first step from (fx,fy) toward (tx,ty) over non-wall tiles. */
export function bfsStep(walls, fx, fy, tx, ty) {
  const H = walls.length, W = walls[0].length;
  const key = (x, y) => y * W + x;
  const q = [[fx, fy]];
  const parent = new Map([[key(fx, fy), -1]]);
  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
  while (q.length) {
    const [cx, cy] = q.shift();
    if (cx === tx && cy === ty) {
      let cur = key(tx, ty);
      while (parent.get(cur) !== key(fx, fy) && parent.get(cur) !== -1) cur = parent.get(cur);
      if (parent.get(cur) === -1) return [0, 0];
      return [(cur % W) - fx, Math.floor(cur / W) - fy];
    }
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      if (walls[ny][nx]) continue;
      const k = key(nx, ny);
      if (parent.has(k)) continue;
      parent.set(k, key(cx, cy));
      q.push([nx, ny]);
    }
  }
  return null;
}

const OPPOSITE = { north: "south", south: "north", east: "west", west: "east" };

/** Coordinate of a segment id (hub id 0 is the origin). */
function segCoord(segs, id) {
  if (id === 0) return [0, 0];
  const z = segs.find((s) => s.id === id);
  return z ? [z.world_x, z.world_y] : [0, 0];
}
/** Gate directions a segment exposes (the hub has all four). */
function gateDirsOf(segs, id) {
  if (id === 0) return ["north", "south", "east", "west"];
  const z = segs.find((s) => s.id === id);
  return z && z.gates ? Object.keys(z.gates) : [];
}
function segByCoord(segs, x, y) {
  return segs.find((s) => s.world_x === x && s.world_y === y);
}
/**
 * Directions from segment `id` whose gate opens onto an UNEXPLORED coord
 * within the depth budget: the real discovery opportunities from here.
 */
export function frontierDirsOf(segs, id, maxD) {
  const [x, y] = segCoord(segs, id);
  const out = [];
  for (const d of gateDirsOf(segs, id)) {
    const [dx, dy] = OFFSET[d];
    const nx = x + dx, ny = y + dy;
    // (0,0) is the hub - it always exists (id 0, not in the segment list), so a
    // gate pointing at it is a plain transit home, NOT a discovery. Treating it
    // as unexplored made a hub-adjacent segment look "frontier-capable" and
    // bounced bots hub<->that-segment forever. Exclude it.
    if (nx === 0 && ny === 0) continue;
    if (!segByCoord(segs, nx, ny) && Math.abs(nx) + Math.abs(ny) <= maxD) out.push(d);
  }
  return out;
}
/** Deepest coord this segment can discover into (-1 if not frontier-capable). */
export function frontierBestDepth(segs, id, maxD) {
  const [x, y] = segCoord(segs, id);
  let best = -1;
  for (const d of frontierDirsOf(segs, id, maxD)) {
    const [dx, dy] = OFFSET[d];
    best = Math.max(best, Math.abs(x + dx) + Math.abs(y + dy));
  }
  return best;
}
/**
 * BFS over the graph of CONFIRMED segments (an edge is a real gate onto a
 * coord-adjacent confirmed neighbour, and the hub (0,0) is a traversable node
 * that links every quadrant) from `fromId`. Among every reachable
 * frontier-capable segment (including `fromId`), pick the one that can discover
 * the DEEPEST coord, tie-broken by nearest, and return the first transit step
 * toward it - or { atGoal: true } when standing on it already.
 *
 * The depth bias is deliberate and is what makes max distance actually CLIMB:
 * routing to the merely-nearest frontier just refills the interior rings and
 * leaves the edge flat, whereas heading for the deepest reachable edge pushes
 * the frontier outward ring by ring. It is still a shortest-path first step
 * toward a single chosen target, so it does not oscillate; the hub node lets a
 * bot in one arm reach a deeper frontier in another arm.
 */
export function planToFrontier(segs, fromId, maxD) {
  const q = [fromId];
  const seen = new Set([fromId]);
  const firstDir = new Map([[fromId, null]]);
  const dist = new Map([[fromId, 0]]);
  let bestId = -1, bestDepth = -1, bestDist = Infinity;
  const consider = (id) => {
    const fd = frontierBestDepth(segs, id, maxD);
    if (fd < 0) return;
    const dd = dist.get(id) ?? Infinity;
    if (fd > bestDepth || (fd === bestDepth && dd < bestDist)) {
      bestDepth = fd; bestDist = dd; bestId = id;
    }
  };
  consider(fromId);
  while (q.length) {
    const cur = q.shift();
    const [x, y] = segCoord(segs, cur);
    for (const d of gateDirsOf(segs, cur)) {
      const [dx, dy] = OFFSET[d];
      const nx = x + dx, ny = y + dy;
      // The hub (0,0) is real and traversable even though it is not in the
      // segment list; without it BFS cannot cross from one arm of the map to a
      // deeper frontier in another arm.
      let nbId, nbConfirmed = true;
      if (nx === 0 && ny === 0) {
        nbId = 0;
      } else {
        const nb = segByCoord(segs, nx, ny);
        if (!nb) continue;
        nbId = nb.id; nbConfirmed = !!nb.confirmed;
      }
      if (!nbConfirmed || seen.has(nbId)) continue;
      seen.add(nbId);
      firstDir.set(nbId, cur === fromId ? d : firstDir.get(cur));
      dist.set(nbId, (dist.get(cur) ?? 0) + 1);
      consider(nbId);
      q.push(nbId);
    }
  }
  if (bestId < 0) return { atGoal: false, stepDir: null };
  if (bestId === fromId) return { atGoal: true, stepDir: null };
  return { atGoal: false, stepDir: firstDir.get(bestId) };
}

/**
 * Drives the player (already in a channel) to a gate and out, fighting
 * monsters in the way and healing when low. `preferDir` chooses which gate
 * (default: the entry gate, i.e. come back the way you came). Leaving via a
 * gate confirms a provisional segment / freely transits a confirmed one.
 * Returns the final state, or pushes a finding if it can't get out.
 */
export async function navigateOut(page, cfg, preferDir = "") {
  const { name, findings } = cfg;
  const state = () => page.evaluate(() => globalThis.__rog.state());
  const call = (fn, ...a) =>
    page.evaluate(([f, args]) => globalThis.__rog[f](...args), [fn, a]);
  const walls = (await page.evaluate(() => globalThis.__rog.map()))?.walls;
  if (!walls) { findings.push(`[${name}] navigateOut: no map`); return state(); }

  for (let t = 0; t < 400; t++) {
    const s = await state();
    if (!s.player?.in_channel) return s;            // out
    if (s.modal) {
      const c = await page.$(".modal-confirm");
      if (c) await c.click(); else await call("dismissModal");
      await sleep(300); continue;
    }
    if (s.busy) { await sleep(150); continue; }
    const sess = s.session;
    if (!sess) { await sleep(150); continue; }
    if (sess.gameOver) { await call("exitChannel"); await sleep(400); continue; }
    // Live combat hp is on the session, not the frozen on-chain player.hp.
    const liveHp = sess.hp ?? s.player.hp;
    const liveMax = sess.maxHp ?? s.player.max_hp;
    if (liveHp < liveMax * 0.4 && liveHp < liveMax
        && s.player.inventory.some(i => i.slot === "bag" && i.item_id === "health_potion")) {
      await call("input", "use_potion"); await sleep(150); continue;
    }
    const dir = preferDir || s.player.active_visit?.entry_direction || sess.gates[0]?.direction;
    const gate = sess.gates.find(g => g.direction === dir) || sess.gates[0];
    const adj = sess.monsters.find(m =>
      Math.abs(m.x - sess.playerX) <= 1 && Math.abs(m.y - sess.playerY) <= 1);
    const tgt = adj || gate;
    const step = bfsStep(walls, sess.playerX, sess.playerY, tgt.x, tgt.y);
    if (!step || (!step[0] && !step[1])) { await call("input", "wait"); await sleep(120); continue; }
    await call("input", "move", step[0], step[1]); await sleep(120);
  }
  findings.push(`[${name}] navigateOut timed out (still in channel)`);
  return state();
}

/**
 * Plays one agent to completion on `page`.
 * cfg: { name, findings, outbound=4, maxTicks=600 }.
 */
export async function playAgent(page, cfg) {
  const { name, findings } = cfg;
  const OUTBOUND = cfg.outbound ?? 4;
  const MAX_TICKS = cfg.maxTicks ?? 600;
  const fail = (m) => findings.push(`[${name}] ${m}`);

  const state = () => page.evaluate(() => globalThis.__rog.state());
  const getMap = () => page.evaluate(() => globalThis.__rog.map());
  const call = (fn, ...a) =>
    page.evaluate(([f, args]) => globalThis.__rog[f](...args), [fn, a]);

  async function waitIdle(ms = 12000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = await state();
      if (!s.busy) return s;
      await sleep(150);
    }
    return state();
  }

  async function handleModal(s) {
    if (!s.modal) return false;
    const confirm = await page.$(".modal-confirm");
    if (confirm) { await confirm.click(); await sleep(300); return true; }
    // Record genuine anomalies; ignore expected feedback (cooldowns,
    // completion, respawn, coord-claim races, provisional-access blocks,
    // all legitimate in a competitive multiplayer world).
    if (!/dungeon complete|respawn|welcome|cooldown|already claimed|provisional/i.test(s.modal))
      findings.push(`[${name}] modal: ${s.modal.slice(0, 120).replace(/\s+/g, " ").trim()}`);
    await call("dismissModal");
    await sleep(300);
    return true;
  }

  async function manageInventory(s) {
    const p = s.player;
    if (!p) return;
    const potions = p.inventory.filter(i => i.slot === "bag"
      && (i.item_id === "health_potion" || i.item_id === "greater_health_potion"));
    if (p.hp < p.max_hp * 0.5 && potions.length) {
      await call("useItem", potions[0].item_id); await waitIdle(); return;
    }
    if (p.stat_points > 0) {
      // Durability-first: max_hp = 50 + constitution*5, so pumping
      // constitution is what lets a character survive deeper. Keep a little
      // strength flowing (kill faster = less exposure) at roughly a 1:2
      // strength:constitution ratio.
      const con = p.stats?.constitution ?? 10;
      const str = p.stats?.strength ?? 5;
      const stat = (str * 2 < con) ? "strength" : "constitution";
      await call("allocateStat", stat); await waitIdle(); return;
    }
    const gear = p.inventory.find(i => i.slot === "bag"
      && /sword|axe|mace|staff|armor|mail|plate|helmet|cap|boots|shield|ring|amulet|necklace/.test(i.item_id));
    if (gear) {
      let slot = "weapon";
      if (/cap|helmet/.test(gear.item_id)) slot = "head";
      else if (/armor|mail|plate|leather$/.test(gear.item_id)) slot = "body";
      else if (/boots/.test(gear.item_id)) slot = "feet";
      else if (/shield/.test(gear.item_id)) slot = "offhand";
      else if (/ring/.test(gear.item_id)) slot = "ring";
      else if (/amulet|necklace/.test(gear.item_id)) slot = "amulet";
      await call("equip", gear.rowid, slot); await waitIdle(); return;
    }
  }

  // Connect + register (retry once; connect can be slow under load, and a
  // silent miss here is what shows up as an idle "undefined" cycle).
  await call("connect", name);
  await waitIdle(15000);
  for (let i = 0; i < 40 && (await state()).status !== "connected"; i++) {
    if (i === 20) await call("connect", name);
    await sleep(400);
  }
  let s = await state();
  if (s.status !== "connected") { fail("did not connect"); return; }
  if (!s.player) { await call("register"); await waitIdle(); }

  // Bound total segment count so the world does not sprawl without limit
  // over a long soak. Kept generous so it never caps DISTANCE (a deep single
  // arm needs few segments) - the binding limit on distance is survival.
  const WORLD_CAP = Math.max(80, OUTBOUND * 10);
  // The frontier push is gated by SURVIVAL, not an arbitrary constant: a bot
  // only discovers a segment one step deeper than the hub if its level (a
  // proxy for how much monster difficulty it can tank) allows it. As the bot
  // banks XP and levels up, this allowance rises and the frontier advances.
  // level 1 -> depth 3, level 2 -> depth 4, ... plus an optional hard ceiling.
  // A frontier confirm is a quick in-and-out (survive a few turns to a gate),
  // so a bot can safely reach a bit beyond its "grind" depth; deaths are still
  // guarded by the depth-aware HP retreat. As the bot levels, this rises and
  // the frontier advances until monster difficulty genuinely outpaces it.
  // There is NO on-chain depth cap (validateGateWalk gates a discovery only on
  // the cooldown and hp>0), so this ceiling is purely a self-imposed guard
  // against diving to death. With the survival heal on gate-walk and a full heal
  // on level-up, bots are durable, so keep it generous and let the depth-aware
  // HP retreat (retreatAt) do the actual death-avoidance. A too-tight cap was
  // wedging capped bots at the edge with nothing to do (see the oscillation
  // fix): level 1 -> depth 5, and it climbs 1:1 with level from there.
  const DEPTH_CEIL = Number(cfg.maxDepth ?? 99);
  const allowedDepth = (lvl) => Math.min(DEPTH_CEIL, Math.max(5, (lvl ?? 1) + 4));

  let discoveries = 0, lastSig = "", stuck = 0;
  // Anti-backtrack bookkeeping: the segment we were in before the current one.
  // Used so a wedge-escape never turns a bot straight back the way it came.
  let cameFrom = null, lastSeg = null;
  // Recent segment-entry history (ids), for a branch-agnostic two-segment
  // oscillation detector: if the last four entries alternate between just two
  // segments, the bot is ping-ponging and must stop transiting (grind or park).
  let segHist = [];
  let mapCache = { visitId: null, walls: null };
  // Per-visit combat budget: on entering a segment a bot hunts monsters for
  // up to this many action-turns before it is allowed to head for a gate.
  // Without it, free instant transit makes bots ping-pong between confirmed
  // segments and never actually play.
  let huntVisit = null, huntTurns = 0;
  // Last tile we attempted a pickup on, so a full-bag pickup does not loop.
  let pickTried = "";
  // Live hp at our last drink attempt; if a drink does not raise hp the session
  // is out of potions and we must stop retrying (see the potion guard below).
  let lastDrinkHp = -1;

  for (let tick = 0; tick < MAX_TICKS; tick++) {
    s = await state();

    // Track the segment we just came from (updated whenever current_segment
    // changes) so the navigation can refuse to immediately transit back to it.
    if (s.player && s.player.current_segment !== lastSeg) {
      if (lastSeg !== null) cameFrom = lastSeg;
      lastSeg = s.player.current_segment;
      segHist.push(s.player.current_segment);
      if (segHist.length > 4) segHist.shift();
    }
    // Two-segment ping-pong: the last four DISTINCT-pairwise entries are A,B,A,B.
    const oscillating = segHist.length >= 4
      && segHist[0] === segHist[2] && segHist[1] === segHist[3]
      && segHist[0] !== segHist[1];

    // Progress signature: include LIVE session hp and the alive-monster count
    // so that fighting an adjacent monster in place (position and on-chain
    // player.hp both unchanged, but session hp / monster count moving) counts
    // as progress. If NONE of these move for several ticks the chosen action is
    // a no-op (e.g. trying to attack a monster across a wall corner, an
    // unreachable target): rather than kill the whole cycle, flip to
    // "must-leave" and steer straight for a gate so the run SETTLES (banking
    // its XP) and the bot moves on. Only a very long wedge breaks the cycle.
    const aliveMons = s.session?.monsters?.length ?? 0;
    // Total monster HP is in the signature so that DEALING DAMAGE (even to an
    // unaware monster that never hits back, so player hp is flat) counts as
    // progress. Travel changes position; combat changes monster hp/count; only
    // a genuinely wedged action (an unreachable/unresolving target) leaves all
    // of position, player hp, monster count AND monster hp unchanged.
    const totalMonHp = (s.session?.monsters ?? []).reduce((a, m) => a + m.hp, 0);
    const sig = `${s.player?.current_segment}:${s.session?.playerX}:${s.session?.playerY}:${s.session?.hp}:${aliveMons}:${totalMonHp}`;
    if (s.player?.in_channel && sig === lastSig && !s.modal && !s.busy) {
      stuck++;
      if (stuck > 250) { fail(`stuck ${stuck} ticks in dungeon at ${sig}`); break; }
    } else stuck = 0;
    lastSig = sig;
    const mustLeave = stuck >= 10;

    if (s.modal) { await handleModal(s); continue; }
    if (s.busy) { await sleep(200); continue; }
    if (s.status !== "connected") { fail("disconnected: " + s.status); break; }

    const p = s.player;

    if (!p.in_channel) {
      await manageInventory(s);
      s = await state();
      const pl = s.player;
      const segs = s.segments;
      const maxD = allowedDepth(pl.level);
      const cd = pl.last_discover_height > 0
        ? Math.max(0, (pl.last_discover_height + 50) - (s.height ?? 0)) : 0;
      const [curX, curY] = segCoord(segs, pl.current_segment);
      const distFromHub = (d) => { const [dx, dy] = OFFSET[d]; return Math.abs(curX + dx) + Math.abs(curY + dy); };
      // Real gates from HERE that open onto unexplored ground (deepest first),
      // and the BFS route to the nearest segment that CAN push the frontier.
      const frontierHere = frontierDirsOf(segs, pl.current_segment, maxD)
        .sort((a, b) => distFromHub(b) - distFromHub(a));
      const plan = planToFrontier(segs, pl.current_segment, maxD);
      const owHealthy = pl.max_hp > 0 ? pl.hp >= pl.max_hp * 0.5 : true;
      // Direction back to the segment we just came from (anti-backtrack).
      const owBackDir = (() => {
        if (cameFrom == null) return null;
        for (const d of Object.keys(OFFSET)) {
          const [dx, dy] = OFFSET[d];
          if (cameFrom === 0) { if (curX + dx === 0 && curY + dy === 0) return d; }
          else { const nb = segByCoord(segs, curX + dx, curY + dy); if (nb && nb.id === cameFrom) return d; }
        }
        return null;
      })();

      let dir = null, discovering = false;
      if (cd === 0 && segs.length < WORLD_CAP && frontierHere.length && plan.atGoal && owHealthy) {
        // Standing on the DEEPEST reachable frontier: discover its deepest gate,
        // pushing the edge out. (If a deeper frontier is reachable, plan.atGoal
        // is false and we route toward it below instead of filling a shallow ring.)
        dir = frontierHere[0]; discovering = true;
      } else if (plan.stepDir && plan.stepDir !== owBackDir) {
        // Otherwise transit ONE step toward the nearest frontier-capable
        // segment (never straight back the way we came). That enters its
        // channel, where the dungeon loop grinds, heals and discovers. This is a
        // shortest-path step, never an orbit.
        dir = plan.stepDir;
      } else {
        // No reachable frontier right now (world capped, hurt at a frontier we
        // must heal for, or on cooldown at the only reachable frontier): PARK.
        // Do nothing on-chain rather than churn transits. It clears shortly.
        await sleep(1500); continue;
      }

      if (cfg.debug && name === "bot_0")
        console.error(`[ow bot_0 t${tick}] seg${pl.current_segment} dir=${dir} disc=${discovering} cd=${cd} frontierHere=${frontierHere} step=${plan.stepDir}`);
      await call("gateWalk", dir);
      const after = await waitIdle(15000);
      if (after.player?.in_channel && discovering) discoveries++;
      continue;
    }

    const sess = s.session;
    if (!sess) { await sleep(200); continue; }
    if (sess.gameOver) { await call("exitChannel"); await waitIdle(15000); continue; }
    if (cfg.debug && name === "bot_0" && tick % 10 === 0)
      console.error(`[dz bot_0 t${tick}] seg${p.current_segment} mons=${sess.monsters.length} pos=${sess.playerX},${sess.playerY} hp=${sess.hp}/${sess.maxHp}`);

    // LIVE combat HP comes from the running session (sess.hp/maxHp), NOT the
    // on-chain player.hp, which is frozen until the run settles. Every in-run
    // survival decision keys off the live value.
    const liveHp = sess.hp ?? p.hp;
    const liveMax = sess.maxHp ?? p.max_hp;
    const hpRatio = liveMax > 0 ? liveHp / liveMax : 1;
    const havePotion = p.inventory.some(i => i.slot === "bag"
      && (i.item_id === "health_potion"));

    // Depth-aware safety margin: monster damage scales with depth, so the
    // deeper we are the earlier we bail. Shallow (near-hub) segments are cheap,
    // so we fight down to a low HP there - which matters because the ONLY way
    // to heal is drinking potions, and the only way to GET potions is killing
    // monsters, so a timid bot at half HP would deadlock (never fight, never
    // heal, never level). retreatAt rises from ~0.35 near the hub toward ~0.6
    // deep, where a level-appropriate character has far more max HP to spend.
    const depthProxyEarly = (() => {
      const seg = s.segments.find(x => x.id === p.current_segment);
      return seg ? Math.abs(seg.world_x) + Math.abs(seg.world_y) : 0;
    })();
    const retreatAt = Math.min(0.6, 0.32 + 0.045 * depthProxyEarly);

    // Drink when hurt (and not already topped up). Drinking raises live hp,
    // which is banked on a surviving exit, so it both saves the run and heals
    // the character for future runs. Drink a bit before the retreat line so we
    // can keep fighting rather than bail.
    //
    // CRITICAL: havePotion checks the on-chain bag, which is NOT decremented
    // until the run settles, so it stays true even after the SESSION's potions
    // (session.loot, the only thing use_potion can draw from) are gone. Guard
    // against the resulting no-op loop: if we already tried to drink at this
    // exact live-hp and it did not rise, the session is out of potions - stop
    // trying and play on, instead of freezing here forever (this loop was what
    // wedged bots in place, killing all combat and exploration).
    if (hpRatio < retreatAt + 0.2 && liveHp < liveMax && havePotion
        && liveHp !== lastDrinkHp) {
      lastDrinkHp = liveHp;
      await call("input", "use_potion"); await sleep(150); continue;
    }
    // Pick up an item we are standing on - but only ATTEMPT each tile once.
    // If the bag is full the pickup is a no-op (no turn passes); retrying it
    // every tick would wedge the bot forever on that tile (this is exactly how
    // bots got stuck deep in a segment doing nothing). Attempt once, then walk
    // on regardless.
    const hereKey = `${sess.playerX},${sess.playerY}`;
    if (sess.groundItems.some(g => g.x === sess.playerX && g.y === sess.playerY)
        && pickTried !== hereKey) {
      pickTried = hereKey;
      await call("input", "pickup"); await sleep(150); continue;
    }

    const vid = p.active_visit?.visit_id ?? null;
    if (mapCache.visitId !== vid) mapCache = { visitId: vid, walls: (await getMap())?.walls };
    const walls = mapCache.walls;
    if (!walls) { await sleep(200); continue; }

    const entryDir = p.active_visit?.entry_direction || "";
    if (huntVisit !== vid) { huntVisit = vid; huntTurns = 0; }
    const curSeg = s.segments.find(x => x.id === p.current_segment);
    const cx0 = curSeg?.world_x ?? 0, cy0 = curSeg?.world_y ?? 0;
    const depthProxy = Math.abs(cx0) + Math.abs(cy0);
    const curConfirmed = !curSeg || !!curSeg.confirmed;   // hub (id 0) counts as confirmed
    const maxD = allowedDepth(p.level);

    let nearestMon = null, nd = Infinity;
    for (const m of sess.monsters) {
      const md = Math.abs(m.x - sess.playerX) + Math.abs(m.y - sess.playerY);
      if (md < nd) { nd = md; nearestMon = m; }
    }
    // Modest per-visit combat budget: kill a FEW nearby monsters (banked on
    // exit), then leave. Short runs bank XP steadily without wading deep into a
    // monster cluster and dying (no HP regen exists, so a death is expensive).
    const HUNT_BUDGET = cfg.huntBudget ?? 24;
    const entryGate = () => sess.gates.find(g => g.direction === entryDir) || sess.gates[0];

    // --- Frontier-directed navigation (anti-oscillation core) ---
    const cd = p.last_discover_height > 0
      ? Math.max(0, (p.last_discover_height + 50) - (s.height ?? 0)) : 0;
    const distOf = (dir) => { const [dx, dy] = OFFSET[dir]; return Math.abs(cx0 + dx) + Math.abs(cy0 + dy); };
    const segs = s.segments;
    // Real gates from HERE onto unexplored ground (deepest first), and the BFS
    // route toward the nearest segment that CAN push the frontier. planToFrontier
    // is a shortest path over confirmed segments, so following it never orbits.
    const frontierHere = frontierDirsOf(segs, p.current_segment, maxD)
      .sort((a, b) => distOf(b) - distOf(a));
    const plan = planToFrontier(segs, p.current_segment, maxD);
    // Discover from HERE only when this is the DEEPEST reachable frontier
    // (plan.atGoal), off cooldown and under the world cap. If a deeper frontier
    // is reachable, plan.stepDir (below) routes toward it instead of filling a
    // shallower ring - this is what makes max distance climb rather than stall.
    const canDiscoverHere = curConfirmed && cd === 0
      && segs.length < WORLD_CAP && plan.atGoal && frontierHere.length > 0;
    // HP needed to safely cross a segment to a frontier gate and confirm the new
    // ring. Below this we grind/heal first rather than bleed out mid-crossing.
    const PUSH_HP = 0.5;

    // Gate helpers: object by direction, path-reachability, nearest of a list.
    const gateObj = (dir) => sess.gates.find(g => g.direction === dir);
    const reachable = (g) => {
      if (!g) return false;
      const st = bfsStep(walls, sess.playerX, sess.playerY, g.x, g.y);
      return !!(st && (st[0] || st[1]));
    };
    const nearestGate = (dirs) => {
      let best = null, bl = Infinity;
      for (const d of dirs) {
        const g = gateObj(d);
        if (g && reachable(g)) {
          const l = Math.abs(g.x - sess.playerX) + Math.abs(g.y - sess.playerY);
          if (l < bl) { bl = l; best = g; }
        }
      }
      return best;
    };
    const allDirs = sess.gates.map(g => g.direction);
    const backDir = entryDir;
    // Direction (by COORD, reliable) that transits back to the segment we just
    // came from. Anti-backtrack keys off this, NOT entryDir: entryDir is the
    // gate side we arrived on, which does not match the travel direction of the
    // return hop, so using it let a two-segment bounce slip through.
    const backSegDir = (() => {
      if (cameFrom == null) return null;
      for (const d of allDirs) {
        const [dx, dy] = OFFSET[d];
        if (cameFrom === 0) { if (cx0 + dx === 0 && cy0 + dy === 0) return d; }
        else { const nb = segByCoord(segs, cx0 + dx, cy0 + dy); if (nb && nb.id === cameFrom) return d; }
      }
      return null;
    })();
    const hurt = hpRatio <= retreatAt;
    const pinned = mustLeave;

    let target = null, decision = "";
    if (oscillating && curConfirmed && !(canDiscoverHere && hpRatio >= PUSH_HP)) {
      // BREAK A DETECTED TWO-SEGMENT PING-PONG (branch-agnostic backstop): the
      // bot has bounced A-B-A-B without discovering. Stop transiting entirely -
      // grind a monster if one is reachable and we are healthy (productive and
      // it changes the sig), otherwise PARK. Only a genuine frontier push is
      // still allowed to leave. This guarantees no oscillation survives even if
      // the routing keeps proposing the return hop.
      if (!hurt && nearestMon) {
        target = { x: nearestMon.x, y: nearestMon.y };
        if (nd <= 1) huntTurns++;
        decision = "osc-grind";
      } else {
        await call("input", "wait");
        stuck = 0; lastSig = "PARK";
        await sleep(600);
        continue;
      }
    } else if (pinned) {
      // No-progress escape: any reachable gate, preferring one that is NOT the
      // way we came in, so a wedge never becomes a two-gate bounce.
      const g = nearestGate(allDirs.filter(d => d !== backDir))
        || nearestGate(allDirs) || entryGate();
      target = { x: g.x, y: g.y }; decision = "pinned";
    } else if (!curConfirmed) {
      // PROVISIONAL frontier: do NOT grind, just survive to a gate to CONFIRM it
      // (banking whatever this short run earned) and advance the frontier. We
      // spawn ON the entry gate, so head to a gate a few steps off; fight only an
      // adjacent blocker briefly. The entry gate is the safe, guaranteed exit
      // back to the confirmed source we came from.
      if (nearestMon && nd <= 1 && huntTurns < 3) {
        target = { x: nearestMon.x, y: nearestMon.y }; huntTurns++; decision = "confirm-fight";
      } else {
        const g = nearestGate([backDir]) || nearestGate(allDirs) || entryGate();
        target = { x: g.x, y: g.y }; decision = "confirm";
      }
    } else if (canDiscoverHere && hpRatio >= PUSH_HP) {
      // PUSH THE FRONTIER (primary goal): beeline the nearest gate that opens
      // onto unexplored ground (deepest preferred). Fight only an adjacent
      // blocker so a monster does not stall the push. Walking through discovers
      // the next ring - this is what makes max distance climb.
      if (nearestMon && nd <= 1 && huntTurns < HUNT_BUDGET) {
        target = { x: nearestMon.x, y: nearestMon.y }; huntTurns++; decision = "push-fight";
      } else {
        const g = nearestGate(frontierHere) || nearestGate(allDirs) || entryGate();
        target = { x: g.x, y: g.y }; decision = "push";
      }
    } else if (!hurt && nearestMon && huntTurns < HUNT_BUDGET) {
      // GRIND (safe, confirmed segment; cannot discover here yet): fight the
      // nearest monster - ANY distance, not just adjacent - to bank XP. Levelling
      // up FULLY HEALS and raises the depth budget, which is exactly what lets a
      // capped bot escape the edge and the frontier advance. Seeking distant
      // monsters (not just ones next to the gate) is the fix for the "no-reward"
      // transits that left bots stuck at low level.
      target = { x: nearestMon.x, y: nearestMon.y };
      if (nd <= 1) huntTurns++;
      decision = "grind";
    } else if (hurt) {
      // RETREAT toward the hub: the reachable gate with the SMALLEST hub distance.
      // Monotonically hubward, so it never bounces - it walks to shallower, safer
      // ground (where retreatAt is lower, so it is "healthy" again) and there it
      // grinds and heals. This replaces the old retreat-to-entry-gate that, paired
      // with a healthy segment marching back outward, was the ping-pong.
      const hubward = [...allDirs].sort((a, b) => distOf(a) - distOf(b));
      const g = nearestGate(hubward) || entryGate();
      target = { x: g.x, y: g.y }; decision = "retreat";
    } else {
      // Healthy, nothing to fight here, cannot discover here: TRANSIT one step
      // toward the nearest frontier-capable segment (BFS route). ANTI-BACKTRACK:
      // never take a route step that leads straight back to the segment we just
      // came from - in a densely-filled region two frontier-capable-but-on-
      // cooldown segments can otherwise point at each other and 2-cycle. When
      // the only route is back (or there is none: we ARE the nearest frontier
      // but on cooldown, or the world is capped) PARK in place - wait, doing
      // nothing on-chain, instead of churning transits. The stuck signature is
      // reset so the wait is not mistaken for a wedge and does not trip escape.
      const routeDir = plan.stepDir;
      const g = (routeDir && routeDir !== backSegDir) ? gateObj(routeDir) : null;
      if (g && reachable(g)) {
        target = { x: g.x, y: g.y }; decision = "route";
      } else {
        await call("input", "wait");
        stuck = 0; lastSig = "PARK";
        await sleep(600);
        continue;
      }
    }

    const step = bfsStep(walls, sess.playerX, sess.playerY, target.x, target.y);
    if (cfg.debug && name === "bot_0" && tick % 3 === 0) {
      console.error(`[dbg ${name} t${tick}] seg${p.current_segment} d${depthProxy} conf=${curConfirmed} hp=${hpRatio.toFixed(2)} ${decision} cd=${cd} discHere=${canDiscoverHere} frontierHere=${frontierHere} step=${plan.stepDir} nd=${nd} tgt=${target.x},${target.y}`);
    }
    if (!step || (step[0] === 0 && step[1] === 0)) {
      let moved = false;
      for (const g of sess.gates) {
        const st = bfsStep(walls, sess.playerX, sess.playerY, g.x, g.y);
        if (st && (st[0] || st[1])) { await call("input", "move", st[0], st[1]); moved = true; break; }
      }
      if (!moved) await call("input", "wait");
      await sleep(120); continue;
    }
    await call("input", "move", step[0], step[1]);
    await sleep(120);
  }

  const fin = await state().catch(() => ({}));
  return {
    name,
    seg: fin.player?.current_segment,
    level: fin.player?.level,
    deaths: fin.player?.combat_record?.deaths,
    discoveries,
  };
}
