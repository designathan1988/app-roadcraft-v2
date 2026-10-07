import { chartAngle } from '@world/planet/sphere';
import { Frustum, Mesh, MeshStandardMaterial, Quaternion, ShaderChunk, ShaderLib, Sphere, SphereGeometry, Vector3, type Camera, type Object3D, type Sprite, type Texture } from 'three';

/**
 * THE PLANET: the map drawn as the globe it charts.
 *
 * The map is the planet's STEREOGRAPHIC chart (`world/planet/sphere.ts`):
 * every system of the game works on the chart, a plane, as surveying and
 * flight simulators work in a local tangent plane, and only the PICTURE is
 * wrapped onto the sphere, each point of the chart to its own point of the
 * sphere exactly (angles kept; the scale 1 + rho^2/4R^2 alike in every
 * direction), its height becoming height above the sphere. Directions turn with it
 * (Rodrigues' rotation about the axis across the radius), so a normal still
 * faces out of the ground it belongs to and the light falls true.
 *
 * Done once, in three's own vertex chunks (`project_vertex`,
 * `worldpos_vertex`, `defaultnormal_vertex`), so every material - its shadow
 * pass included - draws the same globe; textures and every world-space
 * varying the materials compute themselves stay on the plane, undistorted.
 * The camera is set on the globe (`placeCamera`), a pick is taken back to the
 * plane exactly (`planetUnbend`), and three's culling tests a bounding sphere
 * where the globe draws it.
 *
 * Three's coordinates: x east, y up, z = -(map y). The plane's origin, the
 * middle of the map, is the top of the globe; its centre lies R below.
 */

/**
 * The planet's radius in world units, shared by every shader as `planetBend.x`
 * (0: the map is flat). A plain object, not three's Vector4: `cloneUniforms`
 * copies three's own types into each material, and this one must stay ONE
 * object every material reads.
 */
export const PLANET_BEND = { x: 0, y: 0, z: 0, w: 0 };
const PLANET_UNIFORM = { value: PLANET_BEND };

/** The planet's radius, units (0: flat). */
export function planetRadius(): number {
  return PLANET_BEND.x;
}

export function setPlanetRadius(radius: number): void {
  PLANET_BEND.x = Math.max(0, radius);
}

/** A plane point (three's axes: x, height y, z) on the globe. */
export function planetPoint(x: number, y: number, z: number, out: Vector3): Vector3 {
  const R = PLANET_BEND.x;
  const d = Math.hypot(x, z);
  if (R <= 0 || d < 1e-6) return out.set(x, y, z);
  const th = chartAngle(d, R), r = R + y, s = Math.sin(th) * r / d;
  return out.set(x * s, r * Math.cos(th) - R, z * s);
}

/** A point on (or over) the globe back to the plane: x, height, z. */
export function planetUnbend(p: Vector3, out: Vector3): Vector3 {
  const R = PLANET_BEND.x;
  if (R <= 0) return out.copy(p);
  const cy = p.y + R;
  const r = Math.hypot(p.x, cy, p.z);
  const across = Math.hypot(p.x, p.z);
  const th = Math.atan2(across, cy);
  if (across < 1e-9) return out.set(0, r - R, 0);
  const rho = 2 * R * Math.tan(th / 2);
  return out.set((p.x / across) * rho, r - R, (p.z / across) * rho);
}

/** The turn the globe gives a plane point's directions (its local frame). */
export function planetFrame(x: number, z: number, out: Quaternion): Quaternion {
  const R = PLANET_BEND.x;
  const d = Math.hypot(x, z);
  if (R <= 0 || d < 1e-6) return out.identity();
  return out.setFromAxisAngle(axis.set(z / d, 0, -x / d), chartAngle(d, R));
}
const axis = new Vector3();

/**
 * Where a ray first meets the globe at height `h` over it (null: it misses),
 * as a plane point - the pick, exact.
 */
export function planetPick(origin: Vector3, direction: Vector3, h: number, out: Vector3): Vector3 | null {
  const R = PLANET_BEND.x;
  const r = R + h;
  // Centre (0, -R, 0).
  const ox = origin.x, oy = origin.y + R, oz = origin.z;
  const b = ox * direction.x + oy * direction.y + oz * direction.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  if (t < 0) return null;
  hit.set(origin.x + direction.x * t, origin.y + direction.y * t, origin.z + direction.z * t);
  return planetUnbend(hit, out);
}
const hit = new Vector3();

/**
 * Sets a camera placed for the plane (looking at `target`, up `up`) on the
 * globe: carried with the ground it looks at, so that ground still lies level
 * on the screen and the view orbits the planet as it pans.
 */
