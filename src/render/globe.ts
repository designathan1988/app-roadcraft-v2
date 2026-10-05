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
/**
 * The globe's radius once whole. The map wraps round its middle: its corners
 * stop short of the far pole (2.9 rad of the 3.14), so the map never folds
 * back over itself, and everything round the back is clipped (see below).
 */
const RADIUS = (MAP_HALF * Math.SQRT2) / 2.9;
/** Share of the relief kept once the map is a whole globe. */
const RELIEF = 0.3;

const BEND_GLSL = /* glsl */ `
float globeFacing = 1.0;
float globeOn = 0.0;
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
    // Bent round the point looked at while the curve is slight, round the
    // map's own middle as it closes into a globe (the map's edge always round
    // the back), and that middle brought under the camera.
    vec2 globePole = mix( globeCentre.xz, vec2( 0.0 ), globeS );
    vec2 globeD = globeWorld.xz - globePole;
    float globeDist = length( globeD );
    float globeTheta = min( globeDist / globeR, 3.1 );
    vec2 globeDir = globeDist > 1e-4 ? globeD / globeDist : vec2( 0.0 );
    // Hills flattened as the map closes into a globe: at that size the relief
    // would read as a lumpy outline, not as hills.
    float globeRad = globeR + globeWorld.y * mix( 1.0, ${RELIEF.toFixed(2)}, globeS );
    globeWorld.xz = globeCentre.xz + globeDir * globeRad * sin( globeTheta );
    globeWorld.y = globeRad * cos( globeTheta ) - globeR;
    // Raised as it rounds, so the planet sits in the middle of the picture
    // rather than hanging below the point the camera looks at.
    float globeLift = globeR * globeS * globeS * globeS;
    globeWorld.y += globeLift;
    vec3 globeCentreOfSphere = vec3( globeCentre.x, globeLift - globeR, globeCentre.z );
    // Turned, as it closes into a globe, so the map's middle faces the camera
    // (a globe on a desk is turned to the reader): the camera looks down at a
    // slant, and left upright the globe would show the map's edge below.
    vec3 globeToCam = -globeFwd;
    vec3 globeAxis = cross( vec3( 0.0, 1.0, 0.0 ), globeToCam );
    float globeAxisLen = length( globeAxis );
    if ( globeAxisLen > 1e-5 ) {
      globeAxis /= globeAxisLen;
      // s cubed, like the lift: about a centre R below, a turn moves the view
      // by R times the angle, and R grows as 1 / s squared.
      float globeTurn = acos( clamp( globeToCam.y, -1.0, 1.0 ) ) * globeS * globeS * globeS;
      vec3 globeV = globeWorld - globeCentreOfSphere;
      globeV = globeV * cos( globeTurn ) + cross( globeAxis, globeV ) * sin( globeTurn )
        + globeAxis * dot( globeAxis, globeV ) * ( 1.0 - cos( globeTurn ) );
      globeWorld = globeCentreOfSphere + globeV;
    }
    // Which way the sphere faces here, for the clip below.
    globeFacing = dot( normalize( globeWorld - globeCentreOfSphere ), globeToCam );
    globeOn = 1.0;
    mvPosition.xyz = globeRot * globeWorld + viewMatrix[ 3 ].xyz;
  }
}
#endif
gl_Position = projectionMatrix * mvPosition;
#if !defined( DEPTH_PACKING )
// Round the back of the globe, past its horizon, nothing is drawn (as MapLibre
// clips its globe at the horizon plane): pushed beyond the far plane, so a
// triangle that crosses the horizon is cut along it.
if ( globeOn > 0.0 && globeFacing < 0.0 ) gl_Position.z = gl_Position.w * ( 1.0 + 4.0 * ( -globeFacing ) + 0.01 );
#endif`;

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
