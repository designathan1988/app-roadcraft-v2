// Detecção de cômodos de um pavimento a partir das paredes internas e do
// contorno das massas (paredes externas). Os segmentos são divididos em todos
// os cruzamentos; cada face limitada do grafo planar, percorrida virando sempre
// para a aresta seguinte em sentido horário, é um cômodo. Os IDs e nomes são
// preservados casando com os cômodos anteriores por sobreposição de área.
import type { ID, Room, Vec2, WallGraph } from '../core/schema';
import { uid } from '../core/ids';
import { area, pointInPolygon, signedArea } from './polygon';
import { intersection, difference, netArea } from './boolean';
import { segmentIntersection, wallEnds } from './walls';

export interface DetectedRoom {
  polygon: Vec2[];
  holes: Vec2[][];
  area: number;
}

const key = (p: Vec2) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;

/** Segmentos [a, b] do pavimento: paredes internas + contornos das massas. */
export function storeySegments(g: WallGraph, outlines: Vec2[][]): [Vec2, Vec2][] {
  const segs: [Vec2, Vec2][] = [];
  for (const w of g.walls) {
    const e = wallEnds(g, w);
    if (e) segs.push(e);
  }
  for (const ring of outlines) for (let i = 0; i < ring.length; i++) segs.push([ring[i]!, ring[(i + 1) % ring.length]!]);
  return segs;
}

/** Faces limitadas do arranjo de segmentos, dentro do contorno externo. */
export function detectRooms(segments: [Vec2, Vec2][], outer: Vec2[][], holes: Vec2[][] = [], minArea = 0.5): DetectedRoom[] {
  // 1) Pontos de corte em cada segmento.
  const pieces: [Vec2, Vec2][] = [];
  segments.forEach(([a, b], i) => {
    const ts = [0, 1];
    segments.forEach(([c, d], j) => {
      if (i === j) return;
      const hit = segmentIntersection(a, b, c, d);
      if (hit) ts.push(hit.t);
      else {
        // Encosto colinear/extremidade sobre o segmento (T).
        for (const p of [c, d]) {
          const dx = b[0] - a[0],
            dz = b[1] - a[1],
            l2 = dx * dx + dz * dz || 1;
          const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2;
          if (t <= 0 || t >= 1) continue;
          const qx = a[0] + dx * t,
            qz = a[1] + dz * t;
          if (Math.hypot(qx - p[0], qz - p[1]) < 1e-3) ts.push(t);
        }
      }
    });
    ts.sort((x, y) => x - y);
    for (let k = 0; k < ts.length - 1; k++) {
      const t0 = ts[k]!,
        t1 = ts[k + 1]!;
      if (t1 - t0 < 1e-6) continue;
      const p: Vec2 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
      const q: Vec2 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) > 1e-3) pieces.push([p, q]);
    }
  });
  // 2) Grafo com vértices únicos.
  const pts = new Map<string, Vec2>();
  const adj = new Map<string, Set<string>>();
  for (const [p, q] of pieces) {
    const kp = key(p),
      kq = key(q);
    if (kp === kq) continue;
    if (!pts.has(kp)) pts.set(kp, p);
    if (!pts.has(kq)) pts.set(kq, q);
    (adj.get(kp) ?? adj.set(kp, new Set()).get(kp)!).add(kq);
    (adj.get(kq) ?? adj.set(kq, new Set()).get(kq)!).add(kp);
  }
  // Vizinhos ordenados por ângulo.
  const sorted = new Map<string, string[]>();
  for (const [k, ns] of adj) {
    const p = pts.get(k)!;
    sorted.set(
      k,
      [...ns].sort((x, y) => {
        const a = pts.get(x)!,
          b = pts.get(y)!;
        return Math.atan2(a[1] - p[1], a[0] - p[0]) - Math.atan2(b[1] - p[1], b[0] - p[0]);
      }),
    );
  }
  // 3) Percorre as faces: chegando em v vindo de u, segue para o vizinho
  //    anterior a u na ordem angular (curva mais à direita).
  const visited = new Set<string>();
  const faces: Vec2[][] = [];
  for (const [u, ns] of sorted)
    for (const v of ns) {
      if (visited.has(u + '>' + v)) continue;
      const face: Vec2[] = [];
      let a = u,
        b = v,
        guard = 0;
      while (!visited.has(a + '>' + b) && guard++ < 10000) {
        visited.add(a + '>' + b);
        face.push(pts.get(a)!);
        const list = sorted.get(b)!;
        const i = list.indexOf(a);
        const next = list[(i - 1 + list.length) % list.length]!;
        a = b;
        b = next;
      }
      if (face.length >= 3) faces.push(face);
    }
  // 4) Faces anti-horárias limitadas, dentro do contorno e fora dos pátios.
  const out: DetectedRoom[] = [];
  for (const f of faces) {
    if (signedArea(f) <= 1e-6) continue;
    const poly = f;
    // Ponto interior representativo (centroide do primeiro triângulo válido).
    const c = interiorPoint(poly);
    if (!outer.some((o) => pointInPolygon(c[0], c[1], o))) continue;
    if (holes.some((h) => pointInPolygon(c[0], c[1], h))) continue;
    // Pátios inteiros dentro do cômodo viram furos dele.
    const inner = holes.filter((h) => h.every((p) => pointInPolygon(p[0], p[1], poly)));
    let a = area(poly) - inner.reduce((s, h) => s + area(h), 0);
    if (a < minArea) continue;
    out.push({ polygon: poly, holes: inner, area: a });
  }
  return out;
}

/** Um ponto garantidamente dentro do polígono simples. */
export function interiorPoint(poly: Vec2[]): Vec2 {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[(i - 1 + n) % n]!,
      b = poly[i]!,
      c = poly[(i + 1) % n]!;
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (cross <= 1e-9) continue;
    const m: Vec2 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
    // O triângulo da orelha não pode conter outro vértice.
    if (poly.every((p, j) => j === i || j === (i + 1) % n || j === (i - 1 + n) % n || !pointInPolygon(p[0], p[1], [a, b, c]))) return m;
  }
  const s = poly.reduce((acc, p) => [acc[0] + p[0] / n, acc[1] + p[1] / n] as Vec2, [0, 0] as Vec2);
  return s;
}

/** Casa os cômodos detectados com os anteriores (sobreposição > 50%). */
export function matchRooms(previous: Room[], detected: DetectedRoom[], wallsOf: (r: DetectedRoom) => ID[], newId: () => ID = uid): Room[] {
  const used = new Set<ID>();
  let n = previous.length;
  return detected.map((d) => {
    let best: { room: Room; score: number } | null = null;
    for (const r of previous) {
      if (used.has(r.id) || !r.polygon) continue;
      let inter = 0;
      try {
        inter = intersection([d.polygon], [r.polygon]).reduce((s, p) => s + netArea(p), 0);
      } catch {
        inter = 0;
      }
      const score = inter / Math.max(d.area, area(r.polygon));
      if (score > 0.5 && (!best || score > best.score)) best = { room: r, score };
    }
    if (best) {
      used.add(best.room.id);
      return { ...best.room, polygon: d.polygon, area: d.area, wallIds: wallsOf(d) };
    }
    return { id: newId(), name: 'Cômodo ' + ++n, polygon: d.polygon, area: d.area, wallIds: wallsOf(d) };
  });
}

export { difference };
