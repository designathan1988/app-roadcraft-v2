// Acabamentos (materiais de superfície) do forma/3 e a chave de material do
// render. A cor vem do documento; o acabamento dá textura, escala e brilho.
import type { MaterialKey } from '../../geometry/parts';
import type { TextureKind } from '../../styles/schema';
import type { MaterialRef } from '../model/schema';

export interface Finish {
  id: string;
  name: string;
  texture?: TextureKind;
  /** Metros por repetição da textura. */
  scale: number;
  roughness: number;
  metalness?: number;
}

export const FINISHES: Finish[] = [
  // Procedurais (paramétricos, assados na GPU).
  { id: 'plaster', name: 'Reboco', texture: 'plaster', scale: 2, roughness: 0.9 },
  { id: 'paint', name: 'Pintura lisa', texture: 'plaster', scale: 2, roughness: 0.75 },
  { id: 'brick', name: 'Tijolo à vista', texture: 'brick', scale: 1.4, roughness: 0.88 },
  { id: 'stone', name: 'Pedra aparelhada', texture: 'stone', scale: 2.4, roughness: 0.92 },
  { id: 'concrete', name: 'Concreto aparente', texture: 'concrete', scale: 2.4, roughness: 0.85 },
  { id: 'wood', name: 'Madeira (tábuas)', texture: 'wood', scale: 2, roughness: 0.7 },
  { id: 'floor', name: 'Piso cerâmico', texture: 'tile', scale: 2.4, roughness: 0.5 },
  { id: 'paving', name: 'Piso intertravado', texture: 'brick', scale: 1.2, roughness: 0.9 },
  { id: 'tile', name: 'Telha cerâmica', texture: 'tile', scale: 1.6, roughness: 0.78 },
  { id: 'slate', name: 'Ardósia', texture: 'tile', scale: 2, roughness: 0.6 },
  { id: 'metal', name: 'Telha metálica', texture: 'metal', scale: 1.5, roughness: 0.45, metalness: 0.55 },
  { id: 'panel', name: 'Chapa com junta', texture: 'metal', scale: 2, roughness: 0.4, metalness: 0.3 },
  { id: 'membrane', name: 'Manta', texture: 'concrete', scale: 3, roughness: 0.95 },
  { id: 'glass', name: 'Vidro', scale: 1, roughness: 0.15, metalness: 0.35 },
  // Fotografados (PBR).
  { id: 'plaster-photo', name: 'Reboco (foto)', texture: 'plaster', scale: 2, roughness: 0.9 },
  { id: 'brick-photo', name: 'Tijolo (foto)', texture: 'brick', scale: 2.4, roughness: 0.88 },
  { id: 'stone-photo', name: 'Pedra (foto)', texture: 'stone', scale: 2.4, roughness: 0.92 },
  { id: 'concrete-photo', name: 'Concreto (foto)', texture: 'concrete', scale: 2.2, roughness: 0.85 },
  { id: 'wood-photo', name: 'Madeira (foto)', texture: 'wood', scale: 0.8, roughness: 0.7 },
  { id: 'tile-photo', name: 'Telha (foto)', texture: 'tile', scale: 3.2, roughness: 0.78 },
  { id: 'slate-photo', name: 'Ardósia (foto)', texture: 'tile', scale: 2, roughness: 0.6 },
  { id: 'metal-photo', name: 'Metal ondulado (foto)', texture: 'metal', scale: 2, roughness: 0.45, metalness: 0.55 },
];

const byId = new Map(FINISHES.map((f) => [f.id, f]));

export function finishOf(id: string): Finish {
  return byId.get(id) ?? FINISHES[0]!;
}

export type Role = MaterialKey['role'];

export function materialKey(ref: MaterialRef, role: Role, doubleSide = false): MaterialKey {
  const f = finishOf(ref.finish);
  return {
    role,
    color: ref.color,
    roughness: f.roughness,
    ...(f.metalness ? { metalness: f.metalness } : {}),
    ...(f.texture ? { texture: f.texture, textureScale: f.scale } : {}),
    finish: f.id,
    ...(ref.color2 ? { color2: ref.color2 } : {}),
    ...(ref.params && Object.keys(ref.params).length ? { params: JSON.stringify(Object.keys(ref.params).sort().map((k) => [k, ref.params![k]])) } : {}),
    ...(doubleSide ? { doubleSide: true } : {}),
  };
}
