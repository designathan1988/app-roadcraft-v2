import { Rng } from '@core/rng';
import { REGION, type HumanExtras, type Strands } from './extras';
import type { HumanBase } from './humanBase';

/** A morphed body with its normals, as the clothes build it (`clothes.bodyFor`). */
export interface ShapedBody { readonly shape: Float32Array; readonly normals: Float32Array; readonly skin: Uint32Array }

/**
 * The head's skin as a solid: morphed head vertices with their normals in a
 * grid of 1.2 cm cells. A strand point nearer the skin than `margin` (or
 * under it) is moved out along the nearest vertex's normal.
 */
class HeadSolid {
  private readonly cells = new Map<number, number[]>();
  private readonly lo: number[] = [Infinity, Infinity, Infinity];
  private readonly hi: number[] = [-Infinity, -Infinity, -Infinity];
  private static readonly C = 0.012;
  /**
   * `torso`: vertices of the neck, shoulders, chest, back and upper arms,
   * kept `torsoMargin` clear (over the clothes), so long hair falls over the
   * shoulders and down the back instead of through them.
   */
  constructor(private readonly body: ShapedBody, verts: Uint32Array, private readonly torso: Uint8Array | null = null, private readonly torsoMargin = 0) {
    const s = body.shape;
    for (const v of verts) {
      for (let k = 0; k < 3; k++) { this.lo[k] = Math.min(this.lo[k]!, s[v * 3 + k]!); this.hi[k] = Math.max(this.hi[k]!, s[v * 3 + k]!); }
      const key = this.key(s[v * 3]!, s[v * 3 + 1]!, s[v * 3 + 2]!);
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, list = []);
      list.push(v);
    }
  }
  private key(x: number, y: number, z: number): number {
    const C = HeadSolid.C;
    return ((Math.floor(x / C) + 512) * 1024 + (Math.floor(y / C) + 512)) * 1024 + (Math.floor(z / C) + 512);
  }
  /** How far a point is out along the nearest skin vertex's normal, and that normal; null away from the head. */
  surface(p: number[]): { along: number; n: number[] } | null {
    const v = this.nearest(p);
    if (v < 0) return null;
    const s = this.body.shape, n = this.body.normals, b = v * 3;
    return { along: (p[0]! - s[b]!) * n[b]! + (p[1]! - s[b + 1]!) * n[b + 1]! + (p[2]! - s[b + 2]!) * n[b + 2]!, n: [n[b]!, n[b + 1]!, n[b + 2]!] };
  }

  private nearest(p: number[]): number {
    if (p[0]! < this.lo[0]! - 0.02 || p[0]! > this.hi[0]! + 0.02 || p[1]! < this.lo[1]! - 0.02 || p[1]! > this.hi[1]! + 0.02 || p[2]! < this.lo[2]! - 0.02 || p[2]! > this.hi[2]! + 0.02) return -1;
    const C = HeadSolid.C, s = this.body.shape;
    const cx = Math.floor(p[0]! / C), cy = Math.floor(p[1]! / C), cz = Math.floor(p[2]! / C);
    let best = -1, bd = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = this.cells.get(((cx + dx + 512) * 1024 + (cy + dy + 512)) * 1024 + (cz + dz + 512));
      if (!list) continue;
      for (const v of list) {
        const d = (s[v * 3]! - p[0]!) ** 2 + (s[v * 3 + 1]! - p[1]!) ** 2 + (s[v * 3 + 2]! - p[2]!) ** 2;
        if (d < bd) { bd = d; best = v; }
      }
    }
    return best;
  }

  push(p: number[], margin: number): void {
    if (p[0]! < this.lo[0]! - 0.02 || p[0]! > this.hi[0]! + 0.02 || p[1]! < this.lo[1]! - 0.02 || p[1]! > this.hi[1]! + 0.02 || p[2]! < this.lo[2]! - 0.02 || p[2]! > this.hi[2]! + 0.02) return;
    const C = HeadSolid.C, s = this.body.shape, n = this.body.normals;
    const cx = Math.floor(p[0]! / C), cy = Math.floor(p[1]! / C), cz = Math.floor(p[2]! / C);
    let best = -1, bd = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = this.cells.get(((cx + dx + 512) * 1024 + (cy + dy + 512)) * 1024 + (cz + dz + 512));
      if (!list) continue;
      for (const v of list) {
        const d = (s[v * 3]! - p[0]!) ** 2 + (s[v * 3 + 1]! - p[1]!) ** 2 + (s[v * 3 + 2]! - p[2]!) ** 2;
        if (d < bd) { bd = d; best = v; }
      }
    }
    if (best < 0) return;
    const b = best * 3;
    const along = (p[0]! - s[b]!) * n[b]! + (p[1]! - s[b + 1]!) * n[b + 1]! + (p[2]! - s[b + 2]!) * n[b + 2]!;
    const m = this.torso?.[best] ? Math.max(margin, this.torsoMargin) : margin;
    if (along >= m) return;
    const k = m - along;
    p[0] = p[0]! + n[b]! * k; p[1] = p[1]! + n[b + 1]! * k; p[2] = p[2]! + n[b + 2]! * k;
  }
}

