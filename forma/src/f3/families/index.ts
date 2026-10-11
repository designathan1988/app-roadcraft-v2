// Registro das famílias e dos tipos incluídos. Um tipo é uma família com
// valores nomeados; as ocorrências e as regras de fachada apontam para tipos.
import type { ComponentType, ID, Project3 } from '../model/schema';
import type { Family } from './family';
import { BAY_WINDOW, WINDOW } from './windows';
import { DOOR, GARAGE_DOOR, LOADING_DOOR, SHOPFRONT } from './doors';
import { BALCONY, VERANDA } from './balconies';
import { FENCE, GATE, HEDGE, WALL_RUN } from './fences';
import { JULIETTE, RAILING } from './railings';
import { BEAM, COLUMN, PERGOLA, PORTICO } from './structure';
import { RAMP, STAIR } from './stairs';
import { AWNING, BRISE, CANOPY, COBOGO, PORCH_ROOF, ROLL_SHUTTER } from './canopies';
import { BAND, CLOCK, CORNICE, DOWNPIPE, PEDIMENT, PILASTER, QUOINS, SIGN } from './ornament';
import { CHIMNEY, CUPOLA, DORMER, LADDER, SILO, SKYLIGHT, SOLAR, STACK, TANK, VENT, WATER_TANK } from './roofgear';
import { CLADDING, IMAGE_DECAL } from './decal';

const families = new Map<string, Family>();

export function registerFamily(f: Family): void {
  families.set(f.id, f);
}

export function family(id: string): Family | undefined {
  return families.get(id);
}

export function allFamilies(): Family[] {
  return [...families.values()];
}

for (const f of [WINDOW, BAY_WINDOW, DOOR, GARAGE_DOOR, LOADING_DOOR, SHOPFRONT, BALCONY, VERANDA, RAILING, JULIETTE, WALL_RUN, FENCE, GATE, HEDGE, COLUMN, BEAM, PERGOLA, PORTICO, STAIR, RAMP, CANOPY, AWNING, PORCH_ROOF, BRISE, COBOGO, ROLL_SHUTTER, CORNICE, PILASTER, QUOINS, PEDIMENT, BAND, SIGN, CLOCK, DOWNPIPE, CHIMNEY, SKYLIGHT, SOLAR, WATER_TANK, VENT, CUPOLA, DORMER, SILO, STACK, LADDER, TANK, IMAGE_DECAL, CLADDING]) registerFamily(f);

const t = (id: string, fam: string, name: string, params: ComponentType['params'] = {}): ComponentType => ({ id, family: fam, name, params });

