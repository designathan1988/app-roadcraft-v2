// Texturas PBR reais por acabamento (cor, normal e rugosidade, 1K), no lugar
// do ruído procedural. Um conjunto por acabamento, compartilhado por todos os
// materiais que o usam (a cor do documento tinge). A cor vira um "detalhe"
// neutro: luminância linear dividida pela média, com contraste ajustável, para
// o tijolo poder ser de qualquer cor sem perder argamassa e variação.
import * as THREE from 'three';

export interface PbrSet {
  dir: string;
  /** Largura real de uma repetição (m); a altura sai da proporção da imagem. */
  width: number;
  normalScale: number;
  /** Força da variação de cor (0 = liso, 1 = como a foto). */
  contrast: number;
}

/** Acabamento → conjunto. */
export const PBR_SETS: Record<string, PbrSet> = {
  'plaster-photo': { dir: 'Plaster001', width: 2.0, normalScale: 0.9, contrast: 0.55 },
  'brick-photo': { dir: 'Bricks085', width: 2.4, normalScale: 1.0, contrast: 0.9 },
  'stone-photo': { dir: 'Bricks066', width: 2.4, normalScale: 1.0, contrast: 0.7 },
  'concrete-photo': { dir: 'Concrete034', width: 2.2, normalScale: 0.6, contrast: 0.5 },
  'wood-photo': { dir: 'Wood049', width: 0.8, normalScale: 0.7, contrast: 0.8 },
  'metal-photo': { dir: 'CorrugatedSteel007B', width: 2.0, normalScale: 1.0, contrast: 0.5 },
  'tile-photo': { dir: 'RoofingTiles006', width: 3.2, normalScale: 1.2, contrast: 0.8 },
  'slate-photo': { dir: 'RoofingTiles003', width: 2.0, normalScale: 1.0, contrast: 0.8 },
};

/** Média do detalhe guardado (o material compensa multiplicando a cor). */
export const DETAIL_MEAN = 0.8;

export interface PbrTextures {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  set: PbrSet;
}

const listeners = new Set<() => void>();
/** Avisa quando uma textura termina de carregar (a vista redesenha). */
export function onPbrLoad(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const loaded = () => {
  for (const fn of listeners) fn();
};

let base = './tex/';
/** Pasta das texturas (servidas ao lado do app). */
export function setPbrBase(url: string): void {
  base = url.endsWith('/') ? url : url + '/';
}

let anisotropy = 8;
export function setPbrAnisotropy(n: number): void {
  anisotropy = Math.max(1, n);
  for (const t of cache.values()) for (const x of [t.map, t.normalMap, t.roughnessMap]) x.anisotropy = anisotropy;
}

const cache = new Map<string, PbrTextures>();

function wrap(t: THREE.Texture, set: PbrSet, aspect: number): void {
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  // UVs em metros: uma repetição = largura real; altura pela proporção da imagem.
  t.repeat.set(1 / set.width, 1 / (set.width * aspect));
  t.anisotropy = anisotropy;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** Imagem colorida → detalhe cinza neutro (média DETAIL_MEAN em linear). */
function neutralDetail(img: HTMLImageElement, contrast: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height);
  const px = data.data;
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = toLinear(i / 255);
  const n = px.length / 4;
  const lum = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const l = 0.2126 * lut[px[i * 4]!]! + 0.7152 * lut[px[i * 4 + 1]!]! + 0.0722 * lut[px[i * 4 + 2]!]!;
    lum[i] = l;
    sum += l;
  }
  const mean = sum / n || 1;
  for (let i = 0; i < n; i++) {
    const r = 1 + (lum[i]! / mean - 1) * contrast;
    const v = Math.round(255 * toSrgb(Math.max(0, Math.min(1, r * DETAIL_MEAN))));
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v;
    px[i * 4 + 3] = 255;
  }
  g.putImageData(data, 0, 0);
  return c;
}

/** Conjunto de um acabamento (carrega na primeira vez; as texturas se preenchem ao chegar). */
export function pbrFor(finish: string): PbrTextures | null {
  const set = PBR_SETS[finish];
  if (!set || typeof document === 'undefined') return null;
  const key = finish;
  let t = cache.get(key);
  if (t) return t;
  const map = new THREE.Texture();
  map.colorSpace = THREE.SRGBColorSpace;
  const normalMap = new THREE.Texture();
  normalMap.colorSpace = THREE.NoColorSpace;
  const roughnessMap = new THREE.Texture();
  roughnessMap.colorSpace = THREE.NoColorSpace;
  t = { map, normalMap, roughnessMap, set };
  cache.set(key, t);
  for (const x of [map, normalMap, roughnessMap]) wrap(x, set, 1);
  const load = (file: string, use: (img: HTMLImageElement) => void) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      use(img);
      loaded();
    };
    img.src = `${base}${set.dir}/${file}`;
  };
  load('color.jpg', (img) => {
    const aspect = img.naturalHeight / img.naturalWidth;
    for (const x of [map, normalMap, roughnessMap]) wrap(x, set, aspect);
    map.image = neutralDetail(img, set.contrast);
    map.needsUpdate = true;
  });
  load('normal.jpg', (img) => {
    normalMap.image = img;
    normalMap.needsUpdate = true;
  });
  load('rough.jpg', (img) => {
    roughnessMap.image = img;
    roughnessMap.needsUpdate = true;
  });
  return t;
}

export function disposePbr(): void {
  for (const t of cache.values()) for (const x of [t.map, t.normalMap, t.roughnessMap]) x.dispose();
  cache.clear();
}
