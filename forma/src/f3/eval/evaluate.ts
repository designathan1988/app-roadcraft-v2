// Avalia um edifício forma/3: sólidos (corpo + telhado) → booleanas na ordem
// da lista (como a pilha de modificadores do Blender) → vãos recortados →
// vazios dos pavimentos (modo oco) → malha final com a face de origem de cada
// triângulo. Puro (sem three); roda no worker ou no Node.
import type { Building3, Solid, Vec2 } from '../model/schema';
import { kernel, Scope, type Manifold } from '../kernel/kernel';
import { bodyMesh, coveredEdges, solidRings } from './body';
import { FaceTable, type FaceInfo } from './faces';
import { roofMesh } from './roofs';
import { bandsManifold, flatRoof, groupParapet, topKey } from './parapet';
import { heightPrism, MeshBuilder, prismMesh } from './mesh';
import { offsetRing, oriented, ringValid, sampleRing } from '../model/plan';
import { inside } from '../model/ops';
import { edgeRegions, itemPlacements, rulePlacements, typeResolver, type Placement } from './facade';
import { emptyParts3, FrameSink, type Parts3 } from './parts';
import { openingProfile } from '../families/shapes';
import type { Project3 } from '../model/schema';

export interface EvalOptions {
  /** Paredes ocas com vazios por nível (corte e interior). */
  hollow?: boolean;
  /** Corta tudo acima desta cota (pavimento ativo). */
  cutY?: number;
  /** Só o corpo, sem vãos (durante o arrasto). */
  preview?: boolean;
  wallThickness?: number;
  /** Volume escondido na vista (camadas, olho). Padrão: `solid.hidden`. */
  hidden?: (s: Solid) => boolean;
}

export interface Shell {
  /** Posições [x, y, z] (referencial do edifício). */
  positions: Float32Array;
  /** Três índices por triângulo. */
  indices: Uint32Array;
  /** Face de origem de cada triângulo (índice em `faces`). */
  faceOf: Uint32Array;
}

export interface Evaluated {
  shell: Shell;
  /** Peças dos componentes (caixilhos, vidros, sacadas…). */
  parts: Parts3;
  /** Onde cada componente ficou (seleção, alças). */
  placements: Placement[];
  faces: FaceInfo[];
  warnings: string[];
  ms: number;
}

/** Sólido completo de um volume: corpo unido ao telhado. */
export function solidManifold(s: Solid, table: FaceTable, scope: Scope, noParapet = false, covered?: ReadonlySet<string>): Manifold | null {
  const k = kernel();
  const rings = solidRings(s, covered);
  if (rings.outer.pts.length < 3 || s.height <= 0.01) return null;
  let body = scope.keep(bodyMesh(s, rings, table).toManifold(k));
  if (body.status() !== 'NoError' || body.isEmpty()) return null;
  const bands = bandsManifold(s, rings, table, scope);
  if (bands.length) body = scope.keep(k.Manifold.union([body, ...bands]));
  // Sólido de subtração com telhado curvo vira um recorte em arco (arcadas, pórticos).
  // Plano/terraço: a platibanda vem do grupo (contorno da união), não do volume sozinho.
  const roof = (s.op === 'subtract' || noParapet) && flatRoof(s) ? null : roofMesh(s, rings, table);
  if (!roof) return body;
  const parts = roof.parts.filter((p) => !p.empty).map((p) => scope.keep(p.toManifold(k)));
  const good = parts.filter((p) => p.status() === 'NoError' && !p.isEmpty());
  return good.length ? scope.keep(k.Manifold.union([body, ...good])) : body;
}

function withPlinths(b: Building3, acc: Manifold, table: FaceTable, scope: Scope, hidden: (s: Solid) => boolean): Manifold {
  const k = kernel();
  const ps = b.solids.filter((s) => !hidden(s)).map((s) => plinthManifold(s, table, scope)).filter((m): m is Manifold => !!m);
  if (!ps.length) return acc;
  let band = scope.keep(k.Manifold.union(ps));
  // Recortes escondidos continuam recortando (são operações, não objetos).
  const cutters = b.solids.filter((s) => s.op === 'subtract').map((s) => solidManifold(s, new FaceTable(), scope)).filter((m): m is Manifold => !!m);
  if (cutters.length) band = scope.keep(band.subtract(scope.keep(k.Manifold.union(cutters))));
  return scope.keep(acc.add(band));
}

