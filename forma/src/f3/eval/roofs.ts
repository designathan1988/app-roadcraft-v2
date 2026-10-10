// Telhados como sólidos fechados, unidos ao corpo no Manifold (assim um volume
// que sobe através do telhado de outro funde em vez de atravessar).
//  - águas (duas, quatro, mansarda, gambrel): esqueleto reto ponderado sobre o
//    anel do beiral; cada triângulo da água vira um prisma sob ele;
//  - água única, pirâmide, dente de serra: planos por triângulo;
//  - cúpula e abóbada: superfície de alturas lisa sobre uma grade interna;
//  - plano e terraço: platibanda (anel) sobre o topo.
// Lados com `gable` (ou escolhidos pela direção) viram empenas verticais.
import type { RoofSpec, Solid, Vec2 } from '../model/schema';
import { offsetRing, ringValid, signedArea2, type SampledRing } from '../model/plan';
import { straightSkeleton, SkeletonError, type P3 } from '../../geometry/roofs/skeleton';
import { gableEdges } from '../../geometry/roofs/skeleton-roof';
import { pointInPolygon } from '../../geometry/polygon';
import earcut from 'earcut';
import { kernel } from '../kernel/kernel';
import type { SolidRings } from './body';
import { FaceTable } from './faces';
import { heightPrism, MeshBuilder } from './mesh';

const rad = (d: number) => (d * Math.PI) / 180;

export interface RoofBuild {
  /** Sólidos fechados do telhado (unidos ao corpo no Manifold). */
  parts: MeshBuilder[];
  /** Altura máxima do telhado acima do topo das paredes. */
  rise: number;
}

/** Lado (do anel amostrado) sob cada aresta do anel do beiral. */
interface EdgeRef {
  ring: SampledRing;
  index: number;
}

function clipT(poly: P3[], lim: number, keepBelow: boolean): P3[] {
  const inside = (p: P3) => (keepBelow ? p[2] <= lim + 1e-9 : p[2] >= lim - 1e-9);
  const out: P3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!,
      b = poly[(i + 1) % poly.length]!;
    const ia = inside(a),
      ib = inside(b);
    if (ia) out.push(a);
    if (ia !== ib) {
      const k = (lim - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, lim]);
    }
  }
  return out.length >= 3 ? out : [];
}

/** Lados que viram empena: marcados no sólido ou escolhidos pela direção da cumeeira. */
function gableSet(s: Solid, rings: SolidRings, auto: boolean): Set<number> {
  const marked = new Set<number>();
  rings.outer.segs.forEach((seg, i) => {
    if (s.edges[seg.edge]?.gable) marked.add(i);
  });
  if (marked.size || !auto) return marked;
  try {
    const dir = s.roof.direction;
    return new Set(gableEdges(rings.topOuter, rings.topHoles, Number.isFinite(dir) ? dir : undefined));
  } catch {
    return marked;
  }
}

/** Faces do beiral: empena (lado inclinado) ou testeira (lado horizontal). */
function prismFaces(s: Solid, table: FaceTable, refs: EdgeRef[][], topId: (t: number) => number, kinds: { rakeOf?: (ring: number, i: number) => boolean } = {}) {
  const soffit = table.add({ kind: 'soffit', solid: s.id });
  const sideIds = new Map<string, number>();
  return {
    top: topId,
    bottom: soffit,
    side: (ring: number, i: number) => {
      const key = `${ring}:${i}`;
      let id = sideIds.get(key);
      if (id === undefined) {
        const ref = refs[ring]?.[i];
        const rake = kinds.rakeOf?.(ring, i) ?? false;
        id = table.add({ kind: rake ? 'gable' : 'fascia', solid: s.id, ...(ref ? { edge: ref.ring.segs[ref.index]!.edge } : {}) });
        sideIds.set(key, id);
      }
      return id;
    },
  };
}

