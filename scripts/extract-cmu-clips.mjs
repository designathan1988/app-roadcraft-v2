/**
 * Adds motion captures of the CMU Graphics Lab Motion Capture Database (the
 * BVH conversion, https://github.com/Shriinivas/cmubvh) to the Rocketbox
 * motion libraries the citizens play (src/render/motion/rocketbox*.json), as
 * if captured on the Rocketbox avatar of each sex: getting up off the ground
 * face down and face up, steps back, a crawl - none of which the Rocketbox or
 * the free Quaternius library has.
 *
 *   node scripts/extract-cmu-clips.mjs <folder of .bvh files>
 *
 * As `extract-quaternius-clips.mjs`: each CMU bone's turn from its rest pose
 * (the BVH's zero pose, a T-pose) is put on the Rocketbox bone it matches
 * after that bone has been turned from the Rocketbox A-pose onto the T-pose;
 * the capture is turned to face +Z at the first frame taken and scaled to the
 * Rocketbox avatar's hip height. Only a stretch of each take is kept (the
 * takes start in a calibration T-pose and run on for seconds).
 */
import fs from 'node:fs';
import path from 'node:path';
import { AnimationMixer, Quaternion, Vector3 } from 'three';
import { BVHLoader } from 'three/addons/loaders/BVHLoader.js';

const dir = process.argv[2];
if (!dir) throw new Error('Usage: node scripts/extract-cmu-clips.mjs <folder of .bvh files>');

/**
 * name in the game -> [take, from s, to s, kind]: `static` keeps the
 * pelvis's own path (getting up rises and shifts), `forward` holds it over
 * the origin (the game moves the body: the steps back, the crawl).
 */
const CLIPS = {
  getUpFront: ['140_01', 1.0, 4.6, 'static'],
  getUpBack: ['140_08', 1.2, 5.3, 'static'],
  staggerBack: ['76_11', 0.75, 1.8, 'forward'],
  crawl: ['111_03', 6.0, 10.0, 'forward'],
};
/** Rocketbox bone -> CMU bone. */
const MAP = {
  Bip01_Pelvis: 'Hips', Bip01_Spine: 'LowerBack', Bip01_Spine1: 'Spine', Bip01_Spine2: 'Spine1',
  Bip01_Neck: 'Neck', Bip01_Head: 'Head',
  Bip01_L_Clavicle: 'LeftShoulder', Bip01_L_UpperArm: 'LeftArm', Bip01_L_Forearm: 'LeftForeArm', Bip01_L_Hand: 'LeftHand',
  Bip01_R_Clavicle: 'RightShoulder', Bip01_R_UpperArm: 'RightArm', Bip01_R_Forearm: 'RightForeArm', Bip01_R_Hand: 'RightHand',
  Bip01_L_Thigh: 'LeftUpLeg', Bip01_L_Calf: 'LeftLeg', Bip01_L_Foot: 'LeftFoot', Bip01_L_Toe0: 'LeftToeBase',
  Bip01_R_Thigh: 'RightUpLeg', Bip01_R_Calf: 'RightLeg', Bip01_R_Foot: 'RightFoot', Bip01_R_Toe0: 'RightToeBase',
};
/** The joint each limb bone points at, in both skeletons (for the A-pose to T-pose turn). */
const AIM = {
  Bip01_L_Clavicle: ['Bip01_L_UpperArm', 'LeftArm'], Bip01_R_Clavicle: ['Bip01_R_UpperArm', 'RightArm'],
  Bip01_L_UpperArm: ['Bip01_L_Forearm', 'LeftForeArm'], Bip01_R_UpperArm: ['Bip01_R_Forearm', 'RightForeArm'],
  Bip01_L_Forearm: ['Bip01_L_Hand', 'LeftHand'], Bip01_R_Forearm: ['Bip01_R_Hand', 'RightHand'],
  Bip01_L_Hand: ['Bip01_L_Finger2', 'LeftFingerBase'], Bip01_R_Hand: ['Bip01_R_Finger2', 'RightFingerBase'],
  Bip01_L_Thigh: ['Bip01_L_Calf', 'LeftLeg'], Bip01_R_Thigh: ['Bip01_R_Calf', 'RightLeg'],
  Bip01_L_Calf: ['Bip01_L_Foot', 'LeftFoot'], Bip01_R_Calf: ['Bip01_R_Foot', 'RightFoot'],
  Bip01_L_Foot: ['Bip01_L_Toe0', 'LeftToeBase'], Bip01_R_Foot: ['Bip01_R_Toe0', 'RightToeBase'],
};
const follow = (name) => /_L_Finger/.test(name) ? 'Bip01_L_Hand' : /_R_Finger/.test(name) ? 'Bip01_R_Hand'
  : /_L_Toe/.test(name) ? 'Bip01_L_Toe0' : /_R_Toe/.test(name) ? 'Bip01_R_Toe0'
    : /Clavicle|UpperArm|Forearm|Hand/.test(name) ? (name.includes('_L_') ? 'Bip01_L_Hand' : 'Bip01_R_Hand')
      : name === 'Bip01' ? 'Bip01_Pelvis' : 'Bip01_Head';

const f32 = (values) => Buffer.from(new Float32Array(values).buffer).toString('base64');
const i16 = (values) => Buffer.from(new Int16Array(values.map((v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767))).buffer).toString('base64');
const yawAbout = (angle) => new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle);

/** Facing from the hips: forward is up x (left hip - right hip), turned half round (as the Rocketbox extractor). */
const facingOf = (left, right) => Math.atan2(left.z - right.z, -(left.x - right.x)) + Math.PI;

