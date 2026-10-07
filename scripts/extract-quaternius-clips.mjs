/**
 * Adds clips of Quaternius's Universal Animation Library (the free Standard
 * pack, https://quaternius.itch.io/universal-animation-library) to the
 * Rocketbox motion libraries the citizens play (src/render/motion/
 * rocketbox*.json), as if captured on the Rocketbox avatar of each sex:
 * the reactions to a hit that the Rocketbox library has none of.
 *
 *   node scripts/extract-quaternius-clips.mjs <UAL1_Standard.glb>
 *
 * The library's clips are world rotations of the Rocketbox skeleton's bones,
 * transferred to every body as a turn from the Rocketbox avatar's bind pose
 * (`src/render/citizenWalk.ts`). The UAL skeleton is another one (Unreal's
 * names) bound in a T-pose, the Rocketbox avatar in an A-pose: each UAL bone's
 * turn from its own bind is put on the Rocketbox bone it matches AFTER that
 * bone has first been turned from the A-pose onto the T-pose (its direction
 * onto the UAL bone's), so "the arm raised 30 degrees from where it rests"
 * means the same on both. Bones the UAL has none of (fingers, face) follow
 * the nearest bone that has one. Both stand facing +Z, in metres.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AnimationMixer, LoopOnce, Matrix4, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/extract-quaternius-clips.mjs <UAL1_Standard.glb>');

/** name in the game -> the UAL clip */
const CLIPS = { hitChest: 'Hit_Chest', hitHead: 'Hit_Head' };
/** Rocketbox bone -> UAL bone. */
const MAP = {
  Bip01_Pelvis: 'pelvis', Bip01_Spine: 'spine_01', Bip01_Spine1: 'spine_02', Bip01_Spine2: 'spine_03',
  Bip01_Neck: 'neck_01', Bip01_Head: 'Head',
  Bip01_L_Clavicle: 'clavicle_l', Bip01_L_UpperArm: 'upperarm_l', Bip01_L_Forearm: 'lowerarm_l', Bip01_L_Hand: 'hand_l',
  Bip01_R_Clavicle: 'clavicle_r', Bip01_R_UpperArm: 'upperarm_r', Bip01_R_Forearm: 'lowerarm_r', Bip01_R_Hand: 'hand_r',
  Bip01_L_Thigh: 'thigh_l', Bip01_L_Calf: 'calf_l', Bip01_L_Foot: 'foot_l', Bip01_L_Toe0: 'ball_l',
  Bip01_R_Thigh: 'thigh_r', Bip01_R_Calf: 'calf_r', Bip01_R_Foot: 'foot_r', Bip01_R_Toe0: 'ball_r',
};
/** For the A-pose to T-pose turn: the joint each limb bone points at, in both skeletons. */
const AIM = {
  Bip01_L_Clavicle: ['Bip01_L_UpperArm', 'upperarm_l'], Bip01_R_Clavicle: ['Bip01_R_UpperArm', 'upperarm_r'],
  Bip01_L_UpperArm: ['Bip01_L_Forearm', 'lowerarm_l'], Bip01_R_UpperArm: ['Bip01_R_Forearm', 'lowerarm_r'],
  Bip01_L_Forearm: ['Bip01_L_Hand', 'hand_l'], Bip01_R_Forearm: ['Bip01_R_Hand', 'hand_r'],
  Bip01_L_Hand: ['Bip01_L_Finger2', 'middle_01_l'], Bip01_R_Hand: ['Bip01_R_Finger2', 'middle_01_r'],
  Bip01_L_Thigh: ['Bip01_L_Calf', 'calf_l'], Bip01_R_Thigh: ['Bip01_R_Calf', 'calf_r'],
  Bip01_L_Calf: ['Bip01_L_Foot', 'foot_l'], Bip01_R_Calf: ['Bip01_R_Foot', 'foot_r'],
  Bip01_L_Foot: ['Bip01_L_Toe0', 'ball_l'], Bip01_R_Foot: ['Bip01_R_Toe0', 'ball_r'],
};
/** A Rocketbox bone the UAL has none of: the mapped bone it moves with. */
const follow = (name) => /_L_Finger/.test(name) ? 'Bip01_L_Hand' : /_R_Finger/.test(name) ? 'Bip01_R_Hand'
  : /_L_Toe/.test(name) ? 'Bip01_L_Toe0' : /_R_Toe/.test(name) ? 'Bip01_R_Toe0'
    : /Clavicle|UpperArm|Forearm|Hand/.test(name) ? (name.includes('_L_') ? 'Bip01_L_Hand' : 'Bip01_R_Hand')
      : name === 'Bip01' ? 'Bip01_Pelvis' : 'Bip01_Head';

