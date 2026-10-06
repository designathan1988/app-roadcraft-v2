import {
  CanvasTexture,
  ClampToEdgeWrapping,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  FloatType,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  RedFormat,
  type Texture,
} from 'three';
import type { MultiPoly } from '@core/clipper';
import { m } from '@world/units';

/**
 * GRASS: a field of single blades round the camera, made on the GPU.
 *
 * As Sucker Punch did for Ghost of Tsushima (Eric Wohllaib, "Procedural Grass
 * in Ghost of Tsushima", GDC 2021) and as GodotGrass (2Retr0) does after it:
 * every blade is an instance of one short strip of triangles, and everything
 * about it - where it stands, how tall, which way it faces, how it bends, how
 * the wind moves it - is worked out in the vertex shader from its index and a
 * hash of the ground cell it stands in. Nothing is stored per blade and nothing
 * runs on the CPU per frame but two uniforms: the field follows the camera,
 * snapped to its own spacing, so a blade stays where it grew while the camera
 * moves over it.
 *
 * - Blades gather in clumps (a cellular hash): a clump leans one way, is one
 *   height and one shade, as real tufts are.
 * - The ground under each blade is read from a height texture of the terrain;
 *   a mask texture keeps the field off roads, footways, buildings and lots.
 * - Wind is a slow travelling wave plus a quick flutter at the tips.
 * - Lit as the ground is: the same standard material - sun, sky light,
 *   shadows, fog - with a colour from a dark base to a pale tip and a light
 *   shining through the blade when it stands against the sun.
 * - The field fades out over its last quarter, blade by blade (each blade
 *   shrinks to nothing at its own random distance), so there is no edge.
 */

export interface Grass {
  readonly mesh: Mesh;
  /** The ground's heights over the plate, `side` x `side` samples, rows from the south edge (y = -size/2) north. */
  setHeights(heights: Float32Array, side: number, size: number): void;
  /** Where blades may not grow: road surfaces and footprints, in world x/y. */
  setBlocked(polys: readonly MultiPoly[], rings: readonly (readonly { x: number; y: number }[])[], size: number): void;
  /** Each frame: where the field stands (three's x and z), whether it is drawn at all, the clock. */
  update(x: number, z: number, visible: boolean, seconds: number): void;
  dispose(): void;
}

/** Blades along each side of the field, and their spacing (units). */
const GRID = 300;
const SPACING = m(0.12);
/** Half the field's side: the grass is drawn this far from the camera's focus. */
const RADIUS = (GRID * SPACING) / 2;
/** The mask's resolution over the whole plate. */
const MASK_SIDE = 2048;

