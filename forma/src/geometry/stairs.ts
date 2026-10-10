// Escadas: degraus ao longo de um caminho (reta, L, U...) com patamar quadrado
// em cada vértice interno, e a projeção que recorta a laje do pavimento de cima.
import type { Vec2 } from '../core/schema';
import { clean } from './polygon';
import { union, type PolygonWithHoles } from './boolean';

export const RISER = 0.175;

export interface StairStep {
  /** Centro em planta, ângulo (rotação em Y) e dimensões. */
  center: Vec2;
  angle: number;
  length: number;
  width: number;
  /** Altura do topo do degrau acima do piso de partida. */
  top: number;
  landing: boolean;
}

function rect(a: Vec2, b: Vec2, width: number): Vec2[] {
  const dx = b[0] - a[0],
    dz = b[1] - a[1],
    l = Math.hypot(dx, dz) || 1,
    nx = (-dz / l) * (width / 2),
    nz = (dx / l) * (width / 2);
  return clean([
    [a[0] + nx, a[1] + nz],
    [b[0] + nx, b[1] + nz],
    [b[0] - nx, b[1] - nz],
    [a[0] - nx, a[1] - nz],
  ]);
}

/** Projeção da escada em planta (recorte da laje de cima). */
export function stairFootprint(path: Vec2[], width: number): PolygonWithHoles[] {
  const parts: PolygonWithHoles[] = [];
  for (let i = 0; i < path.length - 1; i++) parts.push([rect(path[i]!, path[i + 1]!, width)]);
  for (let i = 1; i < path.length - 1; i++) {
    const p = path[i]!,
      h = width / 2;
    parts.push([clean([[p[0] - h, p[1] - h], [p[0] + h, p[1] - h], [p[0] + h, p[1] + h], [p[0] - h, p[1] + h]])]);
  }
  return parts.length > 1 ? union(parts) : parts;
}

/** Degraus e patamares para vencer `rise` metros. */
export function stairSteps(path: Vec2[], width: number, rise: number): StairStep[] {
  if (path.length < 2 || rise <= 0) return [];
  const half = width / 2;
  // Lances: cada segmento, encurtado meio patamar nos vértices internos.
  const flights = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!,
      b = path[i + 1]!,
      l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-6) continue;
    const tx = (b[0] - a[0]) / l,
      tz = (b[1] - a[1]) / l;
    const s = i > 0 ? half : 0,
      e = i < path.length - 2 ? half : 0;
    const len = Math.max(0, l - s - e);
    flights.push({ start: [a[0] + tx * s, a[1] + tz * s] as Vec2, tx, tz, len });
  }
  const total = flights.reduce((s, f) => s + f.len, 0);
  const n = Math.max(3, Math.round(rise / RISER));
  const riser = rise / n;
  // Distribui os degraus pelos lances, proporcional ao comprimento.
  const counts = flights.map((f) => Math.max(1, Math.round((n * f.len) / (total || 1))));
  let diff = n - counts.reduce((s, c) => s + c, 0);
  for (let i = 0; diff !== 0 && i < 1000; i++) {
    const k = i % counts.length;
    if (diff > 0) {
      counts[k]!++;
      diff--;
    } else if (counts[k]! > 1) {
      counts[k]!--;
      diff++;
    }
  }
  const steps: StairStep[] = [];
  let h = 0;
  flights.forEach((f, i) => {
    const c = counts[i]!,
      tread = f.len / c,
      angle = -Math.atan2(f.tz, f.tx);
    for (let k = 0; k < c; k++) {
      h += riser;
      const s = tread * (k + 0.5);
      steps.push({ center: [f.start[0] + f.tx * s, f.start[1] + f.tz * s], angle, length: tread, width, top: h, landing: false });
    }
    if (i < flights.length - 1) steps.push({ center: path[i + 1]!, angle, length: width, width, top: h, landing: true });
  });
  return steps;
}

/** Altura do piso da escada no ponto p (para caminhar sobre ela), ou null fora dela. */
export function stairHeightAt(path: Vec2[], width: number, rise: number, p: Vec2): number | null {
  let best: number | null = null;
  for (const s of stairSteps(path, width, rise)) {
    const c = Math.cos(-s.angle),
      sn = Math.sin(-s.angle);
    const dx = p[0] - s.center[0],
      dz = p[1] - s.center[1];
    const u = dx * c + dz * sn,
      v = -dx * sn + dz * c;
    if (Math.abs(u) <= s.length / 2 + 1e-6 && Math.abs(v) <= s.width / 2 + 1e-6) best = Math.max(best ?? 0, s.top);
  }
  return best;
}