/**
 * Hair, eyebrows and eyelashes as strands, generated for a morphed body.
 *
 * Hair styles are either a CharMorph groom (guide strands authored on the
 * Vitruvian, each moved by the displacement of the body vertex under its
 * root, as CharMorph fits hair) or grown here from the scalp mask (buzz,
 * crew cut, afro, long, ponytail, bun, mohawk). Around each guide grow child
 * strands, as Blender's "simple" children do: a root offset in a disc of the
 * groom's radius, pulled back to the guide towards the tip by its clump
 * factor, plus roughness. Then the player's settings: length (a trim below 1,
 * a longer fall above), volume (pushed out from the head), curl (a helix
 * round the strand), frizz, and the head as a solid (strands kept outside an
 * ellipsoid fitted to the skull). The point budget keeps any style drawable.
 *
 * Pure: no three.js. Positions in the body's unscaled frame.
 */

export interface HairParams {
  readonly style: string;
  readonly colour: number;
  /** Tip colour for an ombre; equal to `colour` for none. */
  readonly tipColour: number;
  /** 0..1 share of grey strands. */
  readonly grey: number;
  /** 0.3 .. 1.8 of the style's length. */
  readonly length: number;
  readonly volume: number;
  readonly curl: number;
  /** 0 tight .. 1 loose curls. */
  readonly curlSize: number;
  readonly frizz: number;
  /** 0.3 .. 1.6: how many strands. */
  readonly density: number;
  /** 0.5 .. 2: strand width. */
  readonly thickness: number;
}

export interface BrowParams { readonly style: string; readonly colour: number; readonly thickness: number; readonly density: number; readonly length: number }
export interface LashParams { readonly length: number; readonly curl: number; readonly density: number; readonly colour: number }

/** Strands to draw, with what the shader needs per strand. */
export interface StrandSet extends Strands {
  /** Per strand: a random 0..1 (colour variation), and 1 for a grey strand. */
  readonly seeds: Float32Array;
  readonly grey: Uint8Array;
  readonly rootWidth: number;
  readonly tipWidth: number;
  /** Per strand, a scale on the widths (thinner at the hairline); 1 if absent. */
  readonly widths?: Float32Array;
  /**
   * Where each strand leaves the skin, for the scalp's follicle map (Unreal's
   * groom "follicle mask"): the first index of its triangle in the base's
   * render index, and its barycentric (u, v) there.
   */
  readonly follicles?: { readonly tris: Uint32Array; readonly bary: Float32Array };
}

export const GROOM_STYLES = ['Bob', 'Eve', 'Back1', 'SlickedBack', 'Combover_zoro_d', 'SceneHair_1_O4saken'] as const;
export const GROWN_STYLES = ['buzz', 'crew', 'mohawk', 'afro', 'long', 'ponytail', 'bun'] as const;
export const HAIR_STYLES: readonly string[] = ['none', ...GROWN_STYLES, ...GROOM_STYLES];

/** Natural hair colours, dark to light, then dyed. */
export const HAIR_COLOURS: readonly number[] = [
  0x0e0b0a, 0x24180f, 0x3b2615, 0x5a3a1f, 0x7a5230, 0x9a7048, 0xc4a06a, 0xe0c890, 0x8a3b1b, 0xb25a2a, 0x9c9c9c, 0xe6e2da,
  0x1f3a7a, 0x6a1f7a, 0xc0306a, 0x2f7a4a,
];

const ENV: { points: number } = { points: 900_000 };

/** The skull as an ellipsoid (centre, radii), fitted to the head region's skin above the eyes. */
export interface Skull { cx: number; cy: number; cz: number; rx: number; ry: number; rz: number }

export function skullOf(ex: HumanExtras, shape: Float32Array): Skull {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let v = 0; v < ex.scalp.length; v++) {
    if (ex.scalp[v]! < 40) continue;
    const x = shape[v * 3]!, y = shape[v * 3 + 1]!, z = shape[v * 3 + 2]!;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const rx = (maxX - minX) / 2, rz = (maxZ - minZ) / 2;
  // The scalp is a cap: its lowest point is near the skull's equator.
  const ry = (maxY - minY) * 0.95;
  return { cx: (minX + maxX) / 2, cy: maxY - ry, cz: (minZ + maxZ) / 2, rx: rx * 1.02, ry: ry * 1.02, rz: rz * 1.02 };
}

const POINT_BIND = new WeakMap<object, { vert: Uint32Array; weight: Float32Array }>();

/**
 * For each groom point, the nearest head vertex of the rest body and how
 * much it follows it (fully on the skin, fading over 4 cm: a long strand's
 * end follows its root instead).
 */
function pointBinding(key: object, strands: Strands, base: HumanBase, candidates: Uint32Array): { vert: Uint32Array; weight: Float32Array } {
  const cached = POINT_BIND.get(key);
  if (cached) return cached;
  const C = 0.015, rest = base.positions, cells = new Map<number, number[]>();
  const k = (x: number, y: number, z: number): number => ((Math.floor(x / C) + 512) * 1024 + (Math.floor(y / C) + 512)) * 1024 + (Math.floor(z / C) + 512);
  for (const v of candidates) {
    const key2 = k(rest[v * 3]!, rest[v * 3 + 1]!, rest[v * 3 + 2]!);
    let list = cells.get(key2);
    if (!list) cells.set(key2, list = []);
    list.push(v);
  }
  const n = strands.points.length / 3;
  const vert = new Uint32Array(n), weight = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = strands.points[i * 3]!, y = strands.points[i * 3 + 1]!, z = strands.points[i * 3 + 2]!;
    const cx = Math.floor(x / C), cy = Math.floor(y / C), cz = Math.floor(z / C);
    let best = -1, bd = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = cells.get(((cx + dx + 512) * 1024 + (cy + dy + 512)) * 1024 + (cz + dz + 512));
      if (!list) continue;
      for (const v of list) {
        const d = (rest[v * 3]! - x) ** 2 + (rest[v * 3 + 1]! - y) ** 2 + (rest[v * 3 + 2]! - z) ** 2;
        if (d < bd) { bd = d; best = v; }
      }
    }
    vert[i] = Math.max(0, best);
    weight[i] = best < 0 ? 0 : Math.exp(-Math.sqrt(bd) / 0.04);
  }
  const out = { vert, weight };
  POINT_BIND.set(key, out);
  return out;
}

