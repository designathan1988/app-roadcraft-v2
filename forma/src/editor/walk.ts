// Modo caminhar: primeira pessoa dentro do edifício, com colisão nas paredes,
// passagem pelas portas e escadas que levam de um pavimento ao outro.
import * as THREE from 'three';
import type { Building, Vec2 } from '../core/schema';
import { sortedStoreys } from '../core/model';
import { pointInPolygon } from '../geometry/polygon';
import { ringPoints } from '../geometry/ring';
import { toLocal, toWorld } from '../geometry/frame';
import { collisionShapes, pushOut, type Solid } from '../geometry/collision';
import { stairFootprint, stairHeightAt } from '../geometry/stairs';
import { massesAt } from './interior-ops';

const EYE = 1.6,
  RADIUS = 0.25,
  STEP_UP = 0.45,
  SPEED = 1.6,
  RUN = 3.4;

export interface WalkState {
  /** Posição em coordenadas locais do edifício e altura do piso. */
  p: Vec2;
  floor: number;
  yaw: number;
  pitch: number;
}

/** Física do caminhar (sem DOM): testável no Node. */
export class WalkPhysics {
  readonly solids: Solid[];
  constructor(readonly b: Building) {
    this.solids = collisionShapes(b).solids;
  }

  /** Superfície mais alta onde se pode pisar em p, sem subir mais que STEP_UP acima de y. */
  floorAt(p: Vec2, y: number): number {
    let best = 0;
    for (const s of sortedStoreys(this.b)) {
      const top = s.elevation + s.slabThickness;
      if (top > y + STEP_UP) continue;
      const inside = massesAt(this.b, s.id).some((m) => pointInPolygon(p[0], p[1], ringPoints(m.outer)) && !m.holes.some((h) => pointInPolygon(p[0], p[1], ringPoints(h))));
      if (!inside) continue;
      // Vão de escada que chega neste pavimento: não há laje.
      const hole = this.b.stairs.some((st) => st.toStorey === s.id && stairFootprint(st.path, st.width).some((poly) => pointInPolygon(p[0], p[1], poly[0]!)));
      if (!hole) best = Math.max(best, top);
    }
    const byId = new Map(this.b.storeys.map((s) => [s.id, s]));
    for (const st of this.b.stairs) {
      const from = byId.get(st.fromStorey),
        to = byId.get(st.toStorey);
      if (!from || !to) continue;
      const base = from.elevation + from.slabThickness;
      const h = stairHeightAt(st.path, st.width, to.elevation + to.slabThickness - base, p);
      if (h !== null && base + h <= y + STEP_UP) best = Math.max(best, base + h);
    }
    return best;
  }

  /** Move (dx, dz) a partir de st, resolvendo colisões e o piso. */
  step(st: WalkState, dx: number, dz: number): WalkState {
    let p: Vec2 = [st.p[0] + dx, st.p[1] + dz];
    const y = st.floor;
    for (let it = 0; it < 3; it++)
      for (const s of this.solids) {
        // Obstáculos baixos o bastante para subir (degraus) não bloqueiam.
        if (s.y1 <= y + STEP_UP || s.y0 >= y + EYE + 0.1) continue;
        p = pushOut(p, RADIUS, s);
      }
    const floor = this.floorAt(p, y);
    return { ...st, p, floor };
  }
}

export class WalkController {
  private physics: WalkPhysics;
  private state: WalkState;
  private keys = new Set<string>();
  private frame = 0;
  private last = 0;
  private cleanup: (() => void)[] = [];
  private saved: { pos: THREE.Vector3; quat: THREE.Quaternion; fov: number };

