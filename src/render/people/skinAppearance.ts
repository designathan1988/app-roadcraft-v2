import { CanvasTexture, Color, DataTexture, ShaderChunk, SRGBColorSpace, TextureLoader, type BufferGeometry, type MeshStandardMaterial, type Texture } from 'three';
import type { PersonSpec } from '@people/spec';
import { loadProxyItem, proxyUrl, type ProxyItem } from '@people/body/proxy';
import { MAX_TEXTURED, texturedGarments } from './garmentSlots';
import { padGarmentInWorker } from './garmentPaddingPool';
import { cancelUploads, queueUpload } from '../uploads';
import index from '../../../public/models/people/skins/index.json';
const urls = import.meta.glob('../../../public/models/people/skins/*.webp', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

export interface SkinAppearance { texture: Texture; tint: Color; hair: Color; hairTexture?: Texture; browTexture?: Texture; lashTexture?: Texture; beardTexture?: Texture; garments: (Texture | null)[]; outfitTint: Color | null; beard: number; makeup: number }

/** Existing CC0 skin pack, selected by the authored body; no new asset downloads. */
export async function loadSkinAppearance(person: PersonSpec): Promise<SkinAppearance> {
  const b = person.body;
  const origin = b.african > b.asian && b.african > b.caucasian ? 'african'
    : b.asian > b.caucasian ? 'asian' : 'caucasian';
  const age = b.age > 0.8 ? 'old' : b.age > 0.6 ? 'middleage' : 'young';
  const sex = b.gender < 0.5 ? 'female' : 'male';
  // Each person their own skin among those of their origin, sex and age (the
  // system pack had one per kind, so a street of one face), and a made-up
  // face for the women who wear make-up.
  type Skin = (typeof index.skins)[number] & { makeup?: boolean };
  const skins = index.skins as Skin[];
  const madeUp = sex === 'female' && (person.look.makeup ?? 0) > 0;
  const fits = (s: Skin): boolean => s.origin === origin && s.sex === sex && !!s.makeup === madeUp;
  const pool = skins.filter(s => fits(s) && s.age === age);
  const candidates = pool.length ? pool : skins.filter(fits).length ? skins.filter(fits)
    : skins.filter(s => s.origin === origin && s.sex === sex && !s.makeup);
  const skin = candidates[Math.abs(person.id * 2654435761 >>> 0) % candidates.length] ?? index.skins[0]!;
  const url = urls[`../../../public/models/people/skins/${skin.name}.webp`];
  if (!url) throw new Error(`Missing skin texture: ${skin.name}`);
  const skinLease = acquireTexture(SKINS, skin.name, async () => {
    const map = await new TextureLoader().loadAsync(url);
    map.colorSpace = SRGBColorSpace;
    return map;
  });
  const skinRequest = skinLease.texture;
  const average = new Color().setRGB(skin.average[0]! / 255, skin.average[1]! / 255, skin.average[2]! / 255, SRGBColorSpace);
  const desired = new Color(person.look.skin);
  // Match the texture's brightness to the person's skin and only a little of
  // its hue: the texture, chosen by origin, carries a natural hue of its own.
  // Scaling each channel to the target turned a rosy (made-up) texture green.
  const lum = (c: Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const bright = lum(desired) / Math.max(0.01, lum(average));
  const hue = 0.3;
  const tint = new Color().setRGB(
    bright + (desired.r / Math.max(0.01, average.r) - bright) * hue,
    bright + (desired.g / Math.max(0.01, average.g) - bright) * hue,
    bright + (desired.b / Math.max(0.01, average.b) - bright) * hue);
  const garmentNames = texturedGarments(person.look);
  const leases: TextureLease[] = [skinLease];
  let texture: Texture | undefined;
  // Every card item - hair, brows, lashes, a beard - with its own texture,
  // so its strands are drawn per pixel.
  const cardTexture = async (name: string | undefined): Promise<Texture | undefined> => {
    if (!name || name === 'none') return undefined;
    const item = await loadProxyItem(name);
    if (!item.textureFile) return undefined;
    const lease = acquireTexture(CARDS, item.textureFile, async () => {
      const map = await new TextureLoader().loadAsync(proxyUrl(item.textureFile!));
      map.colorSpace = SRGBColorSpace;
      map.flipY = false;
      return map;
    });
    leases.push(lease);
    return lease.texture;
  };
  let hairTexture: Texture | undefined;
  let browTexture: Texture | undefined;
  let lashTexture: Texture | undefined;
  let beardTexture: Texture | undefined;
  const release = (): void => {
    for (const lease of leases) lease.release();
  };
  try {
    const garmentRequests = garmentNames.map(async name => {
      if (!name || name === 'none') return null;
      const item = await loadProxyItem(name);
      if (!item.textureFile) return null;
      const lease = paddedGarment(name, item);
      leases.push(lease);
      return lease.texture;
    });
    const beardName = (person.look.extras ?? []).find((e) => /beard|moustache|goatee|stubble|sideburn/i.test(e));
    // Every request begins now; all settle before cleanup so an error cannot
    // leave a late texture or garment lease behind.
    const requests: Promise<Texture | null | undefined>[] = [skinRequest, ...garmentRequests,
      cardTexture(person.look.hairCut), cardTexture(person.look.brows),
      cardTexture(person.look.lashes), cardTexture(beardName)];
    const settled = await Promise.allSettled(requests);
    const loaded = settled.map((result) => result.status === 'fulfilled' ? result.value : null);
    texture = loaded[0] ?? undefined;
    const cardStart = garmentNames.length + 1;
    hairTexture = loaded[cardStart] ?? undefined;
    browTexture = loaded[cardStart + 1] ?? undefined;
    lashTexture = loaded[cardStart + 2] ?? undefined;
    beardTexture = loaded[cardStart + 3] ?? undefined;
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    if (!texture) throw new Error(`Missing loaded skin texture: ${skin.name}`);
    const garments = loaded.slice(1, cardStart).map((map) => map ?? null);
    // Sent to the GPU ahead of the first frame this person is drawn in.
    queueUpload(texture, ...garments, hairTexture, browTexture, lashTexture, beardTexture);
    const appearance: SkinAppearance = { texture, tint, hair: new Color(person.look.hair), garments,
      outfitTint: person.look.outfitTint == null ? null : new Color(person.look.outfitTint),
      ...(hairTexture ? { hairTexture } : {}),
      ...(browTexture ? { browTexture } : {}),
      ...(lashTexture ? { lashTexture } : {}),
      ...(beardTexture ? { beardTexture } : {}),
      beard: ['none', 'stubble', 'moustache', 'beard'].indexOf(person.look.beard ?? 'none'), makeup: person.look.makeup ?? 0 };
    RELEASE.set(appearance, release);
    return appearance;
  } catch (error) {
    release();
    throw error;
  }
}

const RELEASE = new WeakMap<SkinAppearance, () => void>();

/** Releases one user's textures without invalidating another person's shared garment. */
export function releaseSkinAppearance(appearance: SkinAppearance): void {
  const release = RELEASE.get(appearance);
  if (!release) return;
  RELEASE.delete(appearance);
  release();
}

/** Extends the crowd shader after its bone-palette hook, preserving one draw batch. */
export function applySkinAppearance(material: MeshStandardMaterial, geometry: BufferGeometry, skin: SkinAppearance): void {
  if (!geometry.hasAttribute('skinMask')) return;
  const before = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  const detail = { value: 1 };
  material.userData['appearanceDetail'] = detail;
  // ONE shader program for every dressed person: the same samplers and the
  // same code whoever wears what, a blank texture where a slot is empty and
  // flags where a card has no texture of its own. Keyed on what each person
  // wore, a new mix of garments compiled a new program the moment its
  // wearer came into view: a 50-200 ms hitch each time.
  const texturedHair = geometry.hasAttribute('hairMask');
  const texturedGarments = geometry.hasAttribute('garmentSlot');
  if (texturedHair) { material.alphaToCoverage = true; material.alphaTest = 0.35; }
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.uniforms.personSkin = { value: skin.texture };
    shader.uniforms.appearanceDetail = detail;
    shader.uniforms.personSkinTint = { value: skin.tint };
    shader.uniforms.faceOrigin = { value: geometry.userData['faceOrigin'] };
    shader.uniforms.faceScale = { value: geometry.userData['faceScale'] ?? 0.2 };
    shader.uniforms.beardColour = { value: skin.hair };
    shader.uniforms.beardStyle = { value: skin.beard };
    shader.uniforms.makeupAmount = { value: skin.makeup };
    if (texturedGarments) {
      shader.uniforms.outfitDye = { value: skin.outfitTint ?? new Color(0xffffff) };
      shader.uniforms.outfitDyed = { value: skin.outfitTint ? 1 : 0 };
      for (let i = 0; i < GARMENT_SLOTS; i++) shader.uniforms[`garment${i}`] = { value: skin.garments[i] ?? blank() };
    }
    if (texturedHair) {
      shader.uniforms.personHair = { value: skin.hairTexture ?? blank() };
      shader.uniforms.personBrow = { value: skin.browTexture ?? blank() };
      shader.uniforms.personLash = { value: skin.lashTexture ?? blank() };
      shader.uniforms.personBeard = { value: skin.beardTexture ?? blank() };
      shader.uniforms.cardTextures = { value: [skin.hairTexture, skin.browTexture, skin.lashTexture, skin.beardTexture].map((t) => (t ? 1 : 0)) };
    }
    shader.vertexShader = `attribute float skinMask; uniform vec3 faceOrigin; uniform float faceScale; varying float vSkinMask; varying vec2 vSkinUv; varying vec3 vFace;\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSkinMask = skinMask; vSkinUv = uv; vFace = (position - faceOrigin) / faceScale;');
    shader.fragmentShader = `uniform float appearanceDetail; uniform sampler2D personSkin; uniform vec3 personSkinTint; uniform vec3 beardColour; uniform float beardStyle; uniform float makeupAmount; varying float vSkinMask; varying vec2 vSkinUv; varying vec3 vFace;\n${shader.fragmentShader}`
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (appearanceDetail > 0.5 && vSkinMask > 0.0) {
        vec3 skinColour = texture2D(personSkin, vSkinUv).rgb * personSkinTint;
        float front = smoothstep(-0.12, 0.02, vFace.z);
        float lips = (1.0 - smoothstep(0.65, 1.0, length(vFace.xy / vec2(0.22, 0.045)))) * front;
        float cheeks = exp(-30.0 * (pow(abs(vFace.x) - 0.32, 2.0) + pow(vFace.y - 0.18, 2.0))) * front;
        skinColour = mix(skinColour, skinColour * vec3(1.05, 0.55, 0.6), makeupAmount * max(lips, cheeks * 0.25));
        // Beards are fitted MakeHuman items now (wornItems), not paint: a
        // painted stubble region missed the jaw and lay across the nose as a
        // dark mask.
        diffuseColor.rgb = mix(diffuseColor.rgb, skinColour, vSkinMask);
        }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.5, vSkinMask * appearanceDetail);');
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>',
      ShaderChunk.lights_physical_pars_fragment.replace(
        'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );',
        'reflectedLight.directDiffuse += mix(irradiance, saturate((dot(geometryNormal, directLight.direction) + 0.15) / 1.15) * directLight.color, vSkinMask * appearanceDetail) * BRDF_Lambert(material.diffuseColor);'));
    if (texturedHair) {
      // Brows and lashes are cards laid on the skin. Laid exactly on it, the
      // skin won the depth test over most of them - the brows sank into the
      // face in dashes - and the crowd's camera, with its long depth range,
      // cannot tell millimetres apart. As layered surfaces are fixed in
      // character pipelines: lifted a little off the skin along the normal,
      // and drawn with a small depth bias towards the eye (a decal's bias),
      // both in proportion to the body's scale.
      shader.vertexShader = `attribute float hairMask; varying float vHairMask;\n${shader.vertexShader}`
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vHairMask = hairMask;
float cardSlot = floor(hairMask + 0.5);
bool faceCard = cardSlot > 1.5 && cardSlot < 3.5;
if (faceCard) transformed += normalize(objectNormal) * 0.002;`)
        .replace('#include <project_vertex>', `#include <project_vertex>
if (faceCard) {
  float bodyScale = length(modelViewMatrix[0].xyz);
  #ifdef USE_INSTANCING
    bodyScale *= length(instanceMatrix[0].xyz);
  #endif
  mvPosition.z += 0.004 * bodyScale;
  gl_Position = projectionMatrix * mvPosition;
}`);
      shader.fragmentShader = `uniform sampler2D personHair; uniform sampler2D personBrow; uniform sampler2D personLash; uniform sampler2D personBeard; uniform float cardTextures[4]; varying float vHairMask;\n${shader.fragmentShader}`
        .replace('#include <alphatest_fragment>', `
          // A card: hair (1), brows (2), lashes (3) or a beard (4), each from its
          // own texture. The strands take the person's hair colour, shaded by
          // the texture's own light and dark; where the card fades out its
          // colour stays the hair's, not the texture's white backing (the white
          // fringe round every head of hair).
          // The card's texture footprint per pixel, taken before any branch
          // (derivatives need every pixel of a quad to run them).
          vec2 cardDx = dFdx(vSkinUv), cardDy = dFdy(vSkinUv);
          float eyeSlot = floor(vHairMask + 0.5);
          if (eyeSlot > 4.5) {
            // The eyeball: wet. MakeHuman's own advice for eyes that look
            // dead - a hard glossy highlight over them (static.makehumancommunity
            // .org, "The eyes look flat and dead"); the body's matte 0.88 made
            // them dull grey glass.
          } else
          if (vHairMask > 0.5 && appearanceDetail > 0.5) {
            vec4 cardTexel = vec4(0.0);
            float slot = floor(vHairMask + 0.5);
            if (slot < 1.5) { cardTexel = cardTextures[0] > 0.5 ? texture2D(personHair, vSkinUv) : vec4(0.5, 0.5, 0.5, 1.0); }
            else if (slot < 2.5) { cardTexel = cardTextures[1] > 0.5 ? texture2D(personBrow, vSkinUv) : vec4(0.5, 0.5, 0.5, 1.0); }
            else if (slot < 3.5) { cardTexel = cardTextures[2] > 0.5 ? texture2D(personLash, vSkinUv) : vec4(0.2, 0.2, 0.2, 1.0); }
            else { cardTexel = cardTextures[3] > 0.5 ? texture2D(personBeard, vSkinUv) : vec4(0.5, 0.5, 0.5, 1.0); }
            // Fine strands thin out and vanish in a texture's smaller mips: a
            // brow seen from a little way off was a few dashes. Its alpha is
            // scaled up by the mip level the pixel reads, keeping the strands'
            // coverage (Ben Golus, "Anti-aliased Alpha Test"; I. Castano,
            // "Computing Alpha Mipmaps"; as OpenMW's alpha.glsl does it).
            vec2 cardSize = slot < 1.5 ? vec2(textureSize(personHair, 0)) : slot < 2.5 ? vec2(textureSize(personBrow, 0))
              : slot < 3.5 ? vec2(textureSize(personLash, 0)) : vec2(textureSize(personBeard, 0));
            float cardMip = max(0.0, 0.5 * log2(max(dot(cardDx * cardSize, cardDx * cardSize), dot(cardDy * cardSize, cardDy * cardSize))));
            cardTexel.a *= 1.0 + cardMip * 0.25;
            if (slot > 1.5 && slot < 2.5 && cardTextures[1] > 0.5) cardTexel.a = min(1.0, cardTexel.a * 1.55);
            if (slot > 2.5 && slot < 3.5 && cardTextures[2] > 0.5) cardTexel.a *= 0.65;
            float strand = dot(cardTexel.rgb, vec3(0.3, 0.59, 0.11));
            // The source's grey strand highlights are sRGB, now sampled in
            // linear light. Multiplying them by dark hair dye erased them.
            // Keep a restrained light-coloured reflection on hair cards only.
            vec3 hairCol = slot > 2.5 && slot < 3.5 ? vec3(0.03)
              : beardColour * (0.55 + 0.95 * strand) + (slot < 1.5 ? vec3(0.12 * sqrt(strand)) : vec3(0.0));
            diffuseColor.rgb = mix(beardColour * 0.55, hairCol, smoothstep(0.25, 0.75, cardTexel.a));
            diffuseColor.a = cardTexel.a;
          }
          #include <alphatest_fragment>`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (vHairMask > 4.5) roughnessFactor = 0.06;\nelse if (vHairMask > 0.5) roughnessFactor = 0.42;');
    }
    if (texturedGarments) {
      shader.vertexShader = `attribute float garmentSlot; varying float vGarmentSlot;\n${shader.vertexShader}`
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGarmentSlot = garmentSlot;');
      const uniforms = Array.from({ length: GARMENT_SLOTS }, (_, i) => `uniform sampler2D garment${i};`).join('\n');
      shader.fragmentShader = `uniform vec3 outfitDye; uniform float outfitDyed; varying float vGarmentSlot; ${uniforms}\n${shader.fragmentShader}`;
      const sample = Array.from({ length: GARMENT_SLOTS }, (_, i) => `
        if (appearanceDetail > 0.5 && abs(vGarmentSlot - ${i + 1}.0) < 0.1) {
          vec3 cloth = texture2D(garment${i}, vSkinUv).rgb;
          ${i === 0 ? 'float shade = 0.3 + 1.15 * dot(cloth, vec3(0.3, 0.59, 0.11)); cloth = mix(cloth, min(vec3(1.0), outfitDye * shade), outfitDyed * 0.8);' : ''}
          diffuseColor.rgb = cloth;
        }`).join('\n');
      shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `${sample}\n#include <alphatest_fragment>`);
    }
  };
  material.customProgramCacheKey = () => `${key}-textured-skin-v3-hair${texturedHair}-garments${texturedGarments}`;
}