const ROOT_BIND = new WeakMap<object, Uint32Array>();

/** For each strand root, the nearest skin vertex of the rest body (cached per strand set). */
function rootBinding(key: object, strands: Strands, base: HumanBase, candidates: Uint32Array): Uint32Array {
  const cached = ROOT_BIND.get(key);
  if (cached) return cached;
  const out = new Uint32Array(strands.counts.length);
  const rest = base.positions;
  let at = 0;
  for (let s = 0; s < strands.counts.length; s++) {
    const x = strands.points[at * 3]!, y = strands.points[at * 3 + 1]!, z = strands.points[at * 3 + 2]!;
    let best = 0, bd = Infinity;
    for (const v of candidates) {
      const d = (rest[v * 3]! - x) ** 2 + (rest[v * 3 + 1]! - y) ** 2 + (rest[v * 3 + 2]! - z) ** 2;
      if (d < bd) { bd = d; best = v; }
    }
    out[s] = best;
    at += strands.counts[s]!;
  }
  ROOT_BIND.set(key, out);
  return out;
}

const VERT_SETS = new WeakMap<HumanExtras, { head: Uint32Array; scalp: Uint32Array; upper: Uint32Array; torso: Uint8Array }>();
/** Root candidates: the scalp's vertices for hair, the head's for brows. */
function vertSets(ex: HumanExtras): { head: Uint32Array; scalp: Uint32Array; upper: Uint32Array; torso: Uint8Array } {
  let v = VERT_SETS.get(ex);
  if (!v) {
    const head: number[] = [], scalp: number[] = [], upper: number[] = [];
    const torso = new Uint8Array(ex.region.length);
    const body = new Set<number>([REGION.neck, REGION.chest, REGION.abdomen, REGION.upperarm]);
    for (let i = 0; i < ex.region.length; i++) {
      if (ex.region[i] === REGION.head) { head.push(i); upper.push(i); }
      if (body.has(ex.region[i]!)) { upper.push(i); torso[i] = 1; }
      if (ex.scalp[i]! > 0) scalp.push(i);
    }
    v = { head: Uint32Array.from(head), scalp: Uint32Array.from(scalp), upper: Uint32Array.from(upper), torso };
    VERT_SETS.set(ex, v);
  }
  return v;
}

/** A guide strand as an array of points. */
type Guide = number[][];

function groomGuides(ex: HumanExtras, base: HumanBase, shape: Float32Array, id: string, brows = false): Guide[] {
  const g = brows ? ex.brows.get(id) : ex.grooms.get(id);
  if (!g) return [];
  const sets = vertSets(ex);
  const bind = rootBinding(g, g, base, brows ? sets.head : sets.scalp);
  const pts = pointBinding(g, g, base, sets.head);
  const rest = base.positions;
  const out: Guide[] = [];
  let at = 0;
  for (let s = 0; s < g.counts.length; s++) {
    const v = bind[s]! * 3;
    const dx = shape[v]! - rest[v]!, dy = shape[v + 1]! - rest[v + 1]!, dz = shape[v + 2]! - rest[v + 2]!;
    const guide: Guide = [];
    for (let i = 0; i < g.counts[s]!; i++) {
      const q = (at + i) * 3;
      // Each point follows the skin under it, a far point its root.
      const w = pts.weight[at + i]!, u = pts.vert[at + i]! * 3;
      const ox = w * (shape[u]! - rest[u]!) + (1 - w) * dx, oy = w * (shape[u + 1]! - rest[u + 1]!) + (1 - w) * dy, oz = w * (shape[u + 2]! - rest[u + 2]!) + (1 - w) * dz;
      guide.push([g.points[q]! + ox, g.points[q + 1]! + oy, g.points[q + 2]! + oz]);
    }
    at += g.counts[s]!;
    out.push(guide);
  }
  return out;
}

const norm = (v: number[]): number[] => { const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1; return [v[0]! / l, v[1]! / l, v[2]! / l]; };