/** Embasamento: faixa saliente no pé das paredes (volumes que tocam o chão). */
function plinthManifold(s: Solid, table: FaceTable, scope: Scope): Manifold | null {
  if (s.op !== 'add' || !(s.plinth > 0.05) || s.base > 0.3) return null;
  const k = kernel();
  const rings = solidRings(s);
  const pid = table.add({ kind: 'plinth', solid: s.id });
  const out = offsetRing(rings.outer.pts, rings.outer.pts.map(() => -0.04));
  if (!ringValid(out, 1)) return null;
  const mb = new MeshBuilder();
  heightPrism(mb, out, rings.holes.map((h) => offsetRing(h.pts, h.pts.map(() => -0.04))), [], () => s.base + Math.min(s.plinth, s.height * 0.4), s.base - 0.02, { top: () => pid, bottom: pid, side: () => pid });
  const pm = scope.keep(mb.toManifold(k));
  return pm.status() === 'NoError' && !pm.isEmpty() ? pm : null;
}

export function evaluateBuilding(b: Building3, opts: EvalOptions = {}, project?: Pick<Project3, 'types'>): Evaluated {
  const t0 = performance.now();
  const k = kernel();
  const scope = new Scope();
  const table = new FaceTable();
  const warnings: string[] = [];
  const hidden = opts.hidden ?? ((s: Solid) => !!s.hidden);
  try {
    let acc: Manifold | null = null;
    // Grupos de volumes planos com o mesmo topo: platibanda única, posta logo
    // depois do último membro (os recortes seguintes também a cortam).
    const groups = new Map<number, Solid[]>();
    const groupEnd = new Map<number, Solid[]>();
    b.solids.forEach((s) => {
      if (s.op !== 'add' || hidden(s) || !flatRoof(s)) return;
      const key = topKey(s);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(s);
    });
    for (const g of groups.values()) groupEnd.set(b.solids.indexOf(g[g.length - 1]!), g);
    const covered = new Map(b.solids.map((s) => [s.id, coveredEdges(s, b.solids, hidden)]));
    for (const [i, s] of b.solids.entries()) {
      if (s.op === 'add' && hidden(s)) continue;
      const m = solidManifold(s, table, scope, true, covered.get(s.id));
      if (!m) {
        warnings.push(`${s.name}: forma inválida, ignorada.`);
        continue;
      }
      if (s.op === 'add') acc = acc ? scope.keep(acc.add(m)) : m;
      else if (!acc) warnings.push(`${s.name}: nada para ${s.op === 'subtract' ? 'recortar' : 'intersectar'} antes dele.`);
      else if (s.op === 'subtract') acc = scope.keep(acc.subtract(m));
      else acc = scope.keep(acc.intersect(m));
      const g = groupEnd.get(i);
      if (g && acc) for (const p of groupParapet(g, table, scope, (x) => covered.get(x.id))) acc = scope.keep(acc.add(p));
    }
    const parts = emptyParts3();
    let placements: Placement[] = [];
    if (acc && !opts.preview) {
      // Fachada sobre o sólido antes dos vãos: a parte visível de cada lado.
      const shell0 = toShell(acc);
      const regions = edgeRegions(shell0, table.faces);
      const types = typeResolver(project);
      const roofY = roofHeight(shell0);
      const items = itemPlacements(b, regions, types, roofY, warnings);
      for (const s of b.solids) if (!hidden(s) && s.op === 'add') placements.push(...rulePlacements(b, s, regions, types, warnings, [...items]));
      placements.push(...items);
      // Vãos: um sólido só com todos os recortes.
      const cuts: Manifold[] = [];
      for (const pl of placements) {
        if (!pl.opening) continue;
        const o = pl.opening;
        const reveal = table.add({ kind: 'reveal', solid: pl.tag.solid ?? pl.host?.solid ?? '', ...(pl.tag.item ? { item: pl.tag.item } : {}) });
        const mb = new MeshBuilder();
        prismMesh(mb, openingProfile(o.shape, o.w, o.h, 12), -o.depth, 0.6, pl.frame, reveal);
        const cm = scope.keep(mb.toManifold(k));
        if (cm.status() === 'NoError' && !cm.isEmpty()) cuts.push(cm);
        // Cômodo atrás do vão: interior de verdade visto pelo vidro (paralaxe exata).
        const room = o.room && o.room > 0.2 && pl.host ? roomFit(b, pl, o) : null;
        if (room && pl.host) {
          const rb = new MeshBuilder();
          const ids = { floor: table.add({ kind: 'roomFloor', solid: pl.host.solid }), ceil: table.add({ kind: 'roomCeil', solid: pl.host.solid }), wall: table.add({ kind: 'roomWall', solid: pl.host.solid }) };
          roomBox(rb, pl.frame, room.hx, -room.below + 0.03, room.above, -room.depth, -o.depth + 0.002, ids);
          const rm = scope.keep(rb.toManifold(k));
          if (rm.status() === 'NoError' && !rm.isEmpty()) cuts.push(rm);
        }
      }
      // Embasamento depois da fachada (não esconde o pé das portas), sem atravessar recortes.
      acc = withPlinths(b, acc, table, scope, hidden);
      if (cuts.length) acc = scope.keep(acc.subtract(scope.keep(k.Manifold.union(cuts))));
      for (const pl of placements) {
        const tag = parts.tags.push(pl.tag) - 1;
        pl.family.build(pl.params, new FrameSink(parts, pl.frame, tag), { length: pl.length, reveal: pl.opening?.depth ?? 0, index: 0, ...(pl.path ? { path: pl.path } : {}) });
      }
    }
    if (acc && opts.preview) acc = withPlinths(b, acc, table, scope, hidden);
    if (acc && opts.cutY !== undefined) acc = scope.keep(acc.trimByPlane([0, -1, 0], -opts.cutY));
    const shell = acc ? toShell(acc) : emptyShell();
    void placements;
    return { shell, parts, placements, faces: table.faces, warnings, ms: performance.now() - t0 };
  } finally {
    scope.dispose();
  }
}