/** How far each island of a garment's texture is grown into its background, pixels. */
const GARMENT_PAD = 12;
interface TextureEntry { promise: Promise<Texture>; texture?: Texture; refs: number }
interface TextureLease { texture: Promise<Texture>; release(): void }
const PADDED = new Map<string, TextureEntry>();
const SKINS = new Map<string, TextureEntry>();
const CARDS = new Map<string, TextureEntry>();

function acquireTexture(cache: Map<string, TextureEntry>, key: string, build: () => Promise<Texture>): TextureLease {
  let entry = cache.get(key);
  if (!entry) {
    const work = build();
    const current: TextureEntry = { promise: work, refs: 0 };
    current.promise = work.then((texture) => {
      current.texture = texture;
      return texture;
    }, (error: unknown) => {
      if (cache.get(key) === current) cache.delete(key);
      throw error;
    });
    cache.set(key, current);
    entry = current;
  }
  const held = entry;
  held.refs++;
  let released = false;
  return {
    texture: held.promise,
    release() {
      if (released) return;
      released = true;
      if (--held.refs !== 0) return;
      if (cache.get(key) === held) cache.delete(key);
      if (held.texture) {
        cancelUploads([held.texture]);
        held.texture.dispose();
      } else {
        void held.promise.then((texture) => {
          cancelUploads([texture]);
          texture.dispose();
        }, () => {});
      }
    },
  };
}

