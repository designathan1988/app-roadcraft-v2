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

type Mat = 'stone' | 'render' | 'trim' | 'wood' | 'slats' | 'slab' | 'frame' | 'glass' | 'railing' | 'pot' | 'leaf' | 'leafDark'
  | 'metal' | 'plant' | 'sconce';

let materials: Record<Mat, Material> | null = null;

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
  p.box('wood', sx0, sx1, 0.2, D, top, top + 0.3);
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

const DESIGNS: Partial<Record<string, typeof balconyMid>> = { balconyMid };

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
    const mesh = new Mesh(merged, materials[mat]);
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
