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
  gridX: number;
  gridY: number;
  links: Record<string, number>;  // direction -> segment ID
  provisional: boolean;
}

const DIR_DX: Record<string, number> = { east: 1, west: -1, north: 0, south: 0 };
const DIR_DY: Record<string, number> = { north: -1, south: 1, east: 0, west: 0 };
const OPPOSITE: Record<string, string> = { north: "south", south: "north", east: "west", west: "east" };

/**
 * Lay out segments on a 2D grid using BFS from segment 0 (origin).
 * Segment 0 is always placed at (0,0) even if it has no DB entry.
 */
export function layoutSegments(segments: Map<number, SegmentInfo>): Map<number, SegmentNode> {
  const nodes = new Map<number, SegmentNode>();
  const occupied = new Map<string, number>();  // "x,y" -> segment ID

  // Always create segment 0 (hub) at origin.
  const seg0Links: Record<string, number> = {};

  // Infer segment 0's links from other segments that link back to it.
  for (const seg of segments.values()) {
    for (const [dir, lnk] of Object.entries(seg.links)) {
      if (lnk.to_segment === 0) {
        // This segment links to 0 via direction `dir`.
        // So segment 0 has a link in the opposite direction to this segment.
        const reverseDir = OPPOSITE[dir];
        if (reverseDir) {
          seg0Links[reverseDir] = seg.id;
        }
      }
    }
  }

  // Also check segment 0 data if it somehow exists.
  const seg0Data = segments.get(0);
  if (seg0Data) {
    for (const [dir, lnk] of Object.entries(seg0Data.links)) {
      seg0Links[dir] = lnk.to_segment;
    }
  }

  const hub: SegmentNode = {
    id: 0,
    depth: 0,
    discoverer: "",
    gridX: 0,
    gridY: 0,
    links: seg0Links,
    provisional: false,
  };
  nodes.set(0, hub);
  occupied.set("0,0", 0);

  // BFS from segment 0 to place all connected segments.
  const queue = [0];
  while (queue.length > 0) {
    const curId = queue.shift()!;
    const curNode = nodes.get(curId)!;

    // Get links from either the node's links (for seg 0) or the segment data.
    let links: Record<string, number>;
    if (curId === 0) {
      links = curNode.links;
    } else {
      const curSeg = segments.get(curId);
      if (!curSeg) continue;
      links = {};
      for (const [dir, lnk] of Object.entries(curSeg.links)) {
        links[dir] = lnk.to_segment;
      }
    }

    for (const [dir, neighborId] of Object.entries(links)) {
      if (nodes.has(neighborId)) continue;

      const gx = curNode.gridX + (DIR_DX[dir] ?? 0);
      const gy = curNode.gridY + (DIR_DY[dir] ?? 0);

      const key = `${gx},${gy}`;
      if (occupied.has(key)) continue;

      const neighborSeg = segments.get(neighborId);
      const neighborLinks: Record<string, number> = {};
      if (neighborSeg) {
        for (const [d, l] of Object.entries(neighborSeg.links)) {
          neighborLinks[d] = l.to_segment;
        }
      }

      const node: SegmentNode = {
        id: neighborId,
        depth: neighborSeg?.depth ?? 1,
        discoverer: neighborSeg?.discoverer ?? "?",
        gridX: gx,
        gridY: gy,
        links: neighborLinks,
        provisional: neighborSeg ? !neighborSeg.confirmed : true,
      };
      nodes.set(neighborId, node);
      occupied.set(key, neighborId);
      queue.push(neighborId);
    }
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
