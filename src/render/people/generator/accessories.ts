import {
  BufferGeometry, CatmullRomCurve3, Color, DoubleSide, Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Shape, ShapeGeometry,
  SphereGeometry, TorusGeometry, TubeGeometry, Vector3,
} from 'three';

/**
 * Accessories built round the person's own face: glasses sized to the
 * distance between their eyes and reaching back to their ears, earrings at
 * their ear lobes. Positions come from the drawn body (`AccessoryAnchors`);
 * everything is in the body's frame (a child of the person's mesh).
 */

import type { EarringParams, GlassesParams } from '@people/gen/accessories';

export interface AccessoryAnchors {
  /** Centre of each eye (iris), left (+x) then right. */
  readonly eyes: readonly [Vector3, Vector3];
  /** The ear lobes, left then right. */
  readonly lobes: readonly [Vector3, Vector3];
  /** Where the temples rest, above each ear. */
  readonly earTops: readonly [Vector3, Vector3];
}

/** A lens outline for a frame style, unit size (width 1). */
function lensShape(style: string): Shape {
  const s = new Shape();
  const N = 40;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    let x = Math.cos(a) * 0.5, y = Math.sin(a) * 0.5;
    if (style === 'round') { y *= 0.92; }
    else if (style === 'square') {
      // A superellipse: squared corners.
      const p = 5;
      x = Math.sign(Math.cos(a)) * Math.abs(Math.cos(a)) ** (2 / p) * 0.5;
      y = Math.sign(Math.sin(a)) * Math.abs(Math.sin(a)) ** (2 / p) * 0.36;
    } else if (style === 'cat') {
      y *= 0.62;
      if (y > 0 && x > 0) y += x * 0.32;
    } else if (style === 'aviator') {
      y *= 0.78;
      if (y < 0) { y *= 1.25; x *= 1 - 0.18 * Math.abs(y); }
    }
    if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
  }
  return s;
}

export function glasses(p: GlassesParams, a: AccessoryAnchors): Group | null {
  if (p.style === 'none') return null;
  const g = new Group();
  const frame = new MeshStandardMaterial({ color: p.colour, roughness: 0.35, metalness: p.style === 'aviator' ? 0.9 : 0.1 });
  const lens = new MeshPhysicalMaterial({
    color: new Color(p.tint), transparent: true, opacity: 0.12 + 0.7 * p.tintAmount, roughness: 0.05, clearcoat: 1, side: DoubleSide, depthWrite: false,
  });
  const [l, r] = a.eyes;
  const span = l.distanceTo(r);
  const w = span * 0.82, front = 0.013;
  const shape = lensShape(p.style);
  const outline = shape.getPoints(40).map((v) => new Vector3(v.x, v.y, 0));
  for (const [eye, side] of [[l, 1], [r, -1]] as const) {
    const c = new Vector3(eye.x + side * span * 0.04, eye.y - span * 0.02, eye.z + front);
    const lensMesh = new Mesh(new ShapeGeometry(shape), lens);
    lensMesh.scale.set(w, w, 1);
    lensMesh.position.copy(c);
    g.add(lensMesh);
    const rim = new Mesh(new TubeGeometry(new CatmullRomCurve3(outline.map((v) => v.clone().multiplyScalar(w).add(c)), true), 64, 0.0013, 6, true), frame);
    g.add(rim);
    // Temple: from the lens's outer edge back to above the ear.
    const hinge = new Vector3(c.x + side * w * 0.5, c.y + w * 0.05, c.z - 0.002);
    const ear = a.earTops[side > 0 ? 0 : 1];
    const temple = new CatmullRomCurve3([hinge, new Vector3(ear.x + side * 0.004, hinge.y, (hinge.z + ear.z) / 2), new Vector3(ear.x + side * 0.002, ear.y, ear.z), new Vector3(ear.x - side * 0.004, ear.y - 0.02, ear.z - 0.012)]);
    g.add(new Mesh(new TubeGeometry(temple, 24, 0.0011, 6, false), frame));
  }
  // Bridge over the nose.
  const ib = new Vector3(l.x - span * 0.5 + w * 0.08, l.y - span * 0.0, l.z + front + 0.002);
  const bridge = new CatmullRomCurve3([
    new Vector3(r.x - span * 0.04 + w * 0.42, ib.y, ib.z), new Vector3((l.x + r.x) / 2, ib.y + 0.004, ib.z + 0.002), new Vector3(l.x + span * 0.04 - w * 0.42, ib.y, ib.z),
  ]);
  g.add(new Mesh(new TubeGeometry(bridge, 12, 0.0012, 6, false), frame));
  return g;
}

export function earrings(p: EarringParams, a: AccessoryAnchors): Group | null {
  if (p.style === 'none') return null;
  const g = new Group();
  const metal = new MeshStandardMaterial({ color: p.colour, metalness: 1, roughness: 0.22 });
  for (const lobe of a.lobes) {
    let m: Mesh<BufferGeometry, MeshStandardMaterial>;
    if (p.style === 'hoops') {
      m = new Mesh(new TorusGeometry(0.009, 0.0009, 8, 32), metal);
      m.position.set(lobe.x, lobe.y - 0.0085, lobe.z);
      m.rotation.y = Math.PI / 2;
    } else {
      m = new Mesh(new SphereGeometry(0.0022, 16, 12), metal);
      m.position.set(lobe.x + Math.sign(lobe.x) * 0.0012, lobe.y, lobe.z + 0.001);
    }
    g.add(m);
  }
  return g;
}
