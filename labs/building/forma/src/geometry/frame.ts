// Conversão entre coordenadas locais do edifício e do mundo (planta [x, z]).
// Mesma convenção do v1: rotação em graus, x' = x·c + z·s, z' = −x·s + z·c.
// Equivale a THREE.Object3D.rotation.y = rotação em radianos.
import type { Vec2 } from '../core/schema';

export interface Frame {
  position: Vec2;
  rotation: number;
}

export function toWorld(f: Frame, p: Vec2): Vec2 {
  const a = (f.rotation * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  return [p[0] * c + p[1] * s + f.position[0], -p[0] * s + p[1] * c + f.position[1]];
}

export function toLocal(f: Frame, p: Vec2): Vec2 {
  const a = (f.rotation * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a),
    x = p[0] - f.position[0],
    z = p[1] - f.position[1];
  return [x * c - z * s, x * s + z * c];
}

export const ringToWorld = (f: Frame, ring: Vec2[]): Vec2[] => ring.map((p) => toWorld(f, p));
export const ringToLocal = (f: Frame, ring: Vec2[]): Vec2[] => ring.map((p) => toLocal(f, p));
