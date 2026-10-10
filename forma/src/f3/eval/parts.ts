// Peças dos componentes já no referencial do edifício: primitivas instanciadas
// (caixa, cilindro) com matriz 4×4 e malhas livres (perfis). Sem three.
import earcut from 'earcut';
import type { ID, Vec3 } from '../model/schema';
import type { PartMat, PartSink } from '../families/family';

/** Matriz 4×4 em colunas (mesma ordem do three.js Matrix4.elements). */
export type M4 = number[];

export interface PartTag {
  family: string;
  item?: ID;
  rule?: ID;
  /** Posição na regra de fachada ("lado:nível:índice") ou no arranjo. */
  key?: string;
  solid?: ID;
}

export interface InstPart {
  shape: 'box' | 'cyl6' | 'cyl12' | 'cyl20';
  mat: PartMat;
  m: M4;
  tag: number;
}

export interface MeshPart3 {
  mat: PartMat;
  positions: number[];
  tag: number;
}

export interface Parts3 {
  inst: InstPart[];
  meshes: MeshPart3[];
  tags: PartTag[];
}

export const emptyParts3 = (): Parts3 => ({ inst: [], meshes: [], tags: [] });

export const identity = (): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul(a: M4, b: M4): M4 {
  const o = new Array<number>(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      o[c * 4 + r] = s;
    }
  return o;
}

/** Base (u, v, n) com origem p: leva o referencial local da peça para o edifício. */
export function frameMatrix(p: Vec3, u: Vec3, v: Vec3, n: Vec3): M4 {
  return [u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, n[0], n[1], n[2], 0, p[0], p[1], p[2], 1];
}

export function translation(x: number, y: number, z: number): M4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

