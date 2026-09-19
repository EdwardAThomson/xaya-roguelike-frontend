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
import { DungeonSession, GameAction, PlayerSetup, PlayerState } from "./game/session.js";
import {
  settleLogHash, toWireAction, toWireResults, computeClaims,
  encodeCompactActions, encodeCompactLog,
} from "./game/settle.js";
import { LoggedAction } from "./game/session.js";
import { CoopRunner, ProxyRelayTransport } from "./net/coop.js";
import { PlayerStats } from "./game/combat.js";
import { Camera } from "./render/camera.js";
import { TILE_SIZE, drawTile, initSprites } from "./render/tiles.js";
import { drawMonsters, drawGroundItems, drawPlayer, drawPartner } from "./render/entities.js";
import { InputHandler, Direction, isEditableTarget } from "./game/input.js";
import { FovMap } from "./render/fov.js";
import { Connection, ConnectionState } from "./net/connection.js";
import { PlayerInfo, SegmentInfo, SegmentRef, VisitInfo, VisitSummary,
  segKey, sameSeg, isHub, HUB } from "./net/rpc.js";
import { Gate } from "./game/dungeon.js";
import { MoveClient, createMoveClient, Settlement } from "./net/moves.js";
import { layoutSegments, SegmentNode, hitTestSegment } from "./game/overworld.js";
import { drawOverworld, NODE_SIZE, CELL, PlayerMarker, OverworldView } from "./render/overworld.js";
import { drawDungeonMap } from "./render/dungeonmap.js";
import {
  DEFAULT_GSP_URL, DEFAULT_PROXY_URL, isHostedOrigin,
  ABANDON_WINDOW_BLOCKS, COOP_CHECKPOINT_ACTIONS, COOP_HEARTBEAT_MS,
  COMPACT_ACTIONS,
} from "./config.js";

/** A solo action proof for xc / gw: compact string or the JSON array. */
function soloProof(actions: GameAction[]): object[] | string {
  if (COMPACT_ACTIONS) return encodeCompactActions(actions);
  return actions.map(a => {
    if (a.type === "use") return { type: "use", item: a.itemId };
    if (a.type === "equip") return { type: "equip", rowid: a.rowid, slot: a.slot };
    if (a.type === "unequip") return { type: "unequip", rowid: a.rowid };
    return a;
  });
}

/** A merged-log proof for the multiplayer `s` move. */
function mergedProof(log: LoggedAction[]): object[] | string {
  return COMPACT_ACTIONS ? encodeCompactLog(log, true) : log.map(toWireAction);
}
import {
  ValidatorContext, ValidationResult,
  validateDiscover, validateTravel, validateEnterChannel,
  validateUseItem, validateAllocateStat, validateEquip, validateUnequip,
  validateDiscard,
  validateGateWalk,
  discoveryCooldownRemaining, neighbour, segName,
} from "./net/validator.js";
import { waitForMove, MoveOutcome } from "./net/pending.js";
import { showErrorModal, showModal, showConfirmModal, showChoiceModal, showAmountModal } from "./ui/modal.js";
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

// Map-view tab switcher (World / Dungeon).  The Map view is a single canvas
// with two sub-views: the overworld segment graph ("World", with pan/zoom)
// and a fit-to-frame minimap of the current dungeon session ("Dungeon").
// Injected into the game area (index.html isn't edited); shown only while the
// Map view is active, via setMode()/setMapTab().
const mapTabBar = document.createElement("div");
mapTabBar.id = "map-tab-bar";
mapTabBar.style.cssText =
  "position:absolute; top:8px; left:50%; transform:translateX(-50%); "
  + "display:none; gap:6px; z-index:5;";
const mapTabWorldBtn = document.createElement("button");
mapTabWorldBtn.className = "mode-btn active";
mapTabWorldBtn.textContent = "World";
mapTabWorldBtn.dataset.action = "map-tab-world";
mapTabWorldBtn.title = "Show the overworld segment map";
const mapTabDungeonBtn = document.createElement("button");
mapTabDungeonBtn.className = "mode-btn";
mapTabDungeonBtn.textContent = "Dungeon";
mapTabDungeonBtn.dataset.action = "map-tab-dungeon";
mapTabDungeonBtn.title = "Show the current dungeon's layout";
mapTabBar.append(mapTabWorldBtn, mapTabDungeonBtn);
document.getElementById("game-area")?.appendChild(mapTabBar);

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
let channelSegment: SegmentRef = HUB;
let channelVisitId = -1;
/** Snapshot of player.segment the last time we built a hub session,
 *  so we know to rebuild if it changes (e.g. on death respawn). */
let hubBuiltAtHub = false;
/** True while the reconnect-mid-channel modal is on screen; prevents
 *  it being shown again on every poll. */
let reconnectPromptShown = false;

// Co-op (multiplayer visit) state.  A co-op visit shows up on chain as
// `active_visit` WITHOUT `in_channel` (solo `ec` runs set in_channel); the
// run itself is driven by the CoopRunner over the relay transport.
let coop: CoopRunner | null = null;
/** Latest getvisitinfo for our open/active co-op visit (lobby + settle). */
let coopVisit: VisitInfo | null = null;
let coopSyncInFlight = false;
let coopSettling = false;
let coopSettleError: string | null = null;
/** Everything needed to rebuild the shared session at a checkpoint. */
let coopSetup: { seed: string; depth: number; constraints: Gate[];
                 setups: PlayerSetup[]; names: string[]; me: number;
                 /** The visit id when this run is a DUEL, null for co-op:
                     rebuilding after an abandonment has to use the same
                     engine, and a duel's needs the id for its
                     commitments. */
                 duelVisitId: number | null } | null = null;
/**
 * Solo continuation after abandoning a partner (spec section 11): the run
 * was rebuilt at the partner's last checkpoint (`from` actions), the
 * partner marked absent, and this client plays on alone until it settles
 * with `solo_from`.
 */
let coopSolo: { visitId: number; names: string[]; me: number; from: number } | null = null;
/** Checkpoint bookkeeping (see maybeCheckpoint). */
let coopCheckpointN = -1;
let coopCheckpointAt = 0;
let coopCheckpointInFlight = false;
let coopCheckpointTimer: ReturnType<typeof setInterval> | null = null;

/** The local player's participant state (participant 0 outside co-op). */
function me(): PlayerState {
  return session!.players[coop ? coop.me : coopSolo ? coopSolo.me : 0];
}

// Overworld mode state.
/** Which sub-view of the Map is showing: the World graph or the Dungeon
 *  minimap.  Only meaningful while `mode === "overworld"`. */
type MapTab = "world" | "dungeon";
let mapTab: MapTab = "world";
let overworldNodes: Map<string, SegmentNode> = new Map();
let connState: ConnectionState | null = null;
let selectedSegment: SegmentRef | null = null;

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
let followSeg: SegmentRef = HUB;

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

/**
 * The rules version this build implements (backend rules.hpp).  Bumped in
 * lockstep with RULES_VERSION there whenever anything the REPLAY depends on
 * changes: a draw, an action, a seed derivation, an encoding, the duel
 * commitment preimage.
 */
const CLIENT_RULES_VERSION = 1;
/** What settlement awards; see BANKING_VERSION in rules.hpp.
 *  2: asymmetric duel stakes (the host posts a floor, each side escrows its
 *  own amount, the pot is the sum, a void refunds each exactly what they
 *  put in).  This client sends and displays those, so it is a 2. */
const CLIENT_BANKING_VERSION = 2;

/**
 * Null while the versions agree (or the GSP is too old to say), otherwise
 * why this client must not start a run.  A rules mismatch means the run
 * played here would be REJECTED at settlement -- after the player had
 * played the whole thing, with the reason only in a GSP log line -- so it
 * has to be caught before anyone starts one.  A banking mismatch is not
 * grounds to block play: the engine still agrees, only the projected
 * rewards in the HUD would be wrong.
 */
let rulesMismatch: string | null = null;
let bankingMismatch = false;
let versionWarned = false;

function checkVersionHandshake(state: ConnectionState): void {
  const v = state.fullState?.version;
  if (!v) return;                       // GSP predates the handshake
  rulesMismatch = v.rules === CLIENT_RULES_VERSION ? null
    : `This client implements rules version ${CLIENT_RULES_VERSION}; the ` +
      `server is running version ${v.rules}. A run played here would be ` +
      `rejected when you tried to settle it, so starting one is disabled. ` +
      `Reload to pick up a newer client.`;
  bankingMismatch = v.banking !== CLIENT_BANKING_VERSION;
  if (!versionWarned && (rulesMismatch || bankingMismatch)) {
    versionWarned = true;
    if (rulesMismatch) showErrorModal("Client out of date", rulesMismatch);
    else addOverworldMessage(
      "This client and the server disagree about reward rules; projected " +
      "XP and gold may not match what you are actually awarded.", "warning");
  }
}

const connection = new Connection((state: ConnectionState) => {
  connState = state;
  checkVersionHandshake(state);
  updateConnectionUI();
  rebuildOverworld();
  ensureSessionFromChainState();
  void syncCoopFromChain();
  render();
  updateSidebar();
});

// --- In-progress run persistence -------------------------------------------
// A dungeon run's state (position, HP, loot, kills) lives only in the client
// until it settles at a gate.  Persist the action log so a page reload restores
// the EXACT run by deterministic replay (the same thing the GSP does to verify
// it), instead of forcing a replay-from-scratch or a forfeit (which reads to
// the player as a death).  One active run at a time, keyed by player name.
function runStorageKey(): string | null {
  const name = connState?.playerName;
  return name ? `rog_run:${name}` : null;
}
function persistRun(): void {
  const key = runStorageKey();
  if (!key || !channelSession || !session || coop || coopSolo) return;
  try {
    localStorage.setItem(key, JSON.stringify({
      visitId: channelVisitId,
      seg: channelSegment,
      actions: session.actionLog,
    }));
  } catch { /* storage disabled/full: reconnect prompt is the fallback */ }
}
function clearPersistedRun(): void {
  const key = runStorageKey();
  if (!key) return;
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
function loadPersistedRun(visitId: number): GameAction[] | null {
  const key = runStorageKey();
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data && data.visitId === visitId && Array.isArray(data.actions)) {
      return data.actions as GameAction[];
    }
  } catch { /* corrupt entry: ignore */ }
  return null;
}
// Rebuild the run from on-chain entry state, then deterministically replay the
// saved action log to reproduce the exact pre-reload state.  In its own
// function so `session` is not stale-narrowed by the caller's earlier guards.
function restoreRunFromLog(
  seed: string, depth: number, seg: SegmentRef, visitId: number,
  constraints: Gate[], entryDirection: string, savedActions: GameAction[],
): void {
  startChannelDungeon(seed, depth, seg, visitId, constraints, entryDirection);
  if (session && fov) {
    for (const a of savedActions) session.processAction(a);
    fov.update(me().x, me().y, session.dungeon);
    camera.centerOn(me().x, me().y);
    render();
    updateSidebar();
    persistRun();
  }
  addOverworldMessage("Resumed your dungeon run where you left off.", "info");
}

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
  // Co-op runs are reconciled by syncCoopFromChain (they are not in_channel).
  if (coop || coopSolo) return;

  // A live run can end server-side without the client acting: the 200-block
  // visit timeout force-settles it (a death), or a death/force-settle is
  // applied off-client.  Detect that our in-progress run is no longer the
  // one the chain shows (not in a channel, or a different visit) and re-sync
  // instead of leaving a stale dungeon on screen.  (busy is already excluded
  // above, so this never fires mid gate-walk / settle that we drive ourselves.)
  if (channelSession && session
      && (!p.in_channel || !p.active_visit
          || p.active_visit.visit_id !== channelVisitId)) {
    const knockedBack = resumeAfterSettle();
    if (!knockedBack) ensureHubSessionIfAtHub();
    addOverworldMessage(
      "Your previous run ended; synced to your current location.",
      "info",
    );
    render();
    return;
  }

  if (channelSession || session) return;  // already have something

  if (p.in_channel && p.active_visit) {
    const segId = p.active_visit.segment;
    const visitId = p.active_visit.visit_id;
    const segInfo = connState!.segments.get(segKey(segId));
    if (!segInfo) {
      // Segment cache not populated yet; the next poll will retry.
      return;
    }

    // Restore the exact in-progress run from local storage if we saved it: a
    // reload otherwise loses all client-side progress.  Rebuild from the same
    // on-chain entry state and deterministically replay the saved action log,
    // reproducing position / HP / loot / kills.  No modal, no death.
    const savedActions = loadPersistedRun(visitId);
    if (savedActions) {
      restoreRunFromLog(segInfo.seed, segInfo.depth, segId, visitId,
                        constraintsFor(segInfo),
                        p.active_visit.entry_direction, savedActions);
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
  seed: string, depth: number, seg: SegmentRef, visitId: number,
  isProvisional: boolean, constraints: Gate[], entryDirection: string,
): void {
  const forfeitDetail = isProvisional
    ? "Take the death now (half HP, 25% gold), knocked back one segment (or to the hub if this was your first dive).  This segment is provisional and will be deleted, so you'll have to re-discover it."
    : "Take the death now (half HP, 25% gold), knocked back one segment (or to the hub if this was your first dive).  The segment stays available for future visits.";

  showConfirmModal({
    title: "You were in a dungeon when you disconnected",
    message:
      `Active visit on ${segName(seg)} (depth ${depth}).  Your local progress from before is lost.\n\n` +
      `Continue: replay the dungeon from scratch (it's deterministic, ` +
      `so it's the same layout).  You have until the 200-block visit ` +
      `timeout to settle.\n\n` +
      `Forfeit: ${forfeitDetail}`,
    confirmLabel: "Continue",
    cancelLabel: "Forfeit",
    dismissibleByEscape: false,
    onConfirm: () => {
      reconnectPromptShown = false;
      startChannelDungeon(seed, depth, seg, visitId,
                          constraints, entryDirection);
      addOverworldMessage(
        `Replaying the dungeon at ${segName(seg)} from scratch.`,
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
    const outcome = await waitForMove(connection, ({ player }) => {
      if (!player) return false;
      if (!player.in_channel) return true;
      return !!player.active_visit && player.active_visit.visit_id !== visitId;
    });
    if (outcome === "applied") {
      const knockedBack = resumeAfterSettle();
      addOverworldMessage(
        knockedBack
          ? "Forfeited. Knocked back to the segment you came from."
          : "Forfeited dungeon. Respawned at the hub.",
        "combat",
      );
      if (!knockedBack && !session) ensureHubSessionIfAtHub();
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
 * After a settle or forfeit resolves, tear down the finished run.  If the GSP
 * knocked us back into the previous segment (a deep death now lands you one
 * segment back, not at the hub), start that run; otherwise we are at the hub
 * (first-dive death or a survived exit) and the hub builder takes over.
 * Returns true if it started a knock-back run.
 */
function resumeAfterSettle(): boolean {
  channelSession = false;
  session = null;
  fov = null;
  hubBuiltAtHub = false;
  clearPersistedRun();
  const p = connState?.player;
  if (p && p.in_channel && p.active_visit) {
    const segId = p.active_visit.segment;
    const segInfo = connState?.segments.get(segKey(segId));
    if (segInfo) {
      startChannelDungeon(segInfo.seed, segInfo.depth, segId,
                          p.active_visit.visit_id, constraintsFor(segInfo),
                          p.active_visit.entry_direction);
      return true;
    }
  }
  return false;
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

// Fog is also written through to localStorage (keyed by segment seed) so the
// map you have uncovered survives a page reload, not just the current tab.
let currentFogKey: string | null = null;

function fogStorageKey(key: string): string { return `rog_fog:${key}`; }

function persistentExplored(key: string): Set<number> {
  let s = exploredByKey.get(key);
  if (!s) {
    s = new Set<number>();
    try {
      const raw = localStorage.getItem(fogStorageKey(key));
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) for (const n of arr) s.add(n);
      }
    } catch { /* corrupt / disabled: start with an empty map */ }
    exploredByKey.set(key, s);
  }
  return s;
}

/** Persist the currently-shown segment's explored tiles to localStorage. */
function saveCurrentFog(): void {
  if (!currentFogKey) return;
  const s = exploredByKey.get(currentFogKey);
  if (!s) return;
  try {
    localStorage.setItem(fogStorageKey(currentFogKey), JSON.stringify([...s]));
  } catch { /* storage full/disabled: fog just will not persist */ }
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
  if (!isHub(p.segment)) return;

  if (hubBuiltAtHub && session !== null) return;  // already built

  // Reached the hub: any in-progress run is over, so drop its saved state.
  clearPersistedRun();

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
  currentFogKey = "hub";
  fov.explored = persistentExplored("hub");
  fov.update(me().x, me().y, session.dungeon);
  camera.centerOn(me().x, me().y);
  hubBuiltAtHub = true;
}

gspUrlInput.value = DEFAULT_GSP_URL;

// On a hosted deploy the GSP endpoint is fixed and same-origin (config.ts
// resolves it), so the manual GSP box is redundant and a footgun (a player
// could point it at a dead localhost). Hide it there; the input keeps its
// resolved value so the connect flow still reads a valid URL. Local dev
// keeps the box visible for pointing at an arbitrary devnet. The ?gsp=
// override still works either way (it flows through DEFAULT_GSP_URL).
if (isHostedOrigin()) {
  document.getElementById("gsp-connection")?.classList.add("hidden");
  // On the hosted demo the connection endpoint is fixed, so the raw
  // name + Connect controls are replaced by the account picker (Play -> choose
  // or create a character). Keep them in the DOM (hidden) so the e2e hook,
  // which drives them directly, still works on localhost builds.
  document.getElementById("player-label")?.classList.add("hidden");
  playerNameInput.classList.add("hidden");
  connectBtn.classList.add("hidden");
  const accountBtn = document.getElementById("account-btn");
  accountBtn?.classList.remove("hidden");
  accountBtn?.addEventListener("click", () => showAccountPicker());
}

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
  // Hosted: go straight into the account picker. Dev/e2e: keep the topbar
  // focus behaviour (the e2e driver clicks Play, then drives via __rog).
  // `?picker=1` forces the picker on a localhost build so the hosted flow can
  // be tested locally against the devnet (endpoints stay the local ports).
  const forcePicker = new URLSearchParams(location.search).has("picker");
  if (isHostedOrigin() || forcePicker) showAccountPicker();
  else playerNameInput.focus();
});

connectBtn.addEventListener("click", () => {
  if (connState?.status === "connected" || connState?.status === "connecting") {
    connection.disconnect();
    moves = null;
    session = null;
    fov = null;
    channelSession = false;
    hubBuiltAtHub = false;
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

// --- Account picker (Play -> choose or create a character) -----------------
// On the hosted demo the raw name + Connect topbar controls are hidden in
// favour of this modal. It lists the characters this browser has already
// registered (from the claim-token localStorage keys) and offers a
// "new character" form. Selecting or creating one connects, registering
// on-chain if the name has no player yet (covers brand-new names and ones
// whose on-chain state was wiped by a sandbox reset).

const CLAIM_PREFIX = "rog:claim:";

function listSavedAccounts(): string[] {
  const names: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CLAIM_PREFIX)) names.push(k.slice(CLAIM_PREFIX.length));
    }
  } catch { /* storage unavailable */ }
  return names.sort((a, b) => a.localeCompare(b));
}

async function enterAsPlayer(name: string): Promise<void> {
  hideLanding();
  const url = gspUrlInput.value.trim() || DEFAULT_GSP_URL;
  moves = createMoveClient({ proxyUrl: DEFAULT_PROXY_URL });
  playerNameInput.value = name; // keep the topbar + e2e hook in sync
  await connection.connect(url, name);
  if (connState?.status === "connected" && !connState.player) {
    await doRegister();
  }
}

function showAccountPicker(): void {
  document.getElementById("account-modal-root")?.remove();
  const accounts = listSavedAccounts();
  const connectedName = connState?.status === "connected" ? connState.playerName : "";

  const root = document.createElement("div");
  root.id = "account-modal-root";
  root.className = "modal-overlay";
  root.innerHTML = `
    <div class="modal modal-info account-modal" role="dialog" aria-modal="true">
      <div class="modal-title">Choose your character</div>
      <div class="account-list"></div>
      <div class="account-new">
        <div class="account-new-label">New character</div>
        <div class="account-new-row">
          <input id="account-new-name" type="text" placeholder="character name"
                 spellcheck="false" autocomplete="off" maxlength="32">
          <button id="account-create" class="modal-dismiss modal-confirm">Create</button>
        </div>
        <div class="account-hint">Claimed by this browser for the session.</div>
      </div>
      <div class="account-foot"></div>
    </div>`;

  const close = (): void => {
    root.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
  };

  // Saved-character list (textContent avoids any escaping concerns).
  const list = root.querySelector(".account-list")!;
  if (accounts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "account-empty";
    empty.textContent = "No characters on this device yet. Create one below.";
    list.appendChild(empty);
  } else {
    for (const n of accounts) {
      const btn = document.createElement("button");
      btn.className = "account-item";
      const nameEl = document.createElement("span");
      nameEl.className = "account-name";
      nameEl.textContent = n;
      const tag = document.createElement("span");
      if (n === connectedName) { tag.className = "account-current"; tag.textContent = "playing"; }
      else { tag.className = "account-go"; tag.textContent = "▸"; }
      btn.append(nameEl, tag);
      btn.addEventListener("click", () => { close(); void enterAsPlayer(n); });
      list.appendChild(btn);
    }
  }

  // New-character form.
  const nameInput = root.querySelector("#account-new-name") as HTMLInputElement;
  const createBtn = root.querySelector("#account-create") as HTMLButtonElement;
  const create = (): void => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    close();
    void enterAsPlayer(name);
  };
  createBtn.addEventListener("click", create);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); create(); }
  });

  // When already connected, offer a disconnect (reuses the topbar path).
  if (connectedName) {
    const foot = root.querySelector(".account-foot")!;
    foot.className = "account-foot modal-actions";
    const dc = document.createElement("button");
    dc.className = "modal-cancel";
    dc.textContent = "Disconnect";
    dc.addEventListener("click", () => { close(); connectBtn.click(); });
    foot.appendChild(dc);
  }

  root.addEventListener("click", (e) => { if (e.target === root) close(); });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(root);
  nameInput.focus();
}

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
  mapTabBar.style.display = m === "overworld" ? "flex" : "none";
  applyMapTabControls();
  render();
  updateSidebar();
}