/**
 * Cômodo atrás de um vão, limitado ao interior do volume que o hospeda: não
 * passa da laje (topo do volume), não fura a parede oposta nem as laterais
 * perto dos cantos e não entra em recortes (pátios). Sem espaço: sem cômodo.
 */
function roomFit(b: Building3, pl: Placement, o: { w: number; depth: number; room?: number }): { hx: number; below: number; above: number; depth: number } | null {
  const host = b.solids.find((x) => x.id === pl.host!.solid);
  if (!host) return null;
  const lv = levelAround(b, pl);
  const y = pl.frame[13]!;
  const SLAB = 0.25,
    WALL = 0.2;
  const above = Math.min(lv.above - 0.12, host.base + host.height - y - SLAB);
  const below = Math.min(lv.below, y - host.base - 0.02);
  if (above < 0.5) return null;
  const inner = offsetRing(sampleRing(oriented(host.plan.outer, 1)).pts, sampleRing(oriented(host.plan.outer, 1)).pts.map(() => WALL));
  if (!ringValid(inner, 1)) return null;
  const y0 = y - below,
    y1 = y + above;
  const cutters = b.solids
    .filter((x) => x.op === 'subtract' && x.base < y1 && x.base + x.height > y0)
    .map((x) => offsetRing(sampleRing(oriented(x.plan.outer, 1)).pts, sampleRing(oriented(x.plan.outer, 1)).pts.map(() => -WALL)));
  const holes = host.plan.holes.map((h) => offsetRing(sampleRing(oriented(h, -1)).pts, sampleRing(oriented(h, -1)).pts.map(() => WALL)));
  const free = (p: Vec2) => inside(p, inner) && !holes.some((h) => inside(p, h)) && !cutters.some((c) => inside(p, c));
  const m = pl.frame;
  const c: Vec2 = [m[12]!, m[14]!];
  const ul = Math.hypot(m[0]!, m[2]!) || 1,
    nl = Math.hypot(m[8]!, m[10]!) || 1;
  const u: Vec2 = [m[0]! / ul, m[2]! / ul],
    n: Vec2 = [m[8]! / nl, m[10]! / nl];
  const at = (x: number, z: number): Vec2 => [c[0] + u[0] * x + n[0] * z, c[1] + u[1] * x + n[1] * z];
  const fits = (hx: number, d: number) => {
    // Cantos e meio de cada borda do retângulo em planta.
    for (const x of [-hx, 0, hx]) for (const z of [-o.depth - 0.05, -(o.depth + d) / 2 - 0.01, -d]) if (!free(at(x, z))) return false;
    return true;
  };
  const minHx = o.w / 2 + 0.03;
  const minD = o.depth + 0.4;
  if (!fits(minHx, minD)) return null;
  // Maior profundidade e depois maior largura que cabem (busca binária).
  let lo = minD,
    hi = o.depth + (o.room ?? 0);
  if (fits(minHx, hi)) lo = hi;
  else for (let k = 0; k < 10; k++) (fits(minHx, (lo + hi) / 2) ? (lo = (lo + hi) / 2) : (hi = (lo + hi) / 2));
  const depth = lo;
  let a = minHx,
    z = o.w / 2 + 0.9;
  if (fits(z, depth)) a = z;
  else for (let k = 0; k < 10; k++) (fits((a + z) / 2, depth) ? (a = (a + z) / 2) : (z = (a + z) / 2));
  return { hx: a, below, above, depth };
}

