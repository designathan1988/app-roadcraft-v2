// Recursos compartilhados entre edifícios (materiais e geometria da caixa).
// Quem cria o contexto é dono dele e deve chamar dispose() ao final.
import * as THREE from 'three';
import type { MaterialKey } from '../geometry/parts';
import { createTextureCache } from './textures';
import { createModuleLibrary, type ModuleLibrary } from './modules';

export interface RenderContext {
  material(key: MaterialKey): THREE.MeshStandardMaterial;
  readonly boxGeometry: THREE.BoxGeometry;
  /** Módulos glTF dos estilos (carregados uma vez por URL). */
  readonly modules: ModuleLibrary;
  /** Indica se o recurso pertence ao contexto (não deve ser liberado pelo edifício). */
  owns(resource: THREE.Material | THREE.BufferGeometry): boolean;
  dispose(): void;
}

export function createRenderContext(): RenderContext {
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  const owned = new Set<THREE.Material | THREE.BufferGeometry>([boxGeometry]);
  const textures = createTextureCache();
  const modules = createModuleLibrary();
  return {
    boxGeometry,
    modules,
    material(key) {
      const id = `${key.role}|${key.color}|${key.roughness}|${key.metalness ?? 0}|${key.doubleSide ? 2 : 1}|${key.texture ?? ''}|${key.textureScale ?? 1}`;
      let m = materials.get(id);
      if (!m) {
        m = new THREE.MeshStandardMaterial({
          color: key.color,
          roughness: key.roughness,
          metalness: key.metalness ?? 0,
          side: key.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
        });
        m.name = key.role;
        if (key.texture) m.map = textures.get(key.texture, key.textureScale ?? 1);
        materials.set(id, m);
        owned.add(m);
      }
      return m;
    },
    owns: (r) => owned.has(r),
    dispose() {
      for (const r of owned) r.dispose();
      owned.clear();
      materials.clear();
      textures.dispose();
      modules.dispose();
    },
  };
}
