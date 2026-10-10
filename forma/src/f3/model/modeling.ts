// Ferramentas de modelagem como operações no documento (não destrutivas): o
// que no Blender/3ds Max/SketchUp mexe na malha, aqui cria ou ajusta volumes
// paramétricos que continuam editáveis.
//  - offsetPlan: contorno paralelo (Offset do SketchUp/Rhino), mantém os arcos.
//  - extrudeSide / insetSide: extrudar e inset de uma face lateral → anexo
//    (somar) ou reentrância (recortar), como Extrude/Inset do Edit Poly.
//  - insetTop: inset do topo com profundidade → volume recuado ou poço/átrio.
//  - scaleSolid, splitAtHeight.
// Sem three.
import type { Building3, ID, PlanVertex, Solid, Vec2 } from './schema';
import { arcOf, signedArea2 } from './plan';
import { cloneSolid, locateVertex, planValid } from './ops';
import { roofSpec, solid, uid } from './defaults';

type Corner = 'sharp' | 'round' | 'chamfer';

const rotate = (t: Vec2, a: number): Vec2 => [t[0] * Math.cos(a) - t[1] * Math.sin(a), t[0] * Math.sin(a) + t[1] * Math.cos(a)];
const norm = (v: Vec2): Vec2 => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};
/** Direita do sentido de percurso: (tz, −tx). É "para fora" num anel anti-horário. */
const right = (t: Vec2): Vec2 => [t[1], -t[0]];

/**
 * Tangentes no início e no fim do lado que sai de `a` (bulge = tan(θ/4); o
 * arco com bulge > 0 bomba para a direita da corda, então a tangente de saída
 * gira θ/2 para a direita e a de chegada θ/2 para a esquerda).
 */
function tangents(a: Vec2, b: Vec2, bulge: number): { start: Vec2; end: Vec2 } {
  const c = norm([b[0] - a[0], b[1] - a[1]]);
  if (!bulge) return { start: c, end: c };
  const th = 4 * Math.atan(bulge);
  // Girar "para a direita" no plano (x, z) com área positiva = anti-horário é ângulo negativo.
  return { start: rotate(c, -th / 2), end: rotate(c, th / 2) };
}

function lineHit(p: Vec2, d: Vec2, q: Vec2, e: Vec2): Vec2 | null {
  const den = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
  return [p[0] + d[0] * t, p[1] + d[1] * t];
}

/**
 * Desloca um anel: `dist(edgeId)` > 0 empurra o lado para fora do material.
 * Cada vértice vai para a interseção das tangentes deslocadas dos dois lados
 * (arcos ficam concêntricos: o bulge não muda). `outer` diz se o anel é o
 * contorno (material dentro) ou um furo (material fora).
 */
export function offsetRingVertices(ring: PlanVertex[], dist: (id: ID) => number, outer: boolean, corner: Corner = 'sharp', keepIds = true): PlanVertex[] {
  const n = ring.length;
  const ccw = signedArea2(ring.map((v) => v.p)) > 0;
  // Fora do material = direita do percurso no contorno anti-horário e no furo horário.
  const sgn = outer === ccw ? 1 : -1;
  const tg = ring.map((v, i) => tangents(v.p, ring[(i + 1) % n]!.p, v.bulge ?? 0));
  return ring.map((v, i) => {
    const ip = (i - 1 + n) % n;
    const dIn = dist(ring[ip]!.id) * sgn,
      dOut = dist(v.id) * sgn;
    const tIn = tg[ip]!.end,
      tOut = tg[i]!.start;
    const nIn = right(tIn),
      nOut = right(tOut);
    const pIn: Vec2 = [v.p[0] + nIn[0] * dIn, v.p[1] + nIn[1] * dIn];
    const pOut: Vec2 = [v.p[0] + nOut[0] * dOut, v.p[1] + nOut[1] * dOut];
    const hit = lineHit(pIn, tIn, pOut, tOut);
    const p = hit ?? pOut;
    const out: PlanVertex = { ...v, id: keepIds ? v.id : uid(), p };
    // Material à esquerda do percurso quando sgn = 1; canto convexo = virada para o lado do material.
    const turn = tIn[0] * tOut[1] - tIn[1] * tOut[0];
    const convex = turn * sgn > 0;
    const d = (dist(ring[ip]!.id) + dist(v.id)) / 2;
    // Canto arredondado acompanha: raio cresce no convexo e diminui no côncavo (concêntrico).
    if (v.round) out.round = Math.max(0, v.round + (convex ? d : -d));
    // Canto vivo que cresce: preenche como o Offset do Rhino (redondo ou chanfro).
    if (hit && convex && d > 0 && corner !== 'sharp' && !v.bulge && !ring[ip]!.bulge) {
      const cos = Math.max(-1, Math.min(1, tIn[0] * tOut[0] + tIn[1] * tOut[1]));
      const alpha = Math.acos(cos);
      if (alpha > 1e-3) {
        if (corner === 'round') out.round = (v.round ?? 0) + d;
        else out.chamfer = (v.chamfer ?? 0) + d * Math.tan(alpha / 2);
      }
    }
    return out;
  });
}

