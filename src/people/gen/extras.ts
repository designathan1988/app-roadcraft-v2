import type { HumanBase, HumanSection } from './humanBase';

/**
 * What the creator puts on a body (`scripts/build-human-extras.py` writes
 * the pack): masks (scalp, lips), body regions for cutting clothes, eyelid
 * rims for lashes, hair and eyebrow grooms, and the modelled garments bound
 * to the skin. Pure: no three.js.
 */

export const REGION = {
  head: 0, neck: 1, chest: 2, abdomen: 3, pelvis: 4, upperarm: 5, forearm: 6, hand: 7, thigh: 8, shin: 9, foot: 10, toes: 11,
} as const;

export interface GroomInfo { readonly id: string; readonly children: number; readonly radius: number; readonly clump: number; readonly roughness: number }

export interface ExtrasMeta {
  readonly regions: { readonly names: readonly string[]; readonly landmarks: Readonly<Record<string, number>> };
  readonly lashes: Readonly<Record<'L' | 'R', { readonly upper: readonly number[]; readonly lower: readonly number[] }>>;
  readonly hair: readonly GroomInfo[];
  readonly brows: readonly { readonly id: string; readonly strands: number }[];
  readonly garments: readonly { readonly id: string; readonly vertices: number; readonly bindK: number }[];
  readonly sections: readonly HumanSection[];
}

/** Strands: points (xyz) and how many points each strand has, in order. */
export interface Strands { readonly counts: Uint16Array; readonly points: Float32Array }

export interface BoundGarment {
  readonly id: string;
  readonly positions: Float32Array;
  readonly renderSource: Uint32Array;
  readonly renderUv: Float32Array;
  readonly index: Uint32Array;
  readonly bindIndex: Uint32Array;
  readonly bindWeight: Float32Array;
  readonly k: number;
}

export class HumanExtras {
  readonly scalp: Uint8Array;
  readonly lips: Uint8Array;
  readonly region: Uint8Array;
  /** 0..255 along the vertex's limb (shoulder->elbow, hip->knee...). */
  readonly along: Uint8Array;
  readonly grooms = new Map<string, Strands & GroomInfo>();
  readonly brows = new Map<string, Strands>();
  readonly garments = new Map<string, BoundGarment>();

  constructor(readonly meta: ExtrasMeta, bin: ArrayBuffer) {
    const sec = (name: string): HumanSection => {
      const s = meta.sections.find((x) => x.name === name);
      if (!s) throw new Error(`extras pack has no ${name}`);
      return s;
    };
    const u8 = (n: string): Uint8Array => { const s = sec(n); return new Uint8Array(bin, s.byteOffset, s.count * s.itemSize); };
    const u16 = (n: string): Uint16Array => { const s = sec(n); return new Uint16Array(bin, s.byteOffset, s.count * s.itemSize); };
    const u32 = (n: string): Uint32Array => { const s = sec(n); return new Uint32Array(bin, s.byteOffset, s.count * s.itemSize); };
    const f32 = (n: string): Float32Array => { const s = sec(n); return new Float32Array(bin, s.byteOffset, s.count * s.itemSize); };
    this.scalp = u8('scalpMask');
    this.lips = u8('lipMask');
    this.region = u8('region');
    this.along = u8('along');
    for (const g of meta.hair) this.grooms.set(g.id, { ...g, counts: u16(`hair.${g.id}.cnt`), points: f32(`hair.${g.id}.pts`) });
    for (const b of meta.brows) this.brows.set(b.id, { counts: u16(`brow.${b.id}.cnt`), points: f32(`brow.${b.id}.pts`) });
    for (const g of meta.garments) {
      const p = `garment.${g.id}.`;
      this.garments.set(g.id, {
        id: g.id, positions: f32(p + 'positions'), renderSource: u32(p + 'renderSource'), renderUv: f32(p + 'renderUv'),
        index: u32(p + 'index'), bindIndex: u32(p + 'bindIndex'), bindWeight: f32(p + 'bindWeight'), k: g.bindK,
      });
    }
  }

  /** Rest height of a body landmark (hip, knee, ankle, waist, chest, neckBase, shoulder, crotch). */
  landmark(name: string): number {
    return this.meta.regions.landmarks[name] ?? 0;
  }
}

