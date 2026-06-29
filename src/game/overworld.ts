/**
 * Overworld data model — builds a spatial layout of segments
 * from the GSP segment graph (links between segments).
 *
 * Segment 0 is the origin "hub" — it exists implicitly (not in the
 * segments table) but other segments link back to it.
 */

import { SegmentInfo } from "../net/rpc.js";

export interface SegmentNode {
  id: number;
  depth: number;
  discoverer: string;
  worldX: number;
  worldY: number;
  gridX: number;
  gridY: number;
  links: Record<string, number>;  // direction -> segment ID
  provisional: boolean;
}

const OPPOSITE: Record<string, string> = { north: "south", south: "north", east: "west", west: "east" };

/**
 * Build map nodes directly from the GSP's authoritative world coordinates.
 * Each segment is placed at its own `world_x`/`world_y`; the origin hub
 * (segment 0) sits at (0,0) even though it has no row in the segments table.
 *
 * `gridY = -world_y` because the GSP uses north = +Y while the canvas grows
 * downward — flipping keeps north rendering up.
 */
export function layoutSegments(segments: Map<number, SegmentInfo>): Map<number, SegmentNode> {
  const nodes = new Map<number, SegmentNode>();

  // Hub (segment 0): infer its links from neighbours that link back to it.
  const seg0Links: Record<string, number> = {};
  for (const seg of segments.values()) {
    for (const [dir, lnk] of Object.entries(seg.links)) {
      if (lnk.to_segment === 0) {
        const reverseDir = OPPOSITE[dir];
        if (reverseDir) seg0Links[reverseDir] = seg.id;
      }
    }
  }
  // Honour explicit segment-0 data if it ever exists.
  const seg0Data = segments.get(0);
  if (seg0Data) {
    for (const [dir, lnk] of Object.entries(seg0Data.links)) {
      seg0Links[dir] = lnk.to_segment;
    }
  }

  nodes.set(0, {
    id: 0,
    depth: 0,
    discoverer: "",
    worldX: 0,
    worldY: 0,
    gridX: 0,
    gridY: 0,
    links: seg0Links,
    provisional: false,
  });

  // Place every other segment at its true world coordinate.
  for (const seg of segments.values()) {
    if (seg.id === 0) continue;
    const links: Record<string, number> = {};
    for (const [dir, lnk] of Object.entries(seg.links)) {
      links[dir] = lnk.to_segment;
    }
    nodes.set(seg.id, {
      id: seg.id,
      depth: seg.depth,
      discoverer: seg.discoverer,
      worldX: seg.world_x,
      worldY: seg.world_y,
      gridX: seg.world_x,
      gridY: -seg.world_y,
      links,
      provisional: !seg.confirmed,
    });
  }

  return nodes;
}

/** Find which segment node is at a given canvas position. */
export function hitTestSegment(
  nodes: Map<number, SegmentNode>,
  canvasX: number,
  canvasY: number,
  centerNode: SegmentNode,
  canvasW: number,
  canvasH: number,
  nodeSize: number,
  cellSize: number,
): number | null {
  const offsetX = canvasW / 2 - centerNode.gridX * cellSize;
  const offsetY = canvasH / 2 - centerNode.gridY * cellSize;

  for (const node of nodes.values()) {
    const cx = node.gridX * cellSize + offsetX;
    const cy = node.gridY * cellSize + offsetY;
    const half = nodeSize / 2;

    if (canvasX >= cx - half && canvasX <= cx + half &&
        canvasY >= cy - half && canvasY <= cy + half) {
      return node.id;
    }
  }
  return null;
}

/** Check if two segments are directly linked. */
export function areLinked(nodes: Map<number, SegmentNode>, fromId: number, toId: number): string | null {
  const from = nodes.get(fromId);
  if (!from) return null;
  for (const [dir, targetId] of Object.entries(from.links)) {
    if (targetId === toId) return dir;
  }
  return null;
}