/** Piso e teto do pavimento em volta de uma peça (distâncias a partir da base da peça). */
function levelAround(b: Building3, pl: Placement): { below: number; above: number } {
  // Cota real da peça (em parede inclinada, host.y anda pela parede, não na vertical).
  const y = pl.frame[13]!;
  const lv = [...b.levels].sort((p, q) => p.elevation - q.elevation).filter((l) => l.elevation <= y + 0.01).pop();
  if (!lv) return { below: Math.min(1, pl.host!.y), above: 2.6 };
  return { below: y - lv.elevation, above: lv.elevation + lv.height - y };
}

/** Caixa (cômodo) no referencial da peça, com faces de piso, teto e paredes. */
function roomBox(mb: MeshBuilder, m: number[], hx: number, y0: number, y1: number, z0: number, z1: number, ids: { floor: number; ceil: number; wall: number }): void {
  if (y1 - y0 < 0.3) return;
  const P = (x: number, y: number, z: number): [number, number, number] => [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
  const N = (x: number, y: number, z: number): [number, number, number] => [m[0]! * x + m[4]! * y + m[8]! * z, m[1]! * x + m[5]! * y + m[9]! * z, m[2]! * x + m[6]! * y + m[10]! * z];
  const c = (sx: number, sy: number, sz: number) => P(sx < 0 ? -hx : hx, sy < 0 ? y0 : y1, sz < 0 ? z0 : z1);
  mb.quad(c(-1, -1, -1), c(1, -1, -1), c(1, -1, 1), c(-1, -1, 1), ids.floor, N(0, -1, 0));
  mb.quad(c(-1, 1, -1), c(1, 1, -1), c(1, 1, 1), c(-1, 1, 1), ids.ceil, N(0, 1, 0));
  mb.quad(c(-1, -1, -1), c(1, -1, -1), c(1, 1, -1), c(-1, 1, -1), ids.wall, N(0, 0, -1));
  mb.quad(c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1), ids.wall, N(0, 0, 1));
  mb.quad(c(-1, -1, -1), c(-1, 1, -1), c(-1, 1, 1), c(-1, -1, 1), ids.wall, N(-1, 0, 0));
  mb.quad(c(1, -1, -1), c(1, 1, -1), c(1, 1, 1), c(1, -1, 1), ids.wall, N(1, 0, 0));
}

/** Altura do telhado (maior y entre triângulos voltados para cima sob o ponto). */
export function roofHeight(sh: Shell): (x: number, z: number) => number {
  const P = sh.positions,
    I = sh.indices;
  return (x, z) => {
    let best = 0;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t]! * 3,
        b = I[t + 1]! * 3,
        c = I[t + 2]! * 3;
      const ax = P[a]!, az = P[a + 2]!, bx = P[b]!, bz = P[b + 2]!, cx = P[c]!, cz = P[c + 2]!;
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(det) < 1e-12) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const y = l1 * P[a + 1]! + l2 * P[b + 1]! + l3 * P[c + 1]!;
      if (y > best) best = y;
    }
    return best;
  };
}

export function emptyShell(): Shell {
  return { positions: new Float32Array(0), indices: new Uint32Array(0), faceOf: new Uint32Array(0) };
}

export function toShell(m: Manifold): Shell {
  const mesh = m.getMesh();
  return {
    // Todas as entradas têm só posição (numProp = 3).
    positions: new Float32Array(mesh.vertProperties),
    indices: new Uint32Array(mesh.triVerts),
    faceOf: new Uint32Array(mesh.faceID),
  };
}

export { MeshBuilder };
