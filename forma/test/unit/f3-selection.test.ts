import { describe, expect, it } from 'vitest';
import { boxPicks, combine, marqueeRect, selMode } from '../../src/f3/editor/selection';

describe('seleção múltipla', () => {
  it('modificadores como no SketchUp: Ctrl soma, Shift alterna, Ctrl+Shift tira', () => {
    expect(selMode({ ctrlKey: false, shiftKey: false })).toBe('replace');
    expect(selMode({ ctrlKey: true, shiftKey: false })).toBe('add');
    expect(selMode({ ctrlKey: false, shiftKey: true })).toBe('toggle');
    expect(selMode({ ctrlKey: true, shiftKey: true })).toBe('remove');
    expect(selMode({ ctrlKey: false, shiftKey: false, metaKey: true })).toBe('add');
  });

  it('combina mantendo a ordem e o principal', () => {
    expect(combine(['a', 'b'], ['c', 'a'], 'replace')).toEqual(['c', 'a']);
    expect(combine(['a', 'b'], ['b', 'c'], 'add')).toEqual(['a', 'b', 'c']);
    expect(combine(['a', 'b'], ['b', 'c'], 'toggle')).toEqual(['a', 'c']);
    expect(combine(['a', 'b'], ['b', 'c'], 'remove')).toEqual(['a']);
  });

  it('caixa para a direita é janela; para a esquerda, cruzada', () => {
    expect(marqueeRect(10, 10, 50, 40)).toEqual({ rect: { x0: 10, y0: 10, x1: 50, y1: 40 }, window: true });
    expect(marqueeRect(50, 40, 10, 10).window).toBe(false);
  });

  it('janela pega só o que fica inteiro dentro; cruzada pega o que toca', () => {
    const r = { x0: 0, y0: 0, x1: 100, y1: 100 };
    const inside = [{ x: 10, y: 10, behind: false }, { x: 40, y: 50, behind: false }];
    const half = [{ x: 90, y: 10, behind: false }, { x: 140, y: 50, behind: false }];
    const out = [{ x: 120, y: 10, behind: false }, { x: 140, y: 50, behind: false }];
    expect(boxPicks(inside, r, true)).toBe(true);
    expect(boxPicks(half, r, true)).toBe(false);
    expect(boxPicks(half, r, false)).toBe(true);
    expect(boxPicks(out, r, false)).toBe(false);
    expect(boxPicks([{ x: 10, y: 10, behind: true }], r, false)).toBe(false);
  });
});