  constructor(
    private b: Building,
    private camera: THREE.PerspectiveCamera,
    private canvas: HTMLCanvasElement,
    start: { p: Vec2; floor: number; yaw?: number },
    private onFrame: () => void,
    private onExit: () => void,
  ) {
    this.physics = new WalkPhysics(b);
    this.state = { p: start.p, floor: start.floor, yaw: start.yaw ?? 0, pitch: 0 };
    this.saved = { pos: camera.position.clone(), quat: camera.quaternion.clone(), fov: camera.fov };
    camera.fov = 70;
    camera.updateProjectionMatrix();
    const on = <K extends keyof DocumentEventMap>(t: EventTarget, type: K | string, fn: (e: never) => void) => {
      t.addEventListener(type, fn as EventListener);
      this.cleanup.push(() => t.removeEventListener(type, fn as EventListener));
    };
    const doc = canvas.ownerDocument;
    on(doc, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') return this.exit();
      this.keys.add(e.key.toLowerCase());
    });
    on(doc, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase()));
    on(doc, 'mousemove', (e: MouseEvent) => {
      if (doc.pointerLockElement !== canvas && !(e.buttons & 1)) return;
      this.state.yaw -= e.movementX * 0.0025;
      this.state.pitch = Math.max(-1.3, Math.min(1.3, this.state.pitch - e.movementY * 0.0025));
    });
    on(doc, 'pointerlockchange', () => {
      if (doc.pointerLockElement !== canvas && this.locked) this.exit();
    });
    try {
      const r = canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
      if (r && typeof r.then === 'function') r.then(() => (this.locked = true)).catch(() => undefined);
      else this.locked = true;
    } catch {
      /* sem bloqueio de ponteiro: arrastar com o botão esquerdo olha em volta */
    }
    this.last = performance.now();
    const loop = (t: number) => {
      this.frame = requestAnimationFrame(loop);
      this.update(Math.min(0.05, (t - this.last) / 1000));
      this.last = t;
    };
    this.frame = requestAnimationFrame(loop);
    this.apply();
  }

  private locked = false;

  get position(): WalkState {
    return { ...this.state };
  }

  /** Avança a simulação (exposto para testes). */
  update(dt: number): void {
    const k = this.keys;
    const f = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
    const r = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
    if (f || r) {
      const sp = (k.has('shift') ? RUN : SPEED) * dt;
      const yaw = this.state.yaw;
      // Frente em coordenadas do mundo; o edifício pode estar girado.
      const fw: Vec2 = [-Math.sin(yaw), -Math.cos(yaw)],
        rt: Vec2 = [Math.cos(yaw), -Math.sin(yaw)];
      const wx = (fw[0] * f + rt[0] * r) * sp,
        wz = (fw[1] * f + rt[1] * r) * sp;
      const here = toWorld(this.b, this.state.p);
      const there = toLocal(this.b, [here[0] + wx, here[1] + wz]);
      this.state = this.physics.step(this.state, there[0] - this.state.p[0], there[1] - this.state.p[1]);
    } else {
      // Cai até o piso se estiver no ar (depois de descer uma escada).
      const floor = this.physics.floorAt(this.state.p, this.state.floor);
      if (floor !== this.state.floor) this.state = { ...this.state, floor };
    }
    this.apply();
  }

  private apply(): void {
    const w = toWorld(this.b, this.state.p);
    this.camera.position.set(w[0], this.state.floor + EYE, w[1]);
    this.camera.rotation.set(this.state.pitch, this.state.yaw, 0, 'YXZ');
    this.camera.updateMatrixWorld();
    this.onFrame();
  }

  exit(): void {
    cancelAnimationFrame(this.frame);
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    const doc = this.canvas.ownerDocument;
    if (doc.pointerLockElement === this.canvas) doc.exitPointerLock();
    this.camera.position.copy(this.saved.pos);
    this.camera.quaternion.copy(this.saved.quat);
    this.camera.fov = this.saved.fov;
    this.camera.updateProjectionMatrix();
    this.onExit();
  }
}

/**
 * Ponto de partida: no maior cômodo do pavimento, o ponto da grade mais
 * distante de paredes, do contorno e das escadas (nunca em cima de degraus).
 */
export function walkStart(b: Building, storeyId: string): Vec2 {
  const s = b.storeys.find((x) => x.id === storeyId);
  const rooms = [...(s?.rooms ?? [])].filter((r) => r.polygon).sort((x, y) => (y.area ?? 0) - (x.area ?? 0));
  const polys = rooms.length ? rooms.map((r) => r.polygon!) : massesAt(b, storeyId).map((m) => ringPoints(m.outer));
  const segs: [Vec2, Vec2][] = [];
  for (const p of polys) p.forEach((a, i) => segs.push([a, p[(i + 1) % p.length]!]));
  for (const w of s?.graph.walls ?? []) {
    const a = s!.graph.nodes.find((n) => n.id === w.a)?.p,
      c = s!.graph.nodes.find((n) => n.id === w.b)?.p;
    if (a && c) segs.push([a, c]);
  }
  const stairs = b.stairs.flatMap((st) => stairFootprint(st.path, st.width).map((p) => p[0]!));
  for (const st of stairs) st.forEach((a, i) => segs.push([a, st[(i + 1) % st.length]!]));
  const dist = (p: Vec2) =>
    Math.min(
      ...segs.map(([a, c]) => {
        const dx = c[0] - a[0],
          dz = c[1] - a[1],
          l2 = dx * dx + dz * dz || 1,
          t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
        return Math.hypot(a[0] + dx * t - p[0], a[1] + dz * t - p[1]);
      }),
    );
  let best = null as { p: Vec2; d: number } | null;
  for (const poly of polys.slice(0, 3)) {
    const xs = poly.map((p) => p[0]),
      zs = poly.map((p) => p[1]);
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 0.25)
      for (let z = Math.min(...zs); z <= Math.max(...zs); z += 0.25) {
        const p: Vec2 = [x, z];
        if (!pointInPolygon(x, z, poly) || stairs.some((st) => pointInPolygon(x, z, st))) continue;
        const d = dist(p);
        if (!best || d > best.d) best = { p, d };
      }
    if (best && best.d > 0.6) break;
  }
  return best?.p ?? polys[0]?.[0] ?? [0, 0];
}
