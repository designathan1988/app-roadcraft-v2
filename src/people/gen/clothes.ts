import { REGION, fitGarment, smoothNormals, type HumanExtras } from './extras';
import type { HumanBase } from './humanBase';

/**
 * Clothes for a morphed body, each piece made from parameters:
 *
 * - Fitted pieces (tops, bottoms, underwear, shoes) are cut from the body
 *   itself: the skin triangles whose vertices all fall inside the piece
 *   (by body region and how far along the limb: sleeve and leg length, hem,
 *   rise, neckline), lifted off the skin along its normal by the fabric's
 *   thickness and the piece's looseness - how a game draws close-fitting
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

/** Which mesh vertices a fitted piece covers, by rest position, region and limb fraction. */
function coverage(b: Body, slot: GarmentSlot, p: GarmentParams): Uint8Array {
  const { ex, base } = b;
  const rest = base.positions;
  const L = (k: string): number => ex.landmark(k);
  const crotch = L('crotch'), hip = L('hip'), waist = L('waist'), chest = L('chest'), neck = L('neckBase');
  const out = new Uint8Array(base.vertexCount);
  const t = p.type;
  for (let v = 0; v < out.length; v++) {
    const r = ex.region[v]!, a = ex.along[v]! / 255;
    const x = rest[v * 3]!, y = rest[v * 3 + 1]!, z = rest[v * 3 + 2]!;
    let on = false;
    if (slot === 'top') {
      if (t === 'bra') {
        on = (r === REGION.chest || r === REGION.abdomen) && y > chest - 0.11 && y < chest + 0.06 && !(z > 0.02 && y > chest + 0.02 && Math.abs(x) < 0.05);
      } else {
        const torso = r === REGION.chest || r === REGION.abdomen || r === REGION.pelvis || r === REGION.neck;
        // Hem: from just below the hips (long) up to under the bust (cropped).
        const hemY = crotch - 0.02 + (chest - 0.04 - (crotch - 0.02)) * p.length;
        // Collar: cut by height, not by the rig's chest/neck boundary (which
        // wanders from vertex to vertex and left a ragged, holed neckline):
        // round the neck's base, a scoop in front as deep as asked, a
        // turtleneck up the neck.
        const depth = 0.01 + p.neckline * 0.2, width = 0.065 + p.neckline * 0.05;
        const scoop = z > 0 ? depth * Math.max(0, 1 - (x / width) ** 2) : 0;
        const collarY = p.neckline < 0.05 ? neck + 0.075 : neck - 0.012 - scoop;
        if (torso && y >= hemY && y <= collarY) on = true;
        if (r === REGION.upperarm && p.sleeve > 0) on = a <= p.sleeve * 2;
        if (r === REGION.forearm && p.sleeve > 0.5) on = a <= (p.sleeve - 0.5) * 2;
        // A sleeveless top leaves the shoulder cap bare.
        if (on && p.sleeve === 0 && r === REGION.chest && Math.abs(x) > 0.13 + 0.02 * (1 - p.neckline) && y > chest) on = false;
      }
    } else if (slot === 'bottom') {
      // Rise: the waistband from the hips (low) to the natural waist (high).
      const top = hip + (waist + 0.03 - hip) * p.neckline;
      const trunk = (r === REGION.pelvis || r === REGION.abdomen || r === REGION.chest) && y <= top;
      if (trunk) on = true;
      if (r === REGION.thigh) on = a <= Math.max(0.06, p.length * 2);
      if (r === REGION.shin) on = p.length > 0.5 && a <= (p.length - 0.5) * 2;
      if (t === 'briefs') on = (trunk || (r === REGION.thigh && a < 0.08)) && y > crotch - 0.09;
    } else {
      if (r === REGION.foot || r === REGION.toes) on = t !== 'flats' || y < 0.07 || z > 0.07;
      if (t === 'flats' && (r === REGION.foot || r === REGION.toes)) on = y < 0.045;
      if (r === REGION.shin && (t === 'boots' || t === 'socks' || t === 'sneakers')) on = a >= 1 - p.length * 0.9;
    }
    if (on) out[v] = 1;
  }
  return out;
}

/** Fabric thickness off the skin, metres. */
const THICK: Readonly<Record<string, number>> = { cotton: 0.0035, denim: 0.0045, knit: 0.004, silk: 0.0025, leather: 0.005 };

function shell(b: Body, slot: GarmentSlot, p: GarmentParams, layer: number): GarmentMesh | null {
  const cover = coverage(b, slot, p);
  const map = new Int32Array(b.base.vertexCount).fill(-1);
  const verts: number[] = [];
  const index: number[] = [];
  const s = b.skin;
  for (let i = 0; i < s.length; i += 3) {
    const a = s[i]!, c = s[i + 1]!, d = s[i + 2]!;
    if (!cover[a] || !cover[c] || !cover[d]) continue;
    for (const v of [a, c, d]) {
      if (map[v]! < 0) { map[v] = verts.length; verts.push(v); }
      index.push(map[v]!);
    }
  }
  if (!index.length) return null;
  const n = verts.length;
  const positions = new Float32Array(n * 3), pattern = new Float32Array(n * 3);
  const off = (THICK[p.fabric] ?? 0.0035) + layer * 0.0025 + p.loose * 0.032;
  let lift = 0;
  for (let i = 0; i < n; i++) {
    const v = verts[i]! * 3;
    for (let k = 0; k < 3; k++) {
      positions[i * 3 + k] = b.shape[v + k]! + b.normals[v + k]! * off;
      pattern[i * 3 + k] = b.base.positions[v + k]!;
    }
  }
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
  return { slot, params: p, positions, normals: smoothNormals(n, positions, ident, idx), pattern, index: idx, lift };
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
  if (outfit.shoes) out.push(shell(b, 'shoes', outfit.shoes, 0));
  return out.filter((g): g is GarmentMesh => !!g);
}
