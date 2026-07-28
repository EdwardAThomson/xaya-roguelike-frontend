/**
 * Main entry point — Phase F3/F4a/F5: GSP connection, move submission,
 * and channel play with real player stats.
 *
 * Two modes:
 *   "overworld" — connected to GSP, segment map, on-chain player stats,
 *                 travel, enter/exit dungeon channels
 *   "dungeon"   — local dungeon play (standalone or channel session)
 */

import { WIDTH, HEIGHT } from "./game/dungeon.js";
import { DungeonSession, GameAction } from "./game/session.js";
import { PlayerStats } from "./game/combat.js";
import { Camera } from "./render/camera.js";
import { TILE_SIZE, drawTile, initSprites } from "./render/tiles.js";
import { drawMonsters, drawGroundItems, drawPlayer } from "./render/entities.js";
import { InputHandler, Direction, isEditableTarget } from "./game/input.js";
import { FovMap } from "./render/fov.js";
import { Connection, ConnectionState } from "./net/connection.js";
import { PlayerInfo, SegmentInfo } from "./net/rpc.js";
import { Gate } from "./game/dungeon.js";
import { MoveClient, createMoveClient } from "./net/moves.js";
import { layoutSegments, SegmentNode, hitTestSegment, areLinked } from "./game/overworld.js";
import { drawOverworld, NODE_SIZE, CELL, PlayerMarker, OverworldView } from "./render/overworld.js";
import { DEFAULT_GSP_URL, DEFAULT_PROXY_URL } from "./config.js";
import {
  ValidatorContext, ValidationResult,
  validateDiscover, validateTravel, validateEnterChannel,
  validateUseItem, validateAllocateStat, validateEquip, validateUnequip,
  validateDiscard,
  validateGateWalk,
  discoveryCooldownRemaining,
} from "./net/validator.js";
import { waitFor } from "./net/pending.js";
import { showErrorModal, showModal, showConfirmModal } from "./ui/modal.js";
import { showOverlay, hideOverlay } from "./ui/overlay.js";
import { lookupItem } from "./game/items.js";

// --- DOM refs ---

const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

const gspUrlInput = document.getElementById("gsp-url") as HTMLInputElement;
const playerNameInput = document.getElementById("player-name") as HTMLInputElement;
const connectBtn = document.getElementById("connect-btn") as HTMLButtonElement;
const statusEl = document.getElementById("connection-status")!;
const blockHeightEl = document.getElementById("block-height")!;
const modeOverworldBtn = document.getElementById("mode-overworld") as HTMLButtonElement;
const modeDungeonBtn = document.getElementById("mode-dungeon") as HTMLButtonElement;

// Persistent Help entry point.  index.html isn't edited here, so the button
// is injected into the topbar (always visible, next to the mode buttons).
const helpBtn = document.createElement("button");
helpBtn.id = "open-help-btn";
helpBtn.className = "mode-btn";
helpBtn.dataset.action = "open-help";
helpBtn.textContent = "Help (?)";
helpBtn.title = "Show controls and help (press ? or H)";
document.getElementById("topbar")?.appendChild(helpBtn);

// Recenter control for the overworld map: resets pan/zoom and re-enables
// follow mode.  Injected here (index.html isn't edited); shown only in the
// overworld view via setMode().
const recenterBtn = document.createElement("button");
recenterBtn.id = "recenter-map-btn";
recenterBtn.className = "mode-btn";
recenterBtn.dataset.action = "recenter-map";
recenterBtn.textContent = "Recenter (C)";
recenterBtn.title = "Recenter the map on your segment and reset zoom (press C)";
recenterBtn.style.display = "none";
document.getElementById("topbar")?.appendChild(recenterBtn);

// --- State ---

type AppMode = "overworld" | "dungeon";
let mode: AppMode = "dungeon";  // default: tile view (hub or active session)
let busy = false;  // prevents actions while async ops are in progress

const camera = new Camera();
initSprites();

// Dungeon-mode state.  `session` holds whichever tile-room is currently
// shown: a real dungeon session when channelSession=true, or the hub
// session when the player is at segment 0 out-of-channel.
let session: DungeonSession | null = null;
let fov: FovMap | null = null;
let seedCounter = 0;
let channelSession = false;  // true when session is a real dungeon channel
let channelSegmentId = -1;
let channelVisitId = -1;
/** Snapshot of player.current_segment the last time we built a hub session,
 *  so we know to rebuild if it changes (e.g. on death respawn). */
let hubBuiltAtSegment = -1;
/** True while the reconnect-mid-channel modal is on screen; prevents
 *  it being shown again on every poll. */
let reconnectPromptShown = false;

// Overworld mode state.
let overworldNodes: Map<number, SegmentNode> = new Map();
let connState: ConnectionState | null = null;
let selectedSegment: number | null = null;

// Overworld map view transform: a manual pixel pan plus a zoom scale layered
// on top of the auto-centering on the current segment.  `mapFollow` (the
// default) keeps the view centered on the current segment and forces the pan
// to zero; dragging or zooming turns it off, and "Recenter" turns it back on.
let panX = 0;
let panY = 0;
let zoom = 1;
let mapFollow = true;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.2;
/** Last current-segment we auto-centered on, so a segment change while in
 *  follow mode re-snaps the view. */
let followSeg = -1;

// Drag-to-pan bookkeeping.  A press that stays within DRAG_THRESHOLD pixels is
// treated as a click (segment select); anything larger is a pan.
const DRAG_THRESHOLD = 5;
let isPanning = false;
let panMoved = false;
let panDownX = 0;
let panDownY = 0;
let lastClientX = 0;
let lastClientY = 0;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The effective view transform passed to the renderer and hit-test.  In
 *  follow mode the pan is pinned to zero (pure centering). */
function overworldView(): OverworldView {
  return mapFollow
    ? { panX: 0, panY: 0, zoom }
    : { panX, panY, zoom };
}

/** Reset to the default centered, unscaled view and re-enable follow mode. */
function recenterMap(): void {
  panX = 0;
  panY = 0;
  zoom = 1;
  mapFollow = true;
  if (mode === "overworld") render();
}

// Move client.
let moves: MoveClient | null = null;

// --- Connection ---

const connection = new Connection((state: ConnectionState) => {
  connState = state;
  updateConnectionUI();
  rebuildOverworld();
  ensureSessionFromChainState();
  render();
  updateSidebar();
});

/**
 * Rebuilds the local session to match what the chain says about the
 * player.  Three cases:
 *   - in_channel=1 with active_visit → reconstruct the dungeon from
 *     that segment's seed.  Local action log / kills / pickups from
 *     before the refresh are gone, so the player has to re-clear the
 *     dungeon before settling.  HP on-chain still reflects what it
 *     was at entry, so a fresh session uses that HP correctly.
 *   - current_segment=0 and not in channel → hub session (existing
 *     logic).
 *   - current_segment != 0 and not in channel → legacy state from
 *     before gw; the player can use the Map view to navigate.  No
 *     session built here.
 */
function ensureSessionFromChainState(): void {
  const p = connState?.player;
  if (!p) return;
  // A channel transition (gate-walk / enter / exit) briefly nulls the local
  // session before loading the new one. Do not run reconnect reconciliation
  // in that window, or a state poll sees "in_channel with no session" and
  // wrongly pops the reconnect modal mid-gate-walk (which then desyncs the
  // session and gets the next gate-walk rejected by the GSP).
  if (busy) return;
  if (channelSession || session) return;  // already have something

  if (p.in_channel && p.active_visit) {
    const segId = p.active_visit.segment_id;
    const visitId = p.active_visit.visit_id;
    const segInfo = connState!.segments.get(segId);
    if (!segInfo) {
      // Segment cache not populated yet; the next poll will retry.
      return;
    }
    if (reconnectPromptShown) return;  // modal is already up
    reconnectPromptShown = true;
    promptReconnectChoice(segInfo.seed, segInfo.depth, segId, visitId,
                          !segInfo.confirmed,
                          constraintsFor(segInfo),
                          p.active_visit.entry_direction);
    return;
  }

  ensureHubSessionIfAtHub();
}

/**
 * Modal shown when the player reconnects while still in_channel on
 * chain.  Two explicit choices, no keyboard escape — Esc and backdrop
 * are disabled because both options have consequences.
 *
 *   Continue: rebuild a fresh session for the same segment.  The
 *     player's in-flight progress is lost (frontend-only state) but
 *     the on-chain visit is still active; clearing the dungeon again
 *     and walking out will settle normally.
 *   Forfeit:  submit an empty xc with survived=false.  Backend applies
 *     the death penalty (respawn at hub, 25% gold) and — under the new
 *     anti-grief rule — also prunes the segment if it was provisional.
 */
function promptReconnectChoice(
  seed: string, depth: number, segmentId: number, visitId: number,
  isProvisional: boolean, constraints: Gate[], entryDirection: string,
): void {
  const forfeitDetail = isProvisional
    ? "Respawn at the hub now (25% gold penalty).  The segment is provisional and will be deleted — you'll have to re-discover it."
    : "Respawn at the hub now (25% gold penalty).  The segment stays available for future visits.";

  showConfirmModal({
    title: "You were in a dungeon when you disconnected",
    message:
      `Active visit on segment ${segmentId}.  Your local progress from before is lost.\n\n` +
      `Continue: replay the dungeon from scratch (it's deterministic, ` +
      `so it's the same layout).  You have until the 200-block visit ` +
      `timeout to settle.\n\n` +
      `Forfeit: ${forfeitDetail}`,
    confirmLabel: "Continue",
    cancelLabel: "Forfeit",
    dismissibleByEscape: false,
    onConfirm: () => {
      reconnectPromptShown = false;
      startChannelDungeon(seed, depth, segmentId, visitId,
                          constraints, entryDirection);
      addOverworldMessage(
        `Replaying dungeon at segment ${segmentId} from scratch.`,
        "info",
      );
    },
    onCancel: () => {
      reconnectPromptShown = false;
      void doForfeitVisit(visitId);
    },
  });
}

/**
 * Submits an empty xc with survived=false to settle an abandoned
 * channel.  The replay produces survived=false (empty action log
 * means the player did nothing), so the claim matches and the chain
 * applies the death penalty atomically.
 */
async function doForfeitVisit(visitId: number): Promise<void> {
  if (!moves || !connState?.playerName) return;
  busy = true;
  updateSidebar();
  showOverlay("Forfeiting visit...");
  try {
    await moves.exitChannel(
      connState.playerName, visitId,
      { survived: false, xp: 0, gold: 0, kills: 0 },
      [],
    );
    const resolved = await waitFor(connection, ({ player }) =>
      !!player && !player.in_channel);
    if (resolved) {
      addOverworldMessage(
        "Forfeited dungeon. Respawned at the hub.",
        "combat",
      );
      ensureHubSessionIfAtHub();
    } else {
      showErrorModal(
        "Forfeit didn't settle",
        "The chain didn't close the channel within the timeout. Try again, or wait for the 200-block force-settle.",
      );
    }
  } catch (e) {
    showErrorModal("Forfeit failed", e instanceof Error ? e.message : String(e));
  } finally {
    hideOverlay();
    busy = false;
    updateSidebar();
    render();
  }
}

/**
 * If the player is at the hub (segment 0) and not inside a real channel,
/**
 * Explored fog-of-war tiles, kept per segment so revisiting a place shows
 * the map you already uncovered instead of going dark again.  Each visit
 * is still a fresh deterministic run (same layout, monsters/items return),
 * but the revealed map persists for the session.  Keyed by segment seed
 * (and "hub" for the overworld hub).  In-memory, browser-local.
 */