/**
 * A modelled garment fitted to a morphed body, as CharMorph fits its assets:
 * each vertex moves by the weighted displacement of the body vertices it is
 * bound to. Returns positions per garment vertex.
 */
export function fitGarment(g: BoundGarment, base: HumanBase, shape: Float32Array, out?: Float32Array): Float32Array {
  const n = g.positions.length / 3;
  const result = out && out.length === n * 3 ? out : new Float32Array(n * 3);
  const rest = base.positions;
  for (let v = 0; v < n; v++) {
    let dx = 0, dy = 0, dz = 0;
    for (let j = 0; j < g.k; j++) {
      const b = g.bindIndex[v * g.k + j]! * 3, w = g.bindWeight[v * g.k + j]!;
      dx += w * (shape[b]! - rest[b]!);
      dy += w * (shape[b + 1]! - rest[b + 1]!);
      dz += w * (shape[b + 2]! - rest[b + 2]!);
    }
    result[v * 3] = g.positions[v * 3]! + dx;
    result[v * 3 + 1] = g.positions[v * 3 + 1]! + dy;
    result[v * 3 + 2] = g.positions[v * 3 + 2]! + dz;
  }
  return result;
}

/**
 * Smooth per-vertex normals of a mesh whose render vertices copy source
 * vertices: summed on the sources (a UV seam shows no crease), copied out.
 */
export function smoothNormals(sourceCount: number, positions: Float32Array, renderSource: Uint32Array, index: Uint32Array, out?: Float32Array): Float32Array {
  const acc = new Float32Array(sourceCount * 3);
  for (let t = 0; t < index.length; t += 3) {
    const a = renderSource[index[t]!]! * 3, b = renderSource[index[t + 1]!]! * 3, c = renderSource[index[t + 2]!]! * 3;
    const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!, vy = positions[c + 1]! - positions[a + 1]!, vz = positions[c + 2]! - positions[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) { acc[v] = acc[v]! + nx; acc[v + 1] = acc[v + 1]! + ny; acc[v + 2] = acc[v + 2]! + nz; }
  }
  const n = renderSource.length;
  const result = out && out.length === n * 3 ? out : new Float32Array(n * 3);
  for (let r = 0; r < n; r++) {
    const s = renderSource[r]! * 3;
    const l = Math.hypot(acc[s]!, acc[s + 1]!, acc[s + 2]!) || 1;
    result[r * 3] = acc[s]! / l; result[r * 3 + 1] = acc[s + 1]! / l; result[r * 3 + 2] = acc[s + 2]! / l;
  }
  return result;
}

const BEARDS = new WeakMap<HumanExtras, Uint8Array>();

/**
 * Where a beard grows, per mesh vertex 0..255 (the base's own beard mask is
 * empty): the head's skin round the mouth and jaw and the front of the neck
 * under it, fading at its edges, lips left out.
 */
export function beardMask(ex: HumanExtras, base: HumanBase): Uint8Array {
  const cached = BEARDS.get(ex);
  if (cached) return cached;
  const rest = base.positions;
  let my = 0, mz = 0, n = 0;
  for (let v = 0; v < ex.lips.length; v++) if (ex.lips[v]! > 128) { my += rest[v * 3 + 1]!; mz += rest[v * 3 + 2]!; n++; }
  my /= n || 1; mz /= n || 1;
  const out = new Uint8Array(ex.region.length);
  const smooth = (e0: number, e1: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  for (let v = 0; v < out.length; v++) {
    const r = ex.region[v]!;
    if (r !== REGION.head && r !== REGION.neck) continue;
    const x = Math.abs(rest[v * 3]!), y = rest[v * 3 + 1]! - my, z = rest[v * 3 + 2]! - mz;
    let m: number;
    if (r === REGION.head) {
      // Up to the moustache line, back along the jaw to the ears.
      m = smooth(0.03, 0.012, y) * smooth(-0.1, -0.06, y) * smooth(-0.085, -0.055, z) * smooth(0.085, 0.06, x);
      // The cheeks above the mouth corners are bare.
      if (y > -0.005 && x > 0.032) m *= smooth(0.045, 0.032, x);
    } else {
      m = smooth(-0.13, -0.09, y) * smooth(-0.07, -0.03, z);
    }
    m *= 1 - Math.min(1, ex.lips[v]! / 90);
    out[v] = Math.round(m * 255);
  }
  BEARDS.set(ex, out);
  return out;
}