/** Guides grown from the scalp for the generated styles, combed over the head's real skin. */
function grownGuides(ex: HumanExtras, shape: Float32Array, style: string, skull: Skull, solid: HeadSolid, rng: Rng): { guides: Guide[]; children: number; radius: number; clump: number } {
  const roots: number[][] = [];
  for (let v = 0; v < ex.scalp.length; v++) {
    const m = ex.scalp[v]! / 255;
    if (m < 0.2 || !rng.bool(Math.min(1, m * 0.9))) continue;
    const p = [shape[v * 3]!, shape[v * 3 + 1]!, shape[v * 3 + 2]!];
    if (style === 'mohawk' && Math.abs(p[0]! - skull.cx) > 0.022) continue;
    roots.push(p);
  }
  const radial = (p: number[]): number[] => norm([(p[0]! - skull.cx) / skull.rx ** 2, (p[1]! - skull.cy) / skull.ry ** 2, (p[2]! - skull.cz) / skull.rz ** 2]);
  // Below this height a strand leaves the skull and hangs.
  const earY = skull.cy + skull.ry * 0.05;
  const guides: Guide[] = [];
  const back = [skull.cx, skull.cy + skull.ry * 0.3, skull.cz - skull.rz * 1.05];
  const bunAt = [skull.cx, skull.cy + skull.ry * 0.7, skull.cz - skull.rz * 0.9];
  /**
   * Walks a strand over the skin as a comb would lay it: each step goes the
   * way `want` asks, turned into the skin's tangent plane, then is kept
   * `lift` off the skin (pushed out, and drawn back if it drifted away).
   */
  const walk = (start: number[], steps: number, step: number, want: (p: number[], i: number) => number[], lift: number, stop?: (p: number[]) => boolean, hug = false): Guide => {
    const g: Guide = [start];
    let p = start;
    for (let i = 1; i <= steps; i++) {
      const s = solid.surface(p);
      let d = want(p, i);
      if (s && (hug || p[1]! > earY)) {
        const k = d[0]! * s.n[0]! + d[1]! * s.n[1]! + d[2]! * s.n[2]!;
        d = norm([d[0]! - s.n[0]! * k, d[1]! - s.n[1]! * k, d[2]! - s.n[2]! * k]);
      }
      p = [p[0]! + d[0]! * step, p[1]! + d[1]! * step, p[2]! + d[2]! * step];
      const after = solid.surface(p);
      if (after && (hug || p[1]! > earY) && after.along > lift + 0.002) {
        const back2 = Math.min(after.along - lift, 0.004);
        p = [p[0]! - after.n[0]! * back2, p[1]! - after.n[1]! * back2, p[2]! - after.n[2]! * back2];
      }
      solid.push(p, lift);
      g.push(p);
      if (stop?.(p)) break;
    }
    return g;
  };
  for (const r of roots) {
    const n = radial(r);
    const front = (r[2]! - skull.cz) / skull.rz;
    // The parting runs front to back over the middle; each side combs its own way.
    const side = Math.abs(r[0]! - skull.cx) < 0.003 ? (rng.bool() ? 1 : -1) : Math.sign(r[0]! - skull.cx);
    let g: Guide;
    if (style === 'buzz') {
      g = [r, [r[0]! + n[0]! * 0.004, r[1]! + n[1]! * 0.004, r[2]! + n[2]! * 0.004]];
    } else if (style === 'mohawk') {
      g = [r];
      for (let i = 1; i <= 6; i++) g.push([r[0]! + n[0]! * 0.015 * i * 0.3, r[1]! + 0.015 * i, r[2]! + n[2]! * 0.015 * i * 0.3 - 0.002 * i]);
    } else if (style === 'crew') {
      const len = 0.035 + 0.02 * Math.max(0, front);
      g = walk(r, 6, len / 6, () => norm([side * 0.15, 0.1, -1]), 0.003);
    } else if (style === 'afro') {
      // Out from the scalp until the round outline of the hair (the skull
      // grown by 7-9 cm, a little higher): longer on top, shorter low on the sides.
      const ex2 = skull.rx + 0.08, ey = skull.ry + 0.075, ez = skull.rz + 0.085, cy = skull.cy + 0.012;
      g = [r];
      let q = r;
      const d = norm([n[0]!, n[1]! + 0.25, n[2]!]);
      for (let i = 1; i <= 14; i++) {
        q = [q[0]! + d[0]! * 0.009, q[1]! + d[1]! * 0.009, q[2]! + d[2]! * 0.009];
        g.push(q);
        if (((q[0]! - skull.cx) / ex2) ** 2 + ((q[1]! - cy) / ey) ** 2 + ((q[2]! - skull.cz) / ez) ** 2 > 1) break;
      }
    } else if (style === 'long') {
      const len = 0.42 + rng.range(-0.02, 0.02);
      g = walk(r, 22, len / 22, (p) => {
        // Over the head: down and away from the parting, the front swept
        // further aside so it frames the face; below the ears: falling,
        // never in front of the face.
        const f = Math.max(0, (p[2]! - skull.cz) / skull.rz);
        if (p[1]! > earY) return norm([side * (0.35 + 0.9 * f), -1, -0.25 - 0.3 * f]);
        const inFront = p[2]! > skull.cz + skull.rz * 0.35 && Math.abs(p[0]! - skull.cx) < skull.rx * 1.05;
        return norm([inFront ? side * 0.8 : side * 0.05, -1, inFront ? -0.4 : -0.08]);
      }, 0.004);
    } else {
      const tie = style === 'bun' ? bunAt : back;
      g = walk(r, 24, 0.012, (p) => norm([tie[0]! - p[0]!, tie[1]! - p[1]!, tie[2]! - p[2]!]), 0.003,
        (p) => Math.hypot(p[0]! - tie[0]!, p[1]! - tie[1]!, p[2]! - tie[2]!) < 0.012,
        // Pulled tight to the tie: hair below the ears hugs the head too
        // (left to hang, the sideburns fell straight down before the ears).
        true);
      if (style === 'ponytail') {
        const sx = rng.range(-1, 1) * 0.012, sz = rng.range(-1, 1) * 0.012;
        for (let i = 1; i <= 10; i++) g.push([tie[0]! + sx * Math.sqrt(i), tie[1]! - 0.026 * i, tie[2]! - 0.015 - 0.004 * i + sz * Math.sqrt(i)]);
      } else {
        const phase = rng.range(0, Math.PI * 2), rad = rng.range(0.015, 0.03);
        for (let i = 1; i <= 10; i++) {
          const a = phase + i * 0.6;
          g.push([tie[0]! + Math.cos(a) * rad, tie[1]! + Math.sin(a) * rad * 0.8, tie[2]! - 0.025 - 0.01 * Math.sin(a * 0.5)]);
        }
      }
    }
    if (g.length >= 2) guides.push(g);
  }
  const children = style === 'buzz' ? 6 : style === 'afro' ? 10 : 8;
  return { guides, children, radius: style === 'buzz' ? 0.003 : 0.006, clump: style === 'ponytail' || style === 'bun' ? 0.6 : 0.2 };
}

