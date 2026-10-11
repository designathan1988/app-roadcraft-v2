// Ferramentas rápidas de edifício: pavimentos, recuo no topo, embasamento,
// pátio e fachadas prontas. Operam no documento (sem three).
import type { Building3, FacadeRule, Solid } from './schema';
import { facadeRule, levelsFor, planVertices, roofSpec, solid, uid } from './defaults';
import { offsetRing, oriented, ringValid, sampleRing } from './plan';
import { levelsUpTo } from './modeling';
import { inside, planCenter } from './ops';

const levelsSorted = (b: Building3) => [...b.levels].sort((p, q) => p.elevation - q.elevation);
const topOf = (b: Building3) => {
  const lv = levelsSorted(b);
  const last = lv[lv.length - 1];
  return last ? last.elevation + last.height : 0;
};

/**
 * Topos possíveis para um volume que sobe de andar em andar: o topo de cada
 * pavimento acima da base e, além do último, mais pavimentos da altura típica
 * (até 60 no edifício).
 */
export function floorTops(b: Building3, base: number): number[] {
  const lv = levelsSorted(b);
  const typ = lv[1]?.height ?? lv[0]?.height ?? 3;
  const tops = lv.map((l) => l.elevation + l.height).filter((t) => t > base + 0.3);
  let t = topOf(b);
  for (let i = lv.length; i < 60; i++) {
    t += typ;
    if (t > base + 0.3) tops.push(t);
  }
  return tops;
}

/** O topo de andar mais perto de `want` (no mínimo um andar acima da base). */
export function snapToFloor(b: Building3, base: number, want: number): number {
  const tops = floorTops(b, base);
  let best = tops[0] ?? base + 3;
  for (const t of tops) if (Math.abs(t - want) < Math.abs(best - want)) best = t;
  return best;
}

/**
 * Pavimentos do edifício acompanham os volumes: faltando, acrescenta da
 * altura típica até cobrir o volume mais alto; sobrando (acima de todos),
 * tira. Os pavimentos que continuam mantêm o ID.
 */
export function fitLevels(b: Building3): void {
  const lv = levelsSorted(b);
  const typ = lv[1]?.height ?? lv[0]?.height ?? 3;
  const add = b.solids.filter((s) => s.op === 'add' && !s.hidden);
  if (!add.length || !lv.length) return;
  const need = Math.max(...add.map((s) => s.base + s.height));
  // Pavimento novo só quando o volume passa mais de meio andar do último (platibanda, caixa d'água não contam).
  while (lv.length < 60 && lv[lv.length - 1]!.elevation + lv[lv.length - 1]!.height < need - typ / 2) {
    const last = lv[lv.length - 1]!;
    lv.push({ id: uid(), name: `${lv.length}º pavimento`, elevation: last.elevation + last.height, height: typ });
  }
  while (lv.length > 1 && lv[lv.length - 1]!.elevation >= need - 0.05) lv.pop();
  b.levels = lv;
}

/**
 * Volumes apoiados em cima de `sid`, em cadeia (recuo sobre a torre, caixa
 * d'água sobre o recuo): a base encosta no topo de quem carrega e o centro
 * cai dentro da planta dele. Quando o de baixo cresce, eles sobem junto.
 */
export function riders(b: Building3, sid: string): Solid[] {
  const out: Solid[] = [];
  const queue = b.solids.filter((x) => x.id === sid);
  while (queue.length) {
    const c = queue.shift()!;
    const ring = sampleRing(oriented(c.plan.outer, 1)).pts;
    for (const x of b.solids) {
      if (x === c || out.includes(x) || x.id === sid) continue;
      if (Math.abs(x.base - (c.base + c.height)) < 0.05 && inside(planCenter(x), ring)) {
        out.push(x);
        queue.push(x);
      }
    }
  }
  return out;
}

/** Quantos pavimentos um volume atravessa. */
export function floorsIn(b: Building3, s: Solid): number {
  return b.levels.filter((l) => l.elevation >= s.base - 0.05 && l.elevation < s.base + s.height - 0.05).length;
}

