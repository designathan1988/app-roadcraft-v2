// Coberturas pelo esqueleto reto: quatro águas, duas águas (com empenas) e
// mansarda, com beiral. Derivações no espírito do streets.gl:
//  - quatro águas: altura proporcional ao tempo do esqueleto;
//  - duas águas: as arestas de topo (faces triangulares com cumeeira) recebem
//    peso 0, viram empenas verticais e as águas laterais vão até a borda;
//  - mansarda: dobra a altura em duas inclinações (parte baixa íngreme).
// Quem chama deve tratar erro (SkeletonError) voltando à cobertura antiga.
import earcut from 'earcut';
import type { Vec2 } from '../../core/schema';
import { signedArea } from '../polygon';
import { SkeletonError, straightSkeleton, type P3 } from './skeleton';

export type SkeletonRoofKind = 'hip' | 'gable' | 'mansard';

export interface SkeletonRoofOptions {
  kind: SkeletonRoofKind;
  /** y do topo das paredes. */
  top: number;
  /** Altura da cumeeira acima do topo das paredes. */
  height: number;
  /** Beiral, em metros (padrão 0). */
  overhang?: number;
  /** Direção da cumeeira (graus, 0 = eixo x local) para escolher as empenas. */
  direction?: number;
}

export interface RoofGeometry {
  /** Triângulos das águas [x, y, z, ...]. */
  roof: number[];
  /** Triângulos das empenas (parede). */
  gables: number[];
  /** Arestas (índice no anel externo + furos) que viraram empena. */
  gableEdges: number[];
}

const cache = new Map<string, RoofGeometry>();

/** Escolhe as arestas de empena: faces triangulares cujo ápice tem cumeeira. */
export function gableEdges(outer: Vec2[], holes: Vec2[][], direction?: number): number[] {
  const n = outer.length;
  const dirOf = (i: number): Vec2 => {
    const a = outer[i]!,
      b = outer[(i + 1) % n]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  const dv: Vec2 | null = direction === undefined ? null : [Math.cos((direction * Math.PI) / 180), Math.sin((direction * Math.PI) / 180)];
  const perp = (i: number, v: Vec2, lim: number) => Math.abs(dirOf(i)[0] * v[0] + dirOf(i)[1] * v[1]) < lim;
  const hip = straightSkeleton(outer, holes);
  const same = (a: P3, b: P3) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(a[2] - b[2]) < 1e-6;
  const hasRidge = (q: P3) =>
    hip.arcs.some(([a, b]) => {
      const o = same(a, q) ? b : same(b, q) ? a : null;
      return !!o && Math.abs(o[2] - q[2]) < 1e-6 && Math.hypot(o[0] - q[0], o[1] - q[1]) > 1e-3;
    });
  let out = hip.faces
    .filter((f) => f.edge < n && f.points.length === 3)
    .filter((f) => hasRidge(f.points.reduce((m, p) => (p[2] > m[2] ? p : m))))
    .map((f) => f.edge);
  if (dv) out = out.filter((i) => perp(i, dv, 0.5));
  if (!out.length) {
    // Sem cumeeira (quadrado, polígono regular): usa a direção pedida ou a da maior aresta.
    let v = dv;
    if (!v) {
      let best = -1;
      for (let i = 0; i < n; i++) {
        const a = outer[i]!,
          b = outer[(i + 1) % n]!,
          l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (l > best + 1e-9) {
          best = l;
          v = dirOf(i);
        }
      }
    }
    out = Array.from({ length: n }, (_, i) => i).filter((i) => perp(i, v!, 0.3));
  }
  if (out.length >= n) return [];
  return out;
}

/** Recorta um polígono (x, z, t) pela condição t ≤ lim (keepBelow) ou t ≥ lim. */
function clipT(poly: P3[], lim: number, keepBelow: boolean): P3[] {
  const inside = (p: P3) => (keepBelow ? p[2] <= lim + 1e-9 : p[2] >= lim - 1e-9);
  const out: P3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!,
      b = poly[(i + 1) % poly.length]!;
    const ia = inside(a),
      ib = inside(b);
    if (ia) out.push(a);
    if (ia !== ib) {
      const k = (lim - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, lim]);
    }
  }
  return out.length >= 3 ? out : [];
}

