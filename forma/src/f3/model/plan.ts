// Planta de um sólido → anel amostrado, com a origem de cada segmento.
// Arcos pela convenção bulge (tan(θ/4)), cantos arredondados (round) e
// chanfrados (chamfer). Cada segmento sabe de que lado veio e onde começa
// ao longo dele (s), para a fachada distribuir componentes pelo lado inteiro,
// mesmo curvo. Sem three.
import type { ID, PlanVertex, Vec2 } from './schema';

export interface Segment {
  /** Lado de origem (ID do vértice inicial) ou canto (`<id>:c`). */
  edge: ID;
  /** Distância ao longo do lado de origem no início e no fim do segmento. */
  s0: number;
  s1: number;
  /** Segmento de um arco (lado curvo) ou de um canto arredondado. */
  curved: boolean;
}

export interface SampledRing {
  /** Pontos; o segmento i vai de pts[i] a pts[i+1] (fechado). */
  pts: Vec2[];
  segs: Segment[];
}

/** Tolerância de corda (m) para amostrar arcos. */
const CHORD_TOL = 0.02;
const MAX_ARC_SEGS = 48;

export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const len = (a: Vec2): number => Math.hypot(a[0], a[1]);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

export function signedArea2(p: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!,
      b = p[(i + 1) % p.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** Número de segmentos para um arco de raio r e ângulo θ, dentro da tolerância de corda. */
export function arcSegments(r: number, theta: number): number {
  const a = Math.abs(theta);
  if (r < 1e-6 || a < 1e-6) return 1;
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - CHORD_TOL / r)));
  return Math.max(2, Math.min(MAX_ARC_SEGS, Math.ceil(a / Math.max(step, 0.05))));
}

/** Centro e raio do arco de a até b com o bulge dado. */
export function arcOf(a: Vec2, b: Vec2, bulge: number): { c: Vec2; r: number; theta: number; a0: number } {
  const theta = 4 * Math.atan(bulge);
  const chord = dist(a, b);
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const m = lerp(a, b, 0.5);
  const d = sub(b, a);
  const l = len(d) || 1;
  // Normal à esquerda da corda; o centro fica do lado oposto ao bojo.
  const nl: Vec2 = [-d[1] / l, d[0] / l];
  const h = r * Math.cos(Math.abs(theta) / 2);
  // bulge > 0 com anel anti-horário: arco para fora (para a direita da corda) → centro à esquerda.
  const sgn = bulge > 0 ? 1 : -1;
  const c: Vec2 = [m[0] + nl[0] * h * sgn, m[1] + nl[1] * h * sgn];
  const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
  return { c, r, theta, a0 };
}

interface Corner {
  /** Ponto onde o lado anterior termina e o seguinte começa. */
  inP: Vec2;
  outP: Vec2;
  /** Pontos intermediários do canto (arredondado). */
  mid: Vec2[];
}

/** Recorte de um canto: arredondado (round) ou chanfrado (chamfer), limitado pelos lados. */
function cornerOf(prev: Vec2, v: Vec2, next: Vec2, round: number, chamfer: number): Corner | null {
  const d1 = sub(prev, v),
    d2 = sub(next, v);
  const l1 = len(d1),
    l2 = len(d2);
  if (l1 < 1e-6 || l2 < 1e-6) return null;
  const u1: Vec2 = [d1[0] / l1, d1[1] / l1],
    u2: Vec2 = [d2[0] / l2, d2[1] / l2];
  const cos = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
  const ang = Math.acos(cos);
  if (ang < 1e-3 || Math.PI - ang < 1e-3) return null;
  const maxT = Math.min(l1, l2) * 0.49;
  if (chamfer > 0 && !(round > 0)) {
    const t = Math.min(chamfer, maxT);
    return { inP: [v[0] + u1[0] * t, v[1] + u1[1] * t], outP: [v[0] + u2[0] * t, v[1] + u2[1] * t], mid: [] };
  }
  if (!(round > 0)) return null;
  let t = round / Math.tan(ang / 2);
  let r = round;
  if (t > maxT) {
    t = maxT;
    r = t * Math.tan(ang / 2);
  }
  const p1: Vec2 = [v[0] + u1[0] * t, v[1] + u1[1] * t],
    p2: Vec2 = [v[0] + u2[0] * t, v[1] + u2[1] * t];
  const bis: Vec2 = [u1[0] + u2[0], u1[1] + u2[1]];
  const bl = len(bis) || 1;
  const cd = r / Math.sin(ang / 2);
  const c: Vec2 = [v[0] + (bis[0] / bl) * cd, v[1] + (bis[1] / bl) * cd];
  let a1 = Math.atan2(p1[1] - c[1], p1[0] - c[0]);
  let a2 = Math.atan2(p2[1] - c[1], p2[0] - c[0]);
  let da = a2 - a1;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  const n = arcSegments(r, da);
  const mid: Vec2[] = [];
  for (let k = 1; k < n; k++) {
    const a = a1 + (da * k) / n;
    mid.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
  }
  void a2;
  return { inP: p1, outP: p2, mid };
}

/**
 * Amostra um anel da planta. `orient` força o sentido (1 anti-horário para o
 * anel externo, -1 horário para furos) sem perder a origem dos segmentos.
 */
