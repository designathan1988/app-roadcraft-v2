import {
  BufferAttribute, BufferGeometry, Color, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, NoColorSpace,
  ShaderChunk, SRGBColorSpace, TextureLoader, type Material, type Texture,
} from 'three';
import type { HumanBase } from '@people/gen/humanBase';
import { HAIR_SHADOW_GLSL, type HairShadowUniforms } from './strands';

/**
 * A generated human drawn: one mesh over the base's render vertices, one
 * material per (material, UDIM tile) group of the pack.
 *
 * Skin is three's physical material with the base's own maps (the light and
 * dark albedo blended by melanin, as CharMorph's Vitruvian skin does;
 * roughness; height as bump) and a diffuse term that lets light wrap past the
 * terminator with a red band where it fades - the real-time stand-in for
 * light scattered under the skin (Green, GPU Gems 1 ch. 16; the same idea as
 * pre-integrated skin, Penner 2011) - plus a faint sheen for the fine hair.
 */

export type TextureSet = ReadonlyMap<string, Texture>;

const loader = new TextureLoader();

/** Every map of the pack, keyed `<map>.<tile>`; colour maps decoded as sRGB. */
export async function loadHumanTextures(base: HumanBase, urlOf: (file: string) => string): Promise<TextureSet> {
  const out = new Map<string, Texture>();
  const jobs: Promise<void>[] = [];
  for (const [map, tiles] of Object.entries(base.meta.textures)) {
    for (const tile of tiles) {
      const key = `${map}.${tile}`;
      jobs.push(loader.loadAsync(urlOf(`${key}.jpg`)).then((tex) => {
        tex.colorSpace = map.endsWith('_Color') ? SRGBColorSpace : NoColorSpace;
        tex.anisotropy = 8;
        // Blender's UVs start at the bottom left, as WebGL's do: keep three's default flipY.
        out.set(key, tex);
      }));
    }
  }
  await Promise.all(jobs);
  return out;
}

export interface HumanLook {
  /** 0 light .. 1 dark. */
  readonly melanin: number;
  /** A skin colour for a base without textures. */
  readonly flatSkin: Color;
  readonly iris: Color;
  /** The hair's opacity map: the key light reaches the skin through the hair. */
  readonly hairShadow?: HairShadowUniforms;
}

/** The key light (three puts the shadow-casting light first) scaled by its transmittance through the hair. */
const DIR_LIGHT = 'getDirectionalLightInfo( directionalLight, directLight );';

const DIFFUSE = 'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );';

/** three's physical lighting with skin's wrapped, reddened diffuse. */
function skinLighting(): string {
  const chunk = ShaderChunk.lights_physical_pars_fragment;
  if (!chunk.includes(DIFFUSE)) throw new Error('three lighting chunk changed: skin lighting must be updated');
  return chunk.replace(DIFFUSE, `{
    float rawNL = dot(geometryNormal, directLight.direction);
    float wrapped = saturate((rawNL + 0.45) / 1.45);
    float band = smoothstep(0.0, 0.32, wrapped) * smoothstep(0.66, 0.32, wrapped);
    vec3 lit = (vec3(wrapped) + band * vec3(0.30, 0.06, 0.03)) * directLight.color;
    reflectedLight.directDiffuse += lit * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
  }`);
}

/** Per person, shared by their skin materials so skin and make-up change live. */
export interface SkinUniforms {
  melanin: { value: number };
  /** -1 cool .. 1 warm. */
  undertone: { value: number };
  lipColour: { value: Color };
  lipAmount: { value: number };
  stubble: { value: number };
  stubbleColour: { value: Color };
  /** The colour of the hair where it leaves the skin (the follicle map's dots). */
  follicleColour: { value: Color };
}

export function skinUniforms(melanin: number): SkinUniforms {
  return {
    melanin: { value: melanin }, undertone: { value: 0 }, lipColour: { value: new Color(0xa03040) }, lipAmount: { value: 0 },
    stubble: { value: 0 }, stubbleColour: { value: new Color(0x2a1d16) }, follicleColour: { value: new Color(0x2a1d16) },
  };
}

type MelaninUniform = SkinUniforms;