const takes = new Map();
for (const [, [take]] of Object.entries(CLIPS)) {
  if (takes.has(take)) continue;
  const { skeleton, clip } = new BVHLoader().parse(fs.readFileSync(path.join(dir, `${take}.bvh`), 'utf8'));
  // The rest pose read before any frame is played on the skeleton.
  skeleton.bones[0].updateMatrixWorld(true);
  const rest = new Map(skeleton.bones.map((b) => [b.name, b.getWorldPosition(new Vector3())]));
  takes.set(take, { skeleton, clip, rest });
}

for (const [sex, prefix, walkFile] of [['male', 'Male', 'walkMale.json'], ['female', 'Female', 'walkFemale.json']]) {
  const walk = JSON.parse(fs.readFileSync(path.join('src', 'render', 'motion', walkFile), 'utf8'));
  const target = path.join('src', 'render', 'motion', `rocketbox${prefix}.json`);
  const library = JSON.parse(fs.readFileSync(target, 'utf8'));
  const bones = library.bones;
  const rbBind = bones.map((name) => {
    const b = walk.bind[walk.bones.indexOf(name)];
    return b ? { p: new Vector3(...b.p), q: new Quaternion(...b.q) } : { p: new Vector3(), q: new Quaternion() };
  });
  const rbPelvis = rbBind[bones.indexOf('Bip01_Pelvis')].p.y;
  const index = (name) => bones.indexOf(name);
  for (const [name, [take, from, to, kind]] of Object.entries(CLIPS)) {
    const { skeleton, clip, rest: restWorld } = takes.get(take);
    const root = skeleton.bones[0];
    const byName = (n) => skeleton.bones.find((b) => b.name === n);
    // The rest pose (all rotations zero: a T-pose), facing +Z, in metres.
    const mixer = new AnimationMixer(root);
    const restYaw = facingOf(restWorld.get('LeftUpLeg'), restWorld.get('RightUpLeg'));
    const restTurn = yawAbout(-restYaw);
    const restDir = (a, b) => restWorld.get(b).clone().sub(restWorld.get(a)).applyQuaternion(restTurn).normalize();
    // The Rocketbox bone turned from its A-pose onto the CMU's T-pose.
    const toT = bones.map((boneName, i) => {
      const aim = AIM[boneName];
      if (!aim) return new Quaternion();
      const child = index(aim[0]);
      if (child < 0 || !byName(MAP[boneName]) || !byName(aim[1])) return new Quaternion();
      const fromDir = rbBind[child].p.clone().sub(rbBind[i].p).normalize();
      return new Quaternion().setFromUnitVectors(fromDir, restDir(MAP[boneName], aim[1]));
    });
    mixer.clipAction(clip).play();
    // The hips' height standing: down the leg in the rest pose to the ball of the foot.
    const standing = restWorld.get('Hips').y - Math.min(restWorld.get('LeftToeBase').y, restWorld.get('RightToeBase').y);
    const fps = 30;
    const count = Math.max(2, Math.round((to - from) * fps) + 1);
    const step = (to - from) / (count - 1);
    // Facing +Z at the first frame taken.
    mixer.setTime(from); root.updateMatrixWorld(true);
    const startYaw = facingOf(byName('LeftUpLeg').getWorldPosition(new Vector3()), byName('RightUpLeg').getWorldPosition(new Vector3()));
    const turn = yawAbout(-startYaw);
    const scale = rbPelvis / standing;
    const origin = root.getWorldPosition(new Vector3()).applyQuaternion(turn).multiplyScalar(scale);
    const q = [], pelvis = [], lowest = [], travel = [];
    for (let k = 0; k < count; k++) {
      mixer.setTime(from + k * step);
      root.updateMatrixWorld(true);
      const delta = new Map();
      const world = new Map();
      for (const [rb, cmu] of Object.entries(MAP)) {
        const node = byName(cmu);
        const i = index(rb);
        if (!node || i < 0) continue;
        // The CMU bone's turn from its rest (identity in a BVH), seen facing +Z.
        const now = turn.clone().multiply(node.getWorldQuaternion(new Quaternion())).multiply(restTurn.clone().invert());
        const w = now.multiply(toT[i].clone().multiply(rbBind[i].q));
        world.set(i, w);
        delta.set(rb, w.clone().multiply(rbBind[i].q.clone().invert()));
      }
      bones.forEach((boneName, i) => {
        const w = world.get(i) ?? (delta.get(follow(boneName)) ?? new Quaternion()).clone().multiply(rbBind[i].q);
        q.push(w.x, w.y, w.z, w.w);
      });
      const p = root.getWorldPosition(new Vector3()).applyQuaternion(turn).multiplyScalar(scale).sub(origin);
      travel.push(p.z);
      if (kind === 'forward') pelvis.push(0, p.y + origin.y, 0);
      else pelvis.push(p.x, p.y + origin.y, p.z);
      const feet = ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'].map((n) => byName(n).getWorldPosition(new Vector3()).y * scale);
      lowest.push(Math.min(...feet));
    }
    library.clips[name] = {
      file: `CMU ${take}.bvh ${from}-${to}s`, kind, loop: kind === 'forward' && name === 'crawl', fps, frames: count,
      duration: step * (count - 1), advance: travel[travel.length - 1] - travel[0], turned: 0,
      q: i16(q), pelvis: f32(pelvis), travel: f32(travel.map((v) => v - travel[0])), yaw: f32(new Array(count).fill(0)), lowest: f32(lowest),
    };
    console.log(`${sex} ${name.padEnd(12)} ${count} frames @${fps} ${(to - from).toFixed(2)}s from ${take} travel ${library.clips[name].advance.toFixed(2)} m pelvis y ${pelvis[1].toFixed(2)}..${pelvis[pelvis.length - 2].toFixed(2)}`);
  }
  fs.writeFileSync(target, JSON.stringify(library));
  console.log(`wrote ${target}`);
}