const exploredByKey = new Map<string, Set<number>>();

function persistentExplored(key: string): Set<number> {
  let s = exploredByKey.get(key);
  if (!s) {
    s = new Set<number>();
    exploredByKey.set(key, s);
  }
  return s;
}

/**
 * make sure we have a hub session ready to render.  Rebuilds whenever
 * the player's `current_segment` flips from non-hub back to hub
 * (e.g. after a death respawn).
 */
function ensureHubSessionIfAtHub(entryDirection: string = ""): void {
  const p = connState?.player;
  if (!p) return;
  if (channelSession) return;  // real session takes precedence
  if (p.in_channel) return;     // about to load a real session
  if (p.current_segment !== 0) return;

  if (hubBuiltAtSegment === 0 && session !== null) return;  // already built

  // Use EFFECTIVE stats (base + equipment bonuses) to match the GSP's
  // ComputePlayerStats, which is what the settlement replay runs with.
  // Using base str/dex/con here would desync combat from the replay the
  // moment any stat-granting gear (rings, amulets, shields) is equipped,
  // and every settlement would be rejected.
  const stats: PlayerStats = {
    level: p.level,
    strength: p.effective_stats.strength,
    dexterity: p.effective_stats.dexterity,
    constitution: p.effective_stats.constitution,
    intelligence: p.effective_stats.intelligence,
    equipAttack: p.effective_stats.equip_attack,
    equipDefense: p.effective_stats.equip_defense,
  };
  session = DungeonSession.createHub(stats, p.hp, p.max_hp, entryDirection);
  fov = new FovMap();
  fov.explored = persistentExplored("hub");
  fov.update(session.playerX, session.playerY, session.dungeon);
  camera.centerOn(session.playerX, session.playerY);
  hubBuiltAtSegment = 0;
}

gspUrlInput.value = DEFAULT_GSP_URL;

// --- Landing / title screen ---

// Dismisses the title screen and reveals the game UI (topbar + app).  Safe to
// call repeatedly; a no-op once the landing is already gone.  It is invoked
// both from the Play button and from the connect flow, so a programmatic
// connect (the ?e2e=1 hook calls connectBtn.click() directly, never Play)
// still reveals the game without a manual Play click.
function hideLanding(): void {
  const landing = document.getElementById("landing-screen");
  if (landing) landing.classList.add("hidden");
}

document.getElementById("landing-play-btn")?.addEventListener("click", () => {
  hideLanding();
  playerNameInput.focus();
});

connectBtn.addEventListener("click", () => {
  if (connState?.status === "connected" || connState?.status === "connecting") {
    connection.disconnect();
    moves = null;
    session = null;
    fov = null;
    channelSession = false;
    hubBuiltAtSegment = -1;
    reconnectPromptShown = false;
  } else {
    // Reveal the game in case connect was triggered programmatically (e2e
    // hook) or before the landing screen was dismissed.
    hideLanding();
    const url = gspUrlInput.value.trim();
    const name = playerNameInput.value.trim();
    moves = createMoveClient({ proxyUrl: DEFAULT_PROXY_URL });
    connection.connect(url, name);
  }
});

function updateConnectionUI(): void {
  const s = connState?.status ?? "disconnected";
  statusEl.textContent = s === "error"
    ? `Error: ${connState?.error ?? "unknown"}`
    : s.charAt(0).toUpperCase() + s.slice(1);
  statusEl.className = `status-${s}`;

  const connected = s === "connected" || s === "connecting";
  connectBtn.textContent = connected ? "Disconnect" : "Connect";
  gspUrlInput.disabled = connected;
  playerNameInput.disabled = connected;

  // Block height (and discovery-cooldown countdown) in the topbar so the
  // player can see the chain advancing and how many blocks remain on the
  // cooldown.  Heights only move when a block is mined, so an unchanging
  // number means the chain is idle.
  if (s === "connected" && connState) {
    let text = `Block: ${connState.currentHeight}`;
    const p = connState.player;
    if (p) {
      const cd = discoveryCooldownRemaining(p, connState.currentHeight);
      if (cd > 0) text += ` · discover in ${cd}`;
    }
    blockHeightEl.textContent = text;
  } else {
    blockHeightEl.textContent = "";
  }
}

// --- Mode switching ---

function setMode(m: AppMode): void {
  mode = m;
  modeOverworldBtn.classList.toggle("active", m === "overworld");
  modeDungeonBtn.classList.toggle("active", m === "dungeon");
  modeOverworldBtn.disabled = m === "overworld";
  modeDungeonBtn.disabled = m === "dungeon";
  recenterBtn.style.display = m === "overworld" ? "" : "none";
  canvas.style.cursor = m === "overworld" ? "grab" : "";
  render();
  updateSidebar();
}

modeOverworldBtn.addEventListener("click", () => setMode("overworld"));
modeDungeonBtn.addEventListener("click", () => setMode("dungeon"));

// --- Overworld ---

function rebuildOverworld(): void {
  if (connState && connState.segments.size > 0) {
    overworldNodes = layoutSegments(connState.segments);
  } else {
    // Even with no segments, show segment 0 hub.
    overworldNodes = layoutSegments(new Map());
  }
}

// Canvas click handler for overworld segment selection.  The click event
// fires after mouseup, so a drag-pan sets `panMoved` and we skip selection.
canvas.addEventListener("click", (e) => {
  if (mode !== "overworld" || overworldNodes.size === 0) return;
  if (panMoved) { panMoved = false; return; }  // this was a drag, not a click

  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const currentSeg = connState?.player?.current_segment ?? 0;
  const centerNode = overworldNodes.get(currentSeg) ?? overworldNodes.get(0) ?? overworldNodes.values().next().value!;

  const hit = hitTestSegment(overworldNodes, x, y, centerNode,
    canvas.width, canvas.height, NODE_SIZE, CELL, overworldView());
  selectedSegment = hit;
  render();
  updateSidebar();
});

// Drag-to-pan.  mousedown starts a potential drag; movement past the threshold
// commits it (turning off follow mode), and the pan follows the pointer.  The
// move/up listeners live on window so a drag keeps working outside the canvas.
canvas.addEventListener("mousedown", (e) => {
  if (mode !== "overworld" || e.button !== 0) return;
  isPanning = true;
  panMoved = false;
  panDownX = e.clientX;
  panDownY = e.clientY;
  lastClientX = e.clientX;
  lastClientY = e.clientY;
});

window.addEventListener("mousemove", (e) => {
  if (!isPanning) return;
  if (!panMoved && Math.hypot(e.clientX - panDownX, e.clientY - panDownY) >= DRAG_THRESHOLD) {
    panMoved = true;
    canvas.style.cursor = "grabbing";
    // Detach from follow: seed the manual pan from the current effective pan
    // (zero while following) so the map does not jump when the drag begins.
    if (mapFollow) { panX = 0; panY = 0; mapFollow = false; }
  }
  if (panMoved) {
    panX += e.clientX - lastClientX;
    panY += e.clientY - lastClientY;
    render();
  }
  lastClientX = e.clientX;
  lastClientY = e.clientY;
});

window.addEventListener("mouseup", () => {
  if (!isPanning) return;
  isPanning = false;
  if (mode === "overworld") canvas.style.cursor = "grab";
  // `panMoved` is left set for the click handler (which fires next) to inspect.
});

// Wheel to zoom, centered on the cursor.  Adjusts the pan so the world point
// under the pointer stays fixed while zooming.
canvas.addEventListener("wheel", (e) => {
  if (mode !== "overworld" || overworldNodes.size === 0) return;
  e.preventDefault();

  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const oldZoom = zoom;
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const newZoom = clamp(oldZoom * factor, ZOOM_MIN, ZOOM_MAX);
  if (newZoom === oldZoom) return;

  // Effective pan before the change (zero while following).
  const ex = mapFollow ? 0 : panX;
  const ey = mapFollow ? 0 : panY;
  const ratio = newZoom / oldZoom;
  // Keep the point under the cursor fixed relative to the canvas center.
  panX = mx - canvas.width / 2 - (mx - canvas.width / 2 - ex) * ratio;
  panY = my - canvas.height / 2 - (my - canvas.height / 2 - ey) * ratio;
  zoom = newZoom;
  mapFollow = false;
  render();
}, { passive: false });

// --- Dungeon mode ---

function newStandaloneDungeon(): void {
  channelSession = false;
  const stats: PlayerStats = {
    level: 1, strength: 10, dexterity: 10, constitution: 10, intelligence: 10,
    equipAttack: 5, equipDefense: 2,
  };
  const seed = "dungeon_" + seedCounter++;
  session = new DungeonSession(seed, 1, stats, 100, 100,
    [{ itemId: "health_potion", quantity: 3 }]);
  fov = new FovMap();
  fov.update(session.playerX, session.playerY, session.dungeon);
  camera.centerOn(session.playerX, session.playerY);
  render();
  updateSidebar();
}

/**
 * Build the gate-alignment constraint for a segment from its on-chain info,
 * so the frontend regenerates the same constrained layout as the GSP. Empty
 * when the segment was discovered unconstrained (e.g. from the hub).
 */
function constraintsFor(segInfo: SegmentInfo): Gate[] {
  const dir = segInfo.constraint_dir;
  if (!dir) return [];
  const g = segInfo.gates[dir];
  if (!g) return [];
  return [{ x: g.x, y: g.y, direction: dir }];
}

/** Start a channel dungeon session using real on-chain player data. */
function startChannelDungeon(
  segmentSeed: string, depth: number, segmentId: number, visitId: number,
  constraints: Gate[] = [], entryDirection: string = "",
): void {
  const p = connState?.player;
  if (!p) return;

  channelSession = true;
  channelSegmentId = segmentId;
  channelVisitId = visitId;

  // Use EFFECTIVE stats (base + equipment bonuses) to match the GSP's
  // ComputePlayerStats, which is what the settlement replay runs with.
  // Using base str/dex/con here would desync combat from the replay the
  // moment any stat-granting gear (rings, amulets, shields) is equipped,
  // and every settlement would be rejected.
  const stats: PlayerStats = {
    level: p.level,
    strength: p.effective_stats.strength,
    dexterity: p.effective_stats.dexterity,
    constitution: p.effective_stats.constitution,
    intelligence: p.effective_stats.intelligence,
    equipAttack: p.effective_stats.equip_attack,
    equipDefense: p.effective_stats.equip_defense,
  };

  // Build starting potions from player's bag.
  const potions: Array<{ itemId: string; quantity: number }> = [];
  for (const item of p.inventory) {
    if (item.slot === "bag" && (item.item_id === "health_potion" || item.item_id === "greater_health_potion")) {
      potions.push({ itemId: item.item_id, quantity: item.quantity });
    }
  }

  session = new DungeonSession(
    segmentSeed, depth, stats, p.hp, p.max_hp, potions,
    constraints, entryDirection);
  fov = new FovMap();
  fov.explored = persistentExplored("seg:" + segmentSeed);
  fov.update(session.playerX, session.playerY, session.dungeon);
  camera.centerOn(session.playerX, session.playerY);

  setMode("dungeon");
}


const OPPOSITE_DIRECTION: Record<string, string> = {
  north: "south", south: "north", east: "west", west: "east",
};

