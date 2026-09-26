/**
 * Shared plumbing for the duel scripts that drive the real chain from Node.
 *
 * `duel_adversarial.mjs` grew these first and `duel_bot.mjs` needs the same
 * ones; main.ts has its own TypeScript versions because the browser builds a
 * session from the same chain state. Three copies would be two too many, so
 * the Node ones live here.
 */
export const PROXY = process.env.ROG_PROXY || "http://localhost:18380";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const tokens = {};

export async function proxy(body) {
  const r = await fetch(PROXY, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

export async function gsp(method, params = []) {
  const r = await fetch(`${PROXY}/gsp`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const res = (await r.json()).result;
  return res && typeof res === "object" && "data" in res ? res.data : res;
}

export async function move(name, data) {
  return proxy({ action: "move", name, game: "rog", data, token: tokens[name] });
}

export async function mine(blocks = 1) {
  return proxy({ action: "mine", blocks });
}

export async function register(name) {
  const r = await proxy({ action: "register", name });
  tokens[name] = r.body.token ?? "";
  installClaim(name, tokens[name]);
  await move(name, { r: {} });
  for (let i = 0; i < 40; i++) {
    if (await gsp("getplayerinfo", [name])) return;
    await sleep(500);
  }
  throw new Error(`${name} never appeared on-chain`);
}

/**
 * A localStorage good enough for the browser modules this runs in Node.
 *
 * CoopRunner persists a duel's sealed salt there so a reload can still
 * produce its reveal, and moves.ts keeps the claim token there. Both wrap
 * every access in try/catch, so a missing localStorage would not crash --
 * it would silently lose the salt and the token, which is worse. An
 * in-memory Map is the whole requirement.
 */
export function installStorageShim() {
  if (globalThis.localStorage) return;
  const m = new Map();
  globalThis.localStorage = {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
  };
}

/** Puts a claim token where moves.ts's loadClaim will find it. */
export function installClaim(name, token) {
  installStorageShim();
  globalThis.localStorage.setItem(`rog:claim:${name}`, token ?? "");
}

/** Rebuilds a participant's engine setup from chain state, as the GSP does. */
export function setupFromPlayer(p, entryDir) {
  return {
    name: p.name,
    stats: {
      level: p.level,
      strength: p.effective_stats.strength,
      dexterity: p.effective_stats.dexterity,
      constitution: p.effective_stats.constitution,
      intelligence: p.effective_stats.intelligence,
      equipAttack: p.effective_stats.equip_attack,
      equipDefense: p.effective_stats.equip_defense,
    },
    hp: p.hp, maxHp: p.max_hp,
    potions: p.inventory
      .filter((i) => i.slot === "bag" && /health_potion/.test(i.item_id))
      .map((i) => ({ itemId: i.item_id, quantity: i.quantity })),
    inventory: p.inventory
      .map((i) => ({ rowid: i.rowid, itemId: i.item_id, slot: i.slot }))
      .sort((x, y) => x.rowid - y.rowid),
    entryDir,
  };
}

export function constraintsFor(seg) {
  if (!seg.constraint_dir) return [];
  const g = seg.gates?.[seg.constraint_dir];
  return g ? [{ x: g.x, y: g.y, direction: seg.constraint_dir }] : [];
}

/** Participants in the canonical order the engine and the GSP both use. */
export function canonicalNames(participants) {
  return [...participants].sort();
}

/** Waits for a predicate over getvisitinfo, returning the visit or null. */
export async function visitUntil(id, pred, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await gsp("getvisitinfo", [id]);
    if (pred(v)) return v;
    await sleep(600);
  }
  return null;
}

/**
 * Ensures a confirmed segment east of the hub for `name` to fight in.
 *
 * A duel needs a CONFIRMED arena: a provisional segment belongs to its
 * discoverer until a genuine completed run confirms it. So this walks a
 * real run in and back out through the gate it entered by, which is what
 * confirmation means.
 */
export async function ensureArena(name, DungeonSession) {
  let segs = await gsp("listsegments", []);
  if (segs.some((s) => s.x === 1 && s.y === 0 && s.confirmed)) return;
  if (!segs.some((s) => s.x === 1 && s.y === 0)) {
    await move(name, { gw: { dir: "east" } });
    for (let i = 0; i < 40; i++) {
      const p = await gsp("getplayerinfo", [name]);
      if (p?.in_channel) break;
      await sleep(500);
    }
  }
  const p = await gsp("getplayerinfo", [name]);
  if (!p?.in_channel) throw new Error("could not enter the frontier segment");
  const seg = await gsp("getsegmentinfo", [1, 0]);
  const setup = setupFromPlayer(p, "");
  const s = new DungeonSession(seg.seed, seg.depth, setup.stats, p.hp, p.max_hp,
    setup.potions, constraintsFor(seg),
    p.active_visit.entry_direction, setup.inventory);

  const gate = s.dungeon.gates.find((g) => g.direction === p.active_visit.entry_direction)
    ?? s.dungeon.gates[0];
  for (let i = 0; i < 80 && !(s.playerX === gate.x && s.playerY === gate.y); i++) {
    const dx = Math.sign(gate.x - s.playerX), dy = Math.sign(gate.y - s.playerY);
    if (!s.processAction({ type: "move", dx, dy })
        && !s.processAction({ type: "move", dx, dy: 0 })
        && !s.processAction({ type: "move", dx: 0, dy })) s.processAction({ type: "wait" });
  }
  await move(name, {
    gw: {
      dir: gate.direction,
      settlement: {
        results: { survived: true, xp: s.totalXp, gold: s.totalGold, kills: s.totalKills },
        actions: [...s.actionLog, { type: "gate" }].map((a) =>
          a.type === "use" ? { type: "use", item: a.itemId } : a),
      },
    },
  });
  for (let i = 0; i < 40; i++) {
    segs = await gsp("listsegments", []);
    if (segs.some((x) => x.x === 1 && x.y === 0 && x.confirmed)) return;
    await sleep(600);
  }
  throw new Error("the arena never became confirmed");
}

/** Cancels or voids every open duel, so a fresh match is not confused by one. */
export async function clearOpenDuels() {
  const open = (await gsp("listvisits", ["open"])) || [];
  for (const v of open) {
    if (v.mode !== "duel") continue;
    await move(v.initiator, { lv: { id: v.id } });
    await mine(1);
  }
  return open.length;
}
