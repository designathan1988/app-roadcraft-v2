// Exportação 3D do FORMA 3 (GLB e OBJ) e o JSON do jogo. A cena exportada é
// montada do zero a partir do documento, em detalhe completo (sem LOD e sem
// corte de pavimento), com a posição e a rotação de cada edifício.
//  - GLB: as peças repetidas ficam como InstancedMesh (extensão
//    EXT_mesh_gpu_instancing, marcada como obrigatória pelo GLTFExporter);
//    `expandInstances` funde as instâncias em malhas comuns para programas que
//    não leem a extensão.
//  - OBJ: o OBJExporter só lê a geometria base de uma InstancedMesh, então as
//    instâncias são sempre fundidas; malhas com vários materiais são separadas
//    por material (um `o`/`usemtl` cada).
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import type { Project3 } from '../model/schema';
import { evaluateBuilding } from '../eval/evaluate';
import { kernelReady, loadKernel } from '../kernel/kernel';
import { buildShellMesh, type ShellMesh } from '../render/shell';
import { buildPartsMesh, type PartsMesh } from '../render/parts';
import { createRenderContext, type RenderContext } from '../../render/context';

export { exportGameJSON, gameData } from './game';

export interface ExportOptions {
  /** Contexto de materiais; sem ele, um temporário é criado e liberado no fim. */
  ctx?: RenderContext;
  /** Funde as instâncias em malhas comuns (padrão: false; o OBJ sempre funde). */
  expandInstances?: boolean;
  /** URL do .wasm do núcleo, se ainda não foi carregado. */
  wasmUrl?: string;
  /** Limite das texturas no GLB (px). */
  maxTextureSize?: number;
}

export interface ExportScene {
  scene: THREE.Scene;
  /** Avisos da avaliação (por edifício). */
  warnings: string[];
  dispose(): void;
}

/** Funde as cópias de uma InstancedMesh numa malha (geometria própria). */
export function mergeInstances(im: THREE.InstancedMesh): THREE.Mesh {
  const src = im.geometry;
  const pos = src.getAttribute('position') as THREE.BufferAttribute;
  const nor = src.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const uv = src.getAttribute('uv') as THREE.BufferAttribute | undefined;
  const index = src.getIndex();
  const nv = pos.count,
    n = im.count;
  const P = new Float32Array(nv * n * 3);
  const N = nor ? new Float32Array(nv * n * 3) : null;
  const U = uv ? new Float32Array(nv * n * 2) : null;
  const ni = index ? index.count : 0;
  const I = index ? new Uint32Array(ni * n) : null;
  const m = new THREE.Matrix4(),
    nm = new THREE.Matrix3(),
    v = new THREE.Vector3();
  for (let k = 0; k < n; k++) {
    im.getMatrixAt(k, m);
    nm.getNormalMatrix(m);
    for (let i = 0; i < nv; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      v.toArray(P, (k * nv + i) * 3);
      if (N && nor) {
        v.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
        v.toArray(N, (k * nv + i) * 3);
      }
      if (U && uv) {
        U[(k * nv + i) * 2] = uv.getX(i);
        U[(k * nv + i) * 2 + 1] = uv.getY(i);
      }
    }
    if (I && index) for (let j = 0; j < ni; j++) I[k * ni + j] = index.getX(j) + k * nv;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  if (N) g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  if (U) g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  if (I) g.setIndex(new THREE.BufferAttribute(I, 1));
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, im.material);
  mesh.name = im.name;
  mesh.position.copy(im.position);
  mesh.quaternion.copy(im.quaternion);
  mesh.scale.copy(im.scale);
  return mesh;
}

/** Separa uma malha de vários materiais (geometria sem índice, com grupos) em uma malha por grupo. */
export function splitByMaterial(mesh: THREE.Mesh): THREE.Mesh[] {
  const mats = mesh.material;
  if (!Array.isArray(mats)) return [mesh];
  const g = mesh.geometry;
  const out: THREE.Mesh[] = [];
  for (const grp of g.groups) {
    const sub = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(g.attributes) as [string, THREE.BufferAttribute][]) {
      if (g.index) continue;
      const s = attr.itemSize;
      sub.setAttribute(name, new THREE.BufferAttribute((attr.array as Float32Array).slice(grp.start * s, (grp.start + grp.count) * s), s));
    }
    if (g.index) {
      // Não acontece com a casca (sem índice); mantém a malha inteira.
      sub.dispose();
      return [mesh];
    }
    const material = mats[grp.materialIndex ?? 0]!;
    const m = new THREE.Mesh(sub, material);
    m.name = `${mesh.name}/${material.name || 'material'}`;
    m.userData = { ...mesh.userData };
    out.push(m);
  }
  return out;
}