/** Constrói o sólido do telhado de `s` sobre o topo (`rings`). */
export function roofMesh(s: Solid, rings: SolidRings, table: FaceTable): RoofBuild | null {
  const spec: RoofSpec = s.roof;
  const yTop = rings.top;
  const mb = new MeshBuilder();
  const parts: MeshBuilder[] = [];
  const outer = rings.topOuter,
    holes = rings.topHoles;

  if (spec.kind === 'flat' || spec.kind === 'terrace') {
    const h = spec.kind === 'terrace' ? Math.max(spec.parapet, 1.05) : spec.parapet;
    if (h <= 0.01) return null;
    const t = 0.22;
    const inner = offsetRing(outer, outer.map(() => t));
    if (!ringValid(inner, 1)) return null;
    const pid = table.add({ kind: 'parapet', solid: s.id });
    const faces = { top: () => pid, bottom: pid, side: () => pid };
    // Anel externo com o recuo como furo; cada pátio ganha o seu anel.
    heightPrism(mb, outer, [[...inner].reverse()], [], () => yTop + h, yTop - 0.01, faces);
    for (const hole of holes) {
      const out = offsetRing(hole, hole.map(() => -t));
      if (ringValid(out, -1)) heightPrism(mb, [...out].reverse(), [hole], [], () => yTop + h, yTop - 0.01, faces);
    }
    // Rufo: capa saliente no topo da platibanda (sombra que marca o coroamento).
    const parts: MeshBuilder[] = [mb];
    const cid = table.add({ kind: 'coping', solid: s.id });
    const cf = { top: () => cid, bottom: cid, side: () => cid };
    const capOut = offsetRing(outer, outer.map(() => -0.05)),
      capIn = offsetRing(outer, outer.map(() => t + 0.04));
    if (ringValid(capOut, 1) && ringValid(capIn, 1)) {
      const cap = new MeshBuilder();
      heightPrism(cap, capOut, [[...capIn].reverse()], [], () => yTop + h + 0.07, yTop + h - 0.02, cf);
      parts.push(cap);
    }
    return { parts, rise: h + 0.07 };
  }

  // Cúpula e abóbada nascem na parede; mansarda e gambrel têm beiral curto (a água de baixo é íngreme).
const ov = spec.kind === 'dome' || spec.kind === 'vault' ? 0 : Math.max(0, Math.min(spec.overhang, spec.kind === 'mansard' || spec.kind === 'gambrel' ? 0.2 : 2));
  const thick = Math.max(0.12, spec.thickness);
  const pitch = Math.max(3, Math.min(75, spec.pitch));
  const tanP = Math.tan(rad(pitch));

  if (spec.kind === 'dome' || spec.kind === 'vault') return curvedRoof(s, rings, table);

  if (spec.kind === 'shed') {
    const d = rad(spec.direction || 0);
    const dir: Vec2 = [Math.cos(d), Math.sin(d)];
    const ring = offsetRing(outer, outer.map(() => -ov));
    const proj = (p: Vec2) => p[0] * dir[0] + p[1] * dir[1];
    const minP = Math.min(...outer.map(proj));
    const hOf = (p: Vec2) => yTop + (proj(p) - minP) * tanP;
    const roofId = table.add({ kind: 'roof', solid: s.id });
    const refs: EdgeRef[][] = [rings.outer.pts.map((_, i) => ({ ring: rings.outer, index: i }))];
    const faces = prismFaces(s, table, refs, () => roofId, { rakeOf: () => true });
    const rise = Math.max(...outer.map((p) => hOf(p) - yTop));
    heightPrism(mb, ring, holes.map((h) => offsetRing(h, h.map(() => -ov))), [], (p) => hOf(p) + thick * 0.5, yTop - ov * tanP - thick, faces);
    return { parts: [mb], rise };
  }

  if (spec.kind === 'pyramid') {
    const ring = offsetRing(outer, outer.map(() => -ov));
    let cx = 0,
      cz = 0;
    for (const p of outer) {
      cx += p[0];
      cz += p[1];
    }
    cx /= outer.length;
    cz /= outer.length;
    const inr = Math.min(...outer.map((p, i) => distToLine([cx, cz], p, outer[(i + 1) % outer.length]!)));
    const apexY = yTop + inr * tanP;
    const roofId = table.add({ kind: 'roof', solid: s.id });
    const refs: EdgeRef[][] = [rings.outer.pts.map((_, i) => ({ ring: rings.outer, index: i }))];
    const faces = prismFaces(s, table, refs, () => roofId);
    const eave = yTop - ov * tanP;
    // Um prisma por água (triângulo base-ápice): a união dá a pirâmide.
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!,
        b = ring[(i + 1) % ring.length]!;
      const tri: Vec2[] = signedArea2([a, b, [cx, cz]]) >= 0 ? [a, b, [cx, cz]] : [b, a, [cx, cz]];
      const sub = new MeshBuilder();
      heightPrism(sub, tri, [], [], (p) => (Math.hypot(p[0] - cx, p[1] - cz) < 1e-6 ? apexY : eave), eave - thick, {
        top: () => roofId,
        bottom: faces.bottom,
        side: () => faces.side(0, i),
      });
      parts.push(sub);
    }
    return { parts, rise: apexY - yTop };
  }

  if (spec.kind === 'sawtooth') return sawtoothRoof(s, rings, table, tanP, thick);

  // Águas pelo esqueleto reto.
  const gableKind = spec.kind === 'gable' || spec.kind === 'gambrel';
  const gables = gableSet(s, rings, gableKind);
  const all = [outer, ...holes];
  const weights: number[] = [];
  const offsets: number[][] = all.map((ring, r) =>
    ring.map((_, i) => {
      const g = r === 0 && gables.has(i);
      weights.push(g ? 0 : 1);
      return g ? 0 : -ov;
    }),
  );
  let ovRings = all.map((ring, r) => offsetRing(ring, offsets[r]!));
  if (!ringValid(ovRings[0]!, 1) || ovRings.slice(1).some((h) => !ringValid(h, -1))) ovRings = all;
  const usedOv = ovRings === all ? 0 : ov;
  let sk;
  try {
    sk = straightSkeleton(ovRings[0]!, ovRings.slice(1), weights);
  } catch (e) {
    if (!(e instanceof SkeletonError)) throw e;
    return null;
  }
  const T = sk.maxTime;
  const steep = Math.tan(rad(Math.max(pitch + 15, 68)));
  const folded = spec.kind === 'mansard' || spec.kind === 'gambrel';
  const fold = folded ? usedOv + Math.min(0.42 * (T - usedOv), 2.6) : Infinity;
  const yFold = yTop + (fold - usedOv) * steep;
  const hOf = (t: number) => (t <= fold ? yTop + (t - usedOv) * (folded ? steep : tanP) : yFold + (t - fold) * tanP);
  // Beiral: a altura onde as águas começam (na mansarda, pela água íngreme).
  const eave = hOf(0);
  const refs: EdgeRef[][] = [rings.outer.pts.map((_, i) => ({ ring: rings.outer, index: i })), ...rings.holes.map((h) => h.pts.map((_, i) => ({ ring: h, index: i })))];
  let rise = 0;
  const interior = table.add({ kind: 'roof', solid: s.id });
  const ringStart: number[] = [];
  {
    let k = 0;
    for (const ring of ovRings) {
      ringStart.push(k);
      k += ring.length;
    }
  }
  const locate = (edgeIndex: number): [number, number] => {
    let r = ringStart.length - 1;
    while (r > 0 && ringStart[r]! > edgeIndex) r--;
    return [r, edgeIndex - ringStart[r]!];
  };
  for (const f of sk.faces) {
    if (f.weight <= 0) continue;
    const [ringIdx, edgeIdx] = locate(f.edge);
    const roofId = table.add({ kind: 'roof', solid: s.id, edge: refs[ringIdx]?.[edgeIdx] ? refs[ringIdx]![edgeIdx]!.ring.segs[edgeIdx]!.edge : undefined });
    const pieces = Number.isFinite(fold) ? [clipT(f.points, fold, true), clipT(f.points, fold, false)] : [f.points];
    for (const piece of pieces) {
      if (piece.length < 3) continue;
      const flat: number[] = [];
      for (const p of piece) flat.push(p[0], p[1]);
      const tri = earcut(flat);
      for (let t = 0; t < tri.length; t += 3) {
        const P = [piece[tri[t]!]!, piece[tri[t + 1]!]!, piece[tri[t + 2]!]!];
        const plan: Vec2[] = P.map((p) => [p[0], p[1]]);
        if (Math.abs(signedArea2(plan)) < 1e-6) continue;
        const ordered = signedArea2(plan) > 0 ? P : [P[0]!, P[2]!, P[1]!];
        const ys = ordered.map((p) => hOf(p[2]));
        for (const y of ys) rise = Math.max(rise, y - yTop);
        const sub = new MeshBuilder();
        heightPrism(sub, ordered.map((p) => [p[0], p[1]] as Vec2), [], [], (_, i) => ys[i]! + thick * 0.5, eave - thick, {
          top: () => roofId,
          bottom: table.add({ kind: 'soffit', solid: s.id }),
          side: (_r, i) => {
            const a = ordered[i]!,
              b = ordered[(i + 1) % 3]!;
            // Lado sobre o anel do beiral: empena (sobe) ou testeira (horizontal).
            const hit = boundarySegment(ovRings, [a[0], a[1]], [b[0], b[1]]);
            if (!hit) return interior;
            const ref = refs[hit[0]]?.[hit[1]];
            const rake = Math.abs(hOf(a[2]) - hOf(b[2])) > 1e-4;
            return table.add({ kind: rake ? 'gable' : 'fascia', solid: s.id, ...(ref ? { edge: ref.ring.segs[ref.index]!.edge } : {}) });
          },
        });
        parts.push(sub);
      }
    }
  }
  return parts.length ? { parts, rise } : null;
}

