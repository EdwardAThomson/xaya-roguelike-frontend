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
import { InputHandler, Direction } from "./game/input.js";
import { FovMap } from "./render/fov.js";
import { Connection, ConnectionState } from "./net/connection.js";
import { MoveClient } from "./net/moves.js";
import { layoutSegments, SegmentNode, hitTestSegment, areLinked } from "./game/overworld.js";
import { drawOverworld, NODE_SIZE, CELL } from "./render/overworld.js";
import { DEFAULT_GSP_URL, DEFAULT_PROXY_URL } from "./config.js";
import {
  ValidatorContext, ValidationResult,
  validateDiscover, validateTravel, validateEnterChannel,
  validateUseItem, validateAllocateStat, validateEquip, validateUnequip,
  discoveryCooldownRemaining,
} from "./net/validator.js";
import { waitFor } from "./net/pending.js";
import { showErrorModal, showModal } from "./ui/modal.js";
import { lookupItem } from "./game/items.js";

// --- DOM refs ---

const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

const gspUrlInput = document.getElementById("gsp-url") as HTMLInputElement;
const playerNameInput = document.getElementById("player-name") as HTMLInputElement;
const connectBtn = document.getElementById("connect-btn") as HTMLButtonElement;
const statusEl = document.getElementById("connection-status")!;
const modeOverworldBtn = document.getElementById("mode-overworld") as HTMLButtonElement;
const modeDungeonBtn = document.getElementById("mode-dungeon") as HTMLButtonElement;

// --- State ---

type AppMode = "overworld" | "dungeon";
let mode: AppMode = "overworld";
let busy = false;  // prevents actions while async ops are in progress

const camera = new Camera();
initSprites();

// Dungeon mode state.
let session: DungeonSession | null = null;
let fov: FovMap | null = null;
let seedCounter = 0;
let channelSession = false;  // true when dungeon was entered via channel
let channelSegmentId = -1;
let channelVisitId = -1;

// Overworld mode state.
let overworldNodes: Map<number, SegmentNode> = new Map();
let connState: ConnectionState | null = null;
let selectedSegment: number | null = null;

// Move client.
let moves: MoveClient | null = null;

// --- Connection ---

const connection = new Connection((state: ConnectionState) => {
  connState = state;
  updateConnectionUI();
  if (mode === "overworld") {
    rebuildOverworld();
    render();
    updateSidebar();
  }
});

gspUrlInput.value = DEFAULT_GSP_URL;

