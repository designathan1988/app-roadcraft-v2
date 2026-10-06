import { REGION, fitGarment, smoothNormals, type HumanExtras } from './extras';
import type { HumanBase } from './humanBase';

/**
 * Clothes for a morphed body, each piece made from parameters:
 *
 * - Fitted pieces (tops, bottoms, underwear, shoes) are cut from the body
 *   itself, exactly along the piece's edge (by body region and how far along
 *   the limb: sleeve and leg length, hem, rise, neckline), lifted off the
 *   skin along its normal by the fabric's thickness and the piece's
 *   looseness, and relaxed over the body's hollows - how a game draws close-fitting
 *   clothes over a morphable body, and how The Sims' clothes follow its
 *   sliders.
 * - Skirts hang: rings from the waist down to the hem, each an ellipse
 *   round the hips and both legs at that height (never narrower than the
 *   ring above, so the cloth falls past the gap between the legs), widened
 *   by the flare.
 * - The modelled shirt and trousers (CharMorph's) are fitted by their skin
 *   binding (`fitGarment`).
 *
 * Every piece carries its rest-body coordinates (`pattern`), so a print or
 * a check stays put on the cloth when the body changes. Pure: no three.js.
 */

export type GarmentSlot = 'top' | 'bottom' | 'shoes';

export interface GarmentParams {
  readonly type: string;
  readonly colour: number;
  readonly colour2: number;
  readonly pattern: string;
  readonly patternScale: number;
  readonly fabric: string;
  /** Tops: 0 none .. 0.5 elbow .. 1 wrist. */
  readonly sleeve: number;
  /** Tops: 0 long (to the hips) .. 1 cropped. Bottoms: leg 0 brief .. 1 ankle. Skirts: 0 mini .. 1 maxi. Boots: shaft height. */
  readonly length: number;
  /** Tops: 0 high neck .. 1 deep. Bottoms: 0 low rise .. 1 high. */
  readonly neckline: number;
  readonly loose: number;
  /** Skirts: 0 straight .. 1 full. */
  readonly flare: number;
}

export interface Outfit {
  readonly top: GarmentParams | null;
  readonly bottom: GarmentParams | null;
  readonly shoes: GarmentParams | null;
}

/** The kinds the creator offers, by slot. */
export const GARMENT_TYPES: Readonly<Record<GarmentSlot, readonly string[]>> = {
  top: ['tank', 'tshirt', 'longsleeve', 'crop', 'turtleneck', 'shirt', 'dress', 'bra'],
  bottom: ['briefs', 'shorts', 'capri', 'trousers', 'leggings', 'pants', 'skirt'],
  shoes: ['sneakers', 'flats', 'boots', 'socks'],
};

export const PATTERNS = ['solid', 'stripes', 'pinstripe', 'check', 'dots', 'denim', 'knit', 'camo'] as const;
export const FABRICS = ['cotton', 'denim', 'knit', 'silk', 'leather'] as const;

/** Sensible starting settings for each kind of piece. */
export function garmentDefaults(type: string): Omit<GarmentParams, 'colour' | 'colour2' | 'pattern' | 'patternScale'> {
  const base = { type, fabric: 'cotton', sleeve: 0, length: 0.25, neckline: 0.35, loose: 0.2, flare: 0.3 };
  switch (type) {
    case 'tank': return { ...base, sleeve: 0, neckline: 0.55 };
    case 'tshirt': return { ...base, sleeve: 0.28 };
    case 'longsleeve': return { ...base, sleeve: 0.96 };
    case 'crop': return { ...base, sleeve: 0.2, length: 0.85 };
    case 'turtleneck': return { ...base, sleeve: 0.96, neckline: 0, fabric: 'knit' };
    case 'shirt': return { ...base, sleeve: 1, neckline: 0.3 };
    case 'dress': return { ...base, sleeve: 0.12, length: 0.45, neckline: 0.45, flare: 0.45, fabric: 'silk' };
    case 'bra': return { ...base, neckline: 0.6, loose: 0 };
    case 'briefs': return { ...base, length: 0.04, neckline: 0.35, loose: 0 };
    case 'shorts': return { ...base, length: 0.3, neckline: 0.55, loose: 0.45 };
    case 'capri': return { ...base, length: 0.78, neckline: 0.55 };
    case 'trousers': return { ...base, length: 1, neckline: 0.55, fabric: 'denim', loose: 0.45 };
    case 'leggings': return { ...base, length: 1, neckline: 0.6, loose: 0, fabric: 'knit' };
    case 'pants': return { ...base, length: 1, neckline: 0.5 };
    case 'skirt': return { ...base, length: 0.35, neckline: 0.6, flare: 0.4 };
    case 'sneakers': return { ...base, length: 0.1 };
    case 'flats': return { ...base, length: 0 };
    case 'boots': return { ...base, length: 0.55, fabric: 'leather' };
    case 'socks': return { ...base, length: 0.3, fabric: 'knit' };
    default: return base;
  }
}

