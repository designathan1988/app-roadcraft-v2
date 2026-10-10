// Alças do editor desenhadas sobre o modelo (tamanho constante na tela) e o
// teste de acerto em pixels. O widget de manipulação segue o Gumball do Rhino:
// setas movem no chão, o anel gira em Y, a seta verde ergue; na face, a seta
// laranja empurra/puxa; pontos nos vértices e no meio dos lados editam a planta.
import * as THREE from 'three';
import type { ID } from '../model/schema';
import type { View } from './view';

export type HandleKind = 'move-x' | 'move-z' | 'move-xz' | 'lift' | 'rotate' | 'push' | 'height' | 'vertex' | 'bend' | 'taper' | 'cwidth' | 'cheight' | 'csill';

export interface Handle {
  kind: HandleKind;
  /** Ponto de ancoragem no mundo. */
  at: THREE.Vector3;
  /** Direção da seta (mundo). */
  dir?: THREE.Vector3;
  /** Polilinha para o acerto (anel de giro). */
  ring?: THREE.Vector3[];
  solid?: ID;
  edge?: ID;
  vertex?: ID;
  color: string;
  label: string;
}

const COLORS = { x: '#e0453a', z: '#2f7de1', y: '#1f9d55', push: '#ffb020', vertex: '#ffffff', bend: '#18a6c9', ring: '#e6a521', plane: '#f2c94c' };

export { COLORS as HANDLE_COLORS };

const ARROW_PX = 90;

export class Handles {
  readonly group = new THREE.Group();
  list: Handle[] = [];
  hover: Handle | null = null;
  private cone = new THREE.ConeGeometry(0.5, 1.4, 14);
  private sphere = new THREE.SphereGeometry(0.5, 14, 10);
  private box = new THREE.BoxGeometry(1, 1, 1);
  private shaft = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
  private mats = new Map<string, THREE.MeshBasicMaterial>();
  private lineMats = new Map<string, THREE.LineBasicMaterial>();

  constructor(private view: View) {
    this.group.name = 'alças';
    this.group.renderOrder = 30;
    view.overlay.add(this.group);
  }

