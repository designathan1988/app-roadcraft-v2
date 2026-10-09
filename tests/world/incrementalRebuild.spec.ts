import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Digest } from '@core/digest';
import type { Ring } from '@core/ring';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import type { SegmentId } from '@world/ids';
import { LaneletGraph } from '@world/lanelets';
import { FLAT_GROUND, type RoadElevation, buildRoadElevation } from '@world/elevation';
import { TerrainIndex, sampleTerrainHeight } from '@world/terrain';
import { commitRoadPath, moveNodeChecked } from '@editor/commit';
import { guardRoadEdit } from '@editor/editRules';
import { findAnchor } from '@editor/snap';
import { restoreSnapshot } from '@editor/history';
import { applyOp, freshState } from '../fuzz/support/ops';
import { generate, loadFixtures } from '../fuzz/support/runner';

/**
 * THE ORACLE of the incremental rebuild (docs/VIAS.md V0): after every edit,
 * the network the game keeps (rebuilt incrementally, `Network.rebuild`) and
 * the roads' heights solved from the previous solve (`buildRoadElevation`
 * with `previous`) must be EXACTLY what a network and a solve built from
 * nothing give for the same document - ribbons, junction rings, trims,
 * plates, marks, lanelets, every profile and node height. Over the fuzzer's
 * op sequences (the editor's own commands), every recorded fuzz fixture, and
 * the test town with the edits a player makes there.
 */

const ringText = (ring: Ring): number => {
  const d = new Digest();
  for (const p of ring.flatten()) d.add(p.x).add(p.y);
  return d.value();
};

/** Everything the network derived, one line per piece, so a difference names the piece. */
function networkLines(net: Network): string[] {
  const out: string[] = [];
  const segs = [...net.ribbons.keys()].sort((a, b) => a - b);
  for (const id of segs) {
    const r = net.ribbons.get(id)!;
    const d = new Digest().add(r.typeIndex).addText(r.direction).add(r.dashOrigin).addAll(r.full.xy)
      .addText(JSON.stringify(r.road));
    for (const level of Object.keys(r.centre).map(Number).sort((a, b) => a - b)) {
      d.add(level).addAll(r.centre[level]!.xy).add(ringText(r.rings[level]!));
    }
    out.push(`ribbon ${id} ${d.value()}`);
    out.push(`trims ${id} ${JSON.stringify(net.trims.get(id) ?? null)}`);
  }
  for (const node of [...net.junctions.keys()].sort((a, b) => a - b)) {
    for (const [level, j] of [...net.junctions.get(node)!].sort((a, b) => a[0] - b[0])) {
      const d = new Digest().add(ringText(j.ring)).addAll(j.trims).add(j.transition ? 1 : 0);
      for (const t of j.tongues) d.add(ringText(t));
      for (const r of j.rings) d.add(ringText(r));
      for (const leg of j.legs) d.add(leg.seg).add(leg.hw).add(leg.origin.x).add(leg.origin.y).add(leg.dir.x).add(leg.dir.y);
      out.push(`junction ${node}/${level} ${d.value()}`);
    }
  }
  out.push(`plates ${JSON.stringify([...net.plateReach].sort())}`);
  out.push(`transitions ${[...net.transitions].sort((a, b) => a - b).join(',')}`);
  out.push(`impossible ${JSON.stringify([...net.impossible].sort((a, b) => a[0] - b[0]))}`);
  out.push(`squeezed ${JSON.stringify([...net.squeezed].sort((a, b) => a[0] - b[0]))}`);
  return out;
}

function laneletLines(doc: RoadDoc, net: Network): string[] {
  const graph = new LaneletGraph();
  graph.build(doc, net);
  return [...graph.lanelets.values()].map((l) => {
    const d = new Digest().addText(l.kind).addAll(l.centre.xy).add(l.length).add(l.speedLimit).add(l.controlled ? 1 : 0);
    return `lanelet ${l.id} ${l.segment ?? '-'} ${l.node ?? '-'} ${d.value()}`;
  }).sort();
}

function elevationLines(doc: RoadDoc, elevation: RoadElevation): string[] {
  const out: string[] = [];
  const summaries = elevation.summaries!();
  for (const id of [...summaries.keys()].sort((a, b) => a - b)) out.push(`profile ${id} ${summaries.get(id)!.digest}`);
  for (const id of [...doc.nodes.keys()].sort((a, b) => a - b)) out.push(`node ${id} ${elevation.nodeHeight(id)}`);
  return out;
}