/** A piece to draw. */
export interface GarmentMesh {
  readonly slot: GarmentSlot;
  readonly params: GarmentParams;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  /** Rest-body position of each vertex: where the pattern is read. */
  readonly pattern: Float32Array;
  readonly index: Uint32Array;
  /** Metres the shoes' soles lift the person. */
  readonly lift: number;
}

export interface Body {
  readonly base: HumanBase;
  readonly ex: HumanExtras;
  readonly shape: Float32Array;
  /** One normal per mesh vertex. */
  readonly normals: Float32Array;
  /** Skin triangles over mesh vertices. */
  readonly skin: Uint32Array;
}

const SKIN_TRIS = new WeakMap<HumanBase, Uint32Array>();

export function bodyFor(base: HumanBase, ex: HumanExtras, shape: Float32Array): Body {
  let skin = SKIN_TRIS.get(base);
  if (!skin) {
    const list: number[] = [];
    for (const g of base.meta.groups) {
      if (g.material !== 'Skin' && g.material !== 'Covered') continue;
      for (let i = g.start; i < g.start + g.count; i++) list.push(base.renderSource[base.index[i]!]!);
    }
    skin = Uint32Array.from(list);
    SKIN_TRIS.set(base, skin);
  }
  // Normals per mesh vertex from the skin triangles.
  const identity = new Uint32Array(base.vertexCount).map((_, i) => i);
  const normals = smoothNormals(base.vertexCount, shape, identity, skin);
  return { base, ex, shape, normals, skin };
}

/**
 * How far inside a fitted piece each mesh vertex is, in metres (negative:
 * outside), by rest position, region and limb fraction. The piece's edge is
 * where this crosses zero, cut through the triangles (`shell`), so hems,
 * collars and cuffs run straight instead of stepping along whole triangles.
 */
function coverage(b: Body, slot: GarmentSlot, p: GarmentParams): Float32Array {
  const { ex, base } = b;
  const rest = base.positions;
  const L = (k: string): number => ex.landmark(k);
  const crotch = L('crotch'), hip = L('hip'), waist = L('waist'), chest = L('chest'), neck = L('neckBase');
  const out = new Float32Array(base.vertexCount);
  const t = p.type;
  // Outside a region the piece covers: just past its edge, so a cut along a
  // region's border falls between that border's vertices and the next.
  const OFF = -0.01;
  // A limb fraction (0..1) to metres, near enough for where its cut falls.
  const ARM = 0.3, LEG = 0.42;
  for (let v = 0; v < out.length; v++) {
    const r = ex.region[v]!, a = ex.along[v]! / 255;
    const x = rest[v * 3]!, y = rest[v * 3 + 1]!, z = rest[v * 3 + 2]!;
    let s = OFF;
    if (slot === 'top') {
      if (t === 'bra') {
        const on = (r === REGION.chest || r === REGION.abdomen) && !(z > 0.02 && y > chest + 0.02 && Math.abs(x) < 0.05);
        if (on) s = Math.min(y - (chest - 0.11), chest + 0.06 - y);
      } else {
        const torso = r === REGION.chest || r === REGION.abdomen || r === REGION.pelvis || r === REGION.neck;
        // Hem: from just below the hips (long) up to under the bust (cropped).
        const hemY = crotch - 0.02 + (chest - 0.04 - (crotch - 0.02)) * p.length;
        // Collar: cut by height round the neck's base, a scoop in front as
        // deep as asked, a turtleneck up the neck.
        const depth = 0.01 + p.neckline * 0.2, width = 0.065 + p.neckline * 0.05;
        const scoop = z > 0 ? depth * Math.max(0, 1 - (x / width) ** 2) : 0;
        const collarY = p.neckline < 0.05 ? neck + 0.075 : neck - 0.012 - scoop;
        if (torso) {
          s = Math.min(y - hemY, collarY - y);
          // A sleeveless top leaves the shoulder cap bare.
          if (p.sleeve === 0 && r === REGION.chest) s = Math.min(s, Math.max(0.13 + 0.02 * (1 - p.neckline) - Math.abs(x), chest - y));
        }
        if (r === REGION.upperarm) s = p.sleeve > 0 ? (p.sleeve * 2 - a) * ARM : OFF;
        if (r === REGION.forearm) s = p.sleeve > 0.5 ? ((p.sleeve - 0.5) * 2 - a) * ARM : OFF;
      }
    } else if (slot === 'bottom') {
      // Rise: the waistband from the hips (low) to the natural waist (high).
      const top = hip + (waist + 0.03 - hip) * p.neckline;
      const trunk = r === REGION.pelvis || r === REGION.abdomen || r === REGION.chest;
      if (trunk) s = top - y;
      if (r === REGION.thigh) s = (Math.max(0.06, p.length * 2) - a) * LEG;
      if (r === REGION.shin) s = p.length > 0.5 ? ((p.length - 0.5) * 2 - a) * LEG : OFF;
      if (t === 'briefs') {
        if (trunk) s = Math.min(top - y, y - (crotch - 0.09));
        else if (r === REGION.thigh) s = Math.min((0.08 - a) * LEG, y - (crotch - 0.09));
        else s = OFF;
      }
    } else {
      if (r === REGION.foot || r === REGION.toes) s = t === 'flats' ? 0.045 - y : 0.02;
      if (r === REGION.shin && (t === 'boots' || t === 'socks' || t === 'sneakers')) s = (a - (1 - p.length * 0.9)) * LEG;
    }
    out[v] = s;
  }
  return out;
}

