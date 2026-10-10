// Ferramentas rápidas de edifício: pavimentos, recuo no topo, embasamento,
// pátio e fachadas prontas. Operam no documento (sem three).
import type { Building3, FacadeRule, Solid } from './schema';
import { facadeRule, levelsFor, planVertices, roofSpec, solid, uid } from './defaults';
import { offsetRing, oriented, ringValid, sampleRing } from './plan';

const levelsSorted = (b: Building3) => [...b.levels].sort((p, q) => p.elevation - q.elevation);
const topOf = (b: Building3) => {
  const lv = levelsSorted(b);
  const last = lv[lv.length - 1];
  return last ? last.elevation + last.height : 0;
};

/** Acrescenta (+1) ou tira (−1) um pavimento; volumes que vão até o topo acompanham. */
export function changeLevels(b: Building3, delta: number): boolean {
  const lv = levelsSorted(b);
  const n = lv.length + delta;
  if (n < 1 || n > 60) return false;
  const typ = lv[1]?.height ?? lv[0]?.height ?? 3;
  const oldTop = topOf(b);
  b.levels = levelsFor(n, typ, lv[0]?.height ?? typ);
  // Mantém os IDs dos níveis que continuam (componentes e interiores apontam para eles).
  b.levels.forEach((l, i) => {
    if (lv[i]) l.id = lv[i]!.id;
  });
  const newTop = topOf(b);
  for (const s of b.solids) {
    const top = s.base + s.height;
    if (Math.abs(top - oldTop) < 0.6) s.height = Math.max(0.5, newTop - s.base);
    else if (s.base >= oldTop - 0.6) s.base += newTop - oldTop;
  }
  return true;
}

/** Recuo no topo: um volume recuado sobre o sólido; o de baixo vira terraço. */
export function setbackOn(b: Building3, s: Solid, inset = 2, levels = 1): Solid | null {
  const r = sampleRing(oriented(s.plan.outer, 1));
  const top = offsetRing(r.pts, r.pts.map(() => inset + s.taper));
  if (!ringValid(top, 1)) return null;
  const typ = levelsSorted(b)[1]?.height ?? 3;
  const n = solid({
    name: `${s.name} (recuo)`,
    plan: { outer: planVertices(top), holes: [] },
    base: s.base + s.height,
    height: typ * levels,
    roof: structuredClone(s.roof.kind === 'terrace' ? roofSpec('flat') : s.roof),
    facade: s.facade.map((f) => ({ ...structuredClone(f), id: uid(), edges: [], except: {} })),
    materials: structuredClone(s.materials),
    plinth: 0,
  });
  s.roof = roofSpec('terrace');
  b.solids.push(n);
  if (n.base + n.height > topOf(b) + 0.3) changeLevels(b, Math.round((n.base + n.height - topOf(b)) / typ));
  return n;
}

/** Embasamento: pódio mais largo no térreo, com lojas, unido ao edifício. */
export function podiumUnder(b: Building3, s: Solid, grow = 2.5): Solid | null {
  const r = sampleRing(oriented(s.plan.outer, 1));
  const ring = offsetRing(r.pts, r.pts.map(() => -grow));
  if (!ringValid(ring, 1)) return null;
  const ground = levelsSorted(b)[0]?.height ?? 3.4;
  const n = solid({
    name: 'Embasamento',
    plan: { outer: planVertices(ring), holes: [] },
    base: 0,
    height: ground,
    roof: roofSpec('terrace'),
    facade: [facadeRule('shopfront', { levels: 'ground', mode: 'max', value: 5, margin: 0.6 })],
    materials: { ...structuredClone(s.materials), wall: { finish: 'stone', color: '#b9b1a3' } },
  });
  b.solids.unshift(n);
  // As regras do volume de cima param de pôr janela no térreo (agora é o pódio).
  for (const f of s.facade) if (f.levels === 'all') f.levels = 'upper';
  return n;
}

