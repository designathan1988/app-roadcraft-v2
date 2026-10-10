// Registro das famílias e dos tipos incluídos. Um tipo é uma família com
// valores nomeados; as ocorrências e as regras de fachada apontam para tipos.
import type { ComponentType, ID, Project3 } from '../model/schema';
import type { Family } from './family';
import { BAY_WINDOW, WINDOW } from './windows';
import { DOOR, GARAGE_DOOR, LOADING_DOOR, SHOPFRONT } from './doors';

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

for (const f of [WINDOW, BAY_WINDOW, DOOR, GARAGE_DOOR, LOADING_DOOR, SHOPFRONT]) registerFamily(f);

const t = (id: string, fam: string, name: string, params: ComponentType['params'] = {}): ComponentType => ({ id, family: fam, name, params });

/** Tipos incluídos (variações prontas de cada família). */
export const BUILTIN_TYPES: ComponentType[] = [
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
];

const builtinById = new Map(BUILTIN_TYPES.map((x) => [x.id, x]));

/** Tipo pelo ID: do projeto primeiro, depois os incluídos. */
export function typeById(id: ID, project?: Pick<Project3, 'types'>): ComponentType | undefined {
  return project?.types.find((x) => x.id === id) ?? builtinById.get(id);
}
