import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { HumanBase, type HumanBaseMeta } from '@people/gen/humanBase';
import { randomPerson, resolvePerson } from '@people/gen/person';

const dir = 'public/models/humans/vitruvian';
const meta = JSON.parse(readFileSync(`${dir}/base.json`, 'utf8')) as HumanBaseMeta;
const buf = readFileSync(`${dir}/base.bin`);
const base = new HumanBase(meta, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

describe('generated person', () => {
  it('reaches the height asked for, to the centimetre, at every age', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 24; i++) {
      const p = randomPerson(base, rng.fork(`h${i}`));
      expect(Math.abs(resolvePerson(base, p).heightCm - p.heightCm)).toBeLessThan(1);
    }
  });

  it('children reach the BMI asked for within 1.5 points', () => {
    const rng = new Rng(5);
    for (const years of [3, 6, 10, 14]) for (const bmi of [14, 17, 22]) {
      const r = resolvePerson(base, { ...randomPerson(base, rng.fork(`c${years}`), years), bmi });
      expect(Math.abs(r.massKg / (r.heightCm / 100) ** 2 - bmi), `${years} y, BMI ${bmi}`).toBeLessThan(1.5);
    }
  });

  it('adults reach the BMI asked for within 1.5 points', () => {
    const rng = new Rng(4);
    const rows: string[] = [];
    for (let i = 0; i < 16; i++) {
      const p = { ...randomPerson(base, rng.fork(`b${i}`), 35), bmi: 17 + i * 1.6 };
      const r = resolvePerson(base, p);
      const bmi = r.massKg / (r.heightCm / 100) ** 2;
      rows.push(`${p.bmi.toFixed(1)} -> ${bmi.toFixed(1)} (${r.massKg.toFixed(0)} kg, ${r.heightCm.toFixed(0)} cm)`);
      expect(Math.abs(bmi - p.bmi), rows.join('\n')).toBeLessThan(1.5);
    }
  });
});