export function placeCamera(camera: Camera, target: Vector3): void {
  if (PLANET_BEND.x <= 0) return;
  planetFrame(target.x, target.z, frame);
  planetPoint(target.x, target.y, target.z, bentTarget);
  camera.position.sub(target).applyQuaternion(frame).add(bentTarget);
  camera.up.applyQuaternion(frame);
  camera.lookAt(bentTarget);
}
const frame = new Quaternion();
const bentTarget = new Vector3();

/**
 * The plane's view of a camera on the globe: the same eye taken back to the
 * plane about the point it looks at - for the CPU's own culling and
 * distances, which work on the plane (`target` on the plane).
 */
export function planeCamera<C extends Camera>(camera: C, target: Vector3, out: C): C {
  out.copy(camera, false);
  if (PLANET_BEND.x > 0) {
    planetFrame(target.x, target.z, frame).invert();
    planetPoint(target.x, target.y, target.z, bentTarget);
    out.position.sub(bentTarget).applyQuaternion(frame).add(target);
    out.quaternion.premultiply(frame);
  }
  out.updateMatrixWorld(true);
  return out;
}

/** The GLSL the chunks use: the plane to the globe, and its turn of directions. */
export const PLANET_GLSL = /* glsl */ `
uniform vec4 planetBend;
vec3 planetPoint(vec3 p) {
  float R = planetBend.x;
  float d = length(p.xz);
  if (R <= 0.0 || d < 1e-3) return p;
  float th = 2.0 * atan(d / (2.0 * R));
  float r = R + p.y;
  vec2 u = p.xz / d;
  return vec3(u.x * r * sin(th), r * cos(th) - R, u.y * r * sin(th));
}
vec3 planetTurn(vec3 v, vec3 at) {
  float R = planetBend.x;
  float d = length(at.xz);
  if (R <= 0.0 || d < 1e-3) return v;
  vec3 a = vec3(at.z, 0.0, -at.x) / d;
  float th = 2.0 * atan(d / (2.0 * R));
  float c = cos(th);
  float s = sin(th);
  return v * c + cross(a, v) * s + a * dot(a, v) * (1.0 - c);
}
// A view-space point of the plane to its view-space point on the globe.
vec4 planetView(vec4 mv) {
  if (planetBend.x <= 0.0) return mv;
  mat3 r = mat3(viewMatrix);
  vec3 world = transpose(r) * (mv.xyz - viewMatrix[3].xyz);
  return vec4(r * planetPoint(world) + viewMatrix[3].xyz, mv.w);
}
`;

let installed = false;

/**
 * Wraps three's vertex chunks round the globe, gives every built-in shader
 * the shared radius, and teaches three's culling where things are drawn.
 * Before any program is built; once.
 */
