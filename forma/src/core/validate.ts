// Validação do esquema forma/2: tipos, faixas e integridade das referências.
// Lança Error com mensagem em português na primeira inconsistência.
import type { Building, Limits, Lot, Mass, Project, Ring } from './schema';
import { DEFAULT_LIMITS, SCHEMA } from './schema';
import { validPolygon, type PolygonLimits } from '../geometry/polygon';
import { validHoles } from '../geometry/boolean';
import { massEdges } from '../geometry/ring';

const COLOR = /^#[0-9a-f]{6}$/i;
const ROOFS = ['flat', 'shed', 'gable', 'dome', 'hip', 'mansard'];
const PATTERNS = ['regular', 'storefront', 'curtain', 'blank', 'arched'];
const FILLS = ['window', 'door', 'void', 'storefront'];

class Check {
  constructor(private where: string) {}
  fail(msg: string): never {
    throw new Error(`${this.where}: ${msg}`);
  }
  str(v: unknown, name: string, max = 200): string {
    if (typeof v !== 'string' || !v.length || v.length > max) this.fail(`${name} inválido.`);
    return v;
  }
  num(v: unknown, name: string, min: number, max: number): number {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) this.fail(`${name} fora do intervalo (${min} a ${max}).`);
    return v;
  }
  bool(v: unknown, name: string): boolean {
    if (typeof v !== 'boolean') this.fail(`${name} deve ser verdadeiro ou falso.`);
    return v;
  }
  color(v: unknown, name: string): string {
    if (typeof v !== 'string' || !COLOR.test(v)) this.fail(`${name}: cor inválida.`);
    return v;
  }
  oneOf(v: unknown, name: string, options: string[]): string {
    if (typeof v !== 'string' || !options.includes(v)) this.fail(`${name} inválido.`);
    return v;
  }
  arr(v: unknown, name: string, max: number): unknown[] {
    if (!Array.isArray(v) || v.length > max) this.fail(`${name} inválido ou acima de ${max} itens.`);
    return v;
  }
}

function polyLimits(l: Limits): PolygonLimits {
  return { maxVertices: l.maxVertices, extent: l.worldExtent, minArea: 0.12, minEdge: 0.02 };
}

function checkRing(c: Check, r: unknown, name: string, ids: Set<string>, l: Limits): Ring {
  const ring = r as Ring;
  if (!ring || !Array.isArray(ring.vertices)) c.fail(`${name} sem vértices.`);
  for (const v of ring.vertices) {
    c.str(v?.id, `ID de vértice em ${name}`);
    if (ids.has(v.id)) c.fail(`ID de vértice repetido em ${name}.`);
    ids.add(v.id);
  }
  if (!validPolygon(ring.vertices.map((v) => v.p), polyLimits(l))) c.fail(`${name} se cruza, é pequeno demais ou tem coordenadas inválidas.`);
  return ring;
}

