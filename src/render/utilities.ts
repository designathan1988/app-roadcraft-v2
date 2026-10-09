import {
  BufferGeometry,
  CylinderGeometry,
  BoxGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Mesh,
  Vector3,
  DoubleSide,
  Material,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  CanvasTexture,
  SRGBColorSpace,
  RepeatWrapping,
} from 'three';

import type { Network } from '@world/network';
import { kerbward } from '@world/poleLines';
import { m } from '@world/units';
import { LAMP_BEAM_RADIUS, LAMP_POOL_RADIUS, type SceneryKit } from './scenery';
import { GROUND_ONLY, type RoadElevation } from '@world/elevation';
import { FOOTWAY_RISE } from '@world/roadTypes';
import {
  POLE_ARM_DROP,
  POLE_ARM_HALF,
  POLE_ARM_THICK,
  POLE_BASE_RADIUS,
  POLE_HEIGHT,
  POLE_LAMP_DROP,
  POLE_LAMP_LONG,
  POLE_LAMP_REACH,
  POLE_LAMP_TALL,
  POLE_LAMP_WIDE,
  POLE_TOP_RADIUS,
  WIRE_COURSES,
  WIRE_OFFSETS,
  poleArms,
  sampleWire,
} from '@world/utilities';
import { angleOf } from '@core/vec2';
import { applyWireWind } from './wind';

/** Pin insulator on the cross-arm. */
const INSULATOR_RADIUS = m(0.07);
const INSULATOR_TALL = m(0.2);
/** Arm braces: how far below the arm they meet the mast, and their section. */
const BRACE_DROP = m(0.55);
const BRACE_THICK = m(0.05);
/** Pole-top transformer can. */
const CAN_RADIUS = m(0.28);
/** Rise of the lamp bracket from the pole to the head. */
const LAMP_TILT = (8 * Math.PI) / 180;
/** How far a wire swings at mid-span in a full gust. */
const WIRE_SWING = m(0.35);
/** Half-width of a drawn cable: thicker than life so it reads at play zoom. */
const WIRE_RADIUS = m(0.035);
import type { PoleId, SpanId } from '@world/ids';
import type { UtilityPole, UtilitySpan } from '@world/utilities';

/**
 * The overhead utility network on screen: poles, cross-arms, wires and lamps.
 *
 * Built exactly like every other derived structure — inside `rebuildWorld`,
 * behind the revision gate, never in a draw call. The poles and arms are
 * instanced because there are many identical ones; the wires are a single
 * `LineSegments` because a wire is one pixel wide at every zoom this game is
 * played at, and giving each one a tube would spend thousands of triangles on
 * something that reads as a line either way.
 *
 * The sag is what sells it. A straight segment between two poles reads as a
 * stick; the same span with a metre of droop reads as a cable. See
 * `world/utilities.ts` for why the curve is a quadratic and not a `cosh`.
 */

export interface Utilities {
  readonly group: Group;
  readonly triangles: number;
  dispose(): void;
}

interface Placement {
  x: number;
  y: number;
  /** Height above the ground, in world units. */
  z: number;
  yaw: number;
  /** Tilt of the part's local X axis up from level, radians (a brace, a lamp bracket). */
  roll?: number;
  sx: number;
  sy: number;
  sz: number;
}

