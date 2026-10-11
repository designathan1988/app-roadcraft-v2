import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [materialPath, animationPath, wavePath, trafficPath, transitPath, anglePath] = process.argv.slice(2);
if (![materialPath, animationPath, wavePath, trafficPath, transitPath].every(Boolean)) {
  throw new Error('Usage: node scripts/verify-studio-exports.mjs material.glb animation.glb sound.wav traffic.csv transit.csv');
}
async function glb(path) {
  const bytes = await readFile(path);
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF'); assert.equal(bytes.readUInt32LE(4), 2); assert.equal(bytes.readUInt32LE(8), bytes.length);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)).trim());
  assert.ok(json.meshes.length > 0); assert.ok(json.accessors.length > 0);
  for (const accessor of json.accessors) assert.ok(accessor.count > 0);
  return json;
}
const material = await glb(materialPath);
assert.ok(material.materials[0].pbrMetallicRoughness.baseColorTexture);
assert.ok(material.images[0].bufferView >= 0);
console.log('PASS material GLB: mesh, PBR material and embedded texture');
const animation = await glb(animationPath);
assert.ok(animation.animations.length > 0);
assert.ok(animation.animations[0].channels.length >= 11);
assert.ok(animation.animations[0].channels.some(c => c.target.path === 'translation'));
assert.ok(animation.nodes.some(node => node.name === 'leftArm'));
for (const channel of animation.animations[0].channels) assert.ok(animation.nodes[channel.target.node]);
console.log('PASS animation GLB: articulated nodes, rotation channels and body translation');
const wave = await readFile(wavePath);
assert.equal(wave.toString('ascii', 0, 4), 'RIFF'); assert.equal(wave.toString('ascii', 8, 12), 'WAVE');
assert.equal(wave.readUInt16LE(22), 2); assert.equal(wave.readUInt32LE(24), 44100); assert.equal(wave.readUInt16LE(34), 16); assert.equal(wave.readUInt32LE(40), wave.length - 44);
let peakLeft = 0, peakRight = 0, difference = 0;
for (let i = 44; i < wave.length; i += 4) { const left = wave.readInt16LE(i), right = wave.readInt16LE(i + 2); peakLeft = Math.max(peakLeft, Math.abs(left)); peakRight = Math.max(peakRight, Math.abs(right)); difference += Math.abs(left - right); }
assert.ok(peakLeft > 0 && peakRight > 0 && difference > 0);
console.log(`PASS stereo WAV: ${(wave.length - 44) / 176400}s, peaks ${peakLeft}/${peakRight}, distinct channels`);
const traffic = await readFile(trafficPath, 'utf8');
assert.ok(traffic.includes('Concluídas')); assert.ok(traffic.includes('Fluxo livre')); assert.equal(traffic.trim().split('\n').length, 2);
console.log('PASS traffic CSV: header and scenario result');
const transit = await readFile(transitPath, 'utf8');
assert.ok(transit.includes('Frota mínima')); assert.ok(transit.includes('06:00')); assert.ok(transit.trim().split('\n').length > 2);
console.log('PASS transit CSV: actual departure timetable');
if (anglePath) {
  const bytes = await readFile(anglePath), jsonLength = bytes.readUInt32LE(12), json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength).trim());
  const binary = 20 + jsonLength + 8, node = json.nodes.findIndex(n => n.name === 'leftArm');
  const channel = json.animations[0].channels.find(c => c.target.node === node && c.target.path === 'rotation');
  assert.ok(channel); const sampler = json.animations[0].samplers[channel.sampler];
  const input = json.accessors[sampler.input], output = json.accessors[sampler.output];
  assert.equal(input.componentType, 5126); assert.equal(output.componentType, 5126);
  const timeBase = binary + (json.bufferViews[input.bufferView].byteOffset ?? 0) + (input.byteOffset ?? 0);
  const valueBase = binary + (json.bufferViews[output.bufferView].byteOffset ?? 0) + (output.byteOffset ?? 0);
  let middle = -1; for (let i = 0; i < input.count; i++) if (Math.abs(bytes.readFloatLE(timeBase + i * 4) - 1) < 1e-6) middle = i;
  assert.ok(middle >= 0);
  const q = Array.from({ length: 4 }, (_, c) => bytes.readFloatLE(valueBase + middle * 16 + c * 4));
  assert.ok(Math.abs(q[0]) < 1e-5 && Math.abs(q[1]) < 1e-5 && Math.abs(q[2]) < 1e-5 && Math.abs(q[3] - 1) < 1e-5);
  console.log('PASS extreme-angle GLB: -150° to +150° passes through 0° at 1s');
}
