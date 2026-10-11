// Inferência (como o SketchUp): o cursor gruda em vértices, meios de lado,
// centros, arestas, eixos a partir do último ponto (no referencial do edifício
// em edição), paralelos/perpendiculares a um lado já visto e na grade.
// Tolerância em pixels de tela; a prioridade segue a ordem acima.
import * as THREE from 'three';
import type { Building3, Project3, Vec2 } from '../model/schema';
import { oriented, sampleRing } from '../model/plan';
import { toWorld } from '../model/ops';
import type { View } from './view';

export type SnapKind = 'vertex' | 'mid' | 'center' | 'edge' | 'axis' | 'parallel' | 'perp' | 'grid' | 'free' | 'height' | 'level';

export interface Snap {
  kind: SnapKind;
  p: THREE.Vector3;
  label: string;
  /** Linha de referência (eixo, paralelo) para desenhar. */
  line?: [THREE.Vector3, THREE.Vector3];
  color: string;
}

export const SNAP_COLORS: Record<SnapKind, string> = {
  vertex: '#1f9d55',
  mid: '#1aa3c9',
  center: '#7a4fd1',
  edge: '#d63b3b',
  axis: '#d63b3b',
  parallel: '#c026d3',
  perp: '#c026d3',
  grid: '#6b7280',
  free: '#6b7280',
  height: '#2563eb',
  level: '#2563eb',
};

const LABELS: Record<SnapKind, string> = {
  vertex: 'Ponto',
  mid: 'Meio',
  center: 'Centro',
  edge: 'Na aresta',
  axis: 'No eixo',
  parallel: 'Paralelo',
  perp: 'Perpendicular',
  grid: 'Grade',
  free: '',
  height: 'Mesma altura',
  level: 'Nível',
};

interface Feature {
  kind: 'vertex' | 'mid' | 'center';
  p: THREE.Vector3;
}

interface Seg {
  a: THREE.Vector3;
  b: THREE.Vector3;
}

export class Inference {
  grid = 0.5;
  enabled = true;
  /** Eixos de referência (do edifício em edição). */
  axisAngle = 0;
  private features: Feature[] = [];
  private segs: Seg[] = [];
  private key = '';

  constructor(private view: View) {}

  /** Refaz os pontos de encaixe quando o documento muda. */
  refresh(p: Project3, revisionKey: string, skip?: (b: Building3, solidId: string) => boolean): void {
    if (revisionKey === this.key) return;
    this.key = revisionKey;
    this.features = [];
    this.segs = [];
    for (const b of p.buildings)
      for (const s of b.solids) {
        if (s.hidden || skip?.(b, s.id)) continue;
        const r = sampleRing(oriented(s.plan.outer, 1));
        for (const y of [s.base, s.base + s.height]) {
          const pts = r.pts.map((q) => toWorld(b, q));
          pts.forEach((q, i) => {
            const n = pts[(i + 1) % pts.length]!;
            const seg = r.segs[i]!;
            if (!seg.curved || i === 0) this.features.push({ kind: 'vertex', p: new THREE.Vector3(q[0], y, q[1]) });
            if (!seg.curved) this.features.push({ kind: 'mid', p: new THREE.Vector3((q[0] + n[0]) / 2, y, (q[1] + n[1]) / 2) });
            this.segs.push({ a: new THREE.Vector3(q[0], y, q[1]), b: new THREE.Vector3(n[0], y, n[1]) });
          });
          let cx = 0,
            cz = 0;
          for (const q of pts) {
            cx += q[0];
            cz += q[1];
          }
          this.features.push({ kind: 'center', p: new THREE.Vector3(cx / pts.length, y, cz / pts.length) });
        }
      }
  }

  invalidate(): void {
    this.key = '';
  }

  private screen(p: THREE.Vector3): THREE.Vector2 {
    const s = this.view.toScreen(p);
    return new THREE.Vector2(s.x, s.y);
  }

