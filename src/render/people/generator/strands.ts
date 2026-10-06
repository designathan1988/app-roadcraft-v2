import { BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, ShaderMaterial, Vector3 } from 'three';
import type { StrandSet } from '@people/gen/hair';

/**
 * Strands (hair, brows, lashes) drawn as ribbons that always face the
 * camera: two vertices per strand point, spread across the strand in the
 * vertex shader by the strand's width (root to tip). Lit as hair is in
 * real time: Kajiya-Kay's strand diffuse and specular with Scheuermann's two
 * shifted highlights (ATI, "Hair Rendering and Shading", GDC 2004) - a white
 * one nudged to the tip, a wider one tinted by the hair - darker towards
 * the scalp (the strands' shadow on each other), each strand its own tone,
 * the tips fading by alpha to coverage (needs the canvas's MSAA).
 */

export interface StrandLook {
  readonly root: number;
  readonly tip: number;
  /** The grey strands' colour. */
  readonly grey?: number;
  /** 0..1 highlight strength (lashes and brows have little). */
  readonly shine: number;
}

/** The stage's lights (directions towards the light), for the strands' own shading. */
export interface StrandLights { readonly dirs: readonly Vector3[]; readonly colours: readonly Color[]; readonly ambient: Color }

const VERTEX = /* glsl */ `
attribute vec3 aNext;
attribute float aSide;
attribute float aV;
attribute float aSeed;
attribute float aGrey;
uniform float rootWidth;
uniform float tipWidth;
varying vec3 vT;
varying vec3 vW;
varying float vV;
varying float vSeed;
varying float vGrey;
varying float vCover;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec3 t = normalize((modelMatrix * vec4(aNext, 1.0)).xyz - w.xyz);
  vec3 toEye = normalize(cameraPosition - w.xyz);
  vec3 across = normalize(cross(t, toEye));
  float scale = length(modelMatrix[0].xyz);
  // Never thinner than about a third of a pixel, so far strands still cover.
  vec4 clip = projectionMatrix * viewMatrix * w;
  float pixel = clip.w * 2.0 / (projectionMatrix[1][1] * 720.0);
  // Close up a strand is drawn nearer its real thinness (the cap under the
  // hair gives the cover); from afar, wide enough to read as a head of hair.
  float near = clamp(length(cameraPosition - w.xyz) / 1.4, 0.4, 1.0);
  float trueWidth = mix(rootWidth, tipWidth, aV) * scale * near;
  float width = max(trueWidth, pixel * 0.6);
  // A strand thinner than its drawn width covers only that share (how thin lines are antialiased).
  vCover = clamp(trueWidth / width, 0.08, 1.0);
  w.xyz += across * aSide * width * 0.5;
  vT = t; vW = w.xyz; vV = aV; vSeed = aSeed; vGrey = aGrey;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAGMENT = /* glsl */ `
uniform vec3 rootColour;
uniform vec3 tipColour;
uniform vec3 greyColour;
uniform float shine;
uniform vec3 lightDir[3];
uniform vec3 lightColour[3];
uniform vec3 ambient;
varying vec3 vT;
varying vec3 vW;
varying float vV;
varying float vSeed;
varying float vGrey;
varying float vCover;
float strandSpec(vec3 T, vec3 H, float e) {
  float th = dot(T, H);
  return smoothstep(-1.0, 0.0, th) * pow(sqrt(max(0.0, 1.0 - th * th)), e);
}
void main() {
  vec3 T = normalize(vT);
  vec3 V = normalize(cameraPosition - vW);
  vec3 base = mix(rootColour, tipColour, smoothstep(0.25, 1.0, vV));
  base = mix(base, greyColour, vGrey);
  base *= 0.82 + 0.36 * vSeed;
  // The strands' shadow on each other: darker at the root.
  float occl = mix(0.45, 1.0, smoothstep(0.0, 0.35, vV));
  vec3 colour = ambient * base * occl;
  for (int i = 0; i < 3; i++) {
    vec3 L = lightDir[i];
    float tl = dot(T, L);
    float diffuse = mix(0.25, 1.0, sqrt(max(0.0, 1.0 - tl * tl)));
    vec3 H = normalize(L + V);
    vec3 t1 = normalize(T + 0.08 * V), t2 = normalize(T - 0.1 * V);
    float s1 = strandSpec(t1, H, 120.0) * 0.2;
    float s2 = strandSpec(t2, H, 22.0) * 0.35;
    colour += lightColour[i] * occl * (base * diffuse * 0.75 + shine * (vec3(s1) + base * s2));
  }
  gl_FragColor = vec4(colour, (1.0 - smoothstep(0.82, 1.0, vV) * 0.85) * vCover);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function strandMaterial(lights: StrandLights): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      rootWidth: { value: 0.0004 }, tipWidth: { value: 0.0001 },
      rootColour: { value: new Color() }, tipColour: { value: new Color() }, greyColour: { value: new Color(0xb8b6b2) },
      shine: { value: 1 },
      lightDir: { value: lights.dirs.map((d) => d.clone().normalize()) },
      lightColour: { value: lights.colours },
      ambient: { value: lights.ambient },
    },
    alphaToCoverage: true,
    transparent: false,
    // A ribbon turned to the camera winds either way, by which way its strand runs on screen.
    side: DoubleSide,
  });
}

