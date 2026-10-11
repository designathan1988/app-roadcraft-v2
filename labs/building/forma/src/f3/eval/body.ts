// Corpo de um sólido: a planta amostrada embaixo, o topo deslocado (afunilamento
// e inclinação por lado) em cima, e as paredes entre os dois. Com bisel, anéis
// do perfil entram acima e abaixo da faixa reta (como o Bevel do Blender, mas
// guardado como parâmetro). Cada segmento lateral vira uma face com
// referencial próprio para a fachada.
import type { Solid, Vec2, Vec3 } from '../model/schema';
import { offsetRing, oriented, ringValid, sampleRing, type SampledRing } from '../model/plan';
import { FaceTable, type FaceFrame } from './faces';
import { MeshBuilder, triangulatePlan } from './mesh';

export interface RingLevel {
  /** Cota absoluta. */
  y: number;
  outer: Vec2[];
  holes: Vec2[][];
}

export interface SolidRings {
  outer: SampledRing;
  holes: SampledRing[];
  topOuter: Vec2[];
  topHoles: Vec2[][];
  base: number;
  top: number;
  /** Anéis de baixo para cima (dois sem bisel). */
  levels: RingLevel[];
  /** Índice do anel onde começa a faixa reta da parede. */
  wall: number;
}

const edgeOf = (e: string) => (e.endsWith(':c') ? e.slice(0, -2) : e);

/** Desvio do topo de cada segmento: afunilamento + altura · tan(inclinação do lado). */
function segmentOffsets(s: Solid, r: SampledRing): number[] {
  return r.segs.map((seg) => {
    const lean = s.edges[edgeOf(seg.edge)]?.lean ?? 0;
    return s.taper + s.height * Math.tan((Math.max(-60, Math.min(60, lean)) * Math.PI) / 180);
  });
}

export interface Bevel {
  top: number;
  bottom: number;
  segments: number;
  profile: number;
}

/** Bisel efetivo do volume (null sem bisel); a base e o topo não se cruzam. */
export function bevelOf(s: Solid): Bevel | null {
  const b = s.bevel;
  const edgeMax = Math.max(0, ...Object.values(s.edges).map((e) => e.bevel ?? 0));
  const top = Math.max(0, b?.top ?? 0),
    bottom = Math.max(0, b?.bottom ?? 0);
  if (Math.max(top, edgeMax) <= 1e-3 && bottom <= 1e-3) return null;
  const k = Math.min(1, (s.height * 0.95) / Math.max(1e-6, Math.max(top, edgeMax) + bottom));
  return { top: top * k, bottom: bottom * k, segments: Math.max(1, Math.min(12, Math.round(b?.segments ?? 1))), profile: Math.max(0, Math.min(1, b?.profile ?? 0)) };
}

/** Recuo do perfil em φ ∈ [0, π/2]: reto (profile 0) a quarto de círculo (1). A subida é w·sen φ nos dois. */
const bevelInset = (w: number, phi: number, profile: number) => w * ((1 - profile) * Math.sin(phi) + profile * (1 - Math.cos(phi)));

const NONE: ReadonlySet<string> = new Set();

/**
 * Lados encostados em outro volume de soma (emendas internas): o bisel não
 * entra neles, senão a união deixa um sulco na emenda.
 */
export function coveredEdges(s: Solid, all: Solid[], hidden: (x: Solid) => boolean = (x) => !!x.hidden): Set<string> {
  const out = new Set<string>();
  if (!bevelOf(s)) return out;
  const top = s.base + s.height;
  const others = all.filter((o) => o !== s && o.op === 'add' && !hidden(o) && o.base <= top - 0.05 && o.base + o.height >= top - 0.05).map((o) => sampleRing(oriented(o.plan.outer, 1)).pts);
  if (!others.length) return out;
  const r = sampleRing(oriented(s.plan.outer, 1));
  const state = new Map<string, boolean>();
  r.segs.forEach((seg, i) => {
    if (seg.edge.endsWith(':c')) return;
    const a = r.pts[i]!,
      b = r.pts[(i + 1) % r.pts.length]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    // Meio do segmento, 5 cm para fora (anel anti-horário: fora = direita do sentido).
    const p: Vec2 = [(a[0] + b[0]) / 2 + ((b[1] - a[1]) / l) * 0.05, (a[1] + b[1]) / 2 - ((b[0] - a[0]) / l) * 0.05];
    const hit = others.some((o) => pointIn(p, o));
    state.set(seg.edge, (state.get(seg.edge) ?? true) && hit);
  });
  for (const [e, v] of state) if (v) out.add(e);
  return out;
}

