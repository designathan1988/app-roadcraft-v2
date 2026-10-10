// Abertura de projetos no FORMA 3: forma/3 (validado), forma/2 e v1 (pelo
// núcleo antigo, que leva o v1 ao forma/2) convertidos para forma/3, e a
// validação do forma/3 com mensagens em português. Sem three.
//
// forma/2 → forma/3:
//  - cada edifício continua um edifício (posição e rotação iguais);
//  - pavimentos viram níveis (mesmos IDs, cota e pé-direito);
//  - cada massa vira um sólido 'add' com os mesmos IDs de vértice (logo os
//    mesmos IDs de lado); base = cota do pavimento inicial, altura = soma até
//    o pavimento final;
//  - cobertura: plana → plana com platibanda de 0,45 m (a do v2); água única,
//    duas águas, quatro águas, mansarda e cúpula com o mesmo nome; a altura do
//    v2 vira inclinação por atan(altura / meio vão) (meio vão = metade do lado
//    curto do retângulo mínimo da planta, que é o tempo do esqueleto reto num
//    retângulo); a cúpula guarda a altura em `rise`;
//  - acabamento: parede, caixilho e telhado com as cores do v2;
//  - fachada: o padrão da massa vira regras de fachada com os tipos incluídos;
//    lados com padrão próprio ganham regras só deles e ficam de fora das
//    regras gerais (`blank`); lados com aberturas manuais viram ocorrências
//    avulsas presas à face;
//  - lotes, estilos e paredes internas são copiados.
import type { Building, EdgeOverride, FacadePattern, Mass, Opening, Project } from '../../core/schema';
import { loadProject } from '../../core';
import { edgeConfig, massExtent, sortedStoreys, type EdgeConfig } from '../../core/model';
import { massEdges } from '../../geometry/ring';
import { validateStylePack } from '../../styles/schema';
import type { Building3, BuildingUse, EdgeSpec, FacadeRule, ID, Interior, Item, Level, ParamValue, PlanVertex, Project3, RoofKind, RoofSpec, Solid, Vec2 } from '../model/schema';
import { LIMITS3, SCHEMA3 } from '../model/schema';
import { DEFAULT_MATERIALS, facadeRule, mat, roofSpec, solid } from '../model/defaults';
import { BUILTIN_TYPES, family, typeById } from '../families/index';
import { FINISHES } from '../render/finishes';

export interface Migration {
  project: Project3;
  /** O que não tem equivalente no forma/3 e ficou de fora (para avisar o usuário). */
  notes: string[];
}

/** Abre um projeto de qualquer versão conhecida como forma/3. Lança Error com mensagem em português. */
export function toForma3(raw: unknown): Project3 {
  return migrateForma3(raw).project;
}

/** Como `toForma3`, devolvendo também as notas da migração. */
export function migrateForma3(raw: unknown): Migration {
  const r = raw as { schema?: unknown } | null;
  if (r && typeof r === 'object' && r.schema === SCHEMA3) {
    const errors = validateForma3(r);
    if (errors.length) throw new Error(`Projeto forma/3 inválido: ${errors.slice(0, 3).join(' ')}`);
    return { project: normalize3(structuredClone(r as Project3)), notes: [] };
  }
  const v2 = loadProject(raw);
  const out = fromForma2(v2);
  const errors = validateForma3(out.project);
  if (errors.length) throw new Error(`A conversão para o FORMA 3 falhou: ${errors.slice(0, 3).join(' ')}`);
  return out;
}

/** O JSON troca NaN por null: o peitoril "do tipo" volta a ser NaN. */
function normalize3(p: Project3): Project3 {
  for (const b of p.buildings) for (const s of b.solids) for (const r of s.facade) if (r.sill === null || r.sill === undefined) r.sill = NaN;
  return p;
}

// ── forma/2 → forma/3 ──────────────────────────────────────────────────

const FINISH_IDS = new Set(FINISHES.map((f) => f.id));

/** Tipo incluído de sacada, se algum existir no registro. */
function balconyType(): string | undefined {
  return BUILTIN_TYPES.find((t) => family(t.family)?.category === 'balconies')?.id;
}