// --- Async actions (travel, enter channel, exit channel) ---

/**
 * Builds the validator context from the current connection state.
 * Returns null if we're not in a state where validation is meaningful
 * (not connected, no player, etc.) — callers should short-circuit.
 */
function validatorContext(): ValidatorContext | null {
  if (!connState?.player) return null;
  return {
    player: connState.player,
    segments: connState.segments,
    currentHeight: connState.currentHeight,
  };
}

/** Shows an error modal for a failed validation and returns false. */
function handleValidation(result: ValidationResult): boolean {
  if (result.ok) return true;
  showErrorModal(result.title, result.message);
  return false;
}

const OPPOSITE_DIR: Record<string, string> = {
  north: "south", south: "north", east: "west", west: "east",
};

/**
 * Given a validator context and a direction, returns the segment ID
 * the player would arrive at after traveling — or null if none can be
 * determined from the cache (e.g. stale data, hub with no neighbours).
 */
function targetSegmentFor(ctx: ValidatorContext, dir: string): number | null {
  const curSeg = ctx.player.current_segment;
  if (curSeg === 0) {
    const opp = OPPOSITE_DIR[dir];
    for (const seg of ctx.segments.values()) {
      for (const [d, lnk] of Object.entries(seg.links)) {
        if (lnk.to_segment === 0 && d === opp) return seg.id;
      }
    }
    return null;
  }
  const segInfo = ctx.segments.get(curSeg);
  return segInfo?.links[dir]?.to_segment ?? null;
}

/**
 * Called when a move's expected state change did NOT materialise.
 * Re-runs the validator against the latest state (now that the chain
 * has advanced) to surface the real reason in a modal.  Falls back to
 * a generic message if the validator also sees no problem.
 */
function diagnoseRejection(action: string, revalidate: () => ValidationResult): void {
  try {
    const v = revalidate();
    if (!v.ok) {
      showErrorModal(v.title, v.message);
      return;
    }
  } catch {
    // If revalidation needs a context we no longer have, fall through
    // to the generic message.
  }
  showErrorModal(
    `${action.charAt(0).toUpperCase() + action.slice(1)} move rejected`,
    `The move was submitted but the GSP did not apply it. Likely causes: ` +
      `this is a newly discovered segment you must confirm first (survive a ` +
      `run to a gate to complete it before you can leave); you're out of HP; ` +
      `the discovery cooldown hasn't elapsed (it counts blocks, not real ` +
      `time, so an idle devnet doesn't advance it); another player grabbed ` +
      `the coordinate first; or your local view is stale. Reconnect to ` +
      `refresh, then try again.`,
  );
}

async function doTravel(dir: string): Promise<void> {
  if (busy || !moves || !connState?.playerName) return;
  const ctx = validatorContext();
  if (!ctx) {
    showErrorModal("Not connected", "Connect to a GSP and register a player before traveling.");
    return;
  }
  if (!handleValidation(validateTravel(ctx, dir))) return;

  // Compute expected target segment so we can detect the state change.
  const expectedTarget = targetSegmentFor(ctx, dir);
  const beforeSeg = ctx.player.current_segment;

  busy = true;
  updateSidebar();
  try {
    await moves.travel(connState.playerName, dir);
    addOverworldMessage(`Traveling ${dir}...`, "info");

    const resolved = await waitFor(connection, ({ player }) =>
      !!player && player.current_segment !== beforeSeg
        && (expectedTarget === null || player.current_segment === expectedTarget));

    if (!resolved) diagnoseRejection("travel", () => validateTravel(validatorContext()!, dir));
  } catch (e) {
    showErrorModal("Travel failed", e instanceof Error ? e.message : String(e));
  }
  busy = false;
  updateSidebar();
}

async function doEnterChannel(segmentId: number): Promise<void> {
  if (busy || !moves || !connState?.playerName) return;
  const ctx = validatorContext();
  if (!ctx) {
    showErrorModal("Not connected", "Connect to a GSP and register a player before entering a dungeon.");
    return;
  }
  if (!handleValidation(validateEnterChannel(ctx, segmentId))) return;

  busy = true;
  updateSidebar();
  try {
    await moves.enterChannel(connState.playerName, segmentId);
    addOverworldMessage(`Entering dungeon at segment ${segmentId}...`, "info");

    const resolved = await waitFor(connection, ({ player }) =>
      !!player && player.in_channel && player.active_visit !== null);

    if (resolved && connState.player?.active_visit) {
      const segInfo = connState.segments.get(segmentId);
      if (segInfo) {
        startChannelDungeon(
          segInfo.seed, segInfo.depth, segmentId,
          connState.player.active_visit.visit_id,
          constraintsFor(segInfo),
          connState.player.active_visit.entry_direction);
        busy = false;
        return;
      }
      showErrorModal(
        "Missing segment data",
        `The frontend doesn't have segment ${segmentId} cached. Try reconnecting.`,
      );
    } else {
      diagnoseRejection("enter dungeon", () => validateEnterChannel(validatorContext()!, segmentId));
    }
  } catch (e) {
    showErrorModal("Enter dungeon failed", e instanceof Error ? e.message : String(e));
  }
  busy = false;
  updateSidebar();
}

async function doExitChannel(): Promise<void> {
  if (busy || !moves || !connState?.playerName || !session || !channelSession) return;
  // Snapshot gold before settle so we can report how much was lost on death.
  const goldBefore = connState.player?.gold ?? 0;
  const survived = session.survived;
  const earnedXp = session.totalXp;
  const earnedGold = session.totalGold;

  busy = true;
  updateSidebar();
  try {
    const results = {
      survived,
      xp: earnedXp,
      gold: earnedGold,
      kills: session.totalKills,
    };

    // Convert TS actionLog to C++ format: "itemId" -> "item"
    const actions = session.actionLog.map(a => {
      if (a.type === "use") return { type: "use", item: a.itemId };
      return a;
    });

    await moves.exitChannel(connState.playerName, channelVisitId, results, actions);

    const resolved = await waitFor(connection, ({ player }) =>
      !!player && !player.in_channel);

    if (!resolved) {
      showErrorModal(
        "Settlement rejected",
        "Your dungeon results were submitted but the GSP did not close the channel. The most likely cause is action-log replay mismatch — the submitted actions don't verify against the reported outcome. The dungeon session is still active; try exiting again.",
      );
      busy = false;
      updateSidebar();
      return;
    }

    if (survived) {
      addOverworldMessage(
        `Dungeon complete! +${earnedXp} XP, +${earnedGold} gold`,
        "pickup",
      );
    } else {
      // Death penalty: respawn at hub, lose 25% of carried gold
      // (computed against gold AFTER crediting anything earned).
      const totalGold = goldBefore + earnedGold;
      const goldLost = totalGold - Math.floor(totalGold * 75 / 100);
      addOverworldMessage("You died in the dungeon...", "combat");
      showModal({
        title: "You died",
        message:
          `You respawned at the hub (segment 0) and lost ${goldLost} gold ` +
          `(25% of your carried gold). XP and equipment are preserved.`,
        variant: "error",
      });
    }

    // Exit complete.  Clear channel-session state; the connection
    // callback will rebuild the hub session if we're back at segment 0
    // (which is the case for both death-respawn and Pass A's gate flow).
    // Pass B will replace this with an automatic transition into the
    // neighbour's session via the gw move.
    channelSession = false;
    session = null;
    fov = null;
    hubBuiltAtSegment = -1;
    ensureHubSessionIfAtHub();
    if (!session) {
      // Not at hub and no real session — fall back to the map view so
      // the player can navigate.  Pass B removes this case.
      setMode("overworld");
    }
  } catch (e) {
    showErrorModal("Exit channel failed", e instanceof Error ? e.message : String(e));
  }
  busy = false;
  updateSidebar();
}

async function doDiscover(dir: string): Promise<void> {
  if (busy || !moves || !connState?.playerName) return;
  const ctx = validatorContext();
  if (!ctx) {
    showErrorModal("Not connected", "Connect to a GSP and register a player before discovering.");
    return;
  }
  if (!handleValidation(validateDiscover(ctx, dir))) return;

  const currentSeg = ctx.player.current_segment;
  const currentDepth = overworldNodes.get(currentSeg)?.depth ?? 0;
  const beforeLastDiscover = ctx.player.last_discover_height;

  busy = true;
  updateSidebar();
  try {
    await moves.discover(connState.playerName, currentDepth + 1, dir);
    addOverworldMessage(`Discovering ${dir}...`, "info");

    const resolved = await waitFor(connection, ({ player }) =>
      !!player && player.last_discover_height > beforeLastDiscover);

    if (!resolved) diagnoseRejection("discover", () => validateDiscover(validatorContext()!, dir));
  } catch (e) {
    showErrorModal("Discover failed", e instanceof Error ? e.message : String(e));
  }
  busy = false;
  updateSidebar();
}

async function doUseItem(itemId: string): Promise<void> {
  if (busy || !moves || !connState?.playerName) return;
  const ctx = validatorContext();
  if (!ctx) return;
  if (!handleValidation(validateUseItem(ctx, itemId))) return;

  // Drinking a health potion at full HP would silently waste it, so guard
  // against it here (covers greater_health_potion too via the substring).
  // Use a visible modal, not just a log line: the inventory modal is usually
  // open on top of the message log, so a log-only message reads as "the
  // potion button does nothing / is broken".
  if (itemId.includes("health_potion") && ctx.player.hp >= ctx.player.max_hp) {
    showErrorModal("Already at full HP",
      "You are at full health, so this potion would be wasted. It is saved for when you are hurt.");
    return;
  }

  const beforeHp = ctx.player.hp;
  const beforeQty = ctx.player.inventory
    .filter(i => i.item_id === itemId && i.slot === "bag")
    .reduce((a, i) => a + i.quantity, 0);

  busy = true;
  updateSidebar();
  try {
    await moves.useItem(connState.playerName, itemId);
    addOverworldMessage(`Used ${itemId}...`, "info");

    const resolved = await waitFor(connection, ({ player }) => {
      if (!player) return false;
      if (player.hp > beforeHp) return true;
      const qty = player.inventory
        .filter(i => i.item_id === itemId && i.slot === "bag")
        .reduce((a, i) => a + i.quantity, 0);
      return qty < beforeQty;
    });

    if (!resolved) diagnoseRejection("use item", () => validateUseItem(validatorContext()!, itemId));
  } catch (e) {
    showErrorModal("Use item failed", e instanceof Error ? e.message : String(e));
  }
  busy = false;
  updateSidebar();
}

async function doAllocateStat(stat: string): Promise<void> {
  if (busy || !moves || !connState?.playerName) return;
  const ctx = validatorContext();
  if (!ctx) return;
  if (!handleValidation(validateAllocateStat(ctx, stat))) return;

  const before = ctx.player.stat_points;

  busy = true;
  updateSidebar();
  try {
    await moves.allocateStat(connState.playerName, stat);
    addOverworldMessage(`Allocated +1 ${stat}.`, "pickup");

    const resolved = await waitFor(connection, ({ player }) =>
      !!player && player.stat_points < before);

    if (!resolved) diagnoseRejection("allocate stat", () => validateAllocateStat(validatorContext()!, stat));
  } catch (e) {
    showErrorModal("Allocate stat failed", e instanceof Error ? e.message : String(e));
  }
  busy = false;
  updateSidebar();
}

