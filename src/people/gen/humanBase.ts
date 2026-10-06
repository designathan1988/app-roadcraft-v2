/**
 * A human base model for the generator: one mesh plus additive morphs
 * (`scripts/build-human-base.py` writes the pack, `public/models/humans/<base>`).
 *
 * A body is the base positions plus the sum of each morph's delta times its
 * weight; that is how both bases are built (CharMorph's L2 sliders and the
 * MHR's identity blendshapes are plain linear deltas). Positions live on the
 * mesh's own vertices; the render mesh splits a vertex wherever its UV is cut,
 * so normals are summed on the mesh vertices and copied to the render ones and
 * a UV seam never shows as a crease.
 *
 * Pure: no three.js. Units metres, +Y up, the body faces +Z.
 */

export interface HumanSection {
  readonly name: string;
  readonly type: string;
  readonly itemSize: number;
  readonly count: number;
  readonly byteOffset: number;
}

export interface HumanMorph {
  readonly name: string;
  /** The region it belongs to (`Nose`, `BodyType`, `Body`, `Expression`...). */
  readonly group: string;
  readonly min: number;
  readonly max: number;
  readonly start: number;
  readonly count: number;
  readonly scale: number;
}

/** A run of triangles drawn with one material and one UDIM tile. */
export interface HumanGroup {
  readonly start: number;
  readonly count: number;
  readonly material: string;
  readonly tile: number;
}

export interface HumanBaseMeta {
  readonly base: string;
  readonly vertexCount: number;
  readonly renderVertexCount: number;
  readonly groups: readonly HumanGroup[];
  readonly morphs: readonly HumanMorph[];
  /** Texture map name -> the UDIM tiles it has (`<map>.<tile>.jpg`). */
  readonly textures: Readonly<Record<string, readonly number[]>>;
  readonly sections: readonly HumanSection[];
}

/** Morph name -> weight. Morphs left out weigh nothing. */
export type MorphWeights = Readonly<Record<string, number>>;

export class HumanBase {
  readonly vertexCount: number;
  readonly renderVertexCount: number;
  /** Base positions, one xyz per mesh vertex. */
  readonly positions: Float32Array;
  /** The mesh vertex each render vertex copies. */
  readonly renderSource: Uint32Array;
  readonly renderUv: Float32Array;
  /** Triangles over render vertices. */
  readonly index: Uint32Array;
  /** Per mesh vertex, 0..255: how much the eye's shell is clear cornea there (Vitruvian only). */
  readonly cornea: Uint8Array | null;
  readonly morphs = new Map<string, HumanMorph>();
  private readonly morphIndex: Uint32Array;
  private readonly morphDelta: Int16Array;

  constructor(readonly meta: HumanBaseMeta, bin: ArrayBuffer) {
    const section = (name: string): HumanSection => {
      const s = meta.sections.find((x) => x.name === name);
      if (!s) throw new Error(`human pack has no ${name}`);
      return s;
    };
    const f32 = (name: string): Float32Array => { const s = section(name); return new Float32Array(bin, s.byteOffset, s.count * s.itemSize); };
    const u32 = (name: string): Uint32Array => { const s = section(name); return new Uint32Array(bin, s.byteOffset, s.count * s.itemSize); };
    this.vertexCount = meta.vertexCount;
    this.renderVertexCount = meta.renderVertexCount;
    this.positions = f32('positions');
    this.renderSource = u32('renderSource');
    this.renderUv = f32('renderUv');
    this.index = u32('index');
    const c = meta.sections.find((x) => x.name === 'corneaMask');
    this.cornea = c ? new Uint8Array(bin, c.byteOffset, c.count) : null;
    this.morphIndex = u32('morphIndex');
    const d = section('morphDelta');
    this.morphDelta = new Int16Array(bin, d.byteOffset, d.count * 3);
    for (const m of meta.morphs) this.morphs.set(m.name, m);
  }

  /** The body for these weights, one xyz per mesh vertex. `out` is reused when given. */
  shape(weights: MorphWeights, out?: Float32Array): Float32Array {
    const result = out && out.length === this.positions.length ? out : new Float32Array(this.positions.length);
    result.set(this.positions);
    for (const [name, value] of Object.entries(weights)) {
      const m = this.morphs.get(name);
      if (!m || value === 0) continue;
      const w = Math.min(m.max, Math.max(m.min, value)) * m.scale;
      const idx = this.morphIndex, delta = this.morphDelta;
      for (let e = m.start, end = m.start + m.count; e < end; e++) {
        const v = idx[e]! * 3, q = e * 3;
        result[v] = result[v]! + w * delta[q]!;
        result[v + 1] = result[v + 1]! + w * delta[q + 1]!;
        result[v + 2] = result[v + 2]! + w * delta[q + 2]!;
      }
    }
    return result;
  }