/** Points at arc fractions of a polyline (for trims and resampling). */
function trim(g: Guide, keep: number): Guide {
  if (keep >= 1 || g.length < 2) return g;
  const lens = [0];
  for (let i = 1; i < g.length; i++) lens.push(lens[i - 1]! + Math.hypot(g[i]![0]! - g[i - 1]![0]!, g[i]![1]! - g[i - 1]![1]!, g[i]![2]! - g[i - 1]![2]!));
  const target = lens[lens.length - 1]! * keep;
  const out: Guide = [g[0]!];
  for (let i = 1; i < g.length; i++) {
    if (lens[i]! <= target) { out.push(g[i]!); continue; }
    const t = (target - lens[i - 1]!) / (lens[i]! - lens[i - 1]! || 1);
    out.push([g[i - 1]![0]! + (g[i]![0]! - g[i - 1]![0]!) * t, g[i - 1]![1]! + (g[i]![1]! - g[i - 1]![1]!) * t, g[i - 1]![2]! + (g[i]![2]! - g[i - 1]![2]!) * t]);
    break;
  }
  return out.length >= 2 ? out : [g[0]!, g[1]!];
}

/** Longer than styled: the segments after the first fifth stretch, and fall a little more. */
function extend(g: Guide, k: number): Guide {
  if (k <= 1) return g;
  const out: Guide = [g[0]!];
  const fixed = Math.max(1, Math.round(g.length * 0.2));
  for (let i = 1; i < g.length; i++) {
    const s = i <= fixed ? 1 : k;
    const prev = out[i - 1]!;
    out.push([prev[0]! + (g[i]![0]! - g[i - 1]![0]!) * s, prev[1]! + (g[i]![1]! - g[i - 1]![1]!) * s - (s - 1) * 0.004, prev[2]! + (g[i]![2]! - g[i - 1]![2]!) * s]);
  }
  return out;
}

/** A polyline resampled to `n` points evenly along its length. */
function resample(g: Guide, n: number): Guide {
  const lens = [0];
  for (let i = 1; i < g.length; i++) lens.push(lens[i - 1]! + Math.hypot(g[i]![0]! - g[i - 1]![0]!, g[i]![1]! - g[i - 1]![1]!, g[i]![2]! - g[i - 1]![2]!));
  const total = lens[lens.length - 1]! || 1e-6;
  const out: Guide = [];
  let j = 1;
  for (let k = 0; k < n; k++) {
    const target = (k / (n - 1)) * total;
    while (j < g.length - 1 && lens[j]! < target) j++;
    const t = Math.min(1, Math.max(0, (target - lens[j - 1]!) / (lens[j]! - lens[j - 1]! || 1)));
    const a = g[j - 1]!, b = g[j]!;
    out.push([a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, a[2]! + (b[2]! - a[2]!) * t]);
  }
  return out;
}

/**
 * Guide roots in a grid of 1 cm cells. The nearest `k` within `reach` are
 * found ring by ring outwards, stopping once no closer guide can lie in an
 * unsearched ring (the k-nearest search of a uniform grid).
 */
class GuideIndex {
  private readonly cells = new Map<number, number[]>();
  private static readonly C = 0.01;
  constructor(private readonly roots: readonly number[][], private readonly reach: number) {
    roots.forEach((r, i) => {
      const k = GuideIndex.key(Math.floor(r[0]! / GuideIndex.C), Math.floor(r[1]! / GuideIndex.C), Math.floor(r[2]! / GuideIndex.C));
      let list = this.cells.get(k);
      if (!list) this.cells.set(k, list = []);
      list.push(i);
    });
  }
  private static key(x: number, y: number, z: number): number {
    return ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
  }
  /** Up to `k` guides within reach, nearest first: [guide, distance]. */
  nearest(p: readonly number[], k: number): [number, number][] {
    const C = GuideIndex.C;
    const cx = Math.floor(p[0]! / C), cy = Math.floor(p[1]! / C), cz = Math.floor(p[2]! / C);
    const best: [number, number][] = [];
    const rings = Math.ceil(this.reach / C);
    for (let r = 0; r <= rings; r++) {
      // Everything in ring r is at least (r - 1) cells away.
      if (best.length === k && best[k - 1]![1] < (r - 1) * C) break;
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
        const list = this.cells.get(GuideIndex.key(cx + dx, cy + dy, cz + dz));
        if (!list) continue;
        for (const i of list) {
          const q = this.roots[i]!;
          const d = Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!);
          if (d >= this.reach || (best.length === k && d >= best[k - 1]![1])) continue;
          let at = best.length < k ? best.length : k - 1;
          best[at] = [i, d];
          while (at > 0 && best[at - 1]![1] > d) { [best[at - 1], best[at]] = [best[at]!, best[at - 1]!]; at--; }
        }
      }
    }
    return best;
  }
}

/**
 * `count` root points spread over the scalp by area, thinning where the
 * scalp mask fades (a soft hairline), each on a skin triangle of the
 * morphed body.
 */
/** A root: where, on which skin triangle, and how far inside the hairline (0 at its edge, 1 well inside). */
interface Root { readonly p: number[]; readonly tri: number; readonly u: number; readonly v: number; readonly inside: number }