async function doEquip(rowid: number, slot: string): Promise<void> {
  if (busy || !moves || !connState?.playerName) return;
  const ctx = validatorContext();
  if (!ctx) return;
  if (!handleValidation(validateEquip(ctx, rowid, slot))) return;

  busy = true;
  updateSidebar();
  try {
    await moves.equip(connState.playerName, rowid, slot);
    addOverworldMessage(`Equipped to ${slot}.`, "info");

    const resolved = await waitFor(connection, ({ player }) => {
      const item = player?.inventory.find(i => i.rowid === rowid);
      return !!item && item.slot === slot;
    });

    if (!resolved) diagnoseRejection("equip", () => validateEquip(validatorContext()!, rowid, slot));
  } catch (e) {
    showErrorModal("Equip failed", e instanceof Error ? e.message : String(e));
  }
  busy = false;
  updateSidebar();
}

async function doUnequip(rowid: number): Promise<void> {
  if (busy || !moves || !connState?.playerName) return;
  const ctx = validatorContext();
  if (!ctx) return;
  if (!handleValidation(validateUnequip(ctx, rowid))) return;

  busy = true;
  updateSidebar();
  try {
    await moves.unequip(connState.playerName, rowid);
    addOverworldMessage("Unequipped.", "info");

    const resolved = await waitFor(connection, ({ player }) => {
      const item = player?.inventory.find(i => i.rowid === rowid);
      return !!item && item.slot === "bag";
    });

    if (!resolved) diagnoseRejection("unequip", () => validateUnequip(validatorContext()!, rowid));
  } catch (e) {
    showErrorModal("Unequip failed", e instanceof Error ? e.message : String(e));
  }
  busy = false;
  updateSidebar();
}

function doDiscard(rowid: number): void {
  if (busy || !moves || !connState?.playerName) return;
  const ctx = validatorContext();
  if (!ctx) return;
  if (!handleValidation(validateDiscard(ctx, rowid))) return;

  const item = ctx.player.inventory.find(i => i.rowid === rowid);
  const label = item ? (lookupItem(item.item_id)?.name ?? item.item_id) : "this item";

  showConfirmModal({
    title: "Discard item?",
    message: `Permanently destroy ${label}? This cannot be undone.`,
    confirmLabel: "Discard",
    onConfirm: async () => {
      if (busy || !moves || !connState?.playerName) return;
      busy = true;
      updateSidebar();
      try {
        await moves.discard(connState.playerName, rowid);
        addOverworldMessage(`Discarded ${label}.`, "info");
        const resolved = await waitFor(connection, ({ player }) =>
          !!player && !player.inventory.some(i => i.rowid === rowid));
        if (!resolved)
          diagnoseRejection("discard", () => validateDiscard(validatorContext()!, rowid));
      } catch (e) {
        showErrorModal("Discard failed", e instanceof Error ? e.message : String(e));
      }
      busy = false;
      updateSidebar();
    },
  });
}

/**
 * Atomic gate-walk: settles current dungeon (if any) and transits to the
 * neighbour in `dir`, entering its channel — all in one on-chain move.
 * Auto-triggered when the player walks onto a gate tile, or when a
 * dungeon session ends via the gate action.
 */
async function doGateWalk(dir: string): Promise<void> {
  if (busy || !moves || !connState?.playerName) return;
  const ctx = validatorContext();
  if (!ctx) return;
  if (!handleValidation(validateGateWalk(ctx, dir))) return;

  // Build the settlement payload if we're settling a real dungeon run.
  // We deliberately do NOT end the live session here: walking through a
  // gate means survived=true, and the gate action is appended to the
  // action log purely for the replay payload.  The session is torn down
  // only *after* the chain confirms the transit (below), so a rejected
  // gate-walk — refused client-side or by the GSP — leaves the run fully
  // playable instead of stranding the player on the gate tile.
  // Leaving a CONFIRMED segment is a free transit (no settlement, no
  // rewards, no penalty): the GSP just moves you to the other side of the
  // gate. Leaving a PROVISIONAL segment still requires a settled run to
  // confirm it (anti-grief). See the traversal model in the GSP CLAUDE.md.
  const curConfirmed = !!ctx.segments.get(ctx.player.current_segment)?.confirmed;
  let settlement: undefined | {
    results: { survived: boolean; xp: number; gold: number; kills: number };
    actions: object[];
  };
  let transit = false;
  if (channelSession && session) {
    // A run banks its rewards when it actually did something worth settling:
    // picked up loot, used a potion, or earned XP/gold/kills from combat.
    // Leaving a PROVISIONAL segment always settles (that is what confirms
    // it); a survived run through a CONFIRMED segment that earned anything
    // must ALSO settle so the GSP banks the replay-derived loot AND xp/gold,
    // otherwise it is silently wiped on transit (that is how re-run loot and
    // combat XP were being lost). Only a bare crossing of a confirmed segment
    // (no loot, no combat) stays a plain, free transit with no proof.
    const earnedRewards = session.actionLog.some(
        a => a.type === "pickup" || a.type === "use")
      || (session.totalXp ?? 0) > 0
      || (session.totalKills ?? 0) > 0
      || (session.totalGold ?? 0) > 0;
    if (curConfirmed && !earnedRewards) {
      transit = true;
    } else {
      const actions: object[] = session.actionLog.map(a =>
        a.type === "use" ? { type: "use", item: a.itemId } : a);
      actions.push({ type: "gate" });
      settlement = {
        results: {
          survived: true,
          xp: session.totalXp,
          gold: session.totalGold,
          kills: session.totalKills,
        },
        actions,
      };
    }
  }

  const wasInChannel = channelSession;
  const sourceSeg = ctx.player.current_segment;
  // Snapshot the current visit so we can detect the *actual* transit.
  // A gw from inside a channel starts with in_channel=1 + an active
  // visit, so we must wait for a DIFFERENT visit (every channel entry
  // mints a fresh visit id) rather than for "in a channel" — otherwise
  // waitFor resolves immediately on the stale pre-gw state and we
  // re-enter the same segment at the opposite gate.
  const beforeVisitId = ctx.player.active_visit?.visit_id ?? null;

  busy = true;
  updateSidebar();
  showOverlay(
    wasInChannel
      ? `Settling dungeon and walking ${dir}...`
      : `Walking ${dir}...`,
  );

  try {
    await moves.gateWalk(connState.playerName, dir, settlement, transit);

    // Wait for the chain to reflect the transit.  Success looks like:
    //   - entered a (new) channel — a visit id different from before, OR
    //   - landed at the hub from somewhere else (current_segment==0,
    //     !in_channel, and source was non-hub).
    const resolved = await waitFor(connection, ({ player }) => {
      if (!player) return false;
      if (player.in_channel && player.active_visit
          && player.active_visit.visit_id !== beforeVisitId) {
        return true;
      }
      if (sourceSeg !== 0
          && player.current_segment === 0
          && !player.in_channel) {
        return true;
      }
      return false;
    });

    if (!resolved) {
      diagnoseRejection(
        "gate walk",
        () => validateGateWalk(validatorContext()!, dir),
      );
      return;
    }

    // gw only ever settles a survival exit (deaths go through xc, and
    // the GSP refuses survived=false on gw), so report the run complete.
    if (settlement) {
      addOverworldMessage(
        `Dungeon complete! +${settlement.results.xp} XP, +${settlement.results.gold} gold`,
        "pickup",
      );
    }

    // Tear down old session and load the new one based on where we
    // ended up.
    channelSession = false;
    session = null;
    fov = null;
    hubBuiltAtSegment = -1;

    const p = connState.player!;
    if (p.in_channel && p.active_visit) {
      // Entered a new channel — load that segment's dungeon.  When we just
      // DISCOVERED the segment, its details arrive a poll or two after the
      // player state, so wait briefly for the cache to populate rather than
      // giving up (which leaves session=null and lets a poll pop the
      // reconnect modal, desyncing the run and rejecting the next gate-walk).
      const newSegId = p.active_visit.segment_id;
      let segInfo = connState.segments.get(newSegId);
      for (let i = 0; i < 25 && !segInfo; i++) {
        await new Promise((r) => setTimeout(r, 200));
        segInfo = connState?.segments.get(newSegId);
      }
      if (segInfo) {
        // Regenerate the same constrained layout the GSP replay uses, and
        // spawn at the gate the player entered through — both come from
        // on-chain state so live play matches the replay byte-for-byte.
        startChannelDungeon(
          segInfo.seed, segInfo.depth, newSegId, p.active_visit.visit_id,
          constraintsFor(segInfo), p.active_visit.entry_direction);
      } else {
        // Segment cache miss; force a refresh.  The session will load
        // on the next poll via ensureHubSessionIfAtHub or manual retry.
        showErrorModal(
          "Missing segment data",
          `The frontend doesn't have segment ${newSegId} cached. Reconnect to refresh.`,
        );
      }
    } else if (p.current_segment === 0) {
      // Arrived back at the hub: spawn at the gate we came in through
      // (opposite the direction we walked).
      ensureHubSessionIfAtHub(OPPOSITE_DIRECTION[dir] ?? "");
    }
  } catch (e) {
    showErrorModal("Gate walk failed", e instanceof Error ? e.message : String(e));
  } finally {
    hideOverlay();
    busy = false;
    updateSidebar();
    render();
  }
}

async function doRegister(): Promise<void> {
  if (busy || !moves || !connState?.playerName) return;
  busy = true;
  updateSidebar();
  try {
    await moves.registerPlayer(connState.playerName);

    const resolved = await waitFor(connection, ({ player }) => player !== null);

    if (resolved) {
      addOverworldMessage("Player registered!", "pickup");
    } else {
      showErrorModal(
        "Registration rejected",
        "The register move was submitted but the GSP did not create the player. The name may already be taken on-chain or the proxy may not have minted the Xaya name. Check the proxy logs.",
      );
    }
  } catch (e) {
    showErrorModal("Registration failed", e instanceof Error ? e.message : String(e));
  }
  busy = false;
  updateSidebar();
}

// --- Overworld message buffer ---

const overworldMessages: Array<{ text: string; type: string }> = [];

function addOverworldMessage(text: string, type: string): void {
  overworldMessages.push({ text, type });
  if (overworldMessages.length > 20) overworldMessages.shift();
  if (mode === "overworld") updateOverworldMessages();
}

// --- Resize ---

function resize(): void {
  const parent = canvas.parentElement!;
  canvas.width = parent.clientWidth;
  canvas.height = parent.clientHeight;
  camera.resize(canvas.width, canvas.height);
  if (session && mode === "dungeon") {
    camera.centerOn(session.playerX, session.playerY);
  }
  render();
}
window.addEventListener("resize", resize);
resize();

// --- Render ---

function render(): void {
  if (mode === "overworld") {
    renderOverworld();
  } else {
    renderDungeon();
  }
}

/**
 * The segment the player is actually located in.  While in a channel the
 * dungeon being played is `active_visit.segment_id`, which can differ from
 * `current_segment` (the overworld node the player is based at) — the tile
 * view loads the visit's segment, so the map and sidebar must agree.
 */
function playerLocationSegment(p: PlayerInfo): number {
  return p.in_channel && p.active_visit ? p.active_visit.segment_id : p.current_segment;
}

