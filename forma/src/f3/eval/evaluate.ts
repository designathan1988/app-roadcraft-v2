// Avalia um edifício forma/3: sólidos (corpo + telhado) → booleanas na ordem
// da lista (como a pilha de modificadores do Blender) → vãos recortados →
// vazios dos pavimentos (modo oco) → malha final com a face de origem de cada
// triângulo. Puro (sem three); roda no worker ou no Node.
import type { Building3, Solid } from '../model/schema';
import { kernel, Scope, type Manifold } from '../kernel/kernel';
import { bodyMesh, solidRings } from './body';
import { FaceTable, type FaceInfo } from './faces';
import { roofMesh } from './roofs';
import { heightPrism, MeshBuilder, prismMesh } from './mesh';
import { offsetRing, ringValid } from '../model/plan';
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
export function solidManifold(s: Solid, table: FaceTable, scope: Scope): Manifold | null {
  const k = kernel();
  const rings = solidRings(s);
  if (rings.outer.pts.length < 3 || s.height <= 0.01) return null;
  const body = scope.keep(bodyMesh(s, rings, table).toManifold(k));
  if (body.status() !== 'NoError' || body.isEmpty()) return null;
  // Sólido de subtração com telhado curvo vira um recorte em arco (arcadas, pórticos).
  const roof = s.op === 'subtract' && (s.roof.kind === 'flat' || s.roof.kind === 'terrace') ? null : roofMesh(s, rings, table);
  if (!roof) return body;
  const parts = roof.parts.filter((p) => !p.empty).map((p) => scope.keep(p.toManifold(k)));
  const good = parts.filter((p) => p.status() === 'NoError' && !p.isEmpty());
  return good.length ? scope.keep(k.Manifold.union([body, ...good])) : body;
}

function withPlinths(b: Building3, acc: Manifold, table: FaceTable, scope: Scope): Manifold {
  const k = kernel();
  const ps = b.solids.map((s) => plinthManifold(s, table, scope)).filter((m): m is Manifold => !!m);
  if (!ps.length) return acc;
  let band = scope.keep(k.Manifold.union(ps));
  const cutters = b.solids.filter((s) => s.op === 'subtract' && !s.hidden).map((s) => solidManifold(s, new FaceTable(), scope)).filter((m): m is Manifold => !!m);
  if (cutters.length) band = scope.keep(band.subtract(scope.keep(k.Manifold.union(cutters))));
  return scope.keep(acc.add(band));
}

/** Embasamento: faixa saliente no pé das paredes (volumes que tocam o chão). */
function plinthManifold(s: Solid, table: FaceTable, scope: Scope): Manifold | null {
  if (s.op !== 'add' || s.hidden || !(s.plinth > 0.05) || s.base > 0.3) return null;
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
  try {
    let acc: Manifold | null = null;
    for (const s of b.solids) {
      if (s.hidden) continue;
      const m = solidManifold(s, table, scope);
      if (!m) {
        warnings.push(`${s.name}: forma inválida, ignorada.`);
        continue;
      }
      if (s.op === 'add') acc = acc ? scope.keep(acc.add(m)) : m;
      else if (!acc) warnings.push(`${s.name}: nada para ${s.op === 'subtract' ? 'recortar' : 'intersectar'} antes dele.`);
      else if (s.op === 'subtract') acc = scope.keep(acc.subtract(m));
      else acc = scope.keep(acc.intersect(m));
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
      for (const s of b.solids) if (!s.hidden && s.op === 'add') placements.push(...rulePlacements(b, s, regions, types, warnings, items));
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
      }
      // Embasamento depois da fachada (não esconde o pé das portas), sem atravessar recortes.
      acc = withPlinths(b, acc, table, scope);
      if (cuts.length) acc = scope.keep(acc.subtract(scope.keep(k.Manifold.union(cuts))));
      for (const pl of placements) {
        const tag = parts.tags.push(pl.tag) - 1;
        pl.family.build(pl.params, new FrameSink(parts, pl.frame, tag), { length: pl.length, reveal: pl.opening?.depth ?? 0, index: 0, ...(pl.path ? { path: pl.path } : {}) });
      }
    }
    if (acc && opts.preview) acc = withPlinths(b, acc, table, scope);
    if (acc && opts.cutY !== undefined) acc = scope.keep(acc.trimByPlane([0, -1, 0], -opts.cutY));
    const shell = acc ? toShell(acc) : emptyShell();
    void placements;
    return { shell, parts, placements, faces: table.faces, warnings, ms: performance.now() - t0 };
  } finally {
    scope.dispose();
  }
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