/** Fabric thickness off the skin, metres. */
const THICK: Readonly<Record<string, number>> = { cotton: 0.0035, denim: 0.0045, knit: 0.004, silk: 0.0025, leather: 0.005 };

/**
 * A fitted piece: the skin inside its edge, cut exactly along the edge
 * (marching triangles: the edge crosses a triangle's sides where the inside
 * distance, linearly interpolated, is zero), lifted off the skin by the
 * fabric's thickness; then smoothed (Laplacian) and pushed back out of the
 * body, more for a looser piece, so the cloth bridges hollows - between the
 * breasts, the small of the back, the navel - instead of sinking into them.
 */
function shell(b: Body, slot: GarmentSlot, p: GarmentParams, layer: number): GarmentMesh | null {
  const field = coverage(b, slot, p);
  const off = (THICK[p.fabric] ?? 0.0035) + layer * 0.0025 + p.loose * 0.02;
  // Each vertex of the piece: a point on the skin (a mesh vertex, or a
  // point on a side where the edge crosses it), its skin normal and rest position.
  const skinAt: number[] = [], normal: number[] = [], rest: number[] = [];
  const ids = new Map<number, number>();
  const vertexOf = (v: number): number => {
    let id = ids.get(v);
    if (id === undefined) {
      ids.set(v, id = skinAt.length / 3);
      for (let k = 0; k < 3; k++) { skinAt.push(b.shape[v * 3 + k]!); normal.push(b.normals[v * 3 + k]!); rest.push(b.base.positions[v * 3 + k]!); }
    }
    return id;
  };
  const sideIds = new Map<number, number>();
  const crossing = (u: number, w: number): number => {
    const lo = Math.min(u, w), hi = Math.max(u, w);
    const key = lo * 4194304 + hi;
    let id = sideIds.get(key);
    if (id === undefined) {
      const t = field[lo]! / (field[lo]! - field[hi]!);
      sideIds.set(key, id = skinAt.length / 3);
      const n = [0, 1, 2].map((k) => b.normals[lo * 3 + k]! + (b.normals[hi * 3 + k]! - b.normals[lo * 3 + k]!) * t);
      const len = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
      for (let k = 0; k < 3; k++) {
        skinAt.push(b.shape[lo * 3 + k]! + (b.shape[hi * 3 + k]! - b.shape[lo * 3 + k]!) * t);
        normal.push(n[k]! / len);
        rest.push(b.base.positions[lo * 3 + k]! + (b.base.positions[hi * 3 + k]! - b.base.positions[lo * 3 + k]!) * t);
      }
    }
    return id;
  };
  const index: number[] = [];
  const s = b.skin;
  for (let i = 0; i < s.length; i += 3) {
    const tri = [s[i]!, s[i + 1]!, s[i + 2]!];
    const inside = tri.map((v) => field[v]! >= 0);
    const count = inside.filter(Boolean).length;
    if (count === 0) continue;
    if (count === 3) { index.push(vertexOf(tri[0]!), vertexOf(tri[1]!), vertexOf(tri[2]!)); continue; }
    // Clip the triangle to the inside (Sutherland-Hodgman against one
    // boundary): keep the inside corners, add the crossing on every side
    // that changes, then fan the polygon.
    const poly: number[] = [];
    for (let k = 0; k < 3; k++) {
      if (inside[k]) poly.push(vertexOf(tri[k]!));
      if (inside[k] !== inside[(k + 1) % 3]) poly.push(crossing(tri[k]!, tri[(k + 1) % 3]!));
    }
    for (let k = 1; k + 1 < poly.length; k++) index.push(poly[0]!, poly[k]!, poly[k + 1]!);
  }
  if (!index.length) return null;
  const n = skinAt.length / 3;
  // The cloth lies on a body without its small detail (nipples, navel,
  // ribs): the skin under the piece smoothed by Taubin's lambda|mu filter,
  // which, unlike plain Laplacian smoothing, does not shrink it.
  const proxy = Float32Array.from(skinAt);
  taubin(proxy, index, slot === 'shoes' ? 0 : 60);
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) positions[i] = proxy[i]! + normal[i]! * off;
  // A shoe is a stiff shell: smoothed until the toes no longer show.
  relax(positions, index, proxy, normal, off, slot === 'shoes' ? 4 : 20 + Math.round(p.loose * 40));
  // Never closer than 1.5 mm to the real skin, the cloth tenting smoothly
  // over what still stands out (relaxed against the real skin a few times).
  relax(positions, index, skinAt, normal, 0.0015, 6);
  let lift = 0;
  if (slot === 'shoes' && p.type !== 'socks') {
    // A sole: what is low on the foot is flattened onto it, the person standing on it.
    lift = p.type === 'boots' ? 0.022 : p.type === 'flats' ? 0.008 : 0.018;
    let lo = Infinity;
    for (let i = 0; i < n; i++) lo = Math.min(lo, positions[i * 3 + 1]!);
    for (let i = 0; i < n; i++) {
      const y = positions[i * 3 + 1]!;
      if (y < lo + 0.012) positions[i * 3 + 1] = lo - lift;
    }
  }
  const ident = new Uint32Array(n).map((_, i) => i);
  const idx = Uint32Array.from(index);
  return { slot, params: p, positions, normals: smoothNormals(n, positions, ident, idx), pattern: Float32Array.from(rest), index: idx, lift };
}