/** Pátio: recorte no meio do volume, com recuo `margin` das bordas. */
export function courtyardIn(b: Building3, s: Solid, margin = 6): Solid | null {
  const r = sampleRing(oriented(s.plan.outer, 1));
  const ring = offsetRing(r.pts, r.pts.map(() => margin));
  if (!ringValid(ring, 1)) return null;
  const n = solid({ name: 'Pátio', op: 'subtract', plan: { outer: planVertices(ring), holes: [] }, base: s.base + (levelsSorted(b)[0]?.height ?? 0) * 0, height: s.height + 2, roof: roofSpec('flat', { parapet: 0 }), plinth: 0 });
  n.base = s.base - 0.5;
  b.solids.push(n);
  return n;
}

/**
 * Lado da frente de um volume: o da porta que já existe (regra de porta com
 * lado escolhido) ou o lado reto mais comprido voltado para a frente (+z).
 */
export function frontEdge(s: Solid): string | undefined {
  const door = s.facade.find((f) => f.mode === 'count' && f.edges.length);
  if (door) return door.edges[0];
  const r = sampleRing(oriented(s.plan.outer, 1));
  let best: { id: string; score: number } | undefined;
  r.segs.forEach((seg, i) => {
    if (seg.edge.endsWith(':c') || seg.curved) return;
    const a = r.pts[i]!,
      b = r.pts[(i + 1) % r.pts.length]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // Normal para fora (anel anti-horário): (dz, −dx)/l; preferir a que olha para +z.
    const nz = -(b[0] - a[0]) / (l || 1);
    const score = l * (1.5 + nz);
    if (!best || score > best.score + 1e-6) best = { id: seg.edge, score };
  });
  return best?.id;
}

/** Regras de uma fachada pronta para o volume (a porta só no lado da frente). */
export function presetRules(id: string, s: Solid): FacadeRule[] {
  const pr = FACADE_PRESETS.find((f) => f.id === id);
  if (!pr) return s.facade;
  const front = frontEdge(s);
  return pr.rules().map((r) => (r.mode === 'count' && r.levels === 'ground' && front ? { ...r, edges: [front] } : r));
}

export const FACADE_PRESETS: { id: string; name: string; rules: () => FacadeRule[] }[] = [
  { id: 'res', name: 'Residencial', rules: () => [facadeRule('door-panel', { levels: 'ground', mode: 'count', value: 1 }), facadeRule('win-casement', { mode: 'max', value: 3 })] },
  { id: 'com', name: 'Comercial', rules: () => [facadeRule('shopfront', { levels: 'ground', mode: 'max', value: 5, margin: 0.6 }), facadeRule('win-sliding', { levels: 'upper', mode: 'spacing', value: 2.4 })] },
  { id: 'off', name: 'Escritórios', rules: () => [facadeRule('door-glass', { levels: 'ground', mode: 'count', value: 1 }), facadeRule('win-ribbon', { mode: 'max', value: 5, margin: 0.4 })] },
  { id: 'col', name: 'Colonial', rules: () => [facadeRule('door-arched', { levels: 'ground', mode: 'count', value: 1 }), facadeRule('win-sash', { mode: 'spacing', value: 2.6 })] },
  { id: 'mod', name: 'Moderna', rules: () => [facadeRule('door-glass', { levels: 'ground', mode: 'count', value: 1 }), facadeRule('win-tall', { mode: 'spacing', value: 2.2 })] },
  { id: 'bal', name: 'Com sacadas', rules: () => [facadeRule('door-double', { levels: 'ground', mode: 'count', value: 1 }), facadeRule('win-casement', { levels: 'ground', mode: 'max', value: 3 }), facadeRule('balcony-glass', { levels: 'upper', mode: 'spacing', value: 4.2 })] },
  { id: 'ind', name: 'Industrial', rules: () => [facadeRule('loading-dock', { levels: 'ground', mode: 'count', value: 1 }), facadeRule('win-industrial', { mode: 'max', value: 4.5 })] },
  { id: 'blank', name: 'Cega (sem aberturas)', rules: () => [] },
];
