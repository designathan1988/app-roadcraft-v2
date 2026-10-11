// Imagens do projeto (fotos, cartazes, logos) como texturas, carregadas uma
// vez por imagem e compartilhadas por todas as placas que a usam.
import * as THREE from 'three';
import type { ProjectImage } from '../model/schema';

const data = new Map<string, string>();
const textures = new Map<string, THREE.Texture>();
const listeners = new Set<() => void>();

/** Avisa quando uma imagem termina de carregar (a vista redesenha). */
export function onImageLoad(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Registra as imagens do projeto (chamado a cada sincronização da vista). */
export function setProjectImages(list: ProjectImage[] | undefined): void {
  for (const im of list ?? []) if (data.get(im.id) !== im.data) {
    data.set(im.id, im.data);
    textures.get(im.id)?.dispose();
    textures.delete(im.id);
  }
}

/** Textura de uma imagem do projeto (vazia até carregar). */
export function imageTexture(id: string, anisotropy = 8): THREE.Texture {
  let t = textures.get(id);
  if (t) return t;
  t = new THREE.Texture();
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  textures.set(id, t);
  const src = data.get(id);
  if (src && typeof Image !== 'undefined') {
    const img = new Image();
    img.onload = () => {
      t!.image = img;
      t!.needsUpdate = true;
      for (const fn of listeners) fn();
    };
    img.src = src;
  }
  return t;
}

/** Lê um arquivo de imagem, reduz a no máximo 2048 px e devolve como dado embutido. */
export function readImageFile(file: File): Promise<ProjectImage> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('não foi possível ler o arquivo'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('o arquivo não é uma imagem'));
      img.onload = () => {
        const k = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * k));
        c.height = Math.max(1, Math.round(img.naturalHeight * k));
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
        const png = /png|gif|webp/.test(file.type);
        resolve({ id: (globalThis.crypto?.randomUUID?.() ?? `img-${Date.now()}`), name: file.name.replace(/\.[^.]+$/, '').slice(0, 60) || 'Imagem', data: c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.9), w: c.width, h: c.height });
      };
      img.src = String(fr.result);
    };
    fr.readAsDataURL(file);
  });
}