function checkMass(c: Check, m: Mass, storeyIds: Set<string>, l: Limits): void {
  c.str(m.id, 'ID da massa');
  c.str(m.name, 'Nome da massa', 60);
  const vids = new Set<string>();
  checkRing(c, m.outer, 'Base', vids, l);
  c.arr(m.holes, 'Pátios', l.maxHoles).forEach((h, i) => checkRing(c, h, `Pátio ${i + 1}`, vids, l));
  if (!validHoles(m.outer.vertices.map((v) => v.p), m.holes.map((h) => h.vertices.map((v) => v.p)), polyLimits(l))) c.fail('Pátio fora da base ou sobreposto.');
  if (!storeyIds.has(m.fromStorey) || !storeyIds.has(m.toStorey)) c.fail('Massa aponta para pavimento inexistente.');
  c.oneOf(m.roof?.kind, 'Tipo de cobertura', ROOFS);
  c.num(m.roof.height, 'Altura da cobertura', 0.2, 10);
  c.color(m.roof.color, 'Cor da cobertura');
  c.oneOf(m.facade?.pattern, 'Distribuição da fachada', PATTERNS);
  c.num(m.facade.windowWidth, 'Largura da janela', 0.25, 5);
  c.num(m.facade.windowHeight, 'Altura da janela', 0.3, 4);
  c.num(m.facade.spacing, 'Intervalo das janelas', 1, 8);
  c.color(m.finish?.wall, 'Cor da parede');
  c.color(m.finish.trim, 'Cor dos caixilhos');
  for (const k of ['balconies', 'brise', 'cornice', 'garden', 'pilotis'] as const) c.bool(m.flags?.[k], `Detalhe ${k}`);
  if (!m.edges || typeof m.edges !== 'object') c.fail('Ajustes de fachada inválidos.');
  for (const [id, o] of Object.entries(m.edges)) {
    if (!vids.has(id)) c.fail('Ajuste de fachada aponta para aresta inexistente.');
    if (o.pattern !== undefined) c.oneOf(o.pattern, 'Distribuição da face', PATTERNS);
    if (o.wall !== undefined) c.color(o.wall, 'Cor da face');
    if (o.trim !== undefined) c.color(o.trim, 'Caixilho da face');
    if (o.windowWidth !== undefined) c.num(o.windowWidth, 'Largura da janela da face', 0.25, 5);
    if (o.windowHeight !== undefined) c.num(o.windowHeight, 'Altura da janela da face', 0.3, 4);
    if (o.spacing !== undefined) c.num(o.spacing, 'Intervalo da face', 1, 8);
  }
}

function checkBuilding(b: Building, lotIds: Set<string>, l: Limits): void {
  const c = new Check(`Edifício "${typeof b?.name === 'string' ? b.name : '?'}"`);
  c.str(b.id, 'ID');
  c.str(b.name, 'Nome', 60);
  if (b.lotId !== null && !lotIds.has(b.lotId)) c.fail('Lote inexistente.');
  if (!Array.isArray(b.position) || b.position.length !== 2) c.fail('Posição inválida.');
  c.num(b.position[0], 'Posição x', -l.worldExtent, l.worldExtent);
  c.num(b.position[1], 'Posição z', -l.worldExtent, l.worldExtent);
  c.num(b.rotation, 'Rotação', -3600, 3600);
  const storeys = c.arr(b.storeys, 'Pavimentos', l.maxStoreys) as Building['storeys'];
  if (!storeys.length) c.fail('Edifício sem pavimentos.');
  const storeyIds = new Set<string>();
  for (const s of storeys) {
    c.str(s.id, 'ID do pavimento');
    if (storeyIds.has(s.id)) c.fail('ID de pavimento repetido.');
    storeyIds.add(s.id);
    c.str(s.name, 'Nome do pavimento', 60);
    c.num(s.elevation, 'Elevação do pavimento', 0, l.maxHeight);
    c.num(s.height, 'Altura do pavimento', 0.3, l.maxHeight);
    if (s.elevation + s.height > l.maxHeight + 1e-6) c.fail(`Pavimento acima de ${l.maxHeight} m.`);
    c.num(s.slabThickness, 'Espessura da laje', 0, 2);
    const nodes = new Set((c.arr(s.graph?.nodes, 'Nós', 5000) as { id: string }[]).map((n) => n.id));
    for (const w of c.arr(s.graph.walls, 'Paredes', 5000) as Building['storeys'][number]['graph']['walls']) {
      if (!nodes.has(w.a) || !nodes.has(w.b)) c.fail('Parede aponta para nó inexistente.');
      c.num(w.thickness, 'Espessura da parede', 0.02, 2);
    }
    c.arr(s.rooms, 'Cômodos', 2000);
  }
  const edgeIds = new Map<string, Set<string>>();
  for (const m of c.arr(b.masses, 'Massas', 200) as Mass[]) {
    checkMass(c, m, storeyIds, l);
    edgeIds.set(m.id, new Set(massEdges(m).map((e) => e.id)));
  }
  const perEdge = new Map<string, number>();
  for (const o of c.arr(b.openings, 'Aberturas', 20000) as Building['openings']) {
    c.str(o.id, 'ID da abertura');
    if (!storeyIds.has(o.storeyId)) c.fail('Abertura em pavimento inexistente.');
    if (o.host?.kind === 'massEdge') {
      if (!edgeIds.get(o.host.massId)?.has(o.host.edgeId)) c.fail('Abertura em parede inexistente.');
      const key = o.host.massId + '/' + o.host.edgeId;
      perEdge.set(key, (perEdge.get(key) ?? 0) + 1);
      if (perEdge.get(key)! > l.maxOpeningsPerEdge) c.fail(`Mais de ${l.maxOpeningsPerEdge} aberturas numa parede.`);
    } else if (o.host?.kind !== 'wall') c.fail('Abertura sem parede.');
    c.num(o.offset, 'Posição da abertura', 0, 1000);
    c.num(o.sill, 'Peitoril', 0, l.maxHeight);
    c.num(o.width, 'Largura da abertura', 0.25, 8);
    c.num(o.height, 'Altura da abertura', 0.3, 8);
    c.oneOf(o.fill?.type, 'Tipo de abertura', FILLS);
  }
  c.arr(b.slabs, 'Lajes', 1000);
  for (const st of c.arr(b.stairs, 'Escadas', 200) as Building['stairs']) {
    if (!storeyIds.has(st.fromStorey) || !storeyIds.has(st.toStorey)) c.fail('Escada aponta para pavimento inexistente.');
    c.num(st.width, 'Largura da escada', 0.5, 10);
  }
}