  private mat(color: string): THREE.MeshBasicMaterial {
    let m = this.mats.get(color);
    if (!m) this.mats.set(color, (m = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true })));
    return m;
  }

  private lineMat(color: string): THREE.LineBasicMaterial {
    let m = this.lineMats.get(color);
    if (!m) this.lineMats.set(color, (m = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 })));
    return m;
  }

  set(list: Handle[]): void {
    this.list = list;
    this.draw();
  }

  /** Redesenha (tamanhos dependem da câmera). */
  draw(): void {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      if ((c as THREE.Line).isLine) (c as THREE.Line).geometry.dispose();
    }
    for (const h of this.list) {
      const wpp = this.view.worldPerPixel(h.at);
      const hot = this.hover === h;
      const color = hot ? '#111111' : h.color;
      if (h.kind === 'rotate' && h.ring) {
        const l = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(h.ring), this.lineMat(color));
        l.renderOrder = 31;
        this.group.add(l);
        const grip = new THREE.Mesh(this.sphere, this.mat(color));
        grip.position.copy(h.at);
        grip.scale.setScalar(wpp * (hot ? 14 : 11));
        grip.renderOrder = 32;
        this.group.add(grip);
        continue;
      }
      if (h.dir) {
        const len = wpp * ARROW_PX;
        const tip = h.at.clone().addScaledVector(h.dir, len);
        // Haste grossa (cilindro com largura fixa na tela) e contorno escuro: visível sobre qualquer fundo.
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), h.dir.clone().normalize());
        for (const [w, c, ord] of [[7, '#1f2326', 30], [4, color, 31]] as const) {
          const sh = new THREE.Mesh(this.shaft, this.mat(c));
          sh.position.copy(h.at).addScaledVector(h.dir, len / 2);
          sh.quaternion.copy(q);
          sh.scale.set(wpp * w * (hot ? 1.3 : 1), len, wpp * w * (hot ? 1.3 : 1));
          sh.renderOrder = ord;
          this.group.add(sh);
        }
        const c = new THREE.Mesh(this.cone, this.mat(color));
        c.position.copy(tip);
        c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), h.dir.clone().normalize());
        c.scale.setScalar(wpp * (hot ? 17 : 14));
        c.renderOrder = 32;
        this.group.add(c);
        continue;
      }
      if (h.kind !== 'vertex') {
        const o = new THREE.Mesh(h.kind === 'move-xz' ? this.box : this.sphere, this.mat('#1f2326'));
        o.position.copy(h.at);
        const op = (h.kind === 'bend' ? 9 : h.kind === 'move-xz' ? 16 : 11) + 3;
        o.scale.set(wpp * op, h.kind === 'move-xz' ? wpp * 4 : wpp * op, wpp * op);
        o.renderOrder = 31;
        this.group.add(o);
      }
      const m = new THREE.Mesh(h.kind === 'move-xz' ? this.box : this.sphere, this.mat(color));
      m.position.copy(h.at);
      const px = h.kind === 'vertex' ? 11 : h.kind === 'bend' ? 9 : h.kind === 'move-xz' ? 16 : 11;
      m.scale.set(wpp * px * (hot ? 1.3 : 1), h.kind === 'move-xz' ? wpp * 3 : wpp * px * (hot ? 1.3 : 1), wpp * px * (hot ? 1.3 : 1));
      m.renderOrder = 32;
      this.group.add(m);
      if (h.kind === 'vertex') {
        const ring = new THREE.Mesh(this.sphere, this.mat('#2b2f31'));
        ring.position.copy(h.at);
        ring.scale.setScalar(wpp * (px + 4) * (hot ? 1.3 : 1));
        ring.renderOrder = 31;
        this.group.add(ring);
      }
    }
    this.view.mark();
  }

  /** Alça sob o ponteiro (a mais próxima dentro da tolerância). */
  hit(e: { clientX: number; clientY: number }, tol = 13): Handle | null {
    const r = this.view.renderer.domElement.getBoundingClientRect();
    const m = new THREE.Vector2(e.clientX - r.left, e.clientY - r.top);
    let best: { d: number; h: Handle } | null = null;
    const S = (p: THREE.Vector3) => {
      const s = this.view.toScreen(p);
      return new THREE.Vector2(s.x, s.y);
    };
    for (const h of this.list) {
      let d: number;
      if (h.kind === 'rotate' && h.ring) {
        d = Infinity;
        const pts = h.ring.map(S);
        for (let i = 0; i < pts.length; i++) d = Math.min(d, segDist(m, pts[i]!, pts[(i + 1) % pts.length]!));
        d = Math.min(d, S(h.at).distanceTo(m) - 4);
      } else if (h.dir) {
        const len = this.view.worldPerPixel(h.at) * ARROW_PX;
        const a = S(h.at.clone().addScaledVector(h.dir, len * 0.25)),
          b = S(h.at.clone().addScaledVector(h.dir, len * 1.05));
        d = segDist(m, a, b);
      } else d = S(h.at).distanceTo(m) - (h.kind === 'vertex' ? 2 : 0);
      // Pontos ganham dos traços quando empatam.
      const bias = h.kind === 'vertex' || h.kind === 'bend' ? -3 : 0;
      if (d < tol && (!best || d + bias < best.d)) best = { d: d + bias, h };
    }
    return best?.h ?? null;
  }

  setHover(h: Handle | null): void {
    if (h === this.hover) return;
    this.hover = h;
    this.draw();
  }
}

function segDist(p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  const ab = b.clone().sub(a);
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / (ab.lengthSq() || 1)));
  return a.clone().addScaledVector(ab, t).distanceTo(p);
}
