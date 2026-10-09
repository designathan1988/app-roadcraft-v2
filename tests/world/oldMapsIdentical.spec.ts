import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { applyOp, freshState } from '../fuzz/support/ops';
import { generate } from '../fuzz/support/runner';
import { derivedLines, laneletLines, networkLines } from './support/roadDigest';

/**
 * OLD MAPS STAY IDENTICAL (docs/VIAS.md, acceptance of every stage): the
 * road system grows - profiles, asymmetry, materials, connectors, controls -
 * and a map saved before any of it must derive exactly what it derived
 * before: the same ribbons, junctions, lanelets, surface bands, walkways,
 * furniture, markings and cross-sections. Recorded once from the code before
 * the road system (`ROAD_BASELINE_RECORD=1` rewrites it, only on purpose).
 */
const FIXTURE = 'tests/fixtures/roadBaseline.json';

function scenarios(): [string, () => RoadDoc][] {
  const map = (path: string) => (): RoadDoc => {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return RoadDoc.fromJSON(data.document ?? data);
  };
  const out: [string, () => RoadDoc][] = [
    ['test town', map('maps/cidade-com-estacionamento.json')],
    ['grid and bends', map('tests/fixtures/grid-and-bends.json')],
    ['player city', map('tests/fixtures/player-city.json')],
  ];
  for (const seed of [1, 2, 3, 4]) {
    out.push([`fuzz seed ${seed}`, () => {
      const state = freshState();
      for (const op of generate(seed, 24)) { try { applyOp(state, op); } catch { break; } }
      return state.doc;
    }]);
  }
  return out;
}

function linesOf(doc: RoadDoc): Record<string, string[]> {
  const net = new Network(doc);
  net.rebuild({ full: true });
  return { network: networkLines(net), lanelets: laneletLines(doc, net), derived: derivedLines(net) };
}

describe('old maps', () => {
  it('derive exactly what they derived before the road system', () => {
    const now: Record<string, Record<string, string[]>> = {};
    for (const [name, build] of scenarios()) now[name] = linesOf(build());
    if (process.env['ROAD_BASELINE_RECORD'] === '1' || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, JSON.stringify(now));
      return;
    }
    const before = JSON.parse(readFileSync(FIXTURE, 'utf8')) as typeof now;
    for (const name of Object.keys(before)) {
      for (const part of Object.keys(before[name]!)) {
        expect(now[name]?.[part], `${name}: ${part}`).toEqual(before[name]![part]);
      }
    }
  });
});
