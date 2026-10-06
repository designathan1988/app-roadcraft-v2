import type { BodyPart, Severable } from '@sim/people/view';
import { Matrix4, Quaternion, Vector3 } from 'three';

import type { Casualty } from '@sim/people/people';
import { m } from '@world/units';
import type { BloodDecal } from './casualties';
import type { Exhaust } from './exhaust';
import type { Gore } from './gore';

/**
 * Ragdolls: people knocked over or killed by a blow, or tripping, their own
 * bodies falling.
 *
 * Jakobsen's method, as Hitman's dead bodies were done ("Advanced Character
 * Physics", GDC 2001): the skeleton is a stick figure of particles at the
 * joints - pelvis, chest, neck, head, shoulders, elbows, wrists, hips, knees,
 * ankles, toes - moved by Verlet integration and held together by distance
 * constraints relaxed several times a step: rigid sticks for the bones and a
 * braced torso, ranges for what a joint allows (a knee folds only so far, and
 * only forwards; an elbow only backwards; the head does not fold into the
 * chest). Collisions are projections: a particle below the ground, inside a
 * wall or under a roof is put back on its surface and loses most of its speed
 * into it and some along it (friction). Every bone of the real skeleton is
 * then turned and placed from the particles - each limb's frame derived from
 * its particles with cross products, so knees and elbows bend the way the
 * particles do - and its skin matrix written into the body's palette: the
 * person's own mesh, clothes and hair tumble with arms and legs loose, strike
 * walls and the ground, and come to rest sprawled where they fell.
 *
 * The dead never get up. Right under a blow a body is torn apart: sticks are
 * broken (the head, an arm at the shoulder, a leg at the hip) and each piece
 * flies on its own, spraying blood; a piece is drawn as the whole body with
 * every bone not on it shrunk to the joint it was torn from, so the stump
 * closes. Bodies lie in their blood for a few minutes, then sink away.
 *
 * The living - knocked over by a blast, or tripping on the pavement - lie
 * dazed a moment, then get up the way games bring a ragdoll back to its feet
 * (blend the lying pose into the first frame of a get-up animation, then
 * play it): into a crouch over a short blend, then the crouch-to-stand clip,
 * where the body lies; the simulation is told where (`getUp`), and they run.
 */

export interface RagdollCitizens {
  capturedPose(id: number): { index: number; palette: Float32Array; transform: Matrix4 } | null;
  skeletonOf(index: number): { names: string[]; parents: number[]; inverses: Matrix4[]; local: Matrix4; bind: Matrix4 } | null;
  /** `charred`: burnt black (a bomb's direct hit). */
  drawPalette(index: number, palette: Float32Array, instance: Matrix4, charred?: boolean, alive?: boolean): void;
  clipPose(index: number, key: 'crouchUp' | 'idle', phase: number): { palette: Float32Array; duration: number } | null;
  /** Bodies loaded now, for people with no pose of their own (indoors). */
  loadedIndices(): number[];
  /** The index to draw a piece torn off this person with (their twin, or the same body); null when none can be drawn. */
  twin?(index: number): number | null;
  /** A twin's index given back (its piece gone). */
  untwin?(index: number): void;
  /** Burns the person black (a bomb's direct hit). */
  char?(index: number): void;
  /** A bullet hole in this part of the person, bleeding into their clothes. */
  /** From world (fromX, fromY) when known: the shot's jolt through them too. */
  wound?(index: number, part: BodyPart, fromX?: number, fromY?: number): void;
  /** The person soaked in blood all over (shot to pieces). */
  drench?(index: number): void;
}

/** Somebody inside a building a blow struck: thrown out of it from where they were. */
export interface Occupant {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** Height they stood at (the floor they were on). */
  readonly z: number;
  readonly heading: number;
  readonly blastX: number;
  readonly blastY: number;
  readonly power: number;
  readonly kind: 'dead' | 'torn' | 'knocked';
  /** Burnt black (right under the blow, or in a burning car). */
  readonly charred?: boolean;
  /** The body they were drawn with (a driver, a rider): thrown as themself, not as somebody else. */
  readonly index?: number | null;
}

/** A wall a body can strike: a ring on the ground (world x, y), up to a height. */
export interface RagdollWall {
  readonly ring: readonly { readonly x: number; readonly y: number }[];
  /** The highest it reaches. */
  readonly top: number;
  /** Its top at a point inside it (a roof's pitch); `top` all over when absent. */
  readonly roof?: (x: number, y: number) => number;
}

export interface RagdollWorld {
  /** Height of whatever a body lands on at world (x, y). */
  groundAt(x: number, y: number): number;
  /** The walls near a world point. */
  wallsNear(x: number, y: number, reach: number): RagdollWall[];
}

/** Somebody alive getting up at world (x, y) facing `heading`, taking `seconds` (`PeopleEngine.getUp`). */
export type GetUp = (id: number, x: number, y: number, heading: number, seconds: number) => void;

/** The skeleton's joints the particles sit on ('' for a particle with no bone of its own). */
const JOINTS = [
  'Bip01_Pelvis', 'Bip01_Spine2', 'Bip01_Neck', 'Bip01_Head', '',
  'Bip01_L_UpperArm', 'Bip01_L_Forearm', 'Bip01_L_Hand', 'Bip01_R_UpperArm', 'Bip01_R_Forearm', 'Bip01_R_Hand',
  'Bip01_L_Thigh', 'Bip01_L_Calf', 'Bip01_L_Foot', 'Bip01_L_Toe0', 'Bip01_R_Thigh', 'Bip01_R_Calf', 'Bip01_R_Foot', 'Bip01_R_Toe0',
  '',
] as const;
const PEL = 0, CHE = 1, NEC = 2, HEA = 3, TOP = 4;
const LS = 5, LE = 6, LW = 7, RS = 8, RE = 9, RW = 10;
const LH = 11, LK = 12, LA = 13, LT = 14, RH = 15, RK = 16, RA = 17, RT = 18;
/** In front of the pelvis: braces the torso against folding back and forth. */
const BEL = 19;

type PartName = 'torso' | 'neck' | 'head' | 'lua' | 'lfa' | 'rua' | 'rfa' | 'lth' | 'lca' | 'lfo' | 'rth' | 'rca' | 'rfo';
type Limb = 'larm' | 'rarm' | 'lleg' | 'rleg';
/** Which part each key bone follows; a bone not listed follows its nearest listed ancestor. */
const KEY_PART: Readonly<Record<string, PartName>> = {
  Bip01: 'torso', Bip01_Pelvis: 'torso', Bip01_Spine: 'torso', Bip01_Spine1: 'torso', Bip01_Spine2: 'torso',
  Bip01_L_Clavicle: 'torso', Bip01_R_Clavicle: 'torso', Bip01_Neck: 'neck', Bip01_Head: 'head',
  Bip01_L_UpperArm: 'lua', Bip01_L_Forearm: 'lfa', Bip01_L_Hand: 'lfa', Bip01_R_UpperArm: 'rua', Bip01_R_Forearm: 'rfa', Bip01_R_Hand: 'rfa',
  Bip01_L_Thigh: 'lth', Bip01_L_Calf: 'lca', Bip01_L_Foot: 'lfo', Bip01_L_Toe0: 'lfo',
  Bip01_R_Thigh: 'rth', Bip01_R_Calf: 'rca', Bip01_R_Foot: 'rfo', Bip01_R_Toe0: 'rfo',
};
/** Each part: the particle its frame sits on, the particle its long axis points to, what turns it about that axis. */
const PARTS: Readonly<Record<PartName, { origin: number; to: number; ref: 'side' | Limb }>> = {
  torso: { origin: PEL, to: CHE, ref: 'side' },
  neck: { origin: NEC, to: HEA, ref: 'side' },
  head: { origin: HEA, to: TOP, ref: 'side' },
  lua: { origin: LS, to: LE, ref: 'larm' }, lfa: { origin: LE, to: LW, ref: 'larm' },
  rua: { origin: RS, to: RE, ref: 'rarm' }, rfa: { origin: RE, to: RW, ref: 'rarm' },
  lth: { origin: LH, to: LK, ref: 'lleg' }, lca: { origin: LK, to: LA, ref: 'lleg' }, lfo: { origin: LA, to: LT, ref: 'lleg' },
  rth: { origin: RH, to: RK, ref: 'rleg' }, rca: { origin: RK, to: RA, ref: 'rleg' }, rfo: { origin: RA, to: RT, ref: 'rleg' },
};
/** Parents first (`PART_NAMES` follows this order): each part's parent part, for `bonesWorld`. */
const PART_PARENT: Readonly<Record<PartName, PartName | null>> = {
  torso: null, neck: 'torso', head: 'neck', lua: 'torso', lfa: 'lua', rua: 'torso', rfa: 'rua',
  lth: 'torso', lca: 'lth', lfo: 'lca', rth: 'torso', rca: 'rth', rfo: 'rca',
};
const PART_NAMES = Object.keys(PARTS) as PartName[];
const LIMB_JOINTS: readonly (readonly [Limb, number, number, number])[] = [['larm', LS, LE, LW], ['rarm', RS, RE, RW], ['lleg', LH, LK, LA], ['rleg', RH, RK, RA]];

/** The parts gone with each limb shot off (as the living lose them, `riggedCitizens` maim). */
const LOST_PARTS: Readonly<Record<Severable, readonly PartName[]>> = {
  armL: ['lfa'], armR: ['rfa'], legL: ['lca', 'lfo'], legR: ['rca', 'rfo'], head: ['head'],
};

/** The bones that collide along their length (`capsules`), and where along each the body is tested. */
const CAPSULE_BONES: readonly (readonly [number, number])[] = [
  [PEL, CHE], [CHE, NEC], [NEC, HEA], [HEA, TOP], [LS, LE], [LE, LW], [RS, RE], [RE, RW],
  [LH, LK], [LK, LA], [RH, RK], [RK, RA], [LA, LT], [RA, RT], [LS, RS], [LH, RH],
];
const CAPSULE_SAMPLES: readonly number[] = [0.33, 0.67];

/** What tears off a body right under a blow: the particles that go with it. */
const LIMBS: readonly (readonly number[])[] = [[HEA, TOP], [LS, LE, LW], [RS, RE, RW], [LH, LK, LA, LT], [RH, RK, RA, RT]];

