import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { HumanBase, verticalExtent, type HumanBaseMeta } from '@people/gen/humanBase';
import { sampleBody } from '@people/gen/sampleBody';

function load(name: string): HumanBase {
  const dir = `public/models/humans/${name}`;
  const meta = JSON.parse(readFileSync(`${dir}/base.json`, 'utf8')) as HumanBaseMeta;
  const buf = readFileSync(`${dir}/base.bin`);
  return new HumanBase(meta, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

describe.each(['vitruvian', 'mhr'])('human base %s', (name) => {
  const base = load(name);

  it('stands upright at a human height, facing +Z', () => {
    const [lo, hi] = verticalExtent(base.positions);
    expect(hi - lo).toBeGreaterThan(1.5);
    expect(hi - lo).toBeLessThan(2.0);
    // The nose is the most forward point of the head: in front of the body's middle.
    let noseZ = -Infinity, sumZ = 0;
    for (let v = 0; v < base.vertexCount; v++) {
      const y = base.positions[v * 3 + 1]!, z = base.positions[v * 3 + 2]!;
      sumZ += z;
      if (y > hi - 0.25) noseZ = Math.max(noseZ, z);
    }
    expect(noseZ).toBeGreaterThan(sumZ / base.vertexCount + 0.05);
  });

  it('random people stay between 1.4 and 2.05 m, with unit normals and no NaN', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 30; i++) {
      const body = sampleBody(base, rng.fork(`p${i}`), 'adult');
      const shape = base.shape(body.weights);
      const [lo, hi] = verticalExtent(shape);
      expect(hi - lo).toBeGreaterThan(1.4);
      expect(hi - lo).toBeLessThan(2.05);
      const n = base.renderNormals(shape);
      for (let r = 0; r < n.length; r += 3 * 97) {
        expect(Math.hypot(n[r]!, n[r + 1]!, n[r + 2]!)).toBeCloseTo(1, 3);
      }
      expect(shape.every(Number.isFinite)).toBe(true);
    }
  });

  it('a seam vertex gets one normal on both sides', () => {
    const shape = base.shape({});
    const n = base.renderNormals(shape);
    const seen = new Map<number, number>();
    for (let r = 0; r < base.renderVertexCount; r++) {
      const s = base.renderSource[r]!;
      const first = seen.get(s);
      if (first === undefined) { seen.set(s, r); continue; }
      expect(n[r * 3]).toBe(n[first * 3]);
      expect(n[r * 3 + 1]).toBe(n[first * 3 + 1]);
    }
  });
});

describe('vitruvian ages', () => {
  it('the baby morph makes a small child, the adult stays adult', () => {
    const base = load('vitruvian');
    const height = (w: Record<string, number>): number => { const [lo, hi] = verticalExtent(base.shape(w)); return hi - lo; };
    expect(height({ Age_Baby: 1 })).toBeLessThan(1.0);
    expect(height({ Age_Baby: 0.5 })).toBeLessThan(height({}));
  });
});

describe('vitruvian with the MHR shape', () => {
  const base = load('vitruvian');
  /** Longest edge stretch against the base, over the skin's triangles. */
  function worstStretch(shape: Float32Array): number {
    const src = base.renderSource, idx = base.index, p0 = base.positions;
    let worst = 1;
    for (let t = 0; t < idx.length; t += 3) {
      for (const [i, j] of [[0, 1], [1, 2], [2, 0]] as const) {
        const a = src[idx[t + i]!]! * 3, b = src[idx[t + j]!]! * 3;
        const l0 = Math.hypot(p0[a]! - p0[b]!, p0[a + 1]! - p0[b + 1]!, p0[a + 2]! - p0[b + 2]!);
        // Edges under 2 mm (eyelid rims, nails) stretch by a ratio no eye can see.
        if (l0 < 0.002) continue;
        const l1 = Math.hypot(shape[a]! - shape[b]!, shape[a + 1]! - shape[b + 1]!, shape[a + 2]! - shape[b + 2]!);
        worst = Math.max(worst, l1 / l0);
      }
    }
    return worst;
  }

  it('the inside of the mouth never comes out in front of the lips', () => {
    const material = new Array<string>(base.vertexCount);
    for (const g of base.meta.groups) for (let i = g.start; i < g.start + g.count; i++) material[base.renderSource[base.index[i]!]!] = g.material;
    const mouth = [...material.keys()].filter((v) => material[v] === 'Mouth');
    const check = (w: Record<string, number>): void => {
      const s = base.shape(w);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, front = -Infinity;
      for (const v of mouth) {
        x0 = Math.min(x0, s[v * 3]!); x1 = Math.max(x1, s[v * 3]!);
        y0 = Math.min(y0, s[v * 3 + 1]!); y1 = Math.max(y1, s[v * 3 + 1]!);
        front = Math.max(front, s[v * 3 + 2]!);
      }
      let skin = -Infinity;
      for (let v = 0; v < base.vertexCount; v++) {
        if (material[v] !== 'Skin') continue;
        const x = s[v * 3]!, y = s[v * 3 + 1]!;
        if (x > x0 && x < x1 && y > y0 && y < y1) skin = Math.max(skin, s[v * 3 + 2]!);
      }
      expect(front, JSON.stringify(w)).toBeLessThan(skin);
    };
    check({});
    for (let i = 20; i < 40; i++) for (const v of [-2.5, 2.5]) check({ [`MHR_Head_${i}`]: v });
    check({ Gender_Male: 1, MHR_Head_20: -2.5, MHR_Head_21: 2.5, MHR_Head_22: 2.5 });
  });

  it('has the 45 MHR components', () => {
    for (const g of ['Body', 'Head', 'Hands']) expect([...base.morphs.keys()].some((n) => n.startsWith(`MHR_${g}_`))).toBe(true);
    expect([...base.morphs.keys()].filter((n) => n.startsWith('MHR_')).length).toBe(45);
  });

  it('every component at +-2.5 sigma stretches no edge more than 3.5x (a tear was 19x)', () => {
    for (const name of [...base.morphs.keys()].filter((n) => n.startsWith('MHR_'))) {
      for (const v of [-2.5, 2.5]) expect(worstStretch(base.shape({ [name]: v })), `${name} ${v}`).toBeLessThan(3.5);
    }
  });
});