/** Pan/zoom controls (grab cursor, Recenter button) apply only to the World
 *  tab; the Dungeon minimap is a static view, so hide them there. */
function applyMapTabControls(): void {
  const worldActive = mode === "overworld" && mapTab === "world";
  recenterBtn.style.display = worldActive ? "" : "none";
  canvas.style.cursor = worldActive ? "grab" : "";
}

function setMapTab(tab: MapTab): void {
  mapTab = tab;
  mapTabWorldBtn.classList.toggle("active", tab === "world");
  mapTabDungeonBtn.classList.toggle("active", tab === "dungeon");
  applyMapTabControls();
  render();
}

modeOverworldBtn.addEventListener("click", () => setMode("overworld"));
modeDungeonBtn.addEventListener("click", () => setMode("dungeon"));
mapTabWorldBtn.addEventListener("click", () => setMapTab("world"));
mapTabDungeonBtn.addEventListener("click", () => setMapTab("dungeon"));

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
  if (mode !== "overworld" || mapTab !== "world" || overworldNodes.size === 0) return;
  if (panMoved) { panMoved = false; return; }  // this was a drag, not a click

  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const currentSeg = connState?.player?.segment ?? HUB;
  const centerNode = overworldNodes.get(segKey(currentSeg))
      ?? overworldNodes.get(segKey(HUB))
      ?? overworldNodes.values().next().value!;

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
  if (mode !== "overworld" || mapTab !== "world" || e.button !== 0) return;
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
  if (mode === "overworld" && mapTab === "world") canvas.style.cursor = "grab";
  // `panMoved` is left set for the click handler (which fires next) to inspect.
});