/** Monta a cena de exportação: um grupo por edifício, uma malha por sólido e os componentes. */
export async function buildExportScene(project: Project3, opts: ExportOptions = {}): Promise<ExportScene> {
  if (!kernelReady()) await loadKernel(opts.wasmUrl);
  const ownCtx = !opts.ctx;
  const ctx = opts.ctx ?? createRenderContext();
  const shells: ShellMesh[] = [];
  const parts: PartsMesh[] = [];
  const created: THREE.BufferGeometry[] = [];
  const warnings: string[] = [];
  const scene = new THREE.Scene();
  scene.name = project.name;
  for (const b of project.buildings) {
    const ev = evaluateBuilding(b, { hidden: () => false }, project);
    for (const w of ev.warnings) warnings.push(`${b.name}: ${w}`);
    const group = new THREE.Group();
    group.name = b.name;
    group.userData = { buildingId: b.id, use: b.use };
    group.position.set(b.position[0], 0, b.position[1]);
    group.rotation.y = (b.rotation * Math.PI) / 180;
    const ids = new Set(b.solids.map((s) => s.id));
    const pieces: { name: string; solidId?: string; test: (id: string) => boolean }[] = [
      ...b.solids.map((s) => ({ name: `${b.name}/${s.name}`, solidId: s.id, test: (id: string) => id === s.id })),
      // Faces sem sólido conhecido (vãos de componentes soltos).
      { name: `${b.name}/vãos`, test: (id: string) => !ids.has(id) },
    ];
    for (const pc of pieces) {
      const sm = buildShellMesh(b, ev, ctx, pc.test);
      if (!sm.faceOf.length) {
        sm.dispose();
        continue;
      }
      shells.push(sm);
      sm.mesh.name = pc.name;
      sm.mesh.userData = pc.solidId ? { buildingId: b.id, solidId: pc.solidId } : { buildingId: b.id };
      group.add(sm.mesh);
    }
    if (ev.parts.inst.length || ev.parts.meshes.length) {
      const pm = buildPartsMesh(ev.parts, ctx, false);
      parts.push(pm);
      pm.group.name = `${b.name}/componentes`;
      const children = [...pm.group.children] as THREE.Mesh[];
      for (const c of children) {
        const mat = c.material as THREE.Material;
        c.name = `${b.name}/componentes/${mat.name || 'material'}`;
        // As etiquetas de seleção não vão para o arquivo (extras enormes no glTF).
        c.userData = { buildingId: b.id };
        if (opts.expandInstances && (c as THREE.InstancedMesh).isInstancedMesh) {
          const merged = mergeInstances(c as THREE.InstancedMesh);
          created.push(merged.geometry);
          merged.userData = { buildingId: b.id };
          pm.group.add(merged);
          pm.group.remove(c);
          (c as THREE.InstancedMesh).dispose();
        }
      }
      group.add(pm.group);
    }
    scene.add(group);
  }
  scene.updateMatrixWorld(true);
  return {
    scene,
    warnings,
    dispose() {
      for (const s of shells) s.dispose();
      for (const p of parts) p.dispose();
      for (const g of created) g.dispose();
      scene.clear();
      if (ownCtx) ctx.dispose();
    },
  };
}

/** GLB binário do projeto inteiro. */
export async function exportGLB(project: Project3, opts: ExportOptions = {}): Promise<ArrayBuffer> {
  const es = await buildExportScene(project, opts);
  try {
    const data = await new GLTFExporter().parseAsync(es.scene, { binary: true, onlyVisible: true, ...(opts.maxTextureSize ? { maxTextureSize: opts.maxTextureSize } : {}) });
    return data as ArrayBuffer;
  } finally {
    es.dispose();
  }
}

/** OBJ do projeto inteiro (coordenadas do mundo, metros). */
export async function exportOBJ(project: Project3, opts: Omit<ExportOptions, 'expandInstances' | 'maxTextureSize'> = {}): Promise<string> {
  const es = await buildExportScene(project, { ...opts, expandInstances: true });
  const split: THREE.BufferGeometry[] = [];
  try {
    const multi: THREE.Mesh[] = [];
    es.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && Array.isArray(m.material)) multi.push(m);
    });
    for (const m of multi) {
      const parts = splitByMaterial(m);
      if (parts.length === 1 && parts[0] === m) continue;
      const parent = m.parent!;
      for (const p of parts) {
        split.push(p.geometry);
        parent.add(p);
      }
      parent.remove(m);
    }
    es.scene.updateMatrixWorld(true);
    return `# FORMA 3 — ${project.name}\n# metros, Y para cima\n` + new OBJExporter().parse(es.scene);
  } finally {
    for (const g of split) g.dispose();
    es.dispose();
  }
}
