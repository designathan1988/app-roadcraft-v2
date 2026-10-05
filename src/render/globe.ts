import { type Camera, type Object3D, ShaderChunk, Vector3 } from 'three';
import { MAP_HALF } from '@world/bounds';

/**
 * The map as a little planet when the camera is far, flat when it is near.
 *
 * Nothing in the world changes: the roads, the traffic, the buildings and the
 * people stay on their flat map, and so do shadows and picking. Only the picture
 * is bent, in the vertex stage every material shares (three's `project_vertex`
 * chunk), as in Animal Crossing's "rolling log" world or the curved-world
 * shaders of many games: each vertex is wrapped onto a sphere round the point
 * the camera looks at, keeping its height above the ground as height above the
 * sphere. The sphere's radius follows the zoom: near, it is so large the ground
 * is flat; zoomed out, it shrinks until the whole square map is a globe.
 *
 * Everything the bend needs is read from uniforms three gives every program
 * (`viewMatrix`, `projectionMatrix`, `cameraPosition`, `isOrthographic`), so no
 * material has to be told about it. Depth-only passes (`DEPTH_PACKING`: the
 * shadow maps) are left flat, so a shadow is computed on the flat map and laid
 * on the bent picture where its receiver is.
 */

/** Visible half height (world units) under which the map is flat. */
const FLAT = 500;
/** Visible half height at which the bend is whole. */
const FULL = 2000;
/** The globe's radius once whole: the square map wraps nearly all the way round (its edge 150 degrees from the middle). */
const RADIUS = MAP_HALF / 2.6;

const BEND_GLSL = /* glsl */ `
#if !defined( DEPTH_PACKING )
{
  mat3 globeRot = mat3( viewMatrix );
  vec3 globeWorld = transpose( globeRot ) * ( mvPosition.xyz - viewMatrix[ 3 ].xyz );
  vec3 globeFwd = -vec3( viewMatrix[ 0 ][ 2 ], viewMatrix[ 1 ][ 2 ], viewMatrix[ 2 ][ 2 ] );
  float globeT = globeFwd.y < -1e-4 ? -cameraPosition.y / globeFwd.y : 0.0;
  vec3 globeCentre = cameraPosition + globeFwd * globeT;
  float globeHalf = isOrthographic ? 1.0 / projectionMatrix[ 1 ][ 1 ] : globeT / projectionMatrix[ 1 ][ 1 ];
  float globeS = smoothstep( ${FLAT.toFixed(1)}, ${FULL.toFixed(1)}, globeHalf );
  if ( globeS > 0.0 ) {
    float globeR = ${RADIUS.toFixed(1)} / ( globeS * globeS );
    vec2 globeD = globeWorld.xz - globeCentre.xz;
    float globeDist = length( globeD );
    float globeTheta = min( globeDist / globeR, 3.1 );
    vec2 globeDir = globeDist > 1e-4 ? globeD / globeDist : vec2( 0.0 );
    float globeRad = globeR + globeWorld.y;
    globeWorld.xz = globeCentre.xz + globeDir * globeRad * sin( globeTheta );
    globeWorld.y = globeRad * cos( globeTheta ) - globeR;
    // Raised as it rounds, so the planet sits in the middle of the picture
    // rather than hanging below the point the camera looks at.
    globeWorld.y += globeR * globeS * globeS * globeS;
    mvPosition.xyz = globeRot * globeWorld + viewMatrix[ 3 ].xyz;
  }
}
#endif
gl_Position = projectionMatrix * mvPosition;`;

let installed = false;

/** Puts the bend into every material's vertex stage. Before the first program is compiled. */
export function installGlobe(): void {
  if (installed) return;
  installed = true;
  ShaderChunk.project_vertex = ShaderChunk.project_vertex.replace('gl_Position = projectionMatrix * mvPosition;', BEND_GLSL);
}

const forward = new Vector3();

/** How bent the picture is for this camera: 0 flat, 1 a whole globe. The same sum as the shader's. */
export function globeAmount(camera: Camera): number {
  camera.getWorldDirection(forward);
  const t = forward.y < -1e-4 ? -camera.position.y / forward.y : 0;
  const p11 = camera.projectionMatrix.elements[5] ?? 1;
  const ortho = (camera as { isOrthographicCamera?: boolean }).isOrthographicCamera === true;
  const half = ortho ? 1 / p11 : t / p11;
  const x = Math.min(1, Math.max(0, (half - FLAT) / (FULL - FLAT)));
  return x * x * (3 - 2 * x);
}

/**
 * Frustum culling reads the flat map: bent, things far outside the flat view
 * come into the picture. While the picture is bent, nothing is culled by the
 * camera; flat again, every object culls as it did. Objects added while bent
 * are caught at the next sweep.
 */
export function createGlobeCulling(): { update(scene: Object3D, camera: Camera): boolean } {
  const unculled = new Set<Object3D>();
  let bent = false;
  let sweep = 0;
  return {
    update(scene, camera) {
      const now = globeAmount(camera) > 0;
      if (now && (!bent || ++sweep % 30 === 0)) {
        scene.traverse((o) => { if (o.frustumCulled) { o.frustumCulled = false; unculled.add(o); } });
      } else if (!now && bent) {
        for (const o of unculled) o.frustumCulled = true;
        unculled.clear();
      }
      bent = now;
      return now;
    },
  };
}