function checkLot(lot: Lot, l: Limits): void {
  const c = new Check(`Lote "${typeof lot?.name === 'string' ? lot.name : '?'}"`);
  c.str(lot.id, 'ID');
  c.str(lot.name, 'Nome', 60);
  if (!validPolygon(lot.polygon, polyLimits(l))) c.fail('Polígono do lote inválido.');
  for (const i of c.arr(lot.frontEdges, 'Testada', lot.polygon.length) as number[])
    if (!Number.isInteger(i) || i < 0 || i >= lot.polygon.length) c.fail('Testada aponta para aresta inexistente.');
  if (lot.rules) {
    const r = lot.rules;
    c.oneOf(r.enforcement, 'Modo das regras', ['block', 'warn']);
    for (const k of ['front', 'side', 'back'] as const) c.num(r.setbacks?.[k], `Recuo ${k}`, 0, 100);
    if (r.maxOccupancy !== undefined) c.num(r.maxOccupancy, 'Taxa de ocupação', 0, 1);
    if (r.minPermeability !== undefined) c.num(r.minPermeability, 'Taxa de permeabilidade', 0, 1);
    if (r.maxFAR !== undefined) c.num(r.maxFAR, 'Coeficiente de aproveitamento', 0, 100);
    if (r.maxHeight !== undefined) c.num(r.maxHeight, 'Gabarito', 0, 1000);
    if (r.maxStoreys !== undefined) c.num(r.maxStoreys, 'Máximo de pavimentos', 1, 1000);
  }
}

/** Valida um projeto forma/2 e devolve uma cópia. */
export function validateProject(raw: unknown, limits: Partial<Limits> = {}): Project {
  const l = { ...DEFAULT_LIMITS, ...limits };
  const p = raw as Project;
  if (!p || p.schema !== SCHEMA) throw new Error('Projeto incompatível com o FORMA 2.');
  const c = new Check('Projeto');
  c.str(p.name, 'Nome do projeto', 70);
  const lots = c.arr(p.lots, 'Lotes', 500) as Lot[];
  const lotIds = new Set<string>();
  for (const lot of lots) {
    checkLot(lot, l);
    if (lotIds.has(lot.id)) c.fail('ID de lote repetido.');
    lotIds.add(lot.id);
  }
  const buildings = c.arr(p.buildings, 'Edifícios', l.maxBuildings) as Building[];
  const ids = new Set<string>();
  for (const b of buildings) {
    checkBuilding(b, lotIds, l);
    if (ids.has(b.id)) c.fail('ID de edifício repetido.');
    ids.add(b.id);
  }
  c.arr(p.styles, 'Estilos', 200);
  return structuredClone(p);
}