/** Retângulo de menor área que contém os pontos (direções dos lados): ângulo do lado longo e medidas. */
export function minRect(pts: Vec2[]): { angle: number; long: number; short: number } {
  let best = { area: Infinity, angle: 0, long: 0, short: 0 };
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!,
      b = pts[(i + 1) % pts.length]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-9) continue;
    const u: Vec2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    let u0 = Infinity,
      u1 = -Infinity,
      v0 = Infinity,
      v1 = -Infinity;
    for (const p of pts) {
      const pu = p[0] * u[0] + p[1] * u[1],
        pv = -p[0] * u[1] + p[1] * u[0];
      u0 = Math.min(u0, pu);
      u1 = Math.max(u1, pu);
      v0 = Math.min(v0, pv);
      v1 = Math.max(v1, pv);
    }
    const du = u1 - u0,
      dv = v1 - v0;
    if (du * dv < best.area - 1e-9) {
      const along = Math.atan2(u[1], u[0]);
      // Ângulo do lado longo, em graus, no plano [x, z].
      const angle = du >= dv ? along : along + Math.PI / 2;
      best = { area: du * dv, angle: (angle * 180) / Math.PI, long: Math.max(du, dv), short: Math.min(du, dv) };
    }
  }
  return { angle: best.angle, long: best.long, short: best.short };
}

const deg = (r: number) => (r * 180) / Math.PI;
const clampPitch = (p: number) => Math.round(Math.max(3, Math.min(75, p)) * 100) / 100;

/** Cobertura do v2 → RoofSpec do forma/3. */
export function roofFrom2(m: Mass, outer: Vec2[]): RoofSpec {
  const k = m.roof.kind;
  const h = m.roof.height;
  const rect = minRect(outer);
  const half = Math.max(0.25, rect.short / 2);
  if (k === 'flat') return roofSpec('flat', { parapet: 0.45, overhang: 0 });
  if (k === 'dome') return roofSpec('dome', { rise: h, overhang: 0 });
  if (k === 'shed') {
    // O v2 sobe a água única ao longo de x (ou da direção pedida) pelo vão inteiro.
    const dir = m.roof.direction ?? 0;
    const d = (dir * Math.PI) / 180;
    const proj = outer.map((p) => p[0] * Math.cos(d) + p[1] * Math.sin(d));
    const span = Math.max(0.5, Math.max(...proj) - Math.min(...proj));
    return roofSpec('shed', { pitch: clampPitch(deg(Math.atan(h / span))), direction: dir, overhang: m.roof.overhang ?? 0 });
  }
  // Sem direção no v2, a cumeeira segue o lado longo (o mesmo que a escolha automática faria).
  const direction = Math.round((m.roof.direction ?? rect.angle) * 100) / 100;
  const overhang = m.roof.overhang ?? 0.4;
  if (k === 'mansard') {
    // v2: 70 % da altura na água de baixo até a dobra; o forma/3 faz a de baixo íngreme e
    // usa a inclinação para a de cima, que leva os 30 % restantes.
    const fold = Math.min(0.42 * half, 2.6);
    return roofSpec('mansard', { pitch: clampPitch(deg(Math.atan((0.3 * h) / Math.max(0.3, half - fold)))), direction, overhang });
  }
  const kind: RoofKind = k === 'hip' ? 'hip' : 'gable';
  return roofSpec(kind, { pitch: clampPitch(deg(Math.atan(h / half))), direction, overhang });
}

interface RuleContext {
  /** Pé-direito mínimo e do térreo entre os pavimentos da massa. */
  minLevel: number;
  groundLevel: number;
  balcony: string | undefined;
}

const r2 = (v: number) => Math.round(v * 1000) / 1000;

