// Desenho de um lote: piso, divisa, testada e área edificável.
import * as THREE from 'three';
import type { Lot, Vec2 } from '../core/schema';
import type { PolygonWithHoles } from '../geometry/boolean';
import { edgeKinds, lotPolygon } from '../geometry/lot';

export interface LotLook {
  selected?: boolean;
  violated?: boolean;
}

const Y = 0.012;

function lineLoop(points: Vec2[], color: string, y: number, closed = true, width = 1): THREE.Line {
  const pts = points.map((p) => new THREE.Vector3(p[0], y, p[1]));
  if (closed) pts.push(pts[0]!.clone());
  const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, linewidth: width }));
  l.renderOrder = 5;
  return l;
}

/** Faixa plana ao longo de um segmento (linhas grossas não existem no WebGL). */
function band(a: Vec2, b: Vec2, width: number, color: string, y: number): THREE.Mesh {
  const dx = b[0] - a[0],
    dz = b[1] - a[1],
    l = Math.hypot(dx, dz) || 1,
    nx = (-dz / l) * (width / 2),
    nz = (dx / l) * (width / 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([a[0] + nx, y, a[1] + nz, b[0] + nx, y, b[1] + nz, b[0] - nx, y, b[1] - nz, a[0] - nx, y, a[1] - nz], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthWrite: false }));
  m.renderOrder = 6;
  return m;
}

export function buildLotGroup(lot: Lot, buildable: PolygonWithHoles[], look: LotLook = {}): THREE.Group {
  const g = new THREE.Group();
  g.name = 'lote:' + lot.name;
  g.userData = { lotId: lot.id };
  const p = lotPolygon(lot);
  const shape = new THREE.Shape(p.map((q) => new THREE.Vector2(q[0], -q[1])));
  const fill = new THREE.Mesh(
    new THREE.ShapeGeometry(shape),
    new THREE.MeshStandardMaterial({ color: look.violated ? '#e8c3ba' : '#c8d5b0', roughness: 1, transparent: true, opacity: 0.95, depthWrite: false }),
  );
  fill.rotation.x = -Math.PI / 2;
  fill.position.y = Y - 0.004;
  fill.receiveShadow = true;
  fill.userData = { lotId: lot.id, part: 'lot' };
  g.add(fill);
  const kinds = edgeKinds(lot);
  const border = look.selected ? '#f09b56' : '#7b8274';
  g.add(lineLoop(p, border, Y + 0.002));
  p.forEach((a, i) => {
    if (kinds[i] === 'front') g.add(band(a, p[(i + 1) % p.length]!, 0.35, '#3d6fb6', Y + 0.003));
  });
  const ok = look.violated ? '#c0392b' : '#4f8a4b';
  for (const part of buildable) for (const ring of part) g.add(lineLoop(ring, ok, Y + 0.004));
  return g;
}

export function disposeLotGroup(g: THREE.Group): void {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    (m.material as THREE.Material | undefined)?.dispose?.();
  });
  g.removeFromParent();
}