/** Tipos incluídos (variações prontas de cada família). */
export const BUILTIN_TYPES: ComponentType[] = [
  t('area-stone', 'cladding', 'Revestimento de pedra'),
  t('area-brick', 'cladding', 'Revestimento de tijolo', { finish: 'brick', color: '#a8553a', color2: '#d8d2c6', thick: 0.02 }),
  t('area-wood', 'cladding', 'Revestimento de madeira', { finish: 'wood', color: '#8a5f3e', color2: '#2c241d', thick: 0.025 }),
  t('area-tile', 'cladding', 'Revestimento cerâmico', { finish: 'floor', color: '#e9e5dd', color2: '#bdb6aa', thick: 0.012 }),
  t('win-casement', 'window', 'Janela de abrir 2 folhas'),
  t('win-sash', 'window', 'Guilhotina colonial', { operation: 'sash', leaves: 1, muntins: 'colonial', width: 1.0, height: 1.7, shutters: 'louvered', frameColor: '#ffffff' }),
  t('win-sliding', 'window', 'Janela de correr', { operation: 'sliding', leaves: 2, width: 1.6, height: 1.2, frameColor: '#cfd2d3', frameFinish: 'metal', trim: 0, sill: true }),
  t('win-arched', 'window', 'Janela em arco', { shape: 'arch', width: 1.1, height: 2.0, leaves: 2, muntins: 'grid', muntinRows: 3, transom: false }),
  t('win-segment', 'window', 'Janela de arco abatido', { shape: 'segment', width: 1.2, height: 1.6, leaves: 2, trim: 0.14 }),
  t('win-oculus', 'window', 'Óculo', { shape: 'round', width: 0.8, height: 0.8, leaves: 1, operation: 'fixed', sillH: 1.4, sill: false, trim: 0.12 }),
  t('win-ribbon', 'window', 'Janela em fita', { width: 4.2, height: 1.1, leaves: 4, operation: 'fixed', frameColor: '#3a3f42', frameFinish: 'metal', trim: 0, sill: false, sillH: 1.0 }),
  t('win-industrial', 'window', 'Janela industrial', { width: 2.4, height: 1.8, leaves: 1, operation: 'fixed', muntins: 'grid', muntinCols: 6, muntinRows: 4, frameColor: '#2d3236', frameFinish: 'metal', trim: 0, sillH: 1.6 }),
  t('win-louvre', 'window', 'Veneziana de madeira', { operation: 'louvre', leaves: 2, width: 1.1, height: 1.4, frameColor: '#7a4a2c', frameFinish: 'wood', shutterColor: '#7a4a2c' }),
  t('win-basculante', 'window', 'Basculante', { operation: 'awning', width: 0.8, height: 0.6, leaves: 1, sillH: 1.6, trim: 0 }),
  t('win-tall', 'window', 'Janela alta de piso a teto', { width: 1.4, height: 2.4, sillH: 0.1, leaves: 2, operation: 'sliding', frameColor: '#2f3437', frameFinish: 'metal', trim: 0, sill: false }),
  t('win-bay', 'baywindow', 'Janela saliente'),
  t('door-panel', 'door', 'Porta almofadada'),
  t('door-double', 'door', 'Porta dupla com bandeira', { leaves: 2, width: 1.6, leaf: 'half', transom: true }),
  t('door-french', 'door', 'Porta-balcão', { leaves: 2, width: 1.4, height: 2.3, leaf: 'french', leafColor: '#f4f2ec', leafFinish: 'paint', step: false }),
  t('door-glass', 'door', 'Porta de vidro', { leaf: 'glass', width: 1.0, leafColor: '#2c3134', leafFinish: 'metal', frameColor: '#2c3134', frameFinish: 'metal', trim: 0 }),
  t('door-plank', 'door', 'Porta de tábuas', { leaf: 'plank', leafColor: '#7b5634' }),
  t('door-arched', 'door', 'Porta em arco', { shape: 'arch', leaves: 2, width: 1.5, height: 2.6, leaf: 'panel' }),
  t('door-entrance', 'door', 'Entrada com vidros laterais', { sidelights: true, transom: true, leaf: 'half' }),
  t('garage-sectional', 'garage', 'Garagem seccionada'),
  t('garage-roller', 'garage', 'Garagem de enrolar', { kind: 'roller' }),
  t('garage-carriage', 'garage', 'Garagem de madeira', { kind: 'carriage', doorColor: '#6e4c32', windows: true }),
  t('loading-dock', 'loading', 'Porta de doca'),
  t('shopfront', 'shopfront', 'Vitrine com toldo'),
  t('shopfront-plain', 'shopfront', 'Vitrine simples', { awning: false, bays: 4 }),
  t('balcony-bars', 'balcony', 'Sacada com grade'),
  t('balcony-glass', 'balcony', 'Sacada de vidro', { infill: 'glass' }),
  t('balcony-balusters', 'balcony', 'Sacada com balaústres', { infill: 'balusters', support: 'corbels' }),
  t('balcony-solid', 'balcony', 'Sacada com mureta', { guard: 'solid' }),
  t('juliette', 'juliette', 'Guarda-corpo de janela'),
  t('veranda', 'veranda', 'Varanda coberta'),
  t('railing-bars', 'railing', 'Guarda-corpo de barras'),
  t('railing-glass', 'railing', 'Guarda-corpo de vidro', { infill: 'glass' }),
  t('railing-balusters', 'railing', 'Balaustrada', { infill: 'balusters' }),
  t('wall-run', 'wallrun', 'Muro de alvenaria'),
  t('fence-picket', 'fence', 'Cerca de estacas'),
  t('fence-slats', 'fence', 'Cerca de ripas', { style: 'slats' }),
  t('fence-mesh', 'fence', 'Alambrado', { style: 'mesh' }),
  t('fence-wrought', 'fence', 'Gradil de ferro', { style: 'wrought' }),
  t('gate-double', 'gate', 'Portão de duas folhas'),
  t('gate-sliding', 'gate', 'Portão de correr', { operation: 'sliding' }),
  t('hedge', 'hedge', 'Cerca viva'),
  t('column-square', 'column', 'Pilar quadrado'),
  t('column-round', 'column', 'Pilar roliço', { kind: 'round' }),
  t('column-classical', 'column', 'Coluna clássica', { kind: 'classical' }),
  t('column-steel', 'column', 'Pilar de aço', { kind: 'ibeam' }),
  t('beam', 'beam', 'Viga'),
  t('pergola', 'pergola', 'Pérgola'),
  t('portico', 'portico', 'Pórtico com frontão'),
  t('stair-straight', 'stair', 'Escada reta'),
  t('stair-L', 'stair', 'Escada em L', { shape: 'L' }),
  t('stair-U', 'stair', 'Escada em U', { shape: 'U' }),
  t('stair-spiral', 'stair', 'Escada caracol', { shape: 'spiral', structure: 'center', treadColor: '#4a4f52', treadFinish: 'metal' }),
  t('stair-steel', 'stair', 'Escada metálica', { structure: 'stringers', treadColor: '#5b6064', treadFinish: 'metal', structColor: '#3a3e41' }),
  t('ramp', 'ramp', 'Rampa acessível'),
  t('canopy-concrete', 'canopy', 'Marquise de concreto'),
  t('canopy-glass', 'canopy', 'Marquise de vidro', { kind: 'glass', thick: 0.04, rods: true }),
  t('canopy-metal', 'canopy', 'Marquise metálica', { kind: 'metal', color: '#3b3f43', tilt: 8 }),
  t('awning-green', 'awning', 'Toldo listrado verde'),
  t('awning-red', 'awning', 'Toldo listrado vermelho', { color: '#a8332c' }),
  t('awning-plain', 'awning', 'Toldo liso', { striped: false, color: '#c9a66b', scallop: false }),
  t('porch', 'porchroof', 'Alpendre'),
  t('brise-h', 'brise', 'Brise horizontal'),
  t('brise-v', 'brise', 'Brise vertical', { dir: 'v', angle: 25, color: '#a87b54', finish: 'wood' }),
  t('cobogo', 'cobogo', 'Cobogó'),
  t('cobogo-round', 'cobogo', 'Cobogó redondo', { pattern: 'round' }),
  t('rollshutter', 'rollshutter', 'Persiana de enrolar'),
  t('cornice-classic', 'cornice', 'Cornija clássica'),
  t('cornice-modern', 'cornice', 'Cornija moderna', { profile: 'modern' }),
  t('cornice-dentil', 'cornice', 'Cornija com dentículos', { dentils: true }),
  t('pilaster', 'pilaster', 'Pilastra'),
  t('pilaster-fluted', 'pilaster', 'Pilastra canelada', { fluted: true }),
  t('quoins', 'quoins', 'Cunhais de pedra'),
  t('pediment-tri', 'pediment', 'Frontão triangular'),
  t('pediment-seg', 'pediment', 'Frontão em arco', { shape: 'segment' }),
  t('band', 'band', 'Faixa entre pisos'),
  t('sign-panel', 'sign', 'Letreiro'),
  t('sign-blade', 'sign', 'Letreiro bandeira', { kind: 'blade', width: 1, height: 0.8 }),
  t('sign-letters', 'sign', 'Letras soltas', { kind: 'letters' }),
  t('clock', 'clock', 'Relógio'),
  t('downpipe', 'downpipe', 'Condutor de água'),
  t('chimney', 'chimney', 'Chaminé de tijolo'),
  t('skylight', 'skylight', 'Claraboia'),
  t('skylight-dome', 'skylight', 'Claraboia domo', { kind: 'dome' }),
  t('solar', 'solar', 'Placas solares'),
  t('watertank', 'watertank', "Caixa-d'água"),
  t('watertank-box', 'watertank', "Caixa-d'água retangular", { shape: 'box', color: '#d9d9d4', stand: 0 }),
  t('vent-turbine', 'vent', 'Exaustor eólico'),
  t('vent-ac', 'vent', 'Condensadora de ar', { kind: 'ac', width: 0.8 }),
  t('cupola-dome', 'cupola', 'Lanternim com cúpula'),
  t('cupola-spire', 'cupola', 'Torre com agulha', { top: 'spire', flag: true, color: '#e8dcc4', roofColor: '#4a4f55' }),
  t('cupola-onion', 'cupola', 'Cúpula bulbo', { top: 'onion', roofColor: '#c8a85a' }),
  t('dormer-gable', 'dormer', 'Lucarna duas águas'),
  t('dormer-shed', 'dormer', 'Lucarna uma água', { roof: 'shed' }),
  t('dormer-round', 'dormer', 'Lucarna arredondada', { roof: 'round' }),
  t('silo', 'silo', 'Silo'),
  t('stack', 'stack', 'Chaminé industrial'),
  t('ladder', 'ladder', 'Escada marinheiro'),
  t('tank', 'tank', 'Tanque horizontal'),
];

const builtinById = new Map(BUILTIN_TYPES.map((x) => [x.id, x]));

/** Tipo pelo ID: do projeto primeiro, depois os incluídos. */
export function typeById(id: ID, project?: Pick<Project3, 'types'>): ComponentType | undefined {
  return project?.types.find((x) => x.id === id) ?? builtinById.get(id);
}
