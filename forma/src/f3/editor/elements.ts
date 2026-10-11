// Seleção de elementos de fachada (janelas, portas, sacadas, vitrines…) como as
// ferramentas de seleção do Editable Poly do 3ds Max: Fileira (Loop: o mesmo
// pavimento em todas as faces), Coluna (Ring: a mesma prumada em todos os
// pavimentos), Crescer/Encolher (vizinhos na grade lado × pavimento × posição),
// mesmo tipo, mesma face e deslocar a seleção. Sem three.
import type { Placement } from '../eval/facade';

export interface Elem {
  key: string;
  pl: Placement;
  /** Lado (sólido|aresta), pavimento e posição ao longo (m). */
  side: string;
  level: number;
  s: number;
  type: string;
}

/** Chave estável de um elemento: regra+posição ou componente+cópia. */
export function elemKey(pl: Placement): string | null {
  if (pl.tag.rule && pl.tag.key) return `r|${pl.tag.solid}|${pl.tag.rule}|${pl.tag.key}`;
  if (pl.tag.item) return `i|${pl.tag.item}|${pl.tag.key ?? '0'}`;
  return null;
}

/**
 * Elementos de um edifício avaliado: os presos a faces (com lado e posição na
 * grade da fachada) e os componentes no chão, no telhado ou em caminho (cada
 * um num "lado" só dele, para Fileira/Coluna não os misturarem).
 */
export function elementsOf(placements: Placement[], typeOf: (pl: Placement) => string, levelOf: (pl: Placement) => number): Elem[] {
  const out: Elem[] = [];
  for (const pl of placements) {
    const key = elemKey(pl);
    if (!key) continue;
    const level = levelOf(pl);
    if (pl.host) out.push({ key, pl, side: `${pl.host.solid}|${pl.host.edge}`, level, s: pl.host.s, type: typeOf(pl) });
    else out.push({ key, pl, side: `free|${key}`, level, s: 0, type: typeOf(pl) });
  }
  return out;
}

const COL_TOL = 0.45;

/** Fileira: o mesmo pavimento em todas as faces (a faixa horizontal do prédio). */
export function row(all: Elem[], sel: Set<string>): Set<string> {
  const levels = new Set(all.filter((e) => sel.has(e.key)).map((e) => e.level));
  return new Set(all.filter((e) => levels.has(e.level)).map((e) => e.key));
}

/** Fileira só na mesma face. */
export function rowOnFace(all: Elem[], sel: Set<string>): Set<string> {
  const keys = new Set(all.filter((e) => sel.has(e.key)).map((e) => `${e.side}#${e.level}`));
  return new Set(all.filter((e) => keys.has(`${e.side}#${e.level}`)).map((e) => e.key));
}

/** Coluna: a mesma prumada (mesmo lado e posição) em todos os pavimentos. */
export function column(all: Elem[], sel: Set<string>): Set<string> {
  const picked = all.filter((e) => sel.has(e.key));
  return new Set(all.filter((e) => picked.some((p) => p.side === e.side && Math.abs(p.s - e.s) < COL_TOL)).map((e) => e.key));
}

/** Vizinhos imediatos na grade: ao lado (mesmo pavimento) e acima/abaixo (mesma prumada). */
function neighbours(all: Elem[], e: Elem): Elem[] {
  const same = all.filter((x) => x.side === e.side && x !== e);
  const out: Elem[] = [];
  const rowMates = same.filter((x) => x.level === e.level).sort((a, b) => a.s - b.s);
  const left = rowMates.filter((x) => x.s < e.s).pop();
  const right = rowMates.find((x) => x.s > e.s);
  if (left) out.push(left);
  if (right) out.push(right);
  for (const dl of [-1, 1]) {
    const up = same.filter((x) => x.level === e.level + dl && Math.abs(x.s - e.s) < COL_TOL);
    if (up[0]) out.push(up[0]);
  }
  return out;
}

export function grow(all: Elem[], sel: Set<string>): Set<string> {
  const out = new Set(sel);
  for (const e of all) if (sel.has(e.key)) for (const n of neighbours(all, e)) out.add(n.key);
  return out;
}

export function shrink(all: Elem[], sel: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const e of all) {
    if (!sel.has(e.key)) continue;
    const ns = neighbours(all, e);
    // Fica só quem tem todos os vizinhos da grade também selecionados.
    if (ns.length && ns.every((n) => sel.has(n.key))) out.add(e.key);
  }
  return out;
}

export function sameType(all: Elem[], sel: Set<string>): Set<string> {
  const types = new Set(all.filter((e) => sel.has(e.key)).map((e) => e.type));
  return new Set(all.filter((e) => types.has(e.type)).map((e) => e.key));
}

