// Peças dos interiores: paredes internas com vãos, batentes e escadas.
import type { Building, Opening, Storey } from '../core/schema';
import { sortedStoreys } from '../core/model';
import { clamp } from './polygon';
import { wallEnds } from './walls';
import { stairSteps } from './stairs';
import type { BuildingParts, MaterialKey, PartData, Vec3, WallHole } from './parts';
import { CAP, emptyParts } from './parts';

export interface InteriorOptions {
  /** Corta tudo acima desta altura (coordenada y do edifício). */
  cutY?: number;
}

const PLASTER: MaterialKey = { role: 'wall', color: '#ebe6dc', roughness: 0.9, doubleSide: true };
const WOOD: MaterialKey = { role: 'frame', color: '#7a5f45', roughness: 0.7 };
const STAIR: MaterialKey = { role: 'stone', color: '#cfc9bd', roughness: 0.8 };

export function buildInteriorParts(b: Building, opts: InteriorOptions = {}, out: BuildingParts = emptyParts()): BuildingParts {
  const storeys = sortedStoreys(b);
  const byId = new Map(storeys.map((s) => [s.id, s]));
  const doorsByWall = new Map<string, Opening[]>();
  for (const o of b.openings) {
    if (o.host.kind !== 'wall') continue;
    const list = doorsByWall.get(o.host.wallId) ?? [];
    list.push(o);
    doorsByWall.set(o.host.wallId, list);
  }
  storeys.forEach((s: Storey, si) => {
    const e = s.elevation;
    if (opts.cutY !== undefined && e >= opts.cutY) return;
    const top = opts.cutY !== undefined ? Math.min(s.height, opts.cutY - e) : s.height;
    const bottom = s.slabThickness;
    if (top <= bottom + 0.05) return;
    for (const w of s.graph.walls) {
      const ends = wallEnds(s.graph, w);
      if (!ends) continue;
      const [a, bb] = ends;
      const len = Math.hypot(bb[0] - a[0], bb[1] - a[1]);
      if (len < 0.05) continue;
      const tx = (bb[0] - a[0]) / len,
        tz = (bb[1] - a[1]) / len,
        nx = tz,
        nz = -tx,
        ang = -Math.atan2(tz, tx),
        t = w.thickness;
      const data: PartData = { buildingId: b.id, massId: '', part: 'iwall', storey: si, storeyId: s.id, wallId: w.id };
      const holes: WallHole[] = [];
      for (const o of doorsByWall.get(w.id) ?? []) {
        if (o.host.kind !== 'wall' || o.host.storeyId !== s.id) continue;
        const wd = Math.min(o.width, len - 0.1),
          cx = clamp(o.offset, wd / 2 + 0.05, len - wd / 2 - 0.05),
          y0 = bottom + o.sill,
          h = Math.min(o.height, top - y0 - 0.02);
        if (wd < 0.3 || h < 0.5) continue;
        holes.push({ center: cx, width: wd, height: h, left: cx - wd / 2, right: cx + wd / 2, bottom: y0, top: y0 + h, arch: !!o.fill.arch });
        // Batentes dos dois lados.
        const place = (sAlong: number, y: number): Vec3 => [a[0] + tx * sAlong, e + y, a[1] + tz * sAlong];
        const fd: PartData = { ...data, part: 'idoor', openingId: o.id };
        out.boxes.push({ mat: WOOD, size: [0.06, h, t + 0.04], pos: place(cx - wd / 2, y0 + h / 2), angle: ang, roll: 0, data: fd });
        out.boxes.push({ mat: WOOD, size: [0.06, h, t + 0.04], pos: place(cx + wd / 2, y0 + h / 2), angle: ang, roll: 0, data: fd });
        out.boxes.push({ mat: WOOD, size: [wd + 0.12, 0.06, t + 0.04], pos: place(cx, y0 + h), angle: ang, roll: 0, data: fd });
      }
      out.walls.push({ mat: PLASTER, origin: [a[0] + nx * (t / 2), e, a[1] + nz * (t / 2)], angle: ang, length: len, bottom, top, depth: t, holes, data });
      if (opts.cutY !== undefined && top < s.height - 1e-6) out.boxes.push({ mat: CAP, size: [len + t, 0.03, t + 0.01], pos: [a[0] + tx * (len / 2), e + top + 0.016, a[1] + tz * (len / 2)], angle: ang, roll: 0, data });
    }
    void si;
  });
  for (const st of b.stairs) {
    const from = byId.get(st.fromStorey),
      to = byId.get(st.toStorey);
    if (!from || !to) continue;
    const floor = from.elevation + from.slabThickness;
    const rise = to.elevation + to.slabThickness - floor;
    const si = storeys.indexOf(from);
    for (const step of stairSteps(st.path, st.width, rise)) {
      if (opts.cutY !== undefined && floor + step.top > opts.cutY + 0.01) continue;
      out.boxes.push({
        mat: STAIR,
        size: [step.length + (step.landing ? 0 : 0.02), step.top, step.width],
        pos: [step.center[0], floor + step.top / 2, step.center[1]],
        angle: step.angle,
        roll: 0,
        data: { buildingId: b.id, massId: '', part: 'stair', storey: si, storeyId: from.id, stairId: st.id },
      });
    }
  }
  return out;
}