/** Regras de fachada de uma configuração de lado do v2 (vazio para 'blank'). */
export function rulesFor(cfg: EdgeConfig, edges: ID[], c: RuleContext): FacadeRule[] {
  const out: FacadeRule[] = [];
  const common = { edges, margin: 0.35, justify: 'center' as const };
  const lh = c.minLevel;
  const window = (type: string, levels: FacadeRule['levels']) => {
    const h = Math.max(0.3, Math.min(cfg.windowHeight, lh - 0.5));
    let sill = Math.max(0.45, (lh - h) * 0.52);
    if (sill + h > lh - 0.1) sill = Math.max(0, lh - 0.1 - h);
    out.push(facadeRule(type, { ...common, levels, mode: 'spacing', value: cfg.spacing, sill: r2(sill), params: { width: cfg.windowWidth, height: r2(h), frameColor: cfg.trim } }));
  };
  switch (cfg.pattern) {
    case 'blank':
      return out;
    case 'regular':
      window('win-casement', 'all');
      break;
    case 'arched':
      window('win-arched', 'all');
      break;
    case 'storefront': {
      const h = Math.max(2.2, Math.min(5, c.groundLevel - 0.45));
      out.push(facadeRule('shopfront', { ...common, levels: 'ground', mode: 'max', value: 4.6, sill: 0, params: { width: 4, height: r2(h), frameColor: cfg.trim } }));
      window('win-casement', 'upper');
      break;
    }
    case 'curtain': {
      const pitch = Math.max(1.4, cfg.spacing * 0.8);
      const h = Math.max(0.3, Math.min(4.5, lh - 0.1 - 0.45));
      out.push(facadeRule('win-tall', { ...common, levels: 'all', mode: 'spacing', value: r2(pitch), sill: 0.1, params: { width: r2(Math.max(0.6, pitch - 0.18)), height: r2(h), frameColor: cfg.trim } }));
      break;
    }
  }
  if (cfg.balconies && c.balcony) out.push(facadeRule(c.balcony, { ...common, levels: 'upper', mode: 'spacing', value: cfg.spacing }));
  return out;
}

const configKey = (c: EdgeConfig) => JSON.stringify([c.pattern, c.windowWidth, c.windowHeight, c.spacing, c.trim, c.balconies]);

function openingItem(o: Opening, m: Mass, base: number, storeyElevation: number, trim: string): Item | null {
  if (o.host.kind !== 'massEdge') return null;
  const arch = !!o.fill.arch;
  let type: string;
  const params: Record<string, ParamValue> = { width: o.width, height: o.height };
  switch (o.fill.type) {
    case 'door':
      type = arch ? 'door-arched' : 'door-panel';
      break;
    case 'window':
      type = arch ? 'win-arched' : 'win-casement';
      params.frameColor = trim;
      break;
    case 'storefront':
      type = 'shopfront';
      params.frameColor = trim;
      break;
    default:
      return null;
  }
  return { id: o.id, type, params, host: { kind: 'face', solid: m.id, edge: o.host.edgeId, u: r2(o.offset), y: r2(storeyElevation - base + o.sill) } };
}

function interiorsOf(b: Building): Record<ID, Interior> {
  const out: Record<ID, Interior> = {};
  for (const s of b.storeys) {
    const g = s.graph;
    if (!g.nodes.length && !g.walls.length && !s.rooms.length) continue;
    out[s.id] = {
      nodes: g.nodes.map((n) => ({ id: n.id, p: [n.p[0], n.p[1]] })),
      walls: g.walls.map((w) => ({ id: w.id, a: w.a, b: w.b, thickness: w.thickness, ...(w.splitFrom ? { splitFrom: w.splitFrom } : {}) })),
      rooms: s.rooms.map((r) => ({ id: r.id, name: r.name, wallIds: [...r.wallIds], ...(r.polygon ? { polygon: r.polygon.map((p) => [p[0], p[1]] as Vec2) } : {}), ...(r.area !== undefined ? { area: r.area } : {}) })),
    };
  }
  return out;
}

function useOf(b: Building): BuildingUse {
  const patterns = new Set<FacadePattern>(b.masses.flatMap((m) => [m.facade.pattern, ...Object.values(m.edges).map((e: EdgeOverride) => e.pattern).filter((p): p is FacadePattern => !!p)]));
  if (patterns.has('storefront')) return b.storeys.length > 1 ? 'mixed' : 'commercial';
  if (patterns.has('curtain')) return 'commercial';
  return 'residential';
}

