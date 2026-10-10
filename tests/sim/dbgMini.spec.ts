import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { layoutDoc, simOf } from './support/bodies';
it('dbg mini', () => {
  const { doc, centre } = layoutDoc({ name: 'streets', bearings: [0, 90, 180, 270], types: [1, 1, 1, 1] });
  doc.setNodeControl(centre, 'mini');
  const sim = simOf(doc, 0x77, 4);
  const out: string[] = [];
  let entered = 0;
  const seen = new Set<string>();
  for (let i = 0; i < Math.round(120 / DT); i++) {
    step(sim, { traffic: true, pedestrians: false });
    for (const v of sim.vehicles.values()) { const l = sim.lanelet(v.lanelet); if (l?.kind === 'connector' && !seen.has(`${v.id}:${v.lanelet}`)) { seen.add(`${v.id}:${v.lanelet}`); entered++; out.push(`t=${(i * DT).toFixed(1)} enter ${v.id} ${v.lanelet}`); } }
  }
  out.push(`entered ${entered}`);
  for (const v of sim.vehicles.values()) {
    const l = sim.lanelet(v.lanelet)!;
    if (l.kind === 'connector' || l.length - v.s < 15) out.push(`${v.id} ${v.lanelet} ${l.kind} s=${v.s.toFixed(1)}/${l.length.toFixed(1)} v=${v.v.toFixed(2)} adm ${v.admittedConnector} res ${JSON.stringify(v.reservedConnectors)} claims ${v.claims.length} obst ${JSON.stringify(v.constraints.obstacles.slice(0, 2))}`);
  }
  writeFileSync('C:/Users/JONATH~1/AppData/Local/Temp/claude/C--Codex-Shared-Roadcraft/0e6ecc2b-cbd0-4c4e-95a8-605459c2b205/scratchpad/dbgMini.txt', out.join('\n'));
}, 300_000);
