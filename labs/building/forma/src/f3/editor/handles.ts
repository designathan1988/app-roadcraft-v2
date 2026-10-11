// Alças do editor desenhadas sobre o modelo (tamanho constante na tela) e o
// teste de acerto em pixels. O widget de manipulação segue o Gumball do Rhino:
// setas movem no chão, o anel gira em Y, a seta verde ergue; na face, a seta
// laranja empurra/puxa; pontos nos vértices e no meio dos lados editam a planta.
import * as THREE from 'three';
import type { ID } from '../model/schema';
import type { View } from './view';

export type HandleKind = 'move-x' | 'move-z' | 'move-xz' | 'lift' | 'rotate' | 'push' | 'height' | 'floors' | 'vertex' | 'bend' | 'taper' | 'cwidth' | 'cheight' | 'csill' | 'size';

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
  /** Alça de tamanho: que lado da caixa ela puxa (-1, 0 ou 1 em x e z locais). */
  sx?: number;
  sz?: number;
  /** Alça de face: normal para fora (no mundo); some quando a face dá as costas para a câmera. */
  normal?: THREE.Vector3;
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

  /** A alça está à vista? (alça de face só com a face voltada para a câmera) */
  shown(h: Handle): boolean {
    if (!h.normal) return true;
    return h.normal.dot(this.view.camera.position.clone().sub(h.at)) > 0;
  }

  set(list: Handle[]): void {
    this.list = list;
    // Realce de uma alça que saiu da lista não fica para trás.
    if (this.hover && !list.includes(this.hover)) this.hover = null;
    this.draw();
  }

  /** Redesenha (tamanhos dependem da câmera). */
  draw(): void {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      if ((c as THREE.Line).isLine) (c as THREE.Line).geometry.dispose();
    }
    for (const h of this.list) {
      if (!this.shown(h)) continue;
      const wpp = this.view.worldPerPixel(h.at);
      const hot = this.hover === h;
      // Realce amarelo sob o ponteiro, como o TransformControls do three.js.
      const color = hot ? '#ffd23f' : h.color;
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
      if (h.kind === 'size') {
        // Quadrado branco com contorno escuro (cantos maiores que os lados).
        const px = (h.sx && h.sz ? 13 : 11) * (hot ? 1.35 : 1);
        const o = new THREE.Mesh(this.box, this.mat('#1f2326'));
        o.position.copy(h.at);
        o.scale.set(wpp * (px + 4), wpp * (px + 4), wpp * (px + 4));
        o.renderOrder = 31;
        const f = new THREE.Mesh(this.box, this.mat(hot ? '#ffd23f' : '#ffffff'));
        f.position.copy(h.at);
        f.scale.setScalar(wpp * px);
        f.renderOrder = 32;
        this.group.add(o, f);
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
  hit(e: { clientX: number; clientY: number }, tol = 18): Handle | null {
    const r = this.view.renderer.domElement.getBoundingClientRect();
    const m = new THREE.Vector2(e.clientX - r.left, e.clientY - r.top);
    let best: { d: number; h: Handle } | null = null;
    const S = (p: THREE.Vector3) => {
      const s = this.view.toScreen(p);
      return new THREE.Vector2(s.x, s.y);
    };
    for (const h of this.list) {
      if (!this.shown(h)) continue;
      let d: number;
      if (h.kind === 'rotate' && h.ring) {
        d = Infinity;
        const pts = h.ring.map(S);
        for (let i = 0; i < pts.length; i++) d = Math.min(d, segDist(m, pts[i]!, pts[(i + 1) % pts.length]!));
        d = Math.min(d, S(h.at).distanceTo(m) - 4);
      } else if (h.dir) {
        const len = this.view.worldPerPixel(h.at) * ARROW_PX;
        // A seta inteira pega o clique (da base à ponta, com folga além do cone).
        const a = S(h.at.clone().addScaledVector(h.dir, len * 0.08)),
          b = S(h.at.clone().addScaledVector(h.dir, len * 1.15));
        d = segDist(m, a, b);
      } else d = S(h.at).distanceTo(m) - (h.kind === 'vertex' ? 2 : 0);
      // Pontos ganham dos traços quando empatam.
      const bias = h.kind === 'vertex' || h.kind === 'bend' || h.kind === 'size' ? -4 : 0;
      if (d < tol && (!best || d + bias < best.d)) best = { d: d + bias, h };
    }
    return best?.h ?? null;
  }

  /**
   * Onde as alças ocupam a tela (coordenadas do cliente): pontos como
   * quadrados de ±9 px, setas amostradas a cada 12 px (uma diagonal não vira
   * um quadrado enorme). As cotas desviam disso.
   */
  footprints(): { left: number; right: number; top: number; bottom: number }[] {
    const r = this.view.renderer.domElement.getBoundingClientRect();
    const out: { left: number; right: number; top: number; bottom: number }[] = [];
    const box = (x: number, y: number, k: number) => out.push({ left: r.left + x - k, right: r.left + x + k, top: r.top + y - k, bottom: r.top + y + k });
    for (const h of this.list) {
      if (!this.shown(h)) continue;
      const a = this.view.toScreen(h.at);
      if (a.behind) continue;
      if (h.dir && h.kind !== 'rotate') {
        const len = this.view.worldPerPixel(h.at) * ARROW_PX;
        const b = this.view.toScreen(h.at.clone().addScaledVector(h.dir, len * 1.15));
        const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 12));
        for (let i = 0; i <= n; i++) box(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n, 8);
      } else box(a.x, a.y, 9);
    }
    return out;
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
