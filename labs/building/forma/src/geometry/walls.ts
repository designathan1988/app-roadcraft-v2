// Grafo de paredes internas de um pavimento (coordenadas locais do edifício).
// Nós são compartilhados; ao desenhar, a parede nova é dividida nos cruzamentos
// e as paredes existentes são divididas onde a nova encosta (T) ou cruza (X).
// Política de IDs: a parte inicial mantém o ID; a outra recebe ID novo com
// splitFrom. Portas da parede dividida vão para a parte que contém o seu centro.
import type { GraphNode, ID, Opening, Vec2, Wall, WallGraph } from '../core/schema';
import { uid } from '../core/ids';

const EPS = 1e-6;
export const SNAP_NODE = 0.25;

export const nodeById = (g: WallGraph, id: ID): GraphNode | undefined => g.nodes.find((n) => n.id === id);

export function wallEnds(g: WallGraph, w: Wall): [Vec2, Vec2] | null {
  const a = nodeById(g, w.a),
    b = nodeById(g, w.b);
  return a && b ? [a.p, b.p] : null;
}

export const wallLength = (g: WallGraph, w: Wall): number => {
  const e = wallEnds(g, w);
  return e ? Math.hypot(e[1][0] - e[0][0], e[1][1] - e[0][1]) : 0;
};

/** Parâmetro t (0..1) da projeção de p no segmento ab e a distância. */
export function project(p: Vec2, a: Vec2, b: Vec2): { t: number; d: number; q: Vec2 } {
  const dx = b[0] - a[0],
    dz = b[1] - a[1],
    l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
  const q: Vec2 = [a[0] + dx * t, a[1] + dz * t];
  return { t, d: Math.hypot(p[0] - q[0], p[1] - q[1]), q };
}

/** Interseção própria de dois segmentos (parâmetros em cada um). */
export function segmentIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { t: number; u: number; p: Vec2 } | null {
  const r: Vec2 = [b[0] - a[0], b[1] - a[1]],
    s: Vec2 = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < EPS) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den,
    u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { t, u, p: [a[0] + r[0] * t, a[1] + r[1] * t] };
}

/** Nó existente perto de p, ou um novo. */
function nodeAt(g: WallGraph, p: Vec2, newId: () => ID, tol = 1e-3): GraphNode {
  const n = g.nodes.find((x) => Math.hypot(x.p[0] - p[0], x.p[1] - p[1]) <= tol);
  if (n) return n;
  const created = { id: newId(), p: [p[0], p[1]] as Vec2 };
  g.nodes.push(created);
  return created;
}

/**
 * Divide a parede no ponto p (sobre ela). Devolve o nó do ponto.
 * Aberturas hospedadas são redistribuídas pela posição do centro.
 */
export function splitWall(g: WallGraph, wall: Wall, p: Vec2, openings: Opening[], storeyId: ID, newId: () => ID = uid): GraphNode {
  const ends = wallEnds(g, wall)!;
  const node = nodeAt(g, p, newId);
  if (node.id === wall.a || node.id === wall.b) return node;
  const len = Math.hypot(ends[1][0] - ends[0][0], ends[1][1] - ends[0][1]);
  const cut = Math.hypot(node.p[0] - ends[0][0], node.p[1] - ends[0][1]);
  const second: Wall = { ...structuredClone(wall), id: newId(), a: node.id, b: wall.b, splitFrom: wall.id };
  wall.b = node.id;
  g.walls.push(second);
  for (const o of openings) {
    if (o.host.kind !== 'wall' || o.host.wallId !== wall.id || o.host.storeyId !== storeyId) continue;
    if (o.offset > cut) {
      o.host = { kind: 'wall', storeyId, wallId: second.id };
      o.offset -= cut;
    }
  }
  void len;
  return node;
}

export interface AddWallOptions {
  thickness?: number;
  newId?: () => ID;
  /** Aberturas do edifício (para redistribuir nas divisões). */
  openings?: Opening[];
  storeyId?: ID;
}

/**
 * Adiciona a parede a→b ao grafo, dividindo-a e às existentes nos encontros.
 * Devolve os IDs das paredes criadas.
 */
