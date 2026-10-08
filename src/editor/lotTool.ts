import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import {
  addPolygonLot, curveLotSide, cutLines, deleteLot, insideLot, joinLots, lotCentre, lotFrame, lotRect, lotSnapper,
  moveLotCorner, onLand, setLotFront, splitLot, zoneLots, type Lot,
} from '@world/lots';
import { solidFootprints } from '@world/buildings/geometry';
import type { BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import type { ZoneDensity, ZoneUse } from '@world/zones';

/**
 * THE ZONING TOOL: the lots the player draws, edits and zones
 * (`world/lots.ts`), and the gestures doing it - a brush stroke zoning the
 * lots it crosses, a corner dragged, a lot drawn as a rectangle or point by
 * point, a cut line, a side bent, two lots joined, a delete stroke.
 *
 * Its gestures' data lives here, with the handlers that use it (Nystrom,
 * "State": the data that only matters in one state belongs to that state),
 * not as loose variables of `main.ts` read by every handler of every tool.
 * `main.ts` hands it the pointer and draws what `overlay` returns.
 */

/** Brush paints the cells under the pointer; the other modes edit the lots. */
export type ZoneMode = 'brush' | 'fill' | 'edit' | 'front' | 'split' | 'join' | 'add' | 'polygon' | 'curve' | 'delete';
/** How the split tool cuts (`LotCut`): across the front, parallel to it, or along a drawn line. */
export type LotSplitKind = 'vertical' | 'horizontal' | 'line';

/** What the tool reads of the game and does to it. */
export interface LotToolHost {
  readonly doc: RoadDoc;
  readonly net: Network;
  zoom(): number;
  readonly settings: () => {
    readonly mode: ZoneMode; readonly use: ZoneUse; readonly density: ZoneDensity; readonly eraser: boolean;
    readonly splitKind: LotSplitKind; readonly splitParts: number;
  };
  /** An edit of the document, one undo step. */
  mutate(fn: () => boolean): void;
  hint(key: string): void;
  redraw(): void;
}

/** What the scene draws of the lots (the shape of `render/lotOverlay.ts` `LotOverlayInput`, without its key). */
export interface LotOverlay {
  readonly polygons: { corners: readonly Vec2[]; fill: number | null; fillAlpha: number; line: number; lineAlpha: number; width: number }[];
  readonly lines: { a: Vec2; b: Vec2; colour: number; dashed: boolean; width: number }[];
  readonly points: { p: Vec2; colour: number; radius: number }[];
  /** Labels for the 2D layer: a lot's size, a side's length. */
  readonly labels: { at: Vec2; kind: 'size'; width: number; depth: number }[] | { at: Vec2; kind: 'length'; length: number }[];
}

const ZONE_COLOURS: Readonly<Record<ZoneUse, number>> = { residential: 0x56bb73, commercial: 0x5da9e9, industrial: 0xd9b254 };

export class LotTool {
  /** The pointer over the map while the tool is in hand. */
  hover: Vec2 | null = null;
  /** Lots on which nothing would grow, skipped by the growth until the land or the roads change. */
  readonly refused = new Set<number>();
  private refusedNet = -1;

  /** The corners of a lot being drawn point by point (the polygon mode). */
  private polygon: Vec2[] = [];
  /** A drawn cut line, and a side being curved. */
  private cutLine: { pointer: number; a: Vec2; b: Vec2 } | null = null;
  private curve: { pointer: number; a: Vec2; b: Vec2; through: Vec2 } | null = null;
  /** A stroke of the brush, a corner being dragged, a lot being drawn, the first lot of a join. */
  private stroke: { pointer: number; remove: boolean; ids: Set<number> } | null = null;
  private corner: { pointer: number; from: Vec2; to: Vec2 } | null = null;
  private drawn: { pointer: number; a: Vec2; b: Vec2; angle: number } | null = null;
  private joinFirst: number | null = null;
  /** A stroke of the delete mode: the lots and buildings it has passed over, removed on release as one undo step. */
  private erase: { pointer: number; lots: Set<number>; buildings: Set<BuildingId> } | null = null;

  constructor(private readonly host: LotToolHost) {}

  private get doc(): RoadDoc { return this.host.doc; }
  private get net(): Network { return this.host.net; }

  /** The refused lots are tried again when the roads changed (a road edit can make room). */
  refusedFor(netRevision: number): Set<number> {
    if (this.refusedNet !== netRevision) { this.refused.clear(); this.refusedNet = netRevision; }
    return this.refused;
  }

  /** What the player is in the middle of doing with it, named (`main.ts` `currentGesture`). */
  gesture(): string | null {
    if (this.erase) return 'zona: apagando';
    if (this.stroke) return this.stroke.remove ? 'lote: tirando zona' : 'lote: pintando zona';
    if (this.corner) return 'lote: movendo um canto';
    if (this.drawn) return 'lote: desenhando';
    if (this.cutLine) return 'lote: cortando';
    if (this.curve) return 'lote: curvando um lado';
    if (this.polygon.length > 0) return 'lote: polígono';
    if (this.joinFirst !== null) return 'lote: unindo';
    return null;
  }

  /** Every gesture dropped without committing it. */
  cancel(): void {
    this.polygon = [];
    this.drawn = null;
    this.corner = null;
    this.curve = null;
    this.cutLine = null;
    this.stroke = null;
    this.joinFirst = null;
    this.erase = null;
  }

  /** Another mode picked: a polygon half drawn or a join half chosen is dropped. */
  modeChanged(): void {
    this.joinFirst = null;
    this.polygon = [];
  }

  // ------------------------------------------------------------ geometry

  /** The snap of lot points to the footways, the blocks' corners and the other lots' corners. */
  private snapReach(): number { return Math.max(m(2.5), 16 / Math.max(0.05, this.host.zoom())); }
  private snap(p: Vec2): Vec2 { return lotSnapper(this.doc, this.net)(p, this.snapReach()).p; }
  private lotAt(p: Vec2): Lot | undefined { return this.doc.lots.find((l) => insideLot(p, l)); }

  /** The side of a lot nearest a point: its two corners. */
  private sideNear(p: Vec2): { a: Vec2; b: Vec2 } | null {
    let best: { a: Vec2; b: Vec2 } | null = null, bestD = 18 / Math.max(0.05, this.host.zoom());
    for (const l of this.doc.lots) for (let i = 0; i < l.corners.length; i++) {
      const a = l.corners[i]!, b = l.corners[(i + 1) % l.corners.length]!;
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
      const d = Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
      if (d < bestD) { bestD = d; best = { a, b }; }
    }
    return best;
  }

  /** The side of a lot nearest a point within reach: the lot and the side's index (corner i to i + 1). */
  private sideAt(p: Vec2): { lot: Lot; side: number; a: Vec2; b: Vec2 } | null {
    let best: { lot: Lot; side: number; a: Vec2; b: Vec2 } | null = null, bestD = 18 / Math.max(0.05, this.host.zoom());
    for (const l of this.doc.lots) for (let i = 0; i < l.corners.length; i++) {
      const a = l.corners[i]!, b = l.corners[(i + 1) % l.corners.length]!;
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
      // Inside the lot counts as nearer: of two lots sharing a side, the one the pointer is in.
      const d = Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y) - (insideLot(p, l) ? 1e-3 : 0);
      if (d < bestD) { bestD = d; best = { lot: l, side: i, a, b }; }
    }
    return best;
  }

  /** A dragged corner's snap: onto the streets and other corners, never onto itself. */
  private snapExcept(p: Vec2, from: Vec2): Vec2 {
    const snap = lotSnapper(this.doc, this.net, this.doc.lots.map((l) => ({ id: l.id, corners: l.corners.filter((q) => Math.hypot(q.x - from.x, q.y - from.y) > m(0.8)) })));
    return snap(p, this.snapReach()).p;
  }

  /**
   * Which side of a lot is its front: the longest of those against a street
   * (a lot cut back to the footway has many short sides round a corner's curve,
   * and its front is the long straight one).
   */
  private frontSideOf(points: readonly Vec2[]): number {
    const sides = points.map((p, i) => {
      const q = points[(i + 1) % points.length]!;
      const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      let d = Infinity;
      for (const r of this.net.ribbons.values()) d = Math.min(d, r.full.distanceTo(mid));
      return { i, d, length: Math.hypot(q.x - p.x, q.y - p.y) };
    });
    const nearest = Math.min(...sides.map((side) => side.d));
    return sides.filter((side) => side.d < nearest + m(1.5)).sort((a, b) => b.length - a.length)[0]?.i ?? 0;
  }

  /** A lot as drawn, cut back to the footways (`onLand`), with its front; null when nothing is left on land. */
  private landLot(points: readonly Vec2[]): { corners: Vec2[]; front: number } | null {
    const corners = onLand(this.net, points);
    return corners ? { corners, front: this.frontSideOf(corners) } : null;
  }

  /** The direction of the street nearest a point, for a lot drawn there. */
  private streetAngleNear(p: Vec2): number {
    let best = Infinity, angle = 0;
    for (const r of this.net.ribbons.values()) {
      const d = r.full.distanceTo(p);
      if (d >= best) continue;
      const f = r.full.sampleAt(r.full.closestPoint(p).s);
      best = d; angle = Math.atan2(f.t.y, f.t.x);
    }
    return angle;
  }

  /** What the delete stroke takes at a point: the lot there, the building there. */
  private eraseUnder(world: Vec2): void {
    if (!this.erase) return;
    const lot = this.lotAt(world);
    if (lot) {
      this.erase.lots.add(lot.id);
      if (lot.building !== undefined) this.erase.buildings.add(lot.building as BuildingId);
    }
    for (const b of this.doc.buildings.all()) {
      if (Math.hypot(b.x - world.x, b.y - world.y) > m(80)) continue;
      if (solidFootprints(b).some((ring) => insideLot(world, { corners: ring }))) this.erase.buildings.add(b.id as BuildingId);
    }
  }

  // ------------------------------------------------------------ pointer

  down(pointer: number, world: Vec2, shift: boolean, detail: number): void {
    const { doc, host } = this;
    const settings = host.settings();
    const lot = this.lotAt(world);
    const zoom = Math.max(0.05, host.zoom());
    if (settings.mode === 'edit') {
      // The nearest corner within reach of the pointer.
      let best: Vec2 | null = null, bestD = 14 / zoom;
      for (const l of doc.lots) for (const q of l.corners) {
        const d = Math.hypot(q.x - world.x, q.y - world.y);
        if (d < bestD) { bestD = d; best = q; }
      }
      if (best) this.corner = { pointer, from: { ...best }, to: { ...world } };
    } else if (settings.mode === 'front') {
      // The side clicked becomes the lot's front, the side its building faces.
      const side = this.sideAt(world);
      if (!side) host.hint('hint.lot.frontPick');
      else {
        host.mutate(() => setLotFront(doc, side.lot.id, side.side));
        this.refused.clear();
        host.hint('hint.lot.front');
      }
    } else if (settings.mode === 'split') {
      if (settings.splitKind === 'line') this.cutLine = { pointer, a: { ...world }, b: { ...world } };
      else if (lot) {
        let ok = false;
        host.mutate(() => (ok = splitLot(doc, lot.id, { kind: settings.splitKind as 'vertical' | 'horizontal', parts: settings.splitParts })));
        host.hint(ok ? 'hint.lot.split' : 'hint.lot.splitFail');
      }
    } else if (settings.mode === 'polygon') {
      // A point a click; the first point again (or a double click) closes it.
      const p = this.snap(world);
      const first = this.polygon[0];
      const closing = first && this.polygon.length >= 3 && (Math.hypot(p.x - first.x, p.y - first.y) < 12 / zoom || detail >= 2);
      if (closing) {
        const points = [...this.polygon];
        this.polygon = [];
        let made = false;
        const landed = this.landLot(points);
        host.mutate(() => (made = landed !== null && addPolygonLot(doc, landed.corners, landed.front) !== null));
        host.hint(made ? 'hint.lot.added' : 'hint.lot.addFail');
      } else this.polygon.push(p);
    } else if (settings.mode === 'curve') {
      const side = this.sideNear(world);
      if (side) this.curve = { pointer, a: side.a, b: side.b, through: { ...world } };
    } else if (settings.mode === 'join') {
      if (lot && this.joinFirst === null) { this.joinFirst = lot.id; host.hint('hint.lot.joinPick'); }
      else if (lot && this.joinFirst !== null && lot.id !== this.joinFirst) {
        const first = this.joinFirst;
        let ok = false;
        host.mutate(() => (ok = joinLots(doc, first, lot.id)));
        host.hint(ok ? 'hint.lot.join' : 'hint.lot.joinFail');
        this.joinFirst = null;
      } else this.joinFirst = null;
    } else if (settings.mode === 'add') {
      this.drawn = { pointer, a: this.snap(world), b: this.snap(world), angle: this.streetAngleNear(world) };
    } else if (settings.mode === 'delete') {
      // Lots, the buildings on them or anywhere under the stroke, and the zoned cells: all at once.
      this.erase = { pointer, lots: new Set(), buildings: new Set() };
      this.eraseUnder(world);
    } else {
      // The brush zones the lots it passes over; land with no lot is not zoned.
      this.stroke = { pointer, remove: shift || settings.eraser, ids: new Set(lot ? [lot.id] : []) };
    }
    host.redraw();
  }

  /** The pointer moved; true when one of this tool's gestures took it. */
  move(pointer: number, world: Vec2): boolean {
    const { host } = this;
    if (this.stroke?.pointer === pointer) { const lot = this.lotAt(world); if (lot) this.stroke.ids.add(lot.id); host.redraw(); return true; }
    if (this.erase?.pointer === pointer) { this.eraseUnder(world); host.redraw(); return true; }
    if (this.corner?.pointer === pointer) { this.corner.to = this.snapExcept(world, this.corner.from); host.redraw(); return true; }
    if (this.drawn?.pointer === pointer) { this.drawn.b = this.snap(world); host.redraw(); return true; }
    if (this.cutLine?.pointer === pointer) { this.cutLine.b = { ...world }; host.redraw(); return true; }
    if (this.curve?.pointer === pointer) { this.curve.through = { ...world }; host.redraw(); return true; }
    return false;
  }

  /** The pointer let go: the gesture it held is committed (`commit`), or dropped. */
  up(pointer: number, commit: boolean): void {
    const { doc, host } = this;
    const settings = host.settings();
    if (this.stroke?.pointer === pointer) {
      const stroke = this.stroke;
      this.stroke = null;
      if (commit && !stroke.ids.size) host.hint('hint.zone.empty');
      else if (commit) {
        host.mutate(() => zoneLots(doc, [...stroke.ids], stroke.remove ? null : { use: settings.use, density: settings.density }));
        this.refused.clear();
        host.hint(stroke.remove ? 'hint.zone.removed' : 'hint.zone.painted');
      }
      host.redraw();
    }
    if (this.corner?.pointer === pointer) {
      const drag = this.corner;
      this.corner = null;
      if (commit && Math.hypot(drag.to.x - drag.from.x, drag.to.y - drag.from.y) > m(0.3)) {
        host.mutate(() => moveLotCorner(doc, drag.from, drag.to));
        this.refused.clear();
      }
      host.redraw();
    }
    if (this.cutLine?.pointer === pointer) {
      const line = this.cutLine;
      this.cutLine = null;
      if (commit && Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y) > m(2)) {
        // Every lot the line crosses is cut along it.
        const crossed = doc.lots.filter((l) => cutLines(l, { kind: 'line', a: line.a, b: line.b }).length &&
          l.corners.some((q) => (line.b.x - line.a.x) * (q.y - line.a.y) - (line.b.y - line.a.y) * (q.x - line.a.x) > 0) &&
          l.corners.some((q) => (line.b.x - line.a.x) * (q.y - line.a.y) - (line.b.y - line.a.y) * (q.x - line.a.x) < 0) &&
          segmentCrossesLot(line.a, line.b, l.corners));
        let ok = false;
        host.mutate(() => { for (const l of crossed) ok = splitLot(doc, l.id, { kind: 'line', a: line.a, b: line.b }) || ok; return ok; });
        host.hint(ok ? 'hint.lot.split' : 'hint.lot.splitFail');
      }
      host.redraw();
    }
    if (this.curve?.pointer === pointer) {
      const bend = this.curve;
      this.curve = null;
      if (commit) host.mutate(() => curveLotSide(doc, bend.a, bend.b, bend.through));
      host.redraw();
    }
    if (this.drawn?.pointer === pointer) {
      const drawn = this.drawn;
      this.drawn = null;
      if (commit) {
        let made = false;
        const rect = lotRect(drawn.a, drawn.b, drawn.angle);
        const landed = rect ? this.landLot(rect) : null;
        host.mutate(() => (made = landed !== null && addPolygonLot(doc, landed.corners, landed.front) !== null));
        host.hint(made ? 'hint.lot.added' : 'hint.lot.addFail');
      }
      host.redraw();
    }
    if (this.erase?.pointer === pointer) {
      const stroke = this.erase;
      this.erase = null;
      if (commit && (stroke.lots.size || stroke.buildings.size)) {
        host.mutate(() => {
          for (const id of stroke.lots) deleteLot(doc, id);
          for (const id of stroke.buildings) doc.buildings.remove(id);
          return true;
        });
        host.hint('hint.lot.deleted');
      }
      host.redraw();
    }
  }

  // ------------------------------------------------------------ drawing

  /**
   * The lots as the scene draws them: in the Zoning tool (`editing`) every
   * lot with its front marked and what the mode would do under the pointer;
   * with the other tools only the zoned ones, faintly, and none built on.
   */
  overlay(editing: boolean): LotOverlay {
    const { doc } = this;
    const settings = this.host.settings();
    const hoverLot = editing && this.hover ? this.lotAt(this.hover) : undefined;
    const corner = this.corner;
    const dragged = (q: Vec2): Vec2 => corner && Math.hypot(q.x - corner.from.x, q.y - corner.from.y) < m(0.8) ? corner.to : q;
    const polygons: LotOverlay['polygons'] = [];
    const lines: LotOverlay['lines'] = [];
    const points: LotOverlay['points'] = [];
    for (const l of doc.lots) {
      const built = l.building !== undefined && doc.buildings.has(l.building as BuildingId);
      if (!editing && (!l.use || built)) continue;
      const painting = this.stroke?.ids.has(l.id);
      const brushHover = l === hoverLot && settings.mode === 'brush';
      const picked = editing && (l.id === this.joinFirst || (l === hoverLot && !brushHover && settings.mode !== 'edit'));
      const fill = painting ? (this.stroke!.remove ? 0xe36c60 : ZONE_COLOURS[settings.use]) : l.use ? ZONE_COLOURS[l.use] : brushHover ? (settings.eraser ? 0xe36c60 : ZONE_COLOURS[settings.use]) : null;
      const fillAlpha = painting ? 0.6 : l.use ? (editing ? (built ? 0.22 : 0.45) : 0.25) : brushHover ? 0.35 : 0;
      polygons.push({ corners: l.corners.map(dragged), fill, fillAlpha,
        line: picked ? (settings.mode === 'delete' ? 0xff6b5e : 0xffd25e) : 0xffffff, lineAlpha: editing ? (picked ? 1 : 0.85) : 0,
        width: picked ? 0.7 : 0.35 });
    }
    if (editing && settings.mode === 'edit') for (const l of doc.lots) for (const q of l.corners) points.push({ p: dragged(q), colour: 0xffffff, radius: 0.6 });
    // Each lot's front, the side its building faces: marked in the Zoning tool.
    if (editing) for (const l of doc.lots) if (l.corners.length > 1) {
      const a = dragged(l.corners[0]!), b = dragged(l.corners[1]!);
      lines.push({ a, b, colour: 0x5ee0ff, dashed: false, width: 0.8 });
      // An arrow from inside the lot out through the middle of its front, towards the street.
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < m(2)) continue;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const centre = lotCentre(l);
      let nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
      if ((mid.x - centre.x) * nx + (mid.y - centre.y) * ny < 0) { nx = -nx; ny = -ny; }
      const size = Math.min(m(7), len * 0.35, Math.max(m(2), Math.hypot(mid.x - centre.x, mid.y - centre.y) * 0.6));
      const tail = { x: mid.x - nx * size, y: mid.y - ny * size };
      const tip = { x: mid.x - nx * size * 0.15, y: mid.y - ny * size * 0.15 };
      const head = size * 0.4, tx = -ny, ty = nx;
      lines.push({ a: tail, b: tip, colour: 0x5ee0ff, dashed: false, width: 1 });
      lines.push({ a: tip, b: { x: tip.x - nx * head + tx * head * 0.7, y: tip.y - ny * head + ty * head * 0.7 }, colour: 0x5ee0ff, dashed: false, width: 1 });
      lines.push({ a: tip, b: { x: tip.x - nx * head - tx * head * 0.7, y: tip.y - ny * head - ty * head * 0.7 }, colour: 0x5ee0ff, dashed: false, width: 1 });
    }
    if (editing && settings.mode === 'front' && this.hover) {
      const side = this.sideAt(this.hover);
      if (side) lines.push({ a: side.a, b: side.b, colour: 0xffd25e, dashed: false, width: 1 });
    }
    if (editing && settings.mode === 'split' && settings.splitKind !== 'line' && hoverLot) {
      for (const [a, b] of cutLines(hoverLot, { kind: settings.splitKind, parts: settings.splitParts })) lines.push({ a, b, colour: 0xffd25e, dashed: true, width: 0.5 });
    }
    if (this.cutLine) lines.push({ a: this.cutLine.a, b: this.cutLine.b, colour: 0xffd25e, dashed: true, width: 0.5 });
    if (this.curve) {
      const { a, b, through } = this.curve;
      const c = { x: 2 * through.x - (a.x + b.x) / 2, y: 2 * through.y - (a.y + b.y) / 2 };
      let prev = a;
      for (let k = 1; k <= 16; k++) {
        const t = k / 16, s1 = 1 - t;
        const q = { x: s1 * s1 * a.x + 2 * s1 * t * c.x + t * t * b.x, y: s1 * s1 * a.y + 2 * s1 * t * c.y + t * t * b.y };
        lines.push({ a: prev, b: q, colour: 0xffd25e, dashed: false, width: 0.6 });
        prev = q;
      }
    }
    if (editing && settings.mode === 'curve' && !this.curve && this.hover) {
      const side = this.sideNear(this.hover);
      if (side) lines.push({ a: side.a, b: side.b, colour: 0xffd25e, dashed: false, width: 0.7 });
    }
    if (this.polygon.length) {
      const pts = [...this.polygon, ...(this.hover ? [this.snap(this.hover)] : [])];
      for (let i = 1; i < pts.length; i++) lines.push({ a: pts[i - 1]!, b: pts[i]!, colour: 0xffffff, dashed: false, width: 0.5 });
      for (const q of this.polygon) points.push({ p: q, colour: 0xffffff, radius: 0.6 });
    }
    if (editing && (settings.mode === 'polygon' || settings.mode === 'add' || corner) && this.hover) {
      points.push({ p: corner ? corner.to : this.snap(this.hover), colour: 0x5ee0ff, radius: 0.9 });
    }
    if (this.drawn) {
      // As it will be made: cut back to the footways.
      const rect = lotRect(this.drawn.a, this.drawn.b, this.drawn.angle);
      const cut = rect ? onLand(this.net, rect) : null;
      if (cut) polygons.push({ corners: cut, fill: 0xffffff, fillAlpha: 0.2, line: 0xffffff, lineAlpha: 1, width: 0.5 });
    }
    let labels: LotOverlay['labels'] = [];
    if (editing && hoverLot && !this.polygon.length) {
      const f = lotFrame(hoverLot);
      labels = [{ at: lotCentre(hoverLot), kind: 'size', width: f.width, depth: f.depth }];
    } else if (this.polygon.length && this.hover) {
      const a = this.polygon[this.polygon.length - 1]!, b = this.snap(this.hover);
      labels = [{ at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, kind: 'length', length: Math.hypot(b.x - a.x, b.y - a.y) }];
    }
    return { polygons, lines, points, labels };
  }
}

/** Whether the segment a-b passes through the inside of a lot. */
function segmentCrossesLot(a: Vec2, b: Vec2, q: readonly Vec2[]): boolean {
  for (let k = 0; k <= 20; k++) if (insideLot({ x: a.x + (b.x - a.x) * k / 20, y: a.y + (b.y - a.y) * k / 20 }, { corners: q })) return true;
  return false;
}