function pointIn(p: Vec2, poly: Vec2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!,
      b = poly[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

export function solidRings(s: Solid, covered: ReadonlySet<string> = NONE): SolidRings {
  const outer = sampleRing(oriented(s.plan.outer, 1));
  const holes = s.plan.holes.map((h) => sampleRing(oriented(h, -1)));
  const bev = bevelOf(s);
  const H = s.height;
  const room = H * 0.95 - (bev?.bottom ?? 0);
  // Largura do bisel do topo de cada segmento (o lado com valor próprio manda).
  const topW = (r: SampledRing) => r.segs.map((seg) => (bev && !covered.has(edgeOf(seg.edge)) ? Math.max(0, Math.min(s.edges[edgeOf(seg.edge)]?.bevel ?? bev.top, room)) : 0));
  const wOuter = topW(outer);
  const wHoles = holes.map(topW);
  const seg = bev?.segments ?? 1;
  const profile = bev?.profile ?? 0;
  type Lv = { z: number; phiBot: number };
  const lvs: Lv[] = [];
  if (bev && bev.bottom > 1e-4) {
    // Base: φ vai de π/2 (no pé, recuo máximo) a 0 (começo da parede reta).
    for (let k = 0; k <= seg; k++) {
      const phi = (Math.PI / 2) * (1 - k / seg);
      lvs.push({ z: bev.bottom * (1 - Math.sin(phi)), phiBot: phi });
    }
  } else lvs.push({ z: 0, phiBot: 0 });
  const wall = lvs.length - 1;
  // Topo: os pontos do perfil de cada largura distinta; cada lado lê o seu φ na cota.
  const widths = [...new Set([...wOuter, ...wHoles.flat()].filter((w) => w > 1e-4).map((w) => Math.round(w * 1e5) / 1e5))];
  const topZ = new Set<number>([H]);
  for (const w of widths) for (let k = 0; k <= seg; k++) topZ.add(Math.round((H - w + w * Math.sin((Math.PI / 2) * (k / seg))) * 1e6) / 1e6);
  for (const z of [...topZ].sort((a, b) => a - b)) if (z > lvs[lvs.length - 1]!.z + 1e-4) lvs.push({ z, phiBot: 0 });
  const ring = (r: SampledRing, ws: number[], l: Lv, factor: number) => {
    const lin = segmentOffsets(s, r);
    return offsetRing(
      r.pts,
      lin.map((d, i) => {
        let off = (d * l.z) / H;
        const w = ws[i]!;
        const t = l.z - (H - w);
        if (w > 1e-4 && t > 1e-6) off += bevelInset(w, Math.asin(Math.min(1, t / w)), profile);
        if (l.phiBot > 0 && !covered.has(edgeOf(r.segs[i]!.edge))) off += bevelInset(bev!.bottom, l.phiBot, profile);
        return off * factor;
      }),
    );
  };
  const build = (factor: number): RingLevel[] => lvs.map((l) => ({ y: s.base + l.z, outer: ring(outer, wOuter, l, factor), holes: holes.map((h, i) => ring(h, wHoles[i]!, l, factor)) }));
  const ok = (ls: RingLevel[]) => ls.every((l) => ringValid(l.outer, 1) && l.holes.every((h) => ringValid(h, -1)));
  let factor = 1;
  let levels = build(factor);
  // Afunilamento ou bisel grande demais: reduz até todo anel voltar a ser válido.
  for (let k = 0; k < 12 && !ok(levels); k++) {
    factor *= 0.8;
    levels = build(factor);
  }
  const last = levels[levels.length - 1]!;
  return { outer, holes, topOuter: last.outer, topHoles: last.holes, base: s.base, top: s.base + s.height, levels, wall };
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
 * Malha fechada do corpo. Sólidos de subtração viram faces 'cutter' (as
 * paredes do recorte); as faixas do bisel são 'bevel' (sem componentes).
 */
export function bodyMesh(s: Solid, r: SolidRings, table: FaceTable, mb = new MeshBuilder()): MeshBuilder {
  const cutter = s.op === 'subtract';
  const bottomId = table.add({ kind: cutter ? 'cutter' : 'bottom', solid: s.id });
  const topId = table.add({ kind: cutter ? 'cutter' : 'top', solid: s.id });
  const cap = (outer: Vec2[], holes: Vec2[][], y: number, id: number, up: boolean) => {
    const { pts, tris } = triangulatePlan(outer, holes);
    for (let t = 0; t < tris.length; t += 3) {
      const a = pts[tris[t]!]!,
        b = pts[tris[t + 1]!]!,
        c = pts[tris[t + 2]!]!;
      mb.triangle([a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]], id, [0, up ? 1 : -1, 0]);
    }
  };
  const L = r.levels;
  const first = L[0]!,
    last = L[L.length - 1]!;
  cap(first.outer, first.holes, first.y, bottomId, false);
  cap(last.outer, last.holes, last.y, topId, true);
  const lo = L[r.wall]!,
    hi = L[r.wall + 1]!;
  type Pick = (l: RingLevel) => Vec2[];
  const rings: [SampledRing, Pick, number][] = [[r.outer, (l) => l.outer, -1], ...r.holes.map((h, i) => [h, (l: RingLevel) => l.holes[i]!, i] as [SampledRing, Pick, number])];
  for (const [ring, pick, ringIndex] of rings) {
    const n = ring.pts.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const seg = ring.segs[i]!;
      // Referencial pela faixa reta, com origem na base do volume (a fachada mede dali).
      const a = pick(lo),
        b = pick(hi);
      const B0: Vec3 = [a[i]![0], r.base, a[i]![1]],
        B1: Vec3 = [a[j]![0], r.base, a[j]![1]],
        T0: Vec3 = [b[i]![0], hi.y, b[i]![1]];
      const frame = sideFrame(B0, B1, T0, seg.s0, seg.s1);
      const dx = ring.pts[j]![0] - ring.pts[i]![0],
        dz = ring.pts[j]![1] - ring.pts[i]![1];
      const wallId = table.add({ kind: cutter ? 'cutter' : 'side', solid: s.id, edge: seg.edge, seg: i, ring: ringIndex, frame, smooth: seg.curved });
      let bevelId = -1;
      for (let k = 0; k + 1 < L.length; k++) {
        const p = pick(L[k]!),
          q = pick(L[k + 1]!);
        const id = k === r.wall || cutter ? wallId : bevelId >= 0 ? bevelId : (bevelId = table.add({ kind: 'bevel', solid: s.id, edge: seg.edge, smooth: true }));
        const y0 = L[k]!.y,
          y1 = L[k + 1]!.y;
        mb.quad([p[i]![0], y0, p[i]![1]], [p[j]![0], y0, p[j]![1]], [q[j]![0], y1, q[j]![1]], [q[i]![0], y1, q[i]![1]], id, [dz, 0, -dx]);
      }
    }
  }
  return mb;
}