export function addWall(g: WallGraph, a: Vec2, b: Vec2, opts: AddWallOptions = {}): ID[] {
  const newId = opts.newId ?? uid;
  const openings = opts.openings ?? [];
  const storeyId = opts.storeyId ?? '';
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.05) return [];
  // Pontos de corte ao longo da parede nova (t) e paredes existentes a dividir.
  const cuts: { t: number; p: Vec2 }[] = [
    { t: 0, p: a },
    { t: 1, p: b },
  ];
  for (const w of [...g.walls]) {
    const e = wallEnds(g, w);
    if (!e) continue;
    const hit = segmentIntersection(a, b, e[0], e[1]);
    if (hit) {
      cuts.push({ t: hit.t, p: hit.p });
      if (hit.u > 1e-4 && hit.u < 1 - 1e-4) splitWall(g, w, hit.p, openings, storeyId, newId);
      continue;
    }
    // Extremidade da parede nova encostando no meio de uma existente (T).
    for (const [end, t] of [[a, 0], [b, 1]] as const) {
      const pr = project(end, e[0], e[1]);
      if (pr.d < 1e-3 && pr.t > 1e-4 && pr.t < 1 - 1e-4) {
        splitWall(g, w, pr.q, openings, storeyId, newId);
        cuts.push({ t, p: pr.q });
      }
    }
  }
  // Nós existentes sobre a parede nova também a dividem.
  for (const n of g.nodes) {
    const pr = project(n.p, a, b);
    if (pr.d < 1e-3 && pr.t > 1e-4 && pr.t < 1 - 1e-4) cuts.push({ t: pr.t, p: n.p });
  }
  cuts.sort((x, y) => x.t - y.t);
  const ids: ID[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const p = cuts[i]!.p,
      q = cuts[i + 1]!.p;
    if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.05) continue;
    const na = nodeAt(g, p, newId),
      nb = nodeAt(g, q, newId);
    if (na.id === nb.id) continue;
    if (g.walls.some((w) => (w.a === na.id && w.b === nb.id) || (w.a === nb.id && w.b === na.id))) continue;
    const w: Wall = { id: newId(), a: na.id, b: nb.id, thickness: opts.thickness ?? 0.12 };
    g.walls.push(w);
    ids.push(w.id);
  }
  return ids;
}

/** Remove a parede; nós soltos são apagados; aberturas dela também. */
export function removeWall(g: WallGraph, wallId: ID, openings: Opening[]): Opening[] {
  g.walls = g.walls.filter((w) => w.id !== wallId);
  const used = new Set(g.walls.flatMap((w) => [w.a, w.b]));
  g.nodes = g.nodes.filter((n) => used.has(n.id));
  return openings.filter((o) => !(o.host.kind === 'wall' && o.host.wallId === wallId));
}

/** Ponto de encaixe: nó próximo, ponto sobre parede ou o próprio ponto. */
export function snapToGraph(g: WallGraph, p: Vec2, extra: [Vec2, Vec2][] = [], tol = SNAP_NODE): { p: Vec2; kind: 'node' | 'wall' | 'edge' | 'free'; seg?: [Vec2, Vec2] } {
  let best: { p: Vec2; d: number; kind: 'node' | 'wall' | 'edge'; seg?: [Vec2, Vec2] } | null = null;
  for (const n of g.nodes) {
    const d = Math.hypot(n.p[0] - p[0], n.p[1] - p[1]);
    if (d <= tol && (!best || d < best.d)) best = { p: n.p, d, kind: 'node' };
  }
  if (best) return best;
  for (const w of g.walls) {
    const e = wallEnds(g, w);
    if (!e) continue;
    const pr = project(p, e[0], e[1]);
    if (pr.d <= tol && (!best || pr.d < best.d)) best = { p: pr.q, d: pr.d, kind: 'wall', seg: e };
  }
  for (const [a, b] of extra) {
    // Cantos do contorno têm prioridade sobre o meio da aresta.
    for (const c of [a, b]) {
      const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
      if (d <= tol && (!best || d < best.d + 0.05)) best = { p: c, d, kind: 'edge' };
    }
    const pr = project(p, a, b);
    if (pr.d <= tol && (!best || pr.d < best.d)) best = { p: pr.q, d: pr.d, kind: 'edge', seg: [a, b] };
  }
  return best ?? { p, kind: 'free' };
}

/** Transforma todos os nós (espelhar, escalar, mudar de referencial). */
export function transformGraph(g: WallGraph, fn: (p: Vec2) => Vec2): void {
  for (const n of g.nodes) n.p = fn(n.p);
}
