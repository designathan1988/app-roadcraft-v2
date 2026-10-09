import type { Vec2 } from '@core/vec2';
import { clamp } from '@core/scalar';
import type { Viewport } from './viewport';

/** What the camera's gestures read of the game and do to it. */
export interface CameraGesturesHost {
  /** The view the pointer moves (it is replaced when the renderer changes). */
  view(): Viewport;
  /** The canvas's size, CSS px. */
  size(): { readonly w: number; readonly h: number };
  /** The camera turned: its bearing and tilt are kept with the settings. */
  orbited(): void;
  redraw(): void;
}

/** Camera turn and tilt per CSS pixel of an orbit drag, rad: a full turn in ~1000 px. */
const ORBIT_PER_PX = 0.0063;
/**
 * Which way a twist of two fingers turns the camera, so the map turns with
 * them: a positive orbit turns the map anticlockwise on screen, and a
 * clockwise twist grows the angle between the fingers.
 */
const TWIST_SIGN = -1;
/** How far a press may travel, CSS px, and still be a click rather than a drag. */
const CLICK_SLOP = 5;
/** Below this many CSS px between the fingers a twist is noise, not a turn. */
const TWIST_MIN_SPREAD = 40;

/**
 * THE CAMERA'S GESTURES: the pointers on the canvas, a pan, an orbit, a
 * two-finger pinch - with the handlers that move the view by them. Each
 * pointer's last position is kept by its id and taken away on release
 * (MDN, "Pinch zoom gestures"); two at once are a pinch whose spread zooms,
 * whose twist turns and whose middle holds the ground under it.
 *
 * A pan holds the GROUND POINT that was grabbed under the pointer, not a
 * screen delta over the zoom: the two agree only looking straight down,
 * and holding the point is one rule for every view (`Viewport.panTo`).
 */
export class CameraGestures {
  private readonly pointers = new Map<number, Vec2>();
  private pan: { id: number; grabbed: Vec2 } | null = null;
  /** An orbit: where it was pressed and last was, CSS px; a right click that stays a click cancels the gesture in progress. */
  private orbit: { id: number; last: Vec2; pressed: Vec2; moved: boolean; cancelOnClick: boolean; height: number } | null = null;
  private pinch: { d0: number; zoom0: number; world: Vec2; angle: number } | null = null;

  constructor(private readonly host: CameraGesturesHost) {}

  /** Something of the camera is being moved by hand. */
  get active(): boolean {
    return this.pan !== null || this.orbit !== null || this.pinch !== null;
  }

  get pinching(): boolean {
    return this.pinch !== null;
  }

  /** Pointers on the canvas now. */
  get touches(): number {
    return this.pointers.size;
  }

  has(id: number): boolean {
    return this.pointers.has(id);
  }

  gesture(): string | null {
    if (this.pinch) return 'câmera: pinça';
    if (this.orbit) return 'câmera: girando';
    if (this.pan) return 'câmera: arrastando';
    return null;
  }

  /** A pointer pressed at `screen`, CSS px. */
  press(id: number, screen: Vec2): void {
    this.pointers.set(id, screen);
  }

  /**
   * The point a pan or pinch holds under the pointer, on the `y = 0` plane
   * that `panTo` solves on - deliberately not on the terrain or deck under
   * the cursor: `panTo` then compared a point on that plane with one on
   * `y = 0`, and the first move of every drag jerked the map by
   * `height / tan(48°)` (35 px at 500 %, 139 px at 2000 %). Under an
   * orthographic camera a horizontal shift moves every plane alike, so
   * holding the `y = 0` point IS holding what was grabbed.
   */
  private anchor(px: number, py: number): Vec2 {
    const { w, h } = this.host.size();
    return this.host.view().toWorld(px, py, w, h);
  }

  /** Two fingers (or more) down: a pinch from where they are. */
  startPinch(): void {
    const [a, b] = [...this.pointers.values()] as [Vec2, Vec2];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.pinch = {
      d0: Math.hypot(a.x - b.x, a.y - b.y),
      zoom0: this.host.view().zoom,
      world: this.anchor(mid.x, mid.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }

  /** The camera swung round the ground under `at` (at `height`); `cancelOnClick`: a click cancels what is in progress. */
  startOrbit(id: number, at: Vec2, cancelOnClick: boolean, height: number): void {
    this.orbit = { id, last: at, pressed: at, moved: false, cancelOnClick, height };
  }

  /** The ground under `at` grabbed and dragged. */
  startPan(id: number, at: Vec2): void {
    this.pan = { id, grabbed: this.anchor(at.x, at.y) };
  }

  /** Pointer `id` moved to `screen`: true when the camera took the move. */
  move(id: number, screen: Vec2): boolean {
    if (this.pointers.has(id)) this.pointers.set(id, screen);
    const { host } = this;
    const view = host.view();
    const { w, h } = host.size();
    if (this.pinch && this.pointers.size >= 2) {
      const pinch = this.pinch;
      const [a, b] = [...this.pointers.values()] as [Vec2, Vec2];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const limits = view.zoomBounds;
      const targetZoom = clamp((pinch.zoom0 * d) / Math.max(1, pinch.d0), limits.min, limits.max);
      // A twist of the two fingers turns the camera with them; the pan below
      // then keeps the ground between the fingers where it was.
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const twist = Math.atan2(Math.sin(angle - pinch.angle), Math.cos(angle - pinch.angle));
      pinch.angle = angle;
      if (d > TWIST_MIN_SPREAD) view.orbit(TWIST_SIGN * twist, 0);
      view.zoomAt(mid.x, mid.y, targetZoom / Math.max(0.001, view.zoom), w, h);
      view.panTo(pinch.world, mid.x, mid.y, w, h);
      host.redraw();
      return true;
    }
    const orbit = this.orbit;
    if (orbit?.id === id) {
      if (!orbit.moved) {
        if (Math.hypot(screen.x - orbit.pressed.x, screen.y - orbit.pressed.y) < CLICK_SLOP) return true;
        orbit.moved = true;
      }
      const dx = screen.x - orbit.last.x;
      const dy = screen.y - orbit.last.y;
      orbit.last = screen;
      // A turntable: the near side of the map follows the hand; dragging
      // down lifts the camera towards a plan view.
      view.orbit(dx * ORBIT_PER_PX, dy * ORBIT_PER_PX, { px: orbit.pressed.x, py: orbit.pressed.y, height: orbit.height });
      host.orbited();
      host.redraw();
      return true;
    }
    if (this.pan?.id === id) {
      view.panTo(this.pan.grabbed, screen.x, screen.y, w, h);
      host.redraw();
      return true;
    }
    return false;
  }

  /**
   * Pointer `id` let go. `wasPinching`: a pinch was on when it was let go;
   * `clickCancels`: it was a right click that stayed a click over a gesture
   * in progress, which that click cancels.
   */
  release(id: number): { wasPinching: boolean; clickCancels: boolean } {
    const wasPinching = this.pinch !== null;
    this.pointers.delete(id);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pan?.id === id) this.pan = null;
    let clickCancels = false;
    if (this.orbit?.id === id) {
      clickCancels = this.orbit.cancelOnClick && !this.orbit.moved;
      this.orbit = null;
    }
    return { wasPinching, clickCancels };
  }

  /** The gesture in progress cut short (a tool switch, undo, Escape): the pan and the orbit end. */
  cancel(): void {
    this.pan = null;
    this.orbit = null;
  }

  /** Every press forgotten (the window lost focus, the capture was taken): its release will never arrive. */
  releaseAll(): void {
    this.cancel();
    this.pointers.clear();
    this.pinch = null;
  }
}