  /**
   * Ponto no plano horizontal y sob o ponteiro, com encaixe.
   * `from`: último ponto (para eixos, paralelo e perpendicular).
   */
  snap(e: { clientX: number; clientY: number }, y: number, from?: THREE.Vector3 | null, lock?: THREE.Vector3 | null, tolPx = 12): Snap | null {
    const raw = this.view.onPlane(e, y);
    if (!raw) return null;
    const r = this.view.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(e.clientX - r.left, e.clientY - r.top);
    // Direção travada (Shift): projeta na reta.
    if (lock && from) {
      const d = lock.clone().normalize();
      const t = raw.clone().sub(from).dot(d);
      const p = from.clone().addScaledVector(d, this.quant(t));
      return { kind: 'axis', p, label: 'Travado', line: [from.clone().addScaledVector(d, -200), from.clone().addScaledVector(d, 200)], color: SNAP_COLORS.axis };
    }
    if (!this.enabled) return { kind: 'free', p: raw, label: '', color: SNAP_COLORS.free };
    // 1) Pontos notáveis no mesmo nível (ou projetados nele).
    let best: { d: number; f: Feature } | null = null;
    for (const f of this.features) {
      const q = new THREE.Vector3(f.p.x, y, f.p.z);
      const d = this.screen(q).distanceTo(mouse);
      const rank = f.kind === 'vertex' ? 0 : f.kind === 'mid' ? 2 : 4;
      if (d < tolPx && (!best || d + rank < best.d)) best = { d: d + rank, f };
    }
    if (best) {
      const q = new THREE.Vector3(best.f.p.x, y, best.f.p.z);
      return { kind: best.f.kind, p: q, label: LABELS[best.f.kind], color: SNAP_COLORS[best.f.kind] };
    }
    // 2) Eixos a partir do último ponto (vermelho/verde no referencial do edifício).
    const axes = this.axes();
    if (from) {
      let bestAxis: { d: number; p: THREE.Vector3; dir: THREE.Vector3; i: number } | null = null;
      axes.forEach((dir, i) => {
        const t = raw.clone().sub(from).dot(dir);
        const p = from.clone().addScaledVector(dir, t);
        const d = this.screen(p).distanceTo(mouse);
        if (d < tolPx && (!bestAxis || d < bestAxis.d)) bestAxis = { d, p, dir, i };
      });
      if (bestAxis) {
        const ba = bestAxis as { d: number; p: THREE.Vector3; dir: THREE.Vector3; i: number };
        const t = this.quant(ba.p.clone().sub(from).dot(ba.dir));
        const p = from.clone().addScaledVector(ba.dir, t);
        return { kind: 'axis', p, label: ba.i === 0 ? 'No eixo vermelho' : 'No eixo azul', line: [from.clone(), p.clone()], color: ba.i === 0 ? '#d63b3b' : '#2563eb' };
      }
      // 3) Paralelo / perpendicular a um lado próximo.
      for (const s of this.segs) {
        const dir = s.b.clone().sub(s.a).setY(0).normalize();
        for (const [kind, d] of [['parallel', dir], ['perp', new THREE.Vector3(-dir.z, 0, dir.x)]] as const) {
          const t = raw.clone().sub(from).dot(d);
          const p = from.clone().addScaledVector(d, t);
          if (this.screen(p).distanceTo(mouse) < tolPx * 0.6 && Math.abs(t) > 0.5) {
            const q = from.clone().addScaledVector(d, this.quant(t));
            return { kind, p: q, label: LABELS[kind], line: [from.clone(), q.clone()], color: SNAP_COLORS[kind] };
          }
        }
      }
    }
    // 4) Sobre uma aresta.
    for (const s of this.segs) {
      if (Math.abs(s.a.y - y) > 0.01) continue;
      const ab = s.b.clone().sub(s.a);
      const t = Math.max(0, Math.min(1, raw.clone().sub(s.a).dot(ab) / ab.lengthSq()));
      const p = s.a.clone().addScaledVector(ab, t);
      if (this.screen(p).distanceTo(mouse) < tolPx * 0.7) return { kind: 'edge', p, label: LABELS.edge, color: SNAP_COLORS.edge };
    }
    // 5) Grade (no referencial do edifício em edição).
    return { kind: 'grid', p: this.gridSnap(raw), label: '', color: SNAP_COLORS.grid };
  }

  /** Eixos do referencial atual no mundo (x e z girados). */
  axes(): THREE.Vector3[] {
    const a = (this.axisAngle * Math.PI) / 180;
    return [new THREE.Vector3(Math.cos(a), 0, -Math.sin(a)), new THREE.Vector3(Math.sin(a), 0, Math.cos(a))];
  }

  quant(t: number): number {
    return this.grid > 0 && this.enabled ? Math.round(t / this.grid) * this.grid : t;
  }

  gridSnap(p: THREE.Vector3): THREE.Vector3 {
    if (!(this.grid > 0) || !this.enabled) return p.clone();
    const [ax, az] = this.axes();
    const u = this.quant(p.dot(ax!)),
      v = this.quant(p.dot(az!));
    return new THREE.Vector3(ax!.x * u + az!.x * v, p.y, ax!.z * u + az!.z * v);
  }

  /** Alturas notáveis (topos e bases de sólidos, níveis) perto de um valor. */
  snapHeight(value: number, candidates: number[], tol = 0.25): { value: number; snapped: boolean } {
    let best: number | null = null;
    for (const c of candidates) if (Math.abs(c - value) < tol && (best === null || Math.abs(c - value) < Math.abs(best - value))) best = c;
    if (best !== null) return { value: best, snapped: true };
    return { value: this.grid > 0 && this.enabled ? Math.round(value / (this.grid / 5 || 0.1)) * (this.grid / 5 || 0.1) : value, snapped: false };
  }
}

export type { Vec2 };
