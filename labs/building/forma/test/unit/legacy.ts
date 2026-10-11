// Acesso ao FormaCore legado (extraído do HTML) para testes de paridade.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Legacy: any = require(resolve(root, 'test/legacy/forma-core.js'));

export function fixtures(): Record<string, V1Project> {
  const dir = resolve(root, 'test/fixtures/v1');
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => [f.replace('.json', ''), JSON.parse(readFileSync(resolve(dir, f), 'utf8'))]),
  );
}

export const baselines = (): Record<string, Record<string, { meshes: Record<string, number>; instances: Record<string, number>; box: number[]; sig: Record<string, number>; verts: Record<string, { count: number; sum: number }> }>> =>
  JSON.parse(readFileSync(resolve(root, 'test/fixtures/legacy-baselines.json'), 'utf8'));

export interface V1Project {
  version: 1;
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  volumes: any[];
}

/** Gerador pseudoaleatório determinístico (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Polígono aleatório (estrela irregular, às vezes autointersectante de propósito). */
export function randomPolygon(r: () => number): [number, number][] {
  const n = 3 + Math.floor(r() * 14);
  const scramble = r() < 0.25;
  const pts = Array.from({ length: n }, (_, i) => {
    const a = scramble ? r() * Math.PI * 2 : (i / n) * Math.PI * 2;
    const rad = 0.5 + r() * 12;
    return [Math.round(Math.cos(a) * rad * 100) / 100 + (r() - 0.5) * 20, Math.round(Math.sin(a) * rad * 100) / 100] as [number, number];
  });
  return r() < 0.5 ? pts.reverse() : pts;
}
