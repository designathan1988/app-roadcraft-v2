// Fachada: a parte visível de cada lado (depois das booleanas) define onde
// cabem componentes. Regras de fachada distribuem tipos por nível com quatro
// modos (distância fixa, espaçamento máximo, quantidade, encaixe), como a pele
// de vidro do Revit e do Archicad; ocorrências avulsas presas a uma face usam o
// mesmo referencial. Sem three.
import type { Building3, ComponentType, FacadeRule, Item, LevelPick, Project3, Solid, Vec2, Vec3 } from '../model/schema';
import type { Family, Opening, Params } from '../families/family';
import { resolveParams } from '../families/family';
import { family, typeById } from '../families/index';
import type { FaceFrame, FaceInfo } from './faces';
import type { Shell } from './evaluate';
import { frameMatrix, mul, rotationYXZ, translation, type M4, type PartTag } from './parts';

/** Lado visível de um sólido em coordenadas desenvolvidas (s ao longo, y subindo pela face). */
export interface EdgeRegion {
  solid: string;
  edge: string;
  /** Triângulos visíveis [s, y] (planificados). */
  tris: Vec2[][];
  /** Segmentos do lado, em ordem de s. */
  segs: FaceFrame[];
  length: number;
  bbox: { s0: number; s1: number; y0: number; y1: number };
}

export interface Placement {
  family: Family;
  params: Params;
  /** Referencial da peça: origem no centro da base, x ao longo, y para cima, z para fora. */
  frame: M4;
  opening: Opening | null;
  tag: PartTag;
  length: number;
  /** Ponto da face (para a seleção) e lado de origem. */
  host?: { solid: string; edge: string; s: number; y: number };
  path?: Vec3[];
}

const key = (solid: string, edge: string) => `${solid}|${edge}`;

/** Agrupa os triângulos visíveis por lado. */
export function edgeRegions(shell: Shell, faces: FaceInfo[]): Map<string, EdgeRegion> {
  const out = new Map<string, EdgeRegion>();
  const P = shell.positions,
    I = shell.indices;
  for (let t = 0; t < I.length / 3; t++) {
    const f = faces[shell.faceOf[t]!];
    if (!f || f.kind !== 'side' || !f.frame || !f.edge || f.edge.endsWith(':c')) continue;
    const k = key(f.solid, f.edge);
    let r = out.get(k);
    if (!r) out.set(k, (r = { solid: f.solid, edge: f.edge, tris: [], segs: [], length: 0, bbox: { s0: Infinity, s1: -Infinity, y0: Infinity, y1: -Infinity } }));
    if (!r.segs.includes(f.frame)) r.segs.push(f.frame);
    const fr = f.frame;
    const tri: Vec2[] = [];
    for (let j = 0; j < 3; j++) {
      const i = I[t * 3 + j]! * 3;
      const dx = P[i]! - fr.o[0],
        dy = P[i + 1]! - fr.o[1],
        dz = P[i + 2]! - fr.o[2];
      const s = fr.s0 + dx * fr.u[0] + dy * fr.u[1] + dz * fr.u[2];
      const y = dx * fr.v[0] + dy * fr.v[1] + dz * fr.v[2];
      tri.push([s, y]);
      r.bbox.s0 = Math.min(r.bbox.s0, s);
      r.bbox.s1 = Math.max(r.bbox.s1, s);
      r.bbox.y0 = Math.min(r.bbox.y0, y);
      r.bbox.y1 = Math.max(r.bbox.y1, y);
    }
    r.tris.push(tri);
  }
  for (const r of out.values()) {
    r.segs.sort((a, b) => a.s0 - b.s0);
    r.length = Math.max(...r.segs.map((s) => s.s1));
  }
  return out;
}

function inTri(p: Vec2, t: Vec2[]): boolean {
  const [a, b, c] = t as [Vec2, Vec2, Vec2];
  const d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
  const d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1]);
  const d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1]);
  const neg = d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9;
  const pos = d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9;
  return !(neg && pos);
}

/** O retângulo [s0,s1]×[y0,y1] está todo na parte visível? (amostras em grade). */
export function fits(r: EdgeRegion, s0: number, s1: number, y0: number, y1: number): boolean {
  if (s0 < r.bbox.s0 - 1e-6 || s1 > r.bbox.s1 + 1e-6 || y0 < r.bbox.y0 - 1e-6 || y1 > r.bbox.y1 + 1e-6) return false;
  const nx = Math.max(2, Math.ceil((s1 - s0) / 0.4)),
    ny = Math.max(2, Math.ceil((y1 - y0) / 0.4));
  for (let i = 0; i <= nx; i++)
    for (let j = 0; j <= ny; j++) {
      const p: Vec2 = [s0 + ((s1 - s0) * i) / nx, y0 + ((y1 - y0) * j) / ny];
      if (!r.tris.some((t) => inTri(p, t))) return false;
    }
  return true;
}