/** Converte um projeto forma/2 (já validado) para forma/3. */
export function fromForma2(p: Project): Migration {
  const notes = new Set<string>();
  const balcony = balconyType();
  const buildings: Building3[] = p.buildings.map((b) => {
    const storeys = sortedStoreys(b);
    const levels: Level[] = storeys.map((s) => ({ id: s.id, name: s.name, elevation: s.elevation, height: s.height }));
    const items: Item[] = [];
    const solids: Solid[] = b.masses.map((m) => {
      const ext = massExtent(b, m);
      const toPV = (v: { id: ID; p: Vec2 }): PlanVertex => ({ id: v.id, p: [v.p[0], v.p[1]] });
      const outer = m.outer.vertices.map(toPV);
      const holes = m.holes.map((h) => h.vertices.map(toPV));
      const wallFinish = m.finish.material && FINISH_IDS.has(m.finish.material) ? m.finish.material : 'plaster';
      const materials = {
        wall: mat(wallFinish, m.finish.wall),
        roof: mat('tile', m.roof.color),
        trim: mat('paint', m.finish.trim),
        base: structuredClone(DEFAULT_MATERIALS.base),
      };
      const heights = ext.storeys.map((s) => s.height);
      const ctx: RuleContext = { minLevel: heights.length ? Math.min(...heights) : 3, groundLevel: heights[0] ?? 3, balcony };
      const edges: Record<ID, EdgeSpec> = {};
      const groups = new Map<string, { cfg: EdgeConfig; ids: ID[] }>();
      const base = edgeConfig(m, undefined);
      const baseKey = configKey(base);
      const manualEdges = new Set<ID>();
      for (const e of massEdges(m)) {
        const o = m.edges[e.id];
        const cfg = edgeConfig(m, o);
        const spec: EdgeSpec = {};
        if (o?.wall) spec.material = mat(wallFinish, o.wall);
        if (cfg.manual) {
          spec.blank = true;
          manualEdges.add(e.id);
        } else if (configKey(cfg) !== baseKey) {
          spec.blank = true;
          const k = configKey(cfg);
          let g = groups.get(k);
          if (!g) groups.set(k, (g = { cfg, ids: [] }));
          g.ids.push(e.id);
        }
        if (cfg.balconies && !balcony) notes.add('Sacadas do forma/2 ainda não têm componente no FORMA 3 e ficaram de fora.');
        if (cfg.brise) notes.add('Brises do forma/2 ainda não têm componente no FORMA 3 e ficaram de fora.');
        if (Object.keys(spec).length) edges[e.id] = spec;
      }
      const facade = [...rulesFor(base, [], ctx), ...[...groups.values()].flatMap((g) => rulesFor(g.cfg, g.ids, ctx))];
      if (m.flags.cornice || m.flags.pilotis || m.flags.garden) notes.add('Cornijas, pilotis e jardins de cobertura do forma/2 não têm equivalente no FORMA 3 e ficaram de fora.');
      if (m.style) notes.add('O estilo por massa do forma/2 não passa para o FORMA 3 (os pacotes de estilo do projeto foram mantidos).');
      // Aberturas manuais: só valem nos lados marcados como manuais (como no v2).
      const storeyById = new Map(b.storeys.map((s) => [s.id, s]));
      for (const o of b.openings) {
        if (o.host.kind !== 'massEdge' || o.host.massId !== m.id) continue;
        if (!manualEdges.has(o.host.edgeId)) {
          notes.add('Aberturas desenhadas em lados sem o modo manual eram ignoradas no forma/2 e não foram convertidas.');
          continue;
        }
        const st = storeyById.get(o.storeyId);
        const it = st ? openingItem(o, m, ext.base, st.elevation, edgeConfig(m, m.edges[o.host.edgeId]).trim) : null;
        if (it) items.push(it);
        else notes.add('Vãos vazios (sem caixilho) do forma/2 não têm componente no FORMA 3 e ficaram de fora.');
      }
      return solid({
        id: m.id,
        name: m.name,
        op: 'add',
        plan: { outer, holes },
        base: ext.base,
        height: ext.height,
        edges,
        roof: roofFrom2(m, outer.map((v) => v.p)),
        facade,
        materials,
      });
    });
    if (b.openings.some((o) => o.host.kind === 'wall')) notes.add('Portas internas do forma/2 ainda não passam para o FORMA 3.');
    if (b.slabs.length || b.stairs.length) notes.add('Lajes e escadas do forma/2 ainda não passam para o FORMA 3.');
    if (b.styleRef) notes.add('O estilo do edifício no forma/2 não passa para o FORMA 3 (os pacotes de estilo do projeto foram mantidos).');
    return {
      id: b.id,
      name: b.name,
      lotId: b.lotId,
      position: [b.position[0], b.position[1]],
      rotation: b.rotation,
      use: useOf(b),
      levels,
      solids,
      items,
      interiors: interiorsOf(b),
    };
  });
  const project: Project3 = {
    schema: SCHEMA3,
    name: p.name,
    lots: structuredClone(p.lots),
    buildings,
    types: [],
    styles: structuredClone(p.styles),
    meta: { createdWith: 'FORMA 3', migratedFrom: p.meta.migratedFrom === 1 ? 1 : 2 },
  };
  return { project, notes: [...notes] };
}

// ── Validação forma/3 ──────────────────────────────────────────────────