/**
 * Offset da planta inteira por `d` (m; > 0 cresce, < 0 encolhe). Furos andam
 * no sentido contrário (o material cresce para dentro deles). Devolve a nova
 * planta ou null se ela se cruzaria.
 */
export function offsetPlan(s: Solid, d: number, corner: Corner = 'sharp', keepIds = true): Solid['plan'] | null {
  const plan: Solid['plan'] = {
    outer: offsetRingVertices(s.plan.outer, () => d, true, corner, keepIds),
    holes: s.plan.holes.map((h) => offsetRingVertices(h, () => d, false, corner, keepIds)),
  };
  return sameShape(s.plan, plan) && planValid(plan) ? plan : null;
}

/**
 * O deslocamento não virou a planta do avesso: mesmo sentido em cada anel e
 * nenhum lado reto com a direção invertida (encolher além da metade da
 * largura faz o lado "atravessar" o oposto).
 */
function sameShape(a: Solid['plan'], b: Solid['plan']): boolean {
  const rings: [PlanVertex[], PlanVertex[]][] = [[a.outer, b.outer], ...a.holes.map((h, i) => [h, b.holes[i]!] as [PlanVertex[], PlanVertex[]])];
  for (const [r0, r1] of rings) {
    if (Math.sign(signedArea2(r0.map((v) => v.p))) !== Math.sign(signedArea2(r1.map((v) => v.p)))) return false;
    for (let i = 0; i < r0.length; i++) {
      const j = (i + 1) % r0.length;
      const d0: Vec2 = [r0[j]!.p[0] - r0[i]!.p[0], r0[j]!.p[1] - r0[i]!.p[1]];
      const d1: Vec2 = [r1[j]!.p[0] - r1[i]!.p[0], r1[j]!.p[1] - r1[i]!.p[1]];
      if (d0[0] * d1[0] + d0[1] * d1[1] <= 1e-9) return false;
    }
  }
  return true;
}

/** Acrescenta pavimentos típicos (sem mexer nos volumes) até cobrir a cota y. */
export function levelsUpTo(b: Building3, y: number): void {
  const lv = [...b.levels].sort((p, q) => p.elevation - q.elevation);
  const typ = lv[1]?.height ?? lv[0]?.height ?? 3;
  let last = lv[lv.length - 1];
  let top = last ? last.elevation + last.height : 0;
  while (y > top + typ * 0.5 && b.levels.length < 60) {
    const n = b.levels.length;
    last = { id: uid(), name: `${n}º pavimento`, elevation: top, height: typ };
    b.levels.push(last);
    top += typ;
  }
}

/** Aplica o offset no próprio volume (lados, regras e peças continuam com os mesmos IDs). */
export function offsetSolid(s: Solid, d: number, corner: Corner = 'sharp'): boolean {
  const plan = offsetPlan(s, d, corner, true);
  if (!plan) return false;
  s.plan = plan;
  return true;
}

/** Cópia deslocada como volume novo (laje, beiral, núcleo, casca). */
export function offsetCopy(b: Building3, s: Solid, d: number, corner: Corner = 'sharp'): Solid | null {
  const plan = offsetPlan(s, d, corner, true);
  if (!plan) return null;
  const c = cloneSolid({ ...s, plan });
  c.name = `${s.name} (offset)`;
  b.solids.push(c);
  return c;
}

// ── Faces laterais ─────────────────────────────────────────────────────