/** Trechos [a, b] de s visíveis numa linha horizontal y (cortes dos triângulos, unidos). */
function lineIntervals(r: EdgeRegion, y: number): [number, number][] {
  const segs: [number, number][] = [];
  for (const t of r.tris) {
    const xs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const a = t[i]!,
        b = t[(i + 1) % 3]!;
      if ((a[1] - y) * (b[1] - y) > 0 || a[1] === b[1]) continue;
      xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    if (xs.length >= 2) segs.push([Math.min(...xs), Math.max(...xs)]);
  }
  segs.sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  for (const g of segs) {
    const last = out[out.length - 1];
    if (last && g[0] <= last[1] + 0.005) last[1] = Math.max(last[1], g[1]);
    else out.push([g[0], g[1]]);
  }
  return out;
}

/** Trechos de s visíveis em toda a faixa [y0, y1] (interseção de várias linhas). */
export function rowIntervals(r: EdgeRegion, y0: number, y1: number): [number, number][] {
  let acc: [number, number][] | null = null;
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const y = y0 + ((y1 - y0) * i) / n + (i === 0 ? 1e-4 : i === n ? -1e-4 : 0);
    const line = lineIntervals(r, y);
    if (!acc) acc = line;
    else {
      const next: [number, number][] = [];
      for (const a of acc) for (const b of line) {
        const lo = Math.max(a[0], b[0]),
          hi = Math.min(a[1], b[1]);
        if (hi - lo > 1e-4) next.push([lo, hi]);
      }
      acc = next;
    }
    if (!acc.length) break;
  }
  return acc ?? [];
}

/** Referencial no ponto (s, y) do lado: segmento que contém s. */
export function frameAt(r: EdgeRegion, s: number, y: number): M4 {
  let seg = r.segs[0]!;
  for (const g of r.segs) if (s >= g.s0 - 1e-6) seg = g;
  const ds = s - seg.s0;
  const p: Vec3 = [seg.o[0] + seg.u[0] * ds + seg.v[0] * y, seg.o[1] + seg.u[1] * ds + seg.v[1] * y, seg.o[2] + seg.u[2] * ds + seg.v[2] * y];
  return frameMatrix(p, seg.u, seg.v, seg.n);
}

/** Níveis do edifício dentro da altura do sólido. */
export function solidLevels(b: Building3, s: Solid): { index: number; elevation: number; height: number }[] {
  const out: { index: number; elevation: number; height: number }[] = [];
  const top = s.base + s.height;
  const levels = [...b.levels].sort((a, c) => a.elevation - c.elevation);
  levels.forEach((l, i) => {
    if (l.elevation >= s.base - 0.05 && l.elevation < top - 1) out.push({ index: i, elevation: l.elevation, height: Math.min(l.height, top - l.elevation) });
  });
  if (!out.length && s.height > 1.5) out.push({ index: 0, elevation: s.base, height: s.height });
  return out;
}

function pickLevels(pick: LevelPick, list: ReturnType<typeof solidLevels>): ReturnType<typeof solidLevels> {
  if (Array.isArray(pick)) return list.filter((l, i) => pick.includes(i));
  if (pick === 'all') return list;
  if (pick === 'ground') return list.slice(0, 1);
  if (pick === 'upper') return list.slice(1);
  if (pick === 'top') return list.slice(-1);
  return list.slice(1, -1);
}

/** Centros ao longo de [a, b] para um componente de largura w (quatro modos). */
export function distribute(rule: Pick<FacadeRule, 'mode' | 'value' | 'justify'>, a: number, b: number, w: number): number[] {
  const avail = b - a;
  if (avail < w - 1e-6) return [];
  const v = Math.max(0.01, rule.value);
  if (rule.mode === 'spacing') {
    const d = Math.max(v, w + 0.05);
    const n = Math.floor((avail - w) / d) + 1;
    const span = (n - 1) * d;
    const start = rule.justify === 'start' ? a + w / 2 : rule.justify === 'end' ? b - w / 2 - span : (a + b) / 2 - span / 2;
    return Array.from({ length: n }, (_, i) => start + i * d);
  }
  let n: number;
  if (rule.mode === 'count') n = Math.max(1, Math.round(v));
  else if (rule.mode === 'max') n = Math.max(1, Math.ceil(avail / v));
  else n = Math.max(1, Math.floor(avail / Math.max(w + 0.1, v)));
  // Nunca mais peças do que cabem lado a lado.
  n = Math.min(n, Math.floor(avail / (w + 0.05)) || 1);
  return Array.from({ length: n }, (_, i) => a + ((i + 0.5) * avail) / n);
}