/** Per skin triangle of `bodyFor` (in its order), where it starts in the base's render index. */
const SKIN_INDEX = new WeakMap<HumanBase, Uint32Array>();
function skinIndex(base: HumanBase): Uint32Array {
  let out = SKIN_INDEX.get(base);
  if (!out) {
    const list: number[] = [];
    for (const g of base.meta.groups) {
      if (g.material !== 'Skin' && g.material !== 'Covered') continue;
      for (let i = g.start; i < g.start + g.count; i += 3) list.push(i);
    }
    SKIN_INDEX.set(base, out = Uint32Array.from(list));
  }
  return out;
}

function scalpRoots(ex: HumanExtras, body: ShapedBody, count: number, rng: Rng): Root[] {
  const s = body.shape, tri = body.skin;
  const picks: number[] = [], cum: number[] = [];
  let total = 0;
  for (let i = 0; i < tri.length; i += 3) {
    const a = tri[i]!, b = tri[i + 1]!, c = tri[i + 2]!;
    const m = (ex.scalp[a]! + ex.scalp[b]! + ex.scalp[c]!) / 765;
    if (m < 0.12) continue;
    const ux = s[b * 3]! - s[a * 3]!, uy = s[b * 3 + 1]! - s[a * 3 + 1]!, uz = s[b * 3 + 2]! - s[a * 3 + 2]!;
    const vx = s[c * 3]! - s[a * 3]!, vy = s[c * 3 + 1]! - s[a * 3 + 1]!, vz = s[c * 3 + 2]! - s[a * 3 + 2]!;
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    total += area * Math.min(1, (m - 0.12) / 0.45);
    picks.push(i); cum.push(total);
  }
  const out: Root[] = [];
  if (!picks.length) return out;
  for (let k = 0; k < count; k++) {
    const r = rng.float() * total;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid]! < r) lo = mid + 1; else hi = mid; }
    const i = picks[lo]!;
    let u = rng.float(), v = rng.float();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const a = tri[i]! * 3, b = tri[i + 1]! * 3, c = tri[i + 2]! * 3;
    const ma = ex.scalp[tri[i]!]!, mb = ex.scalp[tri[i + 1]!]!, mc = ex.scalp[tri[i + 2]!]!;
    const m = (ma + (mb - ma) * u + (mc - ma) * v) / 255;
    const inside = Math.min(1, Math.max(0, (m - 0.12) / 0.5));
    out.push({ p: [0, 1, 2].map((d) => s[a + d]! + (s[b + d]! - s[a + d]!) * u + (s[c + d]! - s[a + d]!) * v), tri: i / 3, u, v, inside });
  }
  return out;
}

/**
 * The hair for a person: guides, children and the player's settings, within
 * a point budget.
 */
