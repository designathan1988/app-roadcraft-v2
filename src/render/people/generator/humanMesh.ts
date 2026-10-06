import {
  BufferAttribute, BufferGeometry, Color, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, NoColorSpace,
  ShaderChunk, SRGBColorSpace, TextureLoader, type Material, type Texture,
} from 'three';
import type { HumanBase } from '@people/gen/humanBase';

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
}

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

/** Per person, shared by their skin materials so the skin tone can change live. */
type MelaninUniform = { value: number };

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
  m.onBeforeCompile = (shader) => {
    shader.uniforms['darkMap'] = { value: dark ?? light ?? null };
    shader.uniforms['melanin'] = melanin;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', skinLighting())
      .replace('#include <map_pars_fragment>', '#include <map_pars_fragment>\nuniform sampler2D darkMap;\nuniform float melanin;');
    if (light) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
        vec4 lightSkin = texture2D( map, vMapUv );
        vec4 darkSkin = texture2D( darkMap, vMapUv );
        diffuseColor *= mix( lightSkin, darkSkin, melanin );`);
    }
  };
  m.customProgramCacheKey = () => `human-skin-${light ? 1 : 0}`;
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
export function createHumanMesh(base: HumanBase, tex: TextureSet, shape: Float32Array, look: HumanLook): Mesh {
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
  geometry.setIndex(new BufferAttribute(base.index, 1));
  const materials: Material[] = [];
  const melanin: MelaninUniform = { value: look.melanin };
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
  mesh.userData['melanin'] = melanin;
  return mesh;
}

/** Render positions with the lowest point on y = 0. */
function standing(base: HumanBase, shape: Float32Array, out?: Float32Array): Float32Array {
  const positions = base.renderPositions(shape, out);
  let lo = Infinity;
  for (let i = 1; i < positions.length; i += 3) lo = Math.min(lo, positions[i]!);
  for (let i = 1; i < positions.length; i += 3) positions[i] = positions[i]! - lo;
  return positions;
}

/** Reshapes a person's mesh in place (no new buffers or materials) and sets their skin tone. */
export function updateHumanMesh(mesh: Mesh, base: HumanBase, shape: Float32Array, melanin: number): void {
  const pos = mesh.geometry.getAttribute('position') as BufferAttribute;
  const nor = mesh.geometry.getAttribute('normal') as BufferAttribute;
  standing(base, shape, pos.array as Float32Array);
  base.renderNormals(shape, nor.array as Float32Array);
  pos.needsUpdate = true;
  nor.needsUpdate = true;
  mesh.geometry.computeBoundingSphere();
  mesh.geometry.computeBoundingBox();
  (mesh.userData['melanin'] as MelaninUniform).value = melanin;
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
