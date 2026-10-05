import { CanvasTexture, LinearMipmapLinearFilter, SRGBColorSpace } from 'three';

/**
 * The strands a procedural hair card carries (`people/hair/procedural.ts`):
 * four strips side by side, each many thin tapered strands from the root
 * (top, v = 0) to ragged tips, grey so the person's hair colour dyes them,
 * darker towards the roots where the hair is deepest - the texture islands
 * of a hair card atlas, painted instead of rendered from a groom.
 */
const CACHE = new Map<string, CanvasTexture>();

export function hairStrandTexture(kind: 'straight' | 'wavy'): CanvasTexture {
  const known = CACHE.get(kind);
  if (known) return known;
  const W = 512, H = 1024, strips = 4, sw = W / strips;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d')!;
  let s = kind === 'wavy' ? 7 : 3;
  const rnd = (): number => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  g.lineCap = 'round';
  for (let strip = 0; strip < strips; strip++) {
    const x0 = strip * sw;
    // The top band is solid: the painted scalp (the cap) is mapped there.
    g.fillStyle = 'rgb(118,118,118)';
    g.fillRect(x0, 0, sw, H * 0.03);
    // Under-layer first (dense, darker), then the lighter strands on top.
    for (let pass = 0; pass < 2; pass++) {
      const count = pass === 0 ? 90 : 170;
      for (let k = 0; k < count; k++) {
        const x = x0 + 6 + rnd() * (sw - 12);
        const tip = H * (pass === 0 ? 0.85 + rnd() * 0.15 : 0.7 + rnd() * 0.3);
        const sway = (rnd() - 0.5) * 10, freq = 2 + rnd() * 2, phase = rnd() * 6.28;
        // Close greys: strands, not stripes.
        const grey = pass === 0 ? 120 + rnd() * 35 : 150 + rnd() * 60;
        const width = pass === 0 ? 3 + rnd() * 2 : 1.4 + rnd() * 1.6;
        const steps = 24;
        for (let i = 0; i < steps; i++) {
          const t0 = i / steps, t1 = (i + 1) / steps;
          const y0 = t0 * tip, y1 = t1 * tip;
          const off = (t: number): number => (kind === 'wavy' ? Math.sin(t * freq * 6.28 + phase) * 7 : 0) + sway * t * t;
          // Deeper at the root, thinning to the tip.
          const shade = grey * (0.62 + 0.38 * Math.min(1, t0 * 2.5));
          const alpha = (pass === 0 ? 0.95 : 0.9) * (1 - Math.max(0, (t0 - 0.75) / 0.25) * 0.7);
          g.strokeStyle = `rgba(${shade | 0},${shade | 0},${shade | 0},${alpha.toFixed(3)})`;
          g.lineWidth = Math.max(0.6, width * (1 - 0.6 * t0));
          g.beginPath();
          g.moveTo(Math.min(x0 + sw - 2, Math.max(x0 + 2, x + off(t0))), y0);
          g.lineTo(Math.min(x0 + sw - 2, Math.max(x0 + 2, x + off(t1))), y1);
          g.stroke();
        }
      }
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.flipY = false;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = 4;
  CACHE.set(kind, texture);
  return texture;
}
