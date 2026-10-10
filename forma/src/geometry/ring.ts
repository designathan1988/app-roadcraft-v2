// Anéis com vértices identificados. O ID de uma aresta é o ID do vértice inicial.
import type { ID, Mass, Ring, Vec2 } from '../core/schema';
import { uid } from '../core/ids';

export const ringPoints = (r: Ring): Vec2[] => r.vertices.map((v) => [v.p[0], v.p[1]] as Vec2);

export const makeRing = (points: Vec2[], newId: () => ID = uid): Ring => ({
  vertices: points.map((p) => ({ id: newId(), p: [p[0], p[1]] as Vec2 })),
});

export interface MassEdge {
  id: ID;
  /** 'outer' ou índice do furo. */
  ring: 'outer' | number;
  index: number;
  a: Vec2;
  b: Vec2;
  length: number;
}

/** Arestas da massa na ordem do v1: anel externo e depois cada furo. */
export function massEdges(m: Mass): MassEdge[] {
  const out: MassEdge[] = [];
  const rings: Array<['outer' | number, Ring]> = [['outer', m.outer], ...m.holes.map((h, i) => [i, h] as [number, Ring])];
  for (const [which, r] of rings) {
    const n = r.vertices.length;
    for (let i = 0; i < n; i++) {
      const a = r.vertices[i]!,
        b = r.vertices[(i + 1) % n]!;
      out.push({ id: a.id, ring: which, index: i, a: a.p, b: b.p, length: Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]) });
    }
  }
  return out;
}

export function findEdge(m: Mass, edgeId: ID): MassEdge | undefined {
  return massEdges(m).find((e) => e.id === edgeId);
}
