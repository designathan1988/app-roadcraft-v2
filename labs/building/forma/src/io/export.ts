// Exportações: JSON (forma/2), GLB (mantém InstancedMesh com
// EXT_mesh_gpu_instancing), OBJ (expande as instâncias) e nomes de arquivo.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import type { Project } from '../core/schema';

export function filename(project: Project, ext: string): string {
  return (
    (project.name || 'forma')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .toLowerCase() +
    '.' +
    ext
  );
}

export const exportJSON = (project: Project): string => JSON.stringify(project, null, 2);

/** Copia o modelo para uma cena própria; opcionalmente expande as instâncias. */
export function exportScene(modelRoot: THREE.Object3D, expandInstances: boolean): THREE.Scene {
  const s = new THREE.Scene();
  const r = modelRoot.clone(true);
  s.add(r);
  if (expandInstances) {
    const instances: THREE.InstancedMesh[] = [];
    r.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) instances.push(o as THREE.InstancedMesh);
    });
    for (const o of instances) {
      const g = new THREE.Group();
      g.name = o.name;
      g.position.copy(o.position);
      g.quaternion.copy(o.quaternion);
      g.scale.copy(o.scale);
      const matrix = new THREE.Matrix4();
      for (let i = 0; i < o.count; i++) {
        const m = new THREE.Mesh(o.geometry, o.material);
        o.getMatrixAt(i, matrix);
        matrix.decompose(m.position, m.quaternion, m.scale);
        g.add(m);
      }
      o.parent!.add(g);
      o.parent!.remove(o);
    }
  }
  s.updateMatrixWorld(true);
  return s;
}

export async function exportGLB(modelRoot: THREE.Object3D, opts: { expandInstances?: boolean } = {}): Promise<ArrayBuffer> {
  const scene = exportScene(modelRoot, !!opts.expandInstances);
  const data = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: true });
  return data as ArrayBuffer;
}

export function exportOBJ(modelRoot: THREE.Object3D): string {
  const es = exportScene(modelRoot, true);
  const lines = ['# FORMA — geometria em metros'];
  let offset = 1;
  const v = new THREE.Vector3();
  es.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const p = mesh.geometry.attributes.position!,
      index = mesh.geometry.index;
    lines.push('o ' + (mesh.parent?.name || 'volume').replace(/\s+/g, '_'));
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
      lines.push(`v ${v.x.toFixed(5)} ${v.y.toFixed(5)} ${v.z.toFixed(5)}`);
    }
    const count = index ? index.count : p.count;
    for (let i = 0; i < count; i += 3) lines.push('f ' + [0, 1, 2].map((j) => offset + (index ? index.getX(i + j) : i + j)).join(' '));
    offset += p.count;
  });
  return lines.join('\n');
}

export function download(data: BlobPart | Blob, name: string, type: string, doc: Document = document): void {
  const blob = data instanceof Blob ? data : new Blob([data], { type }),
    url = URL.createObjectURL(blob),
    a = doc.createElement('a');
  a.href = url;
  a.download = name;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