export interface TypeResolver {
  (id: string): { type: ComponentType; family: Family } | null;
}

export function typeResolver(project?: Pick<Project3, 'types'>): TypeResolver {
  return (id) => {
    const type = typeById(id, project);
    const fam = type ? family(type.family) : undefined;
    return type && fam ? { type, family: fam } : null;
  };
}

/** Componentes das regras de fachada de um sólido. */
export function rulePlacements(b: Building3, s: Solid, regions: Map<string, EdgeRegion>, types: TypeResolver, warnings: string[], taken: Placement[] = []): Placement[] {
  const out: Placement[] = [];
  const levels = solidLevels(b, s);
  // Regras de um lado específico primeiro; cada regra cede o lugar às anteriores.
  const ordered = [...s.facade].sort((a, b) => (b.edges.length ? 1 : 0) - (a.edges.length ? 1 : 0));
  for (const rule of ordered) {
    const base = types(rule.type);
    if (!base) {
      warnings.push(`Regra de fachada com tipo desconhecido (${rule.type}).`);
      continue;
    }
    const edges = [...regions.values()].filter((r) => r.solid === s.id && (rule.edges.length ? rule.edges.includes(r.edge) : !s.edges[r.edge]?.blank));
    for (const r of edges) {
      for (const lv of pickLevels(rule.levels, levels)) {
        const seg0 = r.segs[0]!;
        const vy = Math.max(0.2, seg0.v[1]);
        const params = resolveParams(base.family, base.type.params, rule.params);
        const [w, h] = base.family.size(params);
        const sill = Number.isFinite(rule.sill) ? rule.sill : (base.family.sill?.(params) ?? 0.9);
        // Só o vão precisa caber no pé-direito; letreiros e coberturas podem passar.
        const openH = base.family.opening?.(params)?.h ?? h;
        if (sill + openH > lv.height - 0.08) {
          warnings.push(`${base.type.name}: não cabe no nível ${lv.index + 1} (${(sill + openH).toFixed(2)} m em ${lv.height.toFixed(2)} m).`);
          continue;
        }
        let placed = 0,
          yielded = 0;
        const y = (lv.elevation + sill - s.base) / vy;
        // Distribui dentro dos trechos visíveis nesta fileira (torres que afinam,
        // empenas, parede coberta em parte por outro volume).
        const spans = rowIntervals(r, y, y + openH / vy).filter(([a, b]) => b - a - 2 * rule.margin >= w);
        const total = spans.reduce((acc, [a, b]) => acc + (b - a), 0);
        const centers: number[] = [];
        for (const [a, b] of spans) {
          const share = rule.mode === 'count' && spans.length > 1 ? { ...rule, value: Math.max(1, Math.round((rule.value * (b - a)) / total)) } : rule;
          centers.push(...distribute(share, a + rule.margin, b - rule.margin, w));
        }
        centers.forEach((c, i) => {
          const k = `${r.edge}:${lv.index}:${i}`;
          const ex = rule.except[k];
          if (ex === 'none') return;
          const t = ex ? types(ex) : base;
          if (!t) return;
          const p = ex ? resolveParams(t.family, t.type.params) : params;
          const [ww, hh] = t.family.size(p);
          const oh = t.family.opening?.(p)?.h ?? hh;
          if (!fits(r, c - ww / 2, c + ww / 2, y, y + oh / vy)) return;
          // Peça avulsa no mesmo lugar tem prioridade: a regra libera a posição.
          if (taken.some((q) => q.host && q.host.solid === s.id && q.host.edge === r.edge && Math.abs(q.host.s - c) < (q.length + ww) / 2 + 0.05 && q.host.y < y + hh + 0.05 && q.host.y + (q.family.size(q.params)[1] ?? 0) > y - 0.05)) {
            yielded++;
            return;
          }
          placed++;
          const pl: Placement = {
            family: t.family,
            params: p,
            frame: frameAt(r, c, y),
            opening: t.family.opening?.(p) ?? null,
            tag: { family: t.family.id, rule: rule.id, key: k, solid: s.id },
            length: ww,
            host: { solid: s.id, edge: r.edge, s: c, y },
          };
          out.push(pl);
          taken.push(pl);
        });
        if (!placed && !yielded && centers.length && r.length > w + 2 * rule.margin) warnings.push(`${base.type.name}: nada coube no nível ${lv.index + 1} do lado de ${r.length.toFixed(1)} m (algo cobre a parede).`);
      }
    }
  }
  return out;
}