connectBtn.addEventListener("click", () => {
  if (connState?.status === "connected" || connState?.status === "connecting") {
    connection.disconnect();
    moves = null;
  } else {
    const url = gspUrlInput.value.trim();
    const name = playerNameInput.value.trim();
    moves = new MoveClient(DEFAULT_PROXY_URL);
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
}

// --- Mode switching ---

function setMode(m: AppMode): void {
  mode = m;
  modeOverworldBtn.classList.toggle("active", m === "overworld");
  modeDungeonBtn.classList.toggle("active", m === "dungeon");
  modeOverworldBtn.disabled = m === "overworld";
  modeDungeonBtn.disabled = m === "dungeon";
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

// Canvas click handler for overworld segment selection.
canvas.addEventListener("click", (e) => {
  if (mode !== "overworld" || overworldNodes.size === 0) return;

  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const currentSeg = connState?.player?.current_segment ?? 0;
  const centerNode = overworldNodes.get(currentSeg) ?? overworldNodes.get(0) ?? overworldNodes.values().next().value!;

  const hit = hitTestSegment(overworldNodes, x, y, centerNode, canvas.width, canvas.height, NODE_SIZE, CELL);
  selectedSegment = hit;
  render();
  updateSidebar();
});

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

/** Start a channel dungeon session using real on-chain player data. */
function startChannelDungeon(segmentSeed: string, depth: number, segmentId: number, visitId: number): void {
  const p = connState?.player;
  if (!p) return;

  channelSession = true;
  channelSegmentId = segmentId;
  channelVisitId = visitId;

  const stats: PlayerStats = {
    level: p.level,
    strength: p.stats.strength,
    dexterity: p.stats.dexterity,
    constitution: p.stats.constitution,
    intelligence: p.stats.intelligence,
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

  session = new DungeonSession(segmentSeed, depth, stats, p.hp, p.max_hp, potions);
  fov = new FovMap();
  fov.update(session.playerX, session.playerY, session.dungeon);
  camera.centerOn(session.playerX, session.playerY);

  setMode("dungeon");
}

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
    `The move was submitted but the GSP did not apply it. The most likely cause is a race with another player (someone else grabbed the coordinate, or the cooldown window advanced between click and block inclusion). Try again.`,
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
        startChannelDungeon(segInfo.seed, segInfo.depth, segmentId, connState.player.active_visit.visit_id);
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

    // Return to overworld.
    channelSession = false;
    session = null;
    fov = null;
    setMode("overworld");
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

function renderOverworld(): void {
  const currentSeg = connState?.player?.current_segment ?? 0;
  drawOverworld(ctx, overworldNodes, currentSeg, selectedSegment, canvas.width, canvas.height);
}

function renderDungeon(): void {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!session || !fov) {
    ctx.fillStyle = "#666";
    ctx.font = "16px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Press N to start a new dungeon.", canvas.width / 2, canvas.height / 2);
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

new InputHandler((action: string, dir?: Direction) => {
  if (mode !== "dungeon") return;
  if (!session || session.gameOver) return;

  let gameAction: GameAction | null = null;
  switch (action) {
    case "move":
      if (dir) gameAction = { type: "move", dx: dir.dx, dy: dir.dy };
      break;
    case "pickup":
      gameAction = { type: "pickup" };
      break;
    case "wait":
      gameAction = { type: "wait" };
      break;
    case "gate":
      gameAction = { type: "gate" };
      break;
    case "use_potion":
      gameAction = { type: "use", itemId: "health_potion" };
      break;
  }

  if (gameAction && session && fov) {
    session.processAction(gameAction);
    fov.update(session.playerX, session.playerY, session.dungeon);
    camera.centerOn(session.playerX, session.playerY);
    render();
    updateSidebar();
  }
});

document.addEventListener("keydown", (e) => {
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
    case "allocate-stat":
      doAllocateStat(target.dataset.stat!);
      break;
    case "equip":
      doEquip(Number(target.dataset.rowid), target.dataset.slot!);
      break;
    case "unequip":
      doUnequip(Number(target.dataset.rowid));
      break;
  }
});

// --- Sidebar updates ---

function updateSidebar(): void {
  if (mode === "overworld") {
    updateOverworldStats();
    updateOverworldInventory();
    updateOverworldMessages();
  } else {
    updateDungeonStats();
    updateDungeonInventory();
    updateDungeonMessages();
  }
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

  let selectedInfo = "";
  if (selectedSegment !== null) {
    const selNode = overworldNodes.get(selectedSegment);
    const isAdjacentDir = areLinked(overworldNodes, p.current_segment, selectedSegment);
    const isCurrent = selectedSegment === p.current_segment;

    selectedInfo = `<div style="margin-top:8px;border-top:1px solid #333;padding-top:8px">`;
    selectedInfo += `<div style="color:#aaf;font-weight:bold">Segment ${selectedSegment}</div>`;

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
    <div class="stat-row"><span class="stat-label">Segment</span><span class="stat-value">${p.current_segment}${p.in_channel ? " (in dungeon)" : ""}</span></div>
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

    let btn = "";
    if (canMutate && item.slot === "bag" && isEquipable) {
      btn = `<button data-action="equip" data-rowid="${item.rowid}"
        data-slot="${def!.slot}" class="inv-btn"
        ${busy ? "disabled" : ""}>Equip</button>`;
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

  const channelLabel = channelSession
    ? `<div style="color:#aaf;font-size:11px">Channel session (seg ${channelSegmentId})</div>` : "";

  let endButtons = "";
  if (session.gameOver) {
    if (channelSession) {
      endButtons = `
        <button data-action="exit-channel" class="action-btn action-enter" ${busy ? "disabled" : ""}>
          Submit Results On-Chain
        </button>`;
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

  if (!session) {
    el.innerHTML = '<div style="color:#666">Empty</div>';
    return;
  }

  const items = session.loot.filter(l => l.quantity > 0);
  if (items.length === 0) {
    el.innerHTML = '<div style="color:#666">Empty</div>';
    return;
  }

  el.innerHTML = items
    .map(l => `<div>${l.itemId} x${l.quantity}</div>`)
    .join("");
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

// --- Start ---

setMode("overworld");