function renderOverworld(): void {
  const p = connState?.player;
  const currentSeg = p ? playerLocationSegment(p) : 0;
  // Snap back to the current segment when it changes while following, so the
  // view tracks the player between segments (any stray pan is cleared).
  if (mapFollow && currentSeg !== followSeg) {
    panX = 0;
    panY = 0;
  }
  followSeg = currentSeg;
  // Presence tokens for OTHER players, keyed by the segment they are on
  // (from the on-chain world state).  The current player is already shown
  // via the "@" marker, so exclude self here.
  const presence = new Map<number, PlayerMarker[]>();
  const selfName = connState?.playerName;
  for (const pl of connState?.fullState?.players ?? []) {
    if (pl.name === selfName) continue;
    if (!overworldNodes.has(pl.current_segment)) continue;
    const arr = presence.get(pl.current_segment) ?? [];
    arr.push({ name: pl.name, inChannel: pl.in_channel });
    presence.set(pl.current_segment, arr);
  }
  drawOverworld(ctx, overworldNodes, currentSeg, selectedSegment,
    canvas.width, canvas.height, presence, overworldView());
}

function renderDungeon(): void {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!session || !fov) {
    ctx.fillStyle = "#666";
    ctx.font = "16px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    let line1: string;
    let line2: string;
    if (connState?.status !== "connected") {
      line1 = "Enter a GSP URL and player name in the top bar,";
      line2 = "then click Connect.";
    } else if (!connState.player) {
      line1 = `Player "${connState.playerName}" doesn't exist on-chain yet.`;
      line2 = "Click “Register Player” in the right-hand sidebar →";
    } else {
      line1 = "Loading hub...";
      line2 = "";
    }
    ctx.fillText(line1, canvas.width / 2, canvas.height / 2 - 12);
    if (line2)
      ctx.fillText(line2, canvas.width / 2, canvas.height / 2 + 12);
    return;
  }

  const dungeon = session.dungeon;

  for (let y = camera.y; y < camera.y + camera.viewH && y < HEIGHT; y++) {
    for (let x = camera.x; x < camera.x + camera.viewW && x < WIDTH; x++) {
      const alpha = fov.getAlpha(x, y);
      if (alpha <= 0) continue;
      const [px, py] = camera.toScreen(x, y);
      drawTile(ctx, dungeon.getTile(x, y), px, py, alpha);
    }
  }

  drawGroundItems(ctx, camera,
    session.groundItems.filter(gi => fov!.isVisible(gi.x, gi.y)));
  drawMonsters(ctx, camera,
    session.monsters.filter(m => m.alive && fov!.isVisible(m.x, m.y)));
  drawPlayer(ctx, camera, session.playerX, session.playerY);

  ctx.font = "bold 14px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const gate of dungeon.gates) {
    if (camera.isVisible(gate.x, gate.y) && fov.isVisible(gate.x, gate.y)) {
      const [gx, gy] = camera.toScreen(gate.x, gate.y);
      ctx.fillStyle = "#ffd700";
      const arrow = gate.direction === "north" ? "\u2191"
                  : gate.direction === "south" ? "\u2193"
                  : gate.direction === "east" ? "\u2192" : "\u2190";
      ctx.fillText(arrow, gx + TILE_SIZE / 2, gy + TILE_SIZE / 2);
    }
  }
}

// --- Input ---

function handleGameInput(action: string, dir?: Direction): void {
  if (mode !== "dungeon") {
    // If we are peeking at the world map (overworld view) during a live
    // dungeon run, a gameplay key should snap us back into the dungeon and
    // act, not be silently swallowed (which feels like being stuck).
    if (channelSession && session && !session.gameOver) {
      setMode("dungeon");
    } else {
      return;
    }
  }
  if (!session || session.gameOver) return;
  if (busy) return;  // an on-chain action is in flight

  let gameAction: GameAction | null = null;
  switch (action) {
    case "move":
      if (dir) gameAction = { type: "move", dx: dir.dx, dy: dir.dy };
      break;
    case "pickup":
      // Pickup is a no-op in the hub (no items there).
      if (!channelSession) return;
      gameAction = { type: "pickup" };
      break;
    case "wait":
      gameAction = { type: "wait" };
      break;
    case "gate": {
      // Pressing Enter on a gate is explicit intent: trigger gw directly
      // in both the hub and a channel.  doGateWalk ends the in-session
      // run itself (after validating), so we don't touch the session
      // here — that keeps a rejected gw from stranding the run in a
      // gameOver state.
      const gate = gateAtPlayer();
      if (gate) doGateWalk(gate.direction);
      return;
    }
    case "use_potion":
      if (!channelSession) return;
      gameAction = { type: "use", itemId: "health_potion" };
      break;
  }

  if (gameAction && session && fov) {
    session.processAction(gameAction);
    fov.update(session.playerX, session.playerY, session.dungeon);
    camera.centerOn(session.playerX, session.playerY);
    render();
    updateSidebar();

    // If a "move" landed us on a gate (hub OR real dungeon), ask for
    // confirmation before settling/transiting.  Easy to step on a gate
    // by accident.  (Enter-on-a-gate is handled directly above.)
    if (action === "move") {
      const gate = gateAtPlayer();
      if (gate) confirmGateWalk(gate.direction);
    }
  }
}

new InputHandler(handleGameInput);

/** Returns the gate at the player's current position, or null. */
function gateAtPlayer(): { x: number; y: number; direction: string } | null {
  if (!session) return null;
  for (const g of session.dungeon.gates) {
    if (g.x === session.playerX && g.y === session.playerY) return g;
  }
  return null;
}

/**
 * Shows a confirmation modal before stepping through a gate.  Used when
 * the player walks onto a gate tile (easy to do by accident).  Pressing
 * Enter while already on a gate is treated as explicit intent and
 * skips this confirmation — see the input handler.
 */
function confirmGateWalk(dir: string): void {
  const p = connState?.player;
  if (!p) return;

  // Build a context-appropriate message based on what's on the other
  // side of the gate.
  let detail = "";
  const curSeg = p.current_segment;
  const opp = OPPOSITE_DIRECTION[dir];

  // Find target via segment_links (hub uses inferred back-links).
  let target: number | undefined;
  if (curSeg === 0) {
    for (const seg of (connState?.segments?.values() ?? [])) {
      for (const [d, lnk] of Object.entries(seg.links)) {
        if (lnk.to_segment === 0 && d === opp) { target = seg.id; break; }
      }
      if (target !== undefined) break;
    }
  } else {
    const segInfo = connState?.segments.get(curSeg);
    target = segInfo?.links[dir]?.to_segment;
  }

  if (target === undefined) {
    const remaining = discoveryCooldownRemaining(p, connState?.currentHeight ?? 0);
    if (remaining > 0) {
      detail = `Discovers a new dungeon (currently on cooldown — wait ${remaining} block${remaining === 1 ? "" : "s"}).`;
    } else {
      detail = `Discovers a new dungeon (50-block cooldown will apply after).`;
    }
  } else if (target === 0) {
    detail = `Returns you to the hub (0, 0).`;
  } else {
    const segInfo = connState?.segments.get(target);
    if (segInfo) {
      const coord = `(${segInfo.world_x}, ${segInfo.world_y})`;
      const status = segInfo.confirmed ? "depth " + segInfo.depth
                                       : `depth ${segInfo.depth}, provisional`;
      detail = `Enters ${coord} (${status}).`;
    } else {
      detail = `Enters a new area.`;
    }
  }

  showConfirmModal({
    title: `Walk through the ${dir} gate?`,
    message: detail,
    confirmLabel: "Walk",
    onConfirm: () => {
      // doGateWalk validates first, then ends the in-session run itself
      // (appending the gate action to the log for replay).  We don't
      // touch the session here so a rejected gw leaves it playable.
      doGateWalk(dir);
    },
  });
}

document.addEventListener("keydown", (e) => {
  if (isEditableTarget(e.target)) return;
  if (e.key === "Escape") {
    if (helpOpen) { setHelpOpen(false); return; }
    if (activeModalTab) { setModalTab(null); return; }
  }
  // "?" (Shift+/) or H toggles help.  In game (connected) it opens the
  // in-game modal on the Help tab; before connecting it opens the
  // standalone title-screen help overlay, so it never spawns the in-game
  // modal machinery pre-connect.  Neither key is bound to movement.
  if (e.key === "?" || e.key.toLowerCase() === "h") {
    if (connState?.player) {
      setModalTab(activeModalTab === "help" ? null : "help");
    } else {
      setHelpOpen(!helpOpen);
    }
    return;
  }
  if (e.key.toLowerCase() === "i" && connState?.player) {
    setModalTab(activeModalTab === "inventory" ? null : "inventory");
    return;
  }
  // "M" toggles the world map (overworld view) against the dungeon view.
  if (e.key.toLowerCase() === "m" && connState?.player) {
    setMode(mode === "overworld" ? "dungeon" : "overworld");
    return;
  }
  // "C" recenters the overworld map (reset pan/zoom, re-enable follow).
  if (mode === "overworld" && e.key.toLowerCase() === "c") {
    recenterMap();
    return;
  }
  if (mode === "dungeon" && e.key.toLowerCase() === "n" && !channelSession) {
    newStandaloneDungeon();
  }
});

// Delegated click handler for dynamic buttons.
document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const action = target.dataset.action;
  if (!action) return;

  switch (action) {
    case "restart":
      newStandaloneDungeon();
      break;
    case "register":
      doRegister();
      break;
    case "travel":
      doTravel(target.dataset.dir!);
      break;
    case "discover":
      doDiscover(target.dataset.dir!);
      break;
    case "enter-channel":
      doEnterChannel(Number(target.dataset.segment));
      break;
    case "exit-channel":
      doExitChannel();
      break;
    case "back-to-overworld":
      channelSession = false;
      session = null;
      fov = null;
      setMode("overworld");
      break;
    case "use-item":
      doUseItem(target.dataset.item!);
      break;
    case "use-potion-local":
      // Drink a potion inside a dungeon: local, replayed action (same as P).
      handleGameInput("use_potion");
      break;
    case "allocate-stat":
      doAllocateStat(target.dataset.stat!);
      break;
    case "equip":
      doEquip(Number(target.dataset.rowid), target.dataset.slot!);
      break;
    case "unequip":
      doUnequip(Number(target.dataset.rowid));
      break;
    case "discard":
      doDiscard(Number(target.dataset.rowid));
      break;
    case "open-inventory":
      setModalTab("inventory");
      break;
    case "open-help":
      // In-game (topbar) Help: the modal's Help tab.
      setModalTab("help");
      break;
    case "recenter-map":
      recenterMap();
      break;
    case "open-help-home":
      // Title-screen Help: the standalone overlay (no in-game modal).
      setHelpOpen(true);
      break;
    case "close-help":
      setHelpOpen(false);
      break;
    case "switch-tab":
      setModalTab(target.dataset.tab as ModalTab);
      break;
    case "close-modal":
      setModalTab(null);
      break;
  }
});

// --- Inventory & equipment modal ---

/** Equipment slots in display order, matching the GSP's slot names. */
const EQUIP_SLOTS: Array<{ slot: string; label: string; icon: string }> = [
  { slot: "weapon",  label: "Weapon",   icon: "⚔️" },
  { slot: "offhand", label: "Off-hand", icon: "🛡️" },
  { slot: "head",    label: "Head",     icon: "⛑️" },
  { slot: "body",    label: "Body",     icon: "👕" },
  { slot: "feet",    label: "Feet",     icon: "👢" },
  { slot: "ring",    label: "Ring",     icon: "💍" },
  { slot: "amulet",  label: "Amulet",   icon: "📿" },
];

