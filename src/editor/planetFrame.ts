import type { FacePoint } from '@core/cubeSphere';
import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '@world/doc';
import type { NodeId } from '@world/ids';
import { chartAt, inChartInto, toOwnerInto } from '@world/planet/charts';
import type { TerrainStamp } from '@world/terrain';
import type { RoadPathPiece } from './roadPath';

/**
 * A ROAD EDIT WORKED OUT ON ONE CHART OF THE PLANET.
 *
 * Every point of the planet is written on the chart of the piece that owns
 * it (`world/planet/charts.ts`). A road drawn is worked out where it was
 * drawn: on the chart of the piece the gesture started on, which the gesture
 * was read on (`Viewport.holdChart`) and whose map goes on past its piece.
 * The roads round the gesture are brought onto that chart in the working copy
 * (`enterFrame`: the same ground, other coordinates, no edit), the edit runs
 * there unchanged - crossings, splits, joins, heights - and every point is
 * written back on its own piece's chart (`leaveFrame`), a node the edit did
 * not move getting its very coordinates back.
 *
 * On the flat map nothing here is called.
 */

/** How far round the gesture the roads are brought onto its chart, world units: a road the edit can meet, and its other end. */
const FRAME_REACH = 400;

/** The longest piece of road laid in one segment on the planet: what is worked out on one chart stays near it. */
export const PLANET_MAX_PIECE = 200;

export interface EditFrame {
  readonly chart: number;
  /** The nodes brought onto the chart, and where they were written before. */
  readonly kept: ReadonlyMap<NodeId, Vec2>;
  /** The terrain stamps as they were written. */
  readonly stamps: readonly TerrainStamp[];
}

const q: FacePoint = { x: 0, y: 0 };

/** The chart a gesture is worked out on: the one its first point is written on. */
export const gestureChart = (pieces: readonly RoadPathPiece[]): number =>
  chartAt(pieces[0]?.start.at.x ?? 0, pieces[0]?.start.at.y ?? 0);

/**
 * Brings the roads round a gesture (its points on `chart`'s map) onto that
 * chart in the working copy `work`: every node within `FRAME_REACH` of the
 * gesture's bounds, and the other end of every road at one of them; and the
 * terrain stamps there.
 */
export function enterFrame(work: RoadDoc, chart: number, points: readonly Vec2[]): EditFrame {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  minX -= FRAME_REACH; minY -= FRAME_REACH; maxX += FRAME_REACH; maxY += FRAME_REACH;
  const near = new Set<NodeId>();
  for (const node of work.nodes.values()) {
    inChartInto(chart, node.x, node.y, q);
    if (q.x >= minX && q.x <= maxX && q.y >= minY && q.y <= maxY) near.add(node.id);
  }
  for (const id of [...near]) {
    for (const segId of work.requireNode(id).incident) {
      const seg = work.requireSegment(segId);
      near.add(seg.a);
      near.add(seg.b);
    }
  }
  const kept = new Map<NodeId, Vec2>();
  for (const id of near) {
    const node = work.requireNode(id);
    kept.set(id, { x: node.x, y: node.y });
    inChartInto(chart, node.x, node.y, q);
    work.recodeNode(id, { x: q.x, y: q.y });
  }
  const stamps = work.terrainStamps.map((s) => ({ ...s }));
  for (let i = 0; i < work.terrainStamps.length; i++) {
    const s = work.terrainStamps[i]!;
    inChartInto(chart, s.x, s.y, q);
    if (q.x + s.radius < minX || q.x - s.radius > maxX || q.y + s.radius < minY || q.y - s.radius > maxY) continue;
    work.terrainStamps[i] = { ...s, x: q.x, y: q.y };
  }
  return { chart, kept, stamps };
}

/**
 * Writes every point of the working copy back on its own piece's chart: a
 * node brought onto the chart and not moved by the edit gets its very
 * coordinates back (so the edit changes nothing it did not touch); one it
 * moved, and every new one, is written on the chart of the piece it now lies
 * on. The terrain stamps as they were.
 */
export function leaveFrame(work: RoadDoc, frame: EditFrame, before: RoadDoc): void {
  for (const node of work.nodes.values()) {
    const was = frame.kept.get(node.id);
    if (was) {
      inChartInto(frame.chart, was.x, was.y, q);
      if (Math.abs(q.x - node.x) < 1e-6 && Math.abs(q.y - node.y) < 1e-6) {
        work.recodeNode(node.id, was);
        continue;
      }
    } else if (before.nodes.has(node.id)) continue;
    toOwnerInto(frame.chart, node.x, node.y, q);
    work.recodeNode(node.id, { x: q.x, y: q.y });
  }
  work.terrainStamps.length = 0;
  work.terrainStamps.push(...frame.stamps.map((s) => ({ ...s })));
}

/** A ground sampler of the atlas read at points of `chart`'s map. */
export function groundOnChart(chart: number, ground: (x: number, y: number) => number): (x: number, y: number) => number {
  const p: FacePoint = { x: 0, y: 0 };
  return (x, y) => {
    toOwnerInto(chart, x, y, p);
    return ground(p.x, p.y);
  };
}

/** A point of `chart`'s map written on its own piece's chart (a gesture's preview drawn). */
export const ownPoint = (chart: number, p: Readonly<Vec2>): Vec2 => toOwnerInto(chart, p.x, p.y, { x: 0, y: 0 });

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/**
 * The gesture with every piece longer than `max` cut into equal parts (a
 * quadratic's parts are quadratics, de Casteljau), each its own segment: on
 * the planet a segment is worked out on the chart halfway along it
 * (`world/geometry.ts` `segmentChart`), and a short one stays close to it.
 */
export function splitLongPieces(pieces: readonly RoadPathPiece[], max: number,
  controlOf: (piece: RoadPathPiece) => Vec2,
  shapeOf: (a: Vec2, b: Vec2, c: Vec2) => RoadPathPiece['curve']): RoadPathPiece[] {
  const out: RoadPathPiece[] = [];
  for (const piece of pieces) {
    const a = piece.start.at, b = piece.end.at;
    const c = controlOf(piece);
    const length = Math.hypot(c.x - a.x, c.y - a.y) + Math.hypot(b.x - c.x, b.y - c.y);
    const parts = Math.ceil(length / max);
    if (parts <= 1) { out.push(piece); continue; }
    const at = (t: number): Vec2 => lerp(lerp(a, c, t), lerp(c, b, t), t);
    for (let k = 0; k < parts; k++) {
      const t0 = k / parts, t1 = (k + 1) / parts;
      const p0 = at(t0), p1 = at(t1);
      // The part's control: its start plus its length in parameter times the tangent there.
      const d = { x: (1 - t0) * (c.x - a.x) + t0 * (b.x - c.x), y: (1 - t0) * (c.y - a.y) + t0 * (b.y - c.y) };
      const pc = { x: p0.x + d.x * (t1 - t0), y: p0.y + d.y * (t1 - t0) };
      const h0 = piece.start.heightOffset + (piece.end.heightOffset - piece.start.heightOffset) * t0;
      const h1 = piece.start.heightOffset + (piece.end.heightOffset - piece.start.heightOffset) * t1;
      out.push({
        start: { at: p0, heightOffset: h0 },
        end: { at: p1, heightOffset: h1 },
        curve: piece.curve ? shapeOf(p0, p1, pc) : null,
      });
    }
  }
  return out;
}
