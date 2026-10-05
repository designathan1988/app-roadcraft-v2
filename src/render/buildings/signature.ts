import {
  BoxGeometry,
  type BufferGeometry,
  CanvasTexture,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  type Material,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { signatureKind } from '@world/buildings/towerKit';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';

/**
 * Signature buildings: a building of the tower kit drawn with parts of its
 * own - its own windows, balconies, railings, cladding, planters, roof plant -
 * modelled from the reference the player gave, instead of the shared facade
 * kit every other building is drawn with (`kit.ts`, `buildingMesh.ts`).
 *
 * The building's blocks stay in its record (picking, collisions, its lot);
 * `buildingMesh.ts` leaves its closed blocks out and this module draws the
 * body, sized from those blocks, so resizing the blocks resizes the drawing.
 * Each material's parts are merged into one mesh: a building is a handful of
 * draws. Materials and textures are made once (AGENTS.md).
 *
 * Metres in the building's frame: x along the front, y back from it, z up
 * from the floor; three's frame is (x, z, -y), as everywhere in this layer.
 */

/** A material's name: the shared ones of `makeMaterials`, or a facade made by `facade`. */
type Mat = string;

let materials: Record<Mat, Material> | null = null;
/** Facade materials, by style and storey rhythm, made once each. */
const facades = new Map<string, Material>();

type FacadeKind = 'curtainBlue' | 'curtainDark' | 'curtainGreen' | 'punchedBeige' | 'punchedCream' | 'gridDark' | 'brick' | 'stoneGrid';

/**
 * A facade drawn as a picture of its bays - panes and mullions, spandrels,
 * punched windows in a wall - tiling one bay across and one storey up, so
 * floor lines meet the slabs: `base` is the height (m) the storeys start at.
 */
function facade(kind: FacadeKind, bay: number, storey: number, base: number): Mat {
  const key = `${kind}|${bay}|${storey}|${base}`;
  if (facades.has(key)) return key;
  const t = canvasTexture(256, (g, s) => {
    const glass = (top: string, bottom: string, x: number, y: number, w: number, h: number): void => {
      const grad = g.createLinearGradient(0, y, 0, y + h);
      grad.addColorStop(0, top); grad.addColorStop(1, bottom);
      g.fillStyle = grad; g.fillRect(x, y, w, h);
    };
    if (kind === 'curtainBlue' || kind === 'curtainDark' || kind === 'curtainGreen') {
      const [a, b, mull, spand] = kind === 'curtainBlue' ? ['#9fc0d6', '#5f8099', '#d5dadd', '#6c7f8c']
        : kind === 'curtainDark' ? ['#4b5a66', '#222b33', '#5a6168', '#1b2127'] : ['#8fb3ae', '#557a76', '#cfd6d3', '#5d736f'];
      glass(a, b, 0, 0, s, s);
      g.fillStyle = spand; g.fillRect(0, s * 0.82, s, s * 0.18);
      g.fillStyle = mull; g.fillRect(0, s * 0.8, s, 6); g.fillRect(0, s - 4, s, 4); g.fillRect(0, 0, 5, s); g.fillRect(s / 2 - 2, 0, 4, s * 0.8);
      g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(s * 0.1, 0, s * 0.15, s * 0.8);
    } else {
      const wall = kind === 'punchedBeige' ? '#d9c39a' : kind === 'punchedCream' ? '#e9e2d4' : kind === 'gridDark' ? '#3a3f45'
        : kind === 'brick' ? '#9a4a35' : '#d8d4cc';
      g.fillStyle = wall; g.fillRect(0, 0, s, s);
      if (kind === 'brick') {
        g.strokeStyle = 'rgba(60,25,15,.45)'; g.lineWidth = 1;
        for (let y = 0; y < s; y += 8) { g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke(); }
      }
      const wide = kind === 'gridDark' || kind === 'stoneGrid' ? 0.78 : kind === 'brick' ? 0.6 : 0.46;
      const x = s * (1 - wide) / 2, y = s * 0.2, w = s * wide, h = s * 0.58;
      g.fillStyle = kind === 'gridDark' ? '#c9ced2' : '#2b2e31'; g.fillRect(x - 5, y - 5, w + 10, h + 10);
      glass(kind === 'gridDark' ? '#6d8496' : '#7d97a8', '#34434f', x, y, w, h);
      g.fillStyle = kind === 'gridDark' ? '#c9ced2' : '#2b2e31'; g.fillRect(x + w / 2 - 2, y, 4, h);
      if (kind === 'punchedBeige' || kind === 'punchedCream') { g.fillStyle = 'rgba(255,255,255,.5)'; g.fillRect(x - 8, y + h + 5, w + 16, 6); }
    }
  }, 1 / bay, 1 / storey);
  t.offset.y = -base / storey;
  const glassy = kind.startsWith('curtain');
  facades.set(key, new MeshStandardMaterial({ map: t, roughness: glassy ? 0.15 : 0.85, metalness: glassy ? 0.45 : 0 }));
  return key;
}

function canvasTexture(size: number, paint: (g: CanvasRenderingContext2D, s: number) => void, repeatX = 1, repeatY = 1): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  paint(canvas.getContext('2d')!, size);
  const t = new CanvasTexture(canvas);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function makeMaterials(): Record<Mat, Material> {
  // Stone base: large grey slabs, thin joints (a 1.2 m x 0.6 m course).
  const stone = canvasTexture(256, (g, s) => {
    g.fillStyle = '#77736e'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(${90 + Math.random() * 40},${88 + Math.random() * 36},${84 + Math.random() * 30},.35)`; g.fillRect(Math.random() * s, Math.random() * s, 3, 3); }
    g.strokeStyle = '#4f4c49'; g.lineWidth = 3;
    for (let r = 0; r < 4; r++) {
      g.beginPath(); g.moveTo(0, r * s / 4); g.lineTo(s, r * s / 4); g.stroke();
      const off = r % 2 ? s / 4 : 0;
      for (let c = 0; c < 3; c++) { g.beginPath(); g.moveTo(off + c * s / 2, r * s / 4); g.lineTo(off + c * s / 2, (r + 1) * s / 4); g.stroke(); }
    }
  }, 1 / 2.4, 1 / 2.4);
  // Render: warm light grey, a faint trowel texture.
  const render = canvasTexture(128, (g, s) => {
    g.fillStyle = '#d9d4cb'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 900; i++) { const v = 200 + Math.random() * 30; g.fillStyle = `rgba(${v},${v - 4},${v - 10},.25)`; g.fillRect(Math.random() * s, Math.random() * s, 2, 2); }
  }, 1 / 3, 1 / 3);
  // Timber cladding: horizontal boards of a brown-orange wood, 0.15 m each.
  const wood = canvasTexture(256, (g, s) => {
    for (let r = 0; r < 16; r++) {
      const v = Math.random() * 18;
      g.fillStyle = `rgb(${150 + v},${86 + v * 0.6},${52 + v * 0.4})`;
      g.fillRect(0, r * s / 16, s, s / 16);
      g.fillStyle = 'rgba(60,30,15,.55)'; g.fillRect(0, r * s / 16, s, 2);
      for (let k = 0; k < 6; k++) { g.fillStyle = 'rgba(90,45,20,.18)'; g.fillRect(Math.random() * s, r * s / 16 + 3 + Math.random() * 8, 30 + Math.random() * 60, 1); }
    }
  }, 1 / 2.4, 1 / 2.4);
  // Vertical timber slats with dark gaps.
  const slats = canvasTexture(128, (g, s) => {
    g.fillStyle = '#2a1a10'; g.fillRect(0, 0, s, s);
    for (let c = 0; c < 8; c++) {
      const v = Math.random() * 16;
      g.fillStyle = `rgb(${140 + v},${82 + v * 0.6},${48 + v * 0.4})`;
      g.fillRect(c * s / 8 + 2, 0, s / 8 - 5, s);
    }
  }, 1 / 0.8, 1);
  // Railing: black frame, top and bottom rails, thin bars 0.11 m apart (alpha).
  const railing = canvasTexture(128, (g, s) => {
    g.clearRect(0, 0, s, s);
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, s, 9); g.fillRect(0, s - 7, s, 7); g.fillRect(0, s * 0.16, s, 3);
    for (let c = 0; c < 9; c++) g.fillRect(c * s / 9, 0, 3, s);
  }, 1, 1 / 1.05);
  const std = (p: ConstructorParameters<typeof MeshStandardMaterial>[0]): MeshStandardMaterial => new MeshStandardMaterial(p);
  return {
    stone: std({ map: stone, roughness: 0.85 }),
    render: std({ map: render, roughness: 0.92 }),
    trim: std({ color: 0xe6dfd3, roughness: 0.85 }),
    wood: std({ map: wood, roughness: 0.7 }),
    slats: std({ map: slats, roughness: 0.75 }),
    slab: std({ color: 0xece8e0, roughness: 0.8 }),
    frame: std({ color: 0x26282b, roughness: 0.45, metalness: 0.5 }),
    // Daylight glass: dark, reflective, a faint warmth from the rooms behind.
    glass: std({ color: 0x3a4550, emissive: 0x6b5236, emissiveIntensity: 0.25, roughness: 0.08, metalness: 0.7 }),
    railing: std({ color: 0x1c1d1f, alphaMap: railing, alphaTest: 0.5, transparent: false, side: DoubleSide, roughness: 0.5, metalness: 0.4 }),
    pot: std({ color: 0x4a4d51, roughness: 0.75 }),
    leaf: std({ color: 0x4d7a32, roughness: 0.9, flatShading: true }),
    leafDark: std({ color: 0x35612a, roughness: 0.9, flatShading: true }),
    metal: std({ color: 0x3b3e42, roughness: 0.45, metalness: 0.6 }),
    plant: std({ color: 0xa9a59e, roughness: 0.7 }),
    sconce: std({ color: 0xfff1d8, emissive: 0xffd49a, emissiveIntensity: 1.2 }),
    glassRail: std({ color: 0xcfe3ec, transparent: true, opacity: 0.38, roughness: 0.05, metalness: 0.2, depthWrite: false }),
    white: std({ color: 0xf2f1ec, roughness: 0.8 }),
    stoneLight: std({ color: 0xd6d1c7, roughness: 0.75 }),
    beige: std({ color: 0xd9c49c, roughness: 0.85 }),
    brickPier: std({ color: 0x8f4433, roughness: 0.9 }),
    darkPanel: std({ color: 0x2f3439, roughness: 0.6, metalness: 0.3 }),
    lightGrid: std({ color: 0xc4c9cd, roughness: 0.6 }),
    podiumGlass: std({ color: 0x40505c, emissive: 0x5a4630, emissiveIntensity: 0.3, roughness: 0.08, metalness: 0.7 }),
  };
}

/** Collects parts by material, in metres of the building's frame. */
class Parts {
  readonly byMat = new Map<Mat, BufferGeometry[]>();
  /** Draws mirrored front to back about y = mirror / 2 (the back face), or null. */
  mirror: number | null = null;
  Y(y: number): number { return this.mirror === null ? y : this.mirror - y; }

  private push(mat: Mat, g: BufferGeometry): void {
    const geo = g.index ? g.toNonIndexed() : g;
    const list = this.byMat.get(mat);
    if (list) list.push(geo);
    else this.byMat.set(mat, [geo]);
  }

  /** A box from (x0, y0, z0) to (x1, y1, z1), UVs in metres so textures tile at their real size. */
  box(mat: Mat, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
    const w = Math.abs(x1 - x0), d = Math.abs(y1 - y0), h = Math.abs(z1 - z0);
    if (w < 1e-3 || d < 1e-3 || h < 1e-3) return;
    const g = new BoxGeometry(w, h, d);
    g.translate((x0 + x1) / 2, (z0 + z1) / 2, -this.Y((y0 + y1) / 2));
    const pos = g.attributes['position']!, nor = g.attributes['normal']!, uv = g.attributes['uv']!;
    for (let i = 0; i < pos.count; i++) {
      const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i));
      const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
      if (ny > 0.5) uv.setXY(i, px, pz);
      else if (nx > 0.5) uv.setXY(i, pz, py);
      else uv.setXY(i, px, py);
    }
    this.push(mat, g);
  }

  /** A railing panel along x (or y) at height z: an alpha-cut screen of bars. */
  rail(x0: number, x1: number, y0: number, y1: number, z: number, h = 1.05): void {
    const g = new BoxGeometry(Math.max(0.02, Math.abs(x1 - x0)), h, Math.max(0.02, Math.abs(y1 - y0)));
    g.translate((x0 + x1) / 2, z + h / 2, -this.Y((y0 + y1) / 2));
    const pos = g.attributes['position']!, uv = g.attributes['uv']!, nor = g.attributes['normal']!;
    for (let i = 0; i < pos.count; i++) {
      const along = Math.abs(nor.getX(i)) > 0.5 ? -pos.getZ(i) : pos.getX(i);
      uv.setXY(i, along, pos.getY(i) - z);
    }
    this.push('railing', g);
  }

  /** A pot with a bushy plant. */
  plant(x: number, y: number, z: number, size = 1): void {
    const s = size;
    this.box('pot', x - 0.28 * s, x + 0.28 * s, y - 0.28 * s, y + 0.28 * s, z, z + 0.55 * s);
    const leaf = new IcosahedronGeometry(0.42 * s, 1);
    leaf.scale(1, 1.15, 1);
    leaf.translate(x, z + 0.55 * s + 0.38 * s, -this.Y(y));
    this.push('leaf', leaf);
    const top = new IcosahedronGeometry(0.28 * s, 0);
    top.translate(x + 0.12 * s, z + 0.55 * s + 0.78 * s, -this.Y(y) + 0.05);
    this.push('leafDark', top);
  }

  /** A clipped conical shrub (a cypress in a pot), as either side of the door. */
  cone(x: number, y: number, z: number): void {
    this.box('pot', x - 0.3, x + 0.3, y - 0.3, y + 0.3, z, z + 0.6);
    const c = new ConeGeometry(0.38, 1.6, 7);
    c.translate(x, z + 0.6 + 0.8, -this.Y(y));
    this.push('leafDark', c);
  }

  /** A shrub on the ground. */
  bush(x: number, y: number, z: number, r: number, dark = false): void {
    const g = new IcosahedronGeometry(r, 1);
    g.scale(1.2, 0.85, 1.2);
    g.translate(x, z + r * 0.7, -this.Y(y));
    this.push(dark ? 'leafDark' : 'leaf', g);
  }

  /** An upright elliptic prism (a rounded tower, a slab edge round it), UVs in metres round and up. */
  ellipse(mat: Mat, cx: number, cy: number, rx: number, ry: number, z0: number, z1: number, seg = 24): void {
    const g = new CylinderGeometry(1, 1, z1 - z0, seg, 1, false);
    g.scale(rx, 1, ry);
    g.translate(cx, (z0 + z1) / 2, -this.Y(cy));
    const pos = g.attributes['position']!, uv = g.attributes['uv']!;
    const r = (rx + ry) / 2;
    for (let i = 0; i < pos.count; i++) {
      const a = Math.atan2(-(pos.getZ(i) + this.Y(cy)), pos.getX(i) - cx);
      uv.setXY(i, (a + Math.PI) * r, pos.getY(i));
    }
    this.push(mat, g);
  }

  cylinder(mat: Mat, x: number, y: number, z0: number, z1: number, r: number): void {
    const g = new CylinderGeometry(r, r, z1 - z0, 10);
    g.translate(x, (z0 + z1) / 2, -this.Y(y));
    this.push(mat, g);
  }

  /** A window or glazed door on a face looking -y, at depth y: a dark frame round warm glass. */
  windowFront(x0: number, x1: number, y: number, z0: number, z1: number, mullions = 1): void {
    const t = 0.07;
    this.box('glass', x0 + t, x1 - t, y - 0.02, y + 0.02, z0 + t, z1 - t);
    this.box('frame', x0, x1, y - 0.06, y, z0, z0 + t);
    this.box('frame', x0, x1, y - 0.06, y, z1 - t, z1);
    this.box('frame', x0, x0 + t, y - 0.06, y, z0, z1);
    this.box('frame', x1 - t, x1, y - 0.06, y, z0, z1);
    for (let k = 1; k <= mullions; k++) {
      const x = x0 + ((x1 - x0) * k) / (mullions + 1);
      this.box('frame', x - 0.03, x + 0.03, y - 0.06, y, z0, z1);
    }
  }

  /** A window on a side face (looking -x or +x) at x. */
  windowSide(x: number, out: 1 | -1, y0: number, y1: number, z0: number, z1: number): void {
    const t = 0.07, o = out * 0.06;
    this.box('glass', x - 0.02, x + 0.02, y0 + t, y1 - t, z0 + t, z1 - t);
    this.box('frame', x, x + o, y0, y1, z0, z0 + t);
    this.box('frame', x, x + o, y0, y1, z1 - t, z1);
    this.box('frame', x, x + o, y0, y0 + t, z0, z1);
    this.box('frame', x, x + o, y1 - t, y1, z0, z1);
    this.box('frame', x, x + o, (y0 + y1) / 2 - 0.03, (y0 + y1) / 2 + 0.03, z0, z1);
  }
}

/** Image 1: balconies on both wings, a timber column with the stairs, a stone base, a roof terrace. */
function balconyMid(p: Parts, W: number, D: number, g: number, s: number, upper: number): void {
  const FB = 1.6; // balcony depth
  const cw = Math.max(3.6, Math.min(5, W * 0.19));
  const cx = W / 2, sx0 = cx - cw / 2, sx1 = cx + cw / 2;
  const top = g + upper * s;
  const wings: [number, number][] = [[0, sx0], [sx1, W]];

  // Ground floor: the stone base, set back under the first balconies.
  p.box('stone', 0, W, 0.6, D - 0.6, 0, g);
  p.box('trim', -0.05, W + 0.05, 0.5, D - 0.5, g - 0.3, g + 0.02);
  // The front, then the back the same (balconies on both long faces).
  for (const mirror of [null, D]) {
  p.mirror = mirror;
  for (const [a, b] of wings) {
    const span = b - a;
    const n = Math.max(1, Math.round(span / 3.2));
    for (let k = 0; k < n; k++) {
      const x0 = a + 0.6 + (k * (span - 1.2)) / n, x1 = a + 0.6 + ((k + 1) * (span - 1.2)) / n - 0.5;
      p.windowFront(x0, x1, 0.6, 0.5, g - 0.6, 1);
    }
    // A long concrete planter of shrubs in front of the windows.
    p.box('plant', a + 0.3, b - 0.3, -1.4, -0.3, 0, 0.6);
    const shrubs = Math.max(2, Math.round((b - a) / 1.3));
    for (let k = 0; k < shrubs; k++) p.bush(a + 0.8 + (k * (b - a - 1.6)) / Math.max(1, shrubs - 1), -0.85, 0.6, 0.45, k % 2 === 1);
  }
  }
  p.mirror = null;
  // The entrance: a timber portal, glass double doors, a steel canopy, cypresses in pots, wall lights.
  p.box('wood', sx0, sx1, 0.2, D - 0.2, 0, g);
  p.windowFront(cx - 1.3, cx + 1.3, 0.2, 0, Math.min(2.8, g - 0.5), 1);
  p.box('metal', cx - 2.2, cx + 2.2, -1.3, 0.2, g - 0.55, g - 0.4);
  p.cone(sx0 - 0.5, -0.6, 0);
  p.cone(sx1 + 0.5, -0.6, 0);
  for (const x of [sx0 + 0.35, sx1 - 0.35]) p.box('sconce', x - 0.08, x + 0.08, 0.1, 0.2, 2.1, 2.45);
  p.box('slab', cx - 2.4, cx + 2.4, -2.2, 0.2, -0.02, 0.12); // the step

  // The floors above.
  for (let k = 0; k < upper; k++) {
    const z = g + k * s;
    for (const [a, b] of wings) p.box('render', a, b, FB, D - FB, z, z + s);
    for (const mirror of [null, D]) {
    p.mirror = mirror;
    for (const [a, b] of wings) {
      const outer = a === 0 ? a : b; // the wing's outer end
      // The slab of the balcony.
      p.box('slab', a, b, 0, FB, z, z + 0.24);
      // Sliding doors, slat panels either side.
      const inner0 = a + (a === 0 ? 0.25 : 0.9), inner1 = b - (a === 0 ? 0.9 : 0.25);
      p.box('slats', a === 0 ? sx0 - 0.85 : sx1 + 0.15, a === 0 ? sx0 - 0.15 : sx1 + 0.85, FB - 0.08, FB, z + 0.24, z + s);
      const doors = Math.max(1, Math.round((inner1 - inner0) / 2.6));
      for (let d = 0; d < doors; d++) {
        const x0 = inner0 + (d * (inner1 - inner0)) / doors + 0.1, x1 = inner0 + ((d + 1) * (inner1 - inner0)) / doors - 0.1;
        p.windowFront(x0, x1, FB, z + 0.3, z + s - 0.35, 1);
      }
      // The railing round the balcony's open sides.
      p.rail(a + 0.02, b - 0.02, 0.02, 0.06, z + 0.24);
      p.rail(outer - 0.02, outer + 0.02, 0.06, FB, z + 0.24);
      // Plants on the balcony: one at each end.
      p.plant(a + 0.5, 0.45, z + 0.24, 0.9);
      p.plant(b - 0.5, 0.45, z + 0.24, 0.9);
      // A wall light by the doors.
      const lx = a === 0 ? inner1 - 0.25 : inner0 + 0.25;
      p.box('sconce', lx - 0.06, lx + 0.06, FB - 0.12, FB, z + 1.9, z + 2.2);
    }
    p.windowFront(cx - cw * 0.3, cx + cw * 0.3, 0.2, z + 0.7, z + s - 0.5, 1);
    }
    p.mirror = null;
    // The side faces: narrow windows and lights.
    for (const [x, out] of [[0, -1], [W, 1]] as const) {
      for (const y of [D * 0.42, D * 0.68]) p.windowSide(x, out, y - 0.45, y + 0.45, z + 0.7, z + s - 0.5);
    }
    // The timber column: a window per floor, beige bands either side.
    p.box('wood', sx0, sx1, 0.2, D - 0.2, z, z + s);
  }
  // Beige piers either side of the column, full height.
  p.box('trim', sx0 - 0.15, sx0, 0, D, g, top);
  p.box('trim', sx1, sx1 + 0.15, 0, D, g, top);
  // The roof: the top slab over the balconies, a parapet, the terrace.
  for (const [a, b] of wings) { p.box('slab', a, b, 0, FB, top, top + 0.3); p.box('slab', a, b, D - FB, D, top, top + 0.3); }
  p.box('plant', 0, W, FB, D - FB, top, top + 0.3);
  // The column's top only where the deck does not cover it (two coplanar tops flicker).
  p.box('wood', sx0, sx1, 0.2, FB, top, top + 0.3);
  p.box('wood', sx0, sx1, D - FB, D - 0.2, top, top + 0.3);
  // The parapet's coping: a rim round the roof, not a lid over it.
  p.box('trim', -0.1, W + 0.1, -0.1, 0.25, top + 0.3, top + 0.45);
  p.box('trim', -0.1, W + 0.1, D - 0.25, D + 0.1, top + 0.3, top + 0.45);
  p.box('trim', -0.1, 0.25, 0.25, D - 0.25, top + 0.3, top + 0.45);
  p.box('trim', W - 0.25, W + 0.1, 0.25, D - 0.25, top + 0.3, top + 0.45);
  p.rail(0.05, W - 0.05, 0.05, 0.09, top + 0.45);
  p.rail(W - 0.09, W - 0.05, 0.05, D - 0.05, top + 0.45);
  p.rail(0.05, 0.09, 0.05, D - 0.05, top + 0.45);
  p.rail(0.05, W - 0.05, D - 0.09, D - 0.05, top + 0.45);
  for (const x of [1.2, W * 0.3, W * 0.7, W - 1.2]) p.plant(x, 0.9, top + 0.45, 1.1);
  // The stair and lift overrun, its door; air conditioners; a vent stack.
  const py0 = D * 0.35, py1 = Math.min(D - 1, py0 + 4.5);
  p.box('trim', cx - 3, cx + 3, py0, py1, top + 0.3, top + 3.4);
  p.box('slab', cx - 3.15, cx + 3.15, py0 - 0.15, py1 + 0.15, top + 3.4, top + 3.6);
  p.windowFront(cx + 0.6, cx + 1.6, py0, top + 0.45, top + 2.6, 0);
  p.box('frame', cx + 0.6, cx + 1.6, py0 - 0.02, py0 + 0.02, top + 0.45, top + 2.6);
  p.cylinder('metal', cx - 1.8, py0 + 1.2, top + 3.6, top + 4.6, 0.18);
  for (const [x, y] of [[W * 0.78, D * 0.55], [W * 0.84, D * 0.55], [W * 0.2, D * 0.62]] as const) {
    p.box('metal', x - 0.55, x + 0.55, y - 0.4, y + 0.4, top + 0.3, top + 1.2);
    p.box('frame', x - 0.4, x + 0.4, y - 0.42, y - 0.4, top + 0.45, top + 1.05);
  }
}

/** How one of the towers of the reference sheets is made. */
interface TowerLook {
  /** The shaft's face: a facade picture, its bay width. */
  readonly face: FacadeKind;
  readonly bay: number;
  readonly podium: Mat;
  readonly round?: boolean;
  /** Projecting piers, every `every` metres, and their material. */
  readonly piers?: { readonly mat: Mat; readonly every: number; readonly w: number };
  /** A slab edge at every floor (`deep` > 0.5: a balcony band with its railing). */
  readonly bands?: { readonly mat: Mat; readonly deep: number; readonly rail?: 'glassRail' | 'railing'; readonly sides?: boolean };
  /** A strip up the middle of the front, standing forward, one storey higher. */
  readonly strip?: { readonly mat: Mat; readonly frac: number };
  /** Balconies in some columns only (classic towers). */
  readonly loggias?: { readonly every: number };
  /** Storeys of the set-back crown; tiers of an art deco top. */
  readonly crown: number;
  readonly tiers?: number;
  /** A cornice band at the crown. */
  readonly cornice?: Mat;
}

const LOOKS: Record<string, TowerLook> = {
  glassOffice: { face: 'curtainBlue', bay: 1.5, podium: 'stoneLight', piers: { mat: 'stoneLight', every: 6, w: 0.9 },
    strip: { mat: 'curtainStrip', frac: 0.24 }, crown: 2, cornice: 'stoneLight' },
  glassBalcony: { face: 'curtainBlue', bay: 1.5, podium: 'stoneLight', bands: { mat: 'white', deep: 1.4, rail: 'glassRail', sides: true },
    strip: { mat: 'stoneLight', frac: 0.14 }, crown: 2 },
  beigeClassic: { face: 'punchedBeige', bay: 1.8, podium: 'stoneLight', loggias: { every: 3 }, crown: 3, tiers: 2, cornice: 'trim' },
  darkGlass: { face: 'curtainDark', bay: 1.5, podium: 'darkPanel', crown: 4, tiers: 2 },
  whiteBalcony: { face: 'curtainBlue', bay: 1.5, podium: 'stoneLight', bands: { mat: 'white', deep: 1.6, rail: 'glassRail', sides: true }, crown: 1 },
  brickFrame: { face: 'curtainBlue', bay: 1.5, podium: 'stone', piers: { mat: 'brickPier', every: 3, w: 0.8 },
    bands: { mat: 'brickPier', deep: 0.35 }, crown: 1, cornice: 'brickPier' },
  roundGlass: { face: 'curtainBlue', bay: 1.5, podium: 'stoneLight', round: true, bands: { mat: 'white', deep: 0.6 }, crown: 1 },
  darkGrid: { face: 'gridDark', bay: 2.4, podium: 'darkPanel', piers: { mat: 'lightGrid', every: 4.8, w: 0.35 }, crown: 2 },
  artDeco: { face: 'punchedBeige', bay: 1.5, podium: 'stoneLight', piers: { mat: 'beige', every: 1.5, w: 0.35 }, crown: 3, tiers: 3, cornice: 'beige' },
};

/** A tower of the reference sheet: podium, shaft, crown and roof, in its own look. */
function towerOf(look: TowerLook) {
  return (p: Parts, W: number, D: number, g: number, s: number, upper: number): void => {
    const zP = g + s; // a two-storey podium
    const top = g + upper * s;
    const crownZ = top - look.crown * s;
    const I = 2;
    const sx0 = I, sx1 = W - I, sy0 = I, sy1 = D - I;
    const sw = sx1 - sx0, sd = sy1 - sy0;
    const face = facade(look.face, look.bay, s, zP);

    // The podium: its material, tall glazing between columns on every face, the entrance.
    p.box(look.podium, 0, W, 0, D, 0, zP);
    const cols = Math.max(2, Math.round(W / 4));
    for (const mirror of [null, D]) {
      p.mirror = mirror;
      for (let k = 0; k < cols; k++) {
        const x0 = (k * W) / cols + 0.35, x1 = ((k + 1) * W) / cols - 0.35;
        p.box('podiumGlass', x0, x1, -0.04, 0.02, 0.15, zP - 0.7);
        p.box('frame', x0, x1, -0.07, -0.02, g - 0.1, g + 0.05);
      }
      for (let k = 0; k <= cols; k++) { const x = (k * W) / cols; p.box(look.podium, x - 0.35, x + 0.35, -0.3, 0.2, 0, zP - 0.45); }
    }
    p.mirror = null;
    for (const [x, out] of [[0, -1], [W, 1]] as const) {
      const n = Math.max(2, Math.round(D / 4));
      for (let k = 0; k < n; k++) {
        const y0 = (k * D) / n + 0.35, y1 = ((k + 1) * D) / n - 0.35;
        p.box('podiumGlass', x + (out < 0 ? -0.02 : -0.02), x + 0.04 * out + (out < 0 ? 0 : 0.02), y0, y1, 0.15, zP - 0.7);
      }
    }
    p.box('trim', -0.2, W + 0.2, -0.2, D + 0.2, zP - 0.45, zP + 0.06); // stands above the podium's roof: no two tops at one height
    p.box('metal', W / 2 - 3, W / 2 + 3, -2, 0.1, g - 0.4, g - 0.2);
    p.windowFront(W / 2 - 1.5, W / 2 + 1.5, -0.08, 0, 3, 1);
    for (const x of [2, W * 0.3, W * 0.7, W - 2]) p.cone(x, -1.2, 0);
    p.box('plant', 0.5, W / 2 - 4, -1.9, -0.6, 0, 0.5);
    p.box('plant', W / 2 + 4, W - 0.5, -1.9, -0.6, 0, 0.5);
    for (let k = 0; k < 8; k++) p.bush(1 + (k * (W - 2)) / 7, -1.25, 0.5, 0.4, k % 2 === 0);

    // The shaft, then the crown set back.
    const tiers = look.tiers ?? 1;
    const shaft = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void => {
      if (look.round) {
        p.ellipse(face, (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, z0, z1);
        return;
      }
      p.box(face, x0, x1, y0, y1, z0, z1);
      if (look.piers) {
        const { mat, every, w } = look.piers;
        const n = Math.max(1, Math.round((x1 - x0) / every));
        for (let k = 0; k <= n; k++) {
          const x = x0 + ((x1 - x0) * k) / n;
          p.box(mat, x - w / 2, x + w / 2, y0 - 0.3, y0 + 0.2, z0, z1 + 0.25);
          p.box(mat, x - w / 2, x + w / 2, y1 - 0.2, y1 + 0.3, z0, z1 + 0.25);
        }
        const m2 = Math.max(1, Math.round((y1 - y0) / every));
        for (let k = 0; k <= m2; k++) {
          const y = y0 + ((y1 - y0) * k) / m2;
          p.box(mat, x0 - 0.3, x0 + 0.2, y - w / 2, y + w / 2, z0, z1 + 0.2);
          p.box(mat, x1 - 0.2, x1 + 0.3, y - w / 2, y + w / 2, z0, z1 + 0.2);
        }
      }
    };
    shaft(sx0, sx1, sy0, sy1, zP, crownZ);
    for (let t = 0; t < tiers; t++) {
      const c = 1.5 + t * 1.8;
      const z0 = crownZ + (t * (top - crownZ)) / tiers, z1 = crownZ + ((t + 1) * (top - crownZ)) / tiers;
      if (sw - 2 * c > 4 && sd - 2 * c > 4) shaft(sx0 + c, sx1 - c, sy0 + c, sy1 - c, z0, z1);
      if (look.cornice && !look.round) p.box(look.cornice, sx0 + c - 0.4 - 1.5, sx1 - c + 0.4 + 1.5, sy0 + c - 0.4 - 1.5, sy1 - c + 0.4 + 1.5, z0 - 0.4, z0 + 0.05);
    }
    const cTop = 1.5 + (tiers - 1) * 1.8;

    // Slab edges and balcony bands at every floor of the shaft.
    if (look.bands) {
      const { mat, deep, rail, sides } = look.bands;
      for (let k = 2; k < upper - look.crown + 1; k++) {
        const z = g + (k - 1) * s;
        if (look.round) {
          p.ellipse(mat, W / 2, D / 2, sw / 2 + deep, sd / 2 + deep, z, z + 0.25);
          continue;
        }
        p.box(mat, sx0 - (sides ? deep : 0), sx1 + (sides ? deep : 0), sy0 - deep, sy0, z, z + 0.25);
        p.box(mat, sx0 - (sides ? deep : 0), sx1 + (sides ? deep : 0), sy1, sy1 + deep, z, z + 0.25);
        if (sides) { p.box(mat, sx0 - deep, sx0, sy0, sy1, z, z + 0.25); p.box(mat, sx1, sx1 + deep, sy0, sy1, z, z + 0.25); }
        if (rail && deep > 0.5) {
          const railBox = (x0: number, x1: number, y0: number, y1: number): void => {
            if (rail === 'glassRail') p.box('glassRail', x0, x1, y0, y1, z + 0.25, z + 1.3);
            else p.rail(x0, x1, y0, y1, z + 0.25);
          };
          const ex = sides ? deep : 0;
          railBox(sx0 - ex, sx1 + ex, sy0 - deep, sy0 - deep + 0.04);
          railBox(sx0 - ex, sx1 + ex, sy1 + deep - 0.04, sy1 + deep);
          if (sides) { railBox(sx0 - deep, sx0 - deep + 0.04, sy0 - deep, sy1 + deep); railBox(sx1 + deep - 0.04, sx1 + deep, sy0 - deep, sy1 + deep); }
        }
      }
    }
    // Loggias: balconies in every third column, black railings.
    if (look.loggias) {
      const n = Math.max(3, Math.round(sw / look.bay));
      for (let k = 2; k < upper - look.crown + 1; k++) {
        const z = g + (k - 1) * s;
        for (let c = 1; c < n - 1; c += look.loggias.every) {
          const x0 = sx0 + (c * sw) / n, x1 = sx0 + ((c + 1) * sw) / n;
          for (const mirror of [null, D]) {
            p.mirror = mirror;
            p.box('trim', x0 - 0.1, x1 + 0.1, sy0 - 1.1, sy0, z, z + 0.2);
            p.rail(x0 - 0.1, x1 + 0.1, sy0 - 1.1, sy0 - 1.06, z + 0.2);
          }
          p.mirror = null;
        }
      }
    }
    // The strip up the front: standing forward, one storey higher.
    if (look.strip && !look.round) {
      const w = sw * look.strip.frac;
      const stripMat = look.strip.mat === 'curtainStrip' ? facade('curtainBlue', 1.2, s, zP) : look.strip.mat;
      p.box(stripMat, W / 2 - w / 2, W / 2 + w / 2, sy0 - 0.8, sy0 + 0.5, zP, top + s);
      p.box('trim', W / 2 - w / 2 - 0.2, W / 2 + w / 2 + 0.2, sy0 - 1, sy0 + 0.7, top + s, top + s + 0.3);
    }
    // The roof: parapet, railing, plant rooms, cooling towers, a water tank.
    const r0 = look.round ? null : { x0: sx0 + cTop, x1: sx1 - cTop, y0: sy0 + cTop, y1: sy1 - cTop };
    if (r0) {
      p.box('plant', r0.x0, r0.x1, r0.y0, r0.y1, top, top + 0.2);
      p.box('trim', r0.x0 - 0.1, r0.x1 + 0.1, r0.y0 - 0.1, r0.y0 + 0.2, top, top + 0.9);
      p.box('trim', r0.x0 - 0.1, r0.x1 + 0.1, r0.y1 - 0.2, r0.y1 + 0.1, top, top + 0.9);
      p.box('trim', r0.x0 - 0.1, r0.x0 + 0.2, r0.y0, r0.y1, top, top + 0.9);
      p.box('trim', r0.x1 - 0.2, r0.x1 + 0.1, r0.y0, r0.y1, top, top + 0.9);
      const cx = (r0.x0 + r0.x1) / 2, cy = (r0.y0 + r0.y1) / 2;
      p.box('lightGrid', cx - 3, cx + 3, cy - 2, cy + 2, top, top + 3.2);
      p.box('metal', cx - 3.2, cx + 3.2, cy - 2.2, cy + 2.2, top + 3.2, top + 3.4);
      for (const [x, y] of [[r0.x0 + 1.5, r0.y0 + 1.5], [r0.x1 - 1.5, r0.y0 + 1.5], [r0.x1 - 1.5, r0.y1 - 1.5]] as const) {
        p.box('metal', x - 0.8, x + 0.8, y - 0.6, y + 0.6, top + 0.2, top + 1.4);
      }
      p.cylinder('metal', r0.x0 + 2, r0.y1 - 2, top + 0.2, top + 2.6, 1);
    } else {
      p.ellipse('white', W / 2, D / 2, sw / 2 - cTop + 0.3, sd / 2 - cTop + 0.3, top, top + 0.6);
      p.ellipse('lightGrid', W / 2, D / 2, sw / 4, sd / 4, top + 0.6, top + 3.5, 16);
      p.ellipse('white', W / 2, D / 2, sw / 4 + 0.3, sd / 4 + 0.3, top + 3.5, top + 3.8, 16);
    }
  };
}

const DESIGNS: Partial<Record<string, typeof balconyMid>> = {
  balconyMid,
  ...Object.fromEntries(Object.entries(LOOKS).map(([kind, look]) => [kind, towerOf(look)])),
};

/** Whether this module draws the building's body. */
export function drawsSignature(b: Building): boolean {
  const kind = signatureKind(b);
  return kind !== null && DESIGNS[kind] !== undefined;
}

/**
 * The body of a signature building, placed in the world: `floor` is the
 * height of its ground floor (world units), as the generic body would stand.
 */
export function buildSignature(b: Building, floor: number): Group | null {
  const kind = signatureKind(b);
  const design = kind ? DESIGNS[kind] : undefined;
  if (!design) return null;
  materials ??= makeMaterials();
  const U = m(1);
  const closed = b.volumes.filter((v) => !v.open);
  if (!closed.length) return null;
  const base = closed.filter((v) => v.base === 0).sort((p, q) => q.w * q.d - p.w * p.d)[0] ?? closed[0]!;
  const levels = Math.max(...closed.map((v) => v.base + v.storeys.length));
  const parts = new Parts();
  design(parts, base.w / U, base.d / U, b.groundHeight / U, b.storeyHeight / U, Math.max(1, levels - 1));
  const group = new Group();
  group.name = `signature-${b.id}`;
  for (const [mat, list] of parts.byMat) {
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    if (!merged) continue;
    merged.scale(U, U, U);
    merged.computeBoundingSphere();
    const mesh = new Mesh(merged, materials[mat] ?? facades.get(mat)!);
    mesh.castShadow = mat !== 'glass' && mat !== 'sconce';
    mesh.receiveShadow = true;
    mesh.name = `signature-${mat}`;
    group.add(mesh);
  }
  // The body's frame: the base block's corner, in the building's frame, in the world.
  group.position.set(b.x, floor, -b.y);
  group.rotation.y = b.rotation;
  const inner = new Group();
  inner.position.set(base.x, 0, -base.y);
  inner.add(...group.children);
  group.add(inner);
  group.updateMatrixWorld(true);
  return group;
}

export function disposeSignature(group: Group): void {
  group.traverse((o) => { if ((o as Mesh).isMesh) (o as Mesh).geometry.dispose(); });
}