/** Segmento de anel [anel, índice] que contém os dois pontos, ou null. */
function boundarySegment(rings: Vec2[][], p: Vec2, q: Vec2): [number, number] | null {
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r]!;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!,
        b = ring[(i + 1) % ring.length]!;
      if (segDist(p, a, b) < 1e-5 && segDist(q, a, b) < 1e-5) return [r, i];
    }
  }
  return null;
}

function distToLine(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0],
    dz = b[1] - a[1];
  const l = Math.hypot(dx, dz) || 1;
  return Math.abs((p[0] - a[0]) * dz - (p[1] - a[1]) * dx) / l;
}


/**
 * Cúpula e abóbada: um prisma sobre o topo, subdividido no Manifold
 * (refineToLength, sempre fechado) e erguido pelo perfil.
 * Cúpula: perfil circular da borda ao centro (distância à borda); numa base
 * redonda dá a calota esférica, numa quadrada a abóbada de arestas (claustral).
 * Abóbada: perfil circular no corte transversal à direção.
 */
function curvedRoof(s: Solid, rings: SolidRings, table: FaceTable): RoofBuild | null {
  const k = kernel();
  const outer = rings.topOuter,
    holes = rings.topHoles;
  const yTop = rings.top;
  const all = [outer, ...holes];
  const edgeDist = (x: number, z: number) => {
    let d = Infinity;
    for (const ring of all) for (let i = 0; i < ring.length; i++) d = Math.min(d, segDist([x, z], ring[i]!, ring[(i + 1) % ring.length]!));
    return d;
  };
  const xs = outer.map((p) => p[0]),
    zs = outer.map((p) => p[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  const step = Math.max(0.3, span / 28);
  let profile: (x: number, z: number) => number;
  let rise: number;
  if (s.roof.kind === 'dome') {
    // Maior distância à borda (raio inscrito), por amostragem em grade.
    let D = 0.5;
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += step / 2)
      for (let z = Math.min(...zs); z <= Math.max(...zs); z += step / 2)
        if (pointInPolygon(x, z, outer) && holes.every((h) => !pointInPolygon(x, z, h))) D = Math.max(D, edgeDist(x, z));
    rise = s.roof.rise > 0 ? s.roof.rise : D;
    profile = (x, z) => {
      const t = Math.min(1, edgeDist(x, z) / D);
      return rise * Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
    };
  } else {
    const d = rad(s.roof.direction || 0);
    const across: Vec2 = [-Math.sin(d), Math.cos(d)];
    const ps = outer.map((p) => p[0] * across[0] + p[1] * across[1]);
    const lo = Math.min(...ps),
      hi = Math.max(...ps);
    const half = Math.max((hi - lo) / 2, 0.25);
    const mid = (lo + hi) / 2;
    rise = s.roof.rise > 0 ? s.roof.rise : half;
    profile = (x, z) => {
      const c = (x * across[0] + z * across[1] - mid) / half;
      return rise * Math.sqrt(Math.max(0, 1 - c * c));
    };
  }
  const yb = yTop - 0.05;
  const cs = new k.CrossSection(all.map((r) => r.map((p) => [p[0], -p[1]] as Vec2)), 'EvenOdd');
  const prism = k.Manifold.extrude(cs, 1).rotate([-90, 0, 0]).translate([0, yb, 0]);
  const fine = prism.refineToLength(step);
  const mesh = fine.getMesh();
  cs.delete();
  prism.delete();
  fine.delete();
  const P = mesh.vertProperties,
    np = mesh.numProp;
  const top = (x: number, z: number) => yTop + 0.08 + profile(x, z);
  const pts: [number, number, number][] = [];
  for (let i = 0; i < P.length; i += np) {
    const x = P[i]!,
      y = P[i + 1]!,
      z = P[i + 2]!;
    pts.push([x, yb + (y - yb) * (top(x, z) - yb), z]);
  }
  const mb = new MeshBuilder();
  const soffit = table.add({ kind: 'soffit', solid: s.id });
  const sideIds = new Map<string, number>();
  const sideOf = (x: number, z: number) => {
    let best = Infinity,
      key = '';
    let seg: { edge: string } | undefined;
    all.forEach((ring, r) => {
      const src = r === 0 ? rings.outer : rings.holes[r - 1]!;
      ring.forEach((a, i) => {
        const dd = segDist([x, z], a, ring[(i + 1) % ring.length]!);
        if (dd < best) {
          best = dd;
          key = r + ':' + i;
          seg = src.segs[i];
        }
      });
    });
    let id = sideIds.get(key);
    if (id === undefined) {
      id = table.add({ kind: 'gable', solid: s.id, ...(seg ? { edge: seg.edge } : {}) });
      sideIds.set(key, id);
    }
    return id;
  };
  const T = mesh.triVerts;
  for (let t = 0; t < T.length; t += 3) {
    const ia = T[t]!,
      ib = T[t + 1]!,
      ic = T[t + 2]!;
    const ya = P[ia * np + 1]! - yb,
      yb2 = P[ib * np + 1]! - yb,
      yc = P[ic * np + 1]! - yb;
    const a = pts[ia]!,
      b = pts[ib]!,
      c = pts[ic]!;
    let face: number;
    if (ya > 0.999 && yb2 > 0.999 && yc > 0.999) face = table.add({ kind: 'roof', solid: s.id, smooth: true });
    else if (ya < 1e-3 && yb2 < 1e-3 && yc < 1e-3) face = soffit;
    else face = sideOf((a[0] + b[0] + c[0]) / 3, (a[2] + b[2] + c[2]) / 3);
    // A ordem do Manifold já está correta (para fora); só repassa.
    mb.triangle(a, b, c, face);
  }
  return { parts: [mb], rise };
}

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0],
    dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t);
}