/** Ponto e normal (para fora do material) a uma distância `u` ao longo do lado. */
function along(s: Solid, ring: PlanVertex[], i: number, u: number): { p: Vec2; n: Vec2; len: number } {
  const a = ring[i]!,
    b = ring[(i + 1) % ring.length]!;
  const outer = ring === s.plan.outer;
  const ccw = signedArea2(ring.map((v) => v.p)) > 0;
  const sgn = outer === ccw ? 1 : -1;
  const bulge = a.bulge ?? 0;
  if (!bulge) {
    const len = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]);
    const t = norm([b.p[0] - a.p[0], b.p[1] - a.p[1]]);
    const k = Math.max(0, Math.min(len, u));
    const r = right(t);
    return { p: [a.p[0] + t[0] * k, a.p[1] + t[1] * k], n: [r[0] * sgn, r[1] * sgn], len };
  }
  const arc = arcOf(a.p, b.p, bulge);
  const len = Math.abs(arc.theta) * arc.r;
  const f = Math.max(0, Math.min(1, u / len));
  const ang = arc.a0 + arc.theta * f;
  const p: Vec2 = [arc.c[0] + Math.cos(ang) * arc.r, arc.c[1] + Math.sin(ang) * arc.r];
  // Tangente no sentido do percurso; a normal é a direita dela.
  const t: Vec2 = norm([-Math.sin(ang) * Math.sign(arc.theta), Math.cos(ang) * Math.sign(arc.theta)]);
  const r = right(t);
  return { p, n: [r[0] * sgn, r[1] * sgn], len };
}

/** Comprimento de um lado (arco pelo comprimento do arco). */
export function edgeLength(s: Solid, edge: ID): number {
  const loc = locateVertex(s, edge);
  if (!loc) return 0;
  return along(s, loc.ring, loc.i, 0).len;
}

export interface SideRegion {
  /** Margens ao longo do lado (m, do início e do fim). */
  left: number;
  right: number;
  /** Margens na altura (m, do pé e do topo do volume). */
  bottom: number;
  top: number;
}

/**
 * Volume novo sobre um trecho de uma face lateral: `depth` > 0 projeta para
 * fora (anexo, bay, saliência, somar); < 0 afunda (loggia, nicho, recortar).
 * Lados curvos seguem o arco (o anexo fica concêntrico).
 */
export function sideVolume(b: Building3, s: Solid, edge: ID, depth: number, region: SideRegion = { left: 0, right: 0, bottom: 0, top: 0 }): Solid | null {
  const loc = locateVertex(s, edge);
  if (!loc || Math.abs(depth) < 0.01) return null;
  const { ring, i } = loc;
  const len = along(s, ring, i, 0).len;
  const u0 = Math.max(0, region.left),
    u1 = Math.min(len, len - Math.max(0, region.right));
  if (u1 - u0 < 0.1) return null;
  const h = s.height - Math.max(0, region.bottom) - Math.max(0, region.top);
  if (h < 0.1) return null;
  const add = depth > 0;
  // Encostado na parede, sem sobreposição: o Manifold resolve faces coincidentes
  // nas booleanas, e as medidas mostradas ficam exatas.
  const inner = 0;
  const outerD = depth;
  const a = along(s, ring, i, u0),
    z = along(s, ring, i, u1);
  const bulge0 = ring[i]!.bulge ?? 0;
  const frac = len > 0 ? (u1 - u0) / len : 1;
  // Trecho do arco: mesmo sentido, ângulo proporcional.
  const subBulge = bulge0 ? Math.tan(Math.atan(bulge0) * frac) : 0;
  const P = (q: { p: Vec2; n: Vec2 }, d: number): Vec2 => [q.p[0] + q.n[0] * d, q.p[1] + q.n[1] * d];
  // Contorno: lado da parede (no sentido do percurso) e volta pelo lado de fora.
  const pts: { p: Vec2; bulge?: number }[] = [
    { p: P(a, inner), bulge: subBulge || undefined },
    { p: P(z, inner) },
    { p: P(z, outerD), bulge: subBulge ? -subBulge : undefined },
    { p: P(a, outerD) },
  ];
  const outer: PlanVertex[] = pts.map((q) => ({ id: uid(), p: q.p, ...(q.bulge ? { bulge: q.bulge } : {}) }));
  const n = solid({
    name: add ? `${s.name} (anexo)` : `${s.name} (reentrância)`,
    op: add ? 'add' : 'subtract',
    plan: { outer, holes: [] },
    base: s.base + Math.max(0, region.bottom),
    height: h,
    roof: add ? roofSpec('flat', { parapet: s.roof.kind === 'flat' ? s.roof.parapet : 0 }) : roofSpec('flat', { parapet: 0 }),
    facade: add ? s.facade.filter((r) => r.mode !== 'count').map((r) => ({ ...structuredClone(r), id: uid(), edges: [], except: {} })) : [],
    materials: structuredClone(s.materials),
    plinth: add && s.base + region.bottom < 0.3 ? s.plinth : 0,
    ...(add && s.bevel ? { bevel: structuredClone(s.bevel) } : {}),
    ...(s.layer ? { layer: s.layer } : {}),
  });
  if (!planValid(n.plan)) return null;
  // O anexo fica logo depois do volume de origem (recortes posteriores também o cortam).
  const at = b.solids.indexOf(s);
  if (add) b.solids.splice(at + 1, 0, n);
  else b.solids.push(n);
  return n;
}

