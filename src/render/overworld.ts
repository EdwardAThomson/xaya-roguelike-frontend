/**
 * Overworld segment map renderer.
 * Draws segments as nodes on a grid with links between them.
 */

import { SegmentNode } from "../game/overworld.js";
import { SegmentRef, segKey, sameSeg, isHub, HUB } from "../net/rpc.js";

/** One other player present on a segment, for the map presence tokens. */
export interface PlayerMarker {
  name: string;
  inChannel: boolean;
}

/**
 * View transform for the map: a manual pixel pan plus a zoom scale, applied
 * on top of the auto-centering on the current segment.  The default
 * ({ panX: 0, panY: 0, zoom: 1 }) reproduces the classic centered view.
 */
export interface OverworldView {
  panX: number;
  panY: number;
  zoom: number;
}

export const DEFAULT_VIEW: OverworldView = { panX: 0, panY: 0, zoom: 1 };

export const NODE_SIZE = 64;
const NODE_GAP = 96;
export const CELL = NODE_SIZE + NODE_GAP;

const DEPTH_COLORS = [
  "#4a4",   // depth 0 (origin)
  "#6a6",   // depth 1
  "#aa6",   // depth 2
  "#ca6",   // depth 3
  "#c86",   // depth 4
  "#c66",   // depth 5+
];

function depthColor(depth: number): string {
  return DEPTH_COLORS[Math.min(depth, DEPTH_COLORS.length - 1)];
}

