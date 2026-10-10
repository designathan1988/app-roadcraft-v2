// Platibanda dos telhados planos e terraços. Volumes de mesma altura que se
// encostam formam uma cobertura só: a platibanda segue o contorno da UNIÃO dos
// topos (CrossSection do Manifold), então não sobra mureta na emenda entre um
// volume e o anexo extrudado dele.
import type { Solid, Vec2 } from '../model/schema';
import { kernel, type Manifold, type Scope } from '../kernel/kernel';
import { solidRings } from './body';
import { FaceTable } from './faces';
import { MeshBuilder } from './mesh';

/** Espessura da platibanda e saliência do rufo (m). */
const T = 0.22;
const CAP_OUT = 0.05;
const CAP_IN = 0.04;
const CAP_H = 0.09;

export const flatRoof = (s: Solid) => s.roof.kind === 'flat' || s.roof.kind === 'terrace';
/** Altura da platibanda (terraço tem guarda-corpo de pelo menos 1,05 m). */
export const parapetHeight = (s: Solid) => (s.roof.kind === 'terrace' ? Math.max(s.roof.parapet, 1.05) : s.roof.parapet);

/** Chave de grupo: topo arredondado a 2 cm. */
export const topKey = (s: Solid) => Math.round((s.base + s.height) * 50);

/** Malha do Manifold com uma face de origem só (material da platibanda/rufo). */
function tagged(m: Manifold, faceId: number, scope: Scope): Manifold | null {
  const k = kernel();
  const mesh = m.getMesh();
  const P = mesh.vertProperties,
    np = mesh.numProp,
    I = mesh.triVerts;
  const mb = new MeshBuilder();
  for (let t = 0; t < I.length; t += 3) {
    const v = (i: number): [number, number, number] => [P[i * np]!, P[i * np + 1]!, P[i * np + 2]!];
    mb.triangle(v(I[t]!), v(I[t + 1]!), v(I[t + 2]!), faceId);
  }
  if (mb.empty) return null;
  const out = scope.keep(mb.toManifold(k));
  return out.status() === 'NoError' && !out.isEmpty() ? out : null;
}

/**
 * Platibanda e rufo de um grupo de volumes planos com o mesmo topo. As faces
 * ficam no primeiro volume do grupo (material dele).
 */
export function groupParapet(members: Solid[], table: FaceTable, scope: Scope, coveredOf: (s: Solid) => ReadonlySet<string> | undefined = () => undefined): Manifold[] {
  const k = kernel();
  const s0 = members[0]!;
  const h = Math.max(...members.map(parapetHeight));
  if (h <= 0.01) return [];
  const y = s0.base + s0.height;
  const temp: { delete(): void }[] = [];
  const keep = <X extends { delete(): void }>(x: X): X => (temp.push(x), x);
  try {
    // Contorno de cada topo (com furos) no plano [x, −z] do CrossSection.
    const sections = members.map((s) => {
      const r = solidRings(s, coveredOf(s));
      const polys = [r.topOuter, ...r.topHoles].map((ring) => ring.map((p) => [p[0], -p[1]] as Vec2));
      return keep(new k.CrossSection(polys, 'EvenOdd'));
    });
    const U = keep(k.CrossSection.union(sections));
    const prism = (cs: { delete(): void }, y0: number, y1: number) => keep(k.Manifold.extrude(cs as never, y1 - y0).rotate([-90, 0, 0]).translate([0, y0, 0]));
    const ring = (outerD: number, innerD: number) => keep(keep(U.offset(outerD, 'Miter', 4)).subtract(keep(U.offset(-innerD, 'Miter', 4))));
    const out: Manifold[] = [];
    const wall = tagged(prism(ring(0, T), y - 0.01, y + h), table.add({ kind: 'parapet', solid: s0.id }), scope);
    if (wall) out.push(wall);
    const cap = tagged(prism(ring(CAP_OUT, T + CAP_IN), y + h - 0.02, y + h + CAP_H - 0.02), table.add({ kind: 'coping', solid: s0.id }), scope);
    if (cap) out.push(cap);
    return out;
  } finally {
    for (const x of temp) x.delete();
  }
}
