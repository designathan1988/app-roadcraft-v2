// Toldo de lona: superfície contínua da parede até a frente (perfil varrido
// ao longo da largura), abas laterais triangulares, sanefa (caída de pano) na
// borda, braços de metal e listras opcionais. Referencial: x ao longo da
// parede (centro em 0), y para cima, z para fora; a lona nasce em y = top, z = 0.
import type { PartMat, PartSink } from './family';

export interface AwningOptions {
  width: number;
  /** Projeção para fora da parede. */
  depth: number;
  /** Quanto a borda da frente fica abaixo do ponto de fixação. */
  drop: number;
  /** Altura da sanefa (caída de pano na frente). */
  valance: number;
  color: string;
  /** Segunda cor das listras (vazia = lisa). */
  stripe?: string;
  stripeWidth?: number;
  /** Abas laterais fechadas. */
  cheeks?: boolean;
  /** Recorte ondulado na sanefa. */
  scallop?: boolean;
}

const T = 0.025;

export function awning(out: PartSink, top: number, o: AwningOptions): void {
  const { width: w, depth: d, drop } = o;
  const a: PartMat = { slot: 'fabric', color: o.color };
  const b: PartMat = { slot: 'fabric', color: o.stripe || o.color };
  const metal: PartMat = { slot: 'metal', color: '#3a3d40', finish: 'metal' };
  // Perfil (y, z) da lona: da parede (top, 0) à frente (top − drop, d), com espessura.
  const slope: [number, number][] = [
    [top, 0],
    [top - drop, d],
    [top - drop - T, d],
    [top - T, 0],
  ];
  // Listras: faixas alternadas ao longo de x (contínuas, sem frestas).
  const sw = o.stripe ? Math.max(0.15, o.stripeWidth ?? 0.3) : w;
  const n = Math.max(1, Math.round(w / sw));
  const step = w / n;
  for (let i = 0; i < n; i++) {
    const m = i % 2 === 0 ? a : b;
    const x0 = -w / 2 + i * step,
      x1 = x0 + step;
    out.sweepX(m, slope, x0, x1);
    // Sanefa: pano pendurado na borda da frente.
    if (o.valance > 0.02) {
      const v0 = top - drop - T,
        v1 = v0 - o.valance;
      out.sweepX(m, [[v0, d], [v0, d + T], [v1, d + T], [v1, d]], x0, x1);
      if (o.scallop) {
        // Ondas: meia-lua abaixo de cada faixa.
        const r = Math.min(step / 2, o.valance * 0.6);
        const pts: [number, number][] = [];
        for (let k = 0; k <= 8; k++) {
          const t = Math.PI * (k / 8);
          pts.push([x0 + step / 2 - Math.cos(t) * (step / 2), v1 - Math.sin(t) * r]);
        }
        out.prism(m, pts, d, d + T);
      }
    }
  }
  // Abas laterais: triângulo no plano yz em cada ponta.
  if (o.cheeks !== false) {
    for (const x of [-w / 2, w / 2 - T]) {
      out.sweepX(a, [[top, 0], [top - drop - T - o.valance, d], [top - drop - T - o.valance, 0.02]], x, x + T);
    }
  }
  // Braços: da parede até a borda, nas pontas e a cada ~2,5 m.
  const arms = Math.max(2, Math.ceil(w / 2.5) + 1);
  for (let i = 0; i < arms; i++) {
    const x = -w / 2 + 0.06 + ((w - 0.12) * i) / (arms - 1);
    out.rod(metal, [x, top - drop - 0.45, 0.02], [x, top - drop - 0.04, d - 0.04], 0.015, 6);
  }
  // Barra de fixação na parede.
  out.box(metal, [0, top + 0.03, 0.03], [w, 0.06, 0.06]);
}