function skinMaterial(tex: TextureSet, tile: number, look: HumanLook, melanin: MelaninUniform): MeshPhysicalMaterial {
  const light = tex.get(`Light_Skin_Color.${tile}`);
  const dark = tex.get(`Dark_Skin_Color.${tile}`);
  const m = new MeshPhysicalMaterial({
    color: light ? 0xffffff : look.flatSkin,
    map: light ?? null,
    roughnessMap: tex.get(`Skin_Roughness.${tile}`) ?? null,
    // The map is authored for Cycles' dual-lobe skin; one lobe here reads wet
    // unless it is rougher (skin's main lobe is about 0.5).
    roughness: light ? 1.35 : 0.55,
    bumpMap: tex.get(`Skin_Height.${tile}`) ?? null,
    bumpScale: 1.2,
    sheen: 0.25,
    sheenRoughness: 0.6,
    sheenColor: new Color(0.9, 0.75, 0.7),
    specularIntensity: 0.55,
  });
  // This tile's follicle map (each skin tile has its own), set by the stage.
  const follicle = { follicleMap: { value: null as Texture | null }, follicleOn: { value: 0 }, hairCover: { value: 1 } };
  m.userData['follicle'] = follicle;
  m.onBeforeCompile = (shader) => {
    shader.uniforms['darkMap'] = { value: dark ?? light ?? null };
    Object.assign(shader.uniforms, melanin, follicle);
    if (look.hairShadow) Object.assign(shader.uniforms, look.hairShadow);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aMasks;\nattribute float aHide;\nvarying vec3 vMasks;\nvarying float vHide;\nvarying vec3 vHairWorld;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMasks = aMasks;\nvHide = aHide;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvHairWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    if (look.hairShadow) {
      const chunk = ShaderChunk.lights_fragment_begin;
      if (!chunk.includes(DIR_LIGHT)) throw new Error('three lighting chunk changed: the hair shadow on skin must be updated');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <lights_fragment_begin>', `
          // The scalp under the hair is shut off from every light by the hair
          // over it, by how dense its roots are (the follicle map's blurred channel).
          float scalpOcc = 0.0;
          #ifdef USE_MAP
          if (follicleOn > 0.5) scalpOcc = 0.9 * hairCover * smoothstep(0.0, 1.0, texture2D(follicleMap, vMapUv).g);
          #endif
          ${chunk.replace(DIR_LIGHT, `${DIR_LIGHT}\ndirectLight.color *= 1.0 - scalpOcc;\n#if UNROLLED_LOOP_INDEX == 0\ndirectLight.color *= hairTransmittance(vHairWorld);\n#endif`)}`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          reflectedLight.indirectDiffuse *= 1.0 - scalpOcc;
          reflectedLight.indirectSpecular *= 1.0 - scalpOcc;`)
        .replace('#include <common>', `#include <common>\nvarying vec3 vHairWorld;\n${HAIR_SHADOW_GLSL}`);
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', skinLighting())
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (vHide > 0.5) discard;')
      .replace('#include <map_pars_fragment>', `#include <map_pars_fragment>
        uniform sampler2D darkMap;
        uniform float melanin, undertone, lipAmount, stubble, follicleOn, hairCover;
        uniform vec3 lipColour, stubbleColour, follicleColour;
        uniform sampler2D follicleMap;
        varying vec3 vMasks;
        varying float vHide;
        float skinHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }`);
    if (light) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
        vec4 lightSkin = texture2D( map, vMapUv );
        vec4 darkSkin = texture2D( darkMap, vMapUv );
        diffuseColor *= mix( lightSkin, darkSkin, melanin );
        // Undertone: warmer (olive-gold) or cooler (pink).
        diffuseColor.rgb *= vec3(1.0 + 0.05 * undertone, 1.0 + 0.015 * undertone, 1.0 - 0.07 * undertone);
        // Lipstick over the lips' mask.
        diffuseColor.rgb = mix(diffuseColor.rgb, lipColour * (0.55 + 0.45 * dot(diffuseColor.rgb, vec3(0.6))), lipAmount * vMasks.x);
        // Stubble: dark hair stumps, one per few texels, where a beard grows.
        float stump = step(0.55, skinHash(floor(vMapUv * 2600.0)));
        diffuseColor.rgb = mix(diffuseColor.rgb, stubbleColour, stubble * vMasks.y * (0.35 + 0.5 * stump));
        // A dark dot where each strand leaves the skin (the groom's follicle map, painted from its roots).
        if (follicleOn > 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, follicleColour, 0.9 * texture2D(follicleMap, vMapUv).r);`);
    }
  };
  m.customProgramCacheKey = () => `human-skin-${light ? 1 : 0}-${look.hairShadow ? 1 : 0}`;
  return m;
}

function material(name: string, tile: number, tex: TextureSet, look: HumanLook, melanin: MelaninUniform): Material {
  switch (name) {
    case 'Skin':
    case 'Covered':
      // `Covered` is the base's modesty patch (chest, groin): skin, with the
      // skin tiles' own texture there; clothes are what covers a person.
      return skinMaterial(tex, tile, look, melanin);
    case 'Iris':
      return new MeshStandardMaterial({
        map: tex.get(`Iris_Color.${tile}`) ?? null, color: look.iris,
        roughnessMap: tex.get(`Iris_Roughness.${tile}`) ?? null, bumpMap: tex.get(`Iris_Height.${tile}`) ?? null, bumpScale: 1,
      });
    case 'Pupil':
      return new MeshStandardMaterial({ color: 0x050505, roughness: 1 });
    case 'Sclera_Cornea':
      // Clear where the shell is cornea (vertex alpha from the pack's cornea
      // mask), white sclera elsewhere; glossy and wet either way.
      return new MeshPhysicalMaterial({
        map: tex.get(`Sclera_Color.${tile}`) ?? null, color: tex.get(`Sclera_Color.${tile}`) ? 0xffffff : 0xece6df,
        roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.03, transparent: true, vertexColors: true,
        bumpMap: tex.get(`Sclera_Height.${tile}`) ?? null, bumpScale: 0.5,
      });
    case 'Mouth':
      return new MeshPhysicalMaterial({
        map: tex.get(`Mouth_Color.${tile}`) ?? null, color: tex.get(`Mouth_Color.${tile}`) ? 0xffffff : 0xb06060,
        roughnessMap: tex.get(`Mouth_Roughness.${tile}`) ?? null, roughness: 1,
        bumpMap: tex.get(`Mouth_Height.${tile}`) ?? null, bumpScale: 0.5,
      });
    case 'Tearline':
      return new MeshPhysicalMaterial({ color: 0xffffff, roughness: 0, transparent: true, opacity: 0.2, depthWrite: false });
    case 'EyeHair':
      return new MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 });
    default:
      return new MeshStandardMaterial({ color: 0x8f8a84, roughness: 0.9 });
  }
}

/**
 * A mesh for one person. `shape` is the morphed base (one xyz per mesh
 * vertex); the mesh stands with its lowest point on y = 0.
 */
export function createHumanMesh(base: HumanBase, tex: TextureSet, shape: Float32Array, look: HumanLook, masks?: Float32Array): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(standing(base, shape), 3));
  geometry.setAttribute('normal', new BufferAttribute(base.renderNormals(shape), 3));
  geometry.setAttribute('uv', new BufferAttribute(base.renderUv, 2));
  const cornea = base.cornea;
  if (cornea) {
    // RGBA vertex colour: white, alpha 1 on sclera and nearly 0 on cornea.
    const colours = new Float32Array(base.renderVertexCount * 4);
    for (let r = 0; r < base.renderVertexCount; r++) {
      colours.fill(1, r * 4, r * 4 + 3);
      colours[r * 4 + 3] = 1 - 0.94 * (cornea[base.renderSource[r]!]! / 255);
    }
    geometry.setAttribute('color', new BufferAttribute(colours, 4));
  }
  geometry.setAttribute('aMasks', new BufferAttribute(masks ?? new Float32Array(base.renderVertexCount * 3), 3));
  // 1 where a garment covers the skin (its .mhclo delete_verts): not drawn, so the body never shows through the cloth.
  geometry.setAttribute('aHide', new BufferAttribute(new Float32Array(base.renderVertexCount), 1));
  geometry.setIndex(new BufferAttribute(base.index, 1));
  const materials: Material[] = [];
  const melanin: MelaninUniform = skinUniforms(look.melanin);
  for (const g of base.meta.groups) {
    geometry.addGroup(g.start, g.count, materials.length);
    const m = material(g.material, g.tile, tex, look, melanin);
    // Named by the pack's material: the stage finds the eyes and mouth by it.
    m.name = g.material;
    materials.push(m);
  }
  geometry.computeBoundingSphere();
  const mesh = new Mesh(geometry, materials);
  mesh.castShadow = true;
  // No shadow map on the person themselves: a hard self-shadow (the chin's
  // on the neck) is grey on skin without light scattered under it, and read
  // as a stain; the wrapped skin shading darkens those places softly.
  mesh.receiveShadow = false;
  mesh.userData['skin'] = melanin;
  mesh.userData['floor'] = lastFloor;
  return mesh;
}

let lastFloor = 0;

/** Render positions with the lowest point on y = 0 (`userData.floor` keeps how far it moved). */
function standing(base: HumanBase, shape: Float32Array, out?: Float32Array): Float32Array {
  const positions = base.renderPositions(shape, out);
  let lo = Infinity;
  for (let i = 1; i < positions.length; i += 3) lo = Math.min(lo, positions[i]!);
  for (let i = 1; i < positions.length; i += 3) positions[i] = positions[i]! - lo;
  lastFloor = lo;
  return positions;
}

/** Reshapes a person's mesh in place (no new buffers or materials) and sets their skin tone. */
export function updateHumanMesh(mesh: Mesh, base: HumanBase, shape: Float32Array, melanin: number): void {
  const pos = mesh.geometry.getAttribute('position') as BufferAttribute;
  const nor = mesh.geometry.getAttribute('normal') as BufferAttribute;
  standing(base, shape, pos.array as Float32Array);
  mesh.userData['floor'] = lastFloor;
  base.renderNormals(shape, nor.array as Float32Array);
  pos.needsUpdate = true;
  nor.needsUpdate = true;
  mesh.geometry.computeBoundingSphere();
  mesh.geometry.computeBoundingBox();
  (mesh.userData['skin'] as SkinUniforms).melanin.value = melanin;
}

/** Sets the iris colour of a person's eyes. */
export function setIris(mesh: Mesh, colour: number): void {
  for (const m of mesh.material as Material[]) {
    if (m.name === 'Iris') (m as MeshStandardMaterial).color.setHex(colour);
  }
}

export function disposeHumanMesh(mesh: Mesh): void {
  mesh.geometry.dispose();
  for (const m of mesh.material as Material[]) m.dispose();
}
