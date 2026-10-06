/**
 * Sculpting a hair mesh, with the brushes Blender's Curves Sculpt mode
 * gives hair (comb, snake hook, grow/shrink, delete, puff, smooth), applied
 * to a hair mesh's vertices:
 *
 * - Every vertex knows how far along the hair it is from the scalp (the
 *   distance over the mesh from the vertices lying on the scalp): a brush
 *   moves it by that much - the roots stay where they grow, the tips move
 *   most (Blender's comb: "falloff from the tip to the root").
 * - No vertex goes further from its root than the hair is long, so hair
 *   pulled anywhere stays on the head.
 * - After each step the moved vertices are pushed out of the skin, so hair
 *   never goes into the body.
 *
 * What was done is kept as sparse offsets from the fitted mesh and the
 * triangles cut, so it is saved with the person and rebuilt on any body.
 * Pure: no three.js.
 */

export interface HairSculptState {
  /** The hair mesh it was sculpted on. */
  readonly item: string;
  /** Moved vertices: [vertex, dx, dy, dz] per vertex, offsets in tenths of a millimetre. */
  readonly moved: readonly number[];
  /** Triangles cut away (their first index in the mesh's index / 3). */
  readonly cut: readonly number[];
}

export type HairBrush = 'comb' | 'hook' | 'grow' | 'shrink' | 'cut' | 'puff' | 'smooth' | 'loosen' | 'tighten';

interface Skin { readonly shape: Float32Array; readonly normals: Float32Array; readonly skin: Uint32Array }

const GRID = 0.03;
const key = (x: number, y: number, z: number): number => ((Math.floor(x / GRID) + 512) * 1024 + Math.floor(y / GRID) + 512) * 1024 + Math.floor(z / GRID) + 512;

export class HairSculpt {
  readonly positions: Float32Array;
  private readonly base: Float32Array;
  private readonly fullIndex: Uint32Array;
  private readonly cutTris = new Set<number>();
  /** Distance over the mesh from the scalp, metres. */
  private readonly along: Float32Array;
  /** How far each vertex may be from its root: the hair's length to it. */
  private readonly reach: Float32Array;
  /** The scalp vertex each vertex grows from. */
  private readonly root: Int32Array;
  private readonly ring: number[][];
  private readonly skinCells = new Map<number, number[]>();
  private readonly head: [number, number, number];