/** Extrudar a face lateral inteira. */
export function extrudeSide(b: Building3, s: Solid, edge: ID, depth: number): Solid | null {
  return sideVolume(b, s, edge, depth);
}

/** Inset da face lateral: margem igual nos quatro lados do trecho, depois a profundidade. */
export function insetSide(b: Building3, s: Solid, edge: ID, margin: number, depth: number, keepBottom = false): Solid | null {
  return sideVolume(b, s, edge, depth, { left: margin, right: margin, bottom: keepBottom ? 0 : margin, top: margin });
}

// ── Topo ───────────────────────────────────────────────────────────────

/**
 * Inset do topo: `inset` recua o contorno; `depth` > 0 ergue um volume novo
 * (extrudar o topo quando inset = 0; pavimento recuado quando > 0); < 0 afunda
 * (poço, átrio, piscina, terraço rebaixado).
 */
export function insetTop(b: Building3, s: Solid, inset: number, depth: number): Solid | null {
  if (Math.abs(depth) < 0.01) return null;
  const plan = offsetPlan({ ...s, plan: s.plan }, -Math.max(0, inset) - s.taper, 'sharp', false);
  if (!plan) return null;
  const top = s.base + s.height;
  if (depth > 0) {
    const n = solid({
      name: `${s.name} (topo)`,
      plan,
      base: top,
      height: depth,
      roof: structuredClone(s.roof),
      facade: s.facade.map((r) => ({ ...structuredClone(r), id: uid(), edges: [], except: {} })),
      materials: structuredClone(s.materials),
      plinth: 0,
      ...(s.layer ? { layer: s.layer } : {}),
    });
    // O de baixo vira laje: telhado plano (terraço quando sobra borda).
    s.roof = inset > 0.3 ? roofSpec('terrace') : roofSpec('flat', { parapet: 0 });
    b.solids.splice(b.solids.indexOf(s) + 1, 0, n);
    levelsUpTo(b, n.base + n.height);
    return n;
  }
  const d = Math.min(-depth, s.height - 0.1);
  const n = solid({
    name: `${s.name} (rebaixo)`,
    op: 'subtract',
    plan,
    base: top - d,
    height: d + 1,
    roof: roofSpec('flat', { parapet: 0 }),
    plinth: 0,
    ...(s.layer ? { layer: s.layer } : {}),
  });
  b.solids.push(n);
  return n;
}

// ── Escala e divisão ───────────────────────────────────────────────────

/** Caixa envolvente da planta (eixos do edifício). */
export function planBox(s: Solid): { x0: number; x1: number; z0: number; z1: number } {
  let x0 = Infinity,
    x1 = -Infinity,
    z0 = Infinity,
    z1 = -Infinity;
  for (const v of s.plan.outer) {
    x0 = Math.min(x0, v.p[0]);
    x1 = Math.max(x1, v.p[0]);
    z0 = Math.min(z0, v.p[1]);
    z1 = Math.max(z1, v.p[1]);
  }
  return { x0, x1, z0, z1 };
}

/**
 * Escala a planta em x e z a partir do centro da caixa (largura e
 * profundidade exatas). Arcos continuam arcos pelos novos vértices; cantos
 * arredondados escalam pela menor das duas.
 */
export function scaleSolid(s: Solid, sx: number, sz: number): boolean {
  if (!(sx > 0.01 && sz > 0.01)) return false;
  const bx = planBox(s);
  const cx = (bx.x0 + bx.x1) / 2,
    cz = (bx.z0 + bx.z1) / 2;
  const before = structuredClone(s.plan);
  const k = Math.min(sx, sz);
  for (const ring of [s.plan.outer, ...s.plan.holes])
    for (const v of ring) {
      v.p = [cx + (v.p[0] - cx) * sx, cz + (v.p[1] - cz) * sz];
      if (v.round) v.round *= k;
      if (v.chamfer) v.chamfer *= k;
    }
  if (!planValid(s.plan)) {
    s.plan = before;
    return false;
  }
  return true;
}

/** Largura (x) e profundidade (z) exatas. */
export function setSolidSize(s: Solid, w: number, d: number): boolean {
  const bx = planBox(s);
  const W = bx.x1 - bx.x0,
    D = bx.z1 - bx.z0;
  if (W < 1e-3 || D < 1e-3) return false;
  return scaleSolid(s, w / W, d / D);
}