export function createGrass(quality: { readonly grassBlades: number }): Grass {
  // One blade: four rungs and a tip, x across (-0.5..0.5), y up the blade (0..1).
  const rungs = 4;
  const positions: number[] = [];
  for (let k = 0; k < rungs; k++) {
    const y = k / rungs;
    positions.push(-0.5, y, 0, 0.5, y, 0);
  }
  positions.push(0, 1, 0);
  const index: number[] = [];
  for (let k = 0; k + 1 < rungs; k++) {
    const a = k * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  index.push((rungs - 1) * 2, (rungs - 1) * 2 + 1, rungs * 2);
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(positions.map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
  geometry.setIndex(index);
  const side = Math.max(60, Math.min(GRID, Math.round(Math.sqrt(quality.grassBlades))));
  geometry.instanceCount = side * side;
  // The field is placed in the shader: bounds big enough never to be culled.
  geometry.boundingSphere = null;

  const heightTexture = new DataTexture(new Float32Array(4), 2, 2, RedFormat, FloatType);
  heightTexture.magFilter = LinearFilter;
  heightTexture.minFilter = LinearFilter;
  heightTexture.needsUpdate = true;
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = maskCanvas.height = MASK_SIDE;
  const maskTexture = new CanvasTexture(maskCanvas);
  maskTexture.wrapS = maskTexture.wrapT = ClampToEdgeWrapping;
  maskTexture.magFilter = LinearFilter;
  maskTexture.minFilter = LinearFilter;
  maskTexture.generateMipmaps = false;
  {
    const g = maskCanvas.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, MASK_SIDE, MASK_SIDE);
    maskTexture.needsUpdate = true;
  }

  const uniforms = {
    uGrassOrigin: { value: [0, 0] as [number, number] },
    uGrassFocus: { value: [0, 0] as [number, number] },
    uGrassTime: { value: 0 },
    uGrassSide: { value: side },
    uGrassSpacing: { value: SPACING * (GRID / side) },
    uGrassRadius: { value: RADIUS },
    uGrassHeight: { value: heightTexture as Texture },
    uGrassMask: { value: maskTexture as Texture },
    uGrassPlate: { value: [0, 1] as [number, number] },
  };

  // Matte, and taking less of the sky's light than the ground does: blades lit
  // edge-on caught the sky and read blue.
  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, side: DoubleSide, envMapIntensity: 0.55 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform vec2 uGrassOrigin;
        uniform vec2 uGrassFocus;
        uniform float uGrassTime;
        uniform float uGrassSide;
        uniform float uGrassSpacing;
        uniform float uGrassRadius;
        uniform sampler2D uGrassHeight;
        uniform sampler2D uGrassMask;
        uniform vec2 uGrassPlate; // half and size of the plate
        varying float vGrassUp;
        varying vec3 vGrassTint;
        varying float vGrassThrough;
        float grassHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        vec2 grassHash2(vec2 p) { return vec2(grassHash(p), grassHash(p + 17.31)); }
        // The nearest clump centre on a jittered lattice (a cellular hash).
        vec3 grassClump(vec2 p) {
          vec2 cell = floor(p / ${m(2.4).toFixed(3)});
          float best = 1e9; vec2 id = cell;
          for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
            vec2 c = cell + vec2(float(i), float(j));
            vec2 at = (c + grassHash2(c)) * ${m(2.4).toFixed(3)};
            float d = dot(at - p, at - p);
            if (d < best) { best = d; id = c; }
          }
          return vec3(id, sqrt(best));
        }
        // World x/y (y north) to the plate's texture space, as the terrain's paint is read.
        vec2 grassUv(vec2 p) { return vec2((p.x + uGrassPlate.x) / uGrassPlate.y, (p.y + uGrassPlate.x) / uGrassPlate.y); }`)
      .replace('#include <beginnormal_vertex>', `
        // ---- the blade's place, from its index and the ground cell it stands in
        float gi = float(gl_InstanceID);
        vec2 slot = vec2(mod(gi, uGrassSide), floor(gi / uGrassSide)) - uGrassSide * 0.5;
        vec2 cellPos = uGrassOrigin + slot * uGrassSpacing;
        vec2 cellId = floor(cellPos / uGrassSpacing + 0.5);
        vec2 jitter = grassHash2(cellId) - 0.5;
        vec2 root = cellPos + jitter * uGrassSpacing * 1.6;
        vec3 clump = grassClump(root);
        float clumpH = grassHash(clump.xy + 3.7);
        float r1 = grassHash(cellId + 7.13), r2 = grassHash(cellId + 2.71), r3 = grassHash(cellId + 9.4);
        vec2 uv = grassUv(root);
        float onPlate = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
        float allowed = texture2D(uGrassMask, uv).r * onPlate;
        // Fade out over the field's last quarter, each blade at its own distance.
        float dist = length(root - uGrassFocus);
        float fade = 1.0 - smoothstep(uGrassRadius * (0.55 + 0.3 * r3), uGrassRadius * 0.98, dist);
        // Patchy: some ground is barer than other.
        float grassPatch = smoothstep(0.15, 0.55, grassHash(floor(root / ${m(7).toFixed(3)})) * 0.6 + clumpH * 0.6);
        float tall = (${m(0.14).toFixed(3)} + ${m(0.32).toFixed(3)} * (clumpH * 0.7 + r1 * 0.3)) * mix(0.55, 1.0, grassPatch);
        float keep = allowed * fade * step(0.25, allowed);
        tall *= keep;
        float wide = ${m(0.032).toFixed(3)} * (0.75 + r2 * 0.5) * keep;
        // Facing: round the clump's own lean, spread a little.
        vec2 toCentre = normalize(clump.xy * ${m(2.4).toFixed(3)} - root + 1e-4);
        float facing = atan(toCentre.y, toCentre.x) + (r1 - 0.5) * 2.4;
        vec2 across = vec2(cos(facing), sin(facing));
        vec2 lean = vec2(-across.y, across.x);
        // Wind: a slow wave travelling over the field, and a flutter.
        float wave = sin(dot(root, vec2(0.021, 0.013)) - uGrassTime * 1.3) * 0.5 + 0.5;
        float flutter = sin(uGrassTime * 6.0 + r2 * 40.0) * 0.12;
        float bendTip = (0.35 + clumpH * 0.4) + wave * 0.55 + flutter;
        float t = position.y;
        float bend = bendTip * t * t;
        vec2 windDir = normalize(vec2(0.8, 0.6));
        vec2 sway = lean * bend * 0.6 + windDir * wave * t * t * 0.5;
        float ground = texture2D(uGrassHeight, uv).r;
        float taper = (1.0 - t * 0.85);
        vec2 grassAt = root + across * position.x * wide * taper + sway * tall;
        float up = tall * t * (1.0 - 0.25 * bend);
        vGrassUp = t;
        vGrassTint = vec3(clumpH, r1, grassPatch);
        // Light through the blade, strongest at the tip.
        vGrassThrough = t;
        // Normal: the blade's face, rounded across it and tipped by the bend.
        vec3 faceN = normalize(vec3(lean.x, 0.0, -lean.y));
        vec3 objectNormal = normalize(faceN + vec3(across.x, 0.0, -across.y) * position.x * 0.9 + vec3(0.0, 0.6 + bend, 0.0));
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(across.x, 0.0, -across.y);
        #endif`)
      .replace('#include <begin_vertex>', `vec3 transformed = vec3(grassAt.x, ground + up, -grassAt.y);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vGrassUp;
        varying vec3 vGrassTint;
        varying float vGrassThrough;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        // Dark at the root, pale green at the tip; clumps a little drier or lusher.
        vec3 grassBase = vec3(0.018, 0.04, 0.014);
        vec3 grassTip = mix(vec3(0.075, 0.15, 0.04), vec3(0.15, 0.17, 0.05), vGrassTint.x * 0.6);
        grassTip = mix(grassTip, vec3(0.06, 0.13, 0.035), vGrassTint.y * 0.35);
        diffuseColor.rgb = mix(grassBase, grassTip, smoothstep(0.0, 1.0, vGrassUp));`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        // Sun through the blade: a warm glow at the tip that does not depend on facing.
        totalEmissiveRadiance += vec3(0.012, 0.018, 0.004) * vGrassThrough * vGrassThrough;`);
  };
  material.customProgramCacheKey = () => 'grass-field-v2';

  const mesh = new Mesh(geometry, material);
  mesh.name = 'grass';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.visible = false;

  return {
    mesh,
    setHeights(heights, n, size) {
      heightTexture.image = { data: heights, width: n, height: n } as unknown as typeof heightTexture.image;
      heightTexture.needsUpdate = true;
      uniforms.uGrassPlate.value = [size / 2, size];
    },
    setBlocked(polys, rings, size) {
      const g = maskCanvas.getContext('2d')!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#fff';
      g.fillRect(0, 0, MASK_SIDE, MASK_SIDE);
      // World x/y to mask pixels: x east, y north -> rows from the north edge.
      const k = MASK_SIDE / size, half = size / 2;
      g.setTransform(k, 0, 0, -k, half * k, half * k);
      g.fillStyle = '#000';
      for (const multi of polys) {
        for (const poly of multi) {
          g.beginPath();
          for (const ring of poly) {
            ring.forEach(([x, y], i) => (i === 0 ? g.moveTo(x!, y!) : g.lineTo(x!, y!)));
            g.closePath();
          }
          g.fill('evenodd');
        }
      }
      for (const ring of rings) {
        g.beginPath();
        ring.forEach((p, i) => (i === 0 ? g.moveTo(p.x, p.y) : g.lineTo(p.x, p.y)));
        g.closePath();
        g.fill();
      }
      maskTexture.needsUpdate = true;
    },
    update(x, z, visible, seconds) {
      mesh.visible = visible;
      if (!visible) return;
      const s = uniforms.uGrassSpacing.value;
      uniforms.uGrassOrigin.value = [Math.round(x / s) * s, Math.round(-z / s) * s];
      uniforms.uGrassFocus.value = [x, -z];
      uniforms.uGrassTime.value = seconds % 1000;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      heightTexture.dispose();
      maskTexture.dispose();
    },
  };
}