// The persistent game modal is a single element with a tab bar.  `null`
// means closed; otherwise the value is the active tab.  A topbar button
// (or key) opens it on a specific tab; the tab bar switches between them
// without closing.
type ModalTab = "inventory" | "players" | "help";
let activeModalTab: ModalTab | null = null;
// The in-game modal carries a Help tab (alongside Inventory / Players).
// Separately, the title screen has its OWN standalone help overlay
// (`helpOpen` below): it shows the same information but is deliberately
// decoupled from the in-game modal, so opening help from the homepage
// never instantiates the inventory/players game-state machinery.
let helpOpen = false;

// The InputHandler suppresses gameplay movement while "inv-open" is set;
// keep it on whenever any overlay (the game modal or help) is open.
function syncModalBodyClass(): void {
  document.body.classList.toggle("inv-open", activeModalTab !== null || helpOpen);
}

function setModalTab(tab: ModalTab | null): void {
  activeModalTab = tab;
  syncModalBodyClass();
  renderGameModal();
}

function setHelpOpen(open: boolean): void {
  helpOpen = open;
  syncModalBodyClass();
  renderHelpOverlay();
}

/** Short stat-bonus summary for an item, e.g. "ATK +5, STR +1". */
function itemStatLine(itemId: string): string {
  const d = lookupItem(itemId);
  if (!d) return "";
  const parts: string[] = [];
  if (d.attackPower) parts.push(`ATK +${d.attackPower}`);
  if (d.defense) parts.push(`DEF +${d.defense}`);
  if (d.strength) parts.push(`STR ${d.strength > 0 ? "+" : ""}${d.strength}`);
  if (d.dexterity) parts.push(`DEX ${d.dexterity > 0 ? "+" : ""}${d.dexterity}`);
  if (d.constitution) parts.push(`CON ${d.constitution > 0 ? "+" : ""}${d.constitution}`);
  if (d.intelligence) parts.push(`INT ${d.intelligence > 0 ? "+" : ""}${d.intelligence}`);
  if (d.maxHealth) parts.push(`HP +${d.maxHealth}`);
  if (d.healAmount) parts.push(`heals ${d.healAmount}`);
  return parts.join(", ");
}

function itemIcon(itemId: string): string {
  return lookupItem(itemId)?.icon ?? "📦";
}
function itemName(itemId: string): string {
  return lookupItem(itemId)?.name ?? itemId;
}
function itemColor(itemId: string): string {
  return lookupItem(itemId)?.color ?? "#ccc";
}

/**
 * Builds the Inventory tab body (bag + equipped + pending finds).  This is
 * the exact content the standalone inventory overlay used to render; it is
 * now returned as HTML and mounted inside the unified game modal.  Returns a
 * placeholder when there is no player yet.
 */
function renderInventoryTabBody(): string {
  const p = connState?.player;
  if (!p) {
    return `<div class="inv-body"><div class="inv-empty">Connect and register to see your inventory.</div></div>`;
  }

  // On-chain inventory is the truth everywhere.  Equip/use/discard are
  // chain moves the GSP rejects mid-channel, so they're only active in
  // the hub; inside a dungeon the modal is read-only + pending finds.
  const interactive = !!moves && !p.in_channel && !busy;
  const equipped = new Map<string, typeof p.inventory[number]>();
  for (const it of p.inventory) if (it.slot !== "bag") equipped.set(it.slot, it);
  const bag = p.inventory.filter(it => it.slot === "bag");

  const equipHtml = EQUIP_SLOTS.map(s => {
    const it = equipped.get(s.slot);
    if (!it) {
      return `<div class="inv-slot inv-slot-empty">
        <span class="inv-slot-icon">${s.icon}</span>
        <span class="inv-slot-label">${s.label}</span>
        <span class="inv-empty">empty</span></div>`;
    }
    const stat = itemStatLine(it.item_id);
    const unequipBtn = interactive
      ? `<button class="inv-btn unequip" data-action="unequip" data-rowid="${it.rowid}">Unequip</button>`
      : "";
    return `<div class="inv-slot">
      <span class="inv-slot-icon">${itemIcon(it.item_id)}</span>
      <span class="inv-slot-label">${s.label}</span>
      <span class="inv-item-name" style="color:${itemColor(it.item_id)}">${itemName(it.item_id)}</span>
      ${stat ? `<span class="inv-stat">${stat}</span>` : ""}
      ${unequipBtn}</div>`;
  }).join("");

  const bagHtml = bag.length === 0
    ? '<div class="inv-empty">Bag is empty</div>'
    : bag.map(it => {
        const def = lookupItem(it.item_id);
        const canEquip = def && def.slot !== "" && def.type !== "potion" && def.type !== "misc";
        const canUse = def && def.type === "potion";
        const stat = itemStatLine(it.item_id);
        const btns = interactive ? [
          canEquip ? `<button class="inv-btn equip" data-action="equip" data-rowid="${it.rowid}" data-slot="${def!.slot}">Equip</button>` : "",
          canUse ? `<button class="inv-btn use" data-action="use-item" data-item="${it.item_id}">Use</button>` : "",
          `<button class="inv-btn discard" data-action="discard" data-rowid="${it.rowid}">Drop</button>`,
        ].join("")
          // Inside a dungeon, equip/drop are on-chain moves the GSP rejects
          // mid-run, so they stay read-only. But drinking a potion IS a local,
          // replayed action (the same one the P key does), so keep the potion
          // usable from the modal here instead of leaving it dead.
          : (p.in_channel && canUse
            ? `<button class="inv-btn use" data-action="use-potion-local">Drink</button>`
            : "");
        const qty = it.quantity > 1 ? ` x${it.quantity}` : "";
        return `<div class="inv-row">
          <span class="inv-item-icon">${itemIcon(it.item_id)}</span>
          <span class="inv-item-name" style="color:${itemColor(it.item_id)}">${itemName(it.item_id)}${qty}</span>
          ${stat ? `<span class="inv-stat">${stat}</span>` : ""}
          <span class="inv-row-actions">${btns}</span></div>`;
      }).join("");

  // Pending finds collected during the current run (settle on a winning exit).
  let pendingHtml = "";
  if (channelSession && session && session.collected.length > 0) {
    const rows = session.collected.filter(c => c.quantity > 0).map(c =>
      `<div class="inv-row inv-pending">
        <span class="inv-item-icon">${itemIcon(c.itemId)}</span>
        <span class="inv-item-name" style="color:${itemColor(c.itemId)}">${itemName(c.itemId)}${c.quantity > 1 ? ` x${c.quantity}` : ""}</span>
        <span class="inv-stat">${itemStatLine(c.itemId)}</span></div>`).join("");
    pendingHtml = `<div class="inv-pending-box">
      <div class="inv-pending-title">Collected this run (not saved until you exit through a gate)</div>
      ${rows}</div>`;
  }

  const note = p.in_channel
    ? '<div class="inv-note">In a dungeon you can drink potions (here or with P). Equipping gear and managing loot happen back at the hub: loot you pick up settles into your bag when you exit through a gate, then you can equip it.</div>'
    : "";

  return `
      ${note}
      <div class="inv-body">
        <div class="inv-bag">
          <div class="inv-col-title">Bag (${bag.length})</div>
          ${bagHtml}
          ${pendingHtml}
        </div>
        <div class="inv-equip">
          <div class="inv-col-title">Equipped</div>
          ${equipHtml}
        </div>
      </div>`;
}

// --- Players tab ---

/**
 * Builds the Players tab body: a list of every player who has joined this
 * world.  Data comes from `connState.fullState.players` (name, level,
 * current_segment); locations are resolved against `connState.segments`.
 * The chain does not track presence, so this is deliberately NOT labelled
 * "online"; it is everyone who has ever joined.
 */
function renderPlayersTabBody(): string {
  const fs = connState?.fullState;
  if (!fs) {
    return `<div class="players-wrap"><div class="inv-empty">Connect to see other players.</div></div>`;
  }

  const players = fs.players ?? [];
  const me = connState?.playerName ?? "";

  const rowHtml = (pl: typeof players[number]) => {
    const isYou = pl.name === me;
    let loc: string;
    if (pl.current_segment === 0) {
      loc = "Hub";
    } else {
      const seg = connState?.segments.get(pl.current_segment);
      loc = seg ? `(${seg.world_x}, ${seg.world_y})` : `seg ${pl.current_segment}`;
    }
    const youTag = isYou ? ' <span class="player-you-tag">(you)</span>' : "";
    const badge = pl.in_channel ? ' <span class="player-badge">in dungeon</span>' : "";
    return `<div class="player-row${isYou ? " player-you" : ""}">
      <span class="player-name">${pl.name}${youTag}${badge}</span>
      <span class="player-level">Lv${pl.level}</span>
      <span class="player-loc">${loc}</span>
    </div>`;
  };

  // "Active" = currently in a dungeon or out on a segment (not idling in the
  // hub). Show them first; players parked in the hub (incl. long-idle ones)
  // drop to the bottom. Put yourself at the top of your group.
  const youFirst = (a: typeof players[number], b: typeof players[number]) =>
    (a.name === me ? -1 : 0) - (b.name === me ? -1 : 0);
  const active = players.filter(p => p.in_channel || p.current_segment !== 0).sort(youFirst);
  const idle = players.filter(p => !p.in_channel && p.current_segment === 0).sort(youFirst);

  const section = (title: string, arr: typeof players) =>
    arr.length ? `<div class="players-section-title">${title} (${arr.length})</div>
      <div class="players-list">${arr.map(rowHtml).join("")}</div>` : "";

  const body = players.length > 0
    ? `${section("Active", active)}${section("In hub", idle)}`
    : `<div class="inv-empty">No players have joined this world yet.</div>`;

  return `<div class="players-wrap">
    <div class="players-header">Players in this world: ${players.length}</div>
    <div class="players-subtitle">Active = currently in a dungeon or out on a segment (presence is not tracked on-chain).</div>
    ${body}
  </div>`;
}

// --- Help tab ---

/**
 * Builds the Help tab body (controls and objective).  The key bindings
 * listed here match game/input.ts (movement, pickup, wait, gate, potion)
 * and the "n" / "i" handlers in the keydown listener above.
 */
function renderHelpBody(): string {
  return `
      <div class="help-body">
        <div class="help-section">
          <div class="help-section-title">Overworld / Hub</div>
          <div class="help-row"><span class="help-keys"><kbd>I</kbd></span><span>Open inventory and equipment</span></div>
          <div class="help-row"><span class="help-keys"><span class="help-key-text">In inventory</span></span><span>Click Equip / Unequip, Drink, or Drop on an item</span></div>
          <div class="help-row"><span class="help-keys"><span class="help-key-text">Gate / Travel / Discover</span></span><span>Buttons move you between segments</span></div>
          <div class="help-row"><span class="help-keys"><kbd>M</kbd></span><span>Toggle the world map</span></div>
          <div class="help-row"><span class="help-keys"><kbd>?</kbd><kbd>H</kbd></span><span>Open this help</span></div>
        </div>
        <div class="help-section">
          <div class="help-section-title">In a Dungeon</div>
          <div class="help-row"><span class="help-keys"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><span>or Arrow keys: move</span></div>
          <div class="help-row"><span class="help-keys"><kbd>Q</kbd><kbd>E</kbd><kbd>Z</kbd><kbd>C</kbd></span><span>Move diagonally</span></div>
          <div class="help-row"><span class="help-keys"><kbd>G</kbd></span><span>Pick up item</span></div>
          <div class="help-row"><span class="help-keys"><kbd>P</kbd></span><span>Drink health potion</span></div>
          <div class="help-row"><span class="help-keys"><kbd>Space</kbd></span><span>Wait a turn</span></div>
          <div class="help-row"><span class="help-keys"><kbd>Enter</kbd></span><span>Step through a gate</span></div>
          <div class="help-row"><span class="help-keys"><kbd>N</kbd></span><span>New dungeon (standalone mode)</span></div>
        </div>
        <div class="help-note">
          Goal: explore segments and survive to a gate to confirm newly discovered ones.
          If you die in a dungeon you forfeit any loot picked up on that run.
        </div>
        <div class="help-credit">
          &copy; 2026 Edward Thomson (<a href="https://octonion.io" target="_blank" rel="noopener noreferrer">Octonion Software</a>)
        </div>
        <div class="help-credit">
          Built on the <a href="https://xaya.io" target="_blank" rel="noopener noreferrer">Xaya</a> game framework.
        </div>
      </div>`;
}

