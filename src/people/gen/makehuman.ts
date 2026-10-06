import type { HumanBase } from './humanBase';

/**
 * The MakeHuman base mesh (hm08) registered on the generator's base
 * (`scripts/register-makehuman.py`, nonrigid ICP), so MakeHuman's clothes,
 * hair and other proxies - each pinned to hm08 vertices by its `.mhclo`
 * binding (`people/body/proxy.ts`) - can be worn by a generated person: the
 * hm08 vertices follow the body they lie on, then `fitProxy` places the item.
 * Pure: no three.js.
 */

export interface MakeHumanMeta {
  readonly vertexCount: number;
  readonly k: number;
  readonly sections: readonly { readonly name: string; readonly count: number; readonly itemSize: number; readonly byteOffset: number }[];
}

export interface MakeHumanOnBase {
  /** hm08 at the base's rest, metres, x y z per vertex. */
  readonly positions: Float32Array;
  /** Per hm08 vertex: `k` base vertices it follows, and their weights. */
  readonly bindIndex: Uint32Array;
  readonly bindWeight: Float32Array;
  readonly k: number;
}

export function parseMakeHuman(meta: MakeHumanMeta, bin: ArrayBuffer): MakeHumanOnBase {
  const s = (name: string): { byteOffset: number; length: number } => {
    const x = meta.sections.find((q) => q.name === name);
    if (!x) throw new Error(`makehuman pack lacks ${name}`);
    return { byteOffset: x.byteOffset, length: x.count * x.itemSize };
  };
  const p = s('positions'), i = s('bindIndex'), w = s('bindWeight');
  return {
    positions: new Float32Array(bin, p.byteOffset, p.length),
    bindIndex: new Uint32Array(bin, i.byteOffset, i.length),
    bindWeight: new Float32Array(bin, w.byteOffset, w.length),
    k: meta.k,
  };
}

/**
 * hm08 on this body (`shape`, the morphed base), in decimetres - the units
 * the `.mhclo` offsets and `fitProxy` work in: each vertex moves by the
 * weighted displacement of the base vertices it follows.
 */
export function makehumanBody(mh: MakeHumanOnBase, base: HumanBase, shape: Float32Array, out?: Float32Array): Float32Array {
  const n = mh.positions.length / 3;
  const result = out && out.length === n * 3 ? out : new Float32Array(n * 3);
  const rest = base.positions;
  for (let v = 0; v < n; v++) {
    let x = mh.positions[v * 3]!, y = mh.positions[v * 3 + 1]!, z = mh.positions[v * 3 + 2]!;
    for (let j = 0; j < mh.k; j++) {
      const b = mh.bindIndex[v * mh.k + j]! * 3, w = mh.bindWeight[v * mh.k + j]!;
      x += w * (shape[b]! - rest[b]!);
      y += w * (shape[b + 1]! - rest[b + 1]!);
      z += w * (shape[b + 2]! - rest[b + 2]!);
    }
    result[v * 3] = x * 10; result[v * 3 + 1] = y * 10; result[v * 3 + 2] = z * 10;
  }
  return result;
}