/** Ocorrências avulsas (com arranjo). `roofY` dá a altura do telhado num ponto. */
export function itemPlacements(b: Building3, regions: Map<string, EdgeRegion>, types: TypeResolver, roofY: (x: number, z: number) => number, warnings: string[]): Placement[] {
  const out: Placement[] = [];
  for (const it of b.items) {
    const t = types(it.type);
    if (!t) {
      warnings.push(`Componente com tipo desconhecido (${it.type}).`);
      continue;
    }
    const params = resolveParams(t.family, t.type.params, it.params);
    const [w, h, d] = t.family.size(params);
    const copies = arrayOffsets(it, w, d);
    const h0 = it.host;
    if (h0.kind === 'face') {
      const r = regions.get(key(h0.solid, h0.edge));
      if (!r) {
        warnings.push(`${t.type.name}: a face onde estava não existe mais.`);
        continue;
      }
      const vy = Math.max(0.2, r.segs[0]!.v[1]);
      copies.forEach(([dx, dy], i) => {
        const s = h0.u + dx,
          y = h0.y + dy / vy;
        const ok = fits(r, s - w / 2, s + w / 2, y, y + h / vy);
        if (!ok) {
          if (i === 0) warnings.push(`${t.type.name}: não cabe mais na face (fica oculto até caber).`);
          return;
        }
        out.push({ family: t.family, params, frame: frameAt(r, s, y), opening: t.family.opening?.(params) ?? null, tag: { family: t.family.id, item: it.id, key: String(i) }, length: w, host: { solid: h0.solid, edge: h0.edge, s, y } });
      });
    } else if (h0.kind === 'free' || h0.kind === 'roof') {
      const p: Vec3 = h0.kind === 'free' ? h0.p : [h0.p[0], roofY(h0.p[0], h0.p[1]), h0.p[1]];
      const base = mul(translation(p[0], p[1], p[2]), rotationYXZ([h0.rot, 0, 0]));
      copies.forEach(([dx, , dz], i) => {
        let f = mul(base, translation(dx, 0, dz));
        if (h0.kind === 'roof') {
          const q = applyXZ(f);
          f = mul(translation(0, roofY(q[0], q[1]) - p[1], 0), f);
        }
        out.push({ family: t.family, params, frame: f, opening: null, tag: { family: t.family.id, item: it.id, key: String(i) }, length: w });
      });
    } else {
      const pts = h0.points;
      if (pts.length < 2) continue;
      let L = 0;
      for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![2] - pts[i - 1]![2]);
      out.push({ family: t.family, params, frame: translation(0, 0, 0), opening: null, tag: { family: t.family.id, item: it.id }, length: L, path: h0.closed ? [...pts, pts[0]!] : pts });
    }
  }
  return out;
}

function applyXZ(m: M4): Vec2 {
  return [m[12]!, m[14]!];
}

/** Deslocamentos das cópias de um arranjo [ao longo, para cima (faces) ou nada, z local (livres)]. */
export function arrayOffsets(it: Item, w: number, d: number): Vec3[] {
  const a = it.array;
  if (!a) return [[0, 0, 0]];
  const n = Math.max(1, Math.round(a.along.count));
  const step = a.along.mode === 'spacing' || a.along.mode === 'max' ? Math.max(a.along.value, 0.05) : a.along.mode === 'fit' ? Math.max(a.along.value / Math.max(1, n - 1), 0.05) : Math.max(w + 0.05, a.along.value);
  const rows = Math.max(1, Math.round(a.across?.count ?? 1));
  const rs = a.across?.spacing ?? d + 0.5;
  const out: Vec3[] = [];
  for (let r = 0; r < rows; r++)
    for (let i = 0; i < n; i++) {
      const along = i * step;
      out.push(it.host.kind === 'face' ? [along, r * rs, 0] : [along, 0, r * rs]);
    }
  return out;
}