export function scaling(x: number, y: number, z: number): M4 {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

const rad = (d: number) => (d * Math.PI) / 180;

/** Rotação em graus: y, depois x, depois z (aplicada ao objeto nessa ordem). */
export function rotationYXZ(r: Vec3): M4 {
  const [ry, rx, rz] = [rad(r[0]), rad(r[1]), rad(r[2])];
  const Y: M4 = [Math.cos(ry), 0, -Math.sin(ry), 0, 0, 1, 0, 0, Math.sin(ry), 0, Math.cos(ry), 0, 0, 0, 0, 1];
  const X: M4 = [1, 0, 0, 0, 0, Math.cos(rx), Math.sin(rx), 0, 0, -Math.sin(rx), Math.cos(rx), 0, 0, 0, 0, 1];
  const Z: M4 = [Math.cos(rz), Math.sin(rz), 0, 0, -Math.sin(rz), Math.cos(rz), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return mul(Y, mul(X, Z));
}

export function apply(m: M4, p: Vec3): Vec3 {
  return [m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!, m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!, m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!];
}

/** Sumidouro de peças que transforma tudo pela matriz do referencial. */
export class FrameSink implements PartSink {
  constructor(
    private out: Parts3,
    private frame: M4,
    private tag: number,
  ) {}

  box(m: PartMat, c: Vec3, s: Vec3, rot?: Vec3): void {
    if (s[0] <= 1e-4 || s[1] <= 1e-4 || s[2] <= 1e-4) return;
    let local = translation(c[0], c[1], c[2]);
    if (rot && (rot[0] || rot[1] || rot[2])) local = mul(local, rotationYXZ(rot));
    this.out.inst.push({ shape: 'box', mat: m, m: mul(this.frame, mul(local, scaling(s[0], s[1], s[2]))), tag: this.tag });
  }

  cylinder(m: PartMat, base: Vec3, r: number, h: number, sides = 12): void {
    if (r <= 1e-4 || h <= 1e-4) return;
    const shape = sides <= 6 ? 'cyl6' : sides <= 12 ? 'cyl12' : 'cyl20';
    this.out.inst.push({ shape, mat: m, m: mul(this.frame, mul(translation(base[0], base[1] + h / 2, base[2]), scaling(r * 2, h, r * 2))), tag: this.tag });
  }

  rod(m: PartMat, a: Vec3, b: Vec3, r: number, sides = 6): void {
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L = Math.hypot(d[0], d[1], d[2]);
    if (L < 1e-4 || r <= 1e-4) return;
    const y: Vec3 = [d[0] / L, d[1] / L, d[2] / L];
    const ref: Vec3 = Math.abs(y[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let x: Vec3 = [y[1] * ref[2] - y[2] * ref[1], y[2] * ref[0] - y[0] * ref[2], y[0] * ref[1] - y[1] * ref[0]];
    const xl = Math.hypot(x[0], x[1], x[2]) || 1;
    x = [x[0] / xl, x[1] / xl, x[2] / xl];
    const z: Vec3 = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const local = mul(frameMatrix(mid, x, y, z), scaling(r * 2, L, r * 2));
    const shape = sides <= 6 ? 'cyl6' : sides <= 12 ? 'cyl12' : 'cyl20';
    this.out.inst.push({ shape, mat: m, m: mul(this.frame, local), tag: this.tag });
  }

  prism(m: PartMat, profile: [number, number][], z0: number, z1: number, holes: [number, number][][] = []): void {
    if (profile.length < 3 || Math.abs(z1 - z0) < 1e-5) return;
    if (z1 < z0) [z0, z1] = [z1, z0];
    const pos: number[] = [];
    const P = (x: number, y: number, z: number) => apply(this.frame, [x, y, z]);
    const push = (...ps: Vec3[]) => {
      for (const q of ps) pos.push(q[0], q[1], q[2]);
    };
    // Anel externo anti-horário e furos horários (normais para fora do material).
    const outer = area2(profile) > 0 ? profile : [...profile].reverse();
    const hs = holes.filter((h) => h.length >= 3).map((h) => (area2(h) < 0 ? h : [...h].reverse()));
    const all = [outer, ...hs];
    const flat: number[] = [];
    const holeIdx: number[] = [];
    for (const r of all) {
      if (r !== outer) holeIdx.push(flat.length / 2);
      for (const q of r) flat.push(q[0], q[1]);
    }
    const pts = all.flat();
    const tri = earcut(flat, holeIdx);
    for (let t = 0; t < tri.length; t += 3) {
      let [a, b, c] = [pts[tri[t]!]!, pts[tri[t + 1]!]!, pts[tri[t + 2]!]!];
      if (area2([a, b, c]) < 0) [b, c] = [c, b];
      push(P(a[0], a[1], z1), P(b[0], b[1], z1), P(c[0], c[1], z1));
      push(P(a[0], a[1], z0), P(c[0], c[1], z0), P(b[0], b[1], z0));
    }
    for (const r of all)
      for (let i = 0; i < r.length; i++) {
        const a = r[i]!,
          b = r[(i + 1) % r.length]!;
        push(P(a[0], a[1], z0), P(b[0], b[1], z0), P(b[0], b[1], z1));
        push(P(a[0], a[1], z0), P(b[0], b[1], z1), P(a[0], a[1], z1));
      }
    this.out.meshes.push({ mat: m, positions: pos, tag: this.tag });
  }

  slab(m: PartMat, plan: [number, number][], y0: number, y1: number, holes: [number, number][][] = []): void {
    // Rotação (det = 1): x do prisma → x, y do prisma → −z, z do prisma → y.
    const rot = mul(this.frame, [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
    new FrameSink(this.out, rot, this.tag).prism(m, plan.map(([x, z]) => [x, -z] as [number, number]), y0, y1, holes.map((h) => h.map(([x, z]) => [x, -z] as [number, number])));
  }

  translated(x: number, y: number, z: number): FrameSink {
    return new FrameSink(this.out, mul(this.frame, translation(x, y, z)), this.tag);
  }

  placed(x: number, y: number, z: number, rotY: number): FrameSink {
    return new FrameSink(this.out, mul(this.frame, mul(translation(x, y, z), rotationYXZ([rotY, 0, 0]))), this.tag);
  }

  sweepX(m: PartMat, profile: [number, number][], x0: number, x1: number): void {
    if (profile.length < 3 || x1 - x0 < 1e-5) return;
    // Perfil (y, z) → prisma ao longo de x: troca de eixos com um referencial próprio.
    // Rotação (det = 1): x do prisma → −z, y → y, z do prisma → x.
    const rot = mul(this.frame, [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
    const inner = new FrameSink(this.out, rot, this.tag);
    inner.prism(m, profile.map(([y, z]) => [-z, y] as [number, number]), x0, x1);
  }
}

function area2(p: [number, number][]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!,
      b = p[(i + 1) % p.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
}
