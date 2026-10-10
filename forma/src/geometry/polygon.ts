// Operações de polígono 2D em planta [x, z]. Portado do FormaCore legado.
import type { Vec2 } from '../core/schema';

export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, Number(v)));

export const signedArea = (p: Vec2[]): number =>
  p.reduce((s, a, i) => {
    const b = p[(i + 1) % p.length]!;
    return s + a[0] * b[1] - b[0] * a[1];
  }, 0) / 2;

export const area = (p: Vec2[]): number => Math.abs(signedArea(p));

export const cross = (a: Vec2, b: Vec2, c: Vec2): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

export interface PolygonLimits {
  maxVertices: number;
  extent: number;
  minArea: number;
  minEdge: number;
}

export const DEFAULT_POLYGON_LIMITS: PolygonLimits = { maxVertices: 128, extent: 500, minArea: 0.12, minEdge: 0.02 };

/** Polígono simples (sem autointerseção), com área e arestas mínimas. */
export function validPolygon(p: unknown, limits: PolygonLimits = DEFAULT_POLYGON_LIMITS): p is Vec2[] {
  if (!Array.isArray(p) || p.length < 3 || p.length > limits.maxVertices) return false;
  if (p.some((a) => !Array.isArray(a) || a.length !== 2 || a.some((n) => !Number.isFinite(n) || Math.abs(n) > limits.extent))) return false;
  const q = p as Vec2[];
  if (area(q) < limits.minArea) return false;
  for (let i = 0; i < q.length; i++) {
    const a = q[i]!,
      b = q[(i + 1) % q.length]!;
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < limits.minEdge) return false;
    for (let j = i + 2; j < q.length; j++) {
      if (i === 0 && j === q.length - 1) continue;
      const c = q[j]!,
        d = q[(j + 1) % q.length]!;
      if (cross(a, b, c) * cross(a, b, d) < -1e-8 && cross(c, d, a) * cross(c, d, b) < -1e-8) return false;
    }
  }
  return true;
}

/** Remove o ponto de fechamento repetido e orienta anti-horário (área positiva). */
export function clean(p: Vec2[]): Vec2[] {
  const q = p.map((a) => [+a[0], +a[1]] as Vec2);
  if (q.length > 1 && q[0]![0] === q.at(-1)![0] && q[0]![1] === q.at(-1)![1]) q.pop();
  if (signedArea(q) < 0) q.reverse();
  return q;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export function bounds(p: Vec2[]): Bounds {
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const [x, z] of p) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

export const boundsCenter = (b: Bounds): Vec2 => [(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2];

/** Ponto dentro do polígono (regra par-ímpar). */
export function pointInPolygon(x: number, z: number, p: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[i]!,
      b = p[j]!;
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Distância do ponto ao segmento ab. */
export function distanceToSegment(x: number, z: number, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0],
    dz = b[1] - a[1],
    t = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1), 0, 1);
  return Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z);
}

/** Formas básicas centradas na origem (largura em x, profundidade em z). */
export function shape(kind: string, w = 10, d = 8): Vec2[] {
  const x = w / 2,
    z = d / 2;
  if (kind === 'circle') return Array.from({ length: 32 }, (_, i) => [Math.cos((i * Math.PI) / 16) * x, Math.sin((i * Math.PI) / 16) * z] as Vec2);
  if (kind === 'l') return [[-x, -z], [x, -z], [x, -z + d * 0.42], [-x + w * 0.42, -z + d * 0.42], [-x + w * 0.42, z], [-x, z]];
  if (kind === 'u')
    return [[-x, -z], [x, -z], [x, z], [x - w * 0.3, z], [x - w * 0.3, -z + d * 0.38], [-x + w * 0.3, -z + d * 0.38], [-x + w * 0.3, z], [-x, z]];
  return [[-x, -z], [x, -z], [x, z], [-x, z]];
}
