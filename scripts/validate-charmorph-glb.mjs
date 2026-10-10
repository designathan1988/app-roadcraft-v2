/** Check that a GLB can be parsed by the same Three.js loader used by Roadcraft. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/validate-charmorph-glb.mjs <file.glb>');

const bytes = readFileSync(file);
const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const gltf = await new GLTFLoader().parseAsync(data, '');
let meshes = 0;
let vertices = 0;
gltf.scene.traverse((object) => {
  if (!object.isMesh) return;
  meshes += 1;
  vertices += object.geometry.getAttribute('position')?.count ?? 0;
});
assert.ok(meshes > 0 && vertices > 0, 'GLB loaded without a usable mesh');
console.log(JSON.stringify({ file, bytes: bytes.length, meshes, vertices }));