/**
 * Acrescenta (delta > 0) ou tira (delta < 0) pavimentos no corpo do prédio:
 * o volume mais alto que nasce no chão cresce (ou encolhe) de andar em andar
 * e tudo o que está em cima dele (recuo, coroa, telhado) sobe ou desce junto.
 * Nunca passa do térreo; os pavimentos que continuam mantêm o ID.
 */
export function changeLevels(b: Building3, delta: number): boolean {
  const lv = levelsSorted(b);
  if (!lv.length || !delta) return false;
  const typ = lv[1]?.height ?? lv[0]?.height ?? 3;
  const add = b.solids.filter((x) => x.op === 'add');
  const ground = add.filter((x) => x.base < 0.05);
  const pool = ground.length ? ground : add;
  // Onde os andares entram: no topo do corpo, arredondado para a divisa de pavimento mais próxima.
  const bodyTop = pool.length ? Math.max(...pool.map((x) => x.base + x.height)) : topOf(b);
  const bounds = [...lv.map((l) => l.elevation), topOf(b)];
  let j = 0;
  bounds.forEach((y, i) => {
    if (Math.abs(y - bodyTop) < Math.abs(bounds[j]! - bodyTop)) j = i;
  });
  const E = bounds[j]!;
  let D: number;
  if (delta > 0) {
    if (lv.length + delta > 60) return false;
    D = delta * typ;
    const fresh = Array.from({ length: delta }, (_, i) => ({ id: uid(), name: '', elevation: E + i * typ, height: typ }));
    for (const l of lv.slice(j)) l.elevation += D;
    lv.splice(j, 0, ...fresh);
  } else {
    // Tira os pavimentos logo abaixo da divisa, sem tocar no térreo.
    const k = Math.min(-delta, j - 1);
    if (k < 1) return false;
    const gone = lv.splice(j - k, k);
    D = -gone.reduce((a, l) => a + l.height, 0);
    for (const l of lv.slice(j - k)) l.elevation += D;
  }
  // Nomes no padrão seguem a numeração; nome dado pelo usuário fica.
  lv.forEach((l, i) => {
    if (!l.name || /^(Térreo|\d+º pavimento)$/.test(l.name)) l.name = i === 0 ? 'Térreo' : `${i}º pavimento`;
  });
  b.levels = lv;
  // Quem cresce e quem sobe é decidido pelo topo real do corpo (pode não cair numa divisa).
  const T = Math.min(E, bodyTop);
  for (const x of b.solids) {
    if (x.base >= T - 0.05) x.base += D;
    else if (x.base + x.height >= T - 0.05) x.height = Math.max(0.5, x.height + D);
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
    // O recuo é andar de cima: regras do térreo (portas, lojas) ficam no volume de baixo.
    facade: s.facade.filter((f) => f.levels !== 'ground').map((f) => ({ ...structuredClone(f), id: uid(), edges: [], except: {} })),
    materials: structuredClone(s.materials),
    plinth: 0,
  });
  s.roof = roofSpec('terrace');
  b.solids.push(n);
  // Níveis novos sem esticar nada (o volume de baixo continua com a altura dele).
  levelsUpTo(b, n.base + n.height);
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
  { id: 'bal', name: 'Com sacadas', rules: () => [facadeRule('door-double', { levels: 'ground', mode: 'count', value: 1 }), facadeRule('win-casement', { levels: 'ground', mode: 'max', value: 3 }), facadeRule('balcony-glass', { levels: 'upper', mode: 'max', value: 3.6 })] },
  { id: 'ind', name: 'Industrial', rules: () => [facadeRule('loading-dock', { levels: 'ground', mode: 'count', value: 1 }), facadeRule('win-industrial', { mode: 'max', value: 4.5 })] },
  { id: 'blank', name: 'Cega (sem aberturas)', rules: () => [] },
];
