import { CAPTURE_NAME } from './personRig';
import type { Severable } from '@sim/people/view';
import {
  BufferGeometry, Color, DataTexture, DoubleSide, Float32BufferAttribute, FloatType, Group, InstancedBufferAttribute,
  InstancedMesh, Matrix4, MeshDepthMaterial, MeshStandardMaterial, Vector3, NearestFilter, RedFormat, RGBADepthPacking, RGBAFormat,
  Uint16BufferAttribute, UnsignedByteType, type Material, type Texture,
} from 'three';
import { loadPeopleAssets, type PeopleAssets } from '@people/body/assets';
import { Morpher, bodyHeight } from '@people/body/morph';
import { DEFAULT_MACRO, yearsFromAge, ageFromYears, type MacroParams } from '@people/body/macro';
import { loadProxyItem, type ProxyItem, type ProxyPack } from '@people/body/proxy';
import { DEFAULT_LOOK, wornItems, type PersonLook, type PersonSpec } from '@people/spec';
import { FEMALE_HAIR, HAIR_STYLES, MALE_HAIR, generateHair, generateHairStrands, generateHeadband, type HairBase, type HairStyle } from '@people/hair/procedural';
import { hairStrandTexture } from './hairTexture';
import { compileAhead } from '../uploads';
import { clipFields, clipOf, loadProcedural, packRecord, proceduralCookHash } from './proceduralCook';
import type { PackRecord, PackValue } from './cookPack';
import { CHANNELS, channelShapes, faceAt } from './faceExpression';
import { expressionShapes } from '@people/body/expressions';
import { createPersonRig, type PersonRig } from './personRig';
import { itemTexture, personLighting, skinChoice, skinTextures } from './skinAppearance';
import { captureBind, captureBindRotations, loadRocketboxClips, type WalkSex } from '../citizenWalk';
import { bakeLibraryClip, bakeWalk, breathe, restRig, type ClipFrames } from '../citizenBake';
import { PACKED_BONE_FLOATS, SKIN_BONE_FLOATS, blendPackedFrames } from '../citizenPalette';

/**
 * Procedural people (`people-lab.html`, then the game): one MakeHuman body
 * per class - sex and age band - rigged and animated once; every person is
 * numbers on it.
 *
 * - Body shape: the macro model's first `SHAPES` principal components
 *   (`Morpher.component`), each baked once per class as moves of every base
 *   vertex in the bind posture (`PersonRig.deltas`) into one float texture.
 *   A person is `SHAPES` coefficients - their sliders less the class's - in a
 *   row of another; the vertex shader sums them. Height is the instance's
 *   scale, so the skeleton stays the class's.
 * - Clothes, shoes, hair, brows, lashes, hats: separate instanced pieces, one
 *   mesh per class and item, fitted once to the class body (`PersonRig.wear`).
 *   A piece vertex is pinned to three body vertices (the MakeHuman proxy
 *   `refs`), so it reads the same shape texture through them and follows the
 *   body it is on - no shape data of its own.
 * - Skin under a garment: the item's `deleteVerts` as a row of a cover
 *   texture; a body vertex any worn garment covers sinks under it.
 * - Skeleton: a row of a bone palette texture per person (`aRow`), blended
 *   from the class's baked clips each frame, as the crowd's is.
 *
 * Shapes as principal components blended on the GPU follow "Crowd Rendering"
 * in Assassin's Creed Unity (GDC 2015); pieces bound to one skeleton follow
 * Unreal's modular characters (Leader Pose); hiding the skin under clothes by
 * the clothes' own list is MakeHuman's `delete_verts`.
 */

/** Principal components carried per body: 16 keep a body within about 1.5 cm of the full model. */
export const SHAPES = 16;
const SHAPE_WIDTH = 4096;
/** Rows of a person's own face (`procFace`) are this wide; the vertex-to-face index (`procFaceIndex`) this wide. */
const FACE_WIDTH = 2048;
const FACE_INDEX_WIDTH = 4096;
/** The face's expression channels (`faceExpression.ts`: blink, joy, sadness, anger, surprise, brows, visemes), padded to 12. */
const EXPR = Object.keys(CHANNELS).slice(0, 12);
const EXPR_SLOTS = 12;
const COVER_WIDTH = 4096;
/** How far skin under a garment sinks, metres. */
const SINK = 0.025;

export type AgeBand = 'child' | 'young' | 'adult' | 'senior';
const BAND_YEARS: Readonly<Record<AgeBand, number>> = { child: 9, young: 22, adult: 42, senior: 72 };

/** A class's own body: the middle of every slider at the band's age. */
export function classBase(sex: WalkSex, band: AgeBand): MacroParams {
  return { ...DEFAULT_MACRO, gender: sex === 'female' ? 0 : 1, age: ageFromYears(BAND_YEARS[band]),
    muscle: 0.5, weight: 0.5, height: 0.5, proportions: 0.5, african: 1 / 3, asian: 1 / 3, caucasian: 1 / 3 };
}

export function bandOf(years: number): AgeBand {
  return years < 14 ? 'child' : years < 32 ? 'young' : years < 58 ? 'adult' : 'senior';
}

/** A garment that hides the skin under it (as `dressedGeometry` decides). */
const COVERING = new Set(['clothes', 'shoes', 'top', 'bottom', 'skirt', 'dress', 'suit', 'gloves']);

type Kind = 'skin' | 'cloth' | 'hair' | 'face';

interface Piece {
  readonly name: string;
  readonly kind: Kind;
  readonly mesh: InstancedMesh;
  readonly rows: InstancedBufferAttribute;
  readonly dyes: InstancedBufferAttribute;
  readonly worn: InstancedBufferAttribute | null;
  readonly tints: InstancedBufferAttribute | null;
  people: ProceduralPerson[];
  readonly vertices: number;
  /** Settles once its shaders are built and it is in the scene (`makePiece`). */
  readonly ready: Promise<void>;
}

interface BodyClass {
  readonly key: string;
  readonly sex: WalkSex;
  readonly band: AgeBand;
  readonly base: MacroParams;
  readonly shape: Float32Array;
  readonly coefficients: Float64Array;
  readonly rig: PersonRig;
  readonly height: number;
  readonly clips: { walk: ClipFrames; idle: ClipFrames; run: ClipFrames; cower: ClipFrames };
  readonly bones: number;
  /** Bones parents first, and each one's parent (-1 for the root). */
  readonly order: readonly number[];
  readonly parent: Int16Array;
  /** Each bone's head per unit of each shape coefficient, metres: [bone][k][xyz]. */
  readonly jointBasis: Float32Array;
  readonly uniforms: {
    procBones: { value: DataTexture };
    procCoef: { value: DataTexture };
    procShape: { value: DataTexture };
    procCover: { value: DataTexture };
    procCoverRows: { value: number };
    procFace: { value: DataTexture };
    procFaceIndex: { value: DataTexture };
    procFaceRows: { value: number };
    procExpr: { value: DataTexture };
    procExprW: { value: DataTexture };
  };
  palette: Float32Array;
  /** Each person's own face (their regional sliders: nose, jaw, eyes, mouth...) as moves of the head's vertices, `faceRows` rows each. */
  face: Float32Array;
  /** Each person's expression weights now, `EXPR_SLOTS` a row. */
  exprW: Float32Array;
  readonly faceVerts: Int32Array;
  coef: Float32Array;
  rows: number;
  capacity: number;
  readonly cover: Map<string, number>;
  readonly body: BufferGeometry;
  readonly skins: Map<string, Piece>;
  readonly pieces: Map<string, Piece>;
  readonly people: ProceduralPerson[];
}

export interface ProceduralPerson {
  readonly spec: PersonSpec;
  readonly band: AgeBand;
  readonly sex: WalkSex;
  /** Their row in the class's palette and shape textures. */
  readonly row: number;
  /** Standing height over the class body's, the instance's scale. */
  readonly scale: number;
  /** Metres. */
  readonly height: number;
  readonly items: readonly string[];
  /** Their grown hairstyle's item (`hair:...`) and colour, for its strands close up. */
  readonly grown: string | null;
  readonly hairColour: Color;
  /** How far each of their joints is from the class body's, metres (`jointBasis`). */
  readonly joints: Float32Array;
  /** Where they stand and face; what they play. Set by the caller each frame. */
  readonly matrix: Matrix4;
  clip: 'walk' | 'idle' | 'run' | 'cower';
  phase: number;
  /** What they are doing, as the face shows it (`faceAt`): 'talk', 'panic'... */
  activity?: string | undefined;
  /** Limbs (or the head) lost to shots: their bones closed at the joint they were torn from. Set by the caller. */
  lost?: readonly Severable[] | undefined;
}

export interface ProceduralStats {
  readonly classes: number;
  readonly people: number;
  readonly pieces: number;
  readonly draws: number;
  readonly items: number;
  readonly vertices: number;
  readonly textureBytes: number;
  readonly bakeMs: number;
}

const ROW_START = 64;

/** Colours a generated accessory (a headband) is dyed. */
const ACCESSORY_COLOURS = [0xc0392b, 0x1f3a93, 0xf2f0ea, 0x111111, 0xd35400, 0x8e44ad, 0x16a085] as const;

let plain: DataTexture | null = null;
/** A white texel, for a piece with no texture of its own. */
function plainTexture(): DataTexture {
  if (!plain) {
    plain = new DataTexture(new Uint8Array([160, 160, 160, 255]), 1, 1, RGBAFormat, UnsignedByteType);
    plain.needsUpdate = true;
  }
  return plain;
}

