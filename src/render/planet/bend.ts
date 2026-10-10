import { FACES, FACE_HALF, PLANET_RADIUS, type Vec3 } from '@core/cubeSphere';
import { TILES, TILES_PER_SIDE, onTile, sphereToTileInto, tileOfDirection, tileToSphereInto } from '@core/planetTiles';
import { ATLAS_COLUMNS, ATLAS_PITCH, atlasToTileInto, tileCentre, type TileLocal } from '@world/planet/atlas';
import { planetLocalMinutes as localMinutesAt, planetSunInto } from '@world/planet/sun';
import { Frustum, Matrix4, ShaderChunk, ShaderLib, Sphere, Vector3, type Object3D, type Ray, type Scene } from 'three';

/**
 * THE PLANET, DRAWN: every point of the world (the atlas of the planet's
 * pieces, `world/planet/atlas.ts`) is carried in the vertex shader to its
 * point on the sphere (`core/planetTiles.ts`: each piece's own azimuthal
 * equidistant map, true to within a degree and 1.3%), its height becoming
 * height over the sphere - the flat geometry bent onto the planet as
 * Planetary Annihilation bends its brushes (Allen Chou, "Bending Solid
 * Geometry in Planetary Annihilation", 2013). Nothing is built bent: the
 * world, its meshes and the simulation stay flat, and only the picture is
 * folded, in three's own vertex chunks (`project_vertex`, `worldpos_vertex`,
 * `defaultnormal_vertex`), so every built-in material and its shadow pass
 * draw the same planet.
 *
 * The planet is then set down by ONE rigid motion, `planetT`, chosen each
 * frame so the point the view looks at stands where it stands on the flat
 * map, its up the world's up (a floating origin, as planet engines keep the
 * camera near the origin): about that point the picture is the flat map's,
 * and the camera, the sun, the shadows and the passes after work unchanged.
 * Pulled back, the rest of the planet curves away below it, whole.
 *
 * Three's axes: x east, y up, z = -(map y).
 */

/** The shared uniforms: on (1) or off, and the rigid motion setting the planet down. */
const PLANET_ON = { value: 0 };
/**
 * The motion as three reads it, column-major. A typed array, not three's
 * Matrix4: `cloneUniforms` copies three's own types into each material, and
 * this must stay ONE array every material reads.
 */
