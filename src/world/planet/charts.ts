import { FACE_HALF, faceToSphereInto, type FacePoint, type Vec3 } from '@core/cubeSphere';
import { TILES, TILES_PER_SIDE, TILE_COUNT, onTile, sphereToTileInto, tileOfDirection, tileToSphereInto } from '@core/planetTiles';
import type { Vec2 } from '@core/vec2';
import { atlasToTileInto, tileCellOf, tileCentre, type TileLocal } from './atlas';

/**
 * THE PLANET'S CHARTS AND THEIR TRANSITION MAPS.
 *
 * A point of the world is a point of the sphere, written in the coordinates
 * of the piece that owns it (`atlas.ts`). Anything worked out from several
 * points - a road between two nodes, a junction and its legs, a gesture - is
 * worked out on ONE chart: the points are carried onto it through the sphere
 * (a chart's transition map, exact), whatever piece they are written on, and
 * the result is written on that chart. A chart's map goes on past its piece's
 * border, so a road or a junction is never cut.
 *
 * What is written on a chart must stay inside its cell of the atlas (within
 * half `ATLAS_PITCH` of its centre): the picture finds a vertex's chart by the
 * cell it lies in (`render/planet/bend.ts`).
 *
 * On the flat map there is one chart and every map is the identity.
 */

const local: TileLocal = { tile: 0, x: 0, y: 0 };

/**
 * Whether an edit is being worked out on one chart (`editor/planetFrame.ts`):
 * every point of its working copy is then written on that chart, past its
 * cell too, and the maps below are the identity - one plane, as the flat map.
 */
let oneChart = false;

/** Runs `work` with every point on one chart (the maps below the identity). */
export function onOneChart<T>(work: () => T): T {
  const was = oneChart;
  oneChart = true;
  try {
    return work();
  } finally {
    oneChart = was;
  }
}

/** Whether the maps are the identity: the flat map, or an edit on one chart. */
const identity = (): boolean => !__PLANET__ || oneChart;
const s3: Vec3 = { x: 0, y: 0, z: 0 };
const fp: FacePoint = { x: 0, y: 0 };

/** The chart an atlas point is written on: its cell's piece (0 on the flat map). */
export const chartAt = (x: number, y: number): number => (identity() ? 0 : tileCellOf(x, y));

/** The sphere direction of an atlas point (written on its cell's chart), into `out`. */
export function atlasToSphereInto(x: number, y: number, out: Vec3): Vec3 {
  atlasToTileInto(x, y, local);
  return tileToSphereInto(local.tile, local.x, local.y, out);
}

/** A sphere direction on `chart`'s map, as atlas coordinates, into `out`. */
export function sphereToChartInto(chart: number, d: Readonly<Vec3>, out: FacePoint): FacePoint {
  sphereToTileInto(chart, d, fp);
  const c = tileCentre(chart);
  out.x = c.x + fp.x;
  out.y = c.y + fp.y;
  return out;
}

/**
 * An atlas point (written on its cell's chart) on `chart`'s map, into `out`:
 * the same ground, in that chart's coordinates - past its piece's border too.
 */
export function inChartInto(chart: number, x: number, y: number, out: FacePoint): FacePoint {
  if (identity()) { out.x = x; out.y = y; return out; }
  atlasToTileInto(x, y, local);
  if (local.tile === chart) { out.x = x; out.y = y; return out; }
  tileToSphereInto(local.tile, local.x, local.y, s3);
  return sphereToChartInto(chart, s3, out);
}

/** `inChartInto`, allocating. */
export const inChart = (chart: number, p: Readonly<Vec2>): Vec2 => inChartInto(chart, p.x, p.y, { x: 0, y: 0 });

/**
 * A point of `chart`'s map (atlas coordinates about its centre, anywhere on
 * that map, past its cell too) written on the chart of the piece it lies on,
 * into `out`. The inverse of `inChartInto`.
 */
export function toOwnerInto(chart: number, x: number, y: number, out: FacePoint): FacePoint {
  if (!__PLANET__) { out.x = x; out.y = y; return out; }
  return ownerOfChartPointInto(chart, x, y, out);
}

/** `toOwnerInto` whatever chart an edit is worked out on: the sphere's own answer. */
export function ownerOfChartPointInto(chart: number, x: number, y: number, out: FacePoint): FacePoint {
  const c = tileCentre(chart);
  tileToSphereInto(chart, x - c.x, y - c.y, s3);
  return sphereToChartInto(tileOfDirection(s3), s3, out);
}

/** `toOwnerInto`, allocating. */
export const toOwner = (chart: number, p: Readonly<Vec2>): Vec2 => toOwnerInto(chart, p.x, p.y, { x: 0, y: 0 });