/**
 * What a person wears here: their own look, or - for a child, whom the
 * generator dresses in the old tailored shells - a casual outfit for their
 * sex and shoes, dyed their shirt colour. MakeHuman garments fit any body by
 * their reference vertices and scale axes, so an outfit sits on a child body
 * as on an adult one.
 */
export function proceduralLook(spec: PersonSpec, hair = true): PersonLook {
  const look = spec.look;
  const female = spec.body.gender < 0.5;
  const h = Math.abs(spec.id * 2654435761) >>> 0;
  const dressed: PersonLook = look.outfit ? look : {
    ...look,
    outfit: (female ? ['female_casualsuit01', 'female_casualsuit02']
      : ['male_casualsuit01', 'male_casualsuit02', 'male_casualsuit03', 'male_casualsuit04', 'male_casualsuit05', 'male_casualsuit06'])[h % (female ? 2 : 6)]!,
    footwear: ['shoes01', 'shoes02', 'shoes05'][(h >>> 8) % 3]!,
    outfitTint: look.topColour,
  };
  // Half the people in a grown style, half in a stock one that passed the
  // audit (`randomPerson`'s curated lists).
  const mouth = (l: PersonLook): PersonLook => ({ ...l, extras: [...(l.extras ?? []), 'acc:teeth', 'acc:tongue'] });
  if (!hair || ((h >>> 20) & 1) === 0) return mouth(dressed);
  // Children keep the stock styles (the player: the grown ones on a child
  // "nem usa isso").
  if (yearsFromAge(spec.body.age) < 14) return mouth(dressed);
  // Hair grown procedurally (`people/hair/procedural.ts`): older women
  // shorter or up, girls never in a bun, older men short.
  const years = yearsFromAge(spec.body.age);
  const styles: readonly string[] = female
    ? years > 60 ? ['bob', 'midLayered', 'bun', 'bobFringe', 'shoulderBob']
      : years < 14 ? ['longStraight', 'ponytail', 'ponytailFringe', 'bobFringe', 'braid', 'twinBraids', 'pigtails', 'longHeadband'] : FEMALE_HAIR
    : years > 55 ? ['shortCrop', 'shortSide', 'slickedBack'] : MALE_HAIR;
  const style = styles[(h >>> 12) % styles.length]!;
  return mouth({
    ...dressed,
    hairCut: `hair:${style}`,
    ...(HAIR_STYLES[style]?.headband ? { extras: [...(dressed.extras ?? []), 'acc:headband'] } : {}),
  });
}

function skinningChunk(): string {
  return `
uniform sampler2D procBones;
uniform sampler2D procCoef;
uniform sampler2D procShape;
uniform sampler2D procFace;
uniform sampler2D procFaceIndex;
uniform float procFaceRows;
uniform sampler2D procExpr;
uniform sampler2D procExprW;
uniform mat4 bindMatrix;
uniform mat4 bindMatrixInverse;
attribute float aRow;
attribute vec3 aRefs;
attribute vec3 aRefW;
mat4 getBoneMatrix(const in float i) {
  int x = int(i) * 4;
  int y = int(aRow);
  return mat4(texelFetch(procBones, ivec2(x, y), 0), texelFetch(procBones, ivec2(x + 1, y), 0),
    texelFetch(procBones, ivec2(x + 2, y), 0), texelFetch(procBones, ivec2(x + 3, y), 0));
}
vec3 procFaceDelta(int v) {
  float idx = texelFetch(procFaceIndex, ivec2(v % ${FACE_INDEX_WIDTH}, v / ${FACE_INDEX_WIDTH}), 0).r;
  if (idx < 0.0) return vec3(0.0);
  int t = int(idx) + int(aRow) * int(procFaceRows) * ${FACE_WIDTH};
  vec3 d = texelFetch(procFace, ivec2(t % ${FACE_WIDTH}, t / ${FACE_WIDTH}), 0).xyz;
  // The expression of the moment: each channel's shape at its weight.
  for (int c = 0; c < ${EXPR_SLOTS}; c += 4) {
    vec4 w = texelFetch(procExprW, ivec2(c / 4, int(aRow)), 0);
    for (int j = 0; j < 4; j++) {
      if (w[j] == 0.0) continue;
      int e = (c + j) * int(procFaceRows) * ${FACE_WIDTH} + int(idx);
      d += w[j] * texelFetch(procExpr, ivec2(e % ${FACE_WIDTH}, e / ${FACE_WIDTH}), 0).xyz;
    }
  }
  return d;
}
vec3 procDelta(int v) {
  vec3 d = procFaceDelta(v);
  int row = int(aRow);
  for (int k = 0; k < ${SHAPES}; k += 4) {
    vec4 c = texelFetch(procCoef, ivec2(k / 4, row), 0);
    for (int j = 0; j < 4; j++) {
      int t = v * ${SHAPES} + k + j;
      d += c[j] * texelFetch(procShape, ivec2(t % ${SHAPE_WIDTH}, t / ${SHAPE_WIDTH}), 0).xyz;
    }
  }
  return d;
}
vec3 procShapeDelta() {
  vec3 d = aRefW.x * procDelta(int(aRefs.x));
  if (aRefW.y != 0.0) d += aRefW.y * procDelta(int(aRefs.y));
  if (aRefW.z != 0.0) d += aRefW.z * procDelta(int(aRefs.z));
  return d;
}`;
}

const COVER_CHUNK = `
uniform sampler2D procCover;
uniform float procCoverRows;
attribute vec4 aWorn;
float procCovered(float item) {
  if (item < -0.5) return 0.0;
  int v = int(aRefs.x);
  return texelFetch(procCover, ivec2(v % ${COVER_WIDTH}, int(item) * int(procCoverRows) + v / ${COVER_WIDTH}), 0).r;
}`;

/** The vertex half every piece shares: its row's skeleton and shape, the skin's cover. */
function patchVertex(shader: { vertexShader: string }, kind: Kind): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <skinning_pars_vertex>', skinningChunk() + (kind === 'skin' ? COVER_CHUNK : ''))
    .replace('#include <begin_vertex>', `#include <begin_vertex>
transformed += procShapeDelta();
${kind === 'skin' ? 'transformed -= normalize(normal) * ' + SINK.toFixed(4) + ' * max(max(procCovered(aWorn.x), procCovered(aWorn.y)), max(procCovered(aWorn.z), procCovered(aWorn.w)));' : ''}
`);
}

function uniformsInto(shader: { uniforms: Record<string, unknown> }, cls: BodyClass, mesh: { bindMatrix: Matrix4; bindMatrixInverse: Matrix4 }): void {
  Object.assign(shader.uniforms, cls.uniforms, {
    bindMatrix: { value: mesh.bindMatrix },
    bindMatrixInverse: { value: mesh.bindMatrixInverse },
  });
}

/**
 * `grown`: a procedural hair item, its texture a strand atlas (`hairTexture.ts`:
 * R coverage, G root to tip, B strand seed) shaded as the open-source Three.js
 * hair shader does - roots darker, each strand its own brightness, cards
 * seen edge-on darker (deep in the hair), coverage as alpha resolved by
 * multisampling (alpha to coverage) rather than cut at a threshold, and each
 * vertex's own fade (`aFade`) feathering the hairline.
 */
