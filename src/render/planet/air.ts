import { Vector3 } from 'three';
import { PLANET_RADIUS } from '@core/cubeSphere';

/**
 * THE AIR ROUND THE PLANET: single scattering, Rayleigh and Mie, marched along
 * a ray (O'Neil, GPU Gems 2 ch. 16; the glsl-atmosphere shader). One GLSL
 * source for the two places that need it: the shell drawn over the planet
 * (`space.ts`), and the clouds' shadows (`postprocess.ts`), which take the
 * sun from the ground under a cloud but must leave the air between the eye
 * and that ground as it is - a pixel seen from space is the air's own light
 * plus the ground's through it, and a cloud's shadow falls on the ground's
 * part alone (Unreal keeps a cloud's shadow on surfaces and on the
 * atmosphere as two strengths, DirectionalLightComponent
 * `cloud_shadow_on_surface_strength` / `_on_atmosphere_strength`).
 */

/**
 * The top of the air over the sphere: 15 % of the radius. The Earth's is
 * 1.6 % and O'Neil draws 2.5 %; this planet is a few kilometres round and
 * its clouds float hundreds of metres up (`world/clouds.ts`, 450 units by
 * default), so a thinner shell left them hanging in black space past the
 * limb. The optical depth stays the Earth's (`AIR_SCALE`): only the glow
 * round the limb is wider.
 */
export const ATMOSPHERE_TOP = PLANET_RADIUS * 1.15;
/** Earth metres per world unit of the air: its 100 km over our shell's thickness. */
const AIR_SCALE = 100e3 / (ATMOSPHERE_TOP - PLANET_RADIUS);

/** The air's uniforms, fresh: its centre, the sun and how much of it shows set each frame. */
export function airUniforms(): Record<string, { value: unknown }> {
  return {
    uAirCentre: { value: new Vector3() },
    uAirSun: { value: new Vector3(0, 1, 0) },
    uAirPlanet: { value: PLANET_RADIUS },
    uAirTop: { value: ATMOSPHERE_TOP },
    uAirBetaR: { value: new Vector3(5.5e-6, 13.0e-6, 22.4e-6).multiplyScalar(AIR_SCALE) },
    uAirBetaM: { value: 21e-6 * AIR_SCALE },
    uAirScaleR: { value: 8e3 / AIR_SCALE },
    uAirScaleM: { value: 1.2e3 / AIR_SCALE },
    uAirIntensity: { value: 5 },
    uAirStrength: { value: 0 },
  };
}

/**
 * `airLight(eye, rd)`: the air's light along a ray from `eye` (world space)
 * towards `rd`, up to the ground or out of the air, as `rgb`, and what of
 * what lies behind it comes through as `a` - drawn with ONE, SRC_ALPHA it is
 * the air over whatever the scene put there. (0, 0, 0, 1) where the ray
 * misses the air.
 */
export const AIR_GLSL = /* glsl */ `
  uniform vec3 uAirCentre;
  uniform vec3 uAirSun;
  uniform float uAirPlanet;
  uniform float uAirTop;
  uniform vec3 uAirBetaR;
  uniform float uAirBetaM;
  uniform float uAirScaleR;
  uniform float uAirScaleM;
  uniform float uAirIntensity;
  uniform float uAirStrength;
  const float AIR_PI = 3.14159265;
  const int AIR_I_STEPS = 12;
  const int AIR_J_STEPS = 4;
  const float AIR_G = 0.758;
  // Near and far distances along a ray to a sphere at the origin (far < near: a miss).
  vec2 airSphere(vec3 r0, vec3 rd, float sr) {
    float b = dot(rd, r0);
    float c = dot(r0, r0) - sr * sr;
    float d = b * b - c;
    if (d < 0.0) return vec2(1e9, -1e9);
    float s = sqrt(d);
    return vec2(-b - s, -b + s);
  }
  vec4 airLight(vec3 eye, vec3 rd) {
    vec3 ro = eye - uAirCentre;
    vec2 air = airSphere(ro, rd, uAirTop);
    if (air.x > air.y || air.y < 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
    vec2 ground = airSphere(ro, rd, uAirPlanet);
    float t0 = max(air.x, 0.0);
    float t1 = air.y;
    bool hitsGround = ground.x < ground.y && ground.x > 0.0;
    if (hitsGround) t1 = min(t1, ground.x);
    float ds = (t1 - t0) / float(AIR_I_STEPS);
    float odR = 0.0, odM = 0.0;
    vec3 sumR = vec3(0.0), sumM = vec3(0.0);
    for (int i = 0; i < AIR_I_STEPS; i++) {
      vec3 p = ro + rd * (t0 + ds * (float(i) + 0.5));
      float h = length(p) - uAirPlanet;
      float hr = exp(-h / uAirScaleR) * ds;
      float hm = exp(-h / uAirScaleM) * ds;
      odR += hr;
      odM += hm;
      // Towards the sun: none where the planet shades this point.
      vec2 shade = airSphere(p, uAirSun, uAirPlanet);
      if (shade.x < shade.y && shade.x > 0.0) continue;
      float lj = airSphere(p, uAirSun, uAirTop).y / float(AIR_J_STEPS);
      float jR = 0.0, jM = 0.0;
      for (int j = 0; j < AIR_J_STEPS; j++) {
        vec3 q = p + uAirSun * (lj * (float(j) + 0.5));
        float hj = max(length(q) - uAirPlanet, 0.0);
        jR += exp(-hj / uAirScaleR) * lj;
        jM += exp(-hj / uAirScaleM) * lj;
      }
      vec3 tau = uAirBetaR * (odR + jR) + uAirBetaM * 1.1 * (odM + jM);
      vec3 att = exp(-tau);
      sumR += att * hr;
      sumM += att * hm;
    }
    float mu = dot(rd, uAirSun);
    float mu2 = mu * mu;
    float pR = 3.0 / (16.0 * AIR_PI) * (1.0 + mu2);
    float g2 = AIR_G * AIR_G;
    float pM = 3.0 / (8.0 * AIR_PI) * ((1.0 - g2) * (1.0 + mu2)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * mu * AIR_G, 1.5));
    vec3 light = uAirIntensity * (pR * uAirBetaR * sumR + pM * uAirBetaM * sumM);
    vec3 through = exp(-(uAirBetaR * odR + uAirBetaM * 1.1 * odM));
    float behind = hitsGround ? dot(through, vec3(0.3333)) : 1.0;
    return vec4(light * uAirStrength, mix(1.0, behind, uAirStrength));
  }
`;