/** Taubin's lambda|mu smoothing (1995): a shrinking pass then an inflating one, `passes` times. */
function taubin(pos: Float32Array, index: readonly number[], passes: number): void {
  if (!passes) return;
  const n = pos.length / 3;
  const nb: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < index.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = index[i + k]!, c = index[i + (k + 1) % 3]!;
      if (!nb[a]!.includes(c)) { nb[a]!.push(c); nb[c]!.push(a); }
    }
  }
  const next = new Float32Array(pos.length);
  for (let pass = 0; pass < passes * 2; pass++) {
    const f = pass % 2 ? -0.53 : 0.5;
    for (let v = 0; v < n; v++) {
      const list = nb[v]!;
      for (let k = 0; k < 3; k++) {
        let m = 0;
        for (const u of list) m += pos[u * 3 + k]!;
        next[v * 3 + k] = list.length ? pos[v * 3 + k]! + f * (m / list.length - pos[v * 3 + k]!) : pos[v * 3 + k]!;
      }
    }
    pos.set(next);
  }
}

/**
 * Laplacian smoothing (each vertex halfway to its neighbours' mean; the open
 * edge only along itself, so a hem stays where it was cut), each pass
 * followed by the body's collision: no vertex nearer the skin than `off`
 * along its skin normal.
 */