  /** One morph's full delta at weight 1, one xyz per mesh vertex (zeros where it does not move). */
  denseDelta(name: string): Float32Array {
    const out = new Float32Array(this.positions.length);
    const m = this.morphs.get(name);
    if (!m) return out;
    for (let e = m.start, end = m.start + m.count; e < end; e++) {
      const v = this.morphIndex[e]! * 3, q = e * 3;
      out[v] = this.morphDelta[q]! * m.scale;
      out[v + 1] = this.morphDelta[q + 1]! * m.scale;
      out[v + 2] = this.morphDelta[q + 2]! * m.scale;
    }
    return out;
  }

  /** Mesh-vertex positions copied out to the render vertices. */
  renderPositions(shape: Float32Array, out?: Float32Array): Float32Array {
    const n = this.renderVertexCount;
    const result = out && out.length === n * 3 ? out : new Float32Array(n * 3);
    for (let r = 0; r < n; r++) {
      const s = this.renderSource[r]! * 3;
      result[r * 3] = shape[s]!;
      result[r * 3 + 1] = shape[s + 1]!;
      result[r * 3 + 2] = shape[s + 2]!;
    }
    return result;
  }

  /**
   * Smooth normals for the render vertices: area-weighted face normals summed
   * on the mesh vertices (so both sides of a UV seam agree), then copied out.
   */
  renderNormals(shape: Float32Array, out?: Float32Array): Float32Array {
    const acc = new Float32Array(this.vertexCount * 3);
    const src = this.renderSource, idx = this.index;
    for (let t = 0; t < idx.length; t += 3) {
      const a = src[idx[t]!]! * 3, b = src[idx[t + 1]!]! * 3, c = src[idx[t + 2]!]! * 3;
      const ux = shape[b]! - shape[a]!, uy = shape[b + 1]! - shape[a + 1]!, uz = shape[b + 2]! - shape[a + 2]!;
      const vx = shape[c]! - shape[a]!, vy = shape[c + 1]! - shape[a + 1]!, vz = shape[c + 2]! - shape[a + 2]!;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const v of [a, b, c]) { acc[v] = acc[v]! + nx; acc[v + 1] = acc[v + 1]! + ny; acc[v + 2] = acc[v + 2]! + nz; }
    }
    for (let v = 0; v < acc.length; v += 3) {
      const l = Math.hypot(acc[v]!, acc[v + 1]!, acc[v + 2]!);
      if (l > 1e-20) { acc[v] = acc[v]! / l; acc[v + 1] = acc[v + 1]! / l; acc[v + 2] = acc[v + 2]! / l; }
      else { acc[v] = acc[v + 1] = acc[v + 2] = 0; }
    }
    // A vertex whose triangles have no area (Vitruvian's fingernails lie flat
    // on the fingertips until a nail morph lifts them) takes its neighbours'.
    for (let pass = 0; pass < 3; pass++) {
      const borrowed = new Float32Array(acc.length);
      let missing = false;
      for (let t = 0; t < idx.length; t += 3) {
        const tri = [src[idx[t]!]! * 3, src[idx[t + 1]!]! * 3, src[idx[t + 2]!]! * 3];
        for (const v of tri) {
          if (acc[v] !== 0 || acc[v + 1] !== 0 || acc[v + 2] !== 0) continue;
          missing = true;
          for (const u of tri) { borrowed[v] = borrowed[v]! + acc[u]!; borrowed[v + 1] = borrowed[v + 1]! + acc[u + 1]!; borrowed[v + 2] = borrowed[v + 2]! + acc[u + 2]!; }
        }
      }
      if (!missing) break;
      for (let v = 0; v < acc.length; v += 3) {
        const l = Math.hypot(borrowed[v]!, borrowed[v + 1]!, borrowed[v + 2]!);
        if (l > 1e-20) { acc[v] = borrowed[v]! / l; acc[v + 1] = borrowed[v + 1]! / l; acc[v + 2] = borrowed[v + 2]! / l; }
      }
    }
    const n = this.renderVertexCount;
    const result = out && out.length === n * 3 ? out : new Float32Array(n * 3);
    for (let r = 0; r < n; r++) {
      const s = src[r]! * 3;
      result[r * 3] = acc[s]!; result[r * 3 + 1] = acc[s + 1]!; result[r * 3 + 2] = acc[s + 2]!;
    }
    return result;
  }
}

/** Lowest and highest Y of a shape: its standing height is the difference. */
export function verticalExtent(shape: Float32Array): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < shape.length; i += 3) {
    const y = shape[i]!;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  return [lo, hi];
}