export function sameFace(all: Elem[], sel: Set<string>): Set<string> {
  const sides = new Set(all.filter((e) => sel.has(e.key)).map((e) => e.side));
  return new Set(all.filter((e) => sides.has(e.side)).map((e) => e.key));
}

/** Desloca a seleção (Loop/Ring Shift): ←→ ao longo da fileira, ↑↓ entre pavimentos. */
export function shift(all: Elem[], sel: Set<string>, dir: 'left' | 'right' | 'up' | 'down'): Set<string> {
  const out = new Set<string>();
  for (const e of all) {
    if (!sel.has(e.key)) continue;
    const same = all.filter((x) => x.side === e.side);
    let n: Elem | undefined;
    if (dir === 'up' || dir === 'down') n = same.find((x) => x.level === e.level + (dir === 'up' ? 1 : -1) && Math.abs(x.s - e.s) < COL_TOL);
    else {
      // s cresce no sentido u da face, que fica à esquerda de quem olha a fachada de fora.
      const mates = same.filter((x) => x.level === e.level).sort((a, b) => a.s - b.s);
      const i = mates.indexOf(e);
      n = mates[i + (dir === 'right' ? -1 : 1)];
    }
    out.add((n ?? e).key);
  }
  return out;
}

/** Todos os elementos entre dois (mesmo lado e pavimento: trecho da fileira). */
export function between(all: Elem[], a: string, b: string): Set<string> {
  const A = all.find((e) => e.key === a),
    B = all.find((e) => e.key === b);
  if (!A || !B) return new Set([a, b]);
  if (A.side === B.side && A.level === B.level) {
    const lo = Math.min(A.s, B.s),
      hi = Math.max(A.s, B.s);
    return new Set(all.filter((e) => e.side === A.side && e.level === A.level && e.s >= lo - 1e-6 && e.s <= hi + 1e-6).map((e) => e.key));
  }
  if (A.side === B.side && Math.abs(A.s - B.s) < COL_TOL) {
    const lo = Math.min(A.level, B.level),
      hi = Math.max(A.level, B.level);
    return new Set(all.filter((e) => e.side === A.side && Math.abs(e.s - A.s) < COL_TOL && e.level >= lo && e.level <= hi).map((e) => e.key));
  }
  return new Set([a, b]);
}

/** Linha dos grupos automáticos: categoria (0), tipo (1) ou variação de um tipo (2). */
export interface GroupRow {
  id: string;
  label: string;
  depth: 0 | 1 | 2;
  keys: string[];
}

/**
 * Grupos automáticos dos elementos de um edifício: por categoria da família
 * (Janelas, Portas…), dentro dela por tipo, e as variações debaixo do tipo de
 * origem. O tipo leva junto as variações (é o "grupo das janelas de abrir");
 * a variação, só as dela. Categorias na ordem dada; tipos do mais usado.
 */
export function groupElements(all: Elem[], info: (type: string) => { name: string; category: string; base?: string } | undefined, catName: (c: string) => string, order: readonly string[]): GroupRow[] {
  const byType = new Map<string, string[]>();
  for (const e of all) {
    const k = byType.get(e.type);
    if (k) k.push(e.key);
    else byType.set(e.type, [e.key]);
  }
  // Raiz de cada tipo usado: o tipo de origem quando é uma variação de um tipo conhecido.
  const root = (t: string) => {
    const b = info(t)?.base;
    return b && b !== t && info(b) ? b : t;
  };
  const cats = new Map<string, Map<string, string[]>>();
  for (const t of byType.keys()) {
    const i = info(t);
    if (!i) continue;
    const r = root(t);
    const c = info(r)?.category ?? i.category;
    const m = cats.get(c) ?? new Map<string, string[]>();
    cats.set(c, m);
    const list = m.get(r) ?? [];
    if (!list.includes(t)) list.push(t);
    m.set(r, list);
  }
  const rank = (c: string) => (order.indexOf(c) < 0 ? order.length : order.indexOf(c));
  const out: GroupRow[] = [];
  for (const [c, roots] of [...cats].sort((a, b) => rank(a[0]) - rank(b[0]))) {
    const keysOf = (ts: string[]) => ts.flatMap((t) => byType.get(t) ?? []);
    const rows = [...roots].map(([r, ts]) => ({ r, ts, keys: keysOf([r, ...ts.filter((t) => t !== r)]) })).sort((a, b) => b.keys.length - a.keys.length);
    out.push({ id: `c:${c}`, label: catName(c), depth: 0, keys: rows.flatMap((x) => x.keys) });
    for (const { r, ts, keys } of rows) {
      out.push({ id: `t:${r}`, label: info(r)!.name, depth: 1, keys });
      for (const t of ts.filter((x) => x !== r)) out.push({ id: `v:${t}`, label: info(t)!.name, depth: 2, keys: byType.get(t) ?? [] });
    }
  }
  return out;
}