function instanced(
  name: string,
  geometry: BufferGeometry,
  material: Material,
  placements: readonly Placement[],
): InstancedMesh | null {
  if (placements.length === 0) return null;
  const mesh = new InstancedMesh(geometry, material, placements.length);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const object = new Object3D();
  placements.forEach((placement, index) => {
    // World y is mirrored into three's z, as everywhere else in this layer.
    object.position.set(placement.x, placement.z, -placement.y);
    object.rotation.set(0, placement.yaw, placement.roll ?? 0);
    object.scale.set(placement.sx, placement.sy, placement.sz);
    object.updateMatrix();
    mesh.setMatrixAt(index, object.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

/**
 * What a pole layer is built from: the document's poles and spans, or a
 * planned run (`buildPolePreview`). `draws` says which poles get a mast, arms
 * and lamp of their own here; a pole a preview only ties into is already
 * standing in the built layer.
 */
export interface PoleSource {
  readonly poles: ReadonlyMap<PoleId, UtilityPole>;
  readonly spans: ReadonlyMap<SpanId, UtilitySpan>;
  readonly draws?: (pole: UtilityPole) => boolean;
}

export function buildUtilities(
  net: Network,
  groundAt: (x: number, y: number) => number,
  kit: SceneryKit,
  source: PoleSource = { poles: net.doc.poles, spans: net.doc.poleSpans },
  name = 'utilities',
): Utilities {
  const { poles, spans } = source;
  const draws = source.draws ?? (() => true);
  const group = new Group();
  group.name = name;

  const masts: Placement[] = [];
  const arms: Placement[] = [];
  const lampArms: Placement[] = [];
  const insulators: Placement[] = [];
  const braces: Placement[] = [];
  const caps: Placement[] = [];
  const cans: Placement[] = [];
  const lampHeads: Placement[] = [];
  const lenses: Placement[] = [];
  const pools: Placement[] = [];
  const beams: Placement[] = [];
  const wirePoints: number[] = [];
  /** Per wire vertex: weight along its span (0 at the poles), and the span's phase. */
  const wireSwing: number[] = [];
  const wirePhase: number[] = [];

  /** Crown height of each pole, so the wires and the arms agree on it. */
  const crown = new Map<number, number>();

  for (const pole of poles.values()) {
    const base = groundAt(pole.x, pole.y);
    crown.set(pole.id, base + POLE_HEIGHT);
    if (!draws(pole)) continue;

    masts.push({
      x: pole.x,
      y: pole.y,
      z: base + POLE_HEIGHT / 2,
      yaw: 0,
      sx: 1,
      sy: 1,
      sz: 1,
    });
    // A pole cap: the weathering cap on the crown of a timber pole.
    caps.push({ x: pole.x, y: pole.y, z: base + POLE_HEIGHT + m(0.03), yaw: 0, sx: 1, sy: 1, sz: 1 });
  }

  /**
   * Towards the carriageway from a pole: the nearest kerb, or null off the
   * streets. Read from the kerb itself rather than from the street the
   * footway belongs to: a corner's footway belongs to no one street, and a
   * corner pole used to fall back to its cross-arm and light the block.
   */
  const roadward = (x: number, y: number): { x: number; y: number } | null => kerbward(net, { x, y }, m(6));
  // The arms, framed as a line crew frames them (`poleArms`): square to a
  // straight line, on the bisector of a bend, one per line at a corner. A
  // pole with no wire yet stands square to its street.
  const framing = poleArms(poles, spans, (pole) => roadward(pole.x, pole.y) ?? { x: 0, y: 1 });

  for (const pole of poles.values()) {
    const top = crown.get(pole.id);
    if (top === undefined || !draws(pole)) continue;
    const frame = framing.get(pole.id);

    // An instanced box is scaled on its LOCAL X and then rotated about Y, so
    // the length goes on sx and the yaw is the direction that length points
    // in. Putting the length on sz instead - which is what this did - turns
    // every arm ninety degrees, and a row of poles comes out looking twisted.
    for (const arm of frame?.arms ?? []) {
      const armZ = top - POLE_ARM_DROP;
      arms.push({
        x: pole.x,
        y: pole.y,
        z: armZ,
        yaw: angleOf(arm),
        sx: POLE_ARM_HALF * 2,
        sy: POLE_ARM_THICK,
        sz: POLE_ARM_THICK,
      });
      // Pin insulators on the arm, one under each wire of the top course.
      for (const offset of WIRE_OFFSETS) {
        insulators.push({
          x: pole.x + arm.x * POLE_ARM_HALF * offset,
          y: pole.y + arm.y * POLE_ARM_HALF * offset,
          z: armZ + POLE_ARM_THICK / 2 + INSULATOR_TALL / 2,
          yaw: 0, sx: 1, sy: 1, sz: 1,
        });
      }
      // Two flat braces from the mast up to the arm, one each side.
      for (const side of [1, -1]) {
        const reach = POLE_ARM_HALF * 0.6;
        const drop = BRACE_DROP;
        braces.push({
          x: pole.x + arm.x * side * reach / 2,
          y: pole.y + arm.y * side * reach / 2,
          z: armZ - drop / 2,
          yaw: angleOf({ x: arm.x * side, y: arm.y * side }),
          roll: Math.atan2(drop, reach),
          sx: Math.hypot(reach, drop),
          sy: BRACE_THICK,
          sz: BRACE_THICK * 0.5,
        });
      }
    }
    // A pole-top transformer on some poles, hung on the side away from the street.
    if (pole.id % 5 === 3) {
      const away = roadward(pole.x, pole.y) ?? frame?.arms[0] ?? { x: 0, y: 1 };
      cans.push({
        x: pole.x - away.x * (POLE_BASE_RADIUS + CAN_RADIUS),
        y: pole.y - away.y * (POLE_BASE_RADIUS + CAN_RADIUS),
        z: top - POLE_ARM_DROP - m(1.6),
        yaw: 0, sx: 1, sy: 1, sz: 1,
      });
    }

    if (!pole.lamp) continue;
    // The light reaches out over the street, square to the kerb, whichever
    // way the wires run; off the streets, along the first arm.
    const reach = roadward(pole.x, pole.y) ?? frame?.arms[0] ?? { x: 0, y: 1 };
    const reachYaw = angleOf(reach);
    const headX = pole.x + reach.x * POLE_LAMP_REACH;
    const headY = pole.y + reach.y * POLE_LAMP_REACH;
    const headZ = top - POLE_LAMP_DROP;
    lampArms.push({
      x: pole.x + reach.x * (POLE_LAMP_REACH / 2),
      y: pole.y + reach.y * (POLE_LAMP_REACH / 2),
      z: headZ - Math.tan(LAMP_TILT) * POLE_LAMP_REACH / 2,
      yaw: reachYaw,
      // The bracket rises gently from the pole to the head, as a davit does.
      roll: LAMP_TILT,
      sx: POLE_LAMP_REACH / Math.cos(LAMP_TILT),
      sy: POLE_ARM_THICK * 0.8,
      sz: POLE_ARM_THICK * 0.8,
    });
    lampHeads.push({
      x: headX,
      y: headY,
      z: headZ - POLE_LAMP_TALL / 2,
      yaw: reachYaw,
      sx: POLE_LAMP_LONG,
      sy: POLE_LAMP_TALL,
      sz: POLE_LAMP_WIDE,
    });
    // The lens under the head and the pool of light on the street, lit with
    // the street lights' own materials, so they come on at dusk with them.
    const lensZ = headZ - POLE_LAMP_TALL - 0.01;
    const below = groundAt(headX, headY);
    lenses.push({ x: headX, y: headY, z: lensZ, yaw: reachYaw, sx: POLE_LAMP_LONG * 0.8, sy: 1, sz: POLE_LAMP_WIDE * 0.8 });
    pools.push({ x: headX, y: headY, z: below + 0.03, yaw: 0, sx: LAMP_POOL_RADIUS, sy: 1, sz: LAMP_POOL_RADIUS });
    // And the cone of light between them.
    beams.push({ x: headX, y: headY, z: lensZ, yaw: 0, sx: LAMP_BEAM_RADIUS, sy: Math.max(0.01, lensZ - below), sz: LAMP_BEAM_RADIUS });
  }

  // ------------------------------------------------------------------ wires
  for (const span of spans.values()) {
    const a = poles.get(span.a);
    const b = poles.get(span.b);
    if (!a || !b) continue;
    const topA = crown.get(a.id);
    const topB = crown.get(b.id);
    if (topA === undefined || topB === undefined) continue;

    // Each wire leaves its own insulator on the arm the span hangs from. Both
    // ends' arms are turned to the left of the span, so the wire at offset k
    // on one pole meets the wire at offset k on the next and none cross over.
    const armA = framing.get(a.id)?.bySpan.get(span.id) ?? { x: 0, y: 1 };
    const armB = framing.get(b.id)?.bySpan.get(span.id) ?? { x: 0, y: 1 };

    for (const course of WIRE_COURSES) {
      for (const offset of WIRE_OFFSETS) {
        const ax = a.x + armA.x * POLE_ARM_HALF * offset;
        const ay = a.y + armA.y * POLE_ARM_HALF * offset;
        const bx = b.x + armB.x * POLE_ARM_HALF * offset;
        const by = b.y + armB.y * POLE_ARM_HALF * offset;
        const az = topA - POLE_ARM_DROP + course;
        const bz = topB - POLE_ARM_DROP + course;

        const points = sampleWire(ax, ay, az, bx, by, bz);
        const phase = (span.id * 2.399) % (Math.PI * 2);
        const last = points.length - 1;
        for (let i = 0; i + 1 < points.length; i++) {
          const p = points[i];
          const q = points[i + 1];
          if (!p || !q) continue;
          wirePoints.push(p.x, p.z, -p.y, q.x, q.z, -q.y);
          const t0 = i / last, t1 = (i + 1) / last;
          wireSwing.push(4 * t0 * (1 - t0), 4 * t1 * (1 - t1));
          wirePhase.push(phase, phase);
        }
      }
    }
  }

  const metal = new MeshStandardMaterial({
    color: 0x4a4a46,
    roughness: 0.68,
    metalness: 0.35,
  });
  // Creosoted timber: a grain of long streaks up the pole, a few knots and
  // checks, painted once on a canvas and wrapped round the mast.
  const timber = new MeshStandardMaterial({
    color: 0xffffff,
    map: woodTexture(),
    roughness: 0.92,
    metalness: 0,
  });
  // The luminaire as seen from above: its housing. The head used to be a box
  // in the unlit glow, which from the isometric camera was a bright white
  // mark hanging over the carriageway, read as a stray editor marker.
  const housing = new MeshStandardMaterial({ color: 0xa9b0ad, roughness: 0.5, metalness: 0.3 });
  // A wire is thinner than a pixel at any play zoom. Drawn solid near-black
  // it broke up into a dotted trace across the footway under it, which read
  // as a debug path left on screen; a faint line reads as a wire.
  const wireMaterial = new MeshStandardMaterial({ color: 0x1e2224, roughness: 0.55, metalness: 0.3, side: DoubleSide });
  applyWireWind(wireMaterial, WIRE_SWING);

  const mastGeometry = new CylinderGeometry(
    POLE_TOP_RADIUS,
    POLE_BASE_RADIUS,
    POLE_HEIGHT,
    12,
  );
  const capGeometry = new CylinderGeometry(POLE_TOP_RADIUS * 0.4, POLE_TOP_RADIUS * 1.15, m(0.08), 10);
  // A pin insulator: a glazed porcelain bell on a short pin.
  const insulatorGeometry = new CylinderGeometry(INSULATOR_RADIUS * 0.55, INSULATOR_RADIUS, INSULATOR_TALL, 10);
  const canGeometry = new CylinderGeometry(CAN_RADIUS, CAN_RADIUS, m(0.95), 14);
  const porcelain = new MeshStandardMaterial({ color: 0xd8dcd6, roughness: 0.25, metalness: 0 });
  const steel = new MeshStandardMaterial({ color: 0x8c9590, roughness: 0.45, metalness: 0.55 });
  const boxGeometry = new BoxGeometry(1, 1, 1);
  // One face, looking down: a lens only shines down (see `lampLensGeometry`).
  const lensGeometry = new PlaneGeometry(1, 1).rotateX(Math.PI / 2);

  const meshes = [
    instanced('utility-poles', mastGeometry, timber, masts),
    instanced('utility-arms', boxGeometry, timber, arms),
    instanced('utility-caps', capGeometry, steel, caps),
    instanced('utility-braces', boxGeometry, steel, braces),
    instanced('utility-insulators', insulatorGeometry, porcelain, insulators),
    instanced('utility-transformers', canGeometry, steel, cans),
    instanced('utility-lamp-arms', boxGeometry, metal, lampArms),
    instanced('utility-lamp-heads', boxGeometry, housing, lampHeads),
    instanced('utility-lamp-lenses', lensGeometry, kit.glow, lenses),
    instanced('utility-lamp-pools', kit.pool, kit.poolGlow, pools),
    instanced('utility-lamp-beams', kit.beam, kit.beamGlow, beams),
  ].filter((mesh): mesh is InstancedMesh => mesh !== null);

  for (const mesh of meshes) {
    if (mesh.name === 'utility-lamp-lenses' || mesh.name === 'utility-lamp-pools' || mesh.name === 'utility-lamp-beams') mesh.castShadow = false;
    if (mesh.name === 'utility-lamp-pools') { mesh.receiveShadow = false; mesh.renderOrder = 3; }
    if (mesh.name === 'utility-lamp-beams') { mesh.receiveShadow = false; mesh.renderOrder = 4; }
  }
  let triangles = 0;
  for (const mesh of meshes) {
    group.add(mesh);
    const index = mesh.geometry.index;
    const position = mesh.geometry.getAttribute('position');
    const perInstance = (index ? index.count : position.count) / 3;
    triangles += perInstance * mesh.count;
  }

  let wires: Mesh | null = null;
  if (wirePoints.length) {
    // Each wire segment as a thin square tube, so a cable has a real width
    // on screen (a line is one pixel whatever the zoom; the player found the
    // wires too thin to read).
    const pos: number[] = [], nor: number[] = [], swing: number[] = [], phase: number[] = [];
    const a = new Vector3(), b2 = new Vector3(), d = new Vector3(), u = new Vector3(), w = new Vector3(), up = new Vector3(0, 1, 0);
    for (let i = 0; i < wirePoints.length; i += 6) {
      a.set(wirePoints[i]!, wirePoints[i + 1]!, wirePoints[i + 2]!);
      b2.set(wirePoints[i + 3]!, wirePoints[i + 4]!, wirePoints[i + 5]!);
      d.copy(b2).sub(a).normalize();
      u.crossVectors(d, up).normalize().multiplyScalar(WIRE_RADIUS);
      w.crossVectors(u, d).normalize().multiplyScalar(WIRE_RADIUS);
      const sa = wireSwing[i / 3]!, sb = wireSwing[i / 3 + 1]!, ph = wirePhase[i / 3]!;
      const corners = [u.clone(), w.clone(), u.clone().negate(), w.clone().negate()];
      for (let k = 0; k < 4; k++) {
        const c0 = corners[k]!, c1 = corners[(k + 1) % 4]!;
        const n = c0.clone().add(c1).normalize();
        const quad = [[a, c0, sa], [b2, c0, sb], [b2, c1, sb], [a, c0, sa], [b2, c1, sb], [a, c1, sa]] as const;
        for (const [p0, c, sw] of quad) {
          pos.push(p0.x + c.x, p0.y + c.y, p0.z + c.z);
          nor.push(n.x, n.y, n.z);
          swing.push(sw);
          phase.push(ph);
        }
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(nor, 3));
    geometry.setAttribute('aSwing', new Float32BufferAttribute(swing, 1));
    geometry.setAttribute('aPhase', new Float32BufferAttribute(phase, 1));
    geometry.computeBoundingSphere();
    wires = new Mesh(geometry, wireMaterial);
    wires.castShadow = true;
    wires.name = 'utility-wires';
    group.add(wires);
  }

  return {
    group,
    triangles,
    dispose() {
      for (const mesh of meshes) mesh.dispose();
      if (wires) wires.geometry.dispose();
      mastGeometry.dispose();
      capGeometry.dispose();
      insulatorGeometry.dispose();
      canGeometry.dispose();
      porcelain.dispose();
      steel.dispose();
      boxGeometry.dispose();
      lensGeometry.dispose();
      metal.dispose();
      timber.dispose();
      housing.dispose();
      wireMaterial.dispose();
      group.clear();
    },
  };
}

/**
 * Ground a pole stands on: the footway where there is one, the terrain where
 * there is not.
 *
 * A pole beside a street is installed ON the pavement, and the pavement is a
 * kerb height above the carriageway. The terrain is shaped to meet the road,
 * so reading the bare terrain put every pole a kerb-height BELOW the surface
 * it is standing on - which is the "poles do not sit on the footway" defect.
 *
 * Only the ground level is considered. A pole must not climb onto a viaduct
 * passing overhead, and `GROUND_ONLY` is the same filter every other
 * ground-level pass uses.
 */
export function poleGroundAt(
  elevation: RoadElevation,
  terrainAt: (x: number, y: number) => number,
): (x: number, y: number) => number {
  return (x, y) => {
    const road = elevation.roadAt(x, y, GROUND_ONLY);
    // `half` is the CASING half-width, which runs a little past the footway.
    // A pole out on the casing margin is on the verge, not the pavement.
    const onFootway = road.type >= 0 && Math.abs(road.across) <= road.half;
    if (!onFootway) return terrainAt(x, y);
    return elevation.at(x, y, GROUND_ONLY) + FOOTWAY_RISE;
  };
}

/** A planned pole run, as the editor would build it: in order, each pole new or already standing. */
export interface PolePreviewInput {
  readonly poles: readonly { readonly x: number; readonly y: number; readonly lamp: boolean; readonly standing: boolean }[];
}

/**
 * The run under the pointer, drawn as it will stand: masts, cross-arms framed
 * as built, lamps and the sagging wires, from the same builder as the built
 * layer. A pole the run only ties into is standing already and is not drawn
 * twice; the wires to it are.
 */
export function buildPolePreview(
  net: Network,
  groundAt: (x: number, y: number) => number,
  kit: SceneryKit,
  input: PolePreviewInput,
): Utilities {
  const poles = new Map<PoleId, UtilityPole>();
  const spans = new Map<SpanId, UtilitySpan>();
  const standing = new Set<PoleId>();
  input.poles.forEach((pole, index) => {
    const id = (index + 1) as PoleId;
    poles.set(id, { id, x: pole.x, y: pole.y, lamp: pole.lamp });
    if (pole.standing) standing.add(id);
    if (index > 0) spans.set(index as SpanId, { id: index as SpanId, a: index as PoleId, b: id });
  });
  return buildUtilities(net, groundAt, kit, { poles, spans, draws: (pole) => !standing.has(pole.id) }, 'utility-preview');
}

let woodCache: CanvasTexture | null = null;
/** The wood of a pole: dark brown, long grain, knots and drying cracks. Shared. */
function woodTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  if (woodCache) return woodCache;
  const W = 128, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#4e3b2a';
  g.fillRect(0, 0, W, H);
  let seed = 7;
  const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  // Grain: thin streaks of lighter and darker wood running up the pole.
  for (let i = 0; i < 260; i++) {
    const x = rnd() * W, light = rnd() < 0.5;
    g.strokeStyle = light ? `rgba(120, 92, 64, ${0.15 + rnd() * 0.25})` : `rgba(30, 20, 12, ${0.15 + rnd() * 0.3})`;
    g.lineWidth = 0.5 + rnd() * 1.5;
    g.beginPath();
    let px = x;
    g.moveTo(px, 0);
    for (let y = 0; y <= H; y += 16) { px += (rnd() - 0.5) * 1.5; g.lineTo(px, y); }
    g.stroke();
  }
  // Knots and checks.
  for (let i = 0; i < 6; i++) {
    const x = rnd() * W, y = rnd() * H, r = 3 + rnd() * 5;
    const grad = g.createRadialGradient(x, y, 0, x, y, r * 2);
    grad.addColorStop(0, 'rgba(25, 15, 8, 0.85)');
    grad.addColorStop(1, 'rgba(25, 15, 8, 0)');
    g.fillStyle = grad;
    g.beginPath(); g.ellipse(x, y, r, r * 2.2, 0, 0, Math.PI * 2); g.fill();
  }
  for (let i = 0; i < 10; i++) {
    const x = rnd() * W, y = rnd() * H, len = 30 + rnd() * 90;
    g.strokeStyle = 'rgba(15, 10, 6, 0.7)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 3, y + len); g.stroke();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(1, 2);
  woodCache = t;
  return t;
}