function triangulate(poly: P3[], project: (p: P3) => Vec2, height: (t: number) => number, out: number[]) {
  if (poly.length < 3) return;
  const flat: number[] = [];
  for (const p of poly) flat.push(...project(p));
  const tri = earcut(flat);
  for (const i of tri) {
    const p = poly[i]!;
    out.push(p[0], height(p[2]), p[1]);
  }
}

/** Velocidade do vértice entre duas arestas (normais para dentro, com pesos). */
function velocity(nl: Vec2, nr: Vec2, wl: number, wr: number): Vec2 | null {
  const det = nl[0] * nr[1] - nl[1] * nr[0];
  if (Math.abs(det) < 1e-9) return nl[0] * nr[0] + nl[1] * nr[1] > 0 && wl === wr ? [nl[0] * wl, nl[1] * wl] : null;
  return [(wl * nr[1] - wr * nl[1]) / det, (nl[0] * wr - nr[0] * wl) / det];
}

/** Desloca os anéis para fora (beiral), cada aresta conforme o seu peso. */
function outset(rings: Vec2[][], weights: number[], d: number): Vec2[][] | null {
  let k = 0;
  const res: Vec2[][] = [];
  for (const ring of rings) {
    const n = ring.length,
      s = k;
    const normals: Vec2[] = ring.map((a, i) => {
      const b = ring[(i + 1) % n]!;
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
    });
    const out: Vec2[] = [];
    for (let i = 0; i < n; i++) {
      const L = (i - 1 + n) % n;
      const v = velocity(normals[L]!, normals[i]!, weights[s + L]!, weights[s + i]!);
      if (!v || Math.hypot(v[0], v[1]) > 4) return null;
      out.push([ring[i]![0] - v[0] * d, ring[i]![1] - v[1] * d]);
    }
    k += n;
    res.push(out);
  }
  return res;
}

export function skeletonRoof(outerIn: Vec2[], holesIn: Vec2[][], o: SkeletonRoofOptions): RoofGeometry {
  const key = JSON.stringify([outerIn, holesIn, o]);
  const hit = cache.get(key);
  if (hit) return hit;
  const outer = signedArea(outerIn) >= 0 ? outerIn : [...outerIn].reverse();
  const holes = holesIn.map((h) => (signedArea(h) <= 0 ? h : [...h].reverse()));
  const rings = [outer, ...holes];
  const total = rings.reduce((s, r) => s + r.length, 0);
  const weights = new Array<number>(total).fill(1);
  const gEdges = o.kind === 'gable' ? gableEdges(outer, holes, o.direction) : [];
  for (const i of gEdges) weights[i] = 0;

  const want = Math.max(0, Math.min(o.overhang ?? 0, o.kind === 'mansard' ? 0.3 : 1.5));
  let ov = 0;
  let sk = null as ReturnType<typeof straightSkeleton> | null;
  if (want > 0) {
    const off = outset(rings, weights, want);
    if (off)
      try {
        sk = straightSkeleton(off[0]!, off.slice(1), weights);
        ov = want;
      } catch (e) {
        if (!(e instanceof SkeletonError)) throw e;
      }
  }
  sk ??= straightSkeleton(outer, holes, weights);
  const T = sk.maxTime;
  if (T - ov < 1e-3) throw new SkeletonError('Cobertura sem altura.');

  let height: (t: number) => number;
  let fold = Infinity;
  if (o.kind === 'mansard') {
    fold = ov + Math.min(0.4 * (T - ov), 2.5);
    const hl = o.height * 0.7;
    height = (t) => (t <= fold ? o.top + ((t - ov) / (fold - ov)) * hl : o.top + hl + ((t - fold) / Math.max(1e-6, T - fold)) * (o.height - hl));
  } else height = (t) => o.top + ((t - ov) / (T - ov)) * o.height;

  const roof: number[] = [],
    gables: number[] = [];
  const plan = (p: P3): Vec2 => [p[0], p[1]];
  for (const f of sk.faces) {
    if (f.weight > 0) {
      const pieces = Number.isFinite(fold) ? [clipT(f.points, fold, true), clipT(f.points, fold, false)] : [f.points];
      for (const piece of pieces) triangulate(piece, plan, height, roof);
    } else {
      // Empena: plano vertical da aresta, só acima do topo da parede.
      const a = f.points[0]!,
        b = f.points[1]!;
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const d: Vec2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
      const piece = clipT(f.points, ov, false);
      triangulate(piece, (p) => [(p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1], p[2]], height, gables);
    }
  }
  const res = { roof, gables, gableEdges: gEdges };
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  cache.set(key, res);
  return res;
}