function relax(pos: Float32Array, index: readonly number[], skin: ArrayLike<number>, normal: ArrayLike<number>, off: number, passes: number): void {
  const n = pos.length / 3;
  const sides = new Map<number, number>();
  const nb: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < index.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = index[i + k]!, c = index[i + (k + 1) % 3]!;
      const key = Math.min(a, c) * 4194304 + Math.max(a, c);
      const seen = sides.get(key);
      sides.set(key, (seen ?? 0) + 1);
      if (seen === undefined) { nb[a]!.push(c); nb[c]!.push(a); }
    }
  }
  // The open edge: sides used by one triangle.
  const rim: number[][] = Array.from({ length: n }, () => []);
  for (const [key, count] of sides) {
    if (count !== 1) continue;
    const a = Math.floor(key / 4194304), c = key % 4194304;
    rim[a]!.push(c); rim[c]!.push(a);
  }
  const next = new Float32Array(pos.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let v = 0; v < n; v++) {
      const list = rim[v]!.length ? rim[v]! : nb[v]!;
      for (let k = 0; k < 3; k++) {
        let m = 0;
        for (const u of list) m += pos[u * 3 + k]!;
        next[v * 3 + k] = list.length ? pos[v * 3 + k]! * 0.5 + (m / list.length) * 0.5 : pos[v * 3 + k]!;
      }
    }
    for (let v = 0; v < n; v++) {
      let d = 0;
      for (let k = 0; k < 3; k++) d += (next[v * 3 + k]! - skin[v * 3 + k]!) * normal[v * 3 + k]!;
      const push = Math.max(0, off - d);
      for (let k = 0; k < 3; k++) pos[v * 3 + k] = next[v * 3 + k]! + normal[v * 3 + k]! * push;
    }
  }
}

/**
 * Shoes and boots are built on the foot as a shoemaker's last is: not the
 * skin (which shows every toe) but its hull. The foot is cut in slices from
 * heel to toe; each slice's outline is the convex hull of the foot there
 * (its support in 32 directions), pushed out by the leather; the shaft of a
 * boot or sneaker is the same, in horizontal slices up the shin. The sole is
 * flat, under the lowest point. Flats are cut down to a low rim.
 */
