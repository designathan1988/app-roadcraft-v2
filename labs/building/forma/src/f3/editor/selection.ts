// Regras de seleção comuns a edifícios, volumes e elementos (docs/SELECAO.md):
// modificadores como no SketchUp (Ctrl soma, Shift alterna, Ctrl+Shift tira) e
// caixa de seleção em janela (→, só o que fica inteiro dentro) ou cruzada (←,
// o que ela toca). Sem three.

export type SelMode = 'replace' | 'add' | 'toggle' | 'remove';

/** Modo de um clique ou caixa pelos modificadores (Cmd vale como Ctrl). */
export function selMode(e: { ctrlKey: boolean; shiftKey: boolean; metaKey?: boolean }): SelMode {
  const ctrl = e.ctrlKey || !!e.metaKey;
  return ctrl && e.shiftKey ? 'remove' : ctrl ? 'add' : e.shiftKey ? 'toggle' : 'replace';
}

/** Combina o que o gesto pegou com a seleção atual, mantendo a ordem (o primeiro é o principal). */
export function combine<T>(cur: readonly T[], picked: readonly T[], mode: SelMode): T[] {
  if (mode === 'replace') return [...new Set(picked)];
  const s = new Set(cur);
  for (const p of picked) {
    if (mode === 'add') s.add(p);
    else if (mode === 'remove') s.delete(p);
    else if (s.has(p)) s.delete(p);
    else s.add(p);
  }
  return [...s];
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Retângulo normalizado (x0 < x1, y0 < y1) e se é janela (arrastado para a direita). */
export function marqueeRect(ax: number, ay: number, bx: number, by: number): { rect: Rect; window: boolean } {
  return { rect: { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) }, window: bx >= ax };
}

/**
 * Pontos projetados de um objeto (cantos da caixa dele) contra a caixa de
 * seleção. Janela: todos dentro. Cruzada: o retângulo que os envolve encosta
 * na caixa. Ponto atrás da câmera: fora (não dá para ver o objeto inteiro).
 */
export function boxPicks(pts: readonly { x: number; y: number; behind: boolean }[], r: Rect, window: boolean): boolean {
  if (!pts.length || pts.some((p) => p.behind)) return false;
  if (window) return pts.every((p) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return x0 <= r.x1 && x1 >= r.x0 && y0 <= r.y1 && y1 >= r.y0;
}
