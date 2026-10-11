// Texturas procedurais (canvas) para os estilos. São claras e quase sem cor:
// a cor do material as tinge. Cada imagem é UMA repetição; o tamanho real em
// metros vem de `scale` (texture.repeat = 1/scale, com UVs em metros).
import * as THREE from 'three';
import type { TextureKind } from '../styles/schema';

const SIZE = 256;

function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

function draw(kind: TextureKind, g: CanvasRenderingContext2D) {
  const r = rng(kind.length * 977 + 13);
  const shade = (v: number) => {
    const c = Math.round(255 * Math.max(0, Math.min(1, v)));
    return `rgb(${c},${c},${c})`;
  };
  const noise = (amount: number, count = 2600, size = 2) => {
    for (let i = 0; i < count; i++) {
      g.fillStyle = shade(1 - r() * amount);
      g.fillRect(r() * SIZE, r() * SIZE, size, size);
    }
  };
  g.fillStyle = shade(0.96);
  g.fillRect(0, 0, SIZE, SIZE);
  if (kind === 'brick') {
    const rows = 12,
      perRow = 4,
      rh = SIZE / rows,
      bw = SIZE / perRow;
    g.fillStyle = shade(0.78);
    g.fillRect(0, 0, SIZE, SIZE);
    for (let y = 0; y < rows; y++)
      for (let x = -1; x < perRow; x++) {
        const ox = (y % 2) * (bw / 2);
        g.fillStyle = shade(0.86 + r() * 0.14);
        g.fillRect(x * bw + ox + 2, y * rh + 2, bw - 4, rh - 4);
      }
    noise(0.12, 1800);
  } else if (kind === 'stone') {
    const rows = 3,
      rh = SIZE / rows;
    g.fillStyle = shade(0.74);
    g.fillRect(0, 0, SIZE, SIZE);
    for (let y = 0; y < rows; y++) {
      let x = -((y * 53) % 90);
      while (x < SIZE) {
        const w = 60 + r() * 70;
        g.fillStyle = shade(0.84 + r() * 0.14);
        g.fillRect(x + 3, y * rh + 3, w - 6, rh - 6);
        x += w;
      }
    }
    noise(0.15, 3000);
  } else if (kind === 'concrete') {
    noise(0.08, 5000, 2);
    g.strokeStyle = shade(0.8);
    g.lineWidth = 2;
    g.strokeRect(1, 1, SIZE - 2, SIZE - 2);
    g.fillStyle = shade(0.7);
    for (const [x, y] of [
      [0.2, 0.25],
      [0.8, 0.25],
      [0.2, 0.75],
      [0.8, 0.75],
    ]) {
      g.beginPath();
      g.arc(x! * SIZE, y! * SIZE, 4, 0, Math.PI * 2);
      g.fill();
    }
  } else if (kind === 'plaster') {
    noise(0.07, 7000, 3);
  } else if (kind === 'tile') {
    const rows = 6,
      cols = 6,
      rh = SIZE / rows,
      cw = SIZE / cols;
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const grad = g.createLinearGradient(x * cw, 0, (x + 1) * cw, 0);
        const b = 0.86 + r() * 0.1;
        grad.addColorStop(0, shade(b - 0.22));
        grad.addColorStop(0.5, shade(b));
        grad.addColorStop(1, shade(b - 0.22));
        g.fillStyle = grad;
        g.fillRect(x * cw + ((y % 2) * cw) / 2, y * rh, cw, rh - 3);
        g.fillRect(x * cw + ((y % 2) * cw) / 2 - SIZE, y * rh, cw, rh - 3);
        g.fillStyle = shade(0.6);
        g.fillRect(0, y * rh + rh - 3, SIZE, 3);
      }
  } else if (kind === 'wood') {
    const planks = 8,
      pw = SIZE / planks;
    for (let x = 0; x < planks; x++) {
      g.fillStyle = shade(0.82 + r() * 0.14);
      g.fillRect(x * pw, 0, pw - 2, SIZE);
      for (let k = 0; k < 6; k++) {
        g.fillStyle = shade(0.76 + r() * 0.1);
        g.fillRect(x * pw + r() * pw, 0, 1, SIZE);
      }
    }
  } else if (kind === 'metal') {
    const ribs = 8,
      w = SIZE / ribs;
    for (let x = 0; x < ribs; x++) {
      const grad = g.createLinearGradient(x * w, 0, (x + 1) * w, 0);
      grad.addColorStop(0, shade(0.74));
      grad.addColorStop(0.35, shade(1));
      grad.addColorStop(0.7, shade(0.86));
      grad.addColorStop(1, shade(0.74));
      g.fillStyle = grad;
      g.fillRect(x * w, 0, w, SIZE);
    }
  }
}

/** Cache de texturas por (tipo, escala). Sem DOM (servidor/worker), devolve null. */
export function createTextureCache() {
  const images = new Map<TextureKind, HTMLCanvasElement>();
  const textures = new Map<string, THREE.Texture>();
  return {
    get(kind: TextureKind, scale: number): THREE.Texture | null {
      if (typeof document === 'undefined') return null;
      const key = `${kind}|${scale}`;
      let t = textures.get(key);
      if (t) return t;
      let img = images.get(kind);
      if (!img) {
        img = document.createElement('canvas');
        img.width = img.height = SIZE;
        const g = img.getContext('2d');
        if (!g) return null;
        draw(kind, g);
        images.set(kind, img);
      }
      t = new THREE.CanvasTexture(img);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(1 / scale, 1 / scale);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      t.name = `forma-${kind}`;
      textures.set(key, t);
      return t;
    },
    dispose() {
      for (const t of textures.values()) t.dispose();
      textures.clear();
    },
  };
}