/**
 * Standalone help overlay (controls + credits).  Deliberately independent
 * of the in-game modal and of any game state, so it is safe to open from
 * the title screen before the player has connected.
 */
function renderHelpOverlay(): void {
  document.getElementById("help-modal")?.remove();
  if (!helpOpen) return;

  const root = document.createElement("div");
  root.id = "help-modal";
  root.className = "modal-overlay";
  root.innerHTML = `
    <div class="game-modal-panel help-modal" role="dialog" aria-modal="true">
      <div class="inv-header">
        <span class="inv-title">Help &amp; Controls</span>
        <button class="inv-close" data-action="close-help">✕</button>
      </div>
      <div class="modal-tab-body">${renderHelpBody()}</div>
      <div class="inv-foot">Press Esc to close</div>
    </div>`;
  root.addEventListener("click", (e) => {
    if (e.target === root) setHelpOpen(false);
  });
  document.body.appendChild(root);
}

// --- Unified tabbed game modal ---

/**
 * Renders the single persistent game modal (Inventory / Players / Help).
 * Wipes any existing instance, bails when closed, and rebuilds one
 * `#game-modal` overlay appended to the body.  Closes on the ✕ button and
 * on a backdrop click.  Tab buttons switch the active body without closing.
 */
function renderGameModal(): void {
  document.getElementById("game-modal")?.remove();
  if (!activeModalTab) return;

  const tabs: Array<{ id: ModalTab; label: string }> = [
    { id: "inventory", label: "Inventory" },
    { id: "players",   label: "Players" },
    { id: "help",      label: "Help" },
  ];
  const tabBar = tabs.map(t =>
    `<button class="modal-tab${t.id === activeModalTab ? " active" : ""}" data-action="switch-tab" data-tab="${t.id}">${t.label}</button>`
  ).join("");

  let title = "";
  let headerExtra = "";
  let body = "";
  if (activeModalTab === "inventory") {
    title = "Inventory &amp; Equipment";
    const p = connState?.player;
    if (p) headerExtra = `<span class="inv-gold">🪙 ${p.gold}</span>`;
    body = renderInventoryTabBody();
  } else if (activeModalTab === "players") {
    title = "Players";
    body = renderPlayersTabBody();
  } else {
    title = "Help &amp; Controls";
    body = renderHelpBody();
  }

  const root = document.createElement("div");
  root.id = "game-modal";
  root.className = "modal-overlay";
  root.innerHTML = `
    <div class="game-modal-panel" role="dialog" aria-modal="true">
      <div class="inv-header">
        <span class="inv-title">${title}</span>
        ${headerExtra}
        <button class="inv-close" data-action="close-modal">✕</button>
      </div>
      <div class="modal-tabs">${tabBar}</div>
      <div class="modal-tab-body">${body}</div>
      <div class="inv-foot">Press Esc to close</div>
    </div>`;
  // Backdrop click closes.
  root.addEventListener("click", (e) => {
    if (e.target === root) setModalTab(null);
  });
  document.body.appendChild(root);
}

// --- Sidebar updates ---

function updateSidebar(): void {
  // The dungeon-mode sidebar (turns, kills, "submit results") only makes
  // sense when we're in an actual channel session.  When dungeon mode is
  // rendering the hub, use the overworld sidebar so the player still has
  // their stats, inventory, and stat-point/potion buttons.
  if (mode === "overworld" || !channelSession) {
    updateOverworldStats();
    updateOverworldInventory();
    updateOverworldMessages();
  } else {
    updateDungeonStats();
    updateDungeonInventory();
    updateDungeonMessages();
  }
  // Keep the unified game modal (if open) in sync with state polls.
  if (activeModalTab) renderGameModal();
}

// --- Overworld sidebar ---

function updateOverworldStats(): void {
  const el = document.getElementById("stats-display")!;
  const p = connState?.player;
  const isConnected = connState?.status === "connected";
  const hasProxy = !!moves;

  if (!isConnected) {
    el.innerHTML = '<div style="color:#666">Connect to a GSP to view player info.</div>';
    return;
  }

  if (!p) {
    el.innerHTML = `
      <div style="color:#888">Player "${connState?.playerName}" not found.</div>
      ${hasProxy ? `<button data-action="register" class="action-btn" ${busy ? "disabled" : ""}>
        Register Player
      </button>` : ""}`;
    return;
  }

  const hpPct = Math.max(0, p.hp / p.max_hp * 100);
  const hpColor = hpPct > 60 ? "#4a4" : hpPct > 30 ? "#aa4" : "#c44";

  // Location readout: the segment the player is actually in (the visit's
  // segment while in a channel) plus its world coordinates, so the
  // sidebar agrees with the map and tile view.
  const locSeg = playerLocationSegment(p);
  const locInfo = connState?.segments.get(locSeg);
  const locCoord = locSeg === 0 ? "(0, 0)"
    : locInfo ? `(${locInfo.world_x}, ${locInfo.world_y})` : "(?, ?)";
  const locLabel = `${locCoord}${p.in_channel ? " · in dungeon" : ""}`;

  let selectedInfo = "";
  if (selectedSegment !== null) {
    const selNode = overworldNodes.get(selectedSegment);
    const isAdjacentDir = areLinked(overworldNodes, p.current_segment, selectedSegment);
    const isCurrent = selectedSegment === p.current_segment;

    const selCoord = selectedSegment === 0 ? "(0, 0)"
      : selNode ? `(${selNode.worldX}, ${selNode.worldY})` : `(?, ?)`;
    selectedInfo = `<div style="margin-top:8px;border-top:1px solid #333;padding-top:8px">`;
    selectedInfo += `<div style="color:#aaf;font-weight:bold">${selCoord}</div>`;

    if (selNode) {
      selectedInfo += `<div class="stat-row"><span class="stat-label">Depth</span><span class="stat-value">${selNode.depth}</span></div>`;
      if (selNode.discoverer) {
        selectedInfo += `<div class="stat-row"><span class="stat-label">By</span><span class="stat-value">${selNode.discoverer}</span></div>`;
      }
    }

    if (isCurrent && selectedSegment !== 0 && !p.in_channel) {
      selectedInfo += `<button data-action="enter-channel" data-segment="${selectedSegment}"
        class="action-btn action-enter" ${busy ? "disabled" : ""}>Enter Dungeon</button>`;
    }

    if (isAdjacentDir && !isCurrent && !p.in_channel) {
      selectedInfo += `<button data-action="travel" data-dir="${isAdjacentDir}"
        class="action-btn action-travel" ${busy ? "disabled" : ""}>Travel ${isAdjacentDir}</button>`;
    }

    selectedInfo += `</div>`;
  }

  // Discover buttons for directions without links from current segment.
  let discoverBtns = "";
  if (!p.in_channel && hasProxy) {
    const curNode = overworldNodes.get(p.current_segment);
    const dirs = ["north", "east", "south", "west"];
    const openDirs = dirs.filter(d => !curNode?.links[d]);
    const cooldown = discoveryCooldownRemaining(p, connState?.currentHeight ?? 0);
    if (openDirs.length > 0) {
      if (cooldown > 0) {
        discoverBtns = `<div style="margin-top:6px;font-size:11px;color:#c86">Discovery on cooldown \u2014 ${cooldown} block${cooldown === 1 ? "" : "s"} left</div>`;
        discoverBtns += openDirs.map(d =>
          `<button class="action-btn action-discover" disabled>${d}</button>`
        ).join(" ");
      } else {
        discoverBtns = `<div style="margin-top:6px;font-size:11px;color:#888">Discover:</div>`;
        discoverBtns += openDirs.map(d =>
          `<button data-action="discover" data-dir="${d}" class="action-btn action-discover" ${busy ? "disabled" : ""}>${d}</button>`
        ).join(" ");
      }
    }
  }

  // Stat-point allocation (shown when player has points to spend).
  let statBtns = "";
  if (p.stat_points > 0 && !p.in_channel && hasProxy) {
    statBtns = `
      <div style="margin-top:6px;font-size:11px;color:#8c8">
        ${p.stat_points} stat point${p.stat_points === 1 ? "" : "s"} to spend:
      </div>
      <div>
        <button data-action="allocate-stat" data-stat="strength"     class="action-btn" ${busy ? "disabled" : ""}>+STR</button>
        <button data-action="allocate-stat" data-stat="dexterity"    class="action-btn" ${busy ? "disabled" : ""}>+DEX</button>
        <button data-action="allocate-stat" data-stat="constitution" class="action-btn" ${busy ? "disabled" : ""}>+CON</button>
        <button data-action="allocate-stat" data-stat="intelligence" class="action-btn" ${busy ? "disabled" : ""}>+INT</button>
      </div>`;
  }

  // Overworld potion-use button (shown when HP < max and player has potions).
  let potionBtn = "";
  if (!p.in_channel && hasProxy && p.hp < p.max_hp) {
    const potion = p.inventory.find(
      i => i.slot === "bag"
        && (i.item_id === "health_potion" || i.item_id === "greater_health_potion")
        && i.quantity > 0,
    );
    if (potion) {
      const def = lookupItem(potion.item_id);
      const heal = def?.healAmount ?? 0;
      potionBtn = `<button data-action="use-item" data-item="${potion.item_id}"
        class="action-btn action-travel" ${busy ? "disabled" : ""}>
        Use ${def?.name ?? potion.item_id}${heal > 0 ? ` (+${heal} HP)` : ""}
        \u00d7${potion.quantity}
      </button>`;
    }
  }

  el.innerHTML = `
    <div><strong>${p.name}</strong> \u2014 Level ${p.level}</div>
    <div class="hp-bar">
      <div class="hp-bar-fill" style="width:${hpPct}%; background:${hpColor}"></div>
      <div class="hp-bar-text">HP ${p.hp} / ${p.max_hp}</div>
    </div>
    <div class="stat-row"><span class="stat-label">XP</span><span class="stat-value">${p.xp}</span></div>
    <div class="stat-row"><span class="stat-label">Gold</span><span class="stat-value">${p.gold}</span></div>
    <div class="stat-row"><span class="stat-label">Location</span><span class="stat-value">${locLabel}</span></div>
    <div style="margin-top:6px;color:#888;font-size:11px">
      STR ${p.stats.strength} DEX ${p.stats.dexterity}
      CON ${p.stats.constitution} INT ${p.stats.intelligence}
    </div>
    <div style="color:#888;font-size:11px">
      ATK ${p.effective_stats.attack_power} DEF ${p.effective_stats.defense}
    </div>
    <div style="color:#888;font-size:11px">
      K:${p.combat_record.kills} D:${p.combat_record.deaths} V:${p.combat_record.visits_completed}
    </div>
    ${statBtns}
    ${potionBtn}
    ${discoverBtns}
    ${selectedInfo}
    ${busy ? '<div style="margin-top:6px;color:#aa8">Processing...</div>' : ""}
  `;
}

