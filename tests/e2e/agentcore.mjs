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
    // completion, respawn, coord-claim races, provisional-access blocks —
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
  const DEPTH_CEIL = Number(cfg.maxDepth ?? 99);
  const allowedDepth = (lvl) => Math.min(DEPTH_CEIL, Math.max(3, (lvl ?? 1) + 2));

  let discoveries = 0, lastSig = "", stuck = 0;
  let mapCache = { visitId: null, walls: null };
  // Per-visit combat budget: on entering a segment a bot hunts monsters for
  // up to this many action-turns before it is allowed to head for a gate.
  // Without it, free instant transit makes bots ping-pong between confirmed
  // segments and never actually play.
  let huntVisit = null, huntTurns = 0;

  for (let tick = 0; tick < MAX_TICKS; tick++) {
    s = await state();

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
      const curX = pl.current_segment === 0 ? 0
        : (s.segments.find(x => x.id === pl.current_segment)?.world_x ?? 0);
      const curY = pl.current_segment === 0 ? 0
        : (s.segments.find(x => x.id === pl.current_segment)?.world_y ?? 0);
      const confirmedNbr = {};
      const occupied = new Set();
      for (const [dir, [dx, dy]] of Object.entries(OFFSET)) {
        const seg = s.segments.find(x => x.world_x === curX + dx && x.world_y === curY + dy);
        if (seg) { occupied.add(dir); if (seg.confirmed) confirmedNbr[dir] = seg.id; }
      }
      const confirmedDirs = Object.keys(confirmedNbr);
      const emptyDirs = Object.keys(OFFSET).filter(d => !occupied.has(d));
      const cd = pl.last_discover_height > 0
        ? Math.max(0, (pl.last_discover_height + 50) - (s.height ?? 0)) : 0;

      const depthProxy = Math.abs(curX) + Math.abs(curY);
      const dist = (d) => { const [dx, dy] = OFFSET[d]; return Math.abs(curX + dx) + Math.abs(curY + dy); };
      const emptyOut = [...emptyDirs].sort((a, b) => dist(b) - dist(a));
      // Transit outward too: prefer the confirmed neighbour that leads
      // furthest from the hub, so bots march toward the frontier instead of
      // orbiting the hub. From inside that confirmed segment the dungeon-loop
      // pushes another step out (and discovers when the outward tile is empty).
      const confirmedOut = [...confirmedDirs].sort((a, b) => dist(b) - dist(a));
      const maxD = allowedDepth(pl.level);
      let dir = null, discovering = false;
      if (cd === 0 && emptyDirs.length && depthProxy < maxD && s.segments.length < WORLD_CAP) {
        dir = emptyOut[0]; discovering = true;
      } else if (confirmedOut.length) {
        dir = confirmedOut[0];
      } else if (emptyDirs.length && cd > 0) {
        await sleep(1500); continue;
      } else { await sleep(500); continue; }

      if (cfg.debug && name === "bot_0")
        console.error(`[ow bot_0 t${tick}] seg${pl.current_segment} dir=${dir} disc=${discovering} cd=${cd} empty=${emptyDirs} confOut=${confirmedOut}`);
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
    if (hpRatio < retreatAt + 0.2 && liveHp < liveMax && havePotion) {
      await call("input", "use_potion"); await sleep(150); continue;
    }
    if (sess.groundItems.some(g => g.x === sess.playerX && g.y === sess.playerY)) {
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

    // Nearest gate we can actually path to (optionally preferring outward ones).
    const gateToward = (prefer) => {
      const cand = [...prefer, ...sess.gates];
      let best = null, bestLen = Infinity;
      for (const g of cand) {
        if (!g) continue;
        const st = bfsStep(walls, sess.playerX, sess.playerY, g.x, g.y);
        if (st && (st[0] || st[1])) {
          const len = Math.abs(g.x - sess.playerX) + Math.abs(g.y - sess.playerY);
          if (len < bestLen) { bestLen = len; best = g; }
        }
      }
      return best || entryGate();
    };

    // The frontend banks a run's XP/gold/kills whenever it exits a gate having
    // earned anything (see doGateWalk: earnedRewards). So combat XP is banked
    // on gate-exit from BOTH provisional and confirmed segments. That makes the
    // efficient loop: GRIND xp where it is SAFE (already-confirmed segments,
    // whose depth the character has proven it survives) to level up, and make a
    // QUICK, low-risk confirm run whenever we punch the frontier one step out.
    const occupied = new Set();
    for (const [d, [dx, dy]] of Object.entries(OFFSET)) {
      if (s.segments.find(x => x.world_x === cx0 + dx && x.world_y === cy0 + dy)) occupied.add(d);
    }
    const cd = p.last_discover_height > 0
      ? Math.max(0, (p.last_discover_height + 50) - (s.height ?? 0)) : 0;
    const distOf = (dir) => { const [dx, dy] = OFFSET[dir]; return Math.abs(cx0 + dx) + Math.abs(cy0 + dy); };
    const outward = (g) => distOf(g.direction) > depthProxy;
    const frontier = sess.gates.filter(g => !occupied.has(g.direction));
    // Pick the outward-most gate to leave by: discover a deeper frontier when
    // cooldown/cap allow (pushes AND confirms the next ring), else transit an
    // outward confirmed neighbour, else any frontier, else lateral, else back.
    const canDiscover = cd === 0 && depthProxy < maxD && s.segments.length < WORLD_CAP;
    const frontierOut = frontier.filter(outward).sort((a, b) => distOf(b.direction) - distOf(a.direction));
    const confirmedOut = sess.gates.filter(g => occupied.has(g.direction) && g.direction !== entryDir && outward(g))
      .sort((a, b) => distOf(b.direction) - distOf(a.direction));
    const lateralAny = sess.gates.filter(g => g.direction !== entryDir && occupied.has(g.direction));
    const outwardGate = () => (canDiscover && frontierOut[0])
      || confirmedOut[0]
      || (canDiscover && frontier[0])
      || lateralAny[0]
      || entryGate();

    // Reasons to stop fighting and head for a gate right now:
    //  - hurt (hpRatio at/under the depth-aware retreat line): leave BEFORE we
    //    can bleed to death (there is no HP regen; a death is costly),
    //  - no-progress / pinned on an unresolving attack (mustLeave / monStall),
    //  - done with this run's combat budget.
    const hurt = hpRatio <= retreatAt;
    const pinned = mustLeave;
    const healthy = hpRatio > retreatAt;

    let target = null;
    if (hurt || pinned) {
      // Leave immediately via the nearest reachable gate. When still healthy
      // (a pin, not low HP) bias outward so the exit also makes progress.
      const g = gateToward(healthy ? [outwardGate()] : [entryGate()]);
      target = { x: g.x, y: g.y };
    } else if (!curConfirmed) {
      // PROVISIONAL (frontier): risky ground. Do NOT grind - just survive to a
      // gate to CONFIRM it (banking whatever this short run earned) and advance
      // the frontier. We spawn ON the entry gate and an instant exit does not
      // count as survived, so head to a gate (a few steps); fight only an
      // adjacent blocker briefly.
      if (nearestMon && nd <= 1 && huntTurns < 3) {
        target = { x: nearestMon.x, y: nearestMon.y }; huntTurns++;
      } else {
        const g = entryGate();
        target = { x: g.x, y: g.y };
      }
    } else if (healthy && canDiscover && frontierOut.length) {
      // PRIMARY GOAL = push the frontier. If we are healthy in a confirmed
      // segment that CAN discover a deeper neighbour (cooldown clear, level
      // allows the depth, world under cap), beeline for that outward frontier
      // gate. Stepping through it discovers the next ring and, once we survive a
      // confirm run there, extends the max distance. Fight only an adjacent
      // blocker on the way (nd<=1) so a monster does not stall the push.
      if (nearestMon && nd <= 1 && huntTurns < HUNT_BUDGET) {
        target = { x: nearestMon.x, y: nearestMon.y }; huntTurns++;
      } else {
        const g = frontierOut[0];
        target = { x: g.x, y: g.y };
      }
    } else if (nearestMon && nd <= 3 && huntTurns < HUNT_BUDGET) {
      // CONFIRMED + healthy, no frontier to punch here: fight a CLOSE monster
      // (opportunistic - one on/near our outward path) to bank XP and level up.
      // We do not trek across the map to a distant monster; the else branch
      // heads outward toward a frontier-capable segment. Levelling raises
      // constitution/max_hp/defense and allowedDepth so the frontier can advance.
      // Budget counts actual attacks (nd<=1); hurt->leave and the stuck guard
      // cap the risk (retreat before we can die).
      target = { x: nearestMon.x, y: nearestMon.y };
      if (nd <= 1) huntTurns++;
    } else {
      // Nothing worth fighting nearby (or budget spent): leave via an outward
      // gate - discover the next ring when cooldown/level allow, else transit
      // outward toward the frontier.
      const g = outwardGate();
      target = { x: g.x, y: g.y };
    }

    const step = bfsStep(walls, sess.playerX, sess.playerY, target.x, target.y);
    if (cfg.debug && name === "bot_0" && tick % 3 === 0) {
      console.error(`[dbg ${name} t${tick}] seg${p.current_segment} conf=${curConfirmed} hp=${hpRatio.toFixed(2)} hurt=${hurt} pin=${pinned} ht=${huntTurns} nd=${nd} pos=${sess.playerX},${sess.playerY} tgt=${target.x},${target.y} step=${step}`);
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
