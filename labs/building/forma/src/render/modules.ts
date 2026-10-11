// Biblioteca de módulos glTF dos estilos: carrega cada URL uma vez, guarda
// as malhas já normalizadas (caixa unitária centrada) e avisa quando chega.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export interface ModuleMesh {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  /** Transformação da malha dentro da caixa unitária [-0,5..0,5]³. */
  matrix: THREE.Matrix4;
}

export interface ModuleLibrary {
  /** Malhas do módulo, ou null enquanto carrega (ou se falhou). */
  get(url: string): ModuleMesh[] | null;
  failed(url: string): boolean;
  onReady(cb: (url: string) => void): () => void;
  dispose(): void;
}

export function createModuleLibrary(): ModuleLibrary {
  const loaded = new Map<string, ModuleMesh[]>();
  const pending = new Set<string>();
  const bad = new Set<string>();
  const listeners = new Set<(url: string) => void>();
  let loader: GLTFLoader | null = null;
  const start = (url: string) => {
    pending.add(url);
    loader ??= new GLTFLoader();
    loader
      .loadAsync(url)
      .then((gltf) => {
        const root = gltf.scene;
        root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3()),
          center = box.getCenter(new THREE.Vector3());
        const fit = new THREE.Matrix4()
          .makeScale(1 / Math.max(size.x, 1e-6), 1 / Math.max(size.y, 1e-6), 1 / Math.max(size.z, 1e-6))
          .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
        const meshes: ModuleMesh[] = [];
        root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) meshes.push({ geometry: m.geometry, material: m.material, matrix: fit.clone().multiply(m.matrixWorld) });
        });
        loaded.set(url, meshes);
      })
      .catch(() => bad.add(url))
      .finally(() => {
        pending.delete(url);
        for (const cb of listeners) cb(url);
      });
  };
  return {
    get(url) {
      const m = loaded.get(url);
      if (m) return m;
      if (!pending.has(url) && !bad.has(url)) start(url);
      return null;
    },
    failed: (url) => bad.has(url),
    onReady(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      for (const list of loaded.values())
        for (const m of list) {
          m.geometry.dispose();
          for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
            for (const v of Object.values(mat)) if ((v as THREE.Texture)?.isTexture) (v as THREE.Texture).dispose();
            mat.dispose();
          }
        }
      loaded.clear();
      listeners.clear();
    },
  };
}
