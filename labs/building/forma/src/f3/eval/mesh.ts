// Malhas fechadas construídas à mão (com a face de origem em cada triângulo)
// para entrar no Manifold. Vértices iguais são fundidos por posição, então os
// sólidos saem fechados (manifold) quando as bordas coincidem. Sem three.
import earcut from 'earcut';
import type { Vec2, Vec3 } from '../model/schema';
import type { Kernel, Manifold } from '../kernel/kernel';

const Q = 1e5;

export class MeshBuilder {
  readonly pos: number[] = [];
  readonly tri: number[] = [];
  readonly face: number[] = [];
  private index = new Map<string, number>();

  vertex(p: Vec3): number {
    const key = `${Math.round(p[0] * Q)},${Math.round(p[1] * Q)},${Math.round(p[2] * Q)}`;
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.pos.length / 3;
      this.pos.push(p[0], p[1], p[2]);
      this.index.set(key, i);
    }
    return i;
  }

  /** Triângulo com a face dada, virado para `want` (normal desejada aproximada). */
  triangle(a: Vec3, b: Vec3, c: Vec3, faceId: number, want?: Vec3): void {
    const ia = this.vertex(a),
      ib = this.vertex(b),
      ic = this.vertex(c);
    if (ia === ib || ib === ic || ia === ic) return;
    if (want) {
      const n = normal(a, b, c);
      if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) {
        this.tri.push(ia, ic, ib);
        this.face.push(faceId);
        return;
      }
    }
    this.tri.push(ia, ib, ic);
    this.face.push(faceId);
  }

  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, faceId: number, want: Vec3): void {
    this.triangle(a, b, c, faceId, want);
    this.triangle(a, c, d, faceId, want);
  }

  get empty(): boolean {
    return this.tri.length === 0;
  }

  toManifold(k: Kernel): Manifold {
    const mesh = new k.Mesh({
      numProp: 3,
      vertProperties: new Float32Array(this.pos),
      triVerts: new Uint32Array(this.tri),
      faceID: new Uint32Array(this.face),
    });
    return k.Manifold.ofMesh(mesh);
  }
}

export function normal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    uz = b[2] - a[2],
    vx = c[0] - a[0],
    vy = c[1] - a[1],
    vz = c[2] - a[2];
  const n: Vec3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

/** Triangulação de um polígono com furos e pontos internos (earcut aceita furos de um ponto). */
export function triangulatePlan(outer: Vec2[], holes: Vec2[][], steiner: Vec2[] = []): { pts: Vec2[]; tris: number[] } {
  const pts: Vec2[] = [...outer];
  const holeIdx: number[] = [];
  for (const h of holes) {
    holeIdx.push(pts.length);
    pts.push(...h);
  }
  for (const s of steiner) {
    holeIdx.push(pts.length);
    pts.push(s);
  }
  const flat: number[] = [];
  for (const p of pts) flat.push(p[0], p[1]);
  return { pts, tris: earcut(flat, holeIdx) };
}

export interface PrismFaces {
  top: (i: number) => number;
  bottom: number;
  /** Lado entre os pontos de borda a e b (índices no anel). */
  side: (ring: number, i: number) => number;
}

/**
 * Prisma sob uma superfície de alturas: base plana em yBase, topo em
 * y = heights[i] (um por ponto da triangulação), lados verticais nas bordas.
 * Fechado por construção (a mesma triangulação em cima e embaixo).
 */
export function heightPrism(mb: MeshBuilder, outer: Vec2[], holes: Vec2[][], steiner: Vec2[], height: (p: Vec2, i: number) => number, yBase: number, faces: PrismFaces): void {
  const { pts, tris } = triangulatePlan(outer, holes, steiner);
  const hs = pts.map((p, i) => height(p, i));
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t]!,
      b = tris[t + 1]!,
      c = tris[t + 2]!;
    const pa = pts[a]!,
      pb = pts[b]!,
      pc = pts[c]!;
    mb.triangle([pa[0], hs[a]!, pa[1]], [pb[0], hs[b]!, pb[1]], [pc[0], hs[c]!, pc[1]], faces.top(t / 3), [0, 1, 0]);
    mb.triangle([pa[0], yBase, pa[1]], [pb[0], yBase, pb[1]], [pc[0], yBase, pc[1]], faces.bottom, [0, -1, 0]);
  }
  const rings = [outer, ...holes];
  let off = 0;
  rings.forEach((ring, r) => {
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      const a = ring[i]!,
        b = ring[j]!;
      const ha = hs[off + i]!,
        hb = hs[off + j]!;
      const dx = b[0] - a[0],
        dz = b[1] - a[1];
      // Normal para fora do material: à direita do sentido do anel (externo anti-horário, furos horários).
      const want: Vec3 = [dz, 0, -dx];
      mb.quad([a[0], yBase, a[1]], [b[0], yBase, b[1]], [b[0], hb, b[1]], [a[0], ha, a[1]], faces.side(r, i), want);
    }
    off += ring.length;
  });
}

/** Prisma fechado: perfil no plano xy local extrudado de z0 a z1, levado pela matriz (vãos recortados). */
export function prismMesh(mb: MeshBuilder, profile: Vec2[], z0: number, z1: number, m: number[], faceId: number): void {
  const P = (x: number, y: number, z: number): Vec3 => [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
  let area = 0;
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i]!,
      b = profile[(i + 1) % profile.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  const ring = area > 0 ? profile : [...profile].reverse();
  const flat: number[] = [];
  for (const p of ring) flat.push(p[0], p[1]);
  const tri = earcut(flat);
  // Normais no referencial local (a matriz é uma rotação + translação).
  const n = (x: number, y: number, z: number): Vec3 => [m[0]! * x + m[4]! * y + m[8]! * z, m[1]! * x + m[5]! * y + m[9]! * z, m[2]! * x + m[6]! * y + m[10]! * z];
  for (let t = 0; t < tri.length; t += 3) {
    const a = ring[tri[t]!]!,
      b = ring[tri[t + 1]!]!,
      c = ring[tri[t + 2]!]!;
    mb.triangle(P(a[0], a[1], z1), P(b[0], b[1], z1), P(c[0], c[1], z1), faceId, n(0, 0, 1));
    mb.triangle(P(a[0], a[1], z0), P(b[0], b[1], z0), P(c[0], c[1], z0), faceId, n(0, 0, -1));
  }
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!,
      b = ring[(i + 1) % ring.length]!;
    mb.quad(P(a[0], a[1], z0), P(b[0], b[1], z0), P(b[0], b[1], z1), P(a[0], a[1], z1), faceId, n(b[1] - a[1], -(b[0] - a[0]), 0));
  }
}
