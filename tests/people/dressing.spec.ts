import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { HumanBase, type HumanBaseMeta } from '@people/gen/humanBase';
import { HumanExtras, REGION, beardMask, faceAnchors, type ExtrasMeta } from '@people/gen/extras';
import { GARMENT_TYPES, bodyFor, dressBody, garmentDefaults, type GarmentSlot } from '@people/gen/clothes';
import { HAIR_STYLES, browStrands, hairStrands, lashStrands } from '@people/gen/hair';
import { BROW_STYLES, randomPerson, resolvePerson } from '@people/gen/person';

const dir = 'public/models/humans/vitruvian';
const read = (f: string): ArrayBuffer => { const b = readFileSync(`${dir}/${f}`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const base = new HumanBase(JSON.parse(readFileSync(`${dir}/base.json`, 'utf8')) as HumanBaseMeta, read('base.bin'));
const ex = new HumanExtras(JSON.parse(readFileSync(`${dir}/extras.json`, 'utf8')) as ExtrasMeta, read('extras.bin'));
const person = randomPerson(base, new Rng(11), 30);
const shape = base.shape(resolvePerson(base, person).weights);
const body = bodyFor(base, ex, shape);

describe('hair, brows and lashes', () => {
  it.each(HAIR_STYLES.filter((s) => s !== 'none'))('%s grows strands, none of them under the skin', (style) => {
    const set = hairStrands(ex, base, body, { ...person.hair, style, length: 1, density: 0.5 }, 3);
    expect(set.counts.length).toBeGreaterThan(200);
    // Under the skin: within 1 mm of a head vertex but behind its normal.
    const head: number[] = [];
    for (let v = 0; v < ex.region.length; v++) if (ex.region[v] === REGION.head) head.push(v);
    let inside = 0, checked = 0;
    for (let i = 0; i < set.points.length / 3; i += 37) {
      const x = set.points[i * 3]!, y = set.points[i * 3 + 1]!, z = set.points[i * 3 + 2]!;
      let best = -1, bd = Infinity;
      for (const v of head) {
        const d = (shape[v * 3]! - x) ** 2 + (shape[v * 3 + 1]! - y) ** 2 + (shape[v * 3 + 2]! - z) ** 2;
        if (d < bd) { bd = d; best = v; }
      }
      if (bd > 0.02 ** 2) continue;
      checked++;
      const n = body.normals;
      const along = (x - shape[best * 3]!) * n[best * 3]! + (y - shape[best * 3 + 1]!) * n[best * 3 + 1]! + (z - shape[best * 3 + 2]!) * n[best * 3 + 2]!;
      if (along < -0.001) inside++;
    }
    expect(inside / Math.max(1, checked)).toBeLessThan(0.02);
  });

  it('every brow style grows brows; both eyes grow lashes', () => {
    for (const style of BROW_STYLES) expect(browStrands(ex, base, shape, { ...person.brows, style }, 1).counts.length).toBeGreaterThan(50);
    expect(lashStrands(ex, base, shape, person.lashes, 1).counts.length).toBeGreaterThan(100);
  });

  it('every strand of hair has its follicle on a skin triangle; the beard covers its place', () => {
    const hair = hairStrands(ex, base, body, person.hair, 1);
    expect(hair.follicles!.tris.length).toBe(hair.counts.length);
    for (const t of hair.follicles!.tris) expect(base.meta.groups.some((g) => (g.material === 'Skin' || g.material === 'Covered') && t >= g.start && t < g.start + g.count)).toBe(true);
    const beard = beardMask(ex, base);
    expect(beard.filter((v) => v > 128).length).toBeGreaterThan(100);
  });
});

describe('clothes', () => {
  it.each(Object.entries(GARMENT_TYPES).flatMap(([slot, types]) => types.map((t) => [slot, t] as const)))('%s %s is made for the body', (slot, type) => {
    const g = { ...garmentDefaults(type), colour: 0x336699, colour2: 0xffffff, pattern: 'solid', patternScale: 1 };
    const outfit = { top: null, bottom: null, shoes: null, [slot as GarmentSlot]: g };
    const pieces = dressBody(body, outfit, true).filter((m) => m.slot === slot);
    expect(pieces.length).toBeGreaterThan(0);
    for (const m of pieces) {
      expect(m.index.length).toBeGreaterThan(300);
      expect(m.positions.every(Number.isFinite)).toBe(true);
    }
  });
});

describe('accessories', () => {
  it('glasses and earrings find both eyes and both ear lobes, mirrored', () => {
    const a = faceAnchors(ex, base, shape);
    const [l, r] = a.eyes, [ll, rl] = a.lobes;
    expect(l[0]!).toBeGreaterThan(0.02);
    expect(r[0]!).toBeLessThan(-0.02);
    expect(Math.abs(l[0]! + r[0]!)).toBeLessThan(0.01);
    expect(Math.abs(ll[1]! - rl[1]!)).toBeLessThan(0.015);
    // Lobes below the eyes, behind them, out at the sides of the head.
    expect(ll[1]!).toBeLessThan(l[1]!);
    expect(ll[2]!).toBeLessThan(l[2]! - 0.04);
    expect(ll[0]!).toBeGreaterThan(l[0]! + 0.03);
  });
});
