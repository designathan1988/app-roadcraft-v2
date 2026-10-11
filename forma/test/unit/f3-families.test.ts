import { describe, expect, it } from 'vitest';
import { allFamilies, BUILTIN_TYPES, family } from '../../src/f3/families/index';
import { resolveParams } from '../../src/f3/families/family';
import { emptyParts3, FrameSink, identity } from '../../src/f3/eval/parts';
import { stairCount } from '../../src/f3/families/stairs';

function boundsOf(parts: ReturnType<typeof emptyParts3>) {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  let bad = 0;
  const add = (x: number, y: number, z: number) => {
    if (![x, y, z].every(Number.isFinite)) bad++;
    [x, y, z].forEach((v, i) => {
      lo[i] = Math.min(lo[i]!, v);
      hi[i] = Math.max(hi[i]!, v);
    });
  };
  for (const it of parts.inst) {
    const m = it.m;
    for (let k = 0; k < 8; k++) {
      const x = k & 1 ? 0.5 : -0.5,
        y = k & 2 ? 0.5 : -0.5,
        z = k & 4 ? 0.5 : -0.5;
      add(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);
    }
  }
  for (const me of parts.meshes) for (let i = 0; i < me.positions.length; i += 3) add(me.positions[i]!, me.positions[i + 1]!, me.positions[i + 2]!);
  return { lo, hi, bad };
}

describe('famílias de componentes', () => {
  it.each(allFamilies().map((f) => [f.id, f] as const))('%s gera peças válidas e coerentes com o tamanho', (_id, f) => {
    const p = resolveParams(f);
    const parts = emptyParts3();
    const [w, h, d] = f.size(p);
    f.build(p, new FrameSink(parts, identity(), 0), { length: w, reveal: 0.3, index: 0, ...(f.host === 'path' ? { path: [[0, 0, 0], [4, 0, 0], [4, 0, 3]] } : {}) });
    expect(parts.inst.length + parts.meshes.length).toBeGreaterThan(0);
    const b = boundsOf(parts);
    expect(b.bad).toBe(0);
    if (f.host !== 'path') {
      // Nada absurdamente fora da caixa declarada (folga para fundações, rufos, beirais).
      const span = Math.max(w, h, d) + 3;
      for (let i = 0; i < 3; i++) expect(b.hi[i]! - b.lo[i]!).toBeLessThan(span * 2.2);
    }
    const o = f.opening?.(p);
    if (o) {
      expect(o.w).toBeGreaterThan(0);
      expect(o.h).toBeGreaterThan(0);
    }
  });

  it('todo vão com vidro tem cômodo atrás (senão o vidro mostra o fundo do recorte)', () => {
    for (const f of allFamilies()) {
      const o = f.opening?.(resolveParams(f));
      if (!o) continue;
      const parts = emptyParts3();
      const p = resolveParams(f);
      f.build(p, new FrameSink(parts, identity(), 0), { length: f.size(p)[0], reveal: o.depth, index: 0 });
      const glass = parts.inst.some((i) => i.mat.slot === 'glass') || parts.meshes.some((m) => m.mat.slot === 'glass');
      if (glass) expect(o.room ?? 0, f.id).toBeGreaterThan(0.5);
    }
  });

  it('todo tipo incluído aponta para uma família registrada', () => {
    for (const t of BUILTIN_TYPES) expect(family(t.family), t.id).toBeDefined();
  });

  it('escada: degraus pelo espelho máximo', () => {
    expect(stairCount(3, 0.18)).toBe(17);
    expect(stairCount(2.88, 0.18)).toBe(16);
  });

  it('sacada estreita: a porta efetiva cabe nela e o tamanho declarado é o da laje', () => {
    const f = family('balcony')!;
    for (const width of [0.5, 1.2, 1.5, 3]) {
      const p = resolveParams(f, { width });
      const w = Math.max(1.2, width);
      expect(f.size(p)[0]).toBeCloseTo(w, 5);
      expect(f.opening!(p)!.w).toBeLessThanOrEqual(w - 0.2 + 1e-9);
      expect(f.opening!(p)!.w).toBeGreaterThanOrEqual(0.7);
    }
  });
});