export function installPlanet(): void {
  if (installed) return;
  installed = true;
  const chunks = ShaderChunk as unknown as Record<string, string>;
  // In every shader that includes `common` (harmless in a fragment shader:
  // three declares viewMatrix there too).
  chunks['common'] = `${chunks['common']}\n${PLANET_GLSL}\n`;
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
  // The view-space normal and tangent turned as the globe turns the ground
  // they belong to (the unskinned position is close enough: the turn varies
  // by a degree over 87 m on a planet of 5 km).
  chunks['defaultnormal_vertex'] = `${chunks['defaultnormal_vertex'] as string}
     #ifndef PLANET_SKIP
     if ( planetBend.x > 0.0 ) {
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
  for (const shader of Object.values(ShaderLib)) shader.uniforms['planetBend'] = PLANET_UNIFORM;

  // Culling where the globe draws a thing: its bounding sphere's centre on
  // the globe, the sphere a little wider (the globe is near an isometry).
  const object = Frustum.prototype.intersectsObject;
  const sprite = Frustum.prototype.intersectsSprite;
  const sphere = new Sphere();
  const bent = (s: Sphere): Sphere => {
    planetPoint(s.center.x, s.center.y, s.center.z, s.center);
    s.radius = s.radius * 1.05 + 4;
    return s;
  };
  Frustum.prototype.intersectsObject = function (this: Frustum, target: Object3D): boolean {
    if (PLANET_BEND.x <= 0 || target.userData['planetSkip']) return object.call(this, target);
    const own = (target as Object3D & { boundingSphere?: Sphere | null; computeBoundingSphere?: () => void });
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
    return this.intersectsSphere(bent(sphere));
  };
  Frustum.prototype.intersectsSprite = function (this: Frustum, target: Sprite): boolean {
    return sprite.call(this, target);
  };
}

/** GLSL and uniform for a hand-written vertex shader that must sit on the globe too. */
export const PLANET_SHADER = { glsl: PLANET_GLSL, uniform: PLANET_UNIFORM };

/**
 * The rest of the globe round the map, and the land that joins it: a sphere
 * at the globe's ground level, open over the map and its skirt (their
 * square, taken back to the plane); and the skirt's own material. Both are
 * the map's lawn - its grass texture read at the same two scales as the
 * terrain's, by the plane's coordinates, with its grain at every distance -
 * so the land runs on past the map's edge without a seam.
 */
export interface PlanetBody {
  readonly mesh: Mesh;
  /** For the terrain's skirt (`TerrainSurface.skirt`). */
  readonly skirtMaterial: MeshStandardMaterial;
  setRadius(radius: number): void;
  dispose(): void;
}

export function createPlanetBody(openHalf: number, level: number, grass: Texture | null): PlanetBody {
  const land = (body: boolean): MeshStandardMaterial => {
    const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 0.15, map: grass });
    if (body) material.defines = { PLANET_SKIP: '', PLANET_BODY: '' };
    material.onBeforeCompile = (shader) => {
      shader.uniforms['uOpenHalf'] = { value: openHalf };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
varying vec3 vLand;`)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
vLand = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vLand;
          uniform float uOpenHalf;
          float landHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float landNoise(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(mix(landHash(i), landHash(i + vec2(1.0, 0.0)), f.x), mix(landHash(i + vec2(0.0, 1.0)), landHash(i + vec2(1.0)), f.x), f.y);
          }`)
        .replace('#include <map_fragment>', `
          #ifdef PLANET_BODY
            // Back to the plane: where on the map's chart this point lies.
            float R = planetBend.x;
            vec3 c = vLand + vec3(0.0, R, 0.0);
            float across = length(c.xz);
            vec2 chart = across > 1e-3 ? c.xz / across * 2.0 * R * tan(0.5 * atan(across, c.y)) : vec2(0.0);
            if (max(abs(chart.x), abs(chart.y)) < uOpenHalf - 0.5) discard;
          #else
            vec2 chart = vLand.xz;
          #endif
          #ifdef USE_MAP
            // The terrain's lawn: its texture at the same two scales
            // (terrain.ts dualScale) and its grain where a pixel is wide.
            vec2 tg = chart / 96.0;
            vec2 wide = vec2(tg.x * 0.9396926 - tg.y * 0.3420201, tg.x * 0.3420201 + tg.y * 0.9396926) * 0.137;
            vec4 lawn = mix(texture2D(map, tg), texture2D(map, wide), 0.42);
            vec2 fp = fwidth(chart);
            float lod = max(0.0, log2(max(fp.x, fp.y) * 0.9));
            float level = floor(lod);
            vec2 gu = chart / 96.0 * 2.7;
            float g0 = dot(texture2D(map, gu / exp2(level)).rgb, vec3(0.3, 0.6, 0.1));
            float g1 = dot(texture2D(map, gu / exp2(level + 1.0) + 0.37).rgb, vec3(0.3, 0.6, 0.1));
            float gAvg = dot(texture2D(map, gu, 14.0).rgb, vec3(0.3, 0.6, 0.1));
            float grain = mix(g0, g1, lod - level) / max(gAvg, 0.02);
            lawn.rgb *= mix(1.0, clamp(grain, 0.55, 1.5), smoothstep(0.15, 0.6, lod) * 0.75);
            // Broad light and shade, as the map's macro variation.
            lawn.rgb *= 0.88 + 0.24 * (landNoise(chart / 900.0) * 0.6 + landNoise(chart / 260.0) * 0.4);
            diffuseColor *= lawn;
          #endif`);
    };
    material.customProgramCacheKey = () => (body ? 'planet-land-body-v2' : 'planet-land-skirt-v2');
    return material;
  };
  const material = land(true);
  const skirtMaterial = land(false);
  const mesh = new Mesh(new SphereGeometry(1, 256, 128), material);
  mesh.name = 'planet-body';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  mesh.userData['planetSkip'] = true;
  mesh.visible = false;
  return {
    mesh,
    skirtMaterial,
    setRadius(radius) {
      mesh.visible = radius > 0;
      // Its ground at the globe's level, where the skirt ends.
      mesh.scale.setScalar(Math.max(1, radius + level));
      mesh.position.set(0, -radius, 0);
      mesh.updateMatrixWorld(true);
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
      skirtMaterial.dispose();
    },
  };
}