export function drawOverworld(
  ctx: CanvasRenderingContext2D,
  nodes: Map<string, SegmentNode>,
  currentSegment: SegmentRef,
  selectedSegment: SegmentRef | null,
  canvasW: number,
  canvasH: number,
  /** Other players by segment coordinate key (see segKey). */
  presence?: Map<string, PlayerMarker[]>,
  view?: OverworldView,
): void {
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Inset panel so the map reads as a contained view, not edge-to-edge.
  const PAD = 28;
  const pw = Math.max(0, canvasW - PAD * 2);
  const ph = Math.max(0, canvasH - PAD * 2);
  ctx.fillStyle = "#0c0c14";
  roundRect(ctx, PAD, PAD, pw, ph, 10);
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#2c2c3c";
  roundRect(ctx, PAD, PAD, pw, ph, 10);
  ctx.stroke();

  if (nodes.size === 0) {
    ctx.fillStyle = "#666";
    ctx.font = "16px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No segments discovered yet.", canvasW / 2, canvasH / 2);
    return;
  }

  // Pan/zoom transform (defaults to the classic centered, unscaled view).
  const zoom = view?.zoom ?? DEFAULT_VIEW.zoom;
  const panX = view?.panX ?? DEFAULT_VIEW.panX;
  const panY = view?.panY ?? DEFAULT_VIEW.panY;
  const cell = CELL * zoom;
  const nodeSize = NODE_SIZE * zoom;

  // Center the view on the current segment (or origin), then apply the pan.
  const centerNode = nodes.get(segKey(currentSegment))
      ?? nodes.get(segKey(HUB)) ?? nodes.values().next().value!;
  const offsetX = canvasW / 2 - centerNode.gridX * cell + panX;
  const offsetY = canvasH / 2 - centerNode.gridY * cell + panY;

  // Clip the map to the panel so nodes never bleed over the frame.
  ctx.save();
  roundRect(ctx, PAD, PAD, pw, ph, 10);
  ctx.clip();

  // Draw links first (behind nodes).
  ctx.lineWidth = 2 * zoom;
  for (const node of nodes.values()) {
    const x1 = node.gridX * cell + offsetX;
    const y1 = node.gridY * cell + offsetY;

    for (const [_dir, neighborSeg] of Object.entries(node.links)) {
      const neighbor = nodes.get(segKey(neighborSeg));
      if (!neighbor) continue;
      // Draw each link once, from the lower coordinate.
      if (node.seg.x > neighborSeg.x
          || (node.seg.x === neighborSeg.x && node.seg.y > neighborSeg.y)) {
        continue;
      }

      const x2 = neighbor.gridX * cell + offsetX;
      const y2 = neighbor.gridY * cell + offsetY;

      ctx.strokeStyle = "#444";
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }

  // Draw nodes.
  for (const node of nodes.values()) {
    const cx = node.gridX * cell + offsetX;
    const cy = node.gridY * cell + offsetY;
    const half = nodeSize / 2;

    if (cx + half < 0 || cx - half > canvasW || cy + half < 0 || cy - half > canvasH) {
      continue;
    }

    const isOrigin = isHub(node.seg);
    const isCurrent = sameSeg(node.seg, currentSegment);
    const isSelected = !!selectedSegment && sameSeg(node.seg, selectedSegment);

    // Node background.
    ctx.fillStyle = isOrigin ? "#1a2a1a" : "#1a1a2a";
    if (isSelected) ctx.fillStyle = "#2a2a3a";
    ctx.lineWidth = (isCurrent ? 3 : isSelected ? 2 : 1.5) * zoom;
    ctx.strokeStyle = isCurrent ? "#fff" : isSelected ? "#aaf" : depthColor(node.depth);

    roundRect(ctx, cx - half, cy - half, nodeSize, nodeSize, 6 * zoom);
    ctx.fill();

    // Dashed border for provisional (not-yet-confirmed) segments.
    if (node.provisional) {
      ctx.save();
      ctx.setLineDash([5, 3]);
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.stroke();
    }

    // Glow for current segment.
    if (isCurrent) {
      ctx.save();
      ctx.shadowColor = "#fff";
      ctx.shadowBlur = 12 * zoom;
      ctx.stroke();
      ctx.restore();
    }

    // Player icon on current segment.
    if (isCurrent) {
      ctx.fillStyle = "#daa520";
      ctx.font = `bold ${11 * zoom}px monospace`;
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillText("@", cx + half - 3 * zoom, cy - half + 3 * zoom);
    }

    // World coordinates as the node's identity.
    ctx.fillStyle = isCurrent ? "#fff" : isSelected ? "#ddf" : "#ccc";
    ctx.font = `bold ${15 * zoom}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const label = `(${node.seg.x}, ${node.seg.y})${node.provisional ? "?" : ""}`;
    ctx.fillText(label, cx, cy - 8 * zoom);

    // Depth label (or "Provisional" hint).
    if (node.provisional) {
      ctx.fillStyle = "#d08040";
      ctx.font = `${11 * zoom}px monospace`;
      ctx.textAlign = "center";
      ctx.fillText(`Depth ${node.depth} (prov.)`, cx, cy + 10 * zoom);
    } else {
      ctx.fillStyle = depthColor(node.depth);
      ctx.font = `${11 * zoom}px monospace`;
      ctx.textAlign = "center";
      ctx.fillText(isOrigin ? "Safe Zone" : `Depth ${node.depth}`, cx, cy + 10 * zoom);
    }

    // Other players present on this segment, drawn as small initial tokens
    // along the bottom inside edge of the node (blue = in the hub/overworld
    // here, brighter cyan = currently in a dungeon on this segment).  Data
    // comes from the on-chain world state, so it updates every poll.
    const markers = presence?.get(segKey(node.seg));
    if (markers && markers.length) {
      const R = 8 * zoom;
      const gap = 18 * zoom;
      const maxShown = 4;
      const overflow = markers.length > maxShown;
      const shown = overflow ? maxShown - 1 : markers.length;
      const slots = shown + (overflow ? 1 : 0);
      const rowW = (slots - 1) * gap;
      const by = cy + half - 2 * zoom;
      let tx = cx - rowW / 2;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let i = 0; i < shown; i++) {
        const m = markers[i];
        ctx.beginPath();
        ctx.arc(tx, by, R, 0, Math.PI * 2);
        ctx.fillStyle = m.inChannel ? "#2b9fd0" : "#3060a0";
        ctx.fill();
        ctx.lineWidth = 1.5 * zoom;
        ctx.strokeStyle = "#0a0a0a";
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.font = `bold ${10 * zoom}px monospace`;
        ctx.fillText((m.name[0] || "?").toUpperCase(), tx, by + 0.5 * zoom);
        tx += gap;
      }
      if (overflow) {
        ctx.beginPath();
        ctx.arc(tx, by, R, 0, Math.PI * 2);
        ctx.fillStyle = "#555";
        ctx.fill();
        ctx.strokeStyle = "#0a0a0a";
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.font = `bold ${9 * zoom}px monospace`;
        ctx.fillText("+" + (markers.length - shown), tx, by + 0.5 * zoom);
      }
    }

    // Direction arrows on edges.
    ctx.fillStyle = "#555";
    ctx.font = `${9 * zoom}px monospace`;
    for (const dir of Object.keys(node.links)) {
      const edge = half + 8 * zoom;
      const dx = dir === "east" ? edge : dir === "west" ? -edge : 0;
      const dy = dir === "south" ? edge : dir === "north" ? -edge : 0;
      ctx.textAlign = (dir === "east" ? "left" : dir === "west" ? "right" : "center") as CanvasTextAlign;
      ctx.textBaseline = dir === "north" ? "bottom" : dir === "south" ? "top" : "middle";
      const arrow = dir === "north" ? "\u2191" : dir === "south" ? "\u2193"
                  : dir === "east" ? "\u2192" : "\u2190";
      ctx.fillText(arrow, cx + dx, cy + dy);
    }
  }

  // Done with the clipped map content.
  ctx.restore();

  // Title (top-left inside the panel) and legend (bottom, clear of the tab
  // bar that floats over the panel's top-centre).
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#8ec";
  ctx.font = "bold 13px monospace";
  ctx.fillText("WORLD MAP", PAD + 10, PAD + 8);

  ctx.fillStyle = "#666";
  ctx.font = "11px monospace";
  ctx.fillText(
    "Click a segment to select \u00b7 drag to pan, scroll to zoom, Recenter to reset (dashed = provisional)",
    PAD + 10, canvasH - PAD - 20,
  );
  if (zoom !== DEFAULT_VIEW.zoom || panX !== DEFAULT_VIEW.panX || panY !== DEFAULT_VIEW.panY) {
    ctx.fillStyle = "#888";
    ctx.fillText(`zoom ${zoom.toFixed(2)}x`, PAD + 10, canvasH - PAD - 36);
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
