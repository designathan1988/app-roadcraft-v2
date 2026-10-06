import { BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, MeshPhysicalMaterial } from 'three';
import { PATTERNS, type GarmentMesh, type GarmentParams } from '@people/gen/clothes';

/**
 * A piece of clothing drawn: three's physical material with cloth's sheen
 * (Estevez and Kulla's sheen model, three's `sheen`), the fabric's
 * roughness, and the pattern worked out in the shader from the cloth's
 * rest-body position (stripes, pinstripe, check, dots, denim twill, knit
 * rib, camouflage), so it never needs a texture and stays put on the cloth.
 */

const FABRIC: Readonly<Record<string, { roughness: number; sheen: number; sheenRoughness: number; spec: number }>> = {
  cotton: { roughness: 0.85, sheen: 0.5, sheenRoughness: 0.6, spec: 0.3 },
  denim: { roughness: 0.92, sheen: 0.3, sheenRoughness: 0.7, spec: 0.25 },
  knit: { roughness: 0.95, sheen: 0.8, sheenRoughness: 0.5, spec: 0.2 },
  silk: { roughness: 0.38, sheen: 1.0, sheenRoughness: 0.25, spec: 0.7 },
  leather: { roughness: 0.45, sheen: 0.0, sheenRoughness: 0.5, spec: 0.6 },
};

const PATTERN_GLSL = /* glsl */ `
float patHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float patNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(patHash(i), patHash(i + vec2(1, 0)), u.x), mix(patHash(i + vec2(0, 1)), patHash(i + vec2(1, 1)), u.x), u.y);
}
// 0 = first colour, 1 = second; shade multiplies.
vec2 clothPattern(vec3 p, int kind, float scale) {
  float s = scale;
  float across = p.x + p.z * 0.6;
  if (kind == 1) return vec2(step(0.5, fract(p.y * 14.0 * s)), 1.0);
  if (kind == 2) return vec2(step(0.92, fract(across * 26.0 * s)), 1.0);
  if (kind == 3) {
    float a = step(0.5, fract(p.y * 9.0 * s)), b = step(0.5, fract(across * 9.0 * s));
    return vec2((a + b) * 0.5, 1.0);
  }
  if (kind == 4) {
    vec2 q = vec2(across, p.y) * 16.0 * s;
    q.x += step(1.0, mod(floor(q.y), 2.0)) * 0.5;
    return vec2(step(length(fract(q) - 0.5), 0.22), 1.0);
  }
  if (kind == 5) {
    float twill = sin((p.y + across) * 900.0) * 0.5 + 0.5;
    float fade = patNoise(vec2(across, p.y) * 9.0);
    return vec2(fade * 0.45, 0.86 + 0.14 * twill);
  }
  if (kind == 6) return vec2(0.0, 0.84 + 0.16 * (sin(across * 520.0) * 0.5 + 0.5));
  if (kind == 7) {
    float n = patNoise(vec2(across, p.y) * 7.0 * s) + 0.5 * patNoise(vec2(across, p.y) * 15.0 * s);
    return vec2(n > 0.95 ? 1.0 : n > 0.7 ? 0.5 : 0.0, 1.0);
  }
  return vec2(0.0, 1.0);
}`;

export function fabricMaterial(p: GarmentParams): MeshPhysicalMaterial {
  const f = FABRIC[p.fabric] ?? FABRIC['cotton']!;
  const m = new MeshPhysicalMaterial({
    color: 0xffffff, roughness: f.roughness, sheen: f.sheen, sheenRoughness: f.sheenRoughness, sheenColor: new Color(p.colour).lerp(new Color(0xffffff), 0.4),
    specularIntensity: f.spec, side: DoubleSide,
  });
  const uniforms = {
    colourA: { value: new Color(p.colour) }, colourB: { value: new Color(p.colour2) },
    patternKind: { value: Math.max(0, PATTERNS.indexOf(p.pattern as (typeof PATTERNS)[number])) }, patternScale: { value: p.patternScale },
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 pattern;\nvarying vec3 vPattern;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPattern = pattern;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vPattern;\nuniform vec3 colourA;\nuniform vec3 colourB;\nuniform int patternKind;\nuniform float patternScale;\n${PATTERN_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 pat = clothPattern(vPattern, patternKind, patternScale);
        diffuseColor.rgb *= mix(colourA, colourB, pat.x) * pat.y;
        // The inside of the cloth, seen through a sleeve or hem, is in its own shade.
        if (!gl_FrontFacing) diffuseColor.rgb *= 0.45;`);
  };
  m.customProgramCacheKey = () => 'roadcraft-fabric';
  m.userData['fabric'] = uniforms;
  return m;
}

export function garmentObject(g: GarmentMesh): Mesh {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(g.positions, 3));
  geo.setAttribute('normal', new BufferAttribute(g.normals, 3));
  geo.setAttribute('pattern', new BufferAttribute(g.pattern, 3));
  geo.setIndex(new BufferAttribute(g.index, 1));
  geo.computeBoundingSphere();
  const mesh = new Mesh(geo, fabricMaterial(g.params));
  mesh.castShadow = true;
  return mesh;
}