function updateOverworldInventory(): void {
  const el = document.getElementById("inventory-display")!;
  const p = connState?.player;
  const canMutate = !!moves && !p?.in_channel;

  if (!p || p.inventory.length === 0) {
    el.innerHTML = '<div style="color:#666">Empty</div>';
    return;
  }

  el.innerHTML = p.inventory.map(item => {
    const slotClass = item.slot === "bag" ? "slot-bag" : "slot-equipped";
    const slotLabel = item.slot === "bag" ? "" : `[${item.slot}]`;
    const def = lookupItem(item.item_id);
    const isEquipable = def && def.slot !== "" && def.type !== "potion"
        && def.type !== "misc";
    const isPotion = def && def.type === "potion";

    let btn = "";
    if (canMutate && item.slot === "bag" && isEquipable) {
      btn = `<button data-action="equip" data-rowid="${item.rowid}"
        data-slot="${def!.slot}" class="inv-btn"
        ${busy ? "disabled" : ""}>Equip</button>`;
    } else if (canMutate && item.slot === "bag" && isPotion) {
      btn = `<button data-action="use-item" data-item="${item.item_id}"
        class="inv-btn"
        ${busy ? "disabled" : ""}>Drink</button>`;
    } else if (canMutate && item.slot !== "bag") {
      btn = `<button data-action="unequip" data-rowid="${item.rowid}"
        class="inv-btn"
        ${busy ? "disabled" : ""}>Unequip</button>`;
    }

    return `<div class="inventory-item">
      <span>${item.item_id} x${item.quantity}</span>
      <span class="${slotClass}">${slotLabel}</span>
      ${btn}
    </div>`;
  }).join("");
}

function updateOverworldMessages(): void {
  const el = document.getElementById("message-log")!;
  const fs = connState?.fullState;

  const lines: string[] = [];

  if (fs) {
    if (fs.dungeon_id) {
      lines.push(`<div class="msg-info">World: ${fs.dungeon_id}</div>`);
    }
    lines.push(`<div class="msg-info">Players: ${fs.players.length} | Segments: ${fs.segments.length}</div>`);

    for (const pl of fs.players) {
      if (pl.name === connState?.playerName) continue;
      lines.push(`<div class="msg-info">${pl.name} (Lv${pl.level}) @ seg ${pl.current_segment}</div>`);
    }
  }

  // Action messages.
  for (const msg of overworldMessages.slice(-10)) {
    lines.push(`<div class="msg-${msg.type}">${msg.text}</div>`);
  }

  el.innerHTML = lines.length > 0 ? lines.join("") : '<div style="color:#666">Not connected.</div>';
  el.scrollTop = el.scrollHeight;
}

// --- Dungeon sidebar ---

function updateDungeonStats(): void {
  const el = document.getElementById("stats-display")!;

  if (!session) {
    el.innerHTML = `
      <div style="color:#888">No dungeon active.</div>
      <div style="margin-top:8px;font-size:11px;color:#888">
        Press N to start a new dungeon.
      </div>`;
    return;
  }

  const hpPct = Math.max(0, session.playerHp / session.playerMaxHp * 100);
  const hpColor = hpPct > 60 ? "#4a4" : hpPct > 30 ? "#aa4" : "#c44";

  let channelLabel = "";
  if (channelSession) {
    const segInfo = connState?.segments.get(channelSegmentId);
    const coord = channelSegmentId === 0 ? "(0, 0)"
      : segInfo ? `(${segInfo.world_x}, ${segInfo.world_y})` : "(?, ?)";
    channelLabel = `<div style="color:#aaf;font-size:11px">${coord}</div>`;
  }

  let endButtons = "";
  if (session.gameOver) {
    if (channelSession) {
      // Survival exits are auto-settled by gw when the player walks
      // onto the gate.  Only deaths need a manual submit (gw refuses
      // survived=false; xc applies the death penalty).
      if (!session.survived) {
        endButtons = `
          <button data-action="exit-channel" class="action-btn action-enter" ${busy ? "disabled" : ""}>
            Respawn at Hub
          </button>`;
      } else {
        endButtons = `<div style="margin-top:6px;color:#888;font-size:11px">Settling on-chain...</div>`;
      }
    } else {
      endButtons = `
        <button data-action="restart" class="action-btn">New Dungeon</button>`;
    }
  }

  el.innerHTML = `
    ${channelLabel}
    <div>Turn: ${session.turnCount}</div>
    <div class="hp-bar">
      <div class="hp-bar-fill" style="width:${hpPct}%; background:${hpColor}"></div>
      <div class="hp-bar-text">HP ${session.playerHp} / ${session.playerMaxHp}</div>
    </div>
    <div>XP: ${session.totalXp} &nbsp; Gold: ${session.totalGold}</div>
    <div>Kills: ${session.totalKills} &nbsp; Depth: ${session.depth}</div>
    ${session.gameOver
      ? `<div style="margin-top:8px;color:${session.survived ? '#4a4' : '#c44'};font-weight:bold">
           ${session.survived ? 'SURVIVED \u2014 Exited ' + session.exitGate : 'YOU DIED'}
         </div>${endButtons}`
      : ''}
    ${busy ? '<div style="margin-top:6px;color:#aa8">Submitting...</div>' : ""}
    <div style="margin-top:8px;font-size:11px;color:#888">
      WASD/Arrows: Move &nbsp; G: Pickup<br>
      P: Potion &nbsp; Space: Wait &nbsp; Enter: Gate
      ${!channelSession ? "<br>N: New Dungeon" : ""}
    </div>
  `;
}

function updateDungeonInventory(): void {
  const el = document.getElementById("inventory-display")!;
  const p = connState?.player;

  // Show the player's real (on-chain) inventory here too, so the panel is
  // consistent with the hub.  Items found this run are listed separately
  // as pending (they settle only on a winning exit).  Full management is
  // in the modal (I), which is read-only while in a dungeon.
  const lines: string[] = [];
  if (p && p.inventory.length > 0) {
    for (const it of p.inventory) {
      const slot = it.slot === "bag" ? "" : ` [${it.slot}]`;
      const qty = it.quantity > 1 ? ` x${it.quantity}` : "";
      lines.push(`<div class="inventory-item"><span>${itemIcon(it.item_id)} ${itemName(it.item_id)}${qty}</span><span class="slot-equipped">${slot}</span></div>`);
    }
  } else {
    lines.push('<div style="color:#666">Empty</div>');
  }

  const pending = session ? session.collected.filter(l => l.quantity > 0) : [];
  if (pending.length > 0) {
    lines.push('<div style="margin-top:6px;color:#c9b24a;font-size:11px">Collected this run (pending):</div>');
    for (const l of pending) {
      lines.push(`<div class="inventory-item" style="opacity:0.85"><span>${itemIcon(l.itemId)} ${itemName(l.itemId)}${l.quantity > 1 ? ` x${l.quantity}` : ""}</span></div>`);
    }
  }

  el.innerHTML = lines.join("");
}

function updateDungeonMessages(): void {
  const el = document.getElementById("message-log")!;

  if (!session) {
    el.innerHTML = "";
    return;
  }

  const recent = session.messages.slice(-8);
  el.innerHTML = recent.map(m =>
    `<div class="msg-${m.type}">${m.text}</div>`
  ).join("");
  el.scrollTop = el.scrollHeight;
}

// --- E2E / headless debug hook ---

// Enabled only with ?e2e=1 in the URL, so it's absent in normal play and
// on the hosted demo.  Exposes read-only state plus the real orchestration
// actions (the same functions the UI buttons/keys call), so a Playwright
// driver exercises the actual code paths instead of scraping the canvas.
// Rejections still surface as modals (#modal-root), which the driver reads.
if (typeof location !== "undefined"
    && new URLSearchParams(location.search).has("e2e")) {
  (globalThis as unknown as { __rog: unknown }).__rog = {
    state: () => ({
      status: connState?.status ?? "disconnected",
      mode,
      busy,
      channelSession,
      height: connState?.currentHeight ?? null,
      player: connState?.player ?? null,
      session: session ? {
        playerX: session.playerX,
        playerY: session.playerY,
        hp: session.playerHp,
        maxHp: session.playerMaxHp,
        survived: session.survived,
        gameOver: session.gameOver,
        gates: session.dungeon.gates,
        tileAtPlayer: session.dungeon.getTile(session.playerX, session.playerY),
        monsters: session.monsters.filter(m => m.alive)
          .map(m => ({ x: m.x, y: m.y, hp: m.hp, attack: m.attack })),
        groundItems: session.groundItems
          .map(g => ({ x: g.x, y: g.y, item: g.itemId })),
      } : null,
      segments: connState?.segments
        ? Array.from(connState.segments.values()).map(s => ({
            id: s.id, confirmed: s.confirmed,
            world_x: s.world_x, world_y: s.world_y,
            links: s.links, gates: s.gates,
          }))
        : [],
      modal: document.getElementById("modal-root")?.textContent ?? null,
    }),
    // Static wall grid for pathfinding (call once per session).
    map: () => {
      if (!session) return null;
      const d = session.dungeon;
      const walls: boolean[][] = [];
      for (let y = 0; y < HEIGHT; y++) {
        const row: boolean[] = [];
        for (let x = 0; x < WIDTH; x++) row.push(d.getTile(x, y) === 0);
        walls.push(row);
      }
      return { width: WIDTH, height: HEIGHT, walls };
    },
    connect: (name: string, gsp?: string) => {
      if (gsp) gspUrlInput.value = gsp;
      playerNameInput.value = name;
      connectBtn.click();
    },
    register: () => doRegister(),
    travel: (dir: string) => doTravel(dir),
    discover: (dir: string) => doDiscover(dir),
    enterChannel: (id: number) => doEnterChannel(id),
    exitChannel: () => doExitChannel(),
    gateWalk: (dir: string) => doGateWalk(dir),
    forfeit: (visitId: number) => doForfeitVisit(visitId),
    // Dungeon-level control: drives the same path as the keyboard.
    input: (action: string, dx?: number, dy?: number) =>
      handleGameInput(action,
        (dx !== undefined || dy !== undefined)
          ? { dx: dx ?? 0, dy: dy ?? 0 } : undefined),
    // Inventory management.
    equip: (rowid: number, slot: string) => doEquip(rowid, slot),
    unequip: (rowid: number) => doUnequip(rowid),
    useItem: (item: string) => doUseItem(item),
    discard: (rowid: number) => doDiscard(rowid),
    allocateStat: (stat: string) => doAllocateStat(stat),
    dismissModal: () => document.querySelector<HTMLElement>(".modal-dismiss")?.click(),
    // Overworld map view transform, for pan/zoom tests.
    mapView: () => ({ panX, panY, zoom, mapFollow, selectedSegment }),
    recenter: () => recenterMap(),
  };
}

// --- Start ---

setMode("dungeon");
