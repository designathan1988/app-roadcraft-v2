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
  { id: 'plaster', name: 'Reboco', texture: 'plaster', scale: 2.4, roughness: 0.9 },
  { id: 'paint', name: 'Pintura lisa', texture: 'plaster', scale: 3, roughness: 0.75 },
  { id: 'brick', name: 'Tijolo', texture: 'brick', scale: 1.2, roughness: 0.88 },
  { id: 'stone', name: 'Pedra', texture: 'stone', scale: 1.6, roughness: 0.92 },
  { id: 'concrete', name: 'Concreto', texture: 'concrete', scale: 3, roughness: 0.85 },
  { id: 'wood', name: 'Madeira', texture: 'wood', scale: 1.4, roughness: 0.7 },
  { id: 'metal', name: 'Metal', texture: 'metal', scale: 1.2, roughness: 0.45, metalness: 0.55 },
  { id: 'tile', name: 'Telha cerâmica', texture: 'tile', scale: 1.1, roughness: 0.78 },
  { id: 'slate', name: 'Ardósia', texture: 'tile', scale: 0.8, roughness: 0.6 },
  { id: 'membrane', name: 'Manta', texture: 'concrete', scale: 2.2, roughness: 0.95 },
  { id: 'glass', name: 'Vidro', scale: 1, roughness: 0.15, metalness: 0.35 },
  { id: 'panel', name: 'Painel', texture: 'metal', scale: 2.4, roughness: 0.4, metalness: 0.3 },
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
    ...(doubleSide ? { doubleSide: true } : {}),
  };
}
