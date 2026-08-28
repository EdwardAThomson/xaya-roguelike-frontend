/**
 * Overworld data model — builds a spatial layout of segments
 * from the GSP segment graph (links between segments).
 *
 * A segment IS its world coordinate; the hub is (0, 0) and exists
 * implicitly (it has no row in the segments table).
 */

import { SegmentInfo, SegmentRef, segKey, HUB } from "../net/rpc.js";

export interface SegmentNode {
  seg: SegmentRef;
  depth: number;
  discoverer: string;
  gridX: number;
  gridY: number;
  links: Record<string, SegmentRef>;  // direction -> neighbouring coordinate
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
export function layoutSegments(
  segments: Map<string, SegmentInfo>,
): Map<string, SegmentNode> {
  const nodes = new Map<string, SegmentNode>();

  // The hub keeps no row of its own: read its links off the neighbours
  // that link back to (0, 0).
  const hubLinks: Record<string, SegmentRef> = {};
  for (const seg of segments.values()) {
    for (const [dir, lnk] of Object.entries(seg.links)) {
      if (lnk.to.x === 0 && lnk.to.y === 0) {
        const reverseDir = OPPOSITE[dir];
        if (reverseDir) hubLinks[reverseDir] = { x: seg.x, y: seg.y };
      }
    }
  }

  nodes.set(segKey(HUB), {
    seg: HUB,
    depth: 0,
    discoverer: "",
    gridX: 0,
    gridY: 0,
    links: hubLinks,
    provisional: false,
  });

  for (const seg of segments.values()) {
    if (seg.x === 0 && seg.y === 0) continue;
    const links: Record<string, SegmentRef> = {};
    for (const [dir, lnk] of Object.entries(seg.links)) {
      links[dir] = lnk.to;
    }
    nodes.set(segKey(seg), {
      seg: { x: seg.x, y: seg.y },
      // Display depth is the segment's distance from the hub (Manhattan
      // |x| + |y|), so the map is always symmetric regardless of the
      // stored discovery-time depth.
      depth: Math.abs(seg.x) + Math.abs(seg.y),
      discoverer: seg.discoverer,
      gridX: seg.x,
      gridY: -seg.y,
      links,
      provisional: !seg.confirmed,
    });
  }

  return nodes;
}

/**
 * Find which segment node is at a given canvas position.
 *
 * `view` mirrors the pan/zoom transform used by the renderer so hit-testing
 * stays correct when the map is panned or zoomed.  Omitting it (or passing the
 * identity `{ panX: 0, panY: 0, zoom: 1 }`) reproduces the classic centered
 * hit test.
 */
export function hitTestSegment(
  nodes: Map<string, SegmentNode>,
  canvasX: number,
  canvasY: number,
  centerNode: SegmentNode,
  canvasW: number,
  canvasH: number,
  nodeSize: number,
  cellSize: number,
  view?: { panX: number; panY: number; zoom: number },
): SegmentRef | null {
  const zoom = view?.zoom ?? 1;
  const panX = view?.panX ?? 0;
  const panY = view?.panY ?? 0;
  const cell = cellSize * zoom;
  const size = nodeSize * zoom;
  const offsetX = canvasW / 2 - centerNode.gridX * cell + panX;
  const offsetY = canvasH / 2 - centerNode.gridY * cell + panY;

  for (const node of nodes.values()) {
    const cx = node.gridX * cell + offsetX;
    const cy = node.gridY * cell + offsetY;
    const half = size / 2;

    if (canvasX >= cx - half && canvasX <= cx + half &&
        canvasY >= cy - half && canvasY <= cy + half) {
      return node.seg;
    }
  }
  return null;
}

/** Check if two segments are directly linked. */
export function areLinked(
  nodes: Map<string, SegmentNode>, from: SegmentRef, to: SegmentRef,
): string | null {
  const node = nodes.get(segKey(from));
  if (!node) return null;
  for (const [dir, target] of Object.entries(node.links)) {
    if (target.x === to.x && target.y === to.y) return dir;
  }
  return null;
}
