// Divisão de uma fachada em pedaços, com a semântica do split do CGA:
// absolutos e relativos primeiro; a sobra vai para os flutuantes, na
// proporção dos valores; a repetição cabe quantas vezes der (com flutuantes,
// ajusta o número de cópias para preencher sem cortar). Se faltar espaço, os
// pedaços são consumidos em ordem: o que estoura é cortado e os seguintes somem.
import { parseSize, type SplitNode, type Tile } from './schema';

export interface Piece {
  u0: number;
  u1: number;
  tile: Tile;
}

type Flat = { kind: 'abs' | 'rel' | 'float'; value: number; tile: Tile };

const flatten = (nodes: SplitNode[]): Flat[] =>
  nodes.flatMap((n) => {
    if ('repeat' in n) return [];
    const s = parseSize(n.size);
    return s ? [{ ...s, tile: n.tile }] : [];
  });

const fixed = (f: Flat, L: number) => (f.kind === 'abs' ? f.value : f.kind === 'rel' ? f.value * L : 0);

export function resolveSplit(nodes: SplitNode[], L: number): Piece[] {
  if (!(L > 0)) return [];
  // Expande a repetição (no máximo uma por divisão).
  const ri = nodes.findIndex((n) => 'repeat' in n);
  let list: Flat[];
  if (ri < 0) list = flatten(nodes);
  else {
    const before = flatten(nodes.slice(0, ri)),
      after = flatten(nodes.slice(ri + 1));
    const group = flatten((nodes[ri] as { repeat: SplitNode[] }).repeat);
    const outside = [...before, ...after];
    const avail = L - outside.reduce((s, f) => s + fixed(f, L) + (f.kind === 'float' ? f.value : 0), 0);
    const gFixed = group.reduce((s, f) => s + fixed(f, L), 0);
    const gNominal = gFixed + group.reduce((s, f) => s + (f.kind === 'float' ? f.value : 0), 0);
    let n = 0;
    if (gNominal > 1e-9 && avail > 0) {
      const hasFloat = group.some((f) => f.kind === 'float');
      n = hasFloat ? Math.max(1, Math.round(avail / gNominal)) : Math.floor(avail / gNominal + 1e-9);
      if (gFixed > 1e-9) n = Math.min(n, Math.floor((L - outside.reduce((s, f) => s + fixed(f, L), 0)) / gFixed + 1e-9));
      n = Math.max(0, Math.min(n, 400));
    }
    list = [...before, ...Array.from({ length: n }, () => group).flat(), ...after];
  }
  const F = list.reduce((s, f) => s + fixed(f, L), 0);
  const W = list.reduce((s, f) => s + (f.kind === 'float' ? f.value : 0), 0);
  const left = L - F;
  const out: Piece[] = [];
  let u = 0;
  for (const f of list) {
    let size = f.kind === 'float' ? (left > 0 && W > 0 ? (left * f.value) / W : 0) : fixed(f, L);
    if (u + size > L + 1e-9) size = L - u; // estourou: corta
    if (size <= 1e-9) {
      if (u >= L - 1e-9) break;
      continue;
    }
    out.push({ u0: u, u1: u + size, tile: f.tile });
    u += size;
  }
  return out;
}
