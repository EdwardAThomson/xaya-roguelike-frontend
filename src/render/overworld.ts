/**
 * Overworld segment map renderer.
 * Draws segments as nodes on a grid with links between them.
 */

import { SegmentNode } from "../game/overworld.js";

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
  nodes: Map<number, SegmentNode>,
  currentSegment: number,
  selectedSegment: number | null,
  canvasW: number,
  canvasH: number,
): void {
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, canvasW, canvasH);

  if (nodes.size === 0) {
    ctx.fillStyle = "#666";
    ctx.font = "16px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No segments discovered yet.", canvasW / 2, canvasH / 2);
    return;
  }

  // Center the view on the current segment (or origin).
  const centerNode = nodes.get(currentSegment) ?? nodes.get(0) ?? nodes.values().next().value!;
  const offsetX = canvasW / 2 - centerNode.gridX * CELL;
  const offsetY = canvasH / 2 - centerNode.gridY * CELL;

  // Draw links first (behind nodes).
  ctx.lineWidth = 2;
  for (const node of nodes.values()) {
    const x1 = node.gridX * CELL + offsetX;
    const y1 = node.gridY * CELL + offsetY;

    for (const [_dir, neighborId] of Object.entries(node.links)) {
      const neighbor = nodes.get(neighborId);
      if (!neighbor) continue;
      if (node.id > neighborId) continue;  // draw each link once

      const x2 = neighbor.gridX * CELL + offsetX;
      const y2 = neighbor.gridY * CELL + offsetY;

      ctx.strokeStyle = "#444";
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }

  // Draw nodes.
  for (const node of nodes.values()) {
    const cx = node.gridX * CELL + offsetX;
    const cy = node.gridY * CELL + offsetY;
    const half = NODE_SIZE / 2;

    if (cx + half < 0 || cx - half > canvasW || cy + half < 0 || cy - half > canvasH) {
      continue;
    }

    const isOrigin = node.id === 0;
    const isCurrent = node.id === currentSegment;
    const isSelected = node.id === selectedSegment;

    // Node background.
    ctx.fillStyle = isOrigin ? "#1a2a1a" : "#1a1a2a";
    if (isSelected) ctx.fillStyle = "#2a2a3a";
    ctx.lineWidth = isCurrent ? 3 : isSelected ? 2 : 1.5;
    ctx.strokeStyle = isCurrent ? "#fff" : isSelected ? "#aaf" : depthColor(node.depth);

    roundRect(ctx, cx - half, cy - half, NODE_SIZE, NODE_SIZE, 6);
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
      ctx.shadowBlur = 12;
      ctx.stroke();
      ctx.restore();
    }

    // Player icon on current segment.
    if (isCurrent) {
      ctx.fillStyle = "#daa520";
      ctx.font = "bold 11px monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillText("@", cx + half - 3, cy - half + 3);
    }

    // Segment ID.
    ctx.fillStyle = isCurrent ? "#fff" : isSelected ? "#ddf" : "#ccc";
    ctx.font = "bold 16px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const label = isOrigin ? "HUB"
                : node.provisional ? `#${node.id}?`
                : `#${node.id}`;
    ctx.fillText(label, cx, cy - 8);

    // Depth label (or "Provisional" hint).
    if (node.provisional) {
      ctx.fillStyle = "#d08040";
      ctx.font = "11px monospace";
      ctx.textAlign = "center";
      ctx.fillText(`Depth ${node.depth} \u2014 prov.`, cx, cy + 10);
    } else {
      ctx.fillStyle = depthColor(node.depth);
      ctx.font = "11px monospace";
      ctx.textAlign = "center";
      ctx.fillText(isOrigin ? "Safe Zone" : `Depth ${node.depth}`, cx, cy + 10);
    }

    // Direction arrows on edges.
    ctx.fillStyle = "#555";
    ctx.font = "9px monospace";
    for (const dir of Object.keys(node.links)) {
      const dx = dir === "east" ? half + 8 : dir === "west" ? -(half + 8) : 0;
      const dy = dir === "south" ? half + 8 : dir === "north" ? -(half + 8) : 0;
      ctx.textAlign = (dir === "east" ? "left" : dir === "west" ? "right" : "center") as CanvasTextAlign;
      ctx.textBaseline = dir === "north" ? "bottom" : dir === "south" ? "top" : "middle";
      const arrow = dir === "north" ? "\u2191" : dir === "south" ? "\u2193"
                  : dir === "east" ? "\u2192" : "\u2190";
      ctx.fillText(arrow, cx + dx, cy + dy);
    }
  }

  // Legend.
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#666";
  ctx.font = "11px monospace";
  ctx.fillText("Overworld Map \u2014 click a segment to select (dashed = provisional)", 12, 12);
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