const COLOR = /^#[0-9a-f]{6}$/i;
const USES: BuildingUse[] = ['residential', 'commercial', 'industrial', 'public', 'mixed'];
const OPS = ['add', 'subtract', 'intersect'];
const ROOFS: RoofKind[] = ['flat', 'terrace', 'shed', 'gable', 'hip', 'mansard', 'gambrel', 'pyramid', 'dome', 'vault', 'sawtooth'];
const PICKS = ['all', 'ground', 'upper', 'top', 'middle'];
const MODES = ['spacing', 'max', 'count', 'fit'];
const JUSTIFY = ['start', 'center', 'end'];
const MAX_ERRORS = 60;

class Errors {
  readonly list: string[] = [];
  add(where: string, msg: string): void {
    if (this.list.length < MAX_ERRORS) this.list.push(`${where}: ${msg}`);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const vec = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(fin);

function checkMaterial(e: Errors, where: string, m: unknown, name: string): void {
  if (!isObj(m) || !str(m.finish, 40)) e.add(where, `${name}: acabamento inválido.`);
  else if (typeof m.color !== 'string' || !COLOR.test(m.color)) e.add(where, `${name}: cor inválida.`);
}

function checkParams(e: Errors, where: string, p: unknown): void {
  if (!isObj(p)) return e.add(where, 'parâmetros inválidos.');
  for (const [k, v] of Object.entries(p)) if (!(fin(v) || typeof v === 'string' || typeof v === 'boolean')) e.add(where, `parâmetro "${k}" com valor inválido.`);
}

function checkRing(e: Errors, where: string, ring: unknown, name: string, ids: Set<string>): void {
  if (!Array.isArray(ring) || ring.length < 3) return e.add(where, `${name} precisa de pelo menos 3 pontos.`);
  for (const v of ring as PlanVertex[]) {
    if (!isObj(v) || !str(v.id)) {
      e.add(where, `vértice sem ID em ${name}.`);
      continue;
    }
    if (ids.has(v.id)) e.add(where, `ID de vértice repetido (${v.id}).`);
    ids.add(v.id);
    if (!vec(v.p, 2)) e.add(where, `ponto inválido em ${name}.`);
    else if (Math.abs(v.p[0]) > LIMITS3.worldExtent || Math.abs(v.p[1]) > LIMITS3.worldExtent) e.add(where, `ponto fora do limite de ${LIMITS3.worldExtent} m em ${name}.`);
    for (const k of ['bulge', 'round', 'chamfer'] as const) if (v[k] !== undefined && !fin(v[k])) e.add(where, `${k} inválido em ${name}.`);
    if ((v.round ?? 0) < 0 || (v.chamfer ?? 0) < 0) e.add(where, `canto negativo em ${name}.`);
  }
}

function knownType(id: unknown, p: Project3): boolean {
  return typeof id === 'string' && !!typeById(id, p);
}

function checkSolid(e: Errors, where: string, s: Solid, p: Project3, ruleIds: Set<string>): void {
  const w = `${where}, sólido "${typeof s?.name === 'string' ? s.name : '?'}"`;
  if (!str(s.name, 60)) e.add(w, 'nome inválido.');
  if (!OPS.includes(s.op)) e.add(w, 'operação desconhecida.');
  if (!isObj(s.plan)) return e.add(w, 'sem planta.');
  const vids = new Set<string>();
  checkRing(e, w, s.plan.outer, 'contorno', vids);
  if (!Array.isArray(s.plan.holes)) e.add(w, 'furos inválidos.');
  else s.plan.holes.forEach((h, i) => checkRing(e, w, h, `furo ${i + 1}`, vids));
  if (vids.size > LIMITS3.maxVertices) e.add(w, `mais de ${LIMITS3.maxVertices} vértices.`);
  if (!fin(s.base)) e.add(w, 'base inválida.');
  if (!fin(s.height) || s.height <= 0) e.add(w, 'altura inválida.');
  else if (fin(s.base) && s.base + s.height > LIMITS3.maxHeight + 1e-6) e.add(w, `acima de ${LIMITS3.maxHeight} m.`);
  if (!fin(s.taper) || s.taper < 0) e.add(w, 'afunilamento inválido.');
  if (!fin(s.plinth) || s.plinth < 0) e.add(w, 'embasamento inválido.');
  if (s.hidden !== undefined && typeof s.hidden !== 'boolean') e.add(w, 'visibilidade inválida.');
  if (!isObj(s.edges)) e.add(w, 'ajustes de lado inválidos.');
  else
    for (const [id, spec] of Object.entries(s.edges)) {
      if (!vids.has(id)) e.add(w, `ajuste num lado inexistente (${id}).`);
      if (!isObj(spec)) continue;
      if (spec.lean !== undefined && !fin(spec.lean)) e.add(w, 'inclinação de lado inválida.');
      for (const k of ['gable', 'blank'] as const) if (spec[k] !== undefined && typeof spec[k] !== 'boolean') e.add(w, `${k} deve ser verdadeiro ou falso.`);
      if (spec.material !== undefined) checkMaterial(e, w, spec.material, 'material do lado');
    }
  const r = s.roof;
  if (!isObj(r)) e.add(w, 'sem cobertura.');
  else {
    if (!ROOFS.includes(r.kind)) e.add(w, 'tipo de cobertura desconhecido.');
    for (const k of ['pitch', 'rise', 'overhang', 'direction', 'parapet', 'thickness'] as const) if (!fin(r[k])) e.add(w, `cobertura: ${k} inválido.`);
    for (const k of ['rise', 'overhang', 'parapet', 'thickness'] as const) if (fin(r[k]) && r[k] < 0) e.add(w, `cobertura: ${k} negativo.`);
  }
  if (!isObj(s.materials)) e.add(w, 'sem materiais.');
  else for (const k of ['wall', 'roof', 'trim', 'base'] as const) checkMaterial(e, w, s.materials[k], `material ${k}`);
  if (!Array.isArray(s.facade)) return e.add(w, 'regras de fachada inválidas.');
  for (const rule of s.facade) {
    if (!isObj(rule) || !str(rule.id)) {
      e.add(w, 'regra de fachada sem ID.');
      continue;
    }
    if (ruleIds.has(rule.id)) e.add(w, `ID de regra repetido (${rule.id}).`);
    ruleIds.add(rule.id);
    if (!knownType(rule.type, p)) e.add(w, `regra com tipo desconhecido (${String(rule.type)}).`);
    const lv = rule.levels;
    if (!(PICKS.includes(lv as string) || (Array.isArray(lv) && lv.every((i) => Number.isInteger(i) && i >= 0)))) e.add(w, 'níveis da regra inválidos.');
    if (!Array.isArray(rule.edges)) e.add(w, 'lados da regra inválidos.');
    else for (const id of rule.edges) if (!vids.has(id)) e.add(w, `regra aponta para lado inexistente (${id}).`);
    if (!MODES.includes(rule.mode)) e.add(w, 'distribuição da regra desconhecida.');
    if (!fin(rule.value) || rule.value <= 0) e.add(w, 'valor da distribuição inválido.');
    if (!fin(rule.margin) || rule.margin < 0) e.add(w, 'margem da regra inválida.');
    // NaN (ou null, depois do JSON) = peitoril do tipo.
    if (!(rule.sill === null || Number.isNaN(rule.sill) || fin(rule.sill))) e.add(w, 'peitoril da regra inválido.');
    if (!JUSTIFY.includes(rule.justify)) e.add(w, 'justificação da regra inválida.');
    if (!isObj(rule.except)) e.add(w, 'exceções da regra inválidas.');
    else for (const v of Object.values(rule.except)) if (v !== 'none' && !knownType(v, p)) e.add(w, `exceção com tipo desconhecido (${String(v)}).`);
    checkParams(e, w, rule.params);
  }
}

function checkItem(e: Errors, where: string, it: Item, p: Project3, solids: Map<string, Solid>): void {
  const w = `${where}, componente ${typeof it?.id === 'string' ? it.id : '?'}`;
  if (!knownType(it.type, p)) e.add(w, `tipo desconhecido (${String(it.type)}).`);
  checkParams(e, w, it.params);
  const h = it.host;
  if (!isObj(h)) return e.add(w, 'sem apoio.');
  if (h.kind === 'face') {
    const s = solids.get(h.solid);
    if (!s) e.add(w, 'preso a um sólido inexistente.');
    else if (![s.plan.outer, ...s.plan.holes].some((r) => r.some((v) => v.id === h.edge))) e.add(w, 'preso a um lado inexistente.');
    if (!fin(h.u) || !fin(h.y)) e.add(w, 'posição na face inválida.');
  } else if (h.kind === 'free') {
    if (!vec(h.p, 3) || !fin(h.rot)) e.add(w, 'posição livre inválida.');
  } else if (h.kind === 'path') {
    if (!Array.isArray(h.points) || h.points.length < 2 || !h.points.every((q) => vec(q, 3))) e.add(w, 'caminho inválido (pelo menos 2 pontos).');
  } else if (h.kind === 'roof') {
    if (!solids.has(h.solid)) e.add(w, 'sobre um sólido inexistente.');
    if (!vec(h.p, 2) || !fin(h.rot)) e.add(w, 'posição no telhado inválida.');
  } else e.add(w, 'tipo de apoio desconhecido.');
  if (it.array !== undefined) {
    const a = it.array;
    if (!isObj(a) || !isObj(a.along) || !MODES.includes(a.along.mode) || !fin(a.along.value) || !fin(a.along.count) || a.along.count < 1) e.add(w, 'arranjo inválido.');
    else if (a.across !== undefined && (!fin(a.across.count) || a.across.count < 1 || !fin(a.across.spacing))) e.add(w, 'arranjo em colunas inválido.');
  }
}

function checkBuilding(e: Errors, b: Building3, p: Project3, lotIds: Set<string>): void {
  const w = `Edifício "${typeof b?.name === 'string' ? b.name : '?'}"`;
  if (!isObj(b)) return e.add('Projeto', 'edifício inválido.');
  if (!str(b.name, 60)) e.add(w, 'nome inválido.');
  if (b.lotId !== null && !lotIds.has(b.lotId)) e.add(w, 'lote inexistente.');
  if (!vec(b.position, 2)) e.add(w, 'posição inválida.');
  else if (Math.abs(b.position[0]) > LIMITS3.worldExtent || Math.abs(b.position[1]) > LIMITS3.worldExtent) e.add(w, `posição fora do limite de ${LIMITS3.worldExtent} m.`);
  if (!fin(b.rotation)) e.add(w, 'rotação inválida.');
  if (!USES.includes(b.use)) e.add(w, 'uso desconhecido.');
  if (!Array.isArray(b.levels) || b.levels.length > LIMITS3.maxLevels) e.add(w, `níveis inválidos ou acima de ${LIMITS3.maxLevels}.`);
  else {
    const ids = new Set<string>();
    for (const l of b.levels) {
      if (!isObj(l) || !str(l.id)) {
        e.add(w, 'nível sem ID.');
        continue;
      }
      if (ids.has(l.id)) e.add(w, `ID de nível repetido (${l.id}).`);
      ids.add(l.id);
      if (!str(l.name, 60)) e.add(w, 'nome de nível inválido.');
      if (!fin(l.elevation) || !fin(l.height) || l.height <= 0) e.add(w, `nível "${l.name}" com cota ou altura inválida.`);
      else if (l.elevation + l.height > LIMITS3.maxHeight + 1e-6) e.add(w, `nível "${l.name}" acima de ${LIMITS3.maxHeight} m.`);
    }
    if (!isObj(b.interiors)) e.add(w, 'interiores inválidos.');
    else
      for (const [lid, int] of Object.entries(b.interiors)) {
        if (!ids.has(lid)) e.add(w, `interior num nível inexistente (${lid}).`);
        if (!isObj(int) || !Array.isArray(int.nodes) || !Array.isArray(int.walls) || !Array.isArray(int.rooms)) {
          e.add(w, 'interior inválido.');
          continue;
        }
        const nodes = new Set(int.nodes.map((n) => n.id));
        for (const n of int.nodes) if (!vec(n.p, 2)) e.add(w, 'nó de parede interna inválido.');
        for (const wl of int.walls) {
          if (!nodes.has(wl.a) || !nodes.has(wl.b)) e.add(w, 'parede interna aponta para nó inexistente.');
          if (!fin(wl.thickness) || wl.thickness <= 0) e.add(w, 'espessura de parede interna inválida.');
        }
      }
  }
  const solids = new Map<string, Solid>();
  const ruleIds = new Set<string>();
  if (!Array.isArray(b.solids) || b.solids.length > LIMITS3.maxSolids) e.add(w, `sólidos inválidos ou acima de ${LIMITS3.maxSolids}.`);
  else
    for (const s of b.solids) {
      if (!isObj(s) || !str(s.id)) {
        e.add(w, 'sólido sem ID.');
        continue;
      }
      if (solids.has(s.id)) e.add(w, `ID de sólido repetido (${s.id}).`);
      solids.set(s.id, s);
      checkSolid(e, w, s, p, ruleIds);
    }
  if (!Array.isArray(b.items) || b.items.length > LIMITS3.maxItems) e.add(w, `componentes inválidos ou acima de ${LIMITS3.maxItems}.`);
  else {
    const ids = new Set<string>();
    for (const it of b.items) {
      if (!isObj(it) || !str(it.id)) {
        e.add(w, 'componente sem ID.');
        continue;
      }
      if (ids.has(it.id)) e.add(w, `ID de componente repetido (${it.id}).`);
      ids.add(it.id);
      checkItem(e, w, it, p, solids);
    }
  }
}

/** Valida um projeto forma/3. Devolve as mensagens (vazio = válido). */
export function validateForma3(raw: unknown): string[] {
  const e = new Errors();
  const p = raw as Project3;
  if (!isObj(p) || p.schema !== SCHEMA3) return ['Projeto: não é um projeto forma/3.'];
  if (!str(p.name, 70)) e.add('Projeto', 'nome inválido.');
  if (!isObj(p.meta) || !str(p.meta.createdWith)) e.add('Projeto', 'metadados inválidos.');
  else if (p.meta.migratedFrom !== undefined && p.meta.migratedFrom !== 1 && p.meta.migratedFrom !== 2) e.add('Projeto', 'versão de origem inválida.');
  const lotIds = new Set<string>();
  if (!Array.isArray(p.lots) || p.lots.length > 500) e.add('Projeto', 'lotes inválidos ou acima de 500.');
  else
    for (const lot of p.lots) {
      const w = `Lote "${typeof lot?.name === 'string' ? lot.name : '?'}"`;
      if (!isObj(lot) || !str(lot.id)) {
        e.add('Projeto', 'lote sem ID.');
        continue;
      }
      if (lotIds.has(lot.id)) e.add(w, `ID de lote repetido (${lot.id}).`);
      lotIds.add(lot.id);
      if (!str(lot.name, 60)) e.add(w, 'nome inválido.');
      if (!Array.isArray(lot.polygon) || lot.polygon.length < 3 || !lot.polygon.every((q) => vec(q, 2))) e.add(w, 'polígono inválido (pelo menos 3 pontos).');
      else if (lot.polygon.some((q) => Math.abs(q[0]) > LIMITS3.worldExtent || Math.abs(q[1]) > LIMITS3.worldExtent)) e.add(w, `polígono fora do limite de ${LIMITS3.worldExtent} m.`);
      if (!Array.isArray(lot.frontEdges) || lot.frontEdges.some((i) => !Number.isInteger(i) || i < 0 || i >= (lot.polygon?.length ?? 0))) e.add(w, 'testada aponta para aresta inexistente.');
    }
  if (!Array.isArray(p.types)) e.add('Projeto', 'tipos de componente inválidos.');
  else {
    const ids = new Set<string>();
    for (const t of p.types) {
      if (!isObj(t) || !str(t.id)) {
        e.add('Projeto', 'tipo de componente sem ID.');
        continue;
      }
      if (ids.has(t.id)) e.add('Projeto', `ID de tipo repetido (${t.id}).`);
      ids.add(t.id);
      if (!str(t.name, 80)) e.add(`Tipo ${t.id}`, 'nome inválido.');
      if (!str(t.family, 60) || !family(t.family)) e.add(`Tipo ${t.id}`, `família desconhecida (${String(t.family)}).`);
      checkParams(e, `Tipo ${t.id}`, t.params);
    }
  }
  if (!Array.isArray(p.buildings) || p.buildings.length > LIMITS3.maxBuildings) e.add('Projeto', `edifícios inválidos ou acima de ${LIMITS3.maxBuildings}.`);
  else {
    const ids = new Set<string>();
    for (const b of p.buildings) {
      if (isObj(b) && str(b.id)) {
        if (ids.has(b.id)) e.add('Projeto', `ID de edifício repetido (${b.id}).`);
        ids.add(b.id);
      } else e.add('Projeto', 'edifício sem ID.');
      if (Array.isArray(p.types)) checkBuilding(e, b, p, lotIds);
    }
  }
  if (!Array.isArray(p.styles) || p.styles.length > 200) e.add('Projeto', 'estilos inválidos.');
  else for (const st of p.styles) for (const msg of validateStylePack(st).slice(0, 3)) e.add(`Estilo "${String((st as { name?: string })?.name ?? '?')}"`, msg);
  return e.list;
}