function pieceMaterial(cls: BodyClass, kind: Kind, map: Texture | null, eyes: Texture | null, grown = false, lash = false): Material {
  const material = new MeshStandardMaterial({ roughness: kind === 'skin' ? 0.5 : grown ? 0.6 : 0.85, metalness: 0, side: DoubleSide });
  material.defines = { USE_SKINNING: '' };
  if (grown) { material.alphaTest = 0.02; material.alphaToCoverage = true; }
  // Brows and lashes: a soft edge (alpha to coverage over a low cut) - at
  // 0.35 their hairs merged into one hard black band.
  // Brows and lashes stay where the item puts them, on the skin: winning
  // the depth test by a depth bias only (polygon offset, a decal's), never
  // by moving them - pushed 4 mm towards the camera, from the side the brow
  // stood off the face.
  else if (kind === 'face') {
    material.alphaTest = 0.08; material.alphaToCoverage = true;
    material.polygonOffset = true; material.polygonOffsetFactor = -2; material.polygonOffsetUnits = -8;
  }
  else if (kind === 'hair') { material.alphaTest = 0.35; material.alphaToCoverage = true; }
  if (kind === 'skin') material.alphaTest = 0.5;
  const mesh = cls.rig.mesh;
  material.onBeforeCompile = (shader) => {
    uniformsInto(shader, cls, mesh);
    shader.uniforms['procMap'] = { value: map };
    shader.uniforms['procEyes'] = { value: eyes };
    patchVertex(shader, kind);
    shader.vertexShader = `attribute vec4 aDye; attribute float eyeMask; attribute float aFade; varying vec4 vProcDye; varying vec2 vProcUv; varying float vSkinMask; varying float vFade;\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vProcDye = aDye; vProcUv = uv; vFade = aFade; vSkinMask = ${kind === 'skin' ? '1.0 - eyeMask' : '0.0'};`);
    const hair = kind === 'hair' ? '1.0' : '0.0';
    const cloth = kind === 'cloth' ? '1.0' : '0.0';
    shader.fragmentShader = `#define appearanceDetail 1.0
#define vHairMask ${hair}
#define vGarmentSlot ${cloth}
uniform sampler2D procMap; uniform sampler2D procEyes;
varying vec4 vProcDye; varying vec2 vProcUv; varying float vSkinMask; varying float vFade;
vec3 personStrand = vec3(0.0, 1.0, 0.0); float personSparkle = 0.5;
${shader.fragmentShader}`
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec4 texel = texture2D(procMap, vProcUv);
  ${grown ? `
  // Thinning towards a card's long edges (each a quarter of the atlas
  // across), so overlapping cards blend instead of showing as shingles.
  float across = fract(vProcUv.x * 4.0);
  float sides = smoothstep(0.0, 0.22, min(across, 1.0 - across));
  float coverage = clamp(texel.r * 2.5 * vFade * mix(0.35, 1.0, sides), 0.0, 1.0);
  vec3 tone = vProcDye.rgb * mix(0.72, 1.0, smoothstep(0.0, 0.3, texel.g));
  tone *= 1.0 + (texel.b - 0.5) * 0.72;
  float facing = abs(dot(normalize(vNormal), normalize(vViewPosition)));
  tone *= mix(0.6, 1.0, smoothstep(0.05, 0.55, facing));
  texel = vec4(tone, coverage);` : kind === 'skin' ? `
  if (vSkinMask < 0.5) {
    texel = texture2D(procEyes, vProcUv);
    // Iris less garish (the packs' are oversaturated: cat's eyes), sclera
    // off-white, never paper white.
    float l = dot(texel.rgb, vec3(0.2126, 0.7152, 0.0722));
    texel.rgb = mix(vec3(l), texel.rgb, 0.62) * vec3(0.93, 0.9, 0.88);
  }
  else texel = vec4(texel.rgb * vProcDye.rgb, 1.0);` : `
  if (vProcDye.a > 0.5) {
    float l = dot(texel.rgb, vec3(0.2126, 0.7152, 0.0722));
    texel.rgb = vProcDye.rgb * (0.45 + 1.1 * l);
  }
  ${kind === 'face' ? `
  // Brows and lashes a shade lighter than the hair, and thinned: at the
  // hair's own darkness, fully opaque, they read as painted black bars.
  ${lash ? `
  texel.rgb = vec3(0.05, 0.038, 0.03) + texel.rgb * 0.25;
  texel.a = smoothstep(0.15, 0.95, texel.a) * 0.78;` : `
  texel.rgb = texel.rgb * 1.35 + vec3(0.035, 0.028, 0.022);
  texel.a = smoothstep(0.22, 0.95, texel.a) * 0.8;`}` : ''}`}
  diffuseColor *= texel;
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
${kind === 'skin' ? 'if (vSkinMask < 0.5) roughnessFactor = 0.08;' : ''}
${lash ? 'roughnessFactor = 1.0;' : ''}
${grown ? 'roughnessFactor = max(0.55, roughnessFactor + (texture2D(procMap, vProcUv).b - 0.5) * 0.16 + (1.0 - texture2D(procMap, vProcUv).g) * 0.06);' : ''}`)
      .replace('#include <lights_physical_pars_fragment>', personLighting(kind === 'hair', kind === 'cloth'))
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  vec3 dp1 = dFdx(-vViewPosition), dp2 = dFdy(-vViewPosition);
  vec2 du1 = dFdx(vProcUv), du2 = dFdy(vProcUv);
  vec3 along = dp2 * du1.x - dp1 * du2.x;
  personStrand = along - normal * dot(along, normal);
  personStrand = dot(personStrand, personStrand) > 1e-12 ? normalize(personStrand) : vec3(0.0, 1.0, 0.0);
  personSparkle = fract(sin(dot(floor(vProcUv * vec2(160.0, 12.0)), vec2(12.9898, 78.233))) * 43758.5453);
}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
reflectedLight.indirectSpecular *= personIndirect();
${kind === 'skin' ? `
// The eye's wet cornea: a sharp catchlight of the key light and a soft one
// of the sky above - without an environment to mirror the eye had none, and
// read as dead.
if (vSkinMask < 0.5) {
  vec3 R = reflect(-normalize(vViewPosition), normal);
  vec3 key = normalize((viewMatrix * vec4(-0.45, 0.8, 0.5, 0.0)).xyz);
  float glint = pow(max(dot(R, key), 0.0), 380.0) * 2.4 + pow(max(dot(R, (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz), 0.0), 6.0) * 0.06;
  reflectedLight.directSpecular += vec3(glint);
}` : ''}`);
  };
  material.customProgramCacheKey = () => `procedural-person-${kind}${grown ? '-grown' : ''}${lash ? '-lash' : ''}`;
  return material;
}

function depthMaterial(cls: BodyClass, kind: Kind): MeshDepthMaterial {
  const material = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  material.defines = { USE_SKINNING: '' };
  const mesh = cls.rig.mesh;
  material.onBeforeCompile = (shader) => {
    uniformsInto(shader, cls, mesh);
    patchVertex(shader, kind);
  };
  material.customProgramCacheKey = () => `procedural-person-depth-${kind}`;
  return material;
}

function kindOf(item: ProxyItem): Kind {
  const k = item.pack.kind;
  if (k === 'eyebrows' || k === 'eyelashes') return 'face';
  if (k === 'hair' || k === 'beard' || item.transparent) return 'hair';
  return 'cloth';
}

/** A proxy pack as a cooked record, and back (`proceduralCook.ts`). */
export function packRecordOf(pack: ProxyPack): PackRecord {
  return {
    name: pack.name, kind: pack.kind, scaleRefs: pack.scaleRefs, scaleBase: pack.scaleBase, refs: pack.refs,
    weights: pack.weights, offsets: pack.offsets, index: pack.index, deleteVerts: pack.deleteVerts, colour: pack.colour,
    zDepth: pack.zDepth, uvs: pack.uvs ?? null, fade: pack.fade ?? null,
  };
}
function packFromRecord(r: Record<string, PackValue>): ProxyPack {
  const uvs = r['uvs'], fade = r['fade'];
  return {
    name: r['name'] as string, kind: r['kind'] as ProxyPack['kind'], scaleRefs: r['scaleRefs'] as number[],
    scaleBase: r['scaleBase'] as unknown as [number, number, number], refs: r['refs'] as Uint32Array,
    weights: r['weights'] as Float32Array, offsets: r['offsets'] as Float32Array, index: r['index'] as Uint32Array,
    deleteVerts: r['deleteVerts'] as Uint32Array, colour: r['colour'] as number, zDepth: r['zDepth'] as number,
    ...(uvs instanceof Float32Array ? { uvs } : {}), ...(fade instanceof Float32Array ? { fade } : {}),
  };
}