  /**
   * `rooted`: hair (roots on the scalp, kept within its length); a garment
   * is not rooted - all of it moves, only kept out of the body.
   */
  constructor(readonly item: string, fitted: Float32Array, index: Uint32Array, private readonly body: Skin, state?: HairSculptState | null, rooted = true) {
    this.base = fitted.slice();
    this.positions = fitted.slice();
    this.fullIndex = index;
    const n = fitted.length / 3;
    this.ring = Array.from({ length: n }, () => []);
    for (let t = 0; t < index.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = index[t + k]!, c = index[t + (k + 1) % 3]!;
        if (!this.ring[a]!.includes(c)) { this.ring[a]!.push(c); this.ring[c]!.push(a); }
      }
    }
    const seen = new Uint8Array(body.shape.length / 3);
    for (const v of body.skin) {
      if (seen[v]) continue;
      seen[v] = 1;
      const k = key(body.shape[v * 3]!, body.shape[v * 3 + 1]!, body.shape[v * 3 + 2]!);
      let l = this.skinCells.get(k);
      if (!l) this.skinCells.set(k, l = []);
      l.push(v);
    }
    // The head's centre: the middle of the hair's own bounds, high.
    let cx = 0, cy = -Infinity, cz = 0;
    for (let v = 0; v < n; v++) { cx += fitted[v * 3]!; cz += fitted[v * 3 + 2]!; cy = Math.max(cy, fitted[v * 3 + 1]!); }
    this.head = [cx / n, cy - 0.1, cz / n];
    // Roots: vertices on the scalp (within 8 mm of the skin, above the hair's lowest third near the head).
    this.along = new Float32Array(n).fill(Infinity);
    this.root = new Int32Array(n).fill(-1);
    const queue: number[] = [];
    for (let v = 0; v < n && rooted; v++) {
      const d = this.skinDistance(fitted[v * 3]!, fitted[v * 3 + 1]!, fitted[v * 3 + 2]!);
      if (d < 0.008 && fitted[v * 3 + 1]! > this.head[1] - 0.06) { this.along[v] = 0; this.root[v] = v; queue.push(v); }
    }
    if (!rooted) { this.along.fill(1); for (let v = 0; v < n; v++) this.root[v] = v; }
    // Dijkstra over the mesh's edges, with a binary heap.
    const dist = this.along;
    const heap = new MinHeap();
    for (const v of queue) heap.push(0, v);
    while (heap.size) {
      const [d, v] = heap.pop();
      if (d > dist[v]!) continue;
      for (const u of this.ring[v]!) {
        const e = Math.hypot(fitted[u * 3]! - fitted[v * 3]!, fitted[u * 3 + 1]! - fitted[v * 3 + 1]!, fitted[u * 3 + 2]! - fitted[v * 3 + 2]!);
        if (d + e < dist[u]!) { dist[u] = d + e; this.root[u] = this.root[v]!; heap.push(d + e, u); }
      }
    }
    // Parts of the mesh not connected to the scalp: rooted at the nearest skin, measured straight.
    for (let v = 0; v < n; v++) {
      if (Number.isFinite(dist[v]!)) continue;
      dist[v] = this.skinDistance(fitted[v * 3]!, fitted[v * 3 + 1]!, fitted[v * 3 + 2]!);
      this.root[v] = v;
    }
    this.reach = Float32Array.from(dist, (d) => (rooted ? d * 1.05 + 0.002 : Infinity));
    if (state && state.item === item) {
      for (let i = 0; i + 3 < state.moved.length; i += 4) {
        const v = state.moved[i]!;
        if (v >= n) continue;
        for (let c = 0; c < 3; c++) this.positions[v * 3 + c] = this.base[v * 3 + c]! + state.moved[i + 1 + c]! / 10000;
      }
      for (const t of state.cut) this.cutTris.add(t);
    }
  }

  /** The mesh's triangles without the ones cut away. */
  index(): Uint32Array {
    if (!this.cutTris.size) return this.fullIndex;
    const out: number[] = [];
    for (let t = 0; t < this.fullIndex.length / 3; t++) if (!this.cutTris.has(t)) out.push(this.fullIndex[t * 3]!, this.fullIndex[t * 3 + 1]!, this.fullIndex[t * 3 + 2]!);
    return Uint32Array.from(out);
  }

  /** What was done, to save with the person. */
  state(): HairSculptState {
    const moved: number[] = [];
    for (let v = 0; v < this.positions.length / 3; v++) {
      const dx = Math.round((this.positions[v * 3]! - this.base[v * 3]!) * 10000);
      const dy = Math.round((this.positions[v * 3 + 1]! - this.base[v * 3 + 1]!) * 10000);
      const dz = Math.round((this.positions[v * 3 + 2]! - this.base[v * 3 + 2]!) * 10000);
      if (dx || dy || dz) moved.push(v, dx, dy, dz);
    }
    return { item: this.item, moved, cut: [...this.cutTris].sort((a, b) => a - b) };
  }

  /**
   * One step of a brush at `centre` (body frame, metres) with `radius`;
   * `drag` is how far the pointer moved (body frame) for comb and hook;
   * `strength` 0..1.
   */
  stroke(brush: HairBrush, centre: readonly number[], radius: number, strength: number, drag: readonly number[] = [0, 0, 0]): void {
    const P = this.positions, n = P.length / 3;
    const touched: number[] = [], fall: number[] = [];
    for (let v = 0; v < n; v++) {
      const d = Math.hypot(P[v * 3]! - centre[0]!, P[v * 3 + 1]! - centre[1]!, P[v * 3 + 2]! - centre[2]!);
      if (d >= radius) continue;
      const f = 1 - (d / radius) ** 2;
      touched.push(v); fall.push(f * f);
    }
    if (!touched.length) return;
    // From the root (0) to well along the hair (1): roots never move.
    const tip = (v: number): number => { const t = Math.min(1, Math.max(0, (this.along[v]! - 0.004) / 0.06)); return t * t * (3 - 2 * t); };
    if (brush === 'cut') {
      const hit = new Set(touched.filter((v) => tip(v) > 0.15));
      for (let t = 0; t < this.fullIndex.length / 3; t++) {
        if (hit.has(this.fullIndex[t * 3]!) || hit.has(this.fullIndex[t * 3 + 1]!) || hit.has(this.fullIndex[t * 3 + 2]!)) this.cutTris.add(t);
      }
      return;
    }
    if (brush === 'smooth') {
      const next = touched.map((v) => {
        const l = this.ring[v]!;
        const m = [0, 0, 0];
        for (const u of l) for (let c = 0; c < 3; c++) m[c]! += P[u * 3 + c]!;
        return m.map((x) => x / Math.max(1, l.length));
      });
      touched.forEach((v, i) => { const s = strength * fall[i]! * tip(v); for (let c = 0; c < 3; c++) P[v * 3 + c] = P[v * 3 + c]! + (next[i]![c]! - P[v * 3 + c]!) * s; });
    } else {
      touched.forEach((v, i) => {
        const w = fall[i]! * tip(v);
        const r = this.root[v]!;
        if (brush === 'comb' || brush === 'hook') {
          // Snake hook pulls the tips most and lets the hair grow to follow.
          const k = brush === 'hook' ? Math.min(1, this.along[v]! / 0.15) : 1;
          for (let c = 0; c < 3; c++) P[v * 3 + c] = P[v * 3 + c]! + drag[c]! * w * strength * k;
          if (brush === 'hook') this.reach[v] = Math.max(this.reach[v]!, this.distance(v, r));
        } else if (brush === 'grow' || brush === 'shrink') {
          const s = 1 + (brush === 'grow' ? 1 : -1) * 0.15 * strength * w;
          for (let c = 0; c < 3; c++) P[v * 3 + c] = P[r * 3 + c]! + (P[v * 3 + c]! - P[r * 3 + c]!) * s;
          this.reach[v] = this.reach[v]! * s;
        } else if (brush === 'loosen' || brush === 'tighten') {
          // A garment eased off the body or drawn in to it, along the skin's normal there.
          const s = this.nearestSkin(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!);
          if (s >= 0) for (let c = 0; c < 3; c++) P[v * 3 + c] = P[v * 3 + c]! + this.body.normals[s * 3 + c]! * 0.006 * strength * w * (brush === 'loosen' ? 1 : -1);
        } else if (brush === 'puff') {
          const o = [P[v * 3]! - this.head[0], P[v * 3 + 1]! - this.head[1], P[v * 3 + 2]! - this.head[2]];
          const l = Math.hypot(o[0]!, o[1]!, o[2]!) || 1;
          for (let c = 0; c < 3; c++) P[v * 3 + c] = P[v * 3 + c]! + (o[c]! / l) * 0.015 * strength * w;
        }
      });
    }
    // Kept on the head: never further from the root than the hair is long.
    for (const v of touched) {
      const r = this.root[v]!;
      const d = this.distance(v, r), max = this.reach[v]!;
      if (d <= max || d < 1e-6) continue;
      const k = max / d;
      for (let c = 0; c < 3; c++) P[v * 3 + c] = P[r * 3 + c]! + (P[v * 3 + c]! - P[r * 3 + c]!) * k;
    }
    // Kept out of the body.
    for (const v of touched) this.collide(v, 0.003);
  }

  /**
   * Grab-style brushes (comb, hook) take the hair under the brush when the
   * stroke starts and carry it with the pointer to the end (as Blender's
   * Grab brush does): each captured vertex with its weight.
   */
  capture(centre: readonly number[], radius: number): { verts: number[]; weights: number[] } {
    const P = this.positions, verts: number[] = [], weights: number[] = [];
    for (let v = 0; v < P.length / 3; v++) {
      const d = Math.hypot(P[v * 3]! - centre[0]!, P[v * 3 + 1]! - centre[1]!, P[v * 3 + 2]! - centre[2]!);
      if (d >= radius) continue;
      const f = (1 - (d / radius) ** 2) ** 2;
      const t = Math.min(1, Math.max(0, (this.along[v]! - 0.004) / 0.06));
      const w = f * t * t * (3 - 2 * t);
      if (w > 0.001) { verts.push(v); weights.push(w); }
    }
    return { verts, weights };
  }

  /** Moves captured hair by `drag` (body frame): comb keeps each hair's length, hook lets it grow to follow. */
  carry(grab: { verts: readonly number[]; weights: readonly number[] }, drag: readonly number[], strength: number, hook: boolean): void {
    const P = this.positions;
    grab.verts.forEach((v, i) => {
      // Grab-style: the hair at the brush's centre follows the pointer all the way (strength is for the other brushes).
      const w = grab.weights[i]! * Math.max(strength, 1);
      for (let c = 0; c < 3; c++) P[v * 3 + c] = P[v * 3 + c]! + drag[c]! * w;
      if (hook) this.reach[v] = Math.max(this.reach[v]!, this.distance(v, this.root[v]!));
    });
    for (const v of grab.verts) {
      const r = this.root[v]!;
      const d = this.distance(v, r), max = this.reach[v]!;
      if (d > max && d > 1e-6) { const k = max / d; for (let c = 0; c < 3; c++) P[v * 3 + c] = P[r * 3 + c]! + (P[v * 3 + c]! - P[r * 3 + c]!) * k; }
      this.collide(v, 0.003);
    }
  }

  private distance(v: number, r: number): number {
    const P = this.positions;
    return Math.hypot(P[v * 3]! - P[r * 3]!, P[v * 3 + 1]! - P[r * 3 + 1]!, P[v * 3 + 2]! - P[r * 3 + 2]!);
  }

  private nearestSkin(x: number, y: number, z: number): number {
    let best = -1, bd = Infinity;
    const S = this.body.shape;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const l = this.skinCells.get(key(x + dx * GRID, y + dy * GRID, z + dz * GRID));
      if (!l) continue;
      for (const s of l) {
        const d = (S[s * 3]! - x) ** 2 + (S[s * 3 + 1]! - y) ** 2 + (S[s * 3 + 2]! - z) ** 2;
        if (d < bd) { bd = d; best = s; }
      }
    }
    return best;
  }

  private skinDistance(x: number, y: number, z: number): number {
    const s = this.nearestSkin(x, y, z);
    if (s < 0) return 1;
    const S = this.body.shape;
    return Math.hypot(S[s * 3]! - x, S[s * 3 + 1]! - y, S[s * 3 + 2]! - z);
  }

  /** Pushes a vertex out of the skin to `gap` along the nearest skin normal. */
  private collide(v: number, gap: number): void {
    const P = this.positions, S = this.body.shape, N = this.body.normals;
    const x = P[v * 3]!, y = P[v * 3 + 1]!, z = P[v * 3 + 2]!;
    const s = this.nearestSkin(x, y, z);
    if (s < 0) return;
    const along = (x - S[s * 3]!) * N[s * 3]! + (y - S[s * 3 + 1]!) * N[s * 3 + 1]! + (z - S[s * 3 + 2]!) * N[s * 3 + 2]!;
    if (along >= gap) return;
    for (let c = 0; c < 3; c++) P[v * 3 + c] = P[v * 3 + c]! + N[s * 3 + c]! * (gap - along);
  }
}

/** A binary min-heap of (priority, vertex). */
class MinHeap {
  private readonly keys: number[] = [];
  private readonly vals: number[] = [];
  get size(): number { return this.keys.length; }
  push(k: number, v: number): void {
    const K = this.keys, V = this.vals;
    let i = K.length;
    K.push(k); V.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p]! <= k) break;
      K[i] = K[p]!; V[i] = V[p]!; i = p;
    }
    K[i] = k; V[i] = v;
  }
  pop(): [number, number] {
    const K = this.keys, V = this.vals;
    const top: [number, number] = [K[0]!, V[0]!];
    const k = K.pop()!, v = V.pop()!;
    if (K.length) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i, mk = k;
        if (l < K.length && K[l]! < mk) { m = l; mk = K[l]!; }
        if (r < K.length && K[r]! < mk) m = r;
        if (m === i) break;
        K[i] = K[m]!; V[i] = V[m]!; i = m;
      }
      K[i] = k; V[i] = v;
    }
    return top;
  }
}