const GRAVITY = m(9.8);
const STEP = 1 / 90;
const ITERATIONS = 10;
/** Speed kept per step in the air. */
const AIR = 0.9995;
/** Seconds a body lies before it starts to sink away, and how long that takes. */
// The dead stay where they fell (the player wants the aftermath kept, GTA-like).
const LIE = Infinity;
const SINK = 12;
/** Seconds of simulation after which a body is put to rest whatever it is doing. */
const SETTLE = 14;
/** The living: most seconds falling before they lie still, and the blend from lying into the get-up clip. */
const FALL_MOST = 4;
const RISE_BLEND = 0.7;
/** The get-up clip's length when it has not loaded yet. */
const RISE_CLIP = 1.6;
/** The clip a body that fell gets up with. */
const RISE_KEY: 'crouchUp' | 'idle' = 'crouchUp';
const MAX_BODIES = 40;

type Fate = 'dead' | 'torn' | 'knocked' | 'trip';

interface Stick { readonly a: number; readonly b: number; readonly min: number; readonly max: number; broken: boolean }

interface Wall extends RagdollWall { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

/** Somebody alive on the ground: falling, lying a moment, then getting up. */
interface Survivor {
  readonly id: number;
  phase: 'fall' | 'lie' | 'rise';
  t: number;
  lie: number;
  /** Dragging themself along by the arms (a leg lost): which way, and the drops left behind. */
  crawl?: { dx: number; dy: number; since: number };
  /** Where and which way they get up, and the lying bones blended from. */
  root?: Matrix4;
  from?: Matrix4[];
  clip: number;
  /** Whether the get-up clip is baked. */
  ready?: boolean;
}

interface Body {
  readonly index: number;
  readonly scale: number;
  readonly p: Vector3[];
  readonly o: Vector3[];
  readonly inv: number[];
  readonly radius: number[];
  readonly ground: number[];
  readonly sticks: Stick[];
  readonly bonePart: PartName[];
  readonly parents: number[];
  readonly pos0: Vector3[];
  readonly rot0: Quaternion[];
  readonly scl0: Vector3[];
  readonly origin0: Record<PartName, Vector3>;
  readonly frame0: Record<PartName, Matrix4>;
  /** Limb bend normals carried from frame to frame, so a straight limb keeps its last bend. */
  readonly normals: Record<Limb, Vector3>;
  /** +1 or -1: which way side x spine points the body's front. */
  readonly front: number;
  readonly inverses: Matrix4[];
  /** Each bone's bind matrix (the inverse of its inverse). */
  readonly binds: Matrix4[];
  /** local * bind^-1 and its inverse: between the drawn instance's space and a bone's matrix. */
  readonly rebind: Matrix4;
  readonly unbind: Matrix4;
  readonly walls: Wall[];
  torn: boolean;
  /** Parts lost before the fall (shot off, `Casualty.lost`): drawn closed at their joint. */
  lostParts: Set<PartName>;
  survivor: Survivor | undefined;
  /**
   * A limb torn off, a body of its own (`detach`): only `keep` simulated and
   * drawn, every other particle held at `root`, where it was torn from.
   */
  pin?: { readonly root: number; readonly keep: ReadonlySet<number> };
  /** Called when the body goes (a twin given back). */
  drop?: (() => void) | undefined;
  /** Burnt black (a bomb's direct hit). */
  charred?: boolean;
  /** Whose body it was (the casualty's id), for probes. */
  recordId?: number;
  /** Shots taken on the ground, all told and by part (`shootBody`). */
  hits?: number;
  partHits?: Partial<Record<BodyPart, number>>;
  /** Shot to a heap of meat (`mush`). */
  mush?: boolean;
  /** Opened at the belly, the guts out (`openBelly`). */
  opened?: boolean;
  /**
   * Seconds left of joint friction (`joints`): a body just struck moves as
   * a body, not a bundle of loose sticks - its limbs' speeds drawn towards
   * their neighbours', no pose forced on it (pose springs fighting the
   * sticks made a shot body writhe like elastic).
   */
  stiff?: number;
  /** Which piece each particle is on: the body itself, or a limb torn off. */
  comp: number[];
  palettes: Float32Array[];
  readonly anchor: Matrix4;
  still: number;
  asleep: boolean;
  age: number;
  flying: number;
  pooled: boolean;
  splats: number;
  spray: number;
}

const tmpA = new Vector3(), tmpB = new Vector3(), tmpC = new Vector3(), tmpD = new Vector3(), tmpE = new Vector3();
const UP = new Vector3(0, 1, 0);

/** A frame with its x along `x` and its z as near `ref` as stays square to x. */
function frameOf(x: Vector3, ref: Vector3, out: Matrix4): Matrix4 {
  const ax = tmpA.copy(x).normalize();
  const az = tmpB.copy(ref).addScaledVector(ax, -ref.dot(ax));
  if (az.lengthSq() < 1e-10) az.set(ax.y, -ax.x, 0.3).addScaledVector(ax, -az.dot(ax));
  az.normalize();
  const ay = tmpC.crossVectors(az, ax);
  return out.makeBasis(ax, ay, az);
}

const smooth = (t: number): number => { const k = Math.min(1, Math.max(0, t)); return k * k * (3 - 2 * k); };

/** One body as the weapons lab measures it (`Ragdolls.probe`). Distances in metres. */
export interface RagdollProbe {
  /** The person's id (alive or dead: the record's), or -1 for a piece torn off. */
  readonly id: number;
  readonly phase: string;
  readonly piece: boolean;
  readonly asleep: boolean;
  readonly charred: boolean;
  /** Particles: world x, y and height (world units). */
  readonly points: readonly (readonly [number, number, number])[];
  /** Deepest a particle sits under the ground it lies on (its radius counted), metres; 0 when none does. */
  readonly underGround: number;
  /** Deepest a particle sits inside a wall, a pole, a car (below its top), metres. */
  readonly inWall: number;
  /** Worst bone off its length, as a share of it (0: all exact). */
  readonly boneError: number;
  /** Fastest particle, metres a second. */
  readonly speed: number;
  /** Parts gone. */
  readonly lost: readonly string[];
  readonly hits: number;
}

export interface Ragdolls {
  /** Takes in the casualties of blows (each once): bodies thrown from the pose they were last drawn in. */
  absorb(list: readonly Casualty[], citizens: RagdollCitizens, world: RagdollWorld): void;
  /** People inside a struck building, thrown out of it - through its walls and windows - from the floor they were on. */
  fling(list: readonly Occupant[], citizens: RagdollCitizens, world: RagdollWorld): void;
  /** A drop of blood on the ground at world (x, y) (a trail behind somebody bleeding). */
  drip(x: number, y: number, z: number, size: number): void;
  /** Called where a body is torn apart (world x, y, height z; the way it flew; how fast): the renderer throws its pieces. */
  onGore: ((x: number, y: number, z: number, dirX: number, dirY: number, speed: number, kind: 'torn' | 'dead') => void) | null;
  /**
   * Somebody falling (a `fall` pause), from the pose they were last drawn in:
   * tripping forwards, or knocked towards `away` (world angle) by a punch or
   * a shove - over their heels when it is behind them.
   */
  trip(id: number, heading: number, citizens: RagdollCitizens, world: RagdollWorld, away?: number | null): void;
  /** Whether somebody's own body is on the ground here, so the crowd does not draw them standing too. */
  hides(id: number): boolean;
  /**
   * A shot along the line of sight from `a` to `b` (three's frame) at the
   * bodies on the ground: the one it strikes holed, bled, pushed, a limb or
   * the head shot off at the second hit there, shot to a heap of meat at the
   * last (the player, 2026-10-06: "se continuar atirando vai causar mais
   * dano ... até virar um monte de carne"). Somebody alive on the ground is
   * the simulation's to hurt: their id and the part struck come back.
   */
  shootBody(a: Vector3, b: Vector3): { alive: number; part: BodyPart } | 'hit' | null;
  /** Lets go of those who are up again once the simulation has them up too (`down` false). */
  release(down: (id: number) => boolean): void;
  update(dt: number, world: RagdollWorld): void;
  draw(citizens: RagdollCitizens, world: RagdollWorld): void;
  /** The blood the bodies left. */
  readonly decals: BloodDecal[];
  /** Bodies drawn, still moving, pieces, and the living among them (for probes). */
  stats(): { bodies: number; moving: number; pieces: number; living: number };
  /** Each body's pelvis, phase and fate (for probes). */
  debug(): { pelvis: number[]; head: number[]; asleep: boolean; phase: string; torn: boolean }[];
  /**
   * Everything about each body for a test bench (the weapons lab,
   * `src/weaponsLab.ts`): its particles (world x, y, height), how far the
   * lowest sits into the ground, how deep any is inside a wall, how far the
   * bones are off their lengths, how fast it moves, what it is doing.
   */
  probe(): RagdollProbe[];
  /** Every body, piece and stain gone (the weapons lab's clean slate). */
  clear(): void;
}

export function createRagdolls(exhaust: Exhaust, getUp: GetUp, gore: Gore | null = null): Ragdolls {
  const bodies: Body[] = [];
  const decals: BloodDecal[] = [];
  /** The casualty records already turned into bodies (`absorb`). */
  const taken = new WeakSet<Casualty>();
  let clock = 0;

  const api: { onGore: Ragdolls['onGore'] } = { onGore: null };
  const bleed = (x: number, y: number, z: number, size: number, spread: number): void => {
    if (decals.length >= 400) decals.shift();
    decals.push({ x, y, z, angle: Math.random() * Math.PI * 2, size, spread, age: 0 });
  };

  /** A body standing as it was last drawn, at rest; null when that pose is not known. */
  const build = (id: number, heading: number, citizens: RagdollCitizens, world: RagdollWorld, x: number, y: number, fate: Fate,
    given?: { index: number; palette: Float32Array; transform: Matrix4 }): Body | null => {
    const pose = given ?? citizens.capturedPose(id);
    const sk = pose ? citizens.skeletonOf(pose.index) : null;
    if (!pose || !sk) return null;
    const bones = sk.names.length;
    // Each bone's world matrix in the pose drawn. The crowd draws a bone as
    // instance * local * bind^-1 * palette, the palette being W * boneInverse.
    const rebind = sk.local.clone().multiply(sk.bind.clone().invert());
    const unbind = rebind.clone().invert();
    const binds = sk.inverses.map((inv) => inv.clone().invert());
    const pos0: Vector3[] = [], rot0: Quaternion[] = [], scl0: Vector3[] = [];
    const g = new Matrix4(), w = new Matrix4();
    for (let i = 0; i < bones; i++) {
      w.fromArray(pose.palette, i * 16).multiply(binds[i]!);
      g.multiplyMatrices(pose.transform, rebind).multiply(w);
      const p = new Vector3(), q = new Quaternion(), s = new Vector3();
      g.decompose(p, q, s);
      pos0.push(p); rot0.push(q); scl0.push(s);
    }
    const at = (name: string): Vector3 | null => { const i = sk.names.indexOf(name); return i >= 0 ? pos0[i]!.clone() : null; };
    const p: Vector3[] = [];
    for (let k = 0; k < BEL; k++) {
      const name = JOINTS[k]!;
      let v = name ? at(name) : null;
      if (k === TOP) v = p[HEA]!.clone().addScaledVector(tmpD.subVectors(p[HEA]!, p[NEC]!), 1.4);
      if (!v && (k === LT || k === RT)) v = p[k - 1]!.clone();
      if (!v) return null;
      p.push(v);
    }
    // The way the body faced: from its feet, or failing that its heading.
    const forward = new Vector3().subVectors(p[LT]!, p[LA]!).add(tmpD.subVectors(p[RT]!, p[RA]!)).setY(0);
    if (forward.lengthSq() < 1e-8) forward.set(Math.cos(heading), 0, -Math.sin(heading));
    forward.normalize();
    const scale = new Vector3().setFromMatrixScale(pose.transform).x;
    p.push(p[PEL]!.clone().addScaledVector(forward, 0.14 * scale));
    // Which part moves each bone: its own key, or the nearest key above it.
    const bonePart: PartName[] = [];
    for (let i = 0; i < bones; i++) {
      let j = i;
      let part: PartName | undefined;
      while (j >= 0 && !(part = KEY_PART[sk.names[j]!])) j = sk.parents[j]!;
      bonePart.push(part ?? 'torso');
    }
    // Sticks: the bones and a braced torso, and the ranges the joints allow.
    const sticks: Stick[] = [];
    const len = (a: number, b: number): number => p[a]!.distanceTo(p[b]!);
    const rigid = (a: number, b: number): void => { const l = len(a, b); sticks.push({ a, b, min: l, max: l, broken: false }); };
    const range = (a: number, b: number, lo: number, hi: number): void => { const l = len(a, b); sticks.push({ a, b, min: l * lo, max: l * hi, broken: false }); };
    /** How close a limb's ends may come as its middle joint folds. */
    const fold = (a: number, mid: number, b: number, lo: number): void => {
      const l = len(a, mid) + len(mid, b);
      sticks.push({ a, b, min: l * lo, max: l, broken: false });
    };
    for (const [a, b] of [
      [PEL, CHE], [PEL, LH], [PEL, RH], [LH, RH], [BEL, PEL], [BEL, LH], [BEL, RH], [BEL, CHE],
      [CHE, LH], [CHE, RH], [CHE, LS], [CHE, RS], [LS, RS], [LS, LH], [RS, RH], [LS, RH], [RS, LH], [BEL, LS], [BEL, RS],
      [CHE, NEC], [NEC, LS], [NEC, RS], [NEC, HEA], [HEA, TOP],
      [LS, LE], [LE, LW], [RS, RE], [RE, RW], [LH, LK], [LK, LA], [LA, LT], [RH, RK], [RK, RA], [RA, RT],
    ] as const) rigid(a, b);
    // The neck bends, the head nods and turns, but neither folds into the chest.
    // Firmer than a free joint: a shot body's head does not flop (Euphoria's shot keeps the neck stiff at first).
    range(HEA, CHE, 0.88, 1.03);
    range(TOP, CHE, 0.82, 1.03);
    range(TOP, BEL, 0.85, 1.1);
    // Not folded past what the clothes follow: tighter than this the skin
    // came through the sleeves and trouser legs at the elbow and the knee.
    fold(LS, LE, LW, 0.42); fold(RS, RE, RW, 0.42);
    fold(LH, LK, LA, 0.5); fold(RH, RK, RA, 0.5);
    // Ankles: the foot keeps near its rest angle to the shin.
    range(LK, LT, 0.86, 1.06); range(RK, RT, 0.86, 1.06);
    // Shoulders and hips: an arm or a leg swings wide, but not through the body.
    range(CHE, LE, 0.5, 1.6); range(CHE, RE, 0.5, 1.6);
    range(BEL, LK, 0.55, 1.45); range(BEL, RK, 0.55, 1.45);
    range(CHE, LK, 0.55, 1.25); range(CHE, RK, 0.55, 1.25);
    // Metres on this body (its drawn scale is world units per model metre).
    const metre = scale;
    sticks.push({ a: LK, b: RK, min: 0.14 * metre, max: Infinity, broken: false });
    sticks.push({ a: LA, b: RA, min: 0.1 * metre, max: Infinity, broken: false });
    sticks.push({ a: LW, b: RW, min: 0.08 * metre, max: Infinity, broken: false });
    const inv = p.map((_, k) => (k === PEL || k === CHE || k === BEL || k === LH || k === RH || k === LS || k === RS ? 0.45 : k === HEA ? 0.7 : 1));
    const radius = p.map((_, k) => metre * (k === HEA ? 0.11 : k === TOP ? 0.05 : k === PEL || k === CHE || k === BEL ? 0.12 : k === LS || k === RS || k === LH || k === RH ? 0.08
      // Limbs as thick as they are drawn: thinner, a knee or a shin sank into the ground.
      : k === LW || k === RW || k === LT || k === RT ? 0.055 : 0.07));
    const walls: Wall[] = world.wallsNear(x, y, m(35))
      // A wall the body starts in or against does not hold it: the building it
      // is blown out of (its pieces still being made), a doorway, a lot it
      // stood in. Collisions are projections (Jakobsen, "Advanced Character
      // Physics"), each particle moved the least way out: one started inside
      // went up on to the roof, the next out of a face metres off, and the
      // sticks drew the body back together over seconds - a giant shrinking.
      .filter((wall) => !inside(wall.ring, x, y) && !p.some((v, k) => {
        if (v.y > wall.top + radius[k]!) return false;
        const wx = v.x, wy = -v.z;
        if (inside(wall.ring, wx, wy)) return true;
        const e = nearestEdge(wall.ring, wx, wy);
        return Math.hypot(wx - e.x, wy - e.y) < radius[k]!;
      }))
      .map((wall) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const q of wall.ring) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
        return { ...wall, x0, y0, x1, y1 };
      });
    const side0 = new Vector3().subVectors(p[RH]!, p[LH]!).add(tmpD.subVectors(p[RS]!, p[LS]!)).normalize();
    const spine0 = new Vector3().subVectors(p[CHE]!, p[PEL]!);
    const front = new Vector3().crossVectors(side0, spine0).dot(forward) >= 0 ? 1 : -1;
    const living = fate === 'knocked' || fate === 'trip';
    const body: Body = {
      index: pose.index, scale, p, o: p.map((v) => v.clone()), inv, radius, ground: p.map(() => -Infinity), sticks,
      bonePart, parents: sk.parents, pos0, rot0, scl0,
      origin0: {} as Record<PartName, Vector3>, frame0: {} as Record<PartName, Matrix4>,
      normals: { larm: side0.clone(), rarm: side0.clone(), lleg: side0.clone(), rleg: side0.clone() },
      front, inverses: sk.inverses, binds, rebind, unbind, walls, torn: fate === 'torn', lostParts: new Set<PartName>(),
      survivor: living ? { id, phase: 'fall', t: 0, lie: fate === 'trip' ? 0.6 + Math.random() * 0.8 : 1.5 + Math.random() * 1.5, clip: RISE_CLIP } : undefined,
      comp: p.map(() => 0), palettes: [], anchor: new Matrix4(), still: 0, asleep: false, age: 0, flying: 0, pooled: false, splats: 0, spray: 0,
    };
    components(body);
    // The frames at rest, that each part's turn is measured from.
    const side = torsoSide(body, new Vector3());
    for (const [limb] of LIMB_JOINTS) body.normals[limb].copy(side);
    updateNormals(body, side, 1);
    for (const part of PART_NAMES) {
      body.origin0[part] = p[PARTS[part].origin]!.clone();
      body.frame0[part] = partFrame(body, part, side, new Matrix4());
    }
    return body;
  };

  /** Sets every particle moving: `v(k)` its velocity. */
  const launch = (body: Body, v: (k: number, out: Vector3) => Vector3): void => {
    const vel = new Vector3();
    for (let k = 0; k < body.p.length; k++) body.o[k]!.copy(body.p[k]!).addScaledVector(v(k, vel.set(0, 0, 0)), -STEP);
  };

  /** A blast's push on a body: away from it and up, the legs taken from under it, arms and legs scattered. */
  const blast = (body: Body, c: Casualty, strength: number): Vector3 => {
    const p = body.p;
    const dir = new Vector3(c.x - c.blastX, 0, -(c.y - c.blastY));
    if (dir.lengthSq() < 1e-6) dir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    dir.normalize();
    const speed = strength * (0.85 + Math.random() * 0.3);
    const lift = speed * (0.45 + 0.25 * Math.random());
    let low = Infinity, high = -Infinity;
    for (const v of p) { low = Math.min(low, v.y); high = Math.max(high, v.y); }
    const com = p.reduce((s, v) => s.add(v), new Vector3()).divideScalar(p.length);
    // Pitch: head back towards the blast; a little roll and twist besides.
    const spin = new Vector3().crossVectors(dir, UP).normalize().multiplyScalar((2 + 5 * c.power) * (0.7 + 0.6 * Math.random()))
      .addScaledVector(dir, (Math.random() - 0.5) * 4)
      .addScaledVector(UP, (Math.random() - 0.5) * 5);
    const scatter = LIMB_JOINTS.map(() => new Vector3(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5).multiplyScalar(speed * 0.45));
    launch(body, (k, v) => {
      const h = (p[k]!.y - low) / Math.max(1e-3, high - low);
      v.copy(dir).multiplyScalar(speed * (1.1 - 0.25 * h));
      v.y += lift;
      v.add(tmpD.crossVectors(spin, tmpC.subVectors(p[k]!, com)));
      LIMB_JOINTS.forEach(([, a, mid, b], i) => {
        if (k === b) v.add(scatter[i]!);
        else if (k === mid) v.addScaledVector(scatter[i]!, 0.6);
        else if (k === a) v.addScaledVector(scatter[i]!, 0.2);
      });
      if (k === LT) v.add(scatter[2]!);
      if (k === RT) v.add(scatter[3]!);
      return v;
    });
    return dir;
  };

  /** The particles a bullet strikes, by where it went in. */
  const STRUCK: Readonly<Record<BodyPart, readonly number[]>> = {
    head: [HEA, TOP], torso: [CHE, NEC, BEL], armL: [LE, LW], armR: [RE, RW], legL: [LK, LA], legR: [RK, RA],
  };

  /**
   * A bullet's push: the part it went into knocked back from the shooter, the
   * chest a little with it (a leg shot takes the leg from under them).
   */
  const shove = (body: Body, c: Casualty): Vector3 => {
    const dir = new Vector3(c.x - c.blastX, 0, -(c.y - c.blastY));
    if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
    dir.normalize();
    const hit = STRUCK[c.struck ?? 'torso'];
    const leg = c.struck === 'legL' || c.struck === 'legR';
    for (let k = 0; k < body.p.length; k++) {
      const push = hit.includes(k) ? m(leg ? 2.2 : 1.6) : k === CHE || k === NEC || k === HEA || k === TOP ? m(0.7) : 0;
      if (push > 0) body.o[k]!.addScaledVector(dir, -push * STEP);
    }
    body.asleep = false;
    return dir;
  };

  /** The body of a casualty of a blow. */
  const spawn = (c: Casualty, citizens: RagdollCitizens, world: RagdollWorld,
    given?: { index: number; palette: Float32Array; transform: Matrix4 }): void => {
    const groundHere = world.groundAt(c.x, c.y);
    const known = bodies.find((b) => b.survivor?.id === c.id);
    if (known) {
      // On the ground already, and struck again: thrown again, and killed if it was a killing blow.
      if (c.faded) {
        // Bled out where they lay: the crawling stops, the body goes still in a pool.
        known.survivor = undefined;
        known.asleep = false; known.still = 0;
        const at = known.p[PEL]!;
        bleed(at.x, -at.z, world.groundAt(at.x, -at.z), m(1.6), 20);
        return;
      }
      if (c.kind !== 'knocked') {
        // Killed where the body lies, not where they first fell from.
        known.survivor = undefined; known.torn = false;
        const at = known.p[PEL]!;
        bleed(at.x, -at.z, world.groundAt(at.x, -at.z), m(0.8), 4);
      }
      else if (known.survivor) {
        const alive = known.survivor;
        alive.phase = 'fall'; alive.t = 0; delete alive.from;
        if (c.lieFor !== undefined) alive.lie = Math.max(alive.lie, c.lieFor);
        if (c.crawl && !alive.crawl) {
          const ax = c.x - c.blastX, ay = c.y - c.blastY, l = Math.hypot(ax, ay) || 1;
          alive.crawl = { dx: ax / l, dy: ay / l, since: 0 };
        }
      }
      for (const limb of c.lost ?? []) if (!(c.severed ?? []).includes(limb)) for (const part of LOST_PARTS[limb]) known.lostParts.add(part);
      known.asleep = false; known.still = 0; known.flying = 0;
      const away = c.struck ? shove(known, c) : blast(known, c, c.kind === 'knocked' ? m(2.5 + 4 * c.power) : m(4 + 9 * c.power));
      sever(known, c, away, citizens);
      return;
    }
    const body = build(c.id, c.heading, citizens, world, c.x, c.y, c.kind, given);
    if (!body) { if (c.kind !== 'knocked') bleed(c.x, c.y, groundHere, m(1.8), 15); return; }
    for (const limb of c.lost ?? []) for (const part of LOST_PARTS[limb]) body.lostParts.add(part);
    body.recordId = c.id;
    if (body.survivor && c.lieFor !== undefined) body.survivor.lie = c.lieFor;
    if (body.survivor && c.crawl) {
      const ax = c.x - c.blastX, ay = c.y - c.blastY, l = Math.hypot(ax, ay) || 1;
      body.survivor.crawl = { dx: ax / l, dy: ay / l, since: 0 };
    }
    // A bullet does not throw a body: a small push where it went in, the
    // rest is the body itself giving way under its own weight.
    const speed = c.struck ? m(0.6) : c.kind === 'knocked' ? m(2.5 + 4 * c.power) : m(4 + 9 * c.power);
    const dir = c.struck ? shove(body, c) : blast(body, c, speed);
    // Alive going down: the arms out the way they fall, to take it
    // (Euphoria's catch-fall), not dead weight hitting the ground face first.
    if (c.struck && c.kind === 'knocked') {
      for (const k of [LW, RW, LE, RE]) body.o[k]!.addScaledVector(dir, -m(k === LW || k === RW ? 1.4 : 0.8) * STEP).y += m(0.6) * STEP;
    }
    // Joint friction while it falls: dead weight, not a rag.
    body.stiff = 1.6;
    const chest = body.p[CHE]!;
    if (c.kind === 'torn') {
      // Torn: thrown harder, limbs flung, blood everywhere - but whole. A
      // limb torn off by shrinking its bones to the joint (one palette per
      // piece) dragged every vertex the joint's two sides share half-way to
      // it: blades of skin. Tearing needs the mesh cut and capped at the
      // joint, as games author it; until then the body stays in one piece.
      for (const limb of LIMBS.filter(() => Math.random() < 0.5)) {
        const kick = new Vector3(Math.random() - 0.5, 0.3 + Math.random() * 0.6, Math.random() - 0.5).multiplyScalar(speed * 0.5).addScaledVector(dir, speed * 0.3);
        for (const k of limb) body.o[k]!.addScaledVector(kick, -STEP);
      }
      exhaust.burst(chest.x, -chest.z, chest.y, 160, 4, m(0.8), m(0.2), 1.6);
      for (let k = 0; k < 18; k++) {
        const a = Math.random() * Math.PI * 2, r = m(1 + Math.random() * 6);
        bleed(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, groundHere, m(0.5 + Math.random() * 1.1), 0);
      }
      bleed(c.x, c.y, groundHere, m(3.4), 1.8);
      // Pieces of them: an arm, a leg, and what was inside, flung over the street.
      api.onGore?.(chest.x, -chest.z, chest.y, dir.x, -dir.z, speed, 'torn');
    } else if (c.kind === 'dead') {
      exhaust.burst(chest.x, -chest.z, chest.y, 50, 4, m(0.4), m(0.16), 1.2);
      bleed(c.x, c.y, groundHere, m(1.2), 0.6);
      for (let k = 0; k < 4; k++) {
        const a = Math.random() * Math.PI * 2, r = m(0.8 + Math.random() * 2.5);
        bleed(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, groundHere, m(0.3 + Math.random() * 0.5), 0);
      }
      if (Math.random() < 0.35) api.onGore?.(chest.x, -chest.z, chest.y, dir.x, -dir.z, speed * 0.6, 'dead');
    }
    add(body);
    sever(body, c, dir, citizens);
    // A blast tears a body open (one torn apart, most often); a bullet never
    // does it at once - only a body already dead, shot again and again in
    // the belly (`shootBody`).
    if (!c.struck && (c.kind === 'torn' ? Math.random() < 0.7 : c.kind === 'dead' && Math.random() < 0.12)) {
      openBelly(body, dir.clone().multiplyScalar(m(3)), 2 + Math.floor(Math.random() * 3));
    }
  };

  /** What came off at this blow thrown off the body (`detach`), and the body burnt black right under a bomb. */
  const sever = (body: Body, c: Casualty, dir: Vector3, citizens: RagdollCitizens): void => {
    // Charred first: the pieces are twins of the body as it is.
    if (c.charred) { body.charred = true; citizens.char?.(body.index); }
    for (const limb of c.severed ?? []) {
      // A bullet takes a limb off and drops it near; a blast throws it.
      const speed = (c.struck ? m(0.8 + Math.random() * 0.8) : m(2.5 + 6 * Math.max(0.15, c.power))) * (0.7 + Math.random() * 0.6);
      const spread = c.struck ? m(0.6) : m(3);
      const kick = new Vector3(dir.x * speed + (Math.random() - 0.5) * spread, (c.struck ? m(0.4 + Math.random() * 0.6) : m(1.5 + Math.random() * 3) * (0.6 + c.power)),
        dir.z * speed + (Math.random() - 0.5) * spread);
      detach(body, limb, citizens, kick);
    }
  };

  /** The people's side and the world as last given (`shootBody` comes between frames). */
  let lastCitizens: RagdollCitizens | null = null;
  let world0: RagdollWorld | null = null;

  /**
   * A body shot to pieces: every limb and the head off it if still on, the
   * trunk soaked through, scraps of flesh over the ground round it and a
   * wide pool spreading - a heap of meat, as GTA leaves a body shot apart.
   */
  const mush = (body: Body, citizens: RagdollCitizens): void => {
    body.mush = true;
    const at = body.p[body.pin ? body.pin.root : CHE]!;
    if (!body.pin) {
      for (const limb of ['head', 'armL', 'armR', 'legL', 'legR'] as const) {
        if (LOST_PARTS[limb].every((q) => body.lostParts.has(q))) continue;
        detach(body, limb, citizens, new Vector3((Math.random() - 0.5) * m(3), m(1 + Math.random() * 2), (Math.random() - 0.5) * m(3)));
      }
    }
    citizens.drench?.(body.index);
    if (!body.pin) { body.opened = false; openBelly(body, new Vector3(0, m(1), 0), 6); }
    exhaust.burst(at.x, -at.z, at.y, 160, 4, m(0.7), m(0.2), 1.4);
    const gx = at.x, gy = -at.z, g = world0?.groundAt(gx, gy) ?? at.y;
    bleed(gx, gy, g, m(body.pin ? 1.2 : 2.8), body.pin ? 6 : 14);
    for (let n = 0; n < (body.pin ? 4 : 12); n++) {
      const a = Math.random() * Math.PI * 2, r = m(0.4 + Math.random() * 2.2);
      bleed(gx + Math.cos(a) * r, gy + Math.sin(a) * r, g, m(0.3 + Math.random() * 0.6), 0);
    }
    api.onGore?.(at.x, -at.z, at.y, 0, 0, m(2), 'torn');
    body.asleep = false;
  };

  /** The belly opened: the guts hanging out of it, swinging with the body, some spilled on the ground. */
  const openBelly = (body: Body, kick: Vector3, organs = 0): void => {
    if (!gore || body.opened || body.pin) return;
    body.opened = true;
    gore.spill(() => (bodies.includes(body) ? body.p[BEL]! : null), kick);
    if (Math.random() < 0.5) gore.spill(() => (bodies.includes(body) ? body.p[PEL]! : null), kick.clone().multiplyScalar(0.6));
    if (organs > 0) gore.scatter(body.p[BEL]!.clone(), organs, kick);
    exhaust.burst(body.p[BEL]!.x, -body.p[BEL]!.z, body.p[BEL]!.y, 60, 4, m(0.25), m(0.05), 1);
  };

  /** A bone's end out of a stump: from joint `at`, along `from` to `at` and on, `len` long, while the body lasts. */
  const boneOut = (body: Body, from: number, at: number, len: number): void => {
    if (!gore) return;
    const tip = new Vector3(), dir = new Vector3();
    gore.bone(() => {
      if (!bodies.includes(body)) return null;
      const a = body.p[at]!;
      dir.subVectors(a, body.p[from]!);
      const l = dir.length();
      if (l < 1e-6) return null;
      tip.copy(a).addScaledVector(dir, len / l);
      return [a, tip] as const;
    });
  };

  /** The stump and the cut end of each part that can come off: the joint it went at, and the particle it points from. */
  const STUMP: Readonly<Record<Severable, { body: readonly [number, number]; piece: readonly [number, number] }>> = {
    armL: { body: [LS, LE], piece: [LW, LE] }, armR: { body: [RS, RE], piece: [RW, RE] },
    legL: { body: [LH, LK], piece: [LA, LK] }, legR: { body: [RH, RK], piece: [RA, RK] },
    head: { body: [CHE, NEC], piece: [TOP, HEA] },
  };

  const remove = (i: number): void => {
    bodies[i]?.drop?.();
    bodies.splice(i, 1);
  };

  /**
   * A limb (or the head) torn off at a blow: a body of its own from here -
   * the person's own arm, leg or head, their sleeve and skin on it, closed at
   * the joint it came from (as GTA's and Soldier of Fortune's dismemberment
   * swap in the severed part) - kicked off the way the blow went; the body
   * left without it, closed at the stump.
   */
  const detach = (body: Body, limb: Severable, citizens: RagdollCitizens, kick: Vector3): void => {
    const parts = LOST_PARTS[limb];
    const index = citizens.twin ? citizens.twin(body.index) : body.index;
    if (index === null) { for (const part of parts) body.lostParts.add(part); return; }
    const keep = new Set<number>();
    for (const part of parts) { keep.add(PARTS[part].origin); keep.add(PARTS[part].to); }
    const root = PARTS[parts[0]!].origin;
    const piece: Body = {
      ...body,
      index,
      p: body.p.map((v) => v.clone()),
      o: body.o.map((v) => v.clone()),
      ground: body.ground.slice(),
      sticks: body.sticks.map((s) => ({ ...s, broken: s.broken || !(keep.has(s.a) && keep.has(s.b)) })),
      normals: { larm: body.normals.larm.clone(), rarm: body.normals.rarm.clone(), lleg: body.normals.lleg.clone(), rleg: body.normals.rleg.clone() },
      lostParts: new Set(PART_NAMES.filter((part) => !parts.includes(part))),
      survivor: undefined, pin: { root, keep }, drop: index !== body.index ? () => citizens.untwin?.(index) : undefined,
      comp: [], palettes: [], anchor: new Matrix4(), still: 0, asleep: false, age: 0, flying: 0, pooled: false, splats: 0, spray: 0, torn: true,
    };
    components(piece);
    const spin = new Vector3((Math.random() - 0.5) * 2, Math.random(), (Math.random() - 0.5) * 2).multiplyScalar(kick.length() * 0.6);
    for (const k of keep) piece.o[k]!.copy(piece.p[k]!).addScaledVector(kick, -STEP).addScaledVector(spin, k === root ? 0 : -STEP);
    for (const part of parts) body.lostParts.add(part);
    body.asleep = false;
    // The stump spurting.
    const at = body.p[root]!;
    exhaust.burst(at.x, -at.z, at.y, 60, 4, m(0.35), m(0.08), 1.1);
    add(piece);
    // Now and then the bone shows: out of the stump, out of the piece, or both.
    const stump = STUMP[limb];
    const roll = Math.random();
    if (roll < 0.55) boneOut(body, stump.body[0], stump.body[1], m(limb === 'head' ? 0.05 : 0.07));
    if (roll > 0.3 && roll < 0.8) boneOut(piece, stump.piece[0], stump.piece[1], m(limb === 'head' ? 0.04 : 0.06));
  };

  const add = (body: Body): void => {
    bodies.push(body);
    if (bodies.length > MAX_BODIES) {
      // The oldest of the dead goes first; the living get up on their own.
      const i = bodies.findIndex((b) => !b.survivor);
      remove(i >= 0 ? i : 0);
    }
  };

  return {
    decals,
    stats: () => ({
      bodies: bodies.length, moving: bodies.filter((b) => !b.asleep).length,
      pieces: bodies.reduce((n, b) => n + new Set(b.comp).size, 0), living: bodies.filter((b) => b.survivor).length,
    }),
    clear() {
      for (const b of bodies) b.drop?.();
      bodies.length = 0;
      decals.length = 0;
    },
    probe: () => bodies.map((b) => {
      const M = b.scale || 1;
      let under = 0, inWall = 0, boneError = 0, speed = 0;
      b.p.forEach((v, k) => {
        if (b.pin && !b.pin.keep.has(k)) return;
        const g = b.ground[k]!;
        if (Number.isFinite(g)) under = Math.max(under, (g + b.radius[k]! * 0.5 - v.y) / M);
        speed = Math.max(speed, v.distanceTo(b.o[k]!) / STEP / M);
        for (const w of b.walls) {
          const x = v.x, y = -v.z;
          if (x < w.x0 || x > w.x1 || y < w.y0 || y > w.y1) continue;
          const top = w.roof ? w.roof(x, y) : w.top;
          if (v.y > top || !inside(w.ring, x, y)) continue;
          const e = nearestEdge(w.ring, x, y);
          inWall = Math.max(inWall, Math.min(Math.hypot(x - e.x, y - e.y), top - v.y) / M);
        }
      });
      for (const s of b.sticks) {
        if (s.broken || s.min !== s.max || (b.pin && !(b.pin.keep.has(s.a) && b.pin.keep.has(s.b)))) continue;
        const l = b.p[s.a]!.distanceTo(b.p[s.b]!);
        boneError = Math.max(boneError, Math.abs(l - s.min) / Math.max(1e-6, s.min));
      }
      return {
        id: b.survivor?.id ?? b.recordId ?? -1, phase: b.survivor?.phase ?? 'dead', piece: !!b.pin, asleep: b.asleep, charred: !!b.charred,
        points: b.p.map((v) => [v.x, -v.z, v.y] as const), underGround: Math.max(0, under), inWall, boneError, speed,
        lost: [...b.lostParts], hits: b.hits ?? 0,
      };
    }),
    debug: () => bodies.map((b) => ({
      pelvis: b.p[PEL]!.toArray(), head: b.p[HEA]!.toArray(), asleep: b.asleep, phase: `${b.survivor?.phase ?? 'dead'}${b.survivor ? `#${b.survivor.id}/${b.survivor.lie.toFixed(1)}${b.survivor.crawl ? 'c' : ''}` : b.pin ? '/piece' : ''}`, torn: b.torn,
    })),
    hides: (id) => bodies.some((b) => b.survivor?.id === id),
    release(down) {
      // Up: stood on the clip's last frame until the simulation lets them go
      // too (it may be paused, or running faster than the clock).
      for (let i = bodies.length - 1; i >= 0; i--) {
        const alive = bodies[i]!.survivor;
        if (alive?.phase === 'rise' && alive.t >= RISE_BLEND + alive.clip && !down(alive.id)) remove(i);
      }
    },
    drip(x, y, z, size) { bleed(x, y, z, size, 0); },
    get onGore() { return api.onGore; },
    set onGore(f) { api.onGore = f; },
    fling(list, citizens, world) {
      const loaded = citizens.loadedIndices();
      if (!loaded.length) return;
      const turn = new Quaternion(), place = new Vector3(), size = new Vector3();
      for (const o of list) {
        const index = o.index !== undefined && o.index !== null && loaded.includes(o.index) ? o.index : loaded[Math.abs(o.id) % loaded.length]!;
        const clip = citizens.clipPose(index, 'idle', (o.id % 97) / 97);
        if (!clip) continue;
        const transform = new Matrix4().compose(place.set(o.x, o.z, -o.y), turn.setFromAxisAngle(UP, o.heading + Math.PI / 2), size.setScalar(m(1)));
        // Torn: an arm, a leg, the head off; killed: now and then a limb.
        const all: Severable[] = ['head', 'armL', 'armR', 'legL', 'legR'];
        const severed = o.kind === 'torn' ? all.filter(() => Math.random() < 0.45)
          : o.kind === 'dead' && Math.random() < 0.35 ? [all[1 + Math.floor(Math.random() * 4)]!] : [];
        const c = { x: o.x, y: o.y, heading: o.heading, kind: o.kind, t: 0, id: o.id, gender: 'm', ageClass: 'adult', party: null,
          blastX: o.blastX, blastY: o.blastY, power: o.power, severed, lost: severed, charred: o.charred === true } as unknown as Casualty;
        spawn(c, citizens, world, { index, palette: clip.palette, transform });
      }
    },
    shootBody(a, b) {
      const citizens = lastCitizens;
      if (!citizens) return null;
      const ab = new Vector3().subVectors(b, a);
      const len2 = Math.max(1e-9, ab.lengthSq());
      let best: { body: Body; k: number; d: number; t: number } | null = null;
      for (const body of bodies) {
        for (let k = 0; k < body.p.length; k++) {
          if (body.pin && !body.pin.keep.has(k)) continue;
          if (k === BEL) continue;
          const v = body.p[k]!;
          const t = Math.max(0, Math.min(1, tmpA.subVectors(v, a).dot(ab) / len2));
          const d = tmpB.copy(a).addScaledVector(ab, t).distanceTo(v);
          const reach = body.radius[k]! * 1.8 + m(0.08);
          if (d < reach && (!best || t < best.t - 0.002 || (Math.abs(t - best.t) <= 0.002 && d < best.d))) best = { body, k, d, t };
        }
      }
      if (!best) return null;
      const { body, k } = best;
      const part: BodyPart = k === HEA || k === TOP ? 'head' : k === LS || k === LE || k === LW ? 'armL' : k === RS || k === RE || k === RW ? 'armR'
        : k === LH || k === LK || k === LA || k === LT ? 'legL' : k === RH || k === RK || k === RA || k === RT ? 'legR' : 'torso';
      if (body.survivor) return { alive: body.survivor.id, part };
      const dir = ab.clone().normalize();
      const at = body.p[k]!;
      // The bullet's push, the spray out of the far side, blood under it.
      body.o[k]!.addScaledVector(dir, -m(1.6) * STEP);
      body.asleep = false; body.still = 0; body.flying = 0;
      exhaust.burst(at.x + dir.x * m(0.15), -(at.z + dir.z * m(0.15)), at.y, 26, 4, m(0.18), m(0.035), 0.8);
      const gx = at.x + dir.x * m(0.5), gy = -(at.z + dir.z * m(0.5));
      bleed(gx, gy, world0?.groundAt(gx, gy) ?? at.y, m(0.5 + Math.random() * 0.4), 0);
      citizens.wound?.(body.index, part);
      body.hits = (body.hits ?? 0) + 1;
      const tally = body.partHits ??= {};
      tally[part] = (tally[part] ?? 0) + 1;
      if (part === 'torso' && !body.opened && (tally.torso ?? 0) >= 4 && Math.random() < 0.5) openBelly(body, dir.clone().multiplyScalar(m(1.2)), 1);
      // A limb shot off at the second hit (the head at the first or second).
      if (!body.pin && part !== 'torso') {
        const limb = part as Severable;
        const gone = LOST_PARTS[limb].every((q) => body.lostParts.has(q));
        if (!gone && tally[part]! >= (part === 'head' ? 1 + (Math.random() < 0.5 ? 1 : 0) : 2)) {
          const kick = dir.clone().multiplyScalar(m(1)).add(new Vector3((Math.random() - 0.5) * m(0.6), m(0.5 + Math.random() * 0.8), (Math.random() - 0.5) * m(0.6)));
          detach(body, limb, citizens, kick);
        }
      }
      // Shot to pieces: what is left a heap of meat, soaked, everything round it red.
      const bare = (['armL', 'armR', 'legL', 'legR', 'head'] as const).filter((l) => LOST_PARTS[l].every((q) => body.lostParts.has(q))).length;
      if (!body.pin && !body.mush && (body.hits >= 12 || (bare >= 3 && body.hits >= 8))) mush(body, citizens);
      else if (body.pin && body.hits >= 3 && !body.mush) mush(body, citizens);
      return 'hit';
    },
    absorb(list, citizens, world) {
      lastCitizens = citizens;
      world0 = world;
      for (const c of list) {
        // Each record once (two shots from the same place are two records).
        if (taken.has(c)) continue;
        taken.add(c);
        spawn(c, citizens, world);
      }
    },
    trip(id, heading, citizens, world, away = null) {
      if (bodies.some((b) => b.survivor?.id === id)) return;
      const pose = citizens.capturedPose(id);
      if (!pose) return;
      const x = pose.transform.elements[12]!, y = -pose.transform.elements[14]!;
      const body = build(id, heading, citizens, world, x, y, 'trip');
      if (!body) return;
      const low = Math.min(...body.p.map((v) => v.y)), high = Math.max(...body.p.map((v) => v.y));
      if (away === null) {
        // The feet caught, the body pitching forward over them, the hands going out to break the fall.
        const fwd = new Vector3(Math.cos(heading), 0, -Math.sin(heading));
        launch(body, (k, v) => {
          const h = (body.p[k]!.y - low) / Math.max(1e-3, high - low);
          v.copy(fwd).multiplyScalar(m(0.4) + m(2.2) * h);
          if (k === LW || k === RW || k === LE || k === RE) v.addScaledVector(fwd, m(1.2)).y -= m(0.6);
          return v;
        });
      } else {
        // Struck: the chest and head driven away from the blow, the feet left
        // where they stood - backwards over the heels, or sideways, as it came -
        // the arms flung up and out.
        const push = new Vector3(Math.cos(away), 0, -Math.sin(away));
        launch(body, (k, v) => {
          const h = (body.p[k]!.y - low) / Math.max(1e-3, high - low);
          v.copy(push).multiplyScalar(m(0.2) + m(3.2) * h * h);
          if (k === LW || k === RW || k === LE || k === RE) v.addScaledVector(push, m(0.8)).y += m(1.2);
          if (k === HEA || k === TOP) v.addScaledVector(push, m(0.8));
          return v;
        });
      }
      add(body);
    },
    update(dt, world) {
      const wall = Math.min(0.1, Math.max(0, dt));
      clock += wall;
      for (const d of decals) d.age += wall;
      while (clock >= STEP) {
        clock -= STEP;
        for (const body of bodies) if (!body.asleep) step(body, world);
      }
      for (let i = bodies.length - 1; i >= 0; i--) {
        const body = bodies[i]!;
        body.age += wall;
        const alive = body.survivor;
        if (alive) {
          alive.t += wall;
          if (alive.phase === 'fall' && (body.asleep || alive.t > FALL_MOST)) { alive.phase = 'lie'; alive.t = 0; body.asleep = !alive.crawl; }
          else if (alive.phase === 'lie' && alive.crawl) crawlOn(body, alive.crawl, wall, world);
          else if (alive.phase === 'rise' && alive.t > RISE_BLEND + alive.clip + 3) { remove(i); continue; }
          continue;
        }
        if (body.age > LIE + SINK) { remove(i); continue; }
        if (body.charred && !body.pin && body.age < 6) body.asleep = false;
        if (body.age > LIE) for (const v of body.p) v.y -= wall * m(0.12);
        if (body.asleep && !body.pooled) {
          body.pooled = true;
          // A pool of blood spreading from under each piece.
          for (const piece of body.pin ? [body.comp[body.pin.root]!] : new Set(body.comp)) {
            const at = new Vector3();
            let n = 0;
            body.p.forEach((v, k) => { if (body.comp[k] === piece) { at.add(v); n++; } });
            at.divideScalar(Math.max(1, n));
            const main = !body.pin && body.comp[PEL] === piece;
            bleed(at.x, -at.z, world.groundAt(at.x, -at.z), m(main ? (body.torn ? 2.6 : 2.0) : 0.9), main ? 30 : 12);
          }
        }
      }
    },
    draw(citizens, world) {
      lastCitizens = citizens;
      for (const body of bodies) {
        const alive = body.survivor;
        // The get-up clip asked for while they fall, so it is baked by the time they get up.
        if (alive && alive.phase !== 'rise' && !alive.ready) alive.ready = citizens.clipPose(body.index, RISE_KEY, 0) !== null;
        if (alive && alive.phase === 'lie' && alive.t >= alive.lie && (alive.ready || alive.t > alive.lie + 3)) rise(body, alive, citizens, world);
        if (alive?.phase === 'rise' && alive.from && alive.root) {
          body.palettes = [risePalette(body, alive, citizens)];
        } else if (!body.asleep || !body.palettes.length || body.age > LIE) {
          body.palettes = palettes(body, bonesWorld(body));
        }
        for (const palette of body.palettes) citizens.drawPalette(body.index, palette, body.anchor, body.charred === true, body.survivor !== undefined);
      }
    },
  };

  /**
   * Getting up: which way, from how the body lies (face down, it pushes up
   * and crouches facing where its head was; face up, it sits up facing its
   * feet), where (over its pelvis), and the lying pose to blend from.
   */
  function rise(body: Body, alive: Survivor, citizens: RagdollCitizens, world: RagdollWorld): void {
    const spine = new Vector3().subVectors(body.p[CHE]!, body.p[PEL]!).normalize();
    const side = torsoSide(body, new Vector3()).clone();
    const chestFront = new Vector3().crossVectors(side, spine).multiplyScalar(body.front);
    const facing = (chestFront.y < 0 ? spine.clone() : spine.clone().negate()).setY(0);
    if (facing.lengthSq() < 0.04) facing.copy(chestFront).setY(0);
    if (facing.lengthSq() < 1e-6) facing.set(1, 0, 0);
    facing.normalize();
    const heading = Math.atan2(-facing.z, facing.x);
    const x = body.p[PEL]!.x, y = -body.p[PEL]!.z;
    const clip = citizens.clipPose(body.index, RISE_KEY, 0);
    // Played in two seconds at most: the crouch-to-stand clip runs four and more.
    alive.clip = Math.min(2, clip?.duration ?? RISE_CLIP);
    alive.root = new Matrix4().compose(
      new Vector3(x, world.groundAt(x, y), -y),
      new Quaternion().setFromAxisAngle(UP, heading + Math.PI / 2),
      new Vector3(body.scale, body.scale, body.scale),
    );
    alive.from = bonesWorld(body);
    alive.phase = 'rise';
    alive.t = 0;
    getUp(alive.id, x, y, heading, RISE_BLEND + alive.clip);
  }

  /** A getting-up body: the lying pose blended into the get-up clip's first frame, then the clip. */
  function risePalette(body: Body, alive: Survivor, citizens: RagdollCitizens): Float32Array {
    const blend = smooth(alive.t / RISE_BLEND);
    const phase = Math.max(0, alive.t - RISE_BLEND) / Math.max(0.1, alive.clip);
    const clip = citizens.clipPose(body.index, RISE_KEY, phase);
    const bones = body.pos0.length;
    const from = alive.from!;
    let world: Matrix4[];
    if (!clip) world = from;
    else {
      const w = new Matrix4();
      const target = from.map((_, i) => {
        w.fromArray(clip.palette, i * 16).multiply(body.binds[i]!);
        return new Matrix4().multiplyMatrices(alive.root!, body.rebind).multiply(w);
      });
      // Blended in, the clip's own matrix exactly: a bone of these rigs is
      // scaled unevenly (sheared), and taken apart and put back together it
      // came out crooked.
      if (blend >= 0.999) world = target;
      else {
        // Before that, blended as animation systems blend poses: each bone's
        // turn relative to its parent, then the chain put back together from
        // the root. Each bone blended on its own in the world (position along
        // a straight line, turn on its own) pulled the limbs off their joints
        // and folded the body through itself on the way up (the player,
        // 2026-10-06: "a forma totalmente deformada").
        world = new Array<Matrix4>(bones);
        const p0 = new Vector3(), q0 = new Quaternion(), s0 = new Vector3();
        const p1 = new Vector3(), q1 = new Quaternion(), s1 = new Vector3();
        const local = (list: readonly Matrix4[], i: number, out: Matrix4): Matrix4 => {
          const parent = body.parents[i]!;
          return parent >= 0 ? out.copy(list[parent]!).invert().multiply(list[i]!) : out.copy(list[i]!);
        };
        const a = new Matrix4(), b = new Matrix4();
        const solve = (i: number): Matrix4 => {
          const known = world[i];
          if (known) return known;
          local(from, i, a).decompose(p0, q0, s0);
          local(target, i, b).decompose(p1, q1, s1);
          p0.lerp(p1, blend); q0.slerp(q1, blend); s0.lerp(s1, blend);
          const own = new Matrix4().compose(p0, q0, s0);
          const parent = body.parents[i]!;
          const out = parent >= 0 ? new Matrix4().multiplyMatrices(solve(parent), own) : own;
          world[i] = out;
          return out;
        };
        for (let i = 0; i < bones; i++) solve(i);
      }
    }
    const w = new Matrix4();
    body.anchor.copy(alive.root!);
    const back = body.unbind.clone().multiply(body.anchor.clone().invert());
    const out = new Float32Array(bones * 16);
    for (let i = 0; i < bones; i++) w.multiplyMatrices(back, world[i]!).multiply(body.inverses[i]!).toArray(out, i * 16);
    return out;
  }

  /** One Verlet step of a body: move, then relax the sticks, the joints and the collisions together. */
  /**
   * Somebody down with a leg gone dragging themself along: the arms and the
   * chest pulled a hand's length at a time, the legs drawn after by the
   * sticks, a smear of blood left behind (as GTA's wounded crawl).
   */
  function crawlOn(body: Body, crawl: NonNullable<Survivor['crawl']>, dt: number, world: RagdollWorld): void {
    crawl.since += dt;
    // A pull, then a rest: about one stroke a second.
    const stroke = Math.max(0, Math.sin(crawl.since * Math.PI * 1.1));
    const pull = m(0.32) * stroke * dt;
    for (const k of [HEA, TOP, NEC, CHE, LS, RS, LE, RE, LW, RW]) {
      body.p[k]!.x += crawl.dx * pull;
      body.p[k]!.z -= crawl.dy * pull;
      body.o[k]!.x += crawl.dx * pull;
      body.o[k]!.z -= crawl.dy * pull;
    }
    body.asleep = false;
    if (stroke > 0.98 && (crawl.since % 2) < dt * 2) {
      const at = body.p[PEL]!;
      bleed(at.x, -at.z, world.groundAt(at.x, -at.z), m(0.35 + Math.random() * 0.25), 0);
    }
  }

  /**
   * A body burnt black draws up as burnt bodies do (the heat contracting
   * the muscles: the "pugilistic attitude" of forensics): the forearms drawn
   * up to the chest, the fists before the face, the knees and hips bent.
   */
  function curl(body: Body): void {
    const k = 0.015 * Math.min(1, body.age / 1.5);
    const chest = body.p[CHE]!, head = body.p[HEA]!;
    tmpA.lerpVectors(chest, head, 0.6);
    body.p[LW]!.lerp(tmpA, k); body.p[RW]!.lerp(tmpA, k);
    body.p[LE]!.lerp(chest, k * 0.5); body.p[RE]!.lerp(chest, k * 0.5);
    body.p[LA]!.lerp(body.p[LH]!, k * 0.8); body.p[RA]!.lerp(body.p[RH]!, k * 0.8);
    body.p[LK]!.lerp(chest, k * 0.4); body.p[RK]!.lerp(chest, k * 0.4);
  }

  /**
   * Joint friction: across every bone (a rigid stick), the two ends' speeds
   * drawn a little towards their mean - the damping a joint's muscles and
   * tissue give a real body (an articulated body's joint damping), so the
   * limbs follow the trunk instead of whipping about it.
   */
  function joints(body: Body): void {
    const { p, o } = body;
    const k = 0.12;
    for (const s of body.sticks) {
      if (s.broken || s.min !== s.max) continue;
      const a = p[s.a]!, b = p[s.b]!, oa = o[s.a]!, ob = o[s.b]!;
      const vax = a.x - oa.x, vay = a.y - oa.y, vaz = a.z - oa.z;
      const vbx = b.x - ob.x, vby = b.y - ob.y, vbz = b.z - ob.z;
      const mx = (vax + vbx) / 2, my = (vay + vby) / 2, mz = (vaz + vbz) / 2;
      oa.set(a.x - (vax + (mx - vax) * k), a.y - (vay + (my - vay) * k), a.z - (vaz + (mz - vaz) * k));
      ob.set(b.x - (vbx + (mx - vbx) * k), b.y - (vby + (my - vby) * k), b.z - (vbz + (mz - vbz) * k));
    }
  }

  function step(body: Body, world: RagdollWorld): void {
    const { p, o, inv } = body;
    let moved = 0;
    for (let k = 0; k < p.length; k++) {
      const v = p[k]!, old = o[k]!;
      const vx = (v.x - old.x) * AIR, vy = (v.y - old.y) * AIR, vz = (v.z - old.z) * AIR;
      old.copy(v);
      v.x += vx; v.y += vy - GRAVITY * STEP * STEP; v.z += vz;
      moved = Math.max(moved, Math.abs(vx) + Math.abs(vy) + Math.abs(vz));
      // The ground under each particle, looked up once a step.
      body.ground[k] = world.groundAt(v.x, -v.z);
    }
    if (body.stiff && body.stiff > 0) { body.stiff -= STEP; joints(body); }
    if (body.charred && !body.pin && body.age < 6) curl(body);
    // Walls within reach of the body this step.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const v of p) { x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, -v.z); y1 = Math.max(y1, -v.z); }
    const pad = m(0.3);
    const near = body.walls.filter((w) => w.x0 < x1 + pad && w.x1 > x0 - pad && w.y0 < y1 + pad && w.y1 > y0 - pad);
    for (let it = 0; it < ITERATIONS; it++) {
      for (const s of body.sticks) {
        if (s.broken) continue;
        const a = p[s.a]!, b = p[s.b]!;
        const d = tmpA.subVectors(b, a);
        const l = d.length() || 1e-6;
        const target = l < s.min ? s.min : l > s.max ? s.max : l;
        if (target === l) continue;
        const wa = inv[s.a]!, wb = inv[s.b]!;
        const diff = (l - target) / (l * (wa + wb));
        a.addScaledVector(d, wa * diff);
        b.addScaledVector(d, -wb * diff);
      }
      hinges(body);
      collide(body, near, it === ITERATIONS - 1, world);
      if (it % 3 === 2 || it === ITERATIONS - 1) capsules(body, near, world);
    }
    // The bones' lengths last (a little into a wall reads less than a body
    // pulled apart; Unity's ragdoll "projection" does the same).
    for (let it = 0; it < 3; it++) {
      for (const s of body.sticks) {
        if (s.broken || s.min !== s.max) continue;
        const a = p[s.a]!, b = p[s.b]!;
        const d = tmpA.subVectors(b, a);
        const l = d.length() || 1e-6;
        const wa = inv[s.a]!, wb = inv[s.b]!;
        const diff = (l - s.min) / (l * (wa + wb));
        a.addScaledVector(d, wa * diff);
        b.addScaledVector(d, -wb * diff);
      }
    }
    if (body.pin) {
      const { root, keep } = body.pin;
      for (let k = 0; k < p.length; k++) if (!keep.has(k)) { p[k]!.copy(p[root]!); o[k]!.copy(o[root]!); }
    }
    body.flying += STEP;
    // At rest for a moment, or long enough: asleep, drawn as it lies.
    body.still = moved < m(0.0025) ? body.still + STEP : 0;
    if (body.still > 0.8 || body.flying > SETTLE) body.asleep = true;
    // A torn body sprays blood from its stumps while it flies.
    if (body.torn && moved > m(0.01)) {
      body.spray -= STEP;
      if (body.spray <= 0) {
        body.spray = 0.06;
        const k = Math.floor(Math.random() * p.length);
        exhaust.burst(p[k]!.x, -p[k]!.z, p[k]!.y, 3, 4, m(0.1), m(0.12), 0.8);
      }
    }
  }

  /** Knees bend forwards only and elbows backwards only: one on the wrong side of its limb's line is pushed back across. */
  function hinges(body: Body): void {
    const side = torsoSide(body, tmpD);
    const fwd = tmpE.crossVectors(side, tmpA.subVectors(body.p[CHE]!, body.p[PEL]!)).normalize().multiplyScalar(body.front);
    for (const [limb, a, mid, b] of LIMB_JOINTS) {
      // A limb torn off has no torso to measure its front by.
      if (body.comp[a] !== body.comp[PEL] || body.comp[mid] !== body.comp[PEL] || body.comp[b] !== body.comp[PEL]) continue;
      const sign = limb === 'lleg' || limb === 'rleg' ? 1 : -1;
      const pa = body.p[a]!, pk = body.p[mid]!, pb = body.p[b]!;
      const ab = tmpA.subVectors(pb, pa);
      const t = Math.max(0, Math.min(1, tmpB.subVectors(pk, pa).dot(ab) / Math.max(1e-9, ab.lengthSq())));
      const off = tmpB.copy(pa).addScaledVector(ab, t).sub(pk).negate();
      const ahead = off.dot(fwd) * sign;
      if (ahead < 0) {
        const push = -ahead * sign * 0.7;
        pk.addScaledVector(fwd, push * 0.6);
        pa.addScaledVector(fwd, -push * 0.2);
        pb.addScaledVector(fwd, -push * 0.2);
      }
    }
  }

  /** The ground, the walls and the roofs, as projections; speed into a surface is mostly lost, and some along it. */
  function collide(body: Body, walls: readonly Wall[], last: boolean, world: RagdollWorld): void {
    const { p, o, radius } = body;
    const bloody = !body.survivor;
    for (let k = 0; k < p.length; k++) {
      if (body.pin && !body.pin.keep.has(k)) continue;
      const v = p[k]!, old = o[k]!, r = radius[k]!;
      const floor = body.ground[k]! + r;
      if (v.y < floor) {
        const vy = v.y - old.y;
        v.y = floor;
        // Friction on the ground, and a small bounce.
        old.x = v.x - (v.x - old.x) * 0.82;
        old.z = v.z - (v.z - old.z) * 0.82;
        old.y = v.y + Math.min(0, vy) * 0.18;
        if (bloody && last && vy < -m(4) * STEP && body.splats < 12 && Math.random() < 0.35) {
          body.splats++;
          bleed(v.x, -v.z, floor - r, m(0.35 + Math.random() * 0.5), 0.5);
          exhaust.burst(v.x, -v.z, floor, 5, 4, m(0.1), m(0.12), 0.7);
        }
      }
      for (const wall of walls) {
        if (v.y > wall.top + r) continue;
        const wx = v.x, wy = -v.z;
        if (wx < wall.x0 - r || wx > wall.x1 + r || wy < wall.y0 - r || wy > wall.y1 + r) continue;
        const into = inside(wall.ring, wx, wy);
        const edge = nearestEdge(wall.ring, wx, wy);
        const dx = wx - edge.x, dy = wy - edge.y;
        const away = Math.hypot(dx, dy);
        if (!into && away >= r) continue;
        const top = wall.roof ? wall.roof(wx, wy) : wall.top;
        if (v.y > top + r) continue;
        // Over the wall or the roof, coming down on it (or nearer its top than
        // its face): onto it, like the ground.
        if (into && (old.y >= top + r * 0.5 || top + r - v.y < away + r)) {
          const vy = v.y - old.y;
          v.y = top + r;
          old.x = v.x - (v.x - old.x) * 0.8;
          old.z = v.z - (v.z - old.z) * 0.8;
          old.y = v.y + Math.min(0, vy) * 0.18;
          continue;
        }
        // Out to the face, a particle's radius off it.
        let nx = into ? -dx : dx, ny = into ? -dy : dy;
        const nl = Math.hypot(nx, ny);
        if (nl < 1e-9) continue;
        nx /= nl; ny /= nl;
        const vx = v.x - old.x, vy = -(v.z - old.z);
        v.x = edge.x + nx * r;
        v.z = -(edge.y + ny * r);
        // The speed into the wall turned back at a fifth; along it, most is kept.
        const vn = vx * nx + vy * ny;
        let tx = vx, ty = vy;
        if (vn < 0) { tx -= 1.2 * vn * nx; ty -= 1.2 * vn * ny; }
        tx *= 0.75; ty *= 0.75;
        old.x = v.x - tx;
        old.z = v.z + ty;
        if (bloody && last && vn < -m(3) * STEP && body.splats < 12) {
          body.splats++;
          bleed(edge.x + nx * m(0.3), edge.y + ny * m(0.3), world.groundAt(edge.x, edge.y), m(0.5 + Math.random() * 0.4), 1);
          exhaust.burst(v.x, -v.z, v.y, 8, 4, m(0.15), m(0.12), 0.7);
        }
      }
    }
  }

  /**
   * The bones as capped cylinders (Jakobsen, "Advanced Character Physics":
   * each limb a capsule projected out of what it strikes): two points along
   * every bone kept out of the ground and the walls, the bone's two ends
   * moved by their share of the correction. With the joints alone colliding,
   * a forearm or a shin lying across a kerb, a step or a pole sank into it.
   */
  function capsules(body: Body, walls: readonly Wall[], world: RagdollWorld): void {
    const { p, o, radius } = body;
    for (const [a, b] of CAPSULE_BONES) {
      if (body.pin && !(body.pin.keep.has(a) && body.pin.keep.has(b))) continue;
      if (body.comp[a] !== body.comp[b]) continue;
      const pa = p[a]!, pb = p[b]!;
      const r = (radius[a]! + radius[b]!) / 2;
      for (const t of CAPSULE_SAMPLES) {
        const wa = 1 - t, wb = t, share = wa * wa + wb * wb;
        const qx = pa.x + (pb.x - pa.x) * t, qy = pa.y + (pb.y - pa.y) * t, qz = pa.z + (pb.z - pa.z) * t;
        const pen = world.groundAt(qx, -qz) + r - qy;
        if (pen > 0) {
          // Moved out, not thrown out: the old positions go with them, so the
          // correction adds no speed (a push out turned into a launch).
          const l = pen / share;
          pa.y += wa * l; pb.y += wb * l;
          o[a]!.y += wa * l; o[b]!.y += wb * l;
          // Friction along the ground, as for a joint.
          o[a]!.x += (pa.x - o[a]!.x) * 0.18 * wa; o[a]!.z += (pa.z - o[a]!.z) * 0.18 * wa;
          o[b]!.x += (pb.x - o[b]!.x) * 0.18 * wb; o[b]!.z += (pb.z - o[b]!.z) * 0.18 * wb;
        }
        for (const wall of walls) {
          const wx = qx, wy = -qz;
          if (wx < wall.x0 - r || wx > wall.x1 + r || wy < wall.y0 - r || wy > wall.y1 + r) continue;
          const top = wall.roof ? wall.roof(wx, wy) : wall.top;
          if (qy > top + r) continue;
          const into = inside(wall.ring, wx, wy);
          const edge = nearestEdge(wall.ring, wx, wy);
          let nx = wx - edge.x, ny = wy - edge.y;
          const away = Math.hypot(nx, ny);
          if (!into && away >= r) continue;
          if (away < 1e-9) continue;
          nx /= away; ny /= away;
          if (into) { nx = -nx; ny = -ny; }
          // Out to the face, a radius off it, the ends sharing the move.
          const depth = into ? away + r : r - away;
          const l = depth / share;
          pa.x += nx * wa * l; pa.z -= ny * wa * l;
          pb.x += nx * wb * l; pb.z -= ny * wb * l;
          o[a]!.x += nx * wa * l; o[a]!.z -= ny * wa * l;
          o[b]!.x += nx * wb * l; o[b]!.z -= ny * wb * l;
        }
      }
    }
  }

  /** The torso's side axis (left to right), from the hips and the shoulders still on it. */
  function torsoSide(body: Body, out: Vector3): Vector3 {
    out.set(0, 0, 0);
    const c = body.comp[PEL];
    if (body.comp[LH] === c && body.comp[RH] === c) out.add(tmpA.subVectors(body.p[RH]!, body.p[LH]!));
    if (body.comp[LS] === c && body.comp[RS] === c) out.add(tmpA.subVectors(body.p[RS]!, body.p[LS]!));
    if (out.lengthSq() < 1e-10) out.subVectors(body.p[BEL]!, body.p[PEL]!).cross(UP);
    return out.normalize();
  }

  /** Each limb's bend normal, carried on so it keeps its sign and survives the limb going straight. */
  function updateNormals(body: Body, side: Vector3, rate: number): void {
    for (const [limb, a, mid, b] of LIMB_JOINTS) {
      const u = tmpA.subVectors(body.p[mid]!, body.p[a]!), w = tmpB.subVectors(body.p[b]!, body.p[mid]!);
      const n = tmpC.crossVectors(u, w);
      const prev = body.normals[limb];
      if (n.lengthSq() > 0.03 * u.lengthSq() * w.lengthSq()) {
        n.normalize();
        if (n.dot(prev) < 0) n.negate();
        prev.lerp(n, rate).normalize();
      } else if (prev.lengthSq() < 1e-6) prev.copy(side);
    }
  }

  function partFrame(body: Body, part: PartName, side: Vector3, out: Matrix4): Matrix4 {
    const def = PARTS[part];
    const x = new Vector3().subVectors(body.p[def.to]!, body.p[def.origin]!);
    return frameOf(x, def.ref === 'side' ? side : body.normals[def.ref], out);
  }

  /** Which piece each particle is on, from the sticks still whole. */
  function components(body: Body): void {
    const parent = body.p.map((_, k) => k);
    const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k]!)));
    for (const s of body.sticks) if (!s.broken && Number.isFinite(s.max)) parent[find(s.a)] = find(s.b);
    body.comp = body.p.map((_, k) => find(k));
  }

  /** Every bone's world matrix, turned and placed from the particles. */
  function bonesWorld(body: Body): Matrix4[] {
    const side = torsoSide(body, new Vector3()).clone();
    updateNormals(body, side, 0.5);
    const turn: Partial<Record<PartName, Quaternion>> = {};
    const f = new Matrix4(), f0t = new Matrix4();
    for (const part of PART_NAMES) {
      partFrame(body, part, side, f);
      f0t.copy(body.frame0[part]).transpose();
      turn[part] = new Quaternion().setFromRotationMatrix(f.multiply(f0t));
    }
    // Each part placed from its parent part, at its rest distance turned
    // with the parent (forward kinematics, as retargeting keeps bone
    // lengths: only rotations reach the children), not at its own particle:
    // squeezed against a wall or a kerb the particles come closer than the
    // bones are long, and the skin between them was crushed or stretched.
    // A part on another piece (torn off) keeps its particle.
    const origin: Partial<Record<PartName, Vector3>> = {};
    for (const part of PART_NAMES) {
      const parent = PART_PARENT[part];
      const own = body.p[PARTS[part].origin]!;
      if (!parent || body.comp[PARTS[part].origin] !== body.comp[PARTS[parent].origin]) { origin[part] = own; continue; }
      origin[part] = tmpE.subVectors(body.origin0[part], body.origin0[parent]).applyQuaternion(turn[parent]!).add(origin[parent]!).clone();
    }
    const world: Matrix4[] = [];
    const pos = new Vector3(), q = new Quaternion();
    for (let i = 0; i < body.pos0.length; i++) {
      const part = body.bonePart[i]!;
      const r = turn[part]!;
      pos.subVectors(body.pos0[i]!, body.origin0[part]).applyQuaternion(r).add(origin[part]!);
      q.multiplyQuaternions(r, body.rot0[i]!);
      world.push(new Matrix4().compose(pos, q, body.scl0[i]!));
    }
    return world;
  }

  /** The skin matrices of the body (one palette per piece) from its bones' world matrices. */
  function palettes(body: Body, world: readonly Matrix4[]): Float32Array[] {
    const anchor = body.anchor.makeScale(body.scale, body.scale, body.scale).setPosition(body.p[PEL]!);
    // bind * local^-1 * anchor^-1: from the world back into a bone's matrix.
    const back = body.unbind.clone().multiply(anchor.clone().invert());
    const bones = body.pos0.length;
    const m4 = new Matrix4();
    const out: Float32Array[] = [];
    for (const piece of new Set(body.comp)) {
      const on = body.bonePart.map((part) => body.comp[PARTS[part].origin] === piece && !body.lostParts.has(part));
      if (!on.some(Boolean)) continue;
      const palette = new Float32Array(bones * 16);
      // The piece's own root: its topmost bone (the shoulder of an arm, the hip of a leg).
      let root = on.findIndex((own, i) => own && !(body.parents[i]! >= 0 && on[body.parents[i]!]));
      if (root < 0) root = 0;
      for (let i = 0; i < bones; i++) {
        if (on[i]) {
          m4.multiplyMatrices(back, world[i]!).multiply(body.inverses[i]!);
        } else {
          // Not on this piece: shrunk to the joint it was torn from - its
          // nearest ancestor still on the piece, or else the piece's root -
          // so the stump closes there.
          let j = body.parents[i]!;
          while (j >= 0 && !on[j]) j = body.parents[j]!;
          const t = tmpB.setFromMatrixPosition(world[j >= 0 ? j : root]!).applyMatrix4(back);
          m4.set(0, 0, 0, t.x, 0, 0, 0, t.y, 0, 0, 0, t.z, 0, 0, 0, 1);
        }
        m4.toArray(palette, i * 16);
      }
      out.push(palette);
    }
    return out;
  }
}

function inside(ring: readonly { x: number; y: number }[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

function nearestEdge(ring: readonly { x: number; y: number }[], x: number, y: number): { x: number; y: number } {
  let bx = x, by = y, bd = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!, b = ring[i]!;
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
    const px = a.x + dx * t, py = a.y + dy * t, d = (px - x) ** 2 + (py - y) ** 2;
    if (d < bd) { bd = d; bx = px; by = py; }
  }
  return { x: bx, y: by };
}
