// Perfis 2D de vãos (plano xy local, x centrado, y a partir da base).
export type OpeningShape = 'rect' | 'arch' | 'segment' | 'round';
export type Pt = [number, number];

/** Contorno anti-horário do vão. */
export function openingProfile(shape: OpeningShape, w: number, h: number, steps = 14): Pt[] {
  const hw = w / 2;
  if (shape === 'round') {
    const r = Math.min(w, h) / 2;
    const out: Pt[] = [];
    const n = Math.max(16, steps * 2);
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      out.push([Math.cos(a) * r, h / 2 + Math.sin(a) * r]);
    }
    return out;
  }
  if (shape === 'rect') return [[-hw, 0], [hw, 0], [hw, h], [-hw, h]];
  if (shape === 'arch') {
    const r = Math.min(hw, h * 0.6);
    const spring = h - r;
    const out: Pt[] = [[-hw, 0], [hw, 0], [hw, spring]];
    for (let i = 1; i < steps; i++) {
      const a = (i / steps) * Math.PI;
      out.push([Math.cos(a) * hw, spring + Math.sin(a) * r]);
    }
    out.push([-hw, spring]);
    return out;
  }
  // Arco abatido: flecha de 1/6 da largura.
  const rise = Math.min(w / 6, h * 0.3);
  const spring = h - rise;
  const R = (hw * hw + rise * rise) / (2 * rise);
  const cy = h - R;
  const a0 = Math.asin(Math.min(1, hw / R));
  const out: Pt[] = [[-hw, 0], [hw, 0], [hw, spring]];
  for (let i = 1; i < steps; i++) {
    const a = a0 - (i / steps) * 2 * a0;
    out.push([Math.sin(a) * R, cy + Math.cos(a) * R]);
  }
  out.push([-hw, spring]);
  return out;
}

/** Altura do topo do vão na abscissa x (para cortar montantes e baguetes). */
export function openingTop(shape: OpeningShape, w: number, h: number, x: number): number {
  const hw = w / 2;
  if (Math.abs(x) > hw) return 0;
  if (shape === 'rect') return h;
  if (shape === 'round') {
    const r = Math.min(w, h) / 2;
    return h / 2 + Math.sqrt(Math.max(0, r * r - x * x));
  }
  if (shape === 'arch') {
    const r = Math.min(hw, h * 0.6);
    return h - r + r * Math.sqrt(Math.max(0, 1 - (x / hw) ** 2));
  }
  const rise = Math.min(w / 6, h * 0.3);
  const R = (hw * hw + rise * rise) / (2 * rise);
  return h - R + Math.sqrt(Math.max(0, R * R - x * x));
}

/** Altura do início da curva (onde as laterais retas terminam). */
export function openingSpring(shape: OpeningShape, w: number, h: number): number {
  if (shape === 'rect') return h;
  if (shape === 'round') return h / 2;
  if (shape === 'arch') return h - Math.min(w / 2, h * 0.6);
  return h - Math.min(w / 6, h * 0.3);
}

/** Contorno deslocado para fora (guarnições, batentes): o mesmo formato, maior. */
export function inflate(shape: OpeningShape, w: number, h: number, t: number, bottom = 0): Pt[] {
  const p = openingProfile(shape, w + 2 * t, h + t + bottom);
  return p.map(([x, y]) => [x, y - bottom]);
}