/**
 * Divide o volume na cota `y` (acima da base dele): embaixo fica o original
 * (com as peças que estão abaixo), em cima um volume novo com o telhado,
 * o bisel do topo e as peças de cima. Afunilamento e inclinações continuam.
 */
export function splitAtHeight(b: Building3, s: Solid, y: number): Solid | null {
  const h1 = y;
  if (!(h1 > 0.2 && h1 < s.height - 0.2)) return null;
  const H = s.height;
  // Planta do de cima: o anel do original na altura do corte.
  const taper0 = s.taper;
  const leanOff = (id: ID) => taper0 * (h1 / H) + h1 * Math.tan(((Math.max(-60, Math.min(60, s.edges[id]?.lean ?? 0)) * Math.PI) / 180));
  const upperPlan: Solid['plan'] = {
    outer: offsetRingVertices(s.plan.outer, (id) => -leanOff(id), true, 'sharp', true),
    holes: s.plan.holes.map((h) => offsetRingVertices(h, (id) => -leanOff(id), false, 'sharp', true)),
  };
  if (!planValid(upperPlan)) return null;
  const upper = cloneSolid({ ...s, plan: upperPlan });
  // cloneSolid troca os IDs na mesma ordem: mapa do lado antigo → novo.
  const map = new Map<ID, ID>();
  [s.plan.outer, ...s.plan.holes].forEach((r, ri) => r.forEach((v, vi) => map.set(v.id, ([upper.plan.outer, ...upper.plan.holes][ri]![vi]!).id)));
  upper.name = `${s.name} (superior)`;
  upper.base = s.base + h1;
  upper.height = H - h1;
  upper.taper = s.taper * ((H - h1) / H);
  upper.plinth = 0;
  if (s.bevel) upper.bevel = { ...s.bevel, bottom: 0 };
  s.height = h1;
  s.taper = s.taper * (h1 / H);
  s.roof = roofSpec('flat', { parapet: 0 });
  if (s.bevel) s.bevel = { ...s.bevel, top: 0 };
  for (const e of Object.values(s.edges)) delete e.bevel;
  // As regras continuam nos dois (cada um pega os pavimentos que tem).
  b.solids.splice(b.solids.indexOf(s) + 1, 0, upper);
  // Peças de cima mudam de volume no mesmo lugar: o início do lado de cima
  // andou (afunilamento), então a distância ao longo do lado é corrigida.
  const shiftAlong = (edge: ID): number => {
    const lo = locateVertex(s, edge),
      up = locateVertex(upper, map.get(edge) ?? '');
    if (!lo || !up || lo.ring[lo.i]!.bulge) return 0;
    const a = lo.ring[lo.i]!.p,
      b2 = lo.ring[(lo.i + 1) % lo.ring.length]!.p;
    const t = norm([b2[0] - a[0], b2[1] - a[1]]);
    const q = up.ring[up.i]!.p;
    return (q[0] - a[0]) * t[0] + (q[1] - a[1]) * t[1];
  };
  // Na face inclinada, y anda pela parede (não na vertical): h1 vale h1·√(1 + m²).
  const slantH1 = (edge: ID) => h1 * Math.hypot(1, leanOff(edge) / h1);
  for (const it of b.items) {
    const host = it.host;
    if ((host.kind === 'face' && host.solid === s.id && host.y >= slantH1(host.edge)) || (host.kind === 'roof' && host.solid === s.id)) {
      host.solid = upper.id;
      if (host.kind === 'face') {
        host.u -= shiftAlong(host.edge);
        host.y -= slantH1(host.edge);
        host.edge = map.get(host.edge) ?? host.edge;
      }
    }
  }
  return upper;
}

// ── Frisos, cornija e rodapé (varredura pelo contorno) ─────────────────

export type BandPreset = 'floors' | 'cornice' | 'base';

/** Acrescenta frisos prontos: um em cada laje, cornija no topo ou rodapé. */
export function addBands(b: Building3, s: Solid, preset: BandPreset): number {
  const list = (s.bands ??= []);
  const before = list.length;
  if (preset === 'floors') {
    for (const l of b.levels) {
      const y = l.elevation - s.base;
      if (y > 0.5 && y < s.height - 0.5) list.push({ id: uid(), y: y - 0.12, height: 0.24, depth: 0.08, profile: 'flat' });
    }
  } else if (preset === 'cornice') list.push({ id: uid(), y: Math.max(0, s.height - 0.6), height: 0.6, depth: 0.32, profile: 'cornice' });
  else list.push({ id: uid(), y: 0, height: Math.min(0.7, s.height / 3), depth: 0.06, profile: 'flat' });
  return list.length - before;
}