function shoe(b: Body, p: GarmentParams): GarmentMesh | null {
  const { ex, shape } = b;
  const thick = (THICK[p.fabric] ?? 0.004) + 0.002;
  const lift = p.type === 'boots' ? 0.022 : p.type === 'flats' ? 0.008 : 0.018;
  const A = 32;
  const positions: number[] = [], index: number[] = [];
  /** A slice: its centre (two axes) and how far the foot reaches from it in each of A directions. */
  interface Slice { cu: number; cv: number; at: number; reach: number[] }
  const slice = (pts: number[][], u: number, v: number, at: number): Slice => {
    let cu = 0, cv = 0;
    for (const q of pts) { cu += q[u]!; cv += q[v]!; }
    cu /= pts.length; cv /= pts.length;
    const reach: number[] = [];
    for (let k = 0; k < A; k++) {
      const a = (k / A) * Math.PI * 2, du = Math.cos(a), dv = Math.sin(a);
      let r = 0;
      for (const q of pts) r = Math.max(r, (q[u]! - cu) * du + (q[v]! - cv) * dv);
      reach.push(r);
    }
    return { cu, cv, at, reach };
  };
  /** Smooths slices along the run and round each outline, so the last is smooth as a last is. */
  const smooth = (run: Slice[], passes: number): Slice[] => {
    let cur = run;
    for (let n = 0; n < passes; n++) {
      cur = cur.map((s, i) => {
        const a = cur[Math.max(0, i - 1)]!, c = cur[Math.min(cur.length - 1, i + 1)]!;
        // Ends keep their place along the run; their outline still smooths.
        const end = i === 0 || i === cur.length - 1;
        return {
          at: s.at,
          cu: end ? s.cu : (a.cu + 2 * s.cu + c.cu) / 4,
          cv: end ? s.cv : (a.cv + 2 * s.cv + c.cv) / 4,
          reach: s.reach.map((r, k) => {
            const along = end ? r : (a.reach[k]! + 2 * r + c.reach[k]!) / 4;
            const round = (s.reach[(k + A - 1) % A]! + 2 * r + s.reach[(k + 1) % A]!) / 4;
            // Never inside the foot: a last only fills hollows.
            return Math.max(r, (along + round) / 2);
          }),
        };
      });
    }
    return cur;
  };
  /** Emits a slice's ring; u, v, w are the axes of the outline and of the run. */
  const ring = (s: Slice, u: number, v: number, w: number, extra = 0): number => {
    const at = positions.length / 3;
    for (let k = 0; k < A; k++) {
      const a = (k / A) * Math.PI * 2;
      const q = [0, 0, 0];
      q[u] = s.cu + Math.cos(a) * (s.reach[k]! + thick + extra);
      q[v] = s.cv + Math.sin(a) * (s.reach[k]! + thick + extra);
      q[w] = s.at;
      positions.push(q[0]!, q[1]!, q[2]!);
    }
    return at;
  };
  const join = (a: number, c: number): void => {
    for (let k = 0; k < A; k++) {
      const k2 = (k + 1) % A;
      index.push(a + k, c + k, a + k2, a + k2, c + k, c + k2);
    }
  };
  const cap = (a: number, centre: number[], flip: boolean): void => {
    const c = positions.length / 3;
    positions.push(centre[0]!, centre[1]!, centre[2]!);
    for (let k = 0; k < A; k++) {
      const k2 = (k + 1) % A;
      if (flip) index.push(a + k, a + k2, c); else index.push(a + k2, a + k, c);
    }
  };
  for (const side of [1, -1]) {
    const from = positions.length;
    const foot: number[][] = [], shin: number[][] = [];
    for (let v = 0; v < ex.region.length; v++) {
      const r = ex.region[v]!;
      const q = [shape[v * 3]!, shape[v * 3 + 1]!, shape[v * 3 + 2]!];
      if (Math.sign(q[0]!) !== side) continue;
      if (r === REGION.foot || r === REGION.toes) foot.push(q);
      else if (r === REGION.shin) shin.push(q);
    }
    if (foot.length < 10) continue;
    let z0 = Infinity, z1 = -Infinity, floor = Infinity;
    for (const q of foot) { z0 = Math.min(z0, q[2]!); z1 = Math.max(z1, q[2]!); floor = Math.min(floor, q[1]!); }
    // Foot: vertical slices from heel to toe (outline in x, y; along z).
    const S = 40, gap = (z1 - z0) / S;
    const run: Slice[] = [];
    for (let i = 0; i <= S; i++) {
      const z = z0 + (z1 - z0) * (0.015 + 0.97 * i / S);
      const near = foot.filter((q) => Math.abs(q[2]! - z) < gap * 1.5);
      if (near.length >= 3) run.push(slice(near, 0, 1, z));
    }
    const lastRun = smooth(run, 4);
    const rings = lastRun.map((s) => ring(s, 0, 1, 2));
    for (let i = 0; i + 1 < rings.length; i++) join(rings[i]!, rings[i + 1]!);
    if (lastRun.length) {
      const h = lastRun[0]!, t = lastRun[lastRun.length - 1]!;
      cap(rings[0]!, [h.cu, h.cv, z0 - thick], true);
      cap(rings[rings.length - 1]!, [t.cu, t.cv, z1 + thick], false);
    }
    // Shaft: horizontal slices up the shin (outline in x, z; along y), from inside the foot's top.
    // The shin's ends on this body (the landmarks are the rest body's), and
    // the shaft as a share of it, so a child's boot is a child's.
    let ankle = Infinity, knee = -Infinity;
    for (const q of shin) { ankle = Math.min(ankle, q[1]!); knee = Math.max(knee, q[1]!); }
    const shinLen = Math.max(0.1, knee - ankle);
    const height = p.type === 'boots' ? shinLen * (0.15 + p.length * 0.75) : p.type === 'sneakers' ? shinLen * (0.07 + p.length * 0.12) : 0;
    if (height > 0) {
      const y0 = ankle, y1 = ankle + height;
      const R = Math.max(2, Math.round((y1 - y0) / 0.012));
      const shaft: Slice[] = [];
      for (let i = 0; i <= R; i++) {
        const y = y0 + (y1 - y0) * (i / R);
        const near = shin.filter((q) => Math.abs(q[1]! - y) < 0.012);
        if (near.length >= 3) shaft.push(slice(near, 0, 2, y));
      }
      // Outlines in (x, z) wind the other way round: join them reversed.
      // Down into the foot's top, so no gap shows at the ankle.
      if (shaft.length) shaft.unshift({ ...shaft[0]!, at: shaft[0]!.at - 0.03 });
      // Room for trousers or leggings inside the shaft, and its top a little open.
      const ups = smooth(shaft, 3).map((s, i, all) => ring(s, 0, 2, 1, 0.009 + 0.004 * (i / Math.max(1, all.length - 1)) ** 2));
      for (let i = 0; i + 1 < ups.length; i++) join(ups[i + 1]!, ups[i]!);
    }
    // The sole: what is low is drawn down flat under the foot, the sole's
    // depth below it - smoothly by height, or a ring's neighbours either
    // side of a cut would make a sawtooth edge.
    for (let i = from; i < positions.length; i += 3) {
      const y = positions[i + 1]!;
      const t = Math.min(1, Math.max(0, (floor + 0.03 - y) / 0.035));
      positions[i + 1] = y + t * t * (3 - 2 * t) * (floor - lift - y);
    }
  }
  if (!index.length) return null;
  let pos: Float32Array = Float32Array.from(positions), idx: Uint32Array = Uint32Array.from(index);
  if (p.type === 'flats') {
    // A low rim: cut where the shoe rises past 4.5 cm.
    let lo = Infinity;
    for (let i = 1; i < pos.length; i += 3) lo = Math.min(lo, pos[i]!);
    const field = new Float32Array(pos.length / 3).map((_, v) => lo + 0.045 - pos[v * 3 + 1]!);
    [pos, idx] = clipMesh(pos, idx, field);
  }
  const n = pos.length / 3;
  const ident = new Uint32Array(n).map((_, i) => i);
  // The person stands on the soles: the stage lifts them by `lift`.
  return { slot: 'shoes', params: p, positions: pos, normals: smoothNormals(n, pos, ident, idx), pattern: pos.slice(), index: idx, lift };
}