/** Dente de serra: faixas paralelas à direção, cada uma com uma água e um plano vertical envidraçado. */
function sawtoothRoof(s: Solid, rings: SolidRings, table: FaceTable, tanP: number, thick: number): RoofBuild | null {
  const parts: MeshBuilder[] = [];
  const outer = rings.topOuter;
  const yTop = rings.top;
  const d = rad(s.roof.direction || 0);
  const along: Vec2 = [Math.cos(d), Math.sin(d)];
  const proj = (p: Vec2) => p[0] * along[0] + p[1] * along[1];
  const ps = outer.map(proj);
  const lo = Math.min(...ps),
    hi = Math.max(...ps);
  const width = Math.max(3, Math.min(9, (hi - lo) / Math.max(1, Math.round((hi - lo) / 5.5))));
  const roofId = table.add({ kind: 'roof', solid: s.id });
  const glassId = table.add({ kind: 'glazing', solid: s.id });
  let rise = 0;
  for (let a = lo; a < hi - 1e-6; a += width) {
    const b = Math.min(hi, a + width);
    // Corta o anel pela faixa [a, b] na projeção (Sutherland–Hodgman, convexo na direção).
    const strip = clipStrip(clipStrip(outer, along, a, true), along, b, false);
    if (strip.length < 3 || Math.abs(signedArea2(strip)) < 0.05) continue;
    const ring = signedArea2(strip) > 0 ? strip : [...strip].reverse();
    const h = (b - a) * tanP;
    rise = Math.max(rise, h);
    const sub = new MeshBuilder();
    heightPrism(sub, ring, [], [], (p) => yTop + ((proj(p) - a) / (b - a)) * h + thick * 0.4, yTop - 0.02, {
      top: () => roofId,
      bottom: table.add({ kind: 'soffit', solid: s.id }),
      side: (_r, i) => {
        const p = ring[i]!,
          q = ring[(i + 1) % ring.length]!;
        return Math.abs(proj(p) - b) < 1e-6 && Math.abs(proj(q) - b) < 1e-6 ? glassId : table.add({ kind: 'gable', solid: s.id });
      },
    });
    parts.push(sub);
  }
  return parts.length ? { parts, rise } : null;
}

function clipStrip(poly: Vec2[], dir: Vec2, lim: number, keepAbove: boolean): Vec2[] {
  const val = (p: Vec2) => p[0] * dir[0] + p[1] * dir[1];
  const inside = (p: Vec2) => (keepAbove ? val(p) >= lim - 1e-9 : val(p) <= lim + 1e-9);
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!,
      b = poly[(i + 1) % poly.length]!;
    const ia = inside(a),
      ib = inside(b);
    if (ia) out.push(a);
    if (ia !== ib) {
      const k = (lim - val(a)) / (val(b) - val(a));
      out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
    }
  }
  return out;
}