function rowTexture(pixels: Float32Array, width: number, rows: number): DataTexture {
  const texture = new DataTexture(pixels, width / 4, rows, RGBAFormat, FloatType);
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

export interface ProceduralCrowd {
  readonly group: Group;
  add(spec: PersonSpec): Promise<ProceduralPerson>;
  /** Every person's pose and place into the GPU: once a frame, after setting `matrix`, `clip`, `phase`. */
  /** `eye`: where the camera is, so the people nearest it get their hair's strands. */
  /** `time`: the simulation's seconds, which the faces live by (still while paused); wall time without it. */
  update(eye?: Vector3, time?: number): void;
  /**
   * The ragdolls' side (`agents.ts`, `ragdoll.ts`): a person's skeleton (its
   * bones by the capture's names, as the ragdoll knows them), their pose now,
   * the standing pose they get up into, and a pose the ragdoll holds them in.
   */
  readonly ragdoll: {
    skeleton(person: ProceduralPerson): { names: string[]; parents: number[]; inverses: Matrix4[]; local: Matrix4; bind: Matrix4 } | null;
    pose(person: ProceduralPerson): Float32Array | null;
    standing(person: ProceduralPerson, phase: number): Float32Array | null;
    hold(person: ProceduralPerson, palette: Float32Array | null): void;
  };
  clear(): void;
  clipDuration(person: ProceduralPerson): number;
  /** Ground one walk cycle covers at the person's scale, metres. */
  stride(person: ProceduralPerson): number;
  stats(): ProceduralStats;
  /** Diagnosis: the shape the GPU sums for a person at base vertices, against the rig's exact one, metres. */
  probe(person: ProceduralPerson, vertices: readonly number[]): { v: number; linear: number[]; exact: number[] }[];
  readonly people: readonly ProceduralPerson[];
  /** Drops an item and its pieces, so it is built again on next use (a hairstyle being edited). */
  forget(name: string): void;
  /**
   * Every class's rig made ahead, one at a time with a pause between: each is
   * a single stretch of 50-100 ms (`createPersonRig`) that nothing can be
   * cooked for, and made when the first person of the class came in, it was
   * a stall in play (docs/performance.md #8).
   */
  warmClasses(): Promise<void>;
  /** Every class and hairstyle built here, packed for the cook (`proceduralCook.ts`, `scripts/cook-people.mjs`). */
  cook(): Promise<Map<string, ArrayBuffer>>;
}

export function createProceduralCrowd(options: { hair?: boolean; /** World units per metre (the game's are 2.5). */ unit?: number } = {}): ProceduralCrowd {
  const group = new Group();
  group.name = 'procedural-people';
  const classes = new Map<string, Promise<BodyClass>>();
  const ready: BodyClass[] = [];
  const people: ProceduralPerson[] = [];
  const components: Float32Array[] = [];
  let assets: PeopleAssets | null = null;
  let morpher: Morpher | null = null;
  let bakeMs = 0;
  /** Bumped by `clear`: an `add` begun before it is dropped. */
  let epoch = 0;
  const items = new Map<string, Promise<ProxyItem>>();
  const textures = new Map<string, Promise<Texture | null>>();
  const matrix = new Matrix4();
  const scaled = new Matrix4();

  /**
   * The class's pose on this person's own joints. A skin matrix M = W B^-1
   * (W the bone's world, B its bind). Their bind is the class's moved by d,
   * B' = T(d) B, with the same turns; holding each bone's turn from the
   * clip and its length from their body, W' = T(delta) W with
   * delta = delta(parent) + R(M parent) (d - d parent) - so
   * M' = T(delta) M T(-d): a translation per bone, parents first.
   */
  const shift = new Float32Array(512 * 3);
  const refit = (cls: BodyClass, person: ProceduralPerson, at: number): void => {
    const m = cls.palette, d = person.joints;
    for (const i of cls.order) {
      const p = cls.parent[i]!;
      let x = d[i * 3]!, y = d[i * 3 + 1]!, z = d[i * 3 + 2]!;
      if (p >= 0) {
        const q = at + p * SKIN_BONE_FLOATS;
        const ex = x - d[p * 3]!, ey = y - d[p * 3 + 1]!, ez = z - d[p * 3 + 2]!;
        x = shift[p * 3]! + m[q]! * ex + m[q + 4]! * ey + m[q + 8]! * ez;
        y = shift[p * 3 + 1]! + m[q + 1]! * ex + m[q + 5]! * ey + m[q + 9]! * ez;
        z = shift[p * 3 + 2]! + m[q + 2]! * ex + m[q + 6]! * ey + m[q + 10]! * ez;
      }
      shift[i * 3] = x; shift[i * 3 + 1] = y; shift[i * 3 + 2] = z;
    }
    for (let i = 0; i < cls.bones; i++) {
      const o = at + i * SKIN_BONE_FLOATS;
      const dx = d[i * 3]!, dy = d[i * 3 + 1]!, dz = d[i * 3 + 2]!;
      m[o + 12] = m[o + 12]! + shift[i * 3]! - (m[o]! * dx + m[o + 4]! * dy + m[o + 8]! * dz);
      m[o + 13] = m[o + 13]! + shift[i * 3 + 1]! - (m[o + 1]! * dx + m[o + 5]! * dy + m[o + 9]! * dz);
      m[o + 14] = m[o + 14]! + shift[i * 3 + 2]! - (m[o + 2]! * dx + m[o + 6]! * dy + m[o + 10]! * dz);
    }
  };

  /**
   * A limb lost: every bone from its joint down shrunk to that joint, so the
   * stump closes there (as `riggedCitizens` maim does on the cooked bodies).
   */
  const limbBones = new WeakMap<BodyClass, Record<string, { bones: number[]; parent: number; joint: Vector3 } | null>>();
  const limbTmp = new Matrix4(), limbAt = new Vector3();
  const LIMB_ROOT: Record<Severable, string> = { armL: 'lowerarm_l', armR: 'lowerarm_r', legL: 'calf_l', legR: 'calf_r', head: 'head' };
  const closeLimb = (cls: BodyClass, at: number, limb: Severable): void => {
    let info = limbBones.get(cls);
    if (!info) {
      info = {};
      const bones = cls.rig.mesh.skeleton.bones;
      const parents = bones.map((b) => bones.indexOf(b.parent as never));
      for (const [key, name] of Object.entries(LIMB_ROOT)) {
        const root = bones.findIndex((b) => b.name === name);
        if (root < 0) { info[key] = null; continue; }
        const set = [root];
        for (let i = 0; i < bones.length; i++) {
          let j = parents[i]!;
          while (j >= 0 && j !== root) j = parents[j]!;
          if (j === root) set.push(i);
        }
        const joint = new Vector3().setFromMatrixPosition(limbTmp.copy(cls.rig.mesh.skeleton.boneInverses[root]!).invert());
        info[key] = { bones: set, parent: parents[root]!, joint };
      }
      limbBones.set(cls, info);
    }
    const which = info[limb];
    if (!which || which.parent < 0) return;
    const px = cls.palette;
    limbTmp.fromArray(px, at + which.parent * SKIN_BONE_FLOATS);
    limbAt.copy(which.joint).applyMatrix4(limbTmp);
    for (const i of which.bones) {
      const o = at + i * SKIN_BONE_FLOATS;
      px.fill(0, o, o + 16);
      px[o + 12] = limbAt.x; px[o + 13] = limbAt.y; px[o + 14] = limbAt.z; px[o + 15] = 1;
    }
  };

  /** Poses held by the ragdolls, by person (`ragdoll.hold`). */
  const holds = new Map<ProceduralPerson, Float32Array>();
  const classOf = (person: ProceduralPerson): BodyClass | null => ready.find((cls) => cls.people.includes(person)) ?? null;

  const setup = async (): Promise<{ assets: PeopleAssets; morpher: Morpher }> => {
    assets ??= await loadPeopleAssets();
    morpher ??= new Morpher(assets.packs);
    if (!components.length) for (let k = 0; k < SHAPES; k++) components.push(morpher.component(k));
    return { assets, morpher };
  };

  /** The base mesh as a hairstyle is grown on it. */
  const hairBase = (a: PeopleAssets, mo: Morpher): HairBase => ({ positions: mo.base, vertexCount: a.mesh.vertexCount,
    bodyRange: a.bodyRange, joints: a.mesh.joints, weights: a.mesh.weights, boneNames: a.mesh.boneNames, faces: a.mesh.faces });
  /** A hairstyle's cards: read from the cook (`proceduralCook.ts`), grown here only when it is missing or stale. */
  const hairCards = async (style: HairStyle): Promise<ProxyPack> => {
    const cooked = await loadProcedural(`hair-${style.name}`);
    if (cooked) return packFromRecord(cooked);
    const { assets: a, morpher: mo } = await setup();
    const at = performance.now();
    const pack = generateHair(style, hairBase(a, mo));
    performance.measure(`hitch:person/hair ${style.name}`, { start: at, end: performance.now() });
    return pack;
  };

  const item = (name: string): Promise<ProxyItem> => {
    let loaded = items.get(name);
    if (!loaded) {
      const style = name.startsWith('hair:') ? HAIR_STYLES[name.slice(5)] : undefined;
      if (name === 'acc:teeth' || name === 'acc:tongue') {
        // The base mesh's own teeth and tongue (its helper groups), each
        // vertex pinned to itself: so the jaw and the mouth's expressions,
        // which move those vertices too, carry them.
        loaded = Promise.all([setup(), item('eyes')]).then(([{ assets: a }, eyes]) => {
          const groups = (name === 'acc:teeth' ? ['helper-upper-teeth', 'helper-lower-teeth'] : ['helper-tongue'])
            .map((g) => a.mesh.faceGroups.indexOf(g)).filter((g) => g >= 0);
          const used = new Map<number, number>();
          const index: number[] = [];
          const at = (v: number): number => { let k = used.get(v); if (k === undefined) { k = used.size; used.set(v, k); } return k; };
          for (let f = 0; f < a.mesh.faceGroup.length; f++) {
            if (!groups.includes(a.mesh.faceGroup[f]!)) continue;
            const q = [a.mesh.faces[f * 4]!, a.mesh.faces[f * 4 + 1]!, a.mesh.faces[f * 4 + 2]!, a.mesh.faces[f * 4 + 3]!];
            index.push(at(q[0]!), at(q[1]!), at(q[2]!));
            if (q[3] !== q[2]) index.push(at(q[0]!), at(q[2]!), at(q[3]!));
          }
          const n = used.size;
          const refs = new Uint32Array(n * 3), weights = new Float32Array(n * 3);
          for (const [v, k] of used) { refs.fill(v, k * 3, k * 3 + 3); weights[k * 3] = 1; }
          const pack = { ...eyes.pack, name, kind: 'clothes' as const, refs, weights, offsets: new Float32Array(n * 3),
            index: Uint32Array.from(index), deleteVerts: new Uint32Array(0), uvs: new Float32Array(n * 2) };
          return { pack, texture: null, transparent: false, textureFile: null };
        });
        items.set(name, loaded);
        return loaded;
      }
      if (name === 'acc:headband') {
        // From the cook, like the hairstyles: grown here it was the biggest
        // share of the game's script while people arrived (docs/performance.md #29).
        loaded = loadProcedural('acc-headband').then(async (cooked) => {
          if (cooked) return { pack: packFromRecord(cooked), texture: null, transparent: false, textureFile: null };
          const { assets: a, morpher: mo } = await setup();
          return { pack: generateHeadband(hairBase(a, mo)), texture: null, transparent: false, textureFile: null };
        });
        items.set(name, loaded);
        return loaded;
      }
      if (!style && /^eyebrow|^eyelash/.test(name)) {
        // Brows and lashes nearer the skin than their files place them: the
        // brow stood off the face as a slab, the lashes stuck out like legs.
        // Each vertex's offset from the skin it is pinned to, shortened.
        loaded = loadProxyItem(name).then((it) => {
          const k = name.startsWith('eyebrow') ? 0.2 : 0.62;
          return { ...it, pack: { ...it.pack, offsets: it.pack.offsets.map((o) => o * k) } };
        });
        items.set(name, loaded);
        return loaded;
      }
      loaded = style
        ? hairCards(style).then((pack) => ({ pack, texture: null, transparent: true, textureFile: null }))
        : loadProxyItem(name);
      items.set(name, loaded);
    }
    return loaded;
  };
  const textureOf = (name: string, it: ProxyItem): Promise<Texture | null> => {
    let t = textures.get(name);
    if (!t) {
      const style = name.startsWith('hair:') ? HAIR_STYLES[name.slice(5)] : undefined;
      t = style ? Promise.resolve(hairStrandTexture(style.strands))
        : name.startsWith('acc:') ? Promise.resolve(plainTexture() as Texture) : itemTexture(name, it) ?? Promise.resolve(null);
      textures.set(name, t);
    }
    return t;
  };

  /** What a class is made of besides its rig: computed here, or read from the cook. */
  interface ClassData {
    readonly shapePixels: Float32Array;
    readonly jointBasis: Float32Array;
    readonly faceIndexPixels: Float32Array;
    readonly faceList: Int32Array;
    readonly exprPixels: Float32Array;
    readonly walk: ClipFrames;
    readonly idle: ClipFrames;
    /** Running (from danger), and cowering crouched (struck with fear): the reactions' clips. */
    readonly run: ClipFrames;
    readonly cower: ClipFrames;
  }
  const classRecord = (d: ClassData): PackRecord => ({
    shapePixels: d.shapePixels, jointBasis: d.jointBasis, faceIndexPixels: d.faceIndexPixels, faceList: d.faceList,
    exprPixels: d.exprPixels, ...clipFields('walk', d.walk), ...clipFields('idle', d.idle),
    ...clipFields('run', d.run), ...clipFields('cower', d.cower),
  });
  const classFromRecord = (r: Record<string, PackValue>): ClassData => ({
    shapePixels: r['shapePixels'] as Float32Array, jointBasis: r['jointBasis'] as Float32Array,
    faceIndexPixels: r['faceIndexPixels'] as Float32Array, faceList: r['faceList'] as Int32Array,
    exprPixels: r['exprPixels'] as Float32Array, walk: clipOf('walk', r), idle: clipOf('idle', r),
    run: clipOf('run', r), cower: clipOf('cower', r),
  });

  /** A class's rig: its body at the band's age, with only the eyes on it (no outfit, hair, brows, lashes or hat). */
  const classRig = async (sex: WalkSex, band: AgeBand) => {
    const { assets: a, morpher: mo } = await setup();
    const base = classBase(sex, band);
    const shape = mo.shape(base);
    const eyes = await item('eyes');
    await breathe();
    const { outfit: _o, footwear: _f, brows: _b, lashes: _l, ...bare } = DEFAULT_LOOK;
    const look: PersonLook = { ...bare, hairCut: 'none', hat: 'none', extras: [] };
    const rig = createPersonRig({
      nude: true, texturedSkin: true, data: a.mesh, skeleton: a.skeleton, bodyRange: a.bodyRange, positions: shape, look,
      capture: captureBind(sex), captureAxes: captureBindRotations(sex), proxies: new Map([['eyes', eyes]]),
    });
    await breathe();
    return { base, shape, eyes, rig };
  };

  /**
   * A class's data on its rig: the shape basis, the clips, the joint basis,
   * the face slots and the expressions. Some 250 ms of work, done a few
   * milliseconds a frame (`breathe`) when it has to be done in play - only
   * when the cook is missing or stale.
   */
  const classData = async (sex: WalkSex, rig: PersonRig, shape: Float32Array): Promise<ClassData> => {
    const { assets: a } = await setup();
    const vertexCount = a.mesh.vertexCount;
    // The shape basis on this body: each component as moves of every base
    // vertex in the bind posture, per unit of its coefficient (a small step,
    // so the feet-to-ground shift stays linear).
    const shapeRows = Math.ceil(vertexCount * SHAPES / SHAPE_WIDTH);
    const shapePixels = new Float32Array(SHAPE_WIDTH * shapeRows * 4);
    const stepped = new Float32Array(shape.length);
    for (let k = 0; k < SHAPES; k++) {
      const comp = components[k]!;
      let biggest = 0;
      for (let j = 0; j < comp.length; j++) biggest = Math.max(biggest, Math.abs(comp[j]!));
      const eps = biggest > 0 ? 0.3 / biggest : 1;
      for (let j = 0; j < shape.length; j++) stepped[j] = shape[j]! + eps * comp[j]!;
      const moved = rig.deltas!(stepped);
      for (let v = 0; v < vertexCount; v++) {
        const t = (v * SHAPES + k) * 4;
        shapePixels[t] = moved[v * 3]! / eps;
        shapePixels[t + 1] = moved[v * 3 + 1]! / eps;
        shapePixels[t + 2] = moved[v * 3 + 2]! / eps;
      }
      await breathe();
    }
    const library = await loadRocketboxClips(sex);
    await breathe();
    const bakeRig = restRig(rig.scene);
    const walk = await bakeWalk(bakeRig, sex);
    await breathe();
    const idle = await bakeLibraryClip(bakeRig, library.idle, undefined, 'idle');
    await breathe();
    const run = await bakeLibraryClip(bakeRig, library.run, undefined, 'run');
    await breathe();
    const cower = await bakeLibraryClip(bakeRig, library.crouchIdle, undefined, 'crouchIdle');
    await breathe();
    // Joints follow the shape: a MakeHuman bone's head is the mean of a
    // group of base vertices (its joint cube, `personRig.headOf`), so its
    // move per coefficient is the mean of theirs in the shape basis.
    const bones = rig.mesh.skeleton.bones.length;
    const jointBasis = new Float32Array(bones * SHAPES * 3);
    a.skeleton.bones.forEach((bone, i) => {
      const verts: number[] = [];
      if (bone.head.strategy === 'CUBE' && bone.head.cubeName) {
        for (const [x0, x1] of a.mesh.vertexGroups[bone.head.cubeName] ?? []) for (let v = x0; v <= x1; v++) verts.push(v);
      } else verts.push(...(bone.head.vertexIndices ?? []));
      if (!verts.length || i >= bones) return;
      for (let k = 0; k < SHAPES; k++) for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (const v of verts) sum += shapePixels[(v * SHAPES + k) * 4 + c]!;
        jointBasis[(i * SHAPES + k) * 3 + c] = sum / verts.length;
      }
    });
    // The head's vertices (helpers too: the eyes, brows and lashes are pinned
    // to them), each a slot in a person's face row.
    const headBone = a.mesh.boneNames.indexOf('head');
    const faceList: number[] = [];
    const faceIndexPixels = new Float32Array(FACE_INDEX_WIDTH * Math.ceil(vertexCount / FACE_INDEX_WIDTH)).fill(-1);
    for (let v = 0; v < vertexCount; v++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (a.mesh.joints[v * 4 + k] === headBone) w += a.mesh.weights[v * 4 + k]! / 65535;
      if (w > 0.25) { faceIndexPixels[v] = faceList.length; faceList.push(v); }
    }
    const faceRows = Math.ceil(faceList.length / FACE_WIDTH);
    // Each expression channel on this body, as moves of the head's vertices
    // in the bind posture: the channel's ARKit shapes on the class body,
    // posed (`PersonRig.deltas`).
    const expressions = await expressionShapes();
    await breathe();
    const channels = channelShapes(expressions);
    await breathe();
    const exprPixels = new Float32Array(FACE_WIDTH * 4 * faceRows * EXPR_SLOTS);
    const posedBase = rig.deltas!(shape);
    const withChannel = new Float32Array(shape.length);
    for (const [c, name] of EXPR.entries()) {
      await breathe();
      const unit = channels[name];
      if (!unit) continue;
      for (let j = 0; j < shape.length; j++) withChannel[j] = shape[j]! + unit[j]!;
      const moved = rig.deltas!(withChannel);
      faceList.forEach((v, i) => {
        const o = (c * faceRows * FACE_WIDTH + i) * 4;
        exprPixels[o] = moved[v * 3]! - posedBase[v * 3]!;
        exprPixels[o + 1] = moved[v * 3 + 1]! - posedBase[v * 3 + 1]!;
        exprPixels[o + 2] = moved[v * 3 + 2]! - posedBase[v * 3 + 2]!;
      });
    }
    await breathe();
    return { shapePixels, jointBasis, faceIndexPixels, faceList: Int32Array.from(faceList), exprPixels, walk, idle, run, cower };
  };

  const buildClass = async (sex: WalkSex, band: AgeBand): Promise<BodyClass> => {
    const { assets: a, morpher: mo } = await setup();
    const started = performance.now();
    const { base, shape, eyes, rig } = await classRig(sex, band);
    // Read from the cook (`proceduralCook.ts`); built here only when it is missing or stale.
    const cooked = await loadProcedural(`class-${sex}-${band}`);
    const { shapePixels, jointBasis, faceIndexPixels, faceList, exprPixels, walk, idle, run, cower } = cooked
      ? classFromRecord(cooked) : await classData(sex, rig, shape);
    const vertexCount = a.mesh.vertexCount;
    const shapeRows = Math.ceil(vertexCount * SHAPES / SHAPE_WIDTH);
    const shapeTexture = rowTexture(shapePixels, SHAPE_WIDTH * 4, shapeRows);

    // The body itself: base-vertex references for its shape and cover.
    const body = rig.mesh.geometry;
    const source = body.userData['morphSource'] as { kind: Int16Array; index: Int32Array };
    const n = body.getAttribute('position').count;
    const refs = new Float32Array(n * 3), refW = new Float32Array(n * 3);
    for (let o = 0; o < n; o++) {
      const kind = source.kind[o]!, i = source.index[o]!;
      if (kind === -1) { refs.fill(i, o * 3, o * 3 + 3); refW[o * 3] = 1; }
      else if (kind === 0) {
        for (let k = 0; k < 3; k++) { refs[o * 3 + k] = eyes.pack.refs[i * 3 + k]!; refW[o * 3 + k] = eyes.pack.weights[i * 3 + k]!; }
      }
    }
    body.setAttribute('aRefs', new Float32BufferAttribute(refs, 3));
    body.setAttribute('aRefW', new Float32BufferAttribute(refW, 3));
    if (!body.getAttribute('eyeMask')) body.setAttribute('eyeMask', new Float32BufferAttribute(new Float32Array(n), 1));
    if (!body.getAttribute('normal')) body.computeVertexNormals();
    await breathe();

    const bones = rig.mesh.skeleton.bones.length;
    const skeletonBones = rig.mesh.skeleton.bones;
    const parent = new Int16Array(bones).fill(-1);
    skeletonBones.forEach((bone, i) => { parent[i] = skeletonBones.indexOf(bone.parent as typeof bone); });
    const order: number[] = [];
    const visit = (i: number): void => { order.push(i); for (let j = 0; j < bones; j++) if (parent[j] === i) visit(j); };
    for (let i = 0; i < bones; i++) if (parent[i] === -1) visit(i);
    const faceRows = Math.ceil(faceList.length / FACE_WIDTH);
    const faceIndex = new DataTexture(faceIndexPixels, FACE_INDEX_WIDTH, faceIndexPixels.length / FACE_INDEX_WIDTH, RedFormat, FloatType);
    faceIndex.minFilter = faceIndex.magFilter = NearestFilter;
    faceIndex.needsUpdate = true;
    const face = new Float32Array(FACE_WIDTH * 4 * faceRows * ROW_START);
    const exprW = new Float32Array(EXPR_SLOTS * ROW_START);
    const width = bones * SKIN_BONE_FLOATS;
    const palette = new Float32Array(width * ROW_START);
    const coef = new Float32Array(SHAPES * ROW_START);
    const coverPixels = new Uint8Array(COVER_WIDTH);
    const cover = new DataTexture(coverPixels, COVER_WIDTH, 1, RedFormat, UnsignedByteType);
    cover.needsUpdate = true;
    bakeMs += performance.now() - started;
    const cls: BodyClass = {
      key: `${sex}-${band}`, sex, band, base, shape, coefficients: mo.coefficients(base), rig,
      height: bodyHeight(shape, a.bodyRange) / 10, clips: { walk, idle, run, cower }, bones, order, parent, jointBasis,
      uniforms: {
        procBones: { value: rowTexture(palette, width, ROW_START) },
        procCoef: { value: rowTexture(coef, SHAPES, ROW_START) },
        procShape: { value: shapeTexture },
        procCover: { value: cover },
        procCoverRows: { value: Math.ceil(vertexCount / COVER_WIDTH) },
        procFace: { value: rowTexture(face, FACE_WIDTH * 4, faceRows * ROW_START) },
        procFaceIndex: { value: faceIndex },
        procFaceRows: { value: faceRows },
        procExpr: { value: rowTexture(exprPixels, FACE_WIDTH * 4, faceRows * EXPR_SLOTS) },
        procExprW: { value: rowTexture(exprW, EXPR_SLOTS, ROW_START) },
      },
      face, exprW, faceVerts: faceList,
      palette, coef, rows: 0, capacity: ROW_START, cover: new Map(), body,
      skins: new Map(), pieces: new Map(), people: [],
    };
    ready.push(cls);
    return cls;
  };

  const classFor = (sex: WalkSex, band: AgeBand): Promise<BodyClass> => {
    const key = `${sex}-${band}`;
    let cls = classes.get(key);
    if (!cls) { cls = buildClass(sex, band); classes.set(key, cls); }
    return cls;
  };

  /** A garment's cover row in its class, made on first use. */
  const coverRow = (cls: BodyClass, name: string, it: ProxyItem): number => {
    const known = cls.cover.get(name);
    if (known !== undefined) return known;
    const row = cls.cover.size;
    cls.cover.set(name, row);
    const per = cls.uniforms.procCoverRows.value;
    const old = cls.uniforms.procCover.value;
    const rows = (row + 1) * per;
    const pixels = new Uint8Array(COVER_WIDTH * rows);
    pixels.set((old.image.data as Uint8Array).subarray(0, Math.min(old.image.data!.length, pixels.length)));
    for (const v of it.pack.deleteVerts) pixels[row * per * COVER_WIDTH + v] = 255;
    const texture = new DataTexture(pixels, COVER_WIDTH, rows, RedFormat, UnsignedByteType);
    texture.needsUpdate = true;
    cls.uniforms.procCover.value = texture;
    old.dispose();
    return row;
  };

  const growRows = (cls: BodyClass): void => {
    const capacity = cls.capacity * 2;
    const width = cls.bones * SKIN_BONE_FLOATS;
    const palette = new Float32Array(width * capacity);
    palette.set(cls.palette);
    const coef = new Float32Array(SHAPES * capacity);
    coef.set(cls.coef);
    cls.palette = palette;
    cls.coef = coef;
    cls.capacity = capacity;
    cls.uniforms.procBones.value.dispose();
    cls.uniforms.procCoef.value.dispose();
    cls.uniforms.procBones.value = rowTexture(palette, width, capacity);
    cls.uniforms.procCoef.value = rowTexture(coef, SHAPES, capacity);
    const faceRows = cls.uniforms.procFaceRows.value;
    const face = new Float32Array(FACE_WIDTH * 4 * faceRows * capacity);
    face.set(cls.face);
    cls.face = face;
    cls.uniforms.procFace.value.dispose();
    cls.uniforms.procFace.value = rowTexture(face, FACE_WIDTH * 4, faceRows * capacity);
    const exprW = new Float32Array(EXPR_SLOTS * capacity);
    exprW.set(cls.exprW);
    cls.exprW = exprW;
    cls.uniforms.procExprW.value.dispose();
    cls.uniforms.procExprW.value = rowTexture(exprW, EXPR_SLOTS, capacity);
  };

  const makePiece = (cls: BodyClass, name: string, kind: Kind, geometry: BufferGeometry, map: Texture | null, eyes: Texture | null, grown = false): Piece => {
    const capacity = 256;
    const rows = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    const dyes = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    geometry.setAttribute('aRow', rows);
    geometry.setAttribute('aDye', dyes);
    let worn: InstancedBufferAttribute | null = null;
    if (kind === 'skin') {
      worn = new InstancedBufferAttribute(new Float32Array(capacity * 4).fill(-1), 4);
      geometry.setAttribute('aWorn', worn);
    }
    if (!geometry.getAttribute('aFade')) geometry.setAttribute('aFade', new Float32BufferAttribute(new Float32Array(geometry.getAttribute('position').count).fill(1), 1));
    const mesh = new InstancedMesh(geometry, pieceMaterial(cls, kind, map, eyes, grown, /lash/.test(name)), capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = kind !== 'face';
    mesh.receiveShadow = true;
    if (mesh.castShadow) {
      const depth = depthMaterial(cls, kind);
      // As the shadow pass sets it on every draw (three's WebGLShadowMap
      // getDepthMaterial): the main material's map and alpha test - so the
      // program compiled ahead below is the one the shadow pass uses.
      const main = mesh.material as MeshStandardMaterial;
      depth.map = main.map;
      depth.alphaTest = main.alphaToCoverage ? 0.5 : main.alphaTest;
      depth.side = main.side;
      mesh.customDepthMaterial = depth;
    }
    mesh.name = `${cls.key}/${name}`;
    mesh.userData['cls'] = cls.key;
    // Into the scene only once its shaders are built, in parallel and off the
    // frame (`uploads.ts` compileAhead): a mesh in the scene builds its program
    // the first frame it is drawn, even with no instance, and each new piece
    // (a garment, a hairstyle, a class's skin) stopped the game for up to a
    // second on the first person wearing it (profiled 2026-10-06). Its shadow
    // program too, through a stand-in drawn with the depth material.
    const jobs: Promise<void>[] = [compileAhead(mesh)];
    if (mesh.customDepthMaterial) jobs.push(compileAhead(new InstancedMesh(geometry, mesh.customDepthMaterial, 1), true));
    const ready = Promise.all(jobs).then(() => { group.add(mesh); });
    return { name, kind, mesh, rows, dyes, worn, tints: null, people: [], vertices: geometry.getAttribute('position').count, ready };
  };

  /**
   * The skin for a person: never one of the made-up skins - their painted
   * eye shadow and dark lipstick gave every woman red, sore-looking eyes.
   */
  const bareSkin = (person: PersonSpec): ReturnType<typeof skinChoice> => skinChoice({ ...person, look: { ...person.look, makeup: 0 } });
  const skinPiece = async (cls: BodyClass, person: PersonSpec): Promise<Piece> => {
    const choice = bareSkin(person);
    let piece = cls.skins.get(choice.name);
    if (!piece) {
      const [skin, eyes] = await skinTextures(choice.name, choice.url, choice.eyeFile);
      piece = cls.skins.get(choice.name);
      if (piece) return piece;
      const geometry = new BufferGeometry();
      for (const [name, attribute] of Object.entries(cls.body.attributes)) {
        if (name !== 'aRow' && name !== 'aDye' && name !== 'aWorn') geometry.setAttribute(name, attribute);
      }
      geometry.setIndex(cls.body.index);
      piece = makePiece(cls, `skin-${choice.name}`, 'skin', geometry, skin, eyes);
      cls.skins.set(choice.name, piece);
    }
    return piece;
  };

  const wornPiece = async (cls: BodyClass, name: string): Promise<Piece> => {
    const known = cls.pieces.get(name);
    if (known) return known;
    const it = await item(name);
    const map = await textureOf(name, it);
    const again = cls.pieces.get(name);
    if (again) return again;
    await breathe();
    const fitAt = performance.now();
    const fitted = cls.rig.wear!(it, cls.shape);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(fitted.positions, 3));
    const n = fitted.positions.length / 3;
    geometry.setAttribute('uv', new Float32BufferAttribute(it.pack.uvs ?? new Float32Array(n * 2), 2));
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(fitted.joints, 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(fitted.weights, 4));
    geometry.setAttribute('aRefs', new Float32BufferAttribute(Float32Array.from(it.pack.refs), 3));
    geometry.setAttribute('aRefW', new Float32BufferAttribute(it.pack.weights, 3));
    geometry.setAttribute('eyeMask', new Float32BufferAttribute(new Float32Array(n), 1));
    if (it.pack.fade) geometry.setAttribute('aFade', new Float32BufferAttribute(it.pack.fade, 1));
    geometry.setIndex(Array.from(it.pack.index));
    geometry.computeVertexNormals();
    const piece = makePiece(cls, name, kindOf(it), geometry, map, null, name.startsWith('hair:'));
    performance.measure(`hitch:person/fit ${cls.key} ${name}`, { start: fitAt, end: performance.now() });
    cls.pieces.set(name, piece);
    return piece;
  };

  /**
   * Strands close up: a grown hairstyle's strands (`generateHairStrands`)
   * drawn as lines over its cards on the few people nearest the camera,
   * fitted to the class body and moved by the same skeleton and shape as
   * the cards. The rest of the crowd has the cards alone.
   */
  const NEAR = 8, NEAR_RANGE = 14;
  let strandTexture: DataTexture | null = null;
  /** A strand ribbon's texture: solid across (its edges fade in the shader), root to tip in G. */
  const strandMap = (): DataTexture => {
    if (!strandTexture) {
      const data = new Uint8Array(4 * 64 * 4);
      for (let y = 0; y < 64; y++) for (let x = 0; x < 4; x++) {
        const i = (y * 4 + x) * 4;
        data[i] = 110; data[i + 1] = Math.round(y / 63 * 255); data[i + 2] = 128; data[i + 3] = 255;
      }
      strandTexture = new DataTexture(data, 4, 64, RGBAFormat, UnsignedByteType);
      strandTexture.magFilter = strandTexture.minFilter = NearestFilter;
      strandTexture.needsUpdate = true;
    }
    return strandTexture;
  };
  const strandPieces = new Map<string, Promise<Piece>>();
  /** A grown style's strands on a class body: a piece like the cards, filled each frame with the nearest people. */
  const strandPiece = (cls: BodyClass, grownName: string): Promise<Piece> => {
    const key = `${cls.key}/${grownName}`;
    let made = strandPieces.get(key);
    if (!made) {
      made = setup().then(({ assets: a, morpher: mo }) => {
        const style = HAIR_STYLES[grownName.slice(5)]!;
        const pack = generateHairStrands(style, { positions: mo.base, vertexCount: a.mesh.vertexCount, bodyRange: a.bodyRange,
          joints: a.mesh.joints, weights: a.mesh.weights, boneNames: a.mesh.boneNames, faces: a.mesh.faces });
        const it: ProxyItem = { pack, texture: null, transparent: true, textureFile: null };
        const fitted = cls.rig.wear!(it, cls.shape);
        const geometry = new BufferGeometry();
        const n = fitted.positions.length / 3;
        geometry.setAttribute('position', new Float32BufferAttribute(fitted.positions, 3));
        geometry.setAttribute('uv', new Float32BufferAttribute(pack.uvs!, 2));
        geometry.setAttribute('skinIndex', new Uint16BufferAttribute(fitted.joints, 4));
        geometry.setAttribute('skinWeight', new Float32BufferAttribute(fitted.weights, 4));
        geometry.setAttribute('aRefs', new Float32BufferAttribute(Float32Array.from(pack.refs), 3));
        geometry.setAttribute('aRefW', new Float32BufferAttribute(pack.weights, 3));
        geometry.setAttribute('eyeMask', new Float32BufferAttribute(new Float32Array(n), 1));
        geometry.setAttribute('aFade', new Float32BufferAttribute(pack.fade!, 1));
        geometry.setIndex(Array.from(pack.index));
        geometry.computeVertexNormals();
        const piece = makePiece(cls, `strands-${grownName}`, 'hair', geometry, strandMap(), null, true);
        piece.mesh.castShadow = false;
        piece.mesh.customDepthMaterial = undefined;
        readyStrand.set(key, piece);
        return piece;
      });
      strandPieces.set(key, made);
    }
    return made;
  };
  const shown = new Set<Piece>();
  const strandsUpdate = (eye: Vector3): void => {
    const near = people.filter((p) => p.grown)
      .map((p) => ({ p, d: eye.distanceTo(new Vector3().setFromMatrixPosition(p.matrix)) }))
      .filter((x) => x.d < NEAR_RANGE * (options.unit ?? 1)).sort((a, b) => a.d - b.d).slice(0, NEAR);
    const wanted = new Map<Piece, ProceduralPerson[]>();
    for (const { p } of near) {
      const cls = ready.find((c) => c.sex === p.sex && c.band === p.band)!;
      const piece = readyStrand.get(`${cls.key}/${p.grown}`);
      if (!piece) { void strandPiece(cls, p.grown!); continue; }
      const list = wanted.get(piece) ?? [];
      list.push(p);
      wanted.set(piece, list);
    }
    for (const piece of shown) if (!wanted.has(piece)) { piece.people = []; piece.mesh.count = 0; }
    shown.clear();
    for (const [piece, list] of wanted) {
      piece.people = list;
      list.forEach((person, slot) => {
        piece.rows.setX(slot, person.row);
        piece.dyes.setXYZW(slot, person.hairColour.r, person.hairColour.g, person.hairColour.b, 1);
      });
      piece.rows.needsUpdate = piece.dyes.needsUpdate = true;
      piece.mesh.count = list.length;
      shown.add(piece);
    }
  };
  const readyStrand = new Map<string, Piece>();
  const allStrands = (): Piece[] => [...shown];

  const place = (piece: Piece, person: ProceduralPerson, dye: Color | null, worn?: readonly number[]): void => {
    const slot = piece.people.length;
    if (slot >= piece.rows.count) return;
    piece.people.push(person);
    piece.rows.setX(slot, person.row);
    piece.dyes.setXYZW(slot, dye?.r ?? 1, dye?.g ?? 1, dye?.b ?? 1, dye ? 1 : 0);
    if (piece.worn && worn) piece.worn.setXYZW(slot, worn[0] ?? -1, worn[1] ?? -1, worn[2] ?? -1, worn[3] ?? -1);
    piece.rows.needsUpdate = piece.dyes.needsUpdate = true;
    if (piece.worn) piece.worn.needsUpdate = true;
    piece.mesh.count = piece.people.length;
  };

  return {
    group,
    people,
    async add(spec) {
      const started = epoch;
      const { morpher: mo, assets: a } = await setup();
      const years = yearsFromAge(spec.body.age);
      const band = bandOf(years);
      const sex: WalkSex = spec.body.gender < 0.5 ? 'female' : 'male';
      const cls = await classFor(sex, band);
      const look = proceduralLook(spec, options.hair !== false);
      const names = wornItems(look).filter((nm) => nm !== 'eyes');
      const loaded = await Promise.all(names.map((nm) => item(nm).then((it) => [nm, it] as const, () => null)));
      const worn = loaded.filter((x): x is readonly [string, ProxyItem] => !!x);
      const skin = await skinPiece(cls, spec);
      const pieces = await Promise.all(worn.map(([nm]) => wornPiece(cls, nm)));
      // Shown only with every piece's shaders built: no frame waits for a compile.
      await Promise.all([skin.ready, ...pieces.map((pc) => pc.ready)]);

      await breathe();
      if (epoch !== started) throw new Error('crowd cleared');
      if (cls.rows >= cls.capacity) growRows(cls);
      const row = cls.rows++;
      // Their shape on the class body: their sliders at the class's height
      // (height is the instance's scale), less the class's own.
      const level = { ...spec.body, height: cls.base.height };
      const c = mo.coefficients(level);
      for (let k = 0; k < SHAPES; k++) cls.coef[row * SHAPES + k] = (c[k] ?? 0) - (cls.coefficients[k] ?? 0);
      cls.uniforms.procCoef.value.needsUpdate = true;
      // Their own face: the regional sliders on the class body, posed as it
      // is - the shape basis carries the macro build, this the features.
      if (Object.keys(spec.features).length) {
        const moved = cls.rig.deltas!(mo.shape(cls.base, spec.features));
        const at = row * cls.uniforms.procFaceRows.value * FACE_WIDTH * 4;
        cls.faceVerts.forEach((v, i) => {
          cls.face[at + i * 4] = moved[v * 3]!;
          cls.face[at + i * 4 + 1] = moved[v * 3 + 1]!;
          cls.face[at + i * 4 + 2] = moved[v * 3 + 2]!;
        });
        cls.uniforms.procFace.value.needsUpdate = true;
      }
      const tall = bodyHeight(mo.shape(spec.body), a.bodyRange);
      const level0 = bodyHeight(mo.shape(level), a.bodyRange);
      const scale = tall / Math.max(1e-3, level0);
      const person: ProceduralPerson = {
        spec, band, sex, row, scale, height: tall / 10, items: worn.map(([nm]) => nm),
        grown: worn.find(([nm]) => nm.startsWith('hair:'))?.[0] ?? null, hairColour: new Color(spec.look.hair),
        matrix: new Matrix4(), clip: 'walk', phase: 0, joints: new Float32Array(cls.bones * 3),
      };
      for (let i = 0; i < cls.bones; i++) for (let c = 0; c < 3; c++) {
        let d = 0;
        for (let k = 0; k < SHAPES; k++) d += cls.coef[row * SHAPES + k]! * cls.jointBasis[(i * SHAPES + k) * 3 + c]!;
        person.joints[i * 3 + c] = d;
      }
      const covers = worn.filter(([nm, it]) => COVERING.has(it.pack.kind) && !it.transparent && !nm.startsWith('acc:'))
        .map(([nm, it]) => coverRow(cls, nm, it)).slice(0, 4);
      place(skin, person, bareSkin(spec).tint, covers);
      const hair = new Color(spec.look.hair);
      // The outfit itself is dyed, never its shoes or glasses; hair, brows
      // and lashes take the hair colour.
      const tint = look.outfitTint == null ? null : new Color(look.outfitTint);
      pieces.forEach((piece, i) => {
        const kind = piece.kind;
        // A generated accessory takes a colour of the street's, never the outfit's own.
        const itemName = worn[i]![0];
        const accessory = itemName === 'acc:teeth' ? new Color(0.86, 0.83, 0.74)
          : itemName === 'acc:tongue' ? new Color(0.62, 0.3, 0.3)
          : itemName.startsWith('acc:') ? new Color(ACCESSORY_COLOURS[(spec.id * 7 + i) % ACCESSORY_COLOURS.length]!) : null;
        const dye = kind === 'hair' || kind === 'face' ? hair : accessory ?? (worn[i]![0] === look.outfit ? tint : null);
        place(piece, person, dye);
      });
      cls.people.push(person);
      people.push(person);
      return person;
    },
    ragdoll: {
      skeleton(person) {
        const cls = classOf(person);
        if (!cls) return null;
        const mesh = cls.rig.mesh;
        const bones = mesh.skeleton.bones;
        return {
          names: bones.map((b) => CAPTURE_NAME[b.name] ?? b.name),
          parents: bones.map((b) => bones.indexOf(b.parent as never)),
          inverses: mesh.skeleton.boneInverses,
          local: new Matrix4(),
          bind: mesh.bindMatrix,
        };
      },
      pose(person) {
        const cls = classOf(person);
        if (!cls) return null;
        const width = cls.bones * SKIN_BONE_FLOATS;
        return cls.palette.slice(person.row * width, person.row * width + width);
      },
      standing(person, phase) {
        const cls = classOf(person);
        if (!cls) return null;
        const width = cls.bones * SKIN_BONE_FLOATS, packed = cls.bones * PACKED_BONE_FLOATS;
        const at = person.row * width;
        // Worked out in their own row (their proportions, `refit`), then copied out.
        const keep = cls.palette.slice(at, at + width);
        const clip = cls.clips.idle;
        const f = (phase - Math.floor(phase)) * clip.frames;
        const whole = Math.min(clip.frames, Math.floor(f));
        cls.palette.fill(0, at, at + width);
        blendPackedFrames(cls.palette, at, clip.data, whole * packed, packed, cls.bones, 1 - (f - whole), f - whole);
        refit(cls, person, at);
        const out = cls.palette.slice(at, at + width);
        cls.palette.set(keep, at);
        return out;
      },
      hold(person, palette) {
        if (palette) holds.set(person, palette.slice()); else holds.delete(person);
      },
    },
    update(eye, simTime) {
      if (eye) strandsUpdate(eye);
      for (const cls of ready) {
        const width = cls.bones * SKIN_BONE_FLOATS;
        const packed = cls.bones * PACKED_BONE_FLOATS;
        for (const person of cls.people) {
          // Held by a ragdoll: its pose, the limbs lost still closed.
          const held = holds.get(person);
          if (held && held.length === width) {
            cls.palette.set(held, person.row * width);
            for (const limb of person.lost ?? []) closeLimb(cls, person.row * width, limb);
            continue;
          }
          const clip = cls.clips[person.clip];
          const f = (person.phase - Math.floor(person.phase)) * clip.frames;
          const whole = Math.min(clip.frames, Math.floor(f));
          const at = person.row * width;
          cls.palette.fill(0, at, at + width);
          blendPackedFrames(cls.palette, at, clip.data, whole * packed, packed, cls.bones, 1 - (f - whole), f - whole);
          refit(cls, person, at);
          for (const limb of person.lost ?? []) closeLimb(cls, at, limb);
        }
        cls.uniforms.procBones.value.needsUpdate = true;
        // The face of the moment: blinking, mood, talk, fright (`faceAt`).
        const time = simTime ?? performance.now() / 1000;
        for (const person of cls.people) {
          const w = faceAt(person.spec.id, time, person.activity, person.spec.mood ?? 0);
          const at = person.row * EXPR_SLOTS;
          EXPR.forEach((name, c) => { cls.exprW[at + c] = Math.min(1, w[name] ?? 0); });
        }
        cls.uniforms.procExprW.value.needsUpdate = true;
        for (const piece of [...cls.skins.values(), ...cls.pieces.values(), ...allStrands().filter((sp) => sp.mesh.userData['cls'] === cls.key)]) {
          piece.people.forEach((person, slot) => {
            scaled.makeScale(person.scale, person.scale, person.scale);
            matrix.multiplyMatrices(person.matrix, scaled);
            piece.mesh.setMatrixAt(slot, matrix);
          });
          piece.mesh.instanceMatrix.needsUpdate = true;
        }
      }
    },
    clear() {
      epoch++;
      for (const piece of shown) { piece.people = []; piece.mesh.count = 0; }
      shown.clear();
      for (const cls of ready) {
        for (const piece of [...cls.skins.values(), ...cls.pieces.values()]) {
          piece.people = [];
          piece.mesh.count = 0;
        }
        cls.people.length = 0;
        cls.rows = 0;
      }
      people.length = 0;
    },
    clipDuration(person) {
      const cls = ready.find((c) => c.sex === person.sex && c.band === person.band);
      return cls?.clips[person.clip].duration ?? 1;
    },
    stride(person) {
      const cls = ready.find((c) => c.sex === person.sex && c.band === person.band);
      const clip = person.clip === 'run' ? cls?.clips.run : cls?.clips.walk;
      return (clip?.stride || 1.4) * person.scale;
    },
    async cook() {
      const out = new Map<string, ArrayBuffer>();
      for (const sex of ['female', 'male'] as const) {
        for (const band of ['child', 'young', 'adult', 'senior'] as const) {
          const { shape, rig } = await classRig(sex, band);
          out.set(`class-${sex}-${band}`, packRecord(classRecord(await classData(sex, rig, shape))));
        }
      }
      // The cards of every hairstyle. Not the strands drawn over them close
      // up (`strandPiece`): those are for the few people nearest the camera.
      const { assets: a, morpher: mo } = await setup();
      for (const style of Object.values(HAIR_STYLES)) {
        out.set(`hair-${style.name}`, packRecord(packRecordOf(generateHair(style, hairBase(a, mo)))));
        await breathe();
      }
      out.set('acc-headband', packRecord(packRecordOf(generateHeadband(hairBase(a, mo)))));
      return out;
    },
    async warmClasses() {
      for (const sex of ['female', 'male'] as const) {
        for (const band of ['adult', 'young', 'senior', 'child'] as const) {
          await classFor(sex, band);
          await new Promise<void>((done) => setTimeout(done, 400));
        }
      }
    },
    forget(name) {
      for (const [key, piece] of readyStrand) if (key.endsWith(`/${name}`)) {
        group.remove(piece.mesh); piece.mesh.geometry.dispose(); shown.delete(piece);
        readyStrand.delete(key); strandPieces.delete(key);
      }
      items.delete(name);
      textures.delete(name);
      for (const cls of ready) {
        const piece = cls.pieces.get(name);
        if (!piece) continue;
        group.remove(piece.mesh);
        piece.mesh.geometry.dispose();
        (piece.mesh.material as Material).dispose();
        piece.mesh.customDepthMaterial?.dispose();
        cls.pieces.delete(name);
      }
    },
    probe(person, vertices) {
      const cls = ready.find((c) => c.sex === person.sex && c.band === person.band)!;
      const exact = cls.rig.deltas!(morpher!.shape({ ...person.spec.body, height: cls.base.height }));
      const px = cls.uniforms.procShape.value.image.data as Float32Array;
      return vertices.map((v) => {
        const linear = [0, 0, 0];
        for (let k = 0; k < SHAPES; k++) {
          const c = cls.coef[person.row * SHAPES + k]!;
          for (let a = 0; a < 3; a++) linear[a]! += c * px[(v * SHAPES + k) * 4 + a]!;
        }
        return { v, linear, exact: [exact[v * 3]!, exact[v * 3 + 1]!, exact[v * 3 + 2]!] };
      });
    },
    stats() {
      let pieces = 0, draws = 0, vertices = 0, textureBytes = 0;
      const names = new Set<string>();
      for (const cls of ready) {
        for (const piece of [...cls.skins.values(), ...cls.pieces.values()]) {
          pieces++;
          if (piece.mesh.count) draws++;
          vertices += piece.vertices;
          names.add(piece.name);
        }
        for (const t of [cls.uniforms.procBones.value, cls.uniforms.procCoef.value, cls.uniforms.procShape.value]) {
          textureBytes += (t.image.data as Float32Array).byteLength;
        }
        textureBytes += (cls.uniforms.procCover.value.image.data as Uint8Array).byteLength;
      }
      return { classes: ready.length, people: people.length, pieces, draws, items: names.size, vertices, textureBytes, bakeMs };
    },
  };
}

// The cook (`scripts/cook-people.mjs`, run by hand): every class and hairstyle
// built here once, packed and sent to the development server, which writes
// them to `cooked/procedural/` (`proceduralCook.ts` reads them back).
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __cookProcedural?: () => Promise<{ hash: string | null; names: string[]; bytes: number }> }).__cookProcedural = async () => {
    const files = await createProceduralCrowd({ unit: 1 }).cook();
    let bytes = 0;
    for (const [name, data] of files) {
      const response = await fetch(`/__cook/procedural/${name}.bin`, { method: 'PUT', body: data });
      if (!response.ok) throw new Error(`Cook of ${name}: ${response.status}`);
      bytes += data.byteLength;
    }
    return { hash: proceduralCookHash(), names: [...files.keys()], bytes };
  };
}
