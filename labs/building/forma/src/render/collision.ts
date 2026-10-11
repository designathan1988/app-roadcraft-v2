// Malha de colisão para a física do jogo: blocos simples (paredes com vãos
// livres, degraus) e lajes. Invisível por padrão.
import * as THREE from 'three';
import type { Building } from '../core/schema';
import { collisionShapes } from '../geometry/collision';
import { slabGeometry } from './build-building';

export function buildCollision(b: Building, opts: { visible?: boolean } = {}): THREE.Group {
  const g = new THREE.Group();
  g.name = 'colisão:' + b.name;
  g.position.set(b.position[0], 0, b.position[1]);
  g.rotation.y = (b.rotation * Math.PI) / 180;
  g.userData = { buildingId: b.id, collider: true };
  const mat = new THREE.MeshBasicMaterial({ color: '#ff00ff', wireframe: true, visible: !!opts.visible });
  const box = new THREE.BoxGeometry(1, 1, 1);
  const { solids, parts } = collisionShapes(b);
  for (const s of solids) {
    const m = new THREE.Mesh(box, mat);
    m.scale.set(s.hu * 2, s.y1 - s.y0, s.hv * 2);
    m.position.set(s.center[0], (s.y0 + s.y1) / 2, s.center[1]);
    m.rotation.y = s.angle;
    m.userData = { collider: true };
    g.add(m);
  }
  for (const sl of parts.slabs) {
    const m = new THREE.Mesh(slabGeometry(sl), mat);
    m.position.y = sl.y;
    m.userData = { collider: true };
    g.add(m);
  }
  g.updateMatrixWorld(true);
  return g;
}
