import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { unsupportedElements } from '@world/buildings/elements';
import type { Building } from '@world/buildings/types';
import type { ZoneUse } from '@world/zones';
import { growOnLot } from '@editor/zoning';
import { FOOTWAY_RISE, Level, halfWidth, roadType } from '@world/roadTypes';

/**
 * Nothing in a grown lot stands in the air (docs/PLANO.md, Etapa 5a): every
 * part rests on the land, on the building, or on parts that do, with its
 * centre over what holds it (`unsupportedElements`). A carport roof whose
 * posts were refused, or a pergola whose posts a retaining wall cleared, is
 * the class this guards against - on the flat and on a hillside, where the
 * terraces lift and clear parts of the yard.
 */

const flat = (): number => 0;
/** Ground rising to the north (-y) at 18 %, as `terrace.spec.ts`. */
const hill = (_x: number, y: number): number => -y * 0.18;

function grow(groundAt: (x: number, y: number) => number, use: ZoneUse, seed: number): Building[] {
  const paved = (x: number, y: number): number =>
    Math.abs(y) <= halfWidth(roadType(1), Level.Sidewalk) && Math.abs(x) <= m(160) ? groundAt(x, 0) + FOOTWAY_RISE : NaN;
  const doc = new RoadDoc();
  const a = doc.addNode({ x: m(-160), y: 0 }).id, b = doc.addNode({ x: m(160), y: 0 }).id;
  doc.addSegment(a, b, 1);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  zoneLots(doc, doc.lots.map((l) => l.id), { use, density: 'low' });
  const refused = new Set<number>();
  for (let k = 0; k < doc.lots.length * 3; k++) {
    if (growOnLot({ doc, net, groundAt, pavedAt: paved }, refused, seed) === null && refused.size >= doc.lots.length) break;
  }
  return [...doc.buildings.all()] as Building[];
}

describe('lot physics: nothing in the air', () => {
  for (const [name, ground] of [['flat', flat], ['hillside', hill]] as const) {
    for (const use of ['residential', 'commercial'] as const) {
      it(`${use} lots on the ${name}`, () => {
        let parts = 0;
        const loose: string[] = [];
        for (const seed of [0x5eed, 0xbeef, 0xc0de]) {
          for (const b of grow(ground, use, seed)) {
            parts += b.elements?.length ?? 0;
            for (const id of unsupportedElements(b)) {
              const el = b.elements!.find((e) => e.id === id)!;
              loose.push(`seed ${seed.toString(16)} building ${b.id}: ${el.kind} at z ${el.z.toFixed(2)}`);
            }
          }
        }
        expect(parts).toBeGreaterThan(50);
        expect(loose).toEqual([]);
      });
    }
  }
});