export function sampleRing(vs: PlanVertex[]): SampledRing {
  const n = vs.length;
  const corners: (Corner | null)[] = vs.map((v, i) => {
    const prevV = vs[(i - 1 + n) % n]!,
      nextV = vs[(i + 1) % n]!;
    // Cantos só entre lados retos (o arco já é liso).
    if ((prevV.bulge ?? 0) !== 0 || (v.bulge ?? 0) !== 0) return null;
    return cornerOf(prevV.p, v.p, nextV.p, v.round ?? 0, v.chamfer ?? 0);
  });
  const pts: Vec2[] = [];
  const segs: Segment[] = [];
  for (let i = 0; i < n; i++) {
    const v = vs[i]!,
      w = vs[(i + 1) % n]!;
    const c0 = corners[i],
      c1 = corners[(i + 1) % n];
    const start = c0 ? c0.outP : v.p;
    const end = c1 ? c1.inP : w.p;
    const bulge = v.bulge ?? 0;
    const off0 = c0 ? dist(v.p, c0.outP) : 0;
    if (Math.abs(bulge) > 1e-6) {
      const arc = arcOf(v.p, w.p, bulge);
      const k = arcSegments(arc.r, arc.theta);
      // s pelas cordas (a parede é feita delas): segmentos contíguos sem frestas.
      const chord = 2 * arc.r * Math.sin(Math.abs(arc.theta) / (2 * k));
      for (let j = 0; j < k; j++) {
        const a = arc.a0 + (arc.theta * j) / k;
        pts.push([arc.c[0] + Math.cos(a) * arc.r, arc.c[1] + Math.sin(a) * arc.r]);
        segs.push({ edge: v.id, s0: chord * j, s1: chord * (j + 1), curved: true });
      }
    } else {
      pts.push(start);
      segs.push({ edge: v.id, s0: off0, s1: off0 + dist(start, end), curved: false });
    }
    // Canto no fim deste lado (vértice seguinte).
    if (c1) {
      const cornerPts = [end, ...c1.mid];
      let s = 0;
      for (let j = 0; j < cornerPts.length; j++) {
        const a = cornerPts[j]!,
          b = j + 1 < cornerPts.length ? cornerPts[j + 1]! : c1.outP;
        if (j > 0) pts.push(a);
        else pts.push(a);
        const l = dist(a, b);
        segs.push({ edge: `${w.id}:c`, s0: s, s1: s + l, curved: c1.mid.length > 0 });
        s += l;
      }
    }
  }
  // Remove pontos repetidos (cantos encostados).
  for (let i = pts.length - 1; i >= 0 && pts.length > 3; i--) {
    const j = (i + 1) % pts.length;
    if (dist(pts[i]!, pts[j]!) < 1e-6) {
      pts.splice(j, 1);
      segs.splice(i, 1);
    }
  }
  return { pts, segs };
}

/** Comprimento total de cada lado (ID → m), somando os segmentos. */
export function edgeLengths(r: SampledRing): Map<ID, number> {
  const m = new Map<ID, number>();
  for (const s of r.segs) m.set(s.edge, Math.max(m.get(s.edge) ?? 0, s.s1));
  return m;
}

/** Interseção de duas retas (ponto + direção); null se paralelas. */
function intersectLines(p: Vec2, d: Vec2, q: Vec2, e: Vec2): Vec2 | null {
  const den = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
  return [p[0] + d[0] * t, p[1] + d[1] * t];
}

/**
 * Desloca cada segmento para dentro do material pela sua distância (m):
 * a normal para fora é (tz, −tx) num anel anti-horário (furos horários).
 * Os vértices novos são as interseções dos segmentos deslocados (em esquadria).
 */
export function offsetRing(pts: Vec2[], d: number[]): Vec2[] {
  const n = pts.length;
  const lines = pts.map((a, i) => {
    const b = pts[(i + 1) % n]!;
    const l = dist(a, b) || 1;
    const t: Vec2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    const out: Vec2 = [t[1], -t[0]];
    const k = d[i] ?? 0;
    return { p: [a[0] - out[0] * k, a[1] - out[1] * k] as Vec2, t };
  });
  return pts.map((_, i) => {
    const L = lines[(i - 1 + n) % n]!,
      C = lines[i]!;
    return intersectLines(L.p, L.t, C.p, C.t) ?? C.p;
  });
}

/** O anel não se cruza e mantém o sentido (topo de um afunilamento ainda válido). */
export function ringValid(pts: Vec2[], sign: number): boolean {
  if (pts.length < 3) return false;
  if (Math.sign(signedArea2(pts)) !== sign || Math.abs(signedArea2(pts)) < 0.05) return false;
  const n = pts.length;
  const cross = (a: Vec2, b: Vec2, c: Vec2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < n; i++) {
    const a = pts[i]!,
      b = pts[(i + 1) % n]!;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = pts[j]!,
        e = pts[(j + 1) % n]!;
      if (cross(a, b, c) * cross(a, b, e) < -1e-10 && cross(c, e, a) * cross(c, e, b) < -1e-10) return false;
    }
  }
  return true;
}

/** Garante o sentido: anti-horário (sign 1) ou horário (sign −1). */
export function oriented(vs: PlanVertex[], sign: number): PlanVertex[] {
  const a = signedArea2(vs.map((v) => v.p));
  if (Math.sign(a) === sign || a === 0) return vs;
  // Inverter mantém cada lado com o seu ID: o lado i (de v_i a v_i+1) passa a
  // começar em v_i+1, então os IDs andam uma posição.
  const rev = [...vs].reverse();
  return rev.map((v, i) => ({ ...v, id: rev[(i + 1) % rev.length]!.id, bulge: -(rev[(i + 1) % rev.length]!.bulge ?? 0) || undefined }));
}
