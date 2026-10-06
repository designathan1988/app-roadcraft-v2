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
 * The skin a fitted item covers, by ray as Character Creator's Auto Hide
 * Mesh does: from inside the body (3 cm under the skin) out along the skin's
 * normal to 4 cm over it; where the ray meets one of the item's triangles
 * (Moller-Trumbore) the skin is under the item - 2 when the item is under the
 * skin there (the skin pokes through it), 1 when it lies over it. Marks
 * `hidden` (one flag per body vertex, the larger kept). `reach` and `behind`
 * are kept for the callers' sake: the ray spans `behind` under the skin.
 */
export function coveredBy(positions: Float32Array, index: Uint32Array, body: { readonly shape: Float32Array; readonly normals: Float32Array; readonly skin: Uint32Array }, hidden: Uint8Array, _reach = 0.01, behind = 0.03): void {
  const C = 0.03;
  const cell = (x: number, y: number, z: number): number => ((Math.floor(x / C) + 512) * 1024 + Math.floor(y / C) + 512) * 1024 + Math.floor(z / C) + 512;
  // Triangles by every grid cell their bounds touch.
  const cells = new Map<number, number[]>();
  for (let t = 0; t < index.length; t += 3) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = index[t + k]! * 3;
      x0 = Math.min(x0, positions[v]!); x1 = Math.max(x1, positions[v]!);
      y0 = Math.min(y0, positions[v + 1]!); y1 = Math.max(y1, positions[v + 1]!);
      z0 = Math.min(z0, positions[v + 2]!); z1 = Math.max(z1, positions[v + 2]!);
    }
    for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++) for (let j = Math.floor(y0 / C); j <= Math.floor(y1 / C); j++) for (let k = Math.floor(z0 / C); k <= Math.floor(z1 / C); k++) {
      const key = ((i + 512) * 1024 + j + 512) * 1024 + k + 512;
      let l = cells.get(key);
      if (!l) cells.set(key, l = []);
      l.push(t);
    }
  }
  const S = body.shape, N = body.normals;
  const done = new Uint8Array(S.length / 3);
  const ahead = 0.04, length = behind + ahead;
  const tested = new Set<number>();
  for (const v of body.skin) {
    if (done[v]) continue;
    done[v] = 1;
    const nx = N[v * 3]!, ny = N[v * 3 + 1]!, nz = N[v * 3 + 2]!;
    const ox = S[v * 3]! - nx * behind, oy = S[v * 3 + 1]! - ny * behind, oz = S[v * 3 + 2]! - nz * behind;
    tested.clear();
    let hit = -1;
    // The cells along the segment, a sample every half cell.
    for (let s = 0; s <= length + 1e-9 && hit < 0; s += C / 2) {
      const l = cells.get(cell(ox + nx * s, oy + ny * s, oz + nz * s));
      if (!l) continue;
      for (const t of l) {
        if (tested.has(t)) continue;
        tested.add(t);
        const a = index[t]! * 3, b = index[t + 1]! * 3, c = index[t + 2]! * 3;
        const e1x = positions[b]! - positions[a]!, e1y = positions[b + 1]! - positions[a + 1]!, e1z = positions[b + 2]! - positions[a + 2]!;
        const e2x = positions[c]! - positions[a]!, e2y = positions[c + 1]! - positions[a + 1]!, e2z = positions[c + 2]! - positions[a + 2]!;
        const px = ny * e2z - nz * e2y, py = nz * e2x - nx * e2z, pz = nx * e2y - ny * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const tx = ox - positions[a]!, ty = oy - positions[a + 1]!, tz = oz - positions[a + 2]!;
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const w = (nx * qx + ny * qy + nz * qz) * inv;
        if (w < 0 || u + w > 1) continue;
        const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (d < 0 || d > length) continue;
        hit = d < behind ? 2 : 1;
        if (hit === 2) break;
      }
    }
    if (hit > 0) hidden[v] = Math.max(hidden[v]!, hit);
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

/**
 * A rigid item (a shoe) fitted as a whole, not vertex by vertex: a shoe is
 * stiff and the foot fits it, but pinned point by point it takes every bump
 * of the toes (Daz 3D's answer is rigid groups). `onRest` is the item fitted
 * on MakeHuman's own body (`restBody`, decimetres); each side (x > 0, x < 0)
 * goes to this body (`body`, decimetres) by the one affine map that best
 * carries the body vertices it is pinned to (least squares), so it scales and
 * turns with the foot but keeps its shape. In place, decimetres.
 */
export function fitRigid(onRest: Float32Array, refs: Uint32Array, restBody: Float32Array, body: Float32Array): void {
  for (const side of [1, -1]) {
    // Normal equations for T = A S + t over the pinned vertices of this side.
    const M = new Float64Array(16), R = [new Float64Array(4), new Float64Array(4), new Float64Array(4)];
    const seen = new Set<number>();
    for (const r of refs) {
      if (seen.has(r) || Math.sign(restBody[r * 3]!) !== side) continue;
      seen.add(r);
      const s = [restBody[r * 3]!, restBody[r * 3 + 1]!, restBody[r * 3 + 2]!, 1];
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) M[i * 4 + j]! += s[i]! * s[j]!;
        for (let k = 0; k < 3; k++) R[k]![i]! += s[i]! * body[r * 3 + k]!;
      }
    }
    if (seen.size < 8) continue;
    const rows = R.map((b) => solve4(M, b));
    for (let v = 0; v < onRest.length / 3; v++) {
      const x = onRest[v * 3]!;
      if (Math.sign(x) !== side) continue;
      const y = onRest[v * 3 + 1]!, z = onRest[v * 3 + 2]!;
      for (let k = 0; k < 3; k++) {
        const a = rows[k]!;
        onRest[v * 3 + k] = a[0]! * x + a[1]! * y + a[2]! * z + a[3]!;
      }
    }
  }
}

/** Solves a 4x4 symmetric system by Gaussian elimination with pivoting. */
function solve4(M: Float64Array, b: Float64Array): Float64Array {
  const a = Array.from({ length: 4 }, (_, i) => [M[i * 4]!, M[i * 4 + 1]!, M[i * 4 + 2]!, M[i * 4 + 3]!, b[i]!]);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r;
    [a[c], a[p]] = [a[p]!, a[c]!];
    const d = a[c]![c]! || 1e-12;
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = a[r]![c]! / d;
      for (let k = c; k < 5; k++) a[r]![k]! -= f * a[c]![k]!;
    }
  }
  return Float64Array.from(a.map((row, i) => row[4]! / (row[i]! || 1e-12)));
}