/** A mesh cut to where `field` >= 0, exactly (marching triangles). */
function clipMesh(pos: Float32Array, index: Uint32Array, field: Float32Array): [Float32Array, Uint32Array] {
  const out: number[] = Array.from(pos), idx: number[] = [];
  const sides = new Map<number, number>();
  const crossing = (u: number, w: number): number => {
    const lo = Math.min(u, w), hi = Math.max(u, w), key = lo * 4194304 + hi;
    let id = sides.get(key);
    if (id === undefined) {
      const t = field[lo]! / (field[lo]! - field[hi]!);
      sides.set(key, id = out.length / 3);
      for (let k = 0; k < 3; k++) out.push(pos[lo * 3 + k]! + (pos[hi * 3 + k]! - pos[lo * 3 + k]!) * t);
    }
    return id;
  };
  for (let i = 0; i < index.length; i += 3) {
    const tri = [index[i]!, index[i + 1]!, index[i + 2]!];
    const inside = tri.map((v) => field[v]! >= 0);
    const count = inside.filter(Boolean).length;
    if (count === 0) continue;
    if (count === 3) { idx.push(...tri); continue; }
    const poly: number[] = [];
    for (let k = 0; k < 3; k++) {
      if (inside[k]) poly.push(tri[k]!);
      if (inside[k] !== inside[(k + 1) % 3]) poly.push(crossing(tri[k]!, tri[(k + 1) % 3]!));
    }
    for (let k = 1; k + 1 < poly.length; k++) idx.push(poly[0]!, poly[k]!, poly[k + 1]!);
  }
  return [Float32Array.from(out), Uint32Array.from(idx)];
}

