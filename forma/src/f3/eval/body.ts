// Corpo de um sólido: a planta amostrada embaixo, o topo deslocado (afunilamento
// e inclinação por lado) em cima, e as paredes entre os dois. Cada segmento
// lateral vira uma face com referencial próprio para a fachada.
import type { Solid, Vec2, Vec3 } from '../model/schema';
import { offsetRing, oriented, ringValid, sampleRing, type SampledRing } from '../model/plan';
import { FaceTable, type FaceFrame } from './faces';
import { MeshBuilder, triangulatePlan } from './mesh';

export interface SolidRings {
  outer: SampledRing;
  holes: SampledRing[];
  topOuter: Vec2[];
  topHoles: Vec2[][];
  base: number;
  top: number;
}

/** Desvio do topo de cada segmento: afunilamento + altura · tan(inclinação do lado). */
function segmentOffsets(s: Solid, r: SampledRing, factor: number): number[] {
  return r.segs.map((seg) => {
    const edgeId = seg.edge.endsWith(':c') ? seg.edge.slice(0, -2) : seg.edge;
    const lean = s.edges[edgeId]?.lean ?? 0;
    return (s.taper + s.height * Math.tan((Math.max(-60, Math.min(60, lean)) * Math.PI) / 180)) * factor;
  });
}

export function solidRings(s: Solid): SolidRings {
  const outer = sampleRing(oriented(s.plan.outer, 1));
  const holes = s.plan.holes.map((h) => sampleRing(oriented(h, -1)));
  let factor = 1;
  let topOuter = offsetRing(outer.pts, segmentOffsets(s, outer, factor));
  let topHoles = holes.map((h) => offsetRing(h.pts, segmentOffsets(s, h, factor)));
  // Afunilamento grande demais: reduz até o topo voltar a ser um polígono válido.
  for (let k = 0; k < 12 && !(ringValid(topOuter, 1) && topHoles.every((h) => ringValid(h, -1))); k++) {
    factor *= 0.8;
    topOuter = offsetRing(outer.pts, segmentOffsets(s, outer, factor));
    topHoles = holes.map((h) => offsetRing(h.pts, segmentOffsets(s, h, factor)));
  }
  return { outer, holes, topOuter, topHoles, base: s.base, top: s.base + s.height };
}

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm3 = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Referencial de uma face lateral: u ao longo, v subindo pela face, n para fora. */
export function sideFrame(b0: Vec3, b1: Vec3, t0: Vec3, s0: number, s1: number): FaceFrame {
  const u = norm3(sub3(b1, b0));
  const w = sub3(t0, b0);
  const k = dot3(w, u);
  const v = norm3([w[0] - u[0] * k, w[1] - u[1] * k, w[2] - u[2] * k]);
  const n = norm3(cross3(v, u));
  return { o: b0, u, v, n, s0, s1 };
}

/**
 * Malha fechada do corpo. `kind` diferencia sólidos de subtração (as faces
 * deles viram as paredes do recorte).
 */
export function bodyMesh(s: Solid, r: SolidRings, table: FaceTable, mb = new MeshBuilder()): MeshBuilder {
  const cutter = s.op === 'subtract';
  const bottomId = table.add({ kind: cutter ? 'cutter' : 'bottom', solid: s.id });
  const topId = table.add({ kind: cutter ? 'cutter' : 'top', solid: s.id });
  const y0 = r.base,
    y1 = r.top;
  const cap = (outer: Vec2[], holes: Vec2[][], y: number, id: number, up: boolean) => {
    const { pts, tris } = triangulatePlan(outer, holes);
    for (let t = 0; t < tris.length; t += 3) {
      const a = pts[tris[t]!]!,
        b = pts[tris[t + 1]!]!,
        c = pts[tris[t + 2]!]!;
      mb.triangle([a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]], id, [0, up ? 1 : -1, 0]);
    }
  };
  cap(r.outer.pts, r.holes.map((h) => h.pts), y0, bottomId, false);
  cap(r.topOuter, r.topHoles, y1, topId, true);
  const rings: [SampledRing, Vec2[], number][] = [[r.outer, r.topOuter, -1], ...r.holes.map((h, i) => [h, r.topHoles[i]!, i] as [SampledRing, Vec2[], number])];
  for (const [ring, top, ringIndex] of rings) {
    const n = ring.pts.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = ring.pts[i]!,
        b = ring.pts[j]!,
        ta = top[i]!,
        tb = top[j]!;
      const seg = ring.segs[i]!;
      const B0: Vec3 = [a[0], y0, a[1]],
        B1: Vec3 = [b[0], y0, b[1]],
        T0: Vec3 = [ta[0], y1, ta[1]],
        T1: Vec3 = [tb[0], y1, tb[1]];
      const frame = sideFrame(B0, B1, T0, seg.s0, seg.s1);
      const id = table.add({ kind: cutter ? 'cutter' : 'side', solid: s.id, edge: seg.edge, seg: i, ring: ringIndex, frame, smooth: seg.curved });
      const dx = b[0] - a[0],
        dz = b[1] - a[1];
      mb.quad(B0, B1, T1, T0, id, [dz, 0, -dx]);
    }
  }
  return mb;
}