// Wheel to zoom, centered on the cursor.  Adjusts the pan so the world point
// under the pointer stays fixed while zooming.
canvas.addEventListener("wheel", (e) => {
  if (mode !== "overworld" || mapTab !== "world" || overworldNodes.size === 0) return;
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
  fov.update(me().x, me().y, session.dungeon);
  camera.centerOn(me().x, me().y);
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
  segmentSeed: string, depth: number, seg: SegmentRef, visitId: number,
  constraints: Gate[] = [], entryDirection: string = "",
): void {
  const p = connState?.player;
  if (!p) return;

  channelSession = true;
  channelSegment = seg;
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

  // Settled inventory (bag + equipped) that mid-run equip/unequip can act on.
  // ORDER BY rowid asc, matching the GSP's ApplySettlementBody SELECT so the
  // replayed loadout is byte-identical.
  const entryInventory = p.inventory
    .map(item => ({ rowid: item.rowid, itemId: item.item_id, slot: item.slot }))
    .sort((a, b) => a.rowid - b.rowid);

  session = new DungeonSession(
    segmentSeed, depth, stats, p.hp, p.max_hp, potions,
    constraints, entryDirection, entryInventory);
  fov = new FovMap();
  currentFogKey = "seg:" + segmentSeed;
  fov.explored = persistentExplored("seg:" + segmentSeed);
  fov.update(me().x, me().y, session.dungeon);
  camera.centerOn(me().x, me().y);

  setMode("dungeon");
}


// --- Co-op (multiplayer visits) --------------------------------------------
// Backend docs/SPEC_multiplayer_coop.md.  Lobby: `v` hosts a visit on a
// confirmed segment, `j` joins; the visit activates when full.  Run: both
// clients build the same N-participant session and exchange their own
// actions over the relay (net/coop.ts).  Settle: participant 0 submits `s`
// once every other participant's `sc` (consent to the exact merged log) is
// on chain.

/**
 * The gates where the player stands that open onto a confirmed segment: the
 * co-op runs they could start or join from here (backend spec section 8a).
 * The hub has all four gates and no segments row of its own.
 */
interface CoopTarget { dir: string; seg: SegmentRef; }
function coopTargets(from: SegmentRef): CoopTarget[] {
  const dirs = isHub(from)
    ? ["north", "east", "south", "west"]
    : Object.keys(connState?.segments.get(segKey(from))?.gates ?? {});
  const out: CoopTarget[] = [];
  for (const dir of dirs) {
    const seg = neighbour(from, dir);
    if (isHub(seg)) continue;                 // the hub is not a dungeon
    if (!connState?.segments.get(segKey(seg))?.confirmed) continue;
    out.push({ dir, seg });
  }
  return out;
}

/** Open visits the player could walk into from where they stand. */
interface JoinableVisit { visit: VisitSummary; dir: string; }
function joinableVisits(from: SegmentRef): JoinableVisit[] {
  const myName = connState?.playerName ?? "";
  const targets = coopTargets(from);
  const out: JoinableVisit[] = [];
  for (const v of connState?.fullState?.visits ?? []) {
    if (v.status !== "open") continue;
    if (v.initiator === myName) continue;
    if (v.players >= v.max_players) continue;
    const t = targets.find(t => sameSeg(t.seg, v.segment));
    if (t) out.push({ visit: v, dir: t.dir });
  }
  return out;
}

/**
 * The settlement for walking out of the current run through `dir`: the
 * claimed outcome plus the replay proof, with the gate action appended.
 * Shared by the plain gate-walk and by hosting or joining a co-op run,
 * which are gate-walks that wait.  Null when there is no run to settle or
 * the player is not standing on that gate.
 */
function buildExitSettlement(dir: string): Settlement | null {
  if (!session || !channelSession || coop || coopSolo) return null;
  const g = gateAtPlayer();
  if (!g || g.direction !== dir) return null;
  return {
    results: {
      survived: true,
      xp: me().totalXp,
      gold: me().totalGold,
      kills: me().totalKills,
    },
    actions: soloProof([...session.actionLog, { type: "gate" }]),
  };
}

/** Canonical participant order: ascending UTF-8 byte order (spec section 1). */
function canonicalNames(names: string[]): string[] {
  const enc = new TextEncoder();
  const bytes = new Map(names.map(n => [n, enc.encode(n)] as const));
  return [...names].sort((a, b) => {
    const x = bytes.get(a)!, y = bytes.get(b)!;
    const len = Math.min(x.length, y.length);
    for (let i = 0; i < len; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  });
}

/**
 * A participant's engine setup from their on-chain info: EFFECTIVE stats
 * (what the GSP's ComputePlayerStats gives the replay), HP, carried potions,
 * and the settled inventory ORDER BY rowid (the replay's SELECT order).
 */
function setupFromPlayer(p: PlayerInfo, entryDir: string = ""): PlayerSetup {
  const stats: PlayerStats = {
    level: p.level,
    strength: p.effective_stats.strength,
    dexterity: p.effective_stats.dexterity,
    constitution: p.effective_stats.constitution,
    intelligence: p.effective_stats.intelligence,
    equipAttack: p.effective_stats.equip_attack,
    equipDefense: p.effective_stats.equip_defense,
  };
  const potions: Array<{ itemId: string; quantity: number }> = [];
  for (const item of p.inventory) {
    if (item.slot === "bag" && (item.item_id === "health_potion" || item.item_id === "greater_health_potion")) {
      potions.push({ itemId: item.item_id, quantity: item.quantity });
    }
  }
  const inventory = p.inventory
    .map(item => ({ rowid: item.rowid, itemId: item.item_id, slot: item.slot }))
    .sort((a, b) => a.rowid - b.rowid);
  return { name: p.name, stats, hp: p.hp, maxHp: p.max_hp, potions, inventory, entryDir };
}

/** Sleep helper for the settle polling loops. */
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Reconciles the co-op state with the chain on every poll: starts the run
 * when our visit turns active, and tears it down once the visit is gone
 * (settled by the partner's submit, or force-settled by the timeout).
 */
async function syncCoopFromChain(): Promise<void> {
  const p = connState?.player;
  if (!p || !connection.rpc || coopSyncInFlight || busy) return;
  const av = p.active_visit;
  if (!av || p.in_channel) {
    coopVisit = null;
    if ((coop || coopSolo) && !coopSettling) await finishCoop();
    return;
  }
  coopSyncInFlight = true;
  try {
    const v = await connection.rpc.getvisitinfo(av.visit_id);
    coopVisit = v;
    if (!v) return;
    if (v.status === "active" && !coop && !coopSolo && !coopSettling) {
      await startCoopRun(v);
    } else if (v.status !== "active" && v.status !== "open"
               && (coop || coopSolo) && !coopSettling) {
      await finishCoop();
    }
  } catch (e) {
    console.warn("co-op sync failed:", e);
  } finally {
    coopSyncInFlight = false;
    updateSidebar();
  }
}

/** Builds the shared N-participant session for an active visit and starts the runner. */
async function startCoopRun(v: VisitInfo): Promise<void> {
  if (!connState?.player || !connection.rpc || !moves) return;
  const myName = connState.playerName;
  const names = canonicalNames(v.participants);
  const meIdx = names.indexOf(myName);
  if (meIdx < 0) return;
  const segInfo = connState.segments.get(segKey(v.segment));
  if (!segInfo) return;  // segment cache not populated yet; next poll retries

  // Every participant's setup, in canonical order.  Each walked in through
  // their own gate, so each spawns there (spec sections 2a and 8a); the GSP
  // replays from exactly these entry directions.
  const setups: PlayerSetup[] = [];
  for (const n of names) {
    const info = n === myName ? connState.player : await connection.rpc.getplayerinfo(n);
    if (!info) return;
    setups.push(setupFromPlayer(info, v.entry_directions?.[n] ?? ""));
  }

  const constraints = constraintsFor(segInfo);
  // A duel visit must build a DUEL session: the mode is what enables the
  // commit/reveal rounds, the per-round reseed and bump-to-attack, so
  // getting it from the visit row rather than from anything local is what
  // keeps both clients (and the GSP's replay) on the same engine.
  const isDuel = v.mode === "duel";
  const s = isDuel
    ? DungeonSession.createDuel(segInfo.seed, segInfo.depth, setups, v.id, constraints)
    : DungeonSession.createMulti(segInfo.seed, segInfo.depth, setups, constraints);
  session = s;
  channelSession = true;
  channelSegment = v.segment;
  channelVisitId = v.id;
  coopSettling = false;
  coopSettleError = null;
  coopSolo = null;
  coopSetup = { seed: segInfo.seed, depth: segInfo.depth, constraints, setups, names,
                me: meIdx, duelVisitId: isDuel ? v.id : null };
  coopCheckpointN = -1;
  coopCheckpointAt = 0;
  reconnectPromptShown = false;

  coop = new CoopRunner({
    session: s,
    me: meIdx,
    names,
    transport: new ProxyRelayTransport(DEFAULT_PROXY_URL, v.id, myName),
    onChange: coopOnChange,
    onNote: (text, kind) => s.addMessage(text, kind),
  });

  fov = new FovMap();
  currentFogKey = "seg:" + segInfo.seed;
  fov.explored = persistentExplored("seg:" + segInfo.seed);
  const m = me();
  fov.update(m.x, m.y, s.dungeon);
  camera.centerOn(m.x, m.y);

  const partners = names.filter(n => n !== myName).join(", ");
  s.addMessage(isDuel
    ? `Duel with ${partners} at ${segName(v.segment)}. Each round you both choose in secret, then both moves resolve.`
    : `Co-op run with ${partners} at ${segName(v.segment)}. Rounds: one action each, then the monsters move.`,
    "info");
  // The run has started and the player is now standing in the dungeon: the
  // lobby they opened it from is stale, and leaving it up over the map
  // reads as though nothing has happened yet.
  setModalTab(null);
  coop.start();
  if (coopCheckpointTimer) clearInterval(coopCheckpointTimer);
  coopCheckpointTimer = setInterval(() => maybeCheckpoint(false), 5000);
  maybeCheckpoint(true);
  setMode("dungeon");
}

/**
 * Sends a checkpoint confirm (`sc` over the first n merged-log actions,
 * spec section 11) when due: every COOP_CHECKPOINT_ACTIONS applied
 * actions, and at least every COOP_HEARTBEAT_MS while the run is live so a
 * live partner never looks abandoned.  Fire-and-forget; the final confirm
 * at game over is sent by coopSettle.
 */
function maybeCheckpoint(force: boolean): void {
  if (!coop || !moves || !connState?.playerName || coopSettling || coopCheckpointInFlight) return;
  const s = coop.session;
  if (s.gameOver) return;
  const n = s.mergedLog.length;
  const now = Date.now();
  const due = force
    || n - coopCheckpointN >= COOP_CHECKPOINT_ACTIONS
    || now - coopCheckpointAt >= COOP_HEARTBEAT_MS;
  if (!due) return;
  coopCheckpointN = n;
  coopCheckpointAt = now;
  coopCheckpointInFlight = true;
  const hash = settleLogHash(channelVisitId, s.mergedLog.slice(0, n));
  moves.settleConfirm(connState.playerName, channelVisitId, hash, n)
    .catch(e => console.warn("checkpoint failed:", e))
    .finally(() => { coopCheckpointInFlight = false; });
}

/** Runner callback: the shared state changed (own or partner action, relay error). */
function coopOnChange(): void {
  if (!coop || !session || !fov) return;
  const m = me();
  fov.update(m.x, m.y, session.dungeon);
  camera.centerOn(m.x, m.y);
  render();
  updateSidebar();
  saveCurrentFog();
  if (session.gameOver && !coopSettling) void coopSettle();
  else maybeCheckpoint(false);
  noteGateArrival();
}

/**
 * Opens the leave dialog on ARRIVAL at a gate.  A duel round only seals a
 * choice when you press the key; the move itself does not happen until both
 * sides reveal, so firing on input showed the dialog while the player was
 * still standing somewhere else, with "walk out through a gate" greyed and
 * nothing but Cancel clickable.  Watching the applied position instead
 * fires it exactly once, when you are really there.
 */
let lastGateArrival: string | null = null;
function noteGateArrival(): void {
  if (!session || session.gameOver) return;
  const p = me();
  if (p.dead || p.exited) { lastGateArrival = null; return; }
  const g = gateAtPlayer();
  if (!g) { lastGateArrival = null; return; }
  const key = `${g.x},${g.y}`;
  if (lastGateArrival === key) return;   // still standing on the same gate
  lastGateArrival = key;
  if (fireArmedIntent(g.direction)) return;
  session.addMessage(
    session.isDuel()
      ? `On the ${g.direction} gate. Leaving here CONCEDES the duel.`
      : `On the ${g.direction} gate.`,
    session.isDuel() ? "warning" : "info");
  updateSidebar();
  showLeaveOptionsModal();
}

/**
 * The partner's latest checkpoint, and whether it is stale enough for an
 * abandonment settle (spec section 11).  Null when they have none yet.
 */
function partnerCheckpoint(): { name: string; n: number; age: number; stale: boolean } | null {
  const names = coop?.names ?? coopSetup?.names;
  const meIdx = coop?.me ?? coopSetup?.me;
  if (!names || meIdx === undefined || !coopVisit) return null;
  const height = connState?.currentHeight ?? 0;
  let best: { name: string; n: number; age: number; stale: boolean } | null = null;
  for (let i = 0; i < names.length; i++) {
    if (i === meIdx) continue;
    const c = coopVisit.confirms[names[i]];
    if (!c) return null;  // no checkpoint at all: nothing to continue from
    const age = height - c.height;
    const entry = { name: names[i], n: c.n, age, stale: age >= ABANDON_WINDOW_BLOCKS };
    if (!best || entry.age < best.age) best = entry;
  }
  return best;
}

/**
 * Leave a vanished partner behind: rebuild the shared session at their
 * last checkpoint (exactly the first n actions; anything later, including
 * our own, is discarded), mark them absent, and play on alone.
 */
function continueAlone(): void {
  if (!coop || !coopSetup || !session || !fov) return;
  const cp = partnerCheckpoint();
  if (!cp || !cp.stale) {
    showErrorModal("Partner not stale yet",
      "Your partner's last checkpoint is too recent to abandon the run. Wait for the window to pass.");
    return;
  }
  const runner = coop;
  const prefix = runner.session.mergedLog.slice(0, cp.n);
  if (prefix.length < cp.n) {
    showErrorModal("Missing actions",
      `Your partner confirmed ${cp.n} actions but this client only has ${prefix.length}. Wait for the relay to catch up.`);
    return;
  }
  runner.stop();
  coop = null;
  if (coopCheckpointTimer) { clearInterval(coopCheckpointTimer); coopCheckpointTimer = null; }

  // Rebuild on the same engine the run has been using: replaying a duel's
  // prefix through the co-op engine would reject its commit entries and
  // silently truncate the run.
  const s = coopSetup.duelVisitId !== null
    ? DungeonSession.replayDuel(
        coopSetup.seed, coopSetup.depth, coopSetup.setups, coopSetup.duelVisitId,
        prefix, coopSetup.constraints)
    : DungeonSession.replayMulti(
        coopSetup.seed, coopSetup.depth, coopSetup.setups, prefix, coopSetup.constraints);
  for (let i = 0; i < coopSetup.names.length; i++)
    if (i !== coopSetup.me) s.markAbsent(i);
  session = s;
  coopSolo = { visitId: channelVisitId, names: coopSetup.names, me: coopSetup.me, from: cp.n };
  const m = me();
  fov.update(m.x, m.y, s.dungeon);
  camera.centerOn(m.x, m.y);
  s.addMessage(
    coopSetup.duelVisitId !== null
      ? `${cp.name} is gone. They forfeit the duel, and it settles from their last ` +
        `checkpoint (${cp.n} actions in).`
      : `${cp.name} is gone. Continuing alone from their last checkpoint (${cp.n} actions in); ` +
        `reach a gate to settle.`, "warning");
  render();
  updateSidebar();
  if (s.gameOver) void coopSoloSettle();
}

/** Keyboard input while continuing alone after an abandonment. */
function handleSoloSuffixInput(action: string, dir?: Direction): void {
  if (!coopSolo || !session || !fov || session.gameOver) return;
  const m = me();
  if (m.dead || m.exited) return;
  let a: GameAction | null = null;
  switch (action) {
    case "move": if (dir) a = { type: "move", dx: dir.dx, dy: dir.dy }; break;
    case "pickup": a = { type: "pickup" }; break;
    case "wait": a = { type: "wait" }; break;
    case "use_potion": a = { type: "use", itemId: "health_potion" }; break;
    case "gate": {
      const g = gateAtPlayer();
      if (g) confirmCoopExit(g.direction);
      return;
    }
    case "gate-now":
      a = { type: "gate" };
      break;
  }
  if (!a) return;
  if (!session.processActionBy(coopSolo.me, a)) return;
  const m2 = me();
  fov.update(m2.x, m2.y, session.dungeon);
  camera.centerOn(m2.x, m2.y);
  render();
  updateSidebar();
  saveCurrentFog();
  if (session.gameOver) void coopSoloSettle();
  else if (action === "move") {
    const g = gateAtPlayer();
    if (g) {
      session.addMessage(`On the ${g.direction} gate.`, "info");
      updateSidebar();
      showLeaveOptionsModal();
    }
  }
}

/** Abandonment settle: the checkpoint prefix plus our solo suffix, with solo_from. */
async function coopSoloSettle(): Promise<void> {
  if (!coopSolo || !session || !moves || !connection.rpc || coopSettling) return;
  const solo = coopSolo;
  const s = session;
  const myName = connState!.playerName;
  coopSettling = true;
  coopSettleError = null;
  busy = true;
  updateSidebar();
  try {
    s.addMessage("Run over. Settling alone on-chain...", "info");
    await moves.settle(myName, solo.visitId,
                       toWireResults(s, solo.names, coopVisit?.pot ?? 0),
                       mergedProof(s.mergedLog), solo.from);
    const ok = await waitForVisitStatus(solo.visitId, st => st !== "active", 60000);
    if (!ok) throw new Error("The GSP did not settle the run in time. Retry the settlement.");
    busy = false;
    coopSettling = false;
    await finishCoop();
  } catch (e) {
    coopSettleError = e instanceof Error ? e.message : String(e);
    showErrorModal("Settlement problem", coopSettleError);
  } finally {
    busy = false;
    coopSettling = false;
    updateSidebar();
  }
}

/** Polls getvisitinfo until `pred(status)` holds or the timeout passes. */
async function waitForVisitStatus(
  visitId: number, pred: (status: string) => boolean, timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await connection.rpc?.getvisitinfo(visitId);
      if (!v || pred(v.status)) return true;
    } catch { /* transient; keep polling */ }
    await sleep(1000);
  }
  return false;
}

/**
 * Mutual-consent settlement (spec section 7).  Participant 0 is the
 * submitter by convention: everyone else sends `sc` with the hash of the
 * merged log; the submitter waits until those confirms are on chain, then
 * sends `s` with every participant's claims and the log.
 */
async function coopSettle(): Promise<void> {
  if (!coop || !session || !moves || !connection.rpc || coopSettling) return;
  const runner = coop;
  const s = session;
  const visitId = channelVisitId;
  const myName = connState!.playerName;
  coopSettling = true;
  coopSettleError = null;

  const hash = settleLogHash(visitId, s.mergedLog);
  const results = toWireResults(s, runner.names, coopVisit?.pot ?? 0);
  const actions = mergedProof(s.mergedLog);
  const others = runner.names.filter(n => n !== myName);

  busy = true;
  updateSidebar();
  try {
    if (runner.me === 0) {
      s.addMessage("Run over. Waiting for your partner's confirmation...", "info");
      updateSidebar();
      const deadline = Date.now() + 180000;
      let done = false;
      while (Date.now() < deadline && coop === runner) {
        const v = await connection.rpc.getvisitinfo(visitId);
        if (!v || v.status !== "active") { done = true; break; }
        const total = s.mergedLog.length;
        const mismatch = others.find(n =>
          v.confirms[n] && v.confirms[n].n === total && v.confirms[n].h !== hash);
        if (mismatch) {
          throw new Error(
            `${mismatch} confirmed a different action log than yours, so the ` +
            `clients diverged and this run cannot settle. The visit will be ` +
            `force-settled by the timeout.`);
        }
        if (others.every(n => v.confirms[n]?.h === hash && v.confirms[n]?.n === total)) {
          s.addMessage("Confirmation received. Settling on-chain...", "info");
          updateSidebar();
          await moves.settle(myName, visitId, results, actions);
          const ok = await waitForVisitStatus(visitId, st => st !== "active", 60000);
          if (!ok) throw new Error("The GSP did not settle the run in time. Retry the settlement.");
          done = true;
          break;
        }
        await sleep(1500);
      }
      if (!done) throw new Error("Timed out waiting for your partner's confirmation. Retry once they are back.");
    } else {
      s.addMessage("Run over. Sending your confirmation...", "info");
      updateSidebar();
      await moves.settleConfirm(myName, visitId, hash, s.mergedLog.length);
      s.addMessage("Confirmed. Waiting for the host to settle...", "info");
      updateSidebar();
      const ok = await waitForVisitStatus(visitId, st => st !== "active", 180000);
      if (!ok) throw new Error("Timed out waiting for the settlement. Retry to re-send your confirmation.");
    }
    busy = false;
    coopSettling = false;
    await finishCoop();
  } catch (e) {
    coopSettleError = e instanceof Error ? e.message : String(e);
    showErrorModal("Settlement problem", coopSettleError);
  } finally {
    busy = false;
    coopSettling = false;
    updateSidebar();
  }
}

/** Tears down a finished co-op run and re-syncs the view to the chain. */
async function finishCoop(): Promise<void> {
  if (!coop && !coopSolo) return;
  coop?.stop();
  coop = null;
  coopSolo = null;
  coopSetup = null;
  if (coopCheckpointTimer) { clearInterval(coopCheckpointTimer); coopCheckpointTimer = null; }
  const visitId = channelVisitId;

  const wasDuel = !!session?.isDuel();
  let summary = "";
  try {
    const v = await connection.rpc?.getvisitinfo(visitId);
    if (v?.results) {
      summary = v.results.map(r =>
        `${r.name}: ${r.survived ? "survived" : "died"}, +${r.xp_gained} XP, ` +
        `+${r.gold_gained} gold, ${r.kills} kill${r.kills === 1 ? "" : "s"}`).join("\n");
    }
  } catch { /* summary is best-effort */ }

  channelSession = false;
  session = null;
  fov = null;
  hubBuiltAtHub = false;
  coopVisit = null;
  armedIntent = null;
  coopSettling = false;
  coopSettleError = null;
  try { await connection.refreshPlayer(); } catch { /* next poll */ }
  try { ensureHubSessionIfAtHub(); } catch { /* not fatal to the teardown */ }
  if (!session) setMode("overworld");
  // Where the player is left standing is the first thing they need, and
  // nothing used to say it.  A duel winner in particular is banked without
  // ever walking out of a gate, so they end up standing INSIDE the segment
  // with no run: a state the sidebar calls a recovery case, reached every
  // single time a duel is won.
  const now = connState?.player;
  let whereLine = "";
  if (now) {
    if (isHub(now.segment)) {
      whereLine = "You are back at the hub.";
    } else if (!now.in_channel) {
      whereLine = `You are standing in ${segName(now.segment)} with no run under way. ` +
        `Use "Enter Dungeon Here" in the sidebar to play it again, or enter and walk to a gate to move on.`;
    } else {
      whereLine = `You are in ${segName(now.segment)}.`;
    }
  }
  addOverworldMessage(wasDuel ? "Duel settled." : "Co-op run settled.", "info");
  if (whereLine) addOverworldMessage(whereLine, "info");
  // The redraw must happen even if the summary dialog throws.  Anything that
  // skips updateSidebar here leaves the page showing the mid-run sidebar for
  // a run that no longer exists, with no control to get out of it, and only
  // a reload recovers.  That is exactly how a settled duel stranded a player.
  try {
    showModal({
      title: wasDuel ? "Duel settled" : "Co-op run settled",
      message: [summary || "The run has settled on-chain.", whereLine]
        .filter(Boolean).join("\n\n"),
      variant: "info",
    });
  } finally {
    render();
    updateSidebar();
  }
}

/**
 * True (after telling the player) when they are parked in an open or
 * active co-op visit, which the GSP treats as "already in a visit": solo
 * entries and gate-walks would be rejected until it resolves.
 */
function inCoopLobby(): boolean {
  const p = connState?.player;
  if (!p || p.in_channel || !p.active_visit) return false;
  showErrorModal(
    "You are in a co-op visit",
    coopVisit?.status === "active"
      ? "Your co-op run is active. Switch to the World view to play it."
      : "You are waiting in co-op visit #" + p.active_visit.visit_id +
        ". Solo dungeon entries are blocked until it starts and settles, " +
        "or you leave it from the Map sidebar.");
  return true;
}

/**
 * Open a co-op run through the gate `dir` where the player stands (`v`).
 * From inside a run this is a gate-walk that waits: it settles the run and
 * leaves the player standing here with the door open.  From the hub, or a
 * segment they are standing in, there is nothing to settle.
 */
/**
 * Picks the stake for a duel this player is about to host.  Presets rather
 * than a free number: the amounts a player would actually choose are few,
 * and a preset list can be filtered to what they can afford so an
 * unaffordable stake is never offered at all.  0 is kept deliberately --
 * a friendly duel with nothing on it is a real thing to want.
 */
/**
 * What the challenger puts up.  It must clear the host's floor and need not
 * equal their stake: the point of an uneven duel is the underdog risking
 * less, so this opens at the floor rather than at the host's ante.
 */
function showJoinStakeModal(visitId: number, dir: string, hostStake: number,
                            floor: number, gold: number): void {
  showAmountModal({
    title: `Duel for how much?`,
    message:
      `They staked ${hostStake} and will accept ` +
      `${floor === 0 ? "anything" : `${floor} or more`}. Whatever you put up ` +
      `joins theirs in the pot and the winner takes all of it, so risking ` +
      `${floor === 0 ? "nothing" : String(floor)} against their ${hostStake} is a cheap shot ` +
      `worth taking if you fancy your chances. You hold ${gold} gold.`,
    label: "Your stake",
    min: floor,
    max: gold,
    initial: floor,
    presets: [
      [`Least (${floor})`, floor],
      ...(hostStake >= floor && hostStake <= gold
        ? [[`Match them (${hostStake})`, hostStake] as [string, number]] : []),
      ...(gold > floor ? [[`All ${gold}`, gold] as [string, number]] : []),
    ],
    confirmLabel: "Walk in",
    cancelLabel: "Never mind",
    onConfirm: (stake) => { void doCoopJoin(visitId, dir, stake); },
  });
}

function showDuelStakeModal(dir: string, armFor?: SegmentRef): void {
  const gold = connState?.player?.gold ?? 0;
  showAmountModal({
    title: "Stake the duel",
    message:
      `What you put up. Your challenger does not have to match it: you set ` +
      `the floor next, and the winner takes the whole pot. Stake 0 for a ` +
      `friendly duel with nothing on it. You hold ${gold} gold.`,
    label: "Your stake",
    min: 0,
    max: gold,
    initial: 0,
    presets: stakePresets(gold),
    confirmLabel: "Next",
    cancelLabel: "Never mind",
    onConfirm: (stake) => showDuelFloorModal(dir, stake, armFor),
  });
}

/**
 * The least a challenger may put up against `stake`.  This is the host's
 * only protection: a duel activates the moment it is full, so they never
 * see who joined or for how much, and without a floor someone could join a
 * 100 gold duel for 1 and have a nearly free shot at it.  Defaulting to the
 * host's own stake reproduces matched stakes exactly.
 */
function showDuelFloorModal(dir: string, stake: number,
                            armFor?: SegmentRef): void {
  if (stake === 0) {
    // Nothing to protect: a friendly duel has no floor to set.
    if (armFor) armIntent({ kind: "duel", dir, seg: armFor, stake, minStake: 0,
                            from: connState!.player!.segment });
    else void doCoopHost(dir, stake, 0);
    return;
  }
  showAmountModal({
    title: "The least they may risk",
    message:
      `You are staking ${stake}. A challenger must put up at least this ` +
      `much to take you on, and may put up more. Set it low to let an ` +
      `underdog take a cheap shot at you; set it to ${stake} to insist they ` +
      `match you, which is how duels worked before.`,
    label: "Minimum",
    min: 0,
    max: stake,
    initial: stake,
    presets: [
      ["Anything (0)", 0],
      ...(stake >= 4 ? [[`Quarter (${Math.floor(stake / 4)})`, Math.floor(stake / 4)] as [string, number]] : []),
      ...(stake >= 2 ? [[`Half (${Math.floor(stake / 2)})`, Math.floor(stake / 2)] as [string, number]] : []),
      [`Match me (${stake})`, stake],
    ],
    confirmLabel: "Open the duel",
    cancelLabel: "Back",
    onConfirm: (minStake) => {
      if (armFor) armIntent({ kind: "duel", dir, seg: armFor, stake, minStake,
                              from: connState!.player!.segment });
      else void doCoopHost(dir, stake, minStake);
    },
  });
}

/** Quick picks for an amount up to `gold`: nothing, a quarter, half, all. */
function stakePresets(gold: number): Array<[string, number]> {
  const out: Array<[string, number]> = [["No stake", 0]];
  if (gold > 0) {
    const quarter = Math.floor(gold / 4);
    const half = Math.floor(gold / 2);
    if (quarter > 0) out.push([`${quarter}`, quarter]);
    if (half > quarter) out.push([`${half}`, half]);
    out.push([`All ${gold}`, gold]);
  }
  return out;
}

/**
 * True when the player is parked in a CO-OP visit: a lobby they are waiting
 * in, or a co-op/duel run under way.
 *
 * A plain solo dungeon run also sets `active_visit`, and conflating the two
 * broke the documented flow.  Opening or joining a run from inside a solo
 * run is a gate-walk that waits: the move carries that run's settlement,
 * settles it, and leaves you standing at the gate with the door open.  Both
 * doCoopHost and doCoopJoin build exactly that settlement a few lines below
 * the guard that used to reject every `active_visit`, so the code was
 * unreachable, and the Co-op tab additionally reported a solo run as
 * "waiting for a partner" and offered to cancel it.  The honest signal is
 * local: a co-op or duel run always has a runner, and a lobby is always
 * status "open".
 */
function inCoopVisitNow(): boolean {
  const p = connState?.player;
  if (!p?.active_visit) return false;
  return !!coop || !!coopSolo || coopVisit?.status === "open";
}

async function doCoopHost(dir: string, duelStake?: number,
                          duelMinStake?: number): Promise<void> {
  if (busy || !moves || !connState?.playerName) return;
  if (rulesMismatch) { showErrorModal("Client out of date", rulesMismatch); return; }
  const p = connState.player;
  if (!p) return;
  if (inCoopVisitNow()) {
    showErrorModal("Already in a co-op visit",
      "Finish or leave your current co-op visit before starting another.");
    return;
  }
  const target = neighbour(p.segment, dir);
  if (isHub(target) || !connState.segments.get(segKey(target))?.confirmed) {
    showErrorModal("Nothing to meet in",
      `There is no confirmed dungeon through the ${dir} gate. Co-op runs need a segment someone has already cleared.`);
    return;
  }
  const settlement = p.in_channel ? buildExitSettlement(dir) : null;
  if (p.in_channel && !settlement) {
    showErrorModal("Not on that gate",
      `You have to be standing on the ${dir} gate to open a co-op run through it.`);
    return;
  }

  busy = true;
  updateSidebar();
  try {
    await moves.visit(connState.playerName, dir, settlement ?? undefined,
                      duelStake === undefined
                        ? undefined
                        : { stake: duelStake, minStake: duelMinStake });
    const outcome = await waitForMove(connection, ({ player }) =>
      !!player?.active_visit && sameSeg(player.active_visit.segment, target));
    if (outcome === "applied") {
      if (settlement) teardownRunAfterExit();
      addOverworldMessage(
        duelStake === undefined
          ? `Waiting at the ${dir} gate for a partner to join you in ${segName(target)}.`
          : `Waiting at the ${dir} gate for a challenger in ${segName(target)}. ` +
            `Your ${duelStake} gold is in escrow until the duel settles.`,
        "info");
      // Leaving a run to open a lobby is a big, silent state change: the run
      // ends, the view jumps to the world map, and nothing is happening yet.
      // Without saying so it reads as a crash.
      if (settlement) {
        showModal({
          title: duelStake === undefined ? "Waiting for a partner" : "Waiting for a challenger",
          message:
            `Your run settled on the way out, so you kept what you found` +
            (connState.segments.get(segKey(p.segment))?.confirmed
              ? ` and ${segName(p.segment)} is confirmed.` : ".") +
            `\n\nYou are now standing at the ${dir} gate with ${segName(target)} open ` +
            `and waiting. Nothing else happens until someone walks in from their own ` +
            `side of it` +
            (duelStake === undefined ? "." : `, matching your ${duelStake} gold stake.`) +
            `\n\nYou are not in a dungeon while you wait. Cancel from the Co-op tab to ` +
            `go back to playing; it also cancels itself after 100 blocks.`,
          variant: "info",
        });
      }
    } else {
      diagnoseCoopRejection("open a co-op run", dir, target);
    }
  } catch (e) {
    showErrorModal("Host failed", e instanceof Error ? e.message : String(e));
  }
  busy = false;
  updateSidebar();
  void syncCoopFromChain();
}

/**
 * Join an open co-op run through the gate `dir` where the player stands
 * (`j`); the run starts as soon as the visit is full.  Same settlement
 * rules as hosting.
 */
async function doCoopJoin(visitId: number, dir: string,
                          stake?: number): Promise<void> {
  if (rulesMismatch) { showErrorModal("Client out of date", rulesMismatch); return; }
  if (busy || !moves || !connState?.playerName) return;
  const p = connState.player;
  if (!p) return;
  if (inCoopVisitNow()) {
    showErrorModal("Already in a co-op visit",
      "Finish or leave your current co-op visit before joining another.");
    return;
  }
  const target = neighbour(p.segment, dir);
  const settlement = p.in_channel ? buildExitSettlement(dir) : null;
  if (p.in_channel && !settlement) {
    showErrorModal("Not on that gate",
      `You have to be standing on the ${dir} gate to walk into that run.`);
    return;
  }

  busy = true;
  updateSidebar();
  try {
    await moves.join(connState.playerName, visitId, dir, settlement ?? undefined,
                     stake);
    const outcome = await waitForMove(connection, ({ player }) =>
      player?.active_visit?.visit_id === visitId);
    if (outcome === "applied") {
      if (settlement) teardownRunAfterExit();
      addOverworldMessage(
        `Joined the run in ${segName(target)}. It starts as soon as the party is full.`, "info");
    } else {
      diagnoseCoopRejection("join that run", dir, target);
    }
  } catch (e) {
    showErrorModal("Join failed", e instanceof Error ? e.message : String(e));
  }
  busy = false;
  updateSidebar();
  void syncCoopFromChain();
}

/**
 * Drops the finished solo run after its settlement rode out on a `v`/`j`.
 * The player is now standing at their segment, out of any run, waiting.
 */
function teardownRunAfterExit(): void {
  channelSession = false;
  session = null;
  fov = null;
  hubBuiltAtHub = false;
  clearPersistedRun();
  setMode("overworld");
}

/** Explains a rejected co-op move using the rules the GSP applies. */
function diagnoseCoopRejection(what: string, dir: string, target: SegmentRef): void {
  const p = connState?.player;
  const info = connState?.segments.get(segKey(target));
  let why: string;
  if (!info) {
    why = `${segName(target)} has not been discovered yet. The frontier is explored solo.`;
  } else if (!info.confirmed) {
    why = `${segName(target)} is provisional: whoever discovered it has to complete a run there before anyone can meet in it.`;
  } else if (p?.active_visit) {
    why = "You are already in a visit.";
  } else {
    why = `The chain did not accept it. You may not have a ${dir} gate here, or the run filled up first.`;
  }
  showErrorModal(`Could not ${what}`, why);
}

/** Leave an open visit (`lv`); the host leaving cancels it for everyone. */
async function doCoopLeave(visitId: number): Promise<void> {
  if (busy || !moves || !connState?.playerName) return;
  busy = true;
  updateSidebar();
  try {
    await moves.leave(connState.playerName, visitId);
    const outcome = await waitForMove(connection, ({ player }) => !!player && !player.active_visit);
    if (outcome === "applied") addOverworldMessage(`Left visit #${visitId}.`, "info");
    else showErrorModal("Leave rejected", "The GSP did not remove you from the visit; it may already be active.");
  } catch (e) {
    showErrorModal("Leave failed", e instanceof Error ? e.message : String(e));
  }
  busy = false;
  updateSidebar();
}

/** Throttles the "queue is full" note so it cannot be printed per keystroke. */
let lastInputFullNote = 0;

/** Keyboard input during a co-op run: every action goes through the runner. */
function handleCoopInput(action: string, dir?: Direction): void {
  if (!coop || !session || !fov || session.gameOver) return;
  const m = me();
  if (m.dead || m.exited) return;  // spectating until the run ends

  let a: GameAction | null = null;
  switch (action) {
    case "move":
      if (dir) a = { type: "move", dx: dir.dx, dy: dir.dy };
      break;
    case "pickup":
      a = { type: "pickup" };
      break;
    case "wait":
      a = { type: "wait" };
      break;
    case "use_potion":
      a = { type: "use", itemId: "health_potion" };
      break;
    case "gate": {
      // Every one of these used to be a silent no-op: the key did nothing
      // and the player had no way to tell why.
      // Not a reason to refuse the leave modal: when the relay is what is
      // stuck, the routes out are exactly what the player needs to see.
      showLeaveOptionsModal();
      return;
    }
  }
  if (!a) return;

  if (coop.inputFull) {
    // Once every few seconds at most: this fires on every key press while
    // the buffer is full, and a log line per keystroke reads as a fault in
    // the game rather than as the pacing it actually is.
    const now = Date.now();
    if (now - lastInputFullNote > 4000) {
      lastInputFullNote = now;
      session.addMessage(coop.transportError
        ? `The relay refused your last action (${coop.transportError}), so the round cannot close. ` +
          `Nothing you press will register until that is fixed; the action retries by itself once it can.`
        : "Slow down: you are a few moves ahead of the round already.", "info");
      updateSidebar();
    }
    return;
  }
  if (!coop.submitLocal(a)) {
    // A duel only takes input during the commit phase of a round, and only
    // once: every other key press was dropped in silence, which is why
    // drinking a potion mid-duel looked broken.
    if (session.isDuel()) {
      const now = Date.now();
      if (now - lastInputFullNote > 2500) {
        lastInputFullNote = now;
        session.addMessage(
          coop.phaseLabel === "choose"
            ? "You have already sealed your move for this round."
            : `Not now: the round is ${coop.phaseLabel}. Your next choice opens when it resolves.`,
          "info");
        updateSidebar();
      }
    }
    return;
  }

  // Arrival on a gate is announced from coopOnChange, once the move has
  // actually been applied: see noteGateArrival.
}

/**
 * Every way out of a live run, on one screen, with the ones you cannot take
 * right now shown greyed and saying why.  Walking onto a gate and pressing
 * Enter was the only exit and nothing on screen said so, which left players
 * believing a run could not be left at all.  Routes out differ in what they
 * cost, so this lists them rather than picking one: it IS the confirmation,
 * so a choice here acts immediately.
 */
function showLeaveOptionsModal(): void {
  if (!session || (!coop && !coopSolo)) return;
  const duel = session.isDuel();
  const g = gateAtPlayer();
  const stake = coopVisit?.stake ?? 0;
  const choices: Array<{ label: string; detail?: string; disabled?: boolean; onPick: () => void }> = [];

  // 1. The gate: the ordinary way out, and in a duel the forfeit.
  if (duel) {
    choices.push({
      label: g ? `Concede through the ${g.direction} gate` : "Concede through a gate",
      detail: g
        ? "A forfeit, not an escape. Your opponent wins on the spot" +
          (stake > 0 ? ` and takes the ${stake * 2} gold pot` : "") +
          ", and you take the death outcome: half HP, a knock-back, and anything found in here is lost."
        : "You are not on a gate. Walk onto one first; the gates are in the middle of each edge of the map.",
      disabled: !g,
      onPick: () => { submitGateExit(); },
    });
  } else {
    choices.push({
      label: g ? `Walk out through the ${g.direction} gate` : "Walk out through a gate",
      detail: g
        ? "You leave now and keep what you found. The dungeon keeps going for your partner; " +
          "the run settles on-chain once they are done too."
        : "You are not on a gate. Walk onto one first; the gates are in the middle of each edge of the map.",
      disabled: !g,
      onPick: () => { submitGateExit(); },
    });
  }

  // 2. Abandonment: only once the other side has genuinely gone quiet.
  if (coop) {
    const cp = partnerCheckpoint();
    if (!cp) {
      choices.push({
        label: "Settle without your partner",
        detail: "Not yet: they have no checkpoint on chain to settle from.",
        disabled: true,
        onPick: () => {},
      });
    } else {
      choices.push({
        label: `Settle without ${cp.name}`,
        detail: cp.stale
          ? `Their last checkpoint (${cp.n} actions) is ${cp.age} blocks old, so you can leave them behind and settle from it.`
          : `Not yet: their checkpoint is ${cp.age} block${cp.age === 1 ? "" : "s"} old and has to reach ${ABANDON_WINDOW_BLOCKS}. ` +
            `A partner who is still playing keeps it fresh, so this only opens up once they really have gone.`,
        disabled: !cp.stale,
        onPick: () => { continueAlone(); },
      });
    }
  }

  showChoiceModal({
    title: duel ? "Leaving the duel" : "Leaving the run",
    message: duel
      ? "A duel ends when one of you is left standing. There is no neutral exit."
      : "A run ends when everyone has reached a gate or died, and only then does it settle on-chain.",
    choices,
    cancelLabel: duel ? "Keep fighting" : "Stay in the run",
    variant: "warn",
  });
}

/** Sends the gate action for whichever kind of run is live, and says so when
 *  the runner refuses it rather than failing silently. */
function submitGateExit(): void {
  if (coop) {
    if (!coop.submitLocal({ type: "gate" })) {
      session?.addMessage(
        "Could not leave right now: the round is still closing. Try again in a moment.", "warning");
      updateSidebar();
    }
  } else if (coopSolo) {
    handleSoloSuffixInput("gate-now");
  }
}

/** Confirmation before exiting a co-op run -- or conceding a duel -- through
 *  a gate.  In a duel the gate is not an exit at all: it is a forfeit, so
 *  the wording has to say so before the player walks into it expecting to
 *  keep what they found (pvp spec section 5). */
function confirmCoopExit(dir: string): void {
  if (session?.isDuel()) {
    const stake = coopVisit?.stake ?? 0;
    showConfirmModal({
      title: `Concede through the ${dir} gate?`,
      message:
        "Walking out of a duel is a forfeit, not an escape. Your opponent " +
        "wins on the spot" + (stake > 0 ? ` and takes the ${stake * 2} gold pot` : "") +
        ", and you take the ordinary death outcome: half HP, a knock-back, " +
        "and anything you picked up in here is lost.",
      confirmLabel: "Concede",
      cancelLabel: "Keep fighting",
      onConfirm: () => {
        if (coop && !coop.submitLocal({ type: "gate" })) {
          session?.addMessage(
            "Could not concede right now: the round is still closing. Try again in a moment.",
            "warning");
          updateSidebar();
        }
      },
      onCancel: () => {},
    });
    return;
  }
  showConfirmModal({
    title: `Leave through the ${dir} gate?`,
    message:
      "You exit the run now and keep what you found. The dungeon keeps going " +
      "for your partner until they exit or die; then the whole run settles " +
      "on-chain together, with kill rewards split by the damage each of you dealt.",
    confirmLabel: "Exit",
    cancelLabel: "Stay",
    onConfirm: () => {
      if (coop) {
        if (!coop.submitLocal({ type: "gate" })) {
          session?.addMessage(
            "Could not leave right now: the round is still closing. Try again in a moment.",
            "warning");
          updateSidebar();
        }
      } else if (coopSolo) handleSoloSuffixInput("gate-now");
    },
    onCancel: () => {},
  });
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

/**
 * Where traveling `dir` would land the player: the neighbouring cell.
 * Returns null when nothing is there to travel to.
 */
function targetSegmentFor(
  ctx: ValidatorContext, dir: string,
): SegmentRef | null {
  const target = neighbour(ctx.player.segment, dir);
  if (isHub(target) || ctx.segments.has(segKey(target))) return target;
  return null;
}

/**
 * Reports a move that did not produce the expected state change.
 *
 * `rejected` means the chain advanced past the move without applying it —
 * the GSP's parser dropped it, and the validator usually knows why.
 * `pending` means it simply has not been confirmed yet, which is NOT a
 * rejection: nothing has been lost and an in-progress run is still intact.
 * Conflating the two is what made a slow block look like a refused move.
 */
function reportMoveOutcome(
  outcome: MoveOutcome, action: string, revalidate: () => ValidationResult,
): void {
  if (outcome === "pending") {
    showErrorModal(
      "Still waiting for confirmation",
      `Your ${action} was submitted but the chain hasn't caught up yet. ` +
        `Nothing is lost — if you were in a dungeon your run is still ` +
        `exactly where it was. Give it a moment and check the block ` +
        `height in the top bar; if it isn't advancing, the devnet is idle.`,
    );
    return;
  }
  diagnoseRejection(action, revalidate);
}

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
    `The chain moved on without applying it. Likely causes: ` +
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
  const beforeSeg = ctx.player.segment;

  busy = true;
  updateSidebar();
  try {
    await moves.travel(connState.playerName, dir);
    addOverworldMessage(`Traveling ${dir}...`, "info");

    const outcome = await waitForMove(connection, ({ player }) =>
      !!player && player.segment !== beforeSeg
        && (expectedTarget === null || player.segment === expectedTarget));

    if (outcome !== "applied") {
      reportMoveOutcome(outcome, "travel",
        () => validateTravel(validatorContext()!, dir));
    }
  } catch (e) {
    showErrorModal("Travel failed", e instanceof Error ? e.message : String(e));
  }
  busy = false;
  updateSidebar();
}

async function doEnterChannel(seg: SegmentRef): Promise<void> {
  if (busy || !moves || !connState?.playerName) return;
  if (inCoopLobby()) return;
  const ctx = validatorContext();
  if (!ctx) {
    showErrorModal("Not connected", "Connect to a GSP and register a player before entering a dungeon.");
    return;
  }
  if (!handleValidation(validateEnterChannel(ctx, seg))) return;

  busy = true;
  updateSidebar();
  try {
    await moves.enterChannel(connState.playerName, seg);
    addOverworldMessage(`Entering dungeon at ${segName(seg)}...`, "info");

    const outcome = await waitForMove(connection, ({ player }) =>
      !!player && player.in_channel && player.active_visit !== null);

    if (outcome === "applied" && connState.player?.active_visit) {
      const segInfo = connState.segments.get(segKey(seg));
      if (segInfo) {
        startChannelDungeon(
          segInfo.seed, segInfo.depth, seg,
          connState.player.active_visit.visit_id,
          constraintsFor(segInfo),
          connState.player.active_visit.entry_direction);
        busy = false;
        return;
      }
      showErrorModal(
        "Missing segment data",
        `The frontend doesn't have segment ${segName(seg)} cached. Try reconnecting.`,
      );
    } else {
      diagnoseRejection("enter dungeon", () => validateEnterChannel(validatorContext()!, seg));
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
  const survived = me().exited;
  const earnedXp = me().totalXp;
  const earnedGold = me().totalGold;

  busy = true;
  updateSidebar();
  try {
    const results = {
      survived,
      xp: earnedXp,
      gold: earnedGold,
      kills: me().totalKills,
    };

    const actions = soloProof(session.actionLog);

    const beforeVisit = channelVisitId;
    await moves.exitChannel(connState.playerName, channelVisitId, results, actions);

    // Success looks like: no longer in a channel (hub respawn / survived exit),
    // OR knocked back into a NEW run on the previous segment (a deep death now
    // lands you one segment back instead of teleporting to the hub).
    const outcome = await waitForMove(connection, ({ player }) => {
      if (!player) return false;
      if (!player.in_channel) return true;
      return !!player.active_visit && player.active_visit.visit_id !== beforeVisit;
    });

    if (outcome !== "applied") {
      showErrorModal(
        "Settlement rejected",
        "Your dungeon results were submitted but the GSP did not close the channel. The most likely cause is action-log replay mismatch — the submitted actions don't verify against the reported outcome. The dungeon session is still active; try exiting again.",
      );
      busy = false;
      updateSidebar();
      return;
    }

    // Tear down the finished run; start the knock-back run if we were pushed
    // back into the previous segment, else fall through to the hub.
    const knockedBack = resumeAfterSettle();

    if (survived) {
      addOverworldMessage(
        `Dungeon complete! +${earnedXp} XP, +${earnedGold} gold`,
        "pickup",
      );
    } else {
      // Death penalty: half HP, lose 25% of carried gold (computed against
      // gold AFTER crediting anything earned).
      const totalGold = goldBefore + earnedGold;
      const goldLost = totalGold - Math.floor(totalGold * 75 / 100);
      addOverworldMessage("You died in the dungeon...", "combat");
      showModal({
        title: "You died",
        message: knockedBack
          ? `You were knocked back to the segment you came from, at half HP, ` +
            `and lost ${goldLost} gold (25% of carried gold). XP and equipment ` +
            `are preserved.`
          : `You respawned at the hub at half HP and lost ${goldLost} gold ` +
            `(25% of carried gold). XP and equipment are preserved.`,
        variant: "error",
      });
    }

    if (!knockedBack && !session) {
      ensureHubSessionIfAtHub();
      if (!session) {
        // Not at hub and no real session — fall back to the map view.
        setMode("overworld");
      }
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

  const currentSeg = ctx.player.segment;
  const beforeLastDiscover = ctx.player.last_discover_height;

  // Depth is the new segment's distance from the hub (Manhattan of its world
  // coords), matching the GSP which computes it authoritatively.  Sending the
  // discovery-path length here would disagree and could trip the [1,20] range
  // check on a long winding path even when the segment is near the hub.
  const cur = overworldNodes.get(segKey(currentSeg));
  let nx = cur?.seg.x ?? 0;
  let ny = cur?.seg.y ?? 0;
  if (dir === "north") ny += 1;
  else if (dir === "south") ny -= 1;
  else if (dir === "east") nx += 1;
  else if (dir === "west") nx -= 1;
  const newDepth = Math.abs(nx) + Math.abs(ny);

  busy = true;
  updateSidebar();
  try {
    await moves.discover(connState.playerName, newDepth, dir);
    addOverworldMessage(`Discovering ${dir}...`, "info");

    const outcome = await waitForMove(connection, ({ player }) =>
      !!player && player.last_discover_height > beforeLastDiscover);

    if (outcome !== "applied") {
      reportMoveOutcome(outcome, "discover",
        () => validateDiscover(validatorContext()!, dir));
    }
  } catch (e) {
    showErrorModal("Discover failed", e instanceof Error ? e.message : String(e));
  }
  busy = false;
  updateSidebar();
}

/**
 * Current HP the player actually has right now.  During a live dungeon run the
 * on-chain player.hp is stale (it only updates at settlement), so the live
 * session HP is the truth; in the hub there is no session and on-chain wins.
 */
function effectiveHp(): { hp: number; max: number } {
  if (channelSession && session) {
    return { hp: me().hp, max: me().maxHp };
  }
  const p = connState?.player;
  return { hp: p?.hp ?? 0, max: p?.max_hp ?? 0 };
}

async function doUseItem(itemId: string): Promise<void> {
  if (busy || !moves || !connState?.playerName) return;
  const ctx = validatorContext();
  if (!ctx) return;

  // Inside a live run a health potion is a LOCAL replayed action that heals the
  // live session HP, not an on-chain move.  Route by the live session (not
  // p.in_channel, which can lag a poll behind), so a mid-run drink is never
  // blocked by the stale on-chain "full HP" and never submits a bad on-chain use.
  if (itemId.includes("health_potion") && channelSession && session) {
    if (me().hp >= me().maxHp) {
      showErrorModal("Already at full HP",
        "You are at full health, so this potion would be wasted. It is saved for when you are hurt.");
      return;
    }
    session.processAction({ type: "use", itemId });
    if (fov) fov.update(me().x, me().y, session.dungeon);
    render();
    updateSidebar();
    persistRun();
    if (activeModalTab) renderGameModal();
    return;
  }

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

    const outcome = await waitForMove(connection, ({ player }) => {
      if (!player) return false;
      if (player.hp > beforeHp) return true;
      const qty = player.inventory
        .filter(i => i.item_id === itemId && i.slot === "bag")
        .reduce((a, i) => a + i.quantity, 0);
      return qty < beforeQty;
    });

    if (outcome !== "applied") {
      reportMoveOutcome(outcome, "use item",
        () => validateUseItem(validatorContext()!, itemId));
    }
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

    const outcome = await waitForMove(connection, ({ player }) =>
      !!player && player.stat_points < before);

    if (outcome !== "applied") {
      reportMoveOutcome(outcome, "allocate stat",
        () => validateAllocateStat(validatorContext()!, stat));
    }
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

    const outcome = await waitForMove(connection, ({ player }) => {
      const item = player?.inventory.find(i => i.rowid === rowid);
      return !!item && item.slot === slot;
    });

    if (outcome !== "applied") {
      reportMoveOutcome(outcome, "equip",
        () => validateEquip(validatorContext()!, rowid, slot));
    }
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

    const outcome = await waitForMove(connection, ({ player }) => {
      const item = player?.inventory.find(i => i.rowid === rowid);
      return !!item && item.slot === "bag";
    });

    if (outcome !== "applied") {
      reportMoveOutcome(outcome, "unequip",
        () => validateUnequip(validatorContext()!, rowid));
    }
  } catch (e) {
    showErrorModal("Unequip failed", e instanceof Error ? e.message : String(e));
  }
  busy = false;
  updateSidebar();
}

/**
 * Mid-run equip: NOT an on-chain move.  It mutates the live session's settled
 * loadout locally (immediate stat effect), records an equip action in the
 * replay log, and costs a turn (monsters act).  It settles with the exit
 * proof, where the GSP replays the same action and verifies the outcome.
 */
function equipLocal(rowid: number, slot: string): void {
  if (busy || !session || session.gameOver) return;
  if (coop) {
    coop.submitLocal({ type: "equip", rowid, slot });
    return;
  }
  if (coopSolo) {
    if (session.processActionBy(coopSolo.me, { type: "equip", rowid, slot })) afterLocalLoadoutChange();
    return;
  }
  if (!session.equip(rowid, slot)) return;
  afterLocalLoadoutChange();
}

/** Mid-run unequip: local, replayed, costs a turn (see equipLocal). */
function unequipLocal(rowid: number): void {
  if (busy || !session || session.gameOver) return;
  if (coop) {
    coop.submitLocal({ type: "unequip", rowid });
    return;
  }
  if (coopSolo) {
    if (session.processActionBy(coopSolo.me, { type: "unequip", rowid })) afterLocalLoadoutChange();
    return;
  }
  if (!session.unequip(rowid)) return;
  afterLocalLoadoutChange();
}

/** Refresh views after a local equip/unequip (the monster turn it ran may
 *  have moved monsters or changed the player's HP). */
function afterLocalLoadoutChange(): void {
  if (session && fov) fov.update(me().x, me().y, session.dungeon);
  render();
  updateSidebar();
  persistRun();
  if (activeModalTab) renderGameModal();
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
        const outcome = await waitForMove(connection, ({ player }) =>
          !!player && !player.inventory.some(i => i.rowid === rowid));
        if (outcome !== "applied") {
          reportMoveOutcome(outcome, "discard",
            () => validateDiscard(validatorContext()!, rowid));
        }
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
  if (inCoopLobby()) return;
  const ctx = validatorContext();
  if (!ctx) return;

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
  const curConfirmed = !!ctx.segments.get(segKey(ctx.player.segment))?.confirmed;
  let settlement: undefined | {
    results: { survived: boolean; xp: number; gold: number; kills: number };
    actions: object[] | string;
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
        a => a.type === "pickup" || a.type === "use"
          || a.type === "equip" || a.type === "unequip")
      || (me().totalXp ?? 0) > 0
      || (me().totalKills ?? 0) > 0
      || (me().totalGold ?? 0) > 0;
    if (curConfirmed && !earnedRewards) {
      transit = true;
    } else {
      const actions = soloProof([...session.actionLog, { type: "gate" }]);
      settlement = {
        results: {
          survived: true,
          xp: me().totalXp,
          gold: me().totalGold,
          kills: me().totalKills,
        },
        actions,
      };
    }
  }

  // Now that we know what this move will carry, check it against the rules
  // the GSP applies to exactly that shape.  Validating before this point
  // could only ever guess -- which is how "in a channel with no settlement"
  // and "transit out of a provisional segment" used to reach the chain and
  // come back as an unexplained rejection.
  const plan = { hasSettlement: settlement !== undefined, transit };
  if (!handleValidation(validateGateWalk(ctx, dir, plan))) return;

  const wasInChannel = channelSession;
  const sourceSeg = ctx.player.segment;
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
    const outcome = await waitForMove(connection, ({ player }) => {
      if (!player) return false;
      if (player.in_channel && player.active_visit
          && player.active_visit.visit_id !== beforeVisitId) {
        return true;
      }
      if (!isHub(sourceSeg)
          && isHub(player.segment)
          && !player.in_channel) {
        return true;
      }
      return false;
    });

    if (outcome !== "applied") {
      reportMoveOutcome(
        outcome, "gate walk",
        () => validateGateWalk(validatorContext()!, dir, plan),
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
    hubBuiltAtHub = false;

    const p = connState.player!;
    if (p.in_channel && p.active_visit) {
      // Entered a new channel — load that segment's dungeon.  When we just
      // DISCOVERED the segment, its details arrive a poll or two after the
      // player state, so wait briefly for the cache to populate rather than
      // giving up (which leaves session=null and lets a poll pop the
      // reconnect modal, desyncing the run and rejecting the next gate-walk).
      const newSegId = p.active_visit.segment;
      let segInfo = connState.segments.get(segKey(newSegId));
      for (let i = 0; i < 25 && !segInfo; i++) {
        await new Promise((r) => setTimeout(r, 200));
        segInfo = connState?.segments.get(segKey(newSegId));
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
          `The frontend doesn't have segment ${segName(newSegId)} cached. Reconnect to refresh.`,
        );
      }
    } else if (isHub(p.segment)) {
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

    // Registration can take several blocks to become visible on the hosted
    // stack (name mint + the {r} move + the background miner advancing the
    // height), and the watcher's `startHeight` is already stale by the time we
    // begin watching. The 2-block rejection heuristic therefore produces false
    // negatives here, so wait for the player to appear on a time budget (never
    // declaring rejection from the block count), then re-check authoritatively
    // once before reporting failure. A genuinely taken name is caught earlier:
    // the proxy rejects the submission and we land in the catch block below.
    const outcome = await waitForMove(
      connection,
      ({ player }) => player !== null,
      { blocks: Infinity, timeoutMs: 20000 },
    );

    let registered = outcome === "applied";
    if (!registered) registered = (await connection.refreshPlayer()) !== null;

    if (registered) {
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
    camera.centerOn(me().x, me().y);
  }
  render();
}
window.addEventListener("resize", resize);
resize();

// --- Render ---

function render(): void {
  if (mode === "overworld") {
    if (mapTab === "dungeon") {
      // The Dungeon tab reflects a real dungeon run only; the hub and the
      // no-session state fall through to the renderer's placeholder.
      drawDungeonMap(ctx, channelSession ? session : null,
        channelSession ? fov : null, canvas.width, canvas.height,
        coop ? coop.me : 0);
    } else {
      renderOverworld();
    }
  } else {
    renderDungeon();
  }
}

/**
 * The segment the player is actually located in.  While in a channel the
 * dungeon being played is `active_visit.segment`, which can differ from
 * `current_segment` (the overworld node the player is based at) — the tile
 * view loads the visit's segment, so the map and sidebar must agree.
 */
function playerLocationSegment(p: PlayerInfo): SegmentRef {
  return p.in_channel && p.active_visit ? p.active_visit.segment : p.segment;
}

function renderOverworld(): void {
  const p = connState?.player;
  const currentSeg = p ? playerLocationSegment(p) : HUB;
  // Snap back to the current segment when it changes while following, so the
  // view tracks the player between segments (any stray pan is cleared).
  if (mapFollow && !sameSeg(currentSeg, followSeg)) {
    panX = 0;
    panY = 0;
  }
  followSeg = currentSeg;
  // Presence tokens for OTHER players, keyed by the segment they are on
  // (from the on-chain world state).  The current player is already shown
  // via the "@" marker, so exclude self here.
  const presence = new Map<string, PlayerMarker[]>();
  const selfName = connState?.playerName;
  for (const pl of connState?.fullState?.players ?? []) {
    if (pl.name === selfName) continue;
    if (!overworldNodes.has(segKey(pl.segment))) continue;
    const arr = presence.get(segKey(pl.segment)) ?? [];
    arr.push({ name: pl.name, inChannel: pl.in_channel });
    presence.set(segKey(pl.segment), arr);
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
    } else if (!connState.player.in_channel && !isHub(connState.player.segment)) {
      // Standing at a segment, out of any run: where a co-op survivor is
      // left, and where a host waits for a partner.
      line1 = `You are standing at ${segName(connState.player.segment)}.`;
      line2 = "Press M for the map, or open Co-op to start a run here.";
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
  if (coop) {
    for (let i = 0; i < session.players.length; i++) {
      if (i === coop.me) continue;
      const q = session.players[i];
      if (q.dead || q.exited || !fov.isVisible(q.x, q.y)) continue;
      drawPartner(ctx, camera, q.x, q.y);
    }
  }
  drawPlayer(ctx, camera, me().x, me().y);

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
  if (coop) {
    handleCoopInput(action, dir);
    return;
  }
  if (coopSolo) {
    handleSoloSuffixInput(action, dir);
    return;
  }

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
    fov.update(me().x, me().y, session.dungeon);
    camera.centerOn(me().x, me().y);
    render();
    updateSidebar();
    persistRun();
    saveCurrentFog();

    // If a "move" landed us on a gate (hub OR real dungeon), ask for
    // confirmation before settling/transiting.  Easy to step on a gate
    // by accident.  (Enter-on-a-gate is handled directly above.)
    if (action === "move") {
      const gate = gateAtPlayer();
      // An armed intent takes precedence over the confirmation dialog: the
      // player already decided, back when they armed it.
      if (gate && !fireArmedIntent(gate.direction)) confirmGateWalk(gate.direction);
    }
  }
}

new InputHandler(handleGameInput);

/** Returns the gate at the player's current position, or null. */
function gateAtPlayer(): { x: number; y: number; direction: string } | null {
  if (!session) return null;
  for (const g of session.dungeon.gates) {
    if (g.x === me().x && g.y === me().y) return g;
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
  if (inCoopLobby()) return;

  // Build a context-appropriate message based on what's on the other
  // side of the gate.
  let detail = "";
  const curSeg = p.segment;

  // A gate always opens onto the cell next door.
  const target = neighbour(curSeg, dir);
  const targetInfo = connState?.segments.get(segKey(target));

  if (!isHub(target) && !targetInfo) {
    const remaining = discoveryCooldownRemaining(p, connState?.currentHeight ?? 0);
    if (remaining > 0) {
      detail = `Discovers a new dungeon (currently on cooldown — wait ${remaining} block${remaining === 1 ? "" : "s"}).`;
    } else {
      detail = `Discovers a new dungeon (50-block cooldown will apply after).`;
    }
  } else if (isHub(target)) {
    detail = `Returns you to the hub (0, 0).`;
  } else {
    const status = targetInfo!.confirmed
        ? "depth " + targetInfo!.depth
        : `depth ${targetInfo!.depth}, provisional`;
    detail = `Enters ${segName(target)} (${status}).`;
  }

  // Co-op happens at a gate: the segment on the other side is where you
  // would meet someone, and it has to be one somebody has already cleared
  // (the frontier stays solo).  Walking through alone is always an option.
  const coopOk = !!moves && !isHub(target) && !!targetInfo?.confirmed
    && !inCoopVisitNow();
  const joins = coopOk
    ? joinableVisits(curSeg).filter(j => sameSeg(j.visit.segment, target))
    : [];

  if (!coopOk) {
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
    return;
  }

  const choices = [
    {
      label: "Go through alone",
      detail,
      onPick: () => doGateWalk(dir),
    },
    ...joins.map(j => {
      const duel = j.visit.mode === "duel";
      const stake = j.visit.stake ?? 0;
      // What the host will actually accept.  Stakes need not match, so the
      // bar is their floor, not their own ante.
      const floor = j.visit.min_stake ?? stake;
      const gold = connState?.player?.gold ?? 0;
      const affordable = !duel || gold >= floor;
      return {
        label: duel
          ? `Duel ${j.visit.initiator}`
          : `Join ${j.visit.initiator}'s run`,
        // The joiner sees the mode and what it will cost BEFORE joining, and
        // is told when they cannot cover it rather than having the move
        // silently rejected on chain (spec section 9).
        detail: duel
          ? (affordable
              ? `A fight, not a run. They staked ${stake} and will accept ` +
                `${floor === 0 ? "any stake at all" : `${floor} or more`}; ` +
                `the winner takes the whole pot and walking out through a ` +
                `gate concedes. You hold ${gold} gold.`
              : `They will not take less than ${floor} and you hold ${gold}.`)
          : `${j.visit.players} of ${j.visit.max_players} waiting to go into ${segName(target)}.`,
        disabled: !affordable,
        onPick: () => {
          if (duel) showJoinStakeModal(j.visit.id, dir, stake, floor, gold);
          else void doCoopJoin(j.visit.id, dir);
        },
      };
    }),
    {
      label: "Wait here for a partner",
      detail: `Opens a co-op run in ${segName(target)}. Anyone standing next to it can walk in and join you.`,
      onPick: () => { void doCoopHost(dir); },
    },
    {
      label: "Wait here for a duel",
      detail: `Opens a 1v1 duel in ${segName(target)}. You stake gold, the ` +
              `challenger matches it, and the last one standing takes the pot.`,
      onPick: () => { showDuelStakeModal(dir); },
    },
  ];

  showChoiceModal({
    title: `The ${dir} gate`,
    message: `${segName(target)} is on the other side.`,
    choices,
    cancelLabel: "Stay",
  });
}

document.addEventListener("keydown", (e) => {
  if (isEditableTarget(e.target)) return;
  if (e.key === "Escape") {
    // A dialog opened from inside the game modal owns Escape: without this
    // both handlers fire and one keypress closes the dialog AND the modal
    // it was opened from.
    if (document.getElementById("modal-root")) return;
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
  if (mode === "overworld" && mapTab === "world" && e.key.toLowerCase() === "c") {
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
      {
        // The coordinate round-trips through DOM data attributes here, so
        // treat anything non-numeric as a broken button rather than
        // building a NaN coordinate that silently matches no segment.
        const bx = Number(target.dataset.segX);
        const by = Number(target.dataset.segY);
        if (Number.isInteger(bx) && Number.isInteger(by)) {
          doEnterChannel({ x: bx, y: by });
        }
      }
      break;
    case "exit-channel":
      doExitChannel();
      break;
    case "coop-host":
      doCoopHost(target.dataset.dir!);
      break;
    case "duel-host":
      // Same host move with a stake attached; the modal picks the amount
      // and filters it to what this player can actually cover.
      showDuelStakeModal(target.dataset.dir!);
      break;
    case "coop-arm-host":
      armIntent({ kind: "host", dir: target.dataset.dir!,
                  seg: { x: Number(target.dataset.segX), y: Number(target.dataset.segY) },
                  from: connState!.player!.segment });
      break;
    case "coop-arm-duel":
      // The stake is chosen now, while the player is thinking about it, and
      // travels with the armed intent.
      showDuelStakeModal(target.dataset.dir!, {
        x: Number(target.dataset.segX), y: Number(target.dataset.segY),
      });
      break;
    case "coop-arm-join":
      {
        const base = {
          kind: "join" as const, dir: target.dataset.dir!,
          seg: { x: Number(target.dataset.segX), y: Number(target.dataset.segY) },
          from: connState!.player!.segment,
          visitId: Number(target.dataset.visit), who: target.dataset.who,
        };
        if (target.dataset.duel === "1") {
          // Decide the amount now, while they are thinking about it; it
          // travels with the intent and fires at the gate.
          showAmountModal({
            title: "Duel for how much?",
            message:
              `They staked ${target.dataset.stake} and will accept ` +
              `${Number(target.dataset.floor) === 0 ? "anything" : target.dataset.floor + " or more"}. ` +
              `The winner takes the whole pot. This is sealed now and put up ` +
              `when you reach the gate.`,
            label: "Your stake",
            min: Number(target.dataset.floor),
            max: connState?.player?.gold ?? 0,
            initial: Number(target.dataset.floor),
            confirmLabel: "Arm it",
            cancelLabel: "Never mind",
            onConfirm: (stake) => armIntent({ ...base, stake }),
          });
        } else {
          armIntent(base);
        }
      }
      break;
    case "coop-disarm":
      disarmIntent();
      break;
    case "coop-join":
      if (target.dataset.duel === "1") {
        showJoinStakeModal(
          Number(target.dataset.visit), target.dataset.dir!,
          Number(target.dataset.stake), Number(target.dataset.floor),
          connState?.player?.gold ?? 0);
      } else {
        doCoopJoin(Number(target.dataset.visit), target.dataset.dir!);
      }
      break;
    case "coop-leave":
      doCoopLeave(Number(target.dataset.visit));
      break;
    case "coop-exit":
      {
        const g = gateAtPlayer();
        if (g) confirmCoopExit(g.direction);
      }
      break;
    case "coop-leave-options":
      showLeaveOptionsModal();
      break;
    case "coop-settle-retry":
      if (coopSolo) void coopSoloSettle(); else void coopSettle();
      break;
    case "coop-abandon":
      continueAlone();
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
    case "equip-local":
      equipLocal(Number(target.dataset.rowid), target.dataset.slot!);
      break;
    case "unequip-local":
      unequipLocal(Number(target.dataset.rowid));
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

// Maximum number of BAG-slot rows a player can hold.  Must match the GSP's
// MAX_INVENTORY (items.cpp / moveprocessor.cpp): equipped/worn gear does NOT
// count against it, and it counts rows (distinct stacks), not quantities.
// Loot beyond this cap is silently left behind at settlement, so the UI warns
// before that happens.
const MAX_INVENTORY = 50;

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
type ModalTab = "inventory" | "character" | "players" | "coop" | "help";
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

  // On-chain inventory is the truth at the hub.  Equip/use/discard there are
  // chain moves the GSP rejects mid-channel.  Inside a dungeon the settled
  // loadout is instead mutated LOCALLY (me().equipped/bag) as a replayed
  // action, so the bag/equipped view is driven by the live session and the
  // buttons fire local equip/unequip (not on-chain moves).
  const interactive = !!moves && !p.in_channel && !busy;
  const inRun = !!(channelSession && session && p.in_channel);

  const chainQty = new Map<number, number>();
  for (const it of p.inventory) chainQty.set(it.rowid, it.quantity);

  // Potions drunk during this run are consumed from the live session
  // immediately, but the on-chain stack does not shrink until settlement.
  // Count uses per item id (from the replayed action log) so the bag row can
  // show the pending drop instead of a stale count.
  const usedThisRun = new Map<string, number>();
  if (inRun && session) {
    for (const a of session.actionLog)
      if (a.type === "use" && a.itemId)
        usedThisRun.set(a.itemId, (usedThisRun.get(a.itemId) ?? 0) + 1);
  }

  interface InvRow { rowid: number; itemId: string; quantity: number; }
  const equipped = new Map<string, InvRow>();
  const bag: InvRow[] = [];
  if (inRun && session) {
    for (const [slot, e] of me().equipped)
      equipped.set(slot, { rowid: e.rowid, itemId: e.itemId, quantity: 1 });
    for (const b of me().bag)
      bag.push({ rowid: b.rowid, itemId: b.itemId, quantity: chainQty.get(b.rowid) ?? 1 });
  } else {
    for (const it of p.inventory)
      if (it.slot !== "bag") equipped.set(it.slot, { rowid: it.rowid, itemId: it.item_id, quantity: it.quantity });
    for (const it of p.inventory)
      if (it.slot === "bag") bag.push({ rowid: it.rowid, itemId: it.item_id, quantity: it.quantity });
  }

  const equipHtml = EQUIP_SLOTS.map(s => {
    const it = equipped.get(s.slot);
    if (!it) {
      return `<div class="inv-slot inv-slot-empty">
        <span class="inv-slot-icon">${s.icon}</span>
        <span class="inv-slot-label">${s.label}</span>
        <span class="inv-empty">empty</span></div>`;
    }
    const stat = itemStatLine(it.itemId);
    // Hub: on-chain unequip.  Mid-run: local, replayed unequip (costs a turn).
    const unequipBtn = interactive
      ? `<button class="inv-btn unequip" data-action="unequip" data-rowid="${it.rowid}">Unequip</button>`
      : inRun
        ? `<button class="inv-btn unequip" data-action="unequip-local" data-rowid="${it.rowid}">Unequip</button>`
        : "";
    return `<div class="inv-slot">
      <span class="inv-slot-icon">${itemIcon(it.itemId)}</span>
      <span class="inv-slot-label">${s.label}</span>
      <span class="inv-item-name" style="color:${itemColor(it.itemId)}">${itemName(it.itemId)}</span>
      ${stat ? `<span class="inv-stat">${stat}</span>` : ""}
      ${unequipBtn}</div>`;
  }).join("");

  const bagHtml = bag.length === 0
    ? '<div class="inv-empty">Bag is empty</div>'
    : bag.map(it => {
        const def = lookupItem(it.itemId);
        const canEquip = def && def.slot !== "" && def.type !== "potion" && def.type !== "misc";
        const canUse = def && def.type === "potion";
        const stat = itemStatLine(it.itemId);
        let btns: string;
        if (interactive) {
          btns = [
            canEquip ? `<button class="inv-btn equip" data-action="equip" data-rowid="${it.rowid}" data-slot="${def!.slot}">Equip</button>` : "",
            canUse ? `<button class="inv-btn use" data-action="use-item" data-item="${it.itemId}">Use</button>` : "",
            `<button class="inv-btn discard" data-action="discard" data-rowid="${it.rowid}">Drop</button>`,
          ].join("");
        } else if (inRun) {
          // Mid-run: equipping SETTLED bag gear is a local, replayed action
          // (immediate this run, settles with the exit proof); drinking a
          // potion is the same local action the P key does.  Dropping stays
          // hub-only.  This-run finds (the pending list below) are NOT here.
          btns = [
            canEquip ? `<button class="inv-btn equip" data-action="equip-local" data-rowid="${it.rowid}" data-slot="${def!.slot}">Equip</button>` : "",
            canUse ? `<button class="inv-btn use" data-action="use-potion-local">Drink</button>` : "",
          ].join("");
        } else {
          btns = p.in_channel && canUse
            ? `<button class="inv-btn use" data-action="use-potion-local">Drink</button>`
            : "";
        }
        // Reflect this-run potion consumption: the drink is already applied
        // in the live session but the on-chain stack does not shrink until
        // settlement, so show the remaining count plus a pending badge.
        const used = usedThisRun.get(it.itemId) ?? 0;
        const remaining = Math.max(0, it.quantity - used);
        const qty = remaining !== 1 ? ` x${remaining}` : "";
        const usedBadge = used > 0
          ? `<span class="inv-pending-badge">${used} used this run, settles on exit</span>`
          : "";
        return `<div class="inv-row">
          <span class="inv-item-icon">${itemIcon(it.itemId)}</span>
          <span class="inv-item-name" style="color:${itemColor(it.itemId)}">${itemName(it.itemId)}${qty}</span>
          ${stat ? `<span class="inv-stat">${stat}</span>` : ""}
          ${usedBadge}
          <span class="inv-row-actions">${btns}</span></div>`;
      }).join("");

  // Pending finds collected during the current run (settle on a winning exit).
  let pendingHtml = "";
  if (channelSession && session && me().collected.length > 0) {
    const rows = me().collected.filter(c => c.quantity > 0).map(c =>
      `<div class="inv-row inv-pending">
        <span class="inv-item-icon">${itemIcon(c.itemId)}</span>
        <span class="inv-item-name" style="color:${itemColor(c.itemId)}">${itemName(c.itemId)}${c.quantity > 1 ? ` x${c.quantity}` : ""}</span>
        <span class="inv-stat">${itemStatLine(c.itemId)}</span></div>`).join("");
    pendingHtml = `<div class="inv-pending-box">
      <div class="inv-pending-title">Collected this run (not saved until you exit through a gate)</div>
      ${rows}</div>`;
  }

  const note = p.in_channel
    ? '<div class="inv-note">Mid-run you can equip settled gear from your bag and drink potions; both take effect immediately (each costs a turn) and settle when you exit through a gate. Items collected this run cannot be equipped until they settle back at the hub.</div>'
    : "";

  // Bag capacity: count settled BAG-slot rows only (equipped gear is exempt,
  // matching the GSP).  Project how many NEW rows this-run pickups would need
  // at settlement (a pickup that stacks onto an existing bag row needs none),
  // so we can warn before loot is silently left behind at the cap.
  const bagRows = p.inventory.filter(i => i.slot === "bag");
  const bagCount = bagRows.length;
  let projectedNewRows = 0;
  if (inRun && session) {
    const seen = new Set(bagRows.map(i => i.item_id));
    for (const c of me().collected) {
      if (c.quantity <= 0) continue;
      if (!seen.has(c.itemId)) { projectedNewRows++; seen.add(c.itemId); }
    }
  }
  const bagFull = bagCount >= MAX_INVENTORY;
  const willOverflow = bagCount + projectedNewRows > MAX_INVENTORY;
  const capClass = bagFull || willOverflow ? " inv-cap-full" : "";
  const capWarning = (bagFull || (inRun && willOverflow))
    ? `<div class="inv-warning">Bag full: extra loot will be left behind when you settle. Drop or equip items (manage your bag at the hub).</div>`
    : "";

  return `
      ${note}
      ${capWarning}
      <div class="inv-body">
        <div class="inv-bag">
          <div class="inv-col-title">Bag: <span class="inv-cap${capClass}">${bagCount} / ${MAX_INVENTORY}</span></div>
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
    if (isHub(pl.segment)) {
      loc = "Hub";
    } else {
      loc = segName(pl.segment);
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
  const active = players
      .filter(p => p.in_channel || !isHub(p.segment)).sort(youFirst);
  const idle = players
      .filter(p => !p.in_channel && isHub(p.segment)).sort(youFirst);

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

// --- Co-op tab ---

/**
 * The co-op lobby.  Co-op is local: you meet someone by walking into the
 * same segment through your own gates, so this only ever lists the runs
 * reachable from where you are standing (backend spec section 8a).
 */
/**
 * Where a gate sits on the tile map, as a parenthetical.  A direction alone
 * is not much help when you are standing in a corridor somewhere in an 80x40
 * grid and the gate is one tile on one edge.
 */
function gateHint(dir: string): string {
  const g = session?.dungeon.gates.find(x => x.direction === dir);
  if (!g) return "";
  const edge = dir === "north" ? "top edge"
    : dir === "south" ? "bottom edge"
    : dir === "east" ? "right edge" : "left edge";
  return ` (${edge}, around x ${g.x}, y ${g.y})`;
}

/* ---- Armed intent: decide now, act when you reach the gate -------------
 *
 * Opening or joining a run from inside another run has to leave through one
 * specific gate, because the move carries that run's settlement.  Presenting
 * that as a dead grey button was a false affordance: the player had to close
 * the tab, walk, and then find a different dialog.  Arming lets them decide
 * here and have it fire on arrival.  Everything about it is visible while
 * they walk (a sidebar banner with the gate's location and a cancel), so the
 * one thing it must never do is leave someone wondering why nothing
 * happened.
 */
interface ArmedIntent {
  kind: "host" | "duel" | "join";
  dir: string;
  seg: SegmentRef;
  /** Where it was armed; leaving that segment retires it. */
  from: SegmentRef;
  visitId?: number;
  stake?: number;
  /** Duel host only: the least a challenger may put up. */
  minStake?: number;
  who?: string;
}
let armedIntent: ArmedIntent | null = null;

/**
 * Retires an intent that can no longer fire, saying why.  Nothing here is
 * cosmetic: an intent that silently cannot happen is exactly the "why is
 * nothing happening" trap this feature exists to avoid.
 */
function validateArmedIntent(): void {
  const a = armedIntent;
  if (!a) return;
  const p = connState?.player;
  if (!session || !p) { armedIntent = null; return; }
  if (!sameSeg(p.segment, a.from)) {      // left the segment it belonged to
    armedIntent = null;
    return;
  }
  if (a.kind === "join") {
    const v = connState?.fullState?.visits?.find(x => x.id === a.visitId);
    if (!v || v.status !== "open") {
      armedIntent = null;
      session.addMessage(
        `${a.who ?? "That run"} is no longer waiting in ${segName(a.seg)}, so the armed join was cancelled.`,
        "warning");
    }
  }
}

function armIntent(intent: ArmedIntent): void {
  armedIntent = intent;
  session?.addMessage(describeArmed(intent) + " Cancel it from the sidebar.", "info");
  updateSidebar();
  render();
}

function disarmIntent(quiet = false): void {
  if (!armedIntent) return;
  const was = armedIntent;
  armedIntent = null;
  if (!quiet) session?.addMessage(`Cancelled: ${armedLabel(was)} in ${segName(was.seg)}.`, "info");
  updateSidebar();
}

function armedLabel(a: ArmedIntent): string {
  return a.kind === "duel" ? "a duel"
    : a.kind === "join" ? `joining ${a.who ?? "that run"}`
    : "a co-op run";
}

function describeArmed(a: ArmedIntent): string {
  return `Ready: ${armedLabel(a)} in ${segName(a.seg)}, the moment you step on ` +
    `your ${a.dir} gate${gateHint(a.dir)}. Your current run settles on the way out.`;
}

/**
 * Fires a matching armed intent on arrival at `dir`.  Returns true when it
 * fired, so the caller skips whatever dialog it would otherwise have shown.
 */
function fireArmedIntent(dir: string): boolean {
  const a = armedIntent;
  if (!a || a.dir !== dir) return false;
  armedIntent = null;
  if (a.kind === "join" && a.visitId !== undefined)
    void doCoopJoin(a.visitId, dir, a.stake);
  else if (a.kind === "duel") void doCoopHost(dir, a.stake ?? 0, a.minStake);
  else void doCoopHost(dir);
  updateSidebar();
  return true;
}

/** Sidebar banner for an armed intent, shown wherever the player is looking. */
function armedBannerHtml(): string {
  const a = armedIntent;
  if (!a) return "";
  return `<div style="margin-top:6px;padding:6px 8px;border:1px solid #66a;border-radius:4px;background:#1b1b28">
    <div style="color:#aaf;font-size:11px;font-weight:bold">Armed: ${armedLabel(a)} in ${segName(a.seg)}</div>
    <div style="color:#999;font-size:10px">Walk onto your ${a.dir} gate${gateHint(a.dir)}. It opens by itself when you get there; your current run settles on the way out.</div>
    <button data-action="coop-disarm" class="action-btn" ${busy ? "disabled" : ""}>Cancel</button>
  </div>`;
}

function renderCoopTabBody(): string {
  const p = connState?.player;
  if (!p) {
    return `<div class="players-wrap"><div class="inv-empty">Connect to see co-op runs.</div></div>`;
  }
  const intro =
    `<div class="players-subtitle">Two players, one dungeon: each round is one action each, then the monsters move. ` +
    `Kill rewards are split by the damage each of you dealt. You meet by walking into the same segment ` +
    `through your own gates, so you have to be standing next to it.</div>`;

  // Already in a visit: waiting, or playing.
  if (p.active_visit && inCoopVisitNow()) {
    const v = coopVisit;
    const vid = p.active_visit.visit_id;
    const where = segName(p.active_visit.segment);
    if (!v || v.status === "open") {
      const count = v ? v.participants.length : 1;
      const max = connState?.segments.get(segKey(p.active_visit.segment))?.max_players ?? 2;
      const isHost = !v || v.initiator === p.name;
      const who = v && v.participants.length > 0 ? v.participants.join(", ") : p.name;
      return `<div class="players-wrap">
        ${intro}
        <div class="players-section-title">Waiting in ${where}</div>
        <div class="coop-panel">
          <div>Run #${vid}, ${count} of ${max} players: ${who}</div>
          <div class="coop-dim">It starts by itself as soon as the party is full. Anyone standing next to ${where} can walk in.</div>
          <button data-action="coop-leave" data-visit="${vid}" class="action-btn" ${busy ? "disabled" : ""}>${isHost ? "Cancel run" : "Leave run"}</button>
        </div>
      </div>`;
    }
    // Mid-run this tab used to be a dead end: it named the run and told you
    // to close it again.  It is the obvious place to look for the way out,
    // so the leave control lives here as well as on the run panel.
    const live = coop ?? coopSolo;
    const duelRun = !!session?.isDuel();
    const stuck = coop?.transportError ?? null;
    const canLeave = !!live && !!session && !session.gameOver
      && !me().dead && !me().exited;
    const leaveBtn = canLeave
      ? `<button data-action="coop-leave-options" class="action-btn ${
          duelRun ? "action-duel" : "action-enter"}" ${busy ? "disabled" : ""}>${
          duelRun ? "Leave the duel\u2026" : "Leave the run\u2026"}</button>`
      : "";
    const standing = !live
      ? "Starting..."
      : session?.gameOver
        ? "The run is over and settling on chain."
        : me().exited
          ? "You are out through a gate. The run settles once everyone else is done."
          : me().dead
            ? "You are down. The run settles once everyone else is done."
            : "Close this and press M to get back to the dungeon.";
    const stuckLine = stuck
      ? `<div style="color:#c44;font-size:11px">The relay is refusing this client (${stuck}), so the run cannot advance.</div>`
      : "";
    return `<div class="players-wrap">
      ${intro}
      <div class="players-section-title">${duelRun ? "Duelling in" : "Running"} ${where}</div>
      <div class="coop-panel${duelRun ? " coop-panel-duel" : ""}">
        <div>Run #${vid} is under way with ${v.participants.join(", ")}.</div>
        <div class="coop-dim">${standing}</div>
        ${stuckLine}
        ${leaveBtn}
      </div>
    </div>`;
  }

  const here = isHub(p.segment) ? "the hub" : segName(p.segment);
  const targets = coopTargets(p.segment);
  const joins = joinableVisits(p.segment);
  const onGate = p.in_channel ? gateAtPlayer()?.direction ?? null : null;

  let joinHtml = "";
  if (joins.length > 0) {
    joinHtml = `<div class="players-section-title">Waiting for you (${joins.length})</div>` +
      joins.map(j => {
        const blocked = p.in_channel && onGate !== j.dir;
        // A duel is not a run, and the panel must not let anyone walk into
        // a staked fight thinking it is one: mode, stake and affordability
        // are shown BEFORE the click, exactly as the gate modal does.
        const duel = j.visit.mode === "duel";
        const stake = j.visit.stake ?? 0;
        const floor = j.visit.min_stake ?? stake;
        const gold = p.gold ?? 0;
        const poor = duel && gold < floor;
        const head = duel
          ? `<strong>${j.visit.initiator}</strong> is waiting to duel in ${segName(j.visit.segment)}`
          : `<strong>${j.visit.initiator}</strong> is waiting in ${segName(j.visit.segment)} (${j.visit.players}/${j.visit.max_players})`;
        const why = duel
          ? (poor
              ? `They will not take less than ${floor} and you hold ${gold}.`
              : `A fight, not a run. They staked ${stake} and will accept ` +
                `${floor === 0 ? "any stake at all" : `${floor} or more`}; ` +
                `the winner takes the whole pot and walking out concedes.`)
          : `Through your ${j.dir} gate.`;
        return `<div class="coop-panel${duel ? " coop-panel-duel" : ""}">
          <div>${head}</div>
          <div class="coop-dim">${why}${blocked ? ` You are mid-run here: walk onto your ${j.dir} gate${gateHint(j.dir)} and this goes live.` : ""}</div>
          ${armedIntent?.kind === "join" && armedIntent.visitId === j.visit.id
            ? `<button data-action="coop-disarm" class="action-btn" ${busy ? "disabled" : ""}>Cancel</button>`
            : `<button data-action="${blocked ? "coop-arm-join" : "coop-join"}"
                 data-visit="${j.visit.id}" data-dir="${j.dir}"
                 data-seg-x="${j.visit.segment.x}" data-seg-y="${j.visit.segment.y}"
                 data-who="${j.visit.initiator}"
                 data-duel="${duel ? 1 : 0}" data-stake="${stake}" data-floor="${floor}"
                 class="action-btn action-enter" ${busy || poor ? "disabled" : ""}>${
                   blocked ? (duel ? "Duel at the gate" : "Join at the gate")
                           : (duel ? `Duel ${j.visit.initiator}` : `Join ${j.visit.initiator}`)}</button>`}
        </div>`;
      }).join("");
  }

  let hostHtml = "";
  if (targets.length > 0) {
    hostHtml = `<div class="players-section-title">Wait at a gate (${targets.length})</div>` +
      targets.map(t => {
        const blocked = p.in_channel && onGate !== t.dir;
        const off = busy ? "disabled" : "";
        const armedHere = armedIntent?.dir === t.dir && armedIntent.kind !== "join";
        return `<div class="coop-panel">
          <div><strong>${segName(t.seg)}</strong> through your ${t.dir} gate</div>
          <div class="coop-dim">${armedHere
            ? `Armed. It opens by itself when you step on your ${t.dir} gate${gateHint(t.dir)}.`
            : blocked
              ? `You are mid-run, so this settles your current run on the way out and has to ` +
                `leave by your ${t.dir} gate${gateHint(t.dir)}. Choose one and it fires when you get there.`
              : "Wait there for someone to walk in: as a partner, or as an opponent."}</div>
          ${armedHere
            ? `<button data-action="coop-disarm" class="action-btn" ${off}>Cancel</button>`
            : `<button data-action="${blocked ? "coop-arm-host" : "coop-host"}" data-dir="${t.dir}"
                 data-seg-x="${t.seg.x}" data-seg-y="${t.seg.y}"
                 class="action-btn action-enter" ${off}>${blocked ? "Co-op run at the gate" : "Co-op run"}</button>
               <button data-action="${blocked ? "coop-arm-duel" : "duel-host"}" data-dir="${t.dir}"
                 data-seg-x="${t.seg.x}" data-seg-y="${t.seg.y}"
                 class="action-btn action-duel" ${off}>${blocked ? "Duel at the gate" : "Duel"}</button>`}
        </div>`;
      }).join("");
  }

  const empty = (!joinHtml && !hostHtml)
    ? `<div class="inv-empty">No confirmed dungeon borders ${here}. Explore and clear a neighbouring segment first, then come back.</div>`
    : "";

  return `<div class="players-wrap">
    ${intro}
    <div class="players-header">You are at ${here}${p.in_channel ? " (in a run)" : ""}.</div>
    ${empty}${joinHtml}${hostHtml}
  </div>`;
}

// --- Character tab ---

/**
 * Cumulative XP threshold to reach `level`, mirroring the backend
 * XpForLevel(L) = floor(60 * L^1.35) in moveprocessor.cpp.  Display-only:
 * the on-chain `xp` field is the residual progress toward the NEXT level
 * (the GSP subtracts each threshold on level-up), so XP-to-next is
 * XpForLevel(level + 1) - xp.
 */
function xpForLevel(level: number): number {
  return Math.floor(60 * Math.pow(level, 1.35));
}

/**
 * Builds the Character tab body: name, level, XP progress toward the next
 * level, base and effective stats, HP, and gold (banked + this-run pending,
 * per the settled-vs-pending labelling).  Read-only.
 */
function renderCharacterTabBody(): string {
  const p = connState?.player;
  if (!p) {
    return `<div class="char-wrap"><div class="inv-empty">Connect and register to see your character.</div></div>`;
  }

  const nextThreshold = xpForLevel(p.level + 1);
  const xpToNext = Math.max(0, nextThreshold - p.xp);
  const xpPct = nextThreshold > 0
    ? Math.max(0, Math.min(100, p.xp / nextThreshold * 100)) : 0;

  const { hp: curHp, max: curMax } = effectiveHp();
  const hpPct = Math.max(0, curHp / curMax * 100);
  const hpColor = hpPct > 60 ? "#4a4" : hpPct > 30 ? "#aa4" : "#c44";

  const inRun = !!(channelSession && session && p.in_channel);
  const pendingGold = inRun && session ? me().totalGold : 0;
  const goldLine = pendingGold > 0
    ? `${p.gold} banked <span class="char-pending">(+${pendingGold} this run, settles on exit)</span>`
    : `${p.gold} banked`;

  const es = p.effective_stats;
  const statRow = (label: string, value: string) =>
    `<div class="char-stat"><span class="char-stat-label">${label}</span><span class="char-stat-value">${value}</span></div>`;
  // Full-width row that also shows where the number comes from.
  const statRowB = (label: string, value: string, note: string) =>
    `<div class="char-stat char-stat-wide"><span class="char-stat-label">${label}</span>` +
    `<span class="char-stat-value">${value}</span>` +
    `<span class="char-stat-note">${note}</span></div>`;

  // Effective loadout: the live session during a run (mid-run equips change
  // combat immediately and on-chain stats are stale until settlement), else
  // the on-chain effective stats.  Base attributes are the allocated values;
  // the gap between effective and base is the equipment contribution.
  const eff = (channelSession && session)
    ? { str: me().stats.strength, dex: me().stats.dexterity,
        con: me().stats.constitution, intl: me().stats.intelligence,
        equipAtk: me().stats.equipAttack, equipDef: me().stats.equipDefense,
        level: me().stats.level }
    : { str: es.strength, dex: es.dexterity, con: es.constitution,
        intl: es.intelligence, equipAtk: es.equip_attack, equipDef: es.equip_defense,
        level: p.level };
  const base = p.stats;
  const gearNote = (effVal: number, baseVal: number, effect: string) => {
    const g = effVal - baseVal;
    const src = g === 0 ? `${baseVal} base` : `${baseVal} base ${g > 0 ? "+" : ""}${g} gear`;
    return `${src}, ${effect}`;
  };
  const atk = eff.str + Math.floor(eff.level / 2) + eff.equipAtk;
  const def = Math.floor(eff.con / 2) + Math.floor(eff.level / 3) + eff.equipDef;
  const crit = 5 + Math.floor(eff.dex / 5);
  const dodge = Math.min(50, 5 + Math.floor(eff.dex * 0.5));
  const ptsHint = p.stat_points > 0
    ? `<span class="char-hint">${p.stat_points} unspent point${p.stat_points > 1 ? "s" : ""}: allocate at the hub</span>`
    : "";

  // Bag capacity: settled BAG-slot rows only (equipped gear is exempt).
  const bagCount = p.inventory.filter(i => i.slot === "bag").length;
  const bagValue = bagCount >= MAX_INVENTORY
    ? `<span class="inv-cap inv-cap-full">${bagCount} / ${MAX_INVENTORY} (full)</span>`
    : `${bagCount} / ${MAX_INVENTORY}`;

  return `
    <div class="char-wrap">
      <div class="char-header">
        <span class="char-name">${p.name}</span>
        <span class="char-level">Level ${p.level}</span>
      </div>

      <div class="char-xp">
        <div class="char-xp-bar">
          <div class="char-xp-fill" style="width:${xpPct}%"></div>
          <div class="char-xp-text">XP ${p.xp} / ${nextThreshold}</div>
        </div>
        <div class="char-xp-note">${xpToNext} XP to level ${p.level + 1}</div>
      </div>

      <div class="char-hp">
        <div class="hp-bar">
          <div class="hp-bar-fill" style="width:${hpPct}%; background:${hpColor}"></div>
          <div class="hp-bar-text">HP ${curHp} / ${curMax}</div>
        </div>
      </div>

      <div class="char-section-title">Attributes ${ptsHint}</div>
      <div class="char-grid">
        ${statRowB("Strength", String(eff.str), gearNote(eff.str, base.strength, "+1 Attack each"))}
        ${statRowB("Dexterity", String(eff.dex), gearNote(eff.dex, base.dexterity, "raises crit and dodge"))}
        ${statRowB("Constitution", String(eff.con), gearNote(eff.con, base.constitution, "raises Defense and Max HP"))}
        ${statRowB("Intelligence", String(eff.intl), gearNote(eff.intl, base.intelligence, "no combat effect yet"))}
      </div>

      <div class="char-section-title">Combat (derived)</div>
      <div class="char-grid">
        ${statRowB("Attack Power", String(atk), `${eff.str} Strength + ${Math.floor(eff.level / 2)} Level + ${eff.equipAtk} Weapon`)}
        ${statRowB("Defense", String(def), `${Math.floor(eff.con / 2)} from Constitution + ${Math.floor(eff.level / 3)} Level + ${eff.equipDef} Armor`)}
        ${statRowB("Max HP", String(curMax), `50 base + ${eff.con * 5} from Constitution`)}
        ${statRowB("Crit chance", `${crit}%`, "from Dexterity")}
        ${statRowB("Dodge chance", `${dodge}%`, "from Dexterity")}
      </div>

      <div class="char-section-title">Record</div>
      <div class="char-grid">
        ${statRow("Gold", goldLine)}
        ${statRow("Bag", bagValue)}
        ${statRow("Kills", String(p.combat_record.kills))}
        ${statRow("Deaths", String(p.combat_record.deaths))}
        ${statRow("Runs completed", String(p.combat_record.visits_completed))}
      </div>
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
        <div class="help-section">
          <div class="help-section-title">Co-op</div>
          <div class="help-row"><span class="help-keys"><span class="help-key-text">Where</span></span><span>Only in a dungeon someone has already cleared, next to where you stand</span></div>
          <div class="help-row"><span class="help-keys"><span class="help-key-text">Start</span></span><span>Walk onto a gate and choose "Wait here for a partner", or use the Co-op tab</span></div>
          <div class="help-row"><span class="help-keys"><span class="help-key-text">Join</span></span><span>Walk onto the gate facing their run and choose Join, from your own side</span></div>
          <div class="help-row"><span class="help-keys"><span class="help-key-text">Turns</span></span><span>Each round is one action each, then the monsters move</span></div>
          <div class="help-row"><span class="help-keys"><span class="help-key-text">Rewards</span></span><span>Kill XP and gold are pooled and split by the damage each of you dealt</span></div>
          <div class="help-row"><span class="help-keys"><span class="help-key-text">Leaving</span></span><span>Exit through any gate; the run keeps going for your partner until they leave or die</span></div>
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
      <button class="inv-foot" data-action="close-help">Close (or press Esc)</button>
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
 * `#game-modal` overlay appended to the body.  Closes on the ✕ button, on
 * the footer bar, on Esc and on a backdrop click: the footer matters because
 * a long tab puts the ✕ off the top of the screen once you have scrolled.
 * Tab buttons switch the active body without closing.
 */
function renderGameModal(): void {
  // Preserve the scroll position of the active tab body across re-renders.
  // The ~1s state poll re-renders the whole modal; without this, scrolling
  // the inventory (or any tab) snaps back to the top every poll.  Capture
  // scrollTop before wiping the old instance and restore it after mount.
  // The active scroll container may be NESTED (e.g. the inventory tab scrolls
  // .inv-body, not .modal-tab-body), so capture scrollTop of every scrollable
  // element in document order and restore onto the identically-rebuilt DOM.
  const prevModal = document.getElementById("game-modal");
  const prevScroll = prevModal
    ? Array.from(prevModal.querySelectorAll<HTMLElement>("*"))
        .filter(el => el.scrollHeight > el.clientHeight)
        .map(el => el.scrollTop)
    : [];

  document.getElementById("game-modal")?.remove();
  if (!activeModalTab) return;

  const tabs: Array<{ id: ModalTab; label: string }> = [
    { id: "inventory", label: "Inventory" },
    { id: "character", label: "Character" },
    { id: "players",   label: "Players" },
    { id: "coop",      label: "Co-op" },
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
    headerExtra = goldHeaderHtml();
    body = renderInventoryTabBody();
  } else if (activeModalTab === "character") {
    title = "Character";
    headerExtra = goldHeaderHtml();
    body = renderCharacterTabBody();
  } else if (activeModalTab === "players") {
    title = "Players";
    body = renderPlayersTabBody();
  } else if (activeModalTab === "coop") {
    title = "Co-op";
    body = renderCoopTabBody();
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
      <button class="inv-foot" data-action="close-modal">Close (or press Esc)</button>
    </div>`;
  // Backdrop click closes.
  root.addEventListener("click", (e) => {
    if (e.target === root) setModalTab(null);
  });
  document.body.appendChild(root);

  // Restore scroll onto the matching scrollable elements (same document order
  // as capture, since the tab rebuilds to an identical structure).
  if (prevScroll.length) {
    const scrollers = Array.from(root.querySelectorAll<HTMLElement>("*"))
      .filter(el => el.scrollHeight > el.clientHeight);
    scrollers.forEach((el, i) => { if (prevScroll[i] > 0) el.scrollTop = prevScroll[i]; });
  }
}

/**
 * Gold readout for the modal header: banked (on-chain) gold, plus this-run
 * unsettled gold when a channel session is live.  Settled vs pending is
 * spelled out in words so the two numbers are never confused.
 */
function goldHeaderHtml(): string {
  const p = connState?.player;
  if (!p) return "";
  const inRun = !!(channelSession && session && p.in_channel);
  const pending = inRun && session ? me().totalGold : 0;
  const pendingHtml = pending > 0
    ? ` <span class="inv-gold-pending">(+${pending} this run)</span>`
    : "";
  return `<span class="inv-gold">🪙 ${p.gold} banked${pendingHtml}</span>`;
}

// --- Sidebar updates ---

function updateSidebar(): void {
  validateArmedIntent();
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
  // Unambiguous location label: the hub is a named safe zone; every other
  // segment shows its world coordinates and depth.
  const locName = isHub(locSeg)
    ? "Safe Zone (Hub)"
    : `Segment ${segName(locSeg)} - Depth ${Math.abs(locSeg.x) + Math.abs(locSeg.y)}`;
  const locLabel = `${locName}${p.in_channel ? " · in dungeon" : ""}`;

  // Co-op: a compact status line in the sidebar; the lobby itself lives in
  // the Co-op tab of the game modal, which lists only the runs reachable
  // from where the player is standing.
  let coopLobby = "";
  if (hasProxy) {
    if (p.active_visit) {
      const v = coopVisit;
      const vid = p.active_visit.visit_id;
      const where = segName(p.active_visit.segment);
      const waiting = !v || v.status === "open";
      coopLobby = `
        <div style="margin-top:8px;border-top:1px solid #333;padding-top:8px">
          <div style="color:#8cc;font-weight:bold">Co-op run #${vid} \u00b7 ${where}</div>
          <div style="font-size:11px;color:#aaa">${waiting
            ? `Waiting for a partner (${v ? v.participants.length : 1}/${connState?.segments.get(segKey(p.active_visit.segment))?.max_players ?? 2}).`
            : (coop ? "Under way." : "Starting...")}</div>
          <button data-action="switch-tab" data-tab="coop" class="action-btn">Open co-op</button>
        </div>`;
    } else {
      const n = joinableVisits(p.segment).length;
      const t = coopTargets(p.segment).length;
      if (n > 0 || t > 0) {
        coopLobby = `
          <div style="margin-top:8px;border-top:1px solid #333;padding-top:8px">
            <div style="color:#8cc;font-weight:bold">Co-op</div>
            <div style="font-size:11px;color:#888">${n > 0
              ? `${n} run${n === 1 ? "" : "s"} you can walk into from here.`
              : `${t} neighbouring dungeon${t === 1 ? "" : "s"} you could start a run in.`}</div>
            <button data-action="switch-tab" data-tab="coop" class="action-btn action-enter">Open co-op</button>
          </div>`;
      }
    }
  }

  let selectedInfo = "";
  if (selectedSegment !== null) {
    const selNode = overworldNodes.get(segKey(selectedSegment));
    const isCurrent = sameSeg(selectedSegment, p.segment);

    const selCoord = segName(selectedSegment);
    selectedInfo = `<div style="margin-top:8px;border-top:1px solid #333;padding-top:8px">`;
    selectedInfo += `<div style="color:#aaf;font-weight:bold">${selCoord}</div>`;

    if (selNode) {
      selectedInfo += `<div class="stat-row"><span class="stat-label">Depth</span><span class="stat-value">${selNode.depth}</span></div>`;
      if (selNode.discoverer) {
        selectedInfo += `<div class="stat-row"><span class="stat-label">By</span><span class="stat-value">${selNode.discoverer}</span></div>`;
      }
    }

    if (isCurrent && !isHub(selectedSegment) && !p.in_channel) {
      selectedInfo += `<button data-action="enter-channel"
        data-seg-x="${selectedSegment.x}" data-seg-y="${selectedSegment.y}"
        class="action-btn action-enter" ${busy ? "disabled" : ""}>Enter Dungeon</button>`;
    }

    // No "Travel" button here: the map is a meta-view, not a place you move
    // on.  You travel by walking to a gate and stepping through it inside a
    // dungeon/hub session.  The old overworld `t` travel moved you to a
    // segment out-of-channel (a limbo with no session), which desynced the
    // view from the chain, so it is gone.

    selectedInfo += `</div>`;
  }

  // Discover buttons for directions without links from current segment.
  let discoverBtns = "";
  if (!p.in_channel && hasProxy) {
    const curNode = overworldNodes.get(segKey(p.segment));
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
  if (p.stat_points > 0 && !p.in_channel && !p.active_visit && hasProxy) {
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
  if (!p.in_channel && !p.active_visit && hasProxy && p.hp < p.max_hp) {
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

  // Recovery: if we are out-of-channel on a real (non-hub) segment, offer a
  // one-click way into that segment's dungeon.  Normal play never lands here
  // (gate-walk always enters a channel; the hub is the only out-of-channel
  // spot), so this only appears after an odd state and lets the player get
  // moving again (walk to a gate and step through to travel onward).
  let enterHereBtn = "";
  if (!p.in_channel && !isHub(p.segment) && hasProxy) {
    enterHereBtn = `<button data-action="enter-channel"
      data-seg-x="${p.segment.x}" data-seg-y="${p.segment.y}"
      class="action-btn action-enter" ${busy ? "disabled" : ""}>Enter Dungeon Here</button>`;
  }

  el.innerHTML = `
    <div><strong>${p.name}</strong> \u2014 Level ${p.level}</div>
    <div class="hp-bar">
      <div class="hp-bar-fill" style="width:${hpPct}%; background:${hpColor}"></div>
      <div class="hp-bar-text">HP ${p.hp} / ${p.max_hp}</div>
    </div>
    <div class="stat-row"><span class="stat-label">XP</span><span class="stat-value">${p.xp}</span></div>
    <div class="stat-row"><span class="stat-label">Gold</span><span class="stat-value">${p.gold} (banked)${channelSession && session && p.in_channel && me().totalGold > 0 ? ` (+${me().totalGold} this run)` : ""}</span></div>
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
    ${armedBannerHtml()}
    ${enterHereBtn}
    ${statBtns}
    ${potionBtn}
    ${discoverBtns}
    ${selectedInfo}
    ${coopLobby}
    ${busy ? '<div style="margin-top:6px;color:#aa8">Processing...</div>' : ""}
  `;
}

function updateOverworldInventory(): void {
  const el = document.getElementById("inventory-display")!;
  const p = connState?.player;
  const canMutate = !!moves && !p?.in_channel;

  if (!p) {
    el.innerHTML = '<div style="color:#666">Empty</div>';
    return;
  }

  // Sidebar shows equipped gear only; the (potentially long) bag is managed in
  // the Inventory modal (I).  A compact hint points there.
  const equipped = p.inventory.filter(i => i.slot !== "bag");
  const bagCount = p.inventory.filter(i => i.slot === "bag").length;

  const lines: string[] = [];
  if (equipped.length === 0) {
    lines.push('<div style="color:#666">Nothing equipped</div>');
  } else {
    for (const item of equipped) {
      const btn = canMutate
        ? `<button data-action="unequip" data-rowid="${item.rowid}" class="inv-btn" ${busy ? "disabled" : ""}>Unequip</button>`
        : "";
      lines.push(`<div class="inventory-item">
        <span>${itemIcon(item.item_id)} ${itemName(item.item_id)}</span>
        <span class="slot-equipped">[${item.slot}]</span>
        ${btn}
      </div>`);
    }
  }
  lines.push(`<div style="margin-top:6px;color:#888;font-size:11px">Bag: ${bagCount} / ${MAX_INVENTORY} (press I to manage)</div>`);
  el.innerHTML = lines.join("");
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
      lines.push(`<div class="msg-info">${pl.name} (Lv${pl.level}) @ seg ${pl.segment}</div>`);
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

  const hpPct = Math.max(0, me().hp / me().maxHp * 100);
  const hpColor = hpPct > 60 ? "#4a4" : hpPct > 30 ? "#aa4" : "#c44";

  let channelLabel = "";
  if (channelSession) {
    const segInfo = connState?.segments.get(segKey(channelSegment));
    const locName = isHub(channelSegment)
      ? "Safe Zone (Hub)"
      : `Segment ${segName(channelSegment)} - Depth ${segInfo?.depth ?? session.depth}`;
    channelLabel = `<div style="color:#aaf;font-size:11px">Location: ${locName}</div>`;
  }

  // Gold readout: in a channel run the on-chain banked gold and this-run
  // unsettled gold are labelled separately (they settle together on exit);
  // in a standalone dungeon there is no banked total, so show the run score.
  const bankedGold = connState?.player?.gold ?? 0;
  const goldLine = channelSession
    ? `Gold: ${bankedGold} banked (+${me().totalGold} this run, settles on exit)`
    : `Gold: ${me().totalGold} (this run)`;

/**
 * How a finished duel reads.  The winner is whoever is left when at most
 * one participant is active, which is NOT the same as "survived": a
 * conceder walked out through a gate and still lost, so this reads the
 * engine's latched winner rather than anyone's exit state.
 */
function duelOutcomeLine(): string {
  if (!session || !coop) return "Duel over.";
  const w = session.duelWinner;
  if (w < 0) return "Duel over.";
  const won = w === coop.me;
  const loser = session.players[w === 0 ? 1 : 0];
  const how = loser.exited ? "conceded" : "fell";
  return won
    ? `You win \u2014 ${coop.names[w === 0 ? 1 : 0]} ${how}. Settle to take the pot.`
    : `You ${how === "conceded" ? "conceded" : "lost"} \u2014 ${coop.names[w]} takes the pot.`;
}

  // Co-op: partner, turn state, projected reward shares, relay health.
  let coopBlock = "";
  if (coop) {
    const claims = computeClaims(session, coopVisit?.pot ?? 0);
    const rows = coop.names.map((n, i) => {
      const q = session!.players[i];
      const c = claims[i];
      const you = i === coop!.me ? " (you)" : "";
      if (session!.isDuel()) {
        // Both HP bars, because in a duel the opponent's health IS the
        // scoreboard -- there is no shared objective to report instead.
        const frac = q.maxHp > 0 ? Math.max(0, q.hp) / q.maxHp : 0;
        const state = q.dead ? "dead" : q.exited ? "conceded" : `${q.hp}/${q.maxHp}`;
        const colour = i === coop!.me ? "#6c6" : "#c66";
        return `<div class="stat-row"><span class="stat-label">${n}${you}</span>` +
               `<span class="stat-value">${state}</span></div>` +
               `<div style="height:4px;background:#222;margin:1px 0 3px">` +
               `<div style="height:4px;width:${(frac * 100).toFixed(0)}%;background:${colour}"></div></div>`;
      }
      const state = q.dead ? "dead" : q.exited ? `exited ${q.exitGate}` : `HP ${q.hp}/${q.maxHp}`;
      return `<div class="stat-row"><span class="stat-label">${n}${you}</span>` +
             `<span class="stat-value">${state} \u00b7 ${c.kills}K \u00b7 ~${c.xp}xp ~${c.gold}g</span></div>`;
    }).join("");
    const duel = session.isDuel();
    let turnLine: string;
    if (session.gameOver) turnLine = duel ? duelOutcomeLine() : "Run over.";
    else if (me().dead || me().exited) turnLine = "Spectating until the run ends.";
    else if (duel) {
      // A duel round asks for one choice and then runs itself, so the
      // phase is what the player needs to see -- "your move" would be a
      // lie during the reveal, when nothing is being asked of them.
      switch (coop.phaseLabel) {
        case "choose": turnLine = "Choose your move \u2014 both are sealed until revealed."; break;
        case "waiting for opponent": turnLine = "Sealed. Waiting for your opponent..."; break;
        case "revealing": turnLine = "Revealing..."; break;
        default: turnLine = "";
      }
    }
    else if (coop.hasPendingOwn && coop.transportError)
      turnLine = "Your action could not be sent; the run is stuck until the relay accepts it.";
    else if (coop.hasPendingOwn) turnLine = `Action sent; waiting for ${coop.waitingOn}...`;
    else if (coop.myTurn) turnLine = "Your move.";
    else turnLine = `Waiting for ${coop.waitingOn}...`;
    const relay = coop.transportError
      ? `<div style="color:#c44;font-size:11px">Relay: ${coop.transportError}</div>` : "";
    const cp = partnerCheckpoint();
    let cpLine = "";
    if (!session.gameOver) {
      if (!cp) cpLine = `<div style="color:#666;font-size:10px">Partner has no checkpoint on chain yet.</div>`;
      else if (cp.stale) {
        cpLine = `<div style="color:#c86;font-size:11px">${cp.name}'s last checkpoint (${cp.n} actions) is ${cp.age} blocks old.</div>` +
          `<button data-action="coop-abandon" class="action-btn" ${busy ? "disabled" : ""}>Continue alone from their checkpoint</button>`;
      } else {
        cpLine = `<div style="color:#666;font-size:10px">${cp.name}'s checkpoint: ${cp.n} actions, ${cp.age} block${cp.age === 1 ? "" : "s"} ago (abandon after ${ABANDON_WINDOW_BLOCKS}).</div>`;
      }
    }
    // Leaving a live run had no button at all: the only way out was to walk
    // onto a gate and press Enter, which nothing on screen ever said.  The
    // `coop-exit` handler existed but nothing rendered a control for it.
    let exitLine = "";
    if (!session.gameOver && !me().dead && !me().exited) {
      // Always present, whether or not a gate is underfoot: the modal is
      // where the routes out and their costs are spelled out.
      exitLine = `<button data-action="coop-leave-options" class="action-btn ${
        duel ? "action-duel" : "action-enter"}" ${busy ? "disabled" : ""}>${
        duel ? "Leave the duel\u2026" : "Leave the run\u2026"}</button>`;
    }
    const pot = coopVisit?.pot ?? 0;
    const header = duel
      ? `<div style="color:#c88;font-size:11px;font-weight:bold">Duel \u00b7 visit #${channelVisitId}` +
        (pot > 0 ? ` \u00b7 ${pot} gold pot` : " \u00b7 no stake") + `</div>`
      : `<div style="color:#8cc;font-size:11px;font-weight:bold">Co-op run \u00b7 visit #${channelVisitId}</div>`;
    const footnote = duel
      ? `<div style="color:#666;font-size:10px">Bump your opponent to attack. Leaving through a gate concedes the duel and the pot.</div>`
      : `<div style="color:#666;font-size:10px">Shares (~) are projected: kill XP and gold pools split by damage dealt, final at settlement.</div>`;
    coopBlock = `
      <div style="margin-top:6px;border-top:1px solid #333;padding-top:6px">
        ${header}
        ${rows}
        <div style="color:#aaa;font-size:11px">${turnLine}</div>
        ${exitLine}
        ${footnote}
        ${cpLine}
        ${relay}
      </div>`;
  } else if (coopSolo) {
    const claims = computeClaims(session, coopVisit?.pot ?? 0);
    const c = claims[coopSolo.me];
    coopBlock = `
      <div style="margin-top:6px;border-top:1px solid #333;padding-top:6px">
        <div style="color:#8cc;font-size:11px;font-weight:bold">Co-op run \u00b7 visit #${coopSolo.visitId} \u00b7 continuing alone</div>
        <div style="color:#aaa;font-size:11px">Partner left behind at action ${coopSolo.from}; reach a gate to settle.</div>
        <div class="stat-row"><span class="stat-label">Projected</span><span class="stat-value">${c.kills}K \u00b7 ~${c.xp}xp ~${c.gold}g</span></div>
        ${!session.gameOver && !me().dead && !me().exited
          ? `<button data-action="coop-leave-options" class="action-btn action-enter" ${busy ? "disabled" : ""}>Leave the run\u2026</button>`
          : ""}
      </div>`;
  }

  let endButtons = "";
  if (session.gameOver && (coop || coopSolo)) {
    if (coopSettleError) {
      endButtons = `
        <div style="margin-top:6px;color:#c44;font-size:11px">${coopSettleError}</div>
        <button data-action="coop-settle-retry" class="action-btn action-enter" ${busy ? "disabled" : ""}>Retry settlement</button>`;
    } else {
      endButtons = `<div style="margin-top:6px;color:#888;font-size:11px">${coopSolo ? "Settling alone on-chain..." : coop!.me === 0 ? "Settling on-chain (you submit once your partner confirms)..." : "Confirming on-chain; the host settles..."}</div>`;
    }
  } else if (session.gameOver) {
    if (channelSession) {
      // Survival exits are auto-settled by gw when the player walks
      // onto the gate.  Only deaths need a manual submit (gw refuses
      // survived=false; xc applies the death penalty).
      if (!me().exited) {
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
      <div class="hp-bar-text">HP ${me().hp} / ${me().maxHp}</div>
    </div>
    <div>XP: ${me().totalXp}</div>
    <div>${goldLine}</div>
    <div>Kills: ${me().totalKills} &nbsp; Depth: ${session.depth}</div>
    ${coopBlock}
    ${(session.gameOver || ((coop || coopSolo) && (me().dead || me().exited)))
      ? (() => {
          // A duel winner never walks out of a gate, so the old test (exited
          // or else dead) labelled every victory "YOU DIED".
          const duelWon = session!.isDuel() && coop !== null
            && session!.duelWinner === coop.me;
          const won = duelWon || me().exited;
          const label = duelWon
            ? "YOU WON THE DUEL"
            : session!.isDuel() && session!.duelWinner >= 0
              ? (me().dead ? "YOU DIED" : "YOU LOST THE DUEL")
              : me().exited
                ? "SURVIVED \u2014 Exited " + me().exitGate
                : "YOU DIED";
          return `<div style="margin-top:8px;color:${won ? "#4a4" : "#c44"};font-weight:bold">
           ${label}
         </div>${endButtons}`;
        })()
      : ''}
    ${armedBannerHtml()}
    ${busy ? '<div style="margin-top:6px;color:#aa8">Submitting...</div>' : ""}
    <div style="margin-top:8px;font-size:11px;color:#888">
      WASD/Arrows: Move &nbsp; G: Pickup<br>
      P: Potion &nbsp; Space: Wait &nbsp; Enter: ${coop || coopSolo ? "Exit run (on a gate)" : "Gate"}
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
  // Potions drunk this run are consumed from the live session immediately,
  // but the on-chain stack does not shrink until settlement; reflect that in
  // the shown count so the drink visibly registers.
  // Sidebar shows equipped gear only; the settled bag is managed in the
  // Inventory modal (I).  Items found THIS run are still listed below as
  // pending, since that is the useful in-run feedback.
  const lines: string[] = [];
  const equipped = p ? p.inventory.filter(i => i.slot !== "bag") : [];
  const bagCount = p ? p.inventory.filter(i => i.slot === "bag").length : 0;

  if (equipped.length === 0) {
    lines.push('<div style="color:#666">Nothing equipped</div>');
  } else {
    for (const it of equipped) {
      lines.push(`<div class="inventory-item"><span>${itemIcon(it.item_id)} ${itemName(it.item_id)}</span><span class="slot-equipped">[${it.slot}]</span></div>`);
    }
  }
  lines.push(`<div style="margin-top:6px;color:#888;font-size:11px">Bag: ${bagCount} / ${MAX_INVENTORY} (press I to manage)</div>`);

  const pending = session ? me().collected.filter(l => l.quantity > 0) : [];
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
        playerX: me().x,
        playerY: me().y,
        hp: me().hp,
        maxHp: me().maxHp,
        survived: me().exited,
        gameOver: session.gameOver,
        gates: session.dungeon.gates,
        tileAtPlayer: session.dungeon.getTile(me().x, me().y),
        monsters: session.monsters.filter(m => m.alive)
          .map(m => ({ x: m.x, y: m.y, hp: m.hp, attack: m.attack })),
        groundItems: session.groundItems
          .map(g => ({ x: g.x, y: g.y, item: g.itemId })),
      } : null,
      segments: connState?.segments
        ? Array.from(connState.segments.values()).map(s => ({
            x: s.x, y: s.y, confirmed: s.confirmed,
            links: s.links, gates: s.gates,
          }))
        : [],
      modal: document.getElementById("modal-root")?.textContent ?? null,
      // Co-op runtime view (null outside a co-op run).
      coop: coop ? {
        me: coop.me,
        names: coop.names,
        myTurn: coop.myTurn,
        pendingOwn: coop.hasPendingOwn,
        waitingOn: coop.waitingOn,
        turns: coop.session.turnCount,
        logHash: settleLogHash(channelVisitId, coop.session.mergedLog),
        claims: computeClaims(coop.session, coopVisit?.pot ?? 0),
        players: coop.session.players.map(q => ({
          x: q.x, y: q.y, hp: q.hp, dead: q.dead, exited: q.exited, exitGate: q.exitGate,
        })),
        settling: coopSettling,
        settleError: coopSettleError,
        transportError: coop.transportError,
      } : null,
      coopVisit,
      coopSolo,
      // The co-op lobby as the player sees it: what is reachable from
      // where they stand right now.
      coopTargets: connState?.player ? coopTargets(connState.player.segment) : [],
      joinable: connState?.player ? joinableVisits(connState.player.segment) : [],
      partnerCheckpoint: (coop || coopSolo) ? partnerCheckpoint() : null,
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
    enterChannel: (x: number, y: number) => doEnterChannel({ x, y }),
    exitChannel: () => doExitChannel(),
    gateWalk: (dir: string) => doGateWalk(dir),
    forfeit: (visitId: number) => doForfeitVisit(visitId),
    // Co-op lobby / run control.
    coopHost: (dir: string) => doCoopHost(dir),
    coopJoin: (visitId: number, dir: string) => doCoopJoin(visitId, dir),
    coopTargets: () => connState?.player ? coopTargets(connState.player.segment) : [],
    joinable: () => connState?.player ? joinableVisits(connState.player.segment) : [],
    coopLeave: (visitId: number) => doCoopLeave(visitId),
    coopExit: () => { coop?.submitLocal({ type: "gate" }); },
    coopSync: () => syncCoopFromChain(),
    coopCheckpoint: () => maybeCheckpoint(true),
    coopAbandon: () => continueAlone(),
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
    // Any dialog, not just the one-button kind: a CHOICE modal (the gate
    // dialog, the leave dialog) carries .modal-cancel and no .modal-dismiss,
    // so a hook that only knew the latter silently did nothing and left
    // every driver spinning against a modal it could not close.
    dismissModal: () => {
      const el = document.querySelector<HTMLElement>(".modal-dismiss")
        ?? document.querySelector<HTMLElement>(".modal-cancel");
      el?.click();
      return !!el;
    },
    // Overworld map view transform, for pan/zoom tests.
    mapView: () => ({ panX, panY, zoom, mapFollow, selectedSegment }),
    recenter: () => recenterMap(),
  };
}

// --- Start ---

setMode("dungeon");
