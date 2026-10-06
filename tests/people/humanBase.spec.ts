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