export function hairStrands(ex: HumanExtras, base: HumanBase, body: ShapedBody, p: HairParams, seed: number): StrandSet {
  const shape = body.shape;
  const rng = new Rng(seed);
  const skull = skullOf(ex, shape);
  const sets = vertSets(ex);
  // The torso kept 2 cm off: clothes stand off the skin, and hair lies on them.
  const solid = new HeadSolid(body, sets.upper, sets.torso, 0.02);
  let guides: Guide[], children: number, radius: number, clump: number, roughness = 0.003;
  if (p.style === 'none') return empty();
  const info = ex.grooms.get(p.style);
  if (info) {
    guides = groomGuides(ex, base, shape, p.style);
    children = info.children; radius = info.radius; clump = info.clump; roughness = info.roughness * 0.06;
  } else {
    ({ guides, children, radius, clump } = grownGuides(ex, shape, p.style, skull, solid, rng));
  }
  guides = guides.map((g) => extend(trim(g, Math.min(1, p.length)), Math.max(1, p.length)));
  // An afro is coils: tight curls whatever the slider's floor.
  if (p.style === 'afro') p = { ...p, curl: Math.max(p.curl, 0.85), curlSize: Math.min(p.curlSize, 0.2), frizz: Math.max(p.frizz, 0.3) };
  // Interpolated children (Blender's "interpolated" children, Houdini's
  // guide interpolation): roots spread evenly over the scalp, each strand
  // shaped by the guides nearest its root. Children placed round each guide
  // instead (as before) left the scalp bare between guides: 42% of a bob's
  // scalp lay more than 5 mm from any root.
  // Points per strand by its length, as Frostbite's (short hair 5 a strand,
  // long 24): a segment every 1.5 cm, or a fifth of a curl's turn.
  const lengths = guides.filter((g) => g.length >= 2).map((g) => g.slice(1).reduce((s, q, i) => s + Math.hypot(q[0]! - g[i]![0]!, q[1]! - g[i]![1]!, q[2]! - g[i]![2]!), 0)).sort((a, b) => a - b);
  const typical = lengths[Math.floor(lengths.length / 2)] ?? 0.05;
  const seg = p.curl > 0.15 ? Math.min(0.015, (0.012 + 0.04 * p.curlSize) / 5) : 0.015;
  const N = p.style === 'buzz' ? 2 : Math.max(5, Math.min(24, Math.ceil(typical / seg) + 1));
  // A groom denser than 3000 guides (the side part has 30,000) is thinned
  // evenly: interpolation fills between them anyway.
  const stride = Math.max(1, Math.ceil(guides.length / 3000));
  const shaped = guides.filter((g, i) => g.length >= 2 && i % stride === 0).map((g) => resample(g, N));
  if (!shaped.length) return empty();
  const budget = ENV.points * Math.max(0.3, Math.min(1.6, p.density));
  const roots = scalpRoots(ex, body, Math.min(60_000, Math.floor(budget / N)), rng);
  // Within 3 cm of a guide: between the sparsest guides (a bob's, 4 cm apart)
  // but not past the groom's own hairline, where a far guide's fall would
  // hang strands over the forehead.
  const near = new GuideIndex(shaped.map((g) => g[0]!), 0.03);

  const counts: number[] = [], pts: number[] = [], seeds: number[] = [], grey: number[] = [];
  const folTris: number[] = [], folBary: number[] = [], widths: number[] = [];
  const toIndex = skinIndex(base);
  for (const r of roots) {
    const root = r.p;
    let found = near.nearest(root, 4);
    if (!found.length) continue;
    // Only guides heading the way the nearest one heads: mixing a guide
    // combed left with one combed right (at a parting) averages to a strand
    // hanging straight down over the face.
    // A few strands by a parting follow a guide from the other side and
    // cross it, as real hair does (away from a parting every guide near a
    // root heads the same way, so this changes nothing there).
    const lead = shaped[found[found.length > 1 && rng.bool(0.12) ? 1 + Math.floor(rng.float() * (found.length - 1)) : 0]![0]]!;
    const dir = (G: Guide): number[] => norm([G[N - 1]![0]! - G[0]![0]!, G[N - 1]![1]! - G[0]![1]!, G[N - 1]![2]! - G[0]![2]!]);
    const d0 = dir(lead);
    found = found.filter(([j]) => { const d = dir(shaped[j]!); return d[0]! * d0[0]! + d[1]! * d0[1]! + d[2]! * d0[2]! > 0.85; }).slice(0, 3);
    // Hairline strands are shorter and finer (a groom's density, length and
    // width painted down towards the hairline's edge).
    const keep = 0.5 + 0.5 * r.inside;
    let wsum = 0;
    const ws = found.map(([, d]) => { const w = 1 / (d * d + 1e-6); wsum += w; return w; });
    const g: number[][] = [];
    const closest = shaped[found[0]![0]]!;
    for (let i = 0; i < N; i++) {
      let x = root[0]!, y = root[1]!, z = root[2]!;
      found.forEach(([j], k) => {
        const G = shaped[j]!, w = ws[k]! / wsum;
        x += w * (G[i]![0]! - G[0]![0]!); y += w * (G[i]![1]! - G[0]![1]!); z += w * (G[i]![2]! - G[0]![2]!);
      });
      // Clumping: towards the nearest guide's own path, more at the tip.
      const c = clump * (i / (N - 1));
      const px = x + (closest[i]![0]! - x) * c, py = y + (closest[i]![1]! - y) * c, pz = z + (closest[i]![2]! - z) * c;
      g.push([root[0]! + (px - root[0]!) * keep, root[1]! + (py - root[1]!) * keep, root[2]! + (pz - root[2]!) * keep]);
    }
    const phase = rng.range(0, Math.PI * 2), sd = rng.float();
    // Roughness and frizz as smooth waves along the strand (as Blender's
    // child roughness is), each strand its own directions and phases:
    // noise per point would draw every strand as a zigzag of specks.
    const w1 = [rng.normal(0, 1), rng.normal(0, 1), rng.normal(0, 1)], w2 = [rng.normal(0, 1), rng.normal(0, 1), rng.normal(0, 1)];
    const f1 = rng.range(0.8, 2.2), f2 = rng.range(5, 9), p1 = rng.range(0, 6.28), p2 = rng.range(0, 6.28);
    let arc = 0;
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const q = g[i]!;
      if (i > 0) arc += Math.hypot(q[0]! - g[i - 1]![0]!, q[1]! - g[i - 1]![1]!, q[2]! - g[i - 1]![2]!);
      const point = [q[0]!, q[1]!, q[2]!];
      if (t > 0) {
        // Volume: out from the skull's centre, growing to the tip.
        const out = norm([point[0]! - skull.cx, point[1]! - skull.cy, point[2]! - skull.cz]);
        const vol = p.volume * 0.035 * Math.pow(t, 0.7);
        const slow = Math.sin(p1 + f1 * Math.PI * 2 * t) * (roughness * 0.6 + 0.002 * t);
        const fast = Math.sin(p2 + f2 * Math.PI * 2 * t) * p.frizz * 0.006 * t * t;
        point[0] = point[0]! + out[0]! * vol + w1[0]! * slow + w2[0]! * fast;
        point[1] = point[1]! + out[1]! * vol * 0.6 + w1[1]! * slow + w2[1]! * fast;
        point[2] = point[2]! + out[2]! * vol + w1[2]! * slow + w2[2]! * fast;
        if (p.curl > 0) {
          const prev = g[i - 1]!;
          const tan = norm([q[0]! - prev[0]!, q[1]! - prev[1]!, q[2]! - prev[2]!]);
          const ca = norm(Math.abs(tan[1]!) < 0.9 ? [tan[2]!, 0, -tan[0]!] : [0, -tan[2]!, tan[1]!]);
          const cb = [tan[1]! * ca[2]! - tan[2]! * ca[1]!, tan[2]! * ca[0]! - tan[0]! * ca[2]!, tan[0]! * ca[1]! - tan[1]! * ca[0]!];
          const period = 0.012 + 0.04 * p.curlSize, amp = p.curl * (0.003 + 0.01 * p.curlSize) * Math.min(1, t * 5);
          const phi = phase + (arc / period) * Math.PI * 2;
          point[0] = point[0]! + (ca[0]! * Math.cos(phi) + cb[0]! * Math.sin(phi)) * amp;
          point[1] = point[1]! + (ca[1]! * Math.cos(phi) + cb[1]! * Math.sin(phi)) * amp;
          point[2] = point[2]! + (ca[2]! * Math.cos(phi) + cb[2]! * Math.sin(phi)) * amp;
        }
      }
      // The skin is solid: every point at least 2 mm out of it, the root on it.
      solid.push(point, i > 0 ? 0.002 : 0.0003);
      pts.push(point[0]!, point[1]!, point[2]!);
    }
    counts.push(N);
    widths.push(0.3 + 0.7 * r.inside);
    folTris.push(toIndex[r.tri]!); folBary.push(r.u, r.v);
    seeds.push(sd);
    grey.push(rng.bool(p.grey) ? 1 : 0);
  }
  void children; void radius;
  // A few times a real hair (0.07 mm): up to 60,000 strands stand for a
  // head's hundred thousand. Much wider reads as straw (Frostbite, 2019).
  const w = 0.00025 * p.thickness;
  return { counts: Uint16Array.from(counts), points: Float32Array.from(pts), seeds: Float32Array.from(seeds), grey: Uint8Array.from(grey), rootWidth: w, tipWidth: w * 0.3,
    widths: Float32Array.from(widths), follicles: { tris: Uint32Array.from(folTris), bary: Float32Array.from(folBary) },
  };
}

