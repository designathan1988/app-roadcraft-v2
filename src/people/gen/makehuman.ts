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

/**
 * Keeps a fitted item out of the body: each vertex lying on the skin (within
 * 3 cm of it) nearer than `gap` along the skin's normal is pushed out to it,
 * and the push is spread over the item's neighbouring vertices, so the cloth
 * moves as a piece (pushed one by one, a hem hanging between hip and thigh
 * went to spikes). An item made for MakeHuman's body is pinned to the same
 * places on ours, but where ours is fuller (a bust, a belly) the skin would
 * show through it.
 */
export function pushOut(positions: Float32Array, index: Uint32Array, body: { readonly shape: Float32Array; readonly normals: Float32Array; readonly skin: Uint32Array }, gap = 0.002): void {
  const C = 0.03;
  const key = (x: number, y: number, z: number): number => ((Math.floor(x / C) + 512) * 1024 + Math.floor(y / C) + 512) * 1024 + Math.floor(z / C) + 512;
  const cells = new Map<number, number[]>();
  const seen = new Uint8Array(body.shape.length / 3);
  for (const v of body.skin) {
    if (seen[v]) continue;
    seen[v] = 1;
    const k = key(body.shape[v * 3]!, body.shape[v * 3 + 1]!, body.shape[v * 3 + 2]!);
    let l = cells.get(k);
    if (!l) cells.set(k, l = []);
    l.push(v);
  }
  const S = body.shape, N = body.normals;
  const n = positions.length / 3;
  let push = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3]!, y = positions[i * 3 + 1]!, z = positions[i * 3 + 2]!;
    let best = -1, bd = 0.03 * 0.03;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const l = cells.get(key(x + dx * C, y + dy * C, z + dz * C));
      if (!l) continue;
      for (const v of l) {
        const d = (S[v * 3]! - x) ** 2 + (S[v * 3 + 1]! - y) ** 2 + (S[v * 3 + 2]! - z) ** 2;
        if (d < bd) { bd = d; best = v; }
      }
    }
    if (best < 0) continue;
    const along = (x - S[best * 3]!) * N[best * 3]! + (y - S[best * 3 + 1]!) * N[best * 3 + 1]! + (z - S[best * 3 + 2]!) * N[best * 3 + 2]!;
    if (along >= gap) continue;
    for (let k = 0; k < 3; k++) push[i * 3 + k] = N[best * 3 + k]! * (gap - along);
  }
  // Spread: each vertex takes the larger of its own push and its neighbours' mean, a few times.
  const nb: number[][] = Array.from({ length: n }, () => []);
  for (let t = 0; t < index.length; t += 3) {
    for (let k = 0; k < 3; k++) { const a = index[t + k]!, c = index[t + (k + 1) % 3]!; nb[a]!.push(c); nb[c]!.push(a); }
  }
  for (let pass = 0; pass < 4; pass++) {
    const next = push.slice();
    for (let i = 0; i < n; i++) {
      const l = nb[i]!;
      if (!l.length) continue;
      let mx = 0, my = 0, mz = 0;
      for (const j of l) { mx += push[j * 3]!; my += push[j * 3 + 1]!; mz += push[j * 3 + 2]!; }
      mx /= l.length; my /= l.length; mz /= l.length;
      const own = Math.hypot(push[i * 3]!, push[i * 3 + 1]!, push[i * 3 + 2]!), mean = Math.hypot(mx, my, mz);
      if (mean > own) { next[i * 3] = mx; next[i * 3 + 1] = my; next[i * 3 + 2] = mz; }
    }
    push = next;
  }
  for (let i = 0; i < n * 3; i++) positions[i] = positions[i]! + push[i]!;
}

/**
 * The skin a fitted item covers (MakeHuman's delete_verts, worked out on our
 * body, since an item's own list is for MakeHuman's): a skin vertex is under
 * the item when an item vertex lies over it - outside it along its normal,
 * within `reach` of its normal line - and that item vertex is not on
 * the item's open edge (so skin at a hem or a cuff stays drawn up to it).
 * Marks `hidden` (one flag per body vertex).
 */
export function coveredBy(positions: Float32Array, index: Uint32Array, body: { readonly shape: Float32Array; readonly normals: Float32Array; readonly skin: Uint32Array }, hidden: Uint8Array, reach = 0.01, behind = 0.003): void {
  // The item's open edge: sides used by one triangle.
  const sides = new Map<number, number>();
  for (let t = 0; t < index.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = index[t + k]!, c = index[t + (k + 1) % 3]!;
      const key = Math.min(a, c) * 4194304 + Math.max(a, c);
      sides.set(key, (sides.get(key) ?? 0) + 1);
    }
  }
  const edge = new Uint8Array(positions.length / 3);
  for (const [key, n] of sides) if (n === 1) { edge[Math.floor(key / 4194304)] = 1; edge[key % 4194304] = 1; }
  const C = 0.02;
  const cell = (x: number, y: number, z: number): number => ((Math.floor(x / C) + 512) * 1024 + Math.floor(y / C) + 512) * 1024 + Math.floor(z / C) + 512;
  const cells = new Map<number, number[]>();
  for (let v = 0; v < edge.length; v++) {
    if (edge[v]) continue;
    const k = cell(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!);
    let l = cells.get(k);
    if (!l) cells.set(k, l = []);
    l.push(v);
  }
  const S = body.shape, N = body.normals;
  const done = new Uint8Array(S.length / 3);
  for (const v of body.skin) {
    if (done[v]) continue;
    done[v] = 1;
    const x = S[v * 3]!, y = S[v * 3 + 1]!, z = S[v * 3 + 2]!, nx = N[v * 3]!, ny = N[v * 3 + 1]!, nz = N[v * 3 + 2]!;
    search: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const l = cells.get(cell(x + dx * C, y + dy * C, z + dz * C));
      if (!l) continue;
      for (const g of l) {
        const gx = positions[g * 3]! - x, gy = positions[g * 3 + 1]! - y, gz = positions[g * 3 + 2]! - z;
        const along = gx * nx + gy * ny + gz * nz;
        if (along < -behind || along > 0.04) continue;
        const across = Math.hypot(gx - nx * along, gy - ny * along, gz - nz * along);
        if (across < reach) { hidden[v] = 1; break search; }
      }
    }
  }
}

