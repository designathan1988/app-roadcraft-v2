// Sólidos de colisão (sem three.js): cada parede vira blocos ao redor dos vãos
// (as portas ficam livres para passar); lajes e degraus entram como estão.
import type { Building, Vec2 } from '../core/schema';
import type { BuildingParts, WallPart } from './parts';
import { buildBuildingParts } from './mass-parts';

/** Bloco orientado: centro em planta, meias-dimensões, ângulo e faixa de altura. */
export interface Solid {
  center: Vec2;
  /** Meio comprimento ao longo da parede e meia espessura. */
  hu: number;
  hv: number;
  angle: number;
  y0: number;
  y1: number;
}

/** Blocos sólidos de uma parede, deixando livres os vãos. */
export function wallSolids(w: WallPart): Solid[] {
  const out: Solid[] = [];
  const tx = Math.cos(-w.angle),
    tz = Math.sin(-w.angle);
  // A extrusão vai para −normal a partir da origem: o meio da espessura fica em origin − n·depth/2.
  const nx = tz,
    nz = -tx;
  const ox = w.origin[0] - nx * (w.depth / 2),
    oz = w.origin[2] - nz * (w.depth / 2),
    oy = w.origin[1];
  const push = (s0: number, s1: number, y0: number, y1: number) => {
    if (s1 - s0 < 0.01 || y1 - y0 < 0.01) return;
    const m = (s0 + s1) / 2;
    out.push({ center: [ox + tx * m, oz + tz * m], hu: (s1 - s0) / 2, hv: w.depth / 2, angle: w.angle, y0: oy + y0, y1: oy + y1 });
  };
  const holes = [...w.holes].sort((a, b) => a.left - b.left);
  let s = 0;
  for (const h of holes) {
    push(s, h.left, w.bottom, w.top);
    push(h.left, h.right, w.bottom, h.bottom);
    push(h.left, h.right, h.top, w.top);
    s = Math.max(s, h.right);
  }
  push(s, w.length, w.bottom, w.top);
  return out;
}

export interface CollisionShapes {
  solids: Solid[];
  parts: BuildingParts;
}

/** Sólidos de um edifício em coordenadas locais (paredes, degraus). */
export function collisionShapes(b: Building): CollisionShapes {
  const parts = buildBuildingParts(b);
  const solids = parts.walls.flatMap(wallSolids);
  for (const box of parts.boxes) {
    if (box.data.part !== 'stair') continue;
    solids.push({ center: [box.pos[0], box.pos[2]], hu: box.size[0] / 2, hv: box.size[2] / 2, angle: box.angle, y0: box.pos[1] - box.size[1] / 2, y1: box.pos[1] + box.size[1] / 2 });
  }
  return { solids, parts };
}

/** Empurra um círculo (raio r) para fora do bloco; devolve a nova posição. */
export function pushOut(p: Vec2, r: number, s: Solid): Vec2 {
  const c = Math.cos(-s.angle),
    sn = Math.sin(-s.angle);
  const dx = p[0] - s.center[0],
    dz = p[1] - s.center[1];
  const u = dx * c + dz * sn,
    v = -dx * sn + dz * c;
  const cu = Math.max(-s.hu, Math.min(s.hu, u)),
    cv = Math.max(-s.hv, Math.min(s.hv, v));
  let du = u - cu,
    dv = v - cv;
  const d = Math.hypot(du, dv);
  if (d >= r) return p;
  if (d < 1e-9) {
    // Centro dentro do bloco: sai pelo lado mais próximo.
    const ou = s.hu - Math.abs(u),
      ov = s.hv - Math.abs(v);
    if (ou < ov) {
      du = Math.sign(u) || 1;
      dv = 0;
    } else {
      du = 0;
      dv = Math.sign(v) || 1;
    }
    const nu = du ? Math.sign(du) * (s.hu + r) : u,
      nv = dv ? Math.sign(dv) * (s.hv + r) : v;
    return [s.center[0] + nu * c - nv * sn, s.center[1] + nu * sn + nv * c];
  }
  const k = r / d;
  const nu = cu + du * k,
    nv = cv + dv * k;
  return [s.center[0] + nu * c - nv * sn, s.center[1] + nu * sn + nv * c];
}