function empty(): StrandSet {
  return { counts: new Uint16Array(), points: new Float32Array(), seeds: new Float32Array(), grey: new Uint8Array(), rootWidth: 0, tipWidth: 0 };
}

/** Eyebrows: a CharMorph brow groom, thinned, trimmed and moved with the face. */
export function browStrands(ex: HumanExtras, base: HumanBase, shape: Float32Array, p: BrowParams, seed: number): StrandSet {
  if (p.style === 'none' || !ex.brows.has(p.style)) return empty();
  const rng = new Rng(seed);
  const guides = groomGuides(ex, base, shape, p.style, true);
  const counts: number[] = [], pts: number[] = [], seeds: number[] = [];
  for (const g0 of guides) {
    if (!rng.bool(Math.min(1, p.density))) continue;
    const g = extend(trim(g0, Math.min(1, p.length)), Math.max(1, p.length));
    for (const q of g) pts.push(q[0]!, q[1]!, q[2]!);
    counts.push(g.length);
    seeds.push(rng.float());
  }
  const w = 0.00012 * p.thickness;
  return { counts: Uint16Array.from(counts), points: Float32Array.from(pts), seeds: Float32Array.from(seeds), grey: new Uint8Array(counts.length), rootWidth: w, tipWidth: w * 0.35 };
}

/**
 * Eyelashes along both lid margins of each eye (the tear line's front edge):
 * longest at the middle and outer lid, curling up (upper) or down (lower).
 */
export function lashStrands(ex: HumanExtras, base: HumanBase, shape: Float32Array, p: LashParams, seed: number): StrandSet {
  const rng = new Rng(seed);
  const counts: number[] = [], pts: number[] = [], seeds: number[] = [];
  for (const side of ['L', 'R'] as const) {
    const rims = ex.meta.lashes[side];
    // The eye's centre: the rim's centre, pushed back by an eyeball radius.
    let cx = 0, cy = 0, cz = 0, n = 0;
    for (const v of [...rims.upper, ...rims.lower]) { cx += shape[v * 3]!; cy += shape[v * 3 + 1]!; cz += shape[v * 3 + 2]!; n++; }
    cx /= n; cy /= n; cz = cz / n - 0.011;
    for (const [run, up] of [[rims.upper, 1], [rims.lower, -1]] as const) {
      if (run.length < 2) continue;
      const line = run.map((v) => [shape[v * 3]!, shape[v * 3 + 1]!, shape[v * 3 + 2]!]);
      // About 100-150 upper lashes and 50-80 lower per eye.
      const total = Math.round((up > 0 ? 130 : 65) * p.density);
      for (let k = 0; k < total; k++) {
        const u = (k + rng.float()) / total;
        const f = u * (line.length - 1), i = Math.min(line.length - 2, Math.floor(f)), t = f - i;
        const a = line[i]!, b = line[i + 1]!;
        const root = [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, a[2]! + (b[2]! - a[2]!) * t];
        const out = norm([root[0]! - cx, (root[1]! - cy) * 0.6, root[2]! - cz + 0.004]);
        // Longest from the middle to the outer corner.
        const shapeLen = Math.sin(Math.PI * (0.25 + 0.75 * u));
        const len = (up > 0 ? 0.0095 : 0.0045) * p.length * (0.55 + 0.45 * shapeLen) * rng.range(0.85, 1.1);
        let dir = norm([out[0]!, out[1]! + up * 0.25, out[2]! + 0.6]);
        let q = root;
        const g: number[][] = [q];
        for (let s = 1; s <= 5; s++) {
          dir = norm([dir[0]!, dir[1]! + up * p.curl * 0.35, dir[2]! - p.curl * 0.05]);
          q = [q[0]! + dir[0]! * len / 5, q[1]! + dir[1]! * len / 5, q[2]! + dir[2]! * len / 5];
          g.push(q);
        }
        for (const x of g) pts.push(x[0]!, x[1]!, x[2]!);
        counts.push(g.length);
        seeds.push(rng.float());
      }
    }
  }
  void base;
  return { counts: Uint16Array.from(counts), points: Float32Array.from(pts), seeds: Float32Array.from(seeds), grey: new Uint8Array(counts.length), rootWidth: 0.00011, tipWidth: 0.00003 };
}