const buffer = fs.readFileSync(file);
const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), '', resolve, reject));
const scene = gltf.scene;
scene.updateMatrixWorld(true);
const skinned = [];
scene.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
const skeleton = skinned[0].skeleton;
// The UAL bind: each bone's world matrix from its inverse bind matrix.
const ualBind = new Map();
skeleton.bones.forEach((bone, i) => {
  const m = new Matrix4().copy(skeleton.boneInverses[i]).invert();
  const p = new Vector3(), q = new Quaternion(), s = new Vector3();
  m.decompose(p, q, s);
  ualBind.set(bone.name, { p, q });
});

const f32 = (values) => Buffer.from(new Float32Array(values).buffer).toString('base64');
const i16 = (values) => Buffer.from(new Int16Array(values.map((v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767))).buffer).toString('base64');

for (const [sex, prefix, walkFile] of [['male', 'Male', 'walkMale.json'], ['female', 'Female', 'walkFemale.json']]) {
  const walk = JSON.parse(fs.readFileSync(path.join('src', 'render', 'motion', walkFile), 'utf8'));
  const target = path.join('src', 'render', 'motion', `rocketbox${prefix}.json`);
  const library = JSON.parse(fs.readFileSync(target, 'utf8'));
  const bones = library.bones;
  const rbBind = bones.map((name) => {
    const b = walk.bind[walk.bones.indexOf(name)];
    return b ? { p: new Vector3(...b.p), q: new Quaternion(...b.q) } : { p: new Vector3(), q: new Quaternion() };
  });
  const index = (name) => bones.indexOf(name);
  // A to T: each limb bone turned from its Rocketbox bind direction onto the UAL's.
  const toT = bones.map((name, i) => {
    const aim = AIM[name];
    if (!aim) return new Quaternion();
    const child = index(aim[0]);
    const ual = ualBind.get(MAP[name]), ualChild = ualBind.get(aim[1]);
    if (child < 0 || !ual || !ualChild) return new Quaternion();
    const from = rbBind[child].p.clone().sub(rbBind[i].p).normalize();
    const to = ualChild.p.clone().sub(ual.p).normalize();
    return new Quaternion().setFromUnitVectors(from, to);
  });
  for (const [name, source] of Object.entries(CLIPS)) {
    const clip = gltf.animations.find((a) => a.name === source);
    if (!clip) throw new Error(`no ${source} in ${file}`);
    const mixer = new AnimationMixer(scene);
    const action = mixer.clipAction(clip);
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    const fps = 30;
    const count = Math.max(2, Math.round(clip.duration * fps) + 1);
    const step = clip.duration / (count - 1);
    const q = [], pelvis = [], lowest = [];
    for (let k = 0; k < count; k++) {
      mixer.setTime(Math.min(k * step, clip.duration - 1e-4));
      scene.updateMatrixWorld(true);
      const world = new Map();
      const delta = new Map();
      for (const [rb, ual] of Object.entries(MAP)) {
        const node = scene.getObjectByName(ual);
        const i = index(rb);
        if (!node || i < 0) continue;
        const now = node.getWorldQuaternion(new Quaternion());
        // The UAL bone's turn from its bind, on the Rocketbox bone stood in the T-pose.
        const turn = now.clone().multiply(ualBind.get(ual).q.clone().invert());
        const w = turn.multiply(toT[i].clone().multiply(rbBind[i].q));
        world.set(i, w);
        delta.set(rb, w.clone().multiply(rbBind[i].q.clone().invert()));
      }
      bones.forEach((boneName, i) => {
        let w = world.get(i);
        if (!w) w = (delta.get(follow(boneName)) ?? new Quaternion()).clone().multiply(rbBind[i].q);
        q.push(w.x, w.y, w.z, w.w);
      });
      const pv = scene.getObjectByName('pelvis').getWorldPosition(new Vector3());
      pelvis.push(pv.x, pv.y, pv.z);
      const feet = ['foot_l', 'foot_r', 'ball_l', 'ball_r'].map((n) => scene.getObjectByName(n).getWorldPosition(new Vector3()).y);
      lowest.push(Math.min(...feet));
    }
    // The pelvis relative to where it starts (x, z), its height kept.
    const x0 = pelvis[0], z0 = pelvis[2];
    for (let k = 0; k < pelvis.length; k += 3) { pelvis[k] -= x0; pelvis[k + 2] -= z0; }
    library.clips[name] = {
      file: `UAL1_Standard.glb / ${source}`, kind: 'static', loop: false, fps, frames: count,
      duration: step * (count - 1), advance: 0, turned: 0,
      q: i16(q), pelvis: f32(pelvis), travel: f32(new Array(count).fill(0)), yaw: f32(new Array(count).fill(0)), lowest: f32(lowest),
    };
    console.log(`${sex} ${name.padEnd(9)} ${count} frames @${fps} ${clip.duration.toFixed(2)}s from ${source}`);
  }
  fs.writeFileSync(target, JSON.stringify(library));
  console.log(`wrote ${target}`);
}