/**
 * A fitted item as a surface other items are kept off (`pushOut`): its
 * vertices and their normals, each turned to face away from the body (the
 * way the skin's nearest normal faces), whichever way the item was wound.
 */
export function surfaceOf(positions: Float32Array, index: Uint32Array, body: { readonly shape: Float32Array; readonly normals: Float32Array; readonly skin: Uint32Array }): { shape: Float32Array; normals: Float32Array; skin: Uint32Array } {
  const n = positions.length / 3;
  const normals = new Float32Array(n * 3);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t]! * 3, b = index[t + 1]! * 3, c = index[t + 2]! * 3;
    const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!, vy = positions[c + 1]! - positions[a + 1]!, vz = positions[c + 2]! - positions[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) { normals[v] = normals[v]! + nx; normals[v + 1] = normals[v + 1]! + ny; normals[v + 2] = normals[v + 2]! + nz; }
  }
  const C = 0.04;
  const key = (x: number, y: number, z: number): number => ((Math.floor(x / C) + 512) * 1024 + Math.floor(y / C) + 512) * 1024 + Math.floor(z / C) + 512;
  const cells = new Map<number, number[]>();
  const S = body.shape, N = body.normals;
  const seen = new Uint8Array(S.length / 3);
  for (const v of body.skin) {
    if (seen[v]) continue;
    seen[v] = 1;
    const k = key(S[v * 3]!, S[v * 3 + 1]!, S[v * 3 + 2]!);
    let l = cells.get(k);
    if (!l) cells.set(k, l = []);
    l.push(v);
  }
  for (let v = 0; v < n; v++) {
    const l = Math.hypot(normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!) || 1;
    let nx = normals[v * 3]! / l, ny = normals[v * 3 + 1]! / l, nz = normals[v * 3 + 2]! / l;
    const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
    let best = -1, bd = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = cells.get(key(x + dx * C, y + dy * C, z + dz * C));
      if (!list) continue;
      for (const u of list) {
        const d = (S[u * 3]! - x) ** 2 + (S[u * 3 + 1]! - y) ** 2 + (S[u * 3 + 2]! - z) ** 2;
        if (d < bd) { bd = d; best = u; }
      }
    }
    if (best >= 0 && nx * N[best * 3]! + ny * N[best * 3 + 1]! + nz * N[best * 3 + 2]! < 0) { nx = -nx; ny = -ny; nz = -nz; }
    normals[v * 3] = nx; normals[v * 3 + 1] = ny; normals[v * 3 + 2] = nz;
  }
  return { shape: positions, normals, skin: new Uint32Array(n).map((_, i) => i) };
}

/**
 * Tucks an inner item under an outer one (as layered cloth is kept apart):
 * each inner vertex with an outer vertex over it (within `reach` of its normal
 * line) less than `gap` inside the outer is pulled in along its own outward
 * normal to `gap` under it. `self` is the inner item as a surface (outward
 * normals, `surfaceOf`); `outer` the outer item's fitted vertices.
 */
export function tuckUnder(self: { readonly shape: Float32Array; readonly normals: Float32Array }, outer: Float32Array, gap = 0.003, reach = 0.025): void {
  const C = 0.03;
  const key = (x: number, y: number, z: number): number => ((Math.floor(x / C) + 512) * 1024 + Math.floor(y / C) + 512) * 1024 + Math.floor(z / C) + 512;
  const cells = new Map<number, number[]>();
  for (let v = 0; v < outer.length / 3; v++) {
    const k = key(outer[v * 3]!, outer[v * 3 + 1]!, outer[v * 3 + 2]!);
    let l = cells.get(k);
    if (!l) cells.set(k, l = []);
    l.push(v);
  }
  const P = self.shape, N = self.normals;
  for (let v = 0; v < P.length / 3; v++) {
    const x = P[v * 3]!, y = P[v * 3 + 1]!, z = P[v * 3 + 2]!, nx = N[v * 3]!, ny = N[v * 3 + 1]!, nz = N[v * 3 + 2]!;
    let need = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const l = cells.get(key(x + dx * C, y + dy * C, z + dz * C));
      if (!l) continue;
      for (const g of l) {
        const gx = outer[g * 3]! - x, gy = outer[g * 3 + 1]! - y, gz = outer[g * 3 + 2]! - z;
        const along = gx * nx + gy * ny + gz * nz;
        if (along > 0.03 || along < -0.04) continue;
        if (Math.hypot(gx - nx * along, gy - ny * along, gz - nz * along) > reach) continue;
        need = Math.max(need, gap - along);
      }
    }
    if (need <= 0) continue;
    P[v * 3] = x - nx * need; P[v * 3 + 1] = y - ny * need; P[v * 3 + 2] = z - nz * need;
  }
}