/**
 * A garment's texture with every UV island grown outward into the background
 * (texture padding, as every game asset pipeline does). Unpadded, the smaller
 * mip levels mixed each island with the background and with its neighbours
 * on the sheet, and every seam - the shoulder of every shirt - was drawn as a
 * brown line. The islands are the garment's own UV triangles, rasterised.
 */
function paddedGarment(name: string, item: ProxyItem): TextureLease {
  return acquireTexture(PADDED, name, async () => {
      const url = proxyUrl(item.textureFile!);
      const plain = async (): Promise<Texture> => {
        const map = await new TextureLoader().loadAsync(url);
        map.colorSpace = SRGBColorSpace; map.flipY = false;
        return map;
      };
      const uvs = item.pack.uvs;
      if (!uvs || typeof createImageBitmap !== 'function' || typeof document === 'undefined') return plain();
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const W = bitmap.width, H = bitmap.height;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return plain();
      ctx.drawImage(bitmap, 0, 0);
      const image = ctx.getImageData(0, 0, W, H);
      const pixels = await padGarmentInWorker({ pixels: image.data, width: W, height: H,
        uvs, index: item.pack.index, padding: GARMENT_PAD });
      if (pixels !== image.data) image.data.set(pixels);
      ctx.putImageData(image, 0, 0);
      const map = new CanvasTexture(canvas);
      map.colorSpace = SRGBColorSpace;
      map.flipY = false;
      return map;
    });
}

/** Garment textures a person's shader always has room for (`garmentSlots.ts`): with the skin, the hair cards and the bone palette, within a GPU's sixteen texture units. */
const GARMENT_SLOTS = MAX_TEXTURED;
let blankTexture: DataTexture | null = null;
/** A 1x1 grey texture for an empty slot, shared. */
function blank(): DataTexture {
  if (!blankTexture) {
    blankTexture = new DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    blankTexture.needsUpdate = true;
  }
  return blankTexture;
}