/** Ribbon geometry for a strand set (two vertices per point). */
export function strandGeometry(set: StrandSet): BufferGeometry {
  let points = 0;
  for (const c of set.counts) points += c;
  const pos = new Float32Array(points * 6), next = new Float32Array(points * 6);
  const side = new Float32Array(points * 2), v = new Float32Array(points * 2), seed = new Float32Array(points * 2), grey = new Float32Array(points * 2);
  let segs = 0;
  for (const c of set.counts) segs += c - 1;
  const index = new Uint32Array(segs * 6);
  let at = 0, ii = 0;
  for (let s = 0; s < set.counts.length; s++) {
    const n = set.counts[s]!;
    for (let i = 0; i < n; i++) {
      const p = at + i;
      // The point the strand heads to (the last point looks back).
      const q = i < n - 1 ? p + 1 : p - 1, flip = i < n - 1 ? 1 : -1;
      for (let k = 0; k < 2; k++) {
        const o = p * 2 + k;
        for (let d = 0; d < 3; d++) {
          pos[o * 3 + d] = set.points[p * 3 + d]!;
          // For the last point, a point beyond it along the strand.
          next[o * 3 + d] = flip > 0 ? set.points[q * 3 + d]! : 2 * set.points[p * 3 + d]! - set.points[q * 3 + d]!;
        }
        side[o] = k ? 1 : -1;
        v[o] = n > 1 ? i / (n - 1) : 0;
        seed[o] = set.seeds[s]!;
        grey[o] = set.grey[s]!;
      }
      if (i < n - 1) {
        const a = p * 2, b = p * 2 + 1, c2 = (p + 1) * 2, d = (p + 1) * 2 + 1;
        index[ii++] = a; index[ii++] = c2; index[ii++] = b;
        index[ii++] = b; index[ii++] = c2; index[ii++] = d;
      }
    }
    at += n;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('aNext', new BufferAttribute(next, 3));
  g.setAttribute('aSide', new BufferAttribute(side, 1));
  g.setAttribute('aV', new BufferAttribute(v, 1));
  g.setAttribute('aSeed', new BufferAttribute(seed, 1));
  g.setAttribute('aGrey', new BufferAttribute(grey, 1));
  g.setIndex(new BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}

/** A strand layer's mesh; its material is reused across rebuilds. */
export function strandMesh(set: StrandSet, look: StrandLook, material: ShaderMaterial): Mesh {
  const u = material.uniforms;
  u['rootWidth']!.value = set.rootWidth;
  u['tipWidth']!.value = set.tipWidth;
  (u['rootColour']!.value as Color).setHex(look.root);
  (u['tipColour']!.value as Color).setHex(look.tip);
  if (look.grey !== undefined) (u['greyColour']!.value as Color).setHex(look.grey);
  u['shine']!.value = look.shine;
  const mesh = new Mesh(strandGeometry(set), material);
  mesh.frustumCulled = false;
  return mesh;
}
