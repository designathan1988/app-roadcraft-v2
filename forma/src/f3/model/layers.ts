// Camadas e visibilidade (como as Tags do SketchUp, as camadas do Rhino e a
// Visibilidade/Gráficos do Revit). Escondido e travado só valem na vista:
// salvar e exportar levam tudo. Recorte escondido continua recortando (como o
// objeto de corte escondido do Boolean do Blender). Sem three.
import type { Building3, ID, Item, Layer, Project3, Solid, ViewState } from './schema';
import { uid } from './defaults';

/** Camada de quem não tem camada (o "Untagged" do SketchUp). */
export const DEFAULT_LAYER: Layer = { id: 'padrao', name: 'Padrão', color: '#9aa3ad', visible: true, locked: false };

export const LAYER_COLORS = ['#e07a3f', '#3f8fe0', '#4fae6a', '#b05cc8', '#d6b440', '#d0566b', '#3fb8b0', '#7d6cd8'];

export function layersOf(p: Project3): Layer[] {
  const list = p.layers ?? [];
  return list.some((l) => l.id === DEFAULT_LAYER.id) ? list : [{ ...DEFAULT_LAYER }, ...list];
}

/** Garante a lista no projeto (com a camada padrão) e a devolve para edição. */
export function ensureLayers(p: Project3): Layer[] {
  if (!p.layers || !p.layers.some((l) => l.id === DEFAULT_LAYER.id)) p.layers = [{ ...DEFAULT_LAYER }, ...(p.layers ?? [])];
  return p.layers;
}

export function viewOf(p: Project3): ViewState {
  return (p.view ??= { hiddenCategories: [] });
}

export function layerById(p: Project3, id: ID | undefined): Layer {
  return layersOf(p).find((l) => l.id === (id ?? DEFAULT_LAYER.id)) ?? layersOf(p)[0]!;
}

export function addLayer(p: Project3, name?: string): Layer {
  const list = ensureLayers(p);
  const l: Layer = { id: uid(), name: name ?? `Camada ${list.length}`, color: LAYER_COLORS[(list.length - 1) % LAYER_COLORS.length]!, visible: true, locked: false };
  list.push(l);
  return l;
}

/** Apaga a camada; o que estava nela volta para a padrão. */
export function removeLayer(p: Project3, id: ID): boolean {
  if (id === DEFAULT_LAYER.id) return false;
  const list = ensureLayers(p);
  const i = list.findIndex((l) => l.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  for (const b of p.buildings) {
    if (b.layer === id) delete b.layer;
    for (const s of b.solids) if (s.layer === id) delete s.layer;
    for (const it of b.items) if (it.layer === id) delete it.layer;
  }
  const v = viewOf(p);
  if (v.activeLayer === id) delete v.activeLayer;
  return true;
}

/** Camada que recebe o que for criado (undefined = padrão). */
export function activeLayer(p: Project3): ID | undefined {
  const id = p.view?.activeLayer;
  return id && id !== DEFAULT_LAYER.id && layersOf(p).some((l) => l.id === id) ? id : undefined;
}

export const buildingHidden = (p: Project3, b: Building3) => !!b.hidden || !layerById(p, b.layer).visible;
export const buildingLocked = (p: Project3, b: Building3) => !!b.locked || layerById(p, b.layer).locked;
export const solidHidden = (p: Project3, s: Solid) => !!s.hidden || !layerById(p, s.layer).visible;
export const solidLocked = (p: Project3, s: Solid) => !!s.locked || layerById(p, s.layer).locked;
export const itemHidden = (p: Project3, it: Item) => !!it.hidden || !layerById(p, it.layer).visible;
export const itemLocked = (p: Project3, it: Item) => !!it.locked || layerById(p, it.layer).locked;

export function categoryHidden(p: Project3, category: string): boolean {
  return !!p.view?.hiddenCategories.includes(category);
}

/** Chave do que muda a avaliação (camadas visíveis) e do que muda só as peças (categorias). */
export function visibilityKeys(p: Project3): { solids: string; parts: string } {
  const layers = layersOf(p)
    .map((l) => `${l.id}:${l.visible ? 1 : 0}`)
    .join(',');
  return { solids: layers, parts: `${layers}|${(p.view?.hiddenCategories ?? []).join(',')}` };
}