const PLANET_T = { value: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
/** The same motion, for the CPU. */
const motion = new Matrix4();
/** The motion's inverse, for picks. */
const inverseT = new Matrix4();

const v3 = (v: Readonly<Vec3>): string => `vec3(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`;

/** The GLSL the chunks use: a world point to the planet, and a direction turned with it. */
export const PLANET_GLSL = /* glsl */ `
uniform float planetOn;
uniform mat4 planetT;
const float PLANET_R = ${PLANET_RADIUS.toFixed(4)};
const float PLANET_PITCH = ${ATLAS_PITCH.toFixed(1)};
const float PLANET_COLS = ${ATLAS_COLUMNS.toFixed(1)};
const float PLANET_ROWS = ${(TILES.length / ATLAS_COLUMNS).toFixed(1)};
const float PLANET_COLS_HALF = ${(ATLAS_COLUMNS / 2).toFixed(1)};
const float PLANET_ROWS_HALF = ${(TILES.length / ATLAS_COLUMNS / 2).toFixed(1)};
const float PLANET_HALF = ${FACE_HALF.toFixed(1)};
const float PLANET_STEP = ${((2 * FACE_HALF) / TILES_PER_SIDE).toFixed(1)};
const float PLANET_ANGLE = ${(Math.PI / 4 / FACE_HALF).toExponential(8)};
const vec3 PLANET_C[6] = vec3[6](${FACES.map((f) => v3(f.centre)).join(', ')});
const vec3 PLANET_E[6] = vec3[6](${FACES.map((f) => v3(f.east)).join(', ')});
const vec3 PLANET_N[6] = vec3[6](${FACES.map((f) => v3(f.north)).join(', ')});
// The piece whose cell of the atlas holds a world point, and the point on its map.
int planetTile(vec3 p, out vec2 local) {
  vec2 a = vec2(p.x, -p.z);
  float col = clamp(floor(a.x / PLANET_PITCH + 0.5) + PLANET_COLS_HALF, 0.0, PLANET_COLS - 1.0);
  float row = clamp(floor(a.y / PLANET_PITCH + 0.5) + PLANET_ROWS_HALF, 0.0, PLANET_ROWS - 1.0);
  local = a - vec2((col - PLANET_COLS_HALF) * PLANET_PITCH, (row - PLANET_ROWS_HALF) * PLANET_PITCH);
  return int(row * PLANET_COLS + col);
}
// A piece's centre on the sphere and its east and north there (core/planetTiles.ts TILES).
void planetTileFrame(int t, out vec3 c, out vec3 e, out vec3 n) {
  int f = t / ${TILES_PER_SIDE * TILES_PER_SIDE};
  int k = t - f * ${TILES_PER_SIDE * TILES_PER_SIDE};
  vec2 ij = vec2(float(k - (k / ${TILES_PER_SIDE}) * ${TILES_PER_SIDE}), float(k / ${TILES_PER_SIDE}));
  vec2 m = tan((-PLANET_HALF + (ij + 0.5) * PLANET_STEP) * PLANET_ANGLE);
  c = normalize(PLANET_C[f] + m.x * PLANET_E[f] + m.y * PLANET_N[f]);
  e = normalize(PLANET_E[f] - dot(PLANET_E[f], c) * c);
  n = cross(c, e);
}
// The unit direction from the planet's centre of a world point (its piece's
// azimuthal equidistant map), and that piece's east and north at its centre.
vec3 planetDirection(vec3 p, out vec3 e, out vec3 n) {
  vec2 l;
  int t = planetTile(p, l);
  vec3 c;
  planetTileFrame(t, c, e, n);
  float r = length(l);
  if (r < 1e-4) return c;
  float th = r / PLANET_R;
  return cos(th) * c + (sin(th) / r) * (l.x * e + l.y * n);
}
vec3 planetPoint(vec3 p) {
  if (planetOn < 0.5) return p;
  vec3 e, n;
  vec3 s = planetDirection(p, e, n);
  return (planetT * vec4(s * (PLANET_R + p.y), 1.0)).xyz;
}
// A direction of the flat world at a point, as the planet turns it there.
vec3 planetTurn(vec3 v, vec3 at) {
  if (planetOn < 0.5) return v;
  vec3 e0, n0;
  vec3 s = planetDirection(at, e0, n0);
  vec3 e = normalize(e0 - dot(e0, s) * s);
  vec3 n = cross(s, e);
  return mat3(planetT) * (v.x * e + v.y * s - v.z * n);
}
// Whether a world point of a piece's cell lies on that piece itself, give or
// take \`margin\` units over its border: each piece's ground draws only its
// own part of the sphere, the margin closing the hairline between two.
bool planetOwns(vec3 p, float tile, float margin) {
  vec3 e, n;
  vec3 d = planetDirection(p, e, n);
  int t = int(tile + 0.5);
  int f = t / ${TILES_PER_SIDE * TILES_PER_SIDE};
  int k = t - f * ${TILES_PER_SIDE * TILES_PER_SIDE};
  vec2 ij = vec2(float(k - (k / ${TILES_PER_SIDE}) * ${TILES_PER_SIDE}), float(k / ${TILES_PER_SIDE}));
  float along = dot(d, PLANET_C[f]);
  if (along <= 0.0) return false;
  vec2 q = atan(vec2(dot(d, PLANET_E[f]), dot(d, PLANET_N[f])) / along) / PLANET_ANGLE;
  vec2 lo = -PLANET_HALF + ij * PLANET_STEP - margin;
  vec2 hi = lo + PLANET_STEP + 2.0 * margin;
  return all(greaterThanEqual(q, lo)) && all(lessThanEqual(q, hi));
}
// How much of a directional light reaches a view-space point: none past the
// planet's own horizon there. The shadow map covers the ground round the view
// only; out at the globe nothing else stood between the sun and the night
// side, and the leaves' two-sided cards (the back face's normal turned to the
// light) lit every tree on it.
float planetDaylight(vec3 viewPos, vec3 lightDirView) {
  if (planetOn < 0.5) return 1.0;
  vec3 centre = (viewMatrix * vec4(planetT[3].xyz, 1.0)).xyz;
  return smoothstep(-0.04, 0.06, dot(normalize(viewPos - centre), lightDirView));
}
// A view-space point of the flat world to its view-space point on the planet.
vec4 planetView(vec4 mv) {
  if (planetOn < 0.5) return mv;
  mat3 r = mat3(viewMatrix);
  vec3 world = transpose(r) * (mv.xyz - viewMatrix[3].xyz);
  return vec4(r * planetPoint(world) + viewMatrix[3].xyz, mv.w);
}
`;

let installed = false;

/**
 * Wraps three's vertex chunks round the planet, gives every built-in shader
 * the shared uniforms, and teaches three's culling where things are drawn.
 * Before any program is built; once.
 */
export function installPlanet(): void {
  if (installed) return;
  installed = true;
  PLANET_ON.value = 1;
  const chunks = ShaderChunk as unknown as Record<string, string>;
  chunks['common'] = `${chunks['common']}\n${PLANET_GLSL}\n`;
  // After three's own line, so what other materials add before it (the
  // wind, `wind.ts`) is carried round the planet too.
  chunks['project_vertex'] = (chunks['project_vertex'] as string).replace(
    'gl_Position = projectionMatrix * mvPosition;',
    `#ifndef PLANET_SKIP
       mvPosition = planetView( mvPosition );
     #endif
     gl_Position = projectionMatrix * mvPosition;`,
  );
  chunks['worldpos_vertex'] = (chunks['worldpos_vertex'] as string).replace(
    'worldPosition = modelMatrix * worldPosition;',
    `worldPosition = modelMatrix * worldPosition;
     #ifndef PLANET_SKIP
       worldPosition.xyz = planetPoint( worldPosition.xyz );
     #endif`,
  );
  chunks['defaultnormal_vertex'] = `${chunks['defaultnormal_vertex'] as string}
     #ifndef PLANET_SKIP
     if ( planetOn > 0.5 ) {
       vec4 planetAt = vec4( position, 1.0 );
       #ifdef USE_INSTANCING
         planetAt = instanceMatrix * planetAt;
       #endif
       planetAt = modelMatrix * planetAt;
       mat3 planetV = mat3( viewMatrix );
       transformedNormal = planetV * planetTurn( transpose( planetV ) * transformedNormal, planetAt.xyz );
       #ifdef USE_TANGENT
         transformedTangent = planetV * planetTurn( transpose( planetV ) * transformedTangent, planetAt.xyz );
       #endif
     }
     #endif
`;
  // The planet shades its own night side from every directional light.
  chunks['lights_fragment_begin'] = (chunks['lights_fragment_begin'] as string).replace(
    'getDirectionalLightInfo( directionalLight, directLight );',
    `getDirectionalLightInfo( directionalLight, directLight );
     directLight.color *= planetDaylight( geometryPosition, directLight.direction );`,
  );
  for (const shader of Object.values(ShaderLib)) {
    shader.uniforms['planetOn'] = PLANET_ON;
    shader.uniforms['planetT'] = PLANET_T;
  }

  // Culling where the planet draws a thing: its bounding sphere's centre
  // carried there, the sphere a little wider (a piece's map is true to 1.3%).
  const object = Frustum.prototype.intersectsObject;
  const sphere = new Sphere();
  const bent = (s: Sphere): Sphere => {
    planetPointInto(s.center.x, s.center.y, s.center.z, s.center);
    s.radius = s.radius * 1.05 + 4;
    return s;
  };
  Frustum.prototype.intersectsObject = function (this: Frustum, target: Object3D): boolean {
    // Only while the world is drawn (`planetScene`): a full-screen pass's quad
    // carried round the planet is culled, and the picture came out black.
    if (!drawingWorld || target.userData['planetSkip']) return object.call(this, target);
    const own = target as Object3D & { boundingSphere?: Sphere | null; computeBoundingSphere?: () => void };
    const geometry = (target as Object3D & { geometry?: { boundingSphere: Sphere | null; computeBoundingSphere(): void } }).geometry;
    if (own.boundingSphere !== undefined) {
      if (own.boundingSphere === null) own.computeBoundingSphere?.();
      if (!own.boundingSphere) return object.call(this, target);
      sphere.copy(own.boundingSphere).applyMatrix4(target.matrixWorld);
    } else if (geometry) {
      if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
      if (!geometry.boundingSphere) return object.call(this, target);
      sphere.copy(geometry.boundingSphere).applyMatrix4(target.matrixWorld);
    } else {
      return object.call(this, target);
    }
    return this.intersectsSphere(bent(sphere)) && !beyondHorizon(sphere);
  };
}

/** The eye the world is drawn from this frame (`planetEye`): what lies past its horizon is not drawn. */
const eye = new Vector3();
let eyeKnown = false;
const occluder = new Vector3();
const cv = new Vector3();
const vt = new Vector3();
/** How far the ground may lie under the sphere (valleys, cuttings, water beds), world units. */
const HORIZON_SLACK = 200;

/** Sets the eye the next frame is drawn from (three's space). */
export function planetEye(at: Vector3): void {
  eye.copy(at);
  eyeKnown = true;
}

/**
 * Whether a sphere (as the planet draws it) lies wholly past the planet's
 * horizon from the eye: Cesium's horizon culling (Kevin Ring, "Horizon
 * Culling", 2013 - a point is hidden when it is behind the plane of the
 * horizon circle AND inside the cone of the eye's tangents), for the
 * sphere's centre against the planet shrunk by the sphere's radius and by
 * the deepest ground can go (`HORIZON_SLACK`), so nothing that shows is
 * ever left out. At the globe half the planet's plates, and their shadows,
 * were drawn behind it.
 */
function beyondHorizon(s: Sphere): boolean {
  if (!eyeKnown) return false;
  const r = PLANET_RADIUS - HORIZON_SLACK - s.radius;
  if (r <= 0) return false;
  planetCentre(occluder);
  cv.subVectors(eye, occluder).divideScalar(r);
  const vh2 = cv.lengthSq() - 1;
  if (vh2 <= 0) return false;
  vt.subVectors(s.center, occluder).divideScalar(r).sub(cv);
  const vtDotVc = -vt.dot(cv);
  return vtDotVc > vh2 && (vtDotVc * vtDotVc) / vt.lengthSq() > vh2;
}

/** Whether the world's scene is being drawn (its shadows with it): only then is culling done on the planet. */
let drawingWorld = false;

/** Marks the world's scene, so culling on the planet applies while it, and only it, is drawn. */
export function planetScene(scene: Scene): void {
  const before = scene.onBeforeRender.bind(scene);
  const after = scene.onAfterRender.bind(scene);
  scene.onBeforeRender = (...args) => { drawingWorld = true; before(...args); };
  scene.onAfterRender = (...args) => { after(...args); drawingWorld = false; };
}

/** GLSL and uniforms for a hand-written vertex shader that must sit on the planet too. */
export const PLANET_SHADER = { glsl: PLANET_GLSL, on: PLANET_ON, t: PLANET_T };

const local: TileLocal = { tile: 0, x: 0, y: 0 };
const dir: Vec3 = { x: 0, y: 0, z: 0 };
const tmp = new Vector3();

/** A world point (three's x, height y, z) on the planet as drawn, into `out`. */
export function planetPointInto(x: number, y: number, z: number, out: Vector3): Vector3 {
  if (PLANET_ON.value < 0.5) return out.set(x, y, z);
  atlasToTileInto(x, -z, local);
  tileToSphereInto(local.tile, local.x, local.y, dir);
  const r = PLANET_RADIUS + y;
  return out.set(dir.x * r, dir.y * r, dir.z * r).applyMatrix4(motion);
}

/** The anchor `planetT` sets down where it stands on the flat map: the point looked at. */
const anchor = new Vector3();
const east = new Vector3();
const up = new Vector3();
const north = new Vector3();

/**
 * Sets the planet down so the world point (three's x, z) the view looks at
 * stands at its own place on the flat map, at height 0, with its up the
 * world's: about it, the planet is drawn as the flat map is.
 */
export function anchorPlanet(x: number, z: number): void {
  anchor.set(x, 0, z);
  atlasToTileInto(x, -z, local);
  tileToSphereInto(local.tile, local.x, local.y, dir);
  const f = TILES[local.tile]!;
  up.set(dir.x, dir.y, dir.z);
  east.set(f.east.x, f.east.y, f.east.z);
  east.addScaledVector(up, -east.dot(up)).normalize();
  north.crossVectors(up, east);
  // Rows east, up, -north: east to +x, up to +y, north to -z.
  motion.set(
    east.x, east.y, east.z, x,
    up.x, up.y, up.z, -PLANET_RADIUS,
    -north.x, -north.y, -north.z, z,
    0, 0, 0, 1,
  );
  PLANET_T.value.set(motion.elements);
  inverseT.copy(motion).invert();
}

/** The planet's centre as drawn (three's space). */
export function planetCentre(out: Vector3): Vector3 {
  return out.set(0, 0, 0).applyMatrix4(motion);
}

const origin = new Vector3();
const direction = new Vector3();
const hitPoint = new Vector3();
const fp = { x: 0, y: 0 };

/**
 * Where a ray (three's space) first meets the planet at height `h` over the
 * sphere, as a world point of the atlas (map x, y), exact; null when it misses.
 */
export function planetPick(ray: Ray, h: number): { x: number; y: number } | null {
  origin.copy(ray.origin).applyMatrix4(inverseT);
  direction.copy(ray.direction).transformDirection(inverseT);
  const r = PLANET_RADIUS + h;
  const b = origin.dot(direction);
  const c = origin.lengthSq() - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  if (t < 0) return null;
  hitPoint.copy(origin).addScaledVector(direction, t);
  return sphereToAtlas(hitPoint);
}

/**
 * Where a ray passes nearest the planet's centre, as an atlas point: a drag
 * off the planet's limb still has a ground to hold.
 */
export function planetNearest(ray: Ray): { x: number; y: number } {
  origin.copy(ray.origin).applyMatrix4(inverseT);
  direction.copy(ray.direction).transformDirection(inverseT);
  const t = Math.max(0, -origin.dot(direction));
  hitPoint.copy(origin).addScaledVector(direction, t);
  return sphereToAtlas(hitPoint);
}

/** A point of the planet's frame (its direction) as the atlas point of the piece it lies on. */
function sphereToAtlas(p: Vector3): { x: number; y: number } {
  dir.x = p.x; dir.y = p.y; dir.z = p.z;
  const tile = tileOfDirection(dir);
  sphereToTileInto(tile, dir, fp);
  const c = tileCentre(tile);
  return { x: c.x + fp.x, y: c.y + fp.y };
}

const sTmp: Vec3 = { x: 0, y: 0, z: 0 };
const eA = new Vector3();
const eB = new Vector3();
const uS = new Vector3();

/** A piece's east on the sphere at a unit direction (its centre's east, made level there). */
function eastAt(tile: number, s: Readonly<Vec3>, out: Vector3): Vector3 {
  const e = TILES[tile]!.east;
  uS.set(s.x, s.y, s.z);
  return out.set(e.x, e.y, e.z).addScaledVector(uS, -(e.x * s.x + e.y * s.y + e.z * s.z)).normalize();
}

/**
 * An atlas point on a piece's own map: the same ground, in that piece's
 * coordinates - past its border too.
 */
export function inTileChart(tile: number, x: number, y: number): { x: number; y: number } {
  atlasToTileInto(x, y, local);
  if (local.tile === tile) return { x, y };
  tileToSphereInto(local.tile, local.x, local.y, sTmp);
  const c = tileCentre(tile);
  sphereToTileInto(tile, sTmp, fp);
  return { x: c.x + fp.x, y: c.y + fp.y };
}

/**
 * An atlas point that has wandered past its piece's border (the view's centre
 * dragged over it), taken to the piece it now stands on: the same ground in
 * that piece's place, and the turn (rad, to add to an azimuth) between the
 * two pieces' axes there. Null when it is still on its own piece.
 */
export function rehome(x: number, y: number): { x: number; y: number; turn: number } | null {
  atlasToTileInto(x, y, local);
  if (onTile(local.tile, local.x, local.y)) return null;
  const from = local.tile;
  tileToSphereInto(from, local.x, local.y, sTmp);
  const to = tileOfDirection(sTmp);
  if (to === from) return null;
  const p = sphereToTileInto(to, sTmp, fp);
  eastAt(from, sTmp, eA);
  eastAt(to, sTmp, eB);
  const turn = Math.atan2(eA.clone().cross(eB).dot(uS), eA.dot(eB));
  const c = tileCentre(to);
  return { x: c.x + p.x, y: c.y + p.y, turn };
}

const sunPlanet: Vec3 = { x: 0, y: 0, z: 0 };

/** The planet's sun (`world/planet/sun.ts`) as drawn (three's space, unit) at a time of day (minutes). */
export function planetSun(minutes: number, out: Vector3): Vector3 {
  planetSunInto(minutes, sunPlanet);
  return out.set(sunPlanet.x, sunPlanet.y, sunPlanet.z).transformDirection(motion);
}

/**
 * The sun last asked for (`planetSun`) in the planet's own frame: fixed over
 * the planet, it turns with the hour only - what a plate's baked light reads
 * (`terrainAtlas.ts`). Carried back from three's space through the motion of
 * another moment of the frame, it turned by the camera's own motion, and a
 * fast spin re-baked all 864 plates every frame.
 */
export function planetSunOnPlanet(): Readonly<Vec3> {
  return sunPlanet;
}

/** The time the sun makes at the place the view looks at (minutes, 0..1440). */
export function planetLocalMinutes(minutes: number): number {
  return localMinutesAt(minutes, anchor.x, -anchor.z);
}

/** The motion setting the planet down: its own frame to three's space (`space.ts`). */
export function planetMotion(): Readonly<Matrix4> {
  return motion;
}

/** The motion from the drawn world back to the planet's own frame (the clouds' noise is read there). */
export function planetInverse(): Readonly<Matrix4> {
  return inverseT;
}

/** A world point projected through `planetPointInto` (for screen positions). */
export function planetWorld(x: number, y: number, z: number): Vector3 {
  return planetPointInto(x, y, z, tmp);
}

/** The planet's anchor (three's space). */
export function planetAnchor(): Readonly<Vector3> {
  return anchor;
}
