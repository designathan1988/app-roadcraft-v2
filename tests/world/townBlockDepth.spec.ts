import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { buildDefaultTown, townBlocks } from '@world/defaultTown';
import { solidFootprints } from '@world/buildings/geometry';

/**
 * A block has no common ground in its middle: the plots run from the street
 * to the block's spine and are built to it. Measured on the middle of every
 * block - the band around the spine, where the courts used to be - as the
 * share of it under a built (not open) volume.
 */
describe('town blocks are built through', () => {
  const doc = new RoadDoc();
  buildDefaultTown(doc);
  const rects: { x0: number; y0: number; x1: number; y1: number; fn: string }[] = [];
  for (const b of doc.buildings.all()) {
    for (const pts of solidFootprints(b)) {
      rects.push({
        x0: Math.min(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)),
        x1: Math.max(...pts.map((p) => p.x)), y1: Math.max(...pts.map((p) => p.y)),
        fn: String(b.function),
      });
    }
  }

  it('builds the middle of the perimeter blocks', () => {
    const report: string[] = [];
    for (const block of townBlocks()) {
      const { x0, y0, x1, y1 } = block.box;
      // The middle half of the block, both ways.
      const mx0 = x0 + (x1 - x0) * 0.25, mx1 = x1 - (x1 - x0) * 0.25;
      const my0 = y0 + (y1 - y0) * 0.25, my1 = y1 - (y1 - y0) * 0.25;
      let n = 0;
      let built = 0;
      for (let x = mx0 + 2; x < mx1; x += 4) {
        for (let y = my0 + 2; y < my1; y += 4) {
          n++;
          if (rects.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1)) built++;
        }
      }
      report.push(`${block.name}: ${Math.round((100 * built) / n)}%`);
    }
    console.log(report.join('\n'));
    const perimeterBlocks = townBlocks().filter((b) => !/works|block 4,3|block 3,1|block 5,2/.test(b.name));
    for (const block of perimeterBlocks) {
      const line = report.find((r) => r.startsWith(`${block.name}:`)) ?? '';
      expect(Number(line.split(': ')[1]?.replace('%', '')), block.name).toBeGreaterThan(70);
    }
  });
});