const m3: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * The chart a piece of geometry between two atlas points is worked out on:
 * the owner of the point of the sphere halfway between them (their
 * directions' mean). Both ends then lie within half the piece's length of
 * that chart's own piece.
 */
export function chartBetween(ax: number, ay: number, bx: number, by: number): number {
  if (identity()) return 0;
  atlasToSphereInto(ax, ay, m3);
  const mx = m3.x, my = m3.y, mz = m3.z;
  atlasToSphereInto(bx, by, m3);
  m3.x += mx; m3.y += my; m3.z += mz;
  return tileOfDirection(m3);
}

/** A point of chart `from`'s map (atlas coordinates, past its piece too) on chart `to`'s map, into `out`. */
export function chartToChartInto(from: number, to: number, x: number, y: number, out: FacePoint): FacePoint {
  if (identity() || from === to) { out.x = x; out.y = y; return out; }
  const c = tileCentre(from);
  tileToSphereInto(from, x - c.x, y - c.y, s3);
  return sphereToChartInto(to, s3, out);
}

/**
 * The chart the pointer's points are written on while a gesture holds one
 * (`Viewport.holdChart`), or -1: each point on its own piece's chart.
 */
let pointer = -1;

/** Sets the chart a gesture's points are read on (-1: none). */
export function setPointerChart(chart: number): void {
  pointer = chart;
}

/** The chart a pointer point `p` is written on. */
export const pointerChartOf = (x: number, y: number): number => (pointer >= 0 && !identity() ? pointer : chartAt(x, y));

/** Points along each side of a piece's border in its territory's outline. */
const TERRITORY_STEPS = 16;
const territories = new Map<number, readonly (readonly [number, number])[]>();

/**
 * A piece's own ground on its chart's map (atlas coordinates): its border on
 * the sphere - the four arcs of its cell of the cube's face - sampled and
 * written on its chart, `margin` world units wider all round so two pieces'
 * drawings overlap by a hair instead of leaving one. What a chart draws is
 * cut to this, so every point of the sphere is drawn by exactly one chart.
 */
export function territory(chart: number, margin = 0.25): readonly (readonly [number, number])[] {
  const key = chart * 1000 + Math.round(margin * 100);
  const known = territories.get(key);
  if (known) return known;
  const t = TILES[chart]!;
  const step = (2 * FACE_HALF) / TILES_PER_SIDE;
  const x0 = -FACE_HALF + t.i * step, y0 = -FACE_HALF + t.j * step;
  const corners = [[x0, y0], [x0 + step, y0], [x0 + step, y0 + step], [x0, y0 + step]] as const;
  const c = tileCentre(chart);
  const ring: (readonly [number, number])[] = [];
  for (let side = 0; side < 4; side++) {
    const [ax, ay] = corners[side]!, [bx, by] = corners[(side + 1) % 4]!;
    for (let k = 0; k < TERRITORY_STEPS; k++) {
      const f = k / TERRITORY_STEPS;
      faceToSphereInto(t.face, ax + (bx - ax) * f, ay + (by - ay) * f, s3);
      sphereToTileInto(chart, s3, fp);
      const r = Math.hypot(fp.x, fp.y) || 1;
      const grow = (r + margin) / r;
      ring.push([c.x + fp.x * grow, c.y + fp.y * grow]);
    }
  }
  territories.set(key, ring);
  return ring;
}

/** Whether a point of `chart`'s map lies on that chart's own piece. */
export function onTerritory(chart: number, x: number, y: number): boolean {
  if (identity()) return true;
  const c = tileCentre(chart);
  return onTile(chart, x - c.x, y - c.y);
}

/** How far past a piece's border its neighbours are looked for, world units. */
const NEIGHBOUR_PROBE = 8;
const neighbourLists = new Map<number, readonly number[]>();

/**
 * The pieces round `chart`'s on the sphere: every one sharing a side or a
 * corner with it (eight, or seven beside a corner of the cube), found just
 * outside its border - its territory grown by `NEIGHBOUR_PROBE`, the corners
 * pushed out diagonally into the pieces that touch them there.
 */
function neighbours(chart: number): readonly number[] {
  const known = neighbourLists.get(chart);
  if (known) return known;
  const found = new Set<number>();
  const c = tileCentre(chart);
  for (const [x, y] of territory(chart, NEIGHBOUR_PROBE)) {
    tileToSphereInto(chart, x - c.x, y - c.y, s3);
    const t = tileOfDirection(s3);
    if (t !== chart) found.add(t);
  }
  const list = [...found];
  neighbourLists.set(chart, list);
  return list;
}

const pieceBoxes = new Map<number, readonly [number, number, number, number]>();
const onMap: FacePoint = { x: 0, y: 0 };

/** The box round `other`'s piece on `chart`'s map (its territory carried there). */
function pieceBox(chart: number, other: number): readonly [number, number, number, number] {
  const key = chart * TILE_COUNT + other;
  const known = pieceBoxes.get(key);
  if (known) return known;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of territory(other)) {
    chartToChartInto(other, chart, x, y, onMap);
    minX = Math.min(minX, onMap.x); minY = Math.min(minY, onMap.y);
    maxX = Math.max(maxX, onMap.x); maxY = Math.max(maxY, onMap.y);
  }
  const box = [minX, minY, maxX, maxY] as const;
  pieceBoxes.set(key, box);
  return box;
}

/**
 * The other charts whose pieces may hold part of a box of `chart`'s map,
 * into `out`: every neighbour of `chart`'s piece whose ground's box meets
 * it. For a box smaller than a piece (a road's surface, a junction's plate),
 * which can only reach the pieces round its own; a chart that gets one it
 * does not reach cuts it away (`territory`), so more is never wrong.
 *
 * Not the pieces the box's corners - or a polygon's vertices - lie on: the
 * pieces are curved quadrilaterals turned on `chart`'s map, and the corner of
 * a neighbour can stand in the middle of a straight road's side with no
 * vertex on it. That neighbour was never given the road and `chart` cut it
 * away: a pinched gap in the asphalt where four pieces meet. It is why a
 * grid with corner lookups requires cells aligned with the box and larger
 * than it; with any other cells the box is tested against the cells round
 * its own (the "loose grid" of N's broad phase,
 * https://www.metanetsoftware.com/2016/n-tutorial-b-broad-phase-collision).
 */
export function chartsTouching(chart: number, minX: number, minY: number, maxX: number, maxY: number, out: Set<number>): Set<number> {
  out.clear();
  if (identity()) return out;
  for (const other of neighbours(chart)) {
    const [x0, y0, x1, y1] = pieceBox(chart, other);
    if (x0 <= maxX && x1 >= minX && y0 <= maxY && y1 >= minY) out.add(other);
  }
  return out;
}