/** A skirt hanging from `topY` (rest height) to the hem. */
function skirt(b: Body, p: GarmentParams, topY: number, slot: GarmentSlot): GarmentMesh | null {
  const { ex, shape, base } = b;
  const knee = ex.landmark('knee'), ankle = ex.landmark('ankle');
  const bottomRest = knee + 0.12 - (knee + 0.12 - (ankle + 0.03)) * p.length;
  // Rest heights map to the morphed body through the mean drop of the leg vertices near each height.
  const legs: number[] = [];
  for (let v = 0; v < ex.region.length; v++) {
    const r = ex.region[v]!;
    if (r === REGION.pelvis || r === REGION.thigh || r === REGION.shin || r === REGION.abdomen) legs.push(v);
  }
  const RINGS = 22, SEG = 48;
  const positions: number[] = [], pattern: number[] = [], index: number[] = [];
  let prev: [number, number] | null = null;
  let cx = 0, cz = 0;
  for (let i = 0; i <= RINGS; i++) {
    const u = i / RINGS;
    const yr = topY + (bottomRest - topY) * u;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, ym = 0, nm = 0;
    for (const v of legs) {
      const ry = base.positions[v * 3 + 1]!;
      if (Math.abs(ry - yr) > 0.02) continue;
      const x = shape[v * 3]!, z = shape[v * 3 + 2]!;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      ym += shape[v * 3 + 1]!; nm++;
    }
    const y = nm ? ym / nm : (positions.length ? positions[positions.length - 2]! - 0.03 : yr);
    if (i === 0) { cx = (minX + maxX) / 2; cz = (minZ + maxZ) / 2; }
    let rx: number = nm ? (maxX - minX) / 2 : prev![0], rz: number = nm ? (maxZ - minZ) / 2 : prev![1];
    rx += 0.012 + p.loose * 0.02; rz += 0.014 + p.loose * 0.02;
    if (prev) { rx = Math.max(rx, prev[0]); rz = Math.max(rz, prev[1]); }
    const fl = p.flare * 0.32 * u * u;
    const ring: [number, number] = [rx + fl * 0.9, rz + fl * 0.7];
    prev = [rx, rz];
    for (let s = 0; s < SEG; s++) {
      const a = (s / SEG) * Math.PI * 2;
      positions.push(cx + Math.sin(a) * ring[0], y, cz + Math.cos(a) * ring[1]);
      pattern.push(Math.sin(a) * 0.18, yr, Math.cos(a) * 0.12);
    }
  }
  for (let i = 0; i < RINGS; i++) {
    for (let s = 0; s < SEG; s++) {
      const a = i * SEG + s, c = i * SEG + ((s + 1) % SEG), d = a + SEG, e = c + SEG;
      index.push(a, d, c, c, d, e);
    }
  }
  const pos = Float32Array.from(positions), idx = Uint32Array.from(index);
  const ident = new Uint32Array(pos.length / 3).map((_, i) => i);
  return { slot, params: p, positions: pos, normals: smoothNormals(pos.length / 3, pos, ident, idx), pattern: Float32Array.from(pattern), index: idx, lift: 0 };
}

/** A modelled CharMorph garment, fitted to the body. */
function modelled(b: Body, id: string, slot: GarmentSlot, p: GarmentParams): GarmentMesh | null {
  const g = b.ex.garments.get(id);
  if (!g) return null;
  const fitted = fitGarment(g, b.base, b.shape);
  const positions = new Float32Array(g.renderSource.length * 3), pattern = new Float32Array(g.renderSource.length * 3);
  for (let r = 0; r < g.renderSource.length; r++) {
    const s = g.renderSource[r]! * 3;
    for (let k = 0; k < 3; k++) { positions[r * 3 + k] = fitted[s + k]!; pattern[r * 3 + k] = g.positions[s + k]!; }
  }
  return { slot, params: p, positions, normals: smoothNormals(g.positions.length / 3, fitted, g.renderSource, g.index), pattern, index: g.index, lift: 0 };
}

/** Every piece of an outfit for this body (underwear when a slot is empty). */
export function dressBody(b: Body, outfit: Outfit, female: boolean): GarmentMesh[] {
  const { ex } = b;
  const out: (GarmentMesh | null)[] = [];
  const plain = (type: string, colour: number): GarmentParams => ({ ...garmentDefaults(type), colour, colour2: colour, pattern: 'solid', patternScale: 1 });
  const top = outfit.top ?? (female ? plain('bra', 0xd8d2c8) : null);
  const bottom = outfit.bottom ?? (top?.type === 'dress' ? null : plain('briefs', 0xd8d2c8));
  if (bottom) {
    if (bottom.type === 'pants') out.push(modelled(b, 'Pants', 'bottom', bottom));
    else if (bottom.type === 'skirt') {
      out.push(shell(b, 'bottom', { ...bottom, type: 'briefs', length: 0.04 }, 0));
      out.push(skirt(b, bottom, ex.landmark('hip') + (ex.landmark('waist') - ex.landmark('hip')) * bottom.neckline, 'bottom'));
    } else out.push(shell(b, 'bottom', bottom, 0));
  }
  if (top) {
    if (top.type === 'shirt') out.push(modelled(b, 'Shirt', 'top', top));
    else if (top.type === 'dress') {
      out.push(shell(b, 'top', { ...top, type: 'tshirt', length: 0.62 }, 1));
      out.push(skirt(b, top, ex.landmark('waist') - 0.01, 'top'));
    } else out.push(shell(b, 'top', top, 1));
  }
  if (outfit.shoes) out.push(outfit.shoes.type === 'socks' ? shell(b, 'shoes', outfit.shoes, 0) : shoe(b, outfit.shoes));
  return out.filter((g): g is GarmentMesh => !!g);
}