/** The game's network and solve, against ones built from nothing. */
function expectSameAsFull(doc: RoadDoc, net: Network, elevation: RoadElevation, ground: (x: number, y: number) => number, where: string): void {
  const fresh = new Network(doc.clone());
  fresh.rebuild({ full: true });
  expect(networkLines(net), `network after ${where}`).toEqual(networkLines(fresh));
  expect(laneletLines(doc, net), `lanelets after ${where}`).toEqual(laneletLines(fresh.doc, fresh));
  expect(elevationLines(doc, elevation), `heights after ${where}`).toEqual(elevationLines(doc, buildRoadElevation(fresh, ground)));
}

describe('incremental network and height rebuild', () => {
  it('equals a full rebuild after every op of the fuzz sequences', () => {
    const seeds = Number(process.env['ORACLE_SEEDS'] ?? 8);
    const length = Number(process.env['ORACLE_OPS'] ?? 24);
    for (let seed = 1; seed <= seeds; seed++) {
      const ops = generate(seed, length);
      const state = freshState();
      let elevation = buildRoadElevation(state.net, FLAT_GROUND);
      for (let i = 0; i < ops.length; i++) {
        let changed: boolean;
        try { changed = applyOp(state, ops[i]!); } catch { break; }
        if (!changed) continue;
        elevation = buildRoadElevation(state.net, FLAT_GROUND, elevation);
        expectSameAsFull(state.doc, state.net, elevation, FLAT_GROUND, `seed ${seed} op ${i} (${ops[i]!.op})`);
      }
    }
  });

  it('equals a full rebuild over every recorded fuzz fixture', () => {
    for (const fixture of loadFixtures()) {
      const state = freshState();
      let elevation = buildRoadElevation(state.net, FLAT_GROUND);
      fixture.ops.forEach((op, i) => {
        let changed: boolean;
        try { changed = applyOp(state, op); } catch { return; }
        if (!changed) return;
        elevation = buildRoadElevation(state.net, FLAT_GROUND, elevation);
        expectSameAsFull(state.doc, state.net, elevation, FLAT_GROUND, `${fixture.name} op ${i}`);
      });
    }
  });

  it('equals a full rebuild on the test town, over its terrain, through the edits a player makes', () => {
    const doc = RoadDoc.fromJSON(JSON.parse(readFileSync('maps/cidade-com-estacionamento.json', 'utf8')));
    const net = new Network(doc);
    net.rebuild({ full: true });
    const index = new TerrainIndex(doc.terrainStamps, 0, doc.terrainRelief);
    const ground = (x: number, y: number): number => sampleTerrainHeight(index, x, y);
    let elevation = buildRoadElevation(net, ground);
    const settle = (where: string): void => {
      if (net.revision !== doc.revision) net.rebuild();
      elevation = buildRoadElevation(net, ground, elevation);
      expectSameAsFull(doc, net, elevation, ground, where);
    };
    const ids = [...doc.segments.keys()].sort((a, b) => a - b);
    for (const pick of [0.15, 0.5, 0.85]) {
      const id = ids[Math.floor(pick * ids.length)] as SegmentId;
      const line = net.polylines.get(doc, id);
      const frame = line.sampleAt(line.length / 2);
      const start = findAnchor(doc, net, frame.p, 1);
      const end = { x: frame.p.x + frame.n.x * 150, y: frame.p.y + frame.n.y * 150 };
      const before = doc.toJSON();
      const done = commitRoadPath(doc, net, start, { kind: 'free', at: end }, 1,
        [{ start: { at: start.at, heightOffset: 0 }, end: { at: end, heightOffset: 0 }, curve: null }], null, undefined, ground).committed;
      settle(`road out of ${id}`);
      if (done) {
        restoreSnapshot(doc, before, net);
        settle(`undo of the road out of ${id}`);
      }
    }
    const node = [...doc.nodes.values()].find((n) => n.incident.length === 3)!;
    moveNodeChecked(doc, net, node.id, { x: node.x + 6, y: node.y + 4 });
    settle(`move of node ${node.id}`);
    const retyped = ids[Math.floor(ids.length / 3)] as SegmentId;
    guardRoadEdit(doc, net, () => { doc.setSegmentType(retyped, (doc.requireSegment(retyped).type + 1) % 4); return true; });
    settle(`retype of ${retyped}`);
    const raised = [...doc.nodes.values()].find((n) => n.incident.length === 2)!;
    doc.setNodeHeightOffset(raised.id, raised.heightOffset + 10);
    settle(`node ${raised.id} raised`);
  });
});
