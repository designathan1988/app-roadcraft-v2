import { pointInPolygon } from '@core/polygon';
import type { Vec2 } from '@core/vec2';
import { buildingHeight, solidFootprints } from '@world/buildings/geometry';
import type { BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import { insideBody, PLAYER_ID, type VehicleBox } from '@sim/ambient/play';
import type { SimWorld } from '@sim/world';
import type { PlayCamera, SceneHandle } from '@render/renderer';
import { t } from '@ui/i18n';

/**
 * Playing in the scenery, as in GTA: a person on foot or at the wheel, seen
 * from behind (third person) or through their eyes (first person, V).
 *
 * - The camera hangs on a spring arm behind the player (Unreal's Spring Arm,
 *   Godot's SpringArm3D): its length drawn in where a building stands
 *   between the player and the eye, so the camera never sees through a
 *   wall. The mouse turns it (Pointer Lock, after a click, as three.js'
 *   PointerLockControls); W, A, S, D move relative to where it looks.
 * - In first person the player's own body is not drawn.
 * - The simulation side is `sim/ambient/play.ts`; this file is the input,
 *   the camera and the HUD, and nothing else.
 *
 * Keys and mouse as GTA V's on PC (its default bindings): W A S D walk (in
 * a car: throttle, brake and reverse, steer), Shift run, Space the handbrake,
 * mouse look, right button aim (over the shoulder, the body faces the aim and
 * steps sideways), left button punch or shoot, wheel or Tab the next weapon,
 * 1 and 2 a weapon, C look behind, F get in or out, G board as a passenger, E
 * talk, V first/third person, Esc frees the mouse, P stops playing.
 *
 * The mouse turns the camera captured (Pointer Lock, asked for only by the
 * player's own click) or not: where the capture is refused (an embedded
 * browser) its movement still turns it.
 */

export interface PlayHost {
  readonly sim: SimWorld;
  readonly scene: () => SceneHandle;
  readonly canvas: HTMLCanvasElement;
  readonly root: HTMLElement;
  requestDraw(): void;
  /** The building opened for the player inside it, or none. */
  openInside(id: BuildingId | null): void;
  /** Where to start: the middle of the view. */
  centre(): Vec2;
}

export interface Play {
  readonly active: boolean;
  toggle(): void;
  /** Once per frame, before the scene is drawn. */
  frame(dt: number): void;
}

const HEAD = m(1.62);
const ARM_FOOT = m(4.2), ARM_CAR = m(8.5);
const PIVOT_FOOT = m(1.55), PIVOT_CAR = m(1.6);
/** Aiming: the arm drawn in over the right shoulder (GTA's aim camera). */
const ARM_AIM = m(2.4), SHOULDER = m(0.55);

export function createPlay(host: PlayHost): Play {
  const { sim, canvas } = host;
  const play = sim.ambient.play;
  let active = false;
  let firstPerson = false;
  let yaw = 0, pitch = 0.32;
  const keys = new Set<string>();
  /** Right button held: aiming over the shoulder. */
  let aiming = false;
  /** The browser refused to capture the mouse (an embedded view): it turns the camera uncaptured. */
  let lockRefused = false;
  document.addEventListener('pointerlockerror', () => { lockRefused = true; });
  /** When the mouse last turned the camera (ms): a car's camera swings back behind it after a while. */
  let mouseAt = 0;
  const WEAPONS = ['fists', 'pistol'] as const;
  const nextWeapon = (step: number): void => {
    const i = WEAPONS.indexOf(play.weapon as typeof WEAPONS[number]);
    play.weapon = WEAPONS[(i + step + WEAPONS.length) % WEAPONS.length]!;
  };
  type V3 = [number, number, number];
  let eye: V3 = [0, 0, 0], look: V3 = [0, 0, 0], focus: V3 = [0, 0, 0];
  let smoothEye: V3 | null = null;
  let insideShown: BuildingId | null = null;

  // ------------------------------------------------------------ the HUD
  const hud = document.createElement('div');
  hud.className = 'play-hud';
  hud.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:40;color:#fff;font:600 13px system-ui,sans-serif;'
    + 'background:rgba(10,16,18,.72);border-radius:10px;padding:10px 12px;max-width:min(560px,calc(100vw - 32px));display:none;'
    + 'text-shadow:0 1px 2px #000;pointer-events:none';
  host.root.appendChild(hud);
  const cross = document.createElement('div');
  cross.style.cssText = 'position:fixed;left:50%;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;z-index:40;display:none;'
    + 'pointer-events:none;border:2px solid rgba(255,255,255,.8);border-radius:50%';
  host.root.appendChild(cross);
  // No cursor anywhere over the page while playing (the overlay canvas lies over the game's).
  const cursorless = document.createElement('style');
  cursorless.textContent = '.playing-cursorless, .playing-cursorless * { cursor: none !important; }';
  document.head.appendChild(cursorless);

  const showHud = (): void => {
    if (!active) { hud.style.display = 'none'; cross.style.display = 'none'; return; }
    hud.style.display = 'block';
    cross.style.display = play.mode === 'foot' && (aiming || play.weapon === 'pistol') ? 'block' : 'none';
    // GTA's wanted level: the stars earned lit, the rest dim.
    const stars = `<span style="color:#ffd25e">${'★'.repeat(play.wanted)}</span>`
      + `<span style="color:rgba(255,255,255,.3)">${'★'.repeat(5 - play.wanted)}</span>`;
    const msg = play.message && sim.clock.time - play.message.at < 4 ? t(`play.msg.${play.message.key}`) : '';
    const mode = play.mode === 'car' ? t('play.driving', { speed: Math.round(Math.abs(play.v) / m(1) * 3.6) })
      : play.mode === 'inside' ? t('play.inside') : play.mode === 'ride' ? t(play.ride?.kind === 'train' ? 'play.ridingTrain' : 'play.ridingBus')
        : t('play.onFoot');
    const keyLine = play.mode === 'car' ? t('play.keys.car') : play.mode === 'inside' ? t('play.keys.inside')
      : play.mode === 'ride' ? t('play.keys.ride') : t('play.keys.foot');
    hud.innerHTML = `<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">`
      + `<span>${mode}</span>`
      + `<span>${t('play.health')}: <b style="color:${play.health > 50 ? '#7be38f' : play.health > 20 ? '#f2c94c' : '#ff6b5e'}">${Math.round(play.health)}</b></span>`
      + `<span>${t(`play.weapon.${play.weapon}`)}</span>`
      + `<span style="letter-spacing:2px">${stars}</span>`
      + `<span>${firstPerson ? t('play.view.first') : t('play.view.third')}</span></div>`
      + (msg ? `<div style="margin-top:6px;color:#ffe9a8">${msg}</div>` : '')
      + `<div style="margin-top:6px;font-weight:500;opacity:.85">${keyLine}</div>`;
  };

  // ------------------------------------------------------------ input
  const playing = (): boolean => active;
  /**
   * The mouse captured and its cursor gone, as in GTA: asked for when play
   * starts (the J key or the Play button, the player's own gesture) and again
   * on any click while it is not held. Refused once (an embedded browser), it
   * is still asked for on the next click.
   */
  const capture = (): void => {
    if (document.pointerLockElement === canvas) return;
    try {
      void Promise.resolve(canvas.requestPointerLock?.()).catch(() => { lockRefused = true; });
    } catch { lockRefused = true; }
  };
  /**
   * A key by where it is on the keyboard (`KeyboardEvent.code`), not by the
   * character it types: with Shift held, or on another layout, `key` was a
   * capital or another symbol and the key stuck down.
   */
  const keyOf = (e: KeyboardEvent): string => {
    const code = e.code;
    if (code.startsWith('Key')) return code.slice(3).toLowerCase();
    if (code.startsWith('Digit')) return code.slice(5);
    if (code === 'ShiftLeft' || code === 'ShiftRight') return 'shift';
    if (code === 'Space') return ' ';
    if (code === 'ArrowUp' || code === 'ArrowDown' || code === 'ArrowLeft' || code === 'ArrowRight') return code.toLowerCase();
    return e.key.toLowerCase();
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!playing()) {
      if ((e.key === 'j' || e.key === 'J') && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        api.toggle();
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    const k = keyOf(e);
    if (k === 'p') { api.toggle(); }
    else if (k === 'f') play.input.enter = true;
    else if (k === 'g') play.input.board = true;
    else if (k === 'e') play.input.talk = true;
    else if (k === '1') play.weapon = 'fists';
    else if (k === '2') play.weapon = 'pistol';
    else if (k === 'tab') nextWeapon(1);
    else if (k === 'v') {
      firstPerson = !firstPerson;
      // Through the eyes, the look starts where the body faces (or the car points).
      yaw = play.mode === 'car' && play.car?.free ? play.car.free.angle : play.heading;
      pitch = firstPerson ? 0.33 : 0.32;
    }
    else if (k === 'escape') { if (document.pointerLockElement) document.exitPointerLock(); }
    else keys.add(k);
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (!playing()) return;
    keys.delete(keyOf(e));
    if (e.key === 'Shift') keys.delete('shift');
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onPointerDown = (e: PointerEvent): void => {
    if (!playing() || e.target !== canvas) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // The mouse freed (Esc), a click captures it again (that click does nothing
    // else); where the capture is refused, clicks act at once.
    if (document.pointerLockElement !== canvas) {
      const refused = lockRefused;
      lockRefused = false;
      capture();
      if (!refused) return;
    }
    if (e.button === 0) play.input.attack = true;
    if (e.button === 2) aiming = true;
  };
  const onPointerUp = (e: PointerEvent): void => {
    if (!playing()) return;
    if (e.button === 2) aiming = false;
  };
  const onMouseMove = (e: MouseEvent): void => {
    if (!playing()) return;
    // Captured, the mouse turns the camera; not captured (refused, or freed with
    // Esc), over the game it still does, as long as no button of the page is under it.
    if (document.pointerLockElement !== canvas && e.target !== canvas) return;
    const k = aiming ? 0.55 : 1;
    yaw -= e.movementX * 0.0028 * k;
    pitch = Math.max(-0.75, Math.min(1.1, pitch + e.movementY * 0.0024 * k));
    if (e.movementX || e.movementY) mouseAt = performance.now();
  };
  const onWheel = (e: WheelEvent): void => {
    if (!playing() || e.target !== canvas) return;
    nextWeapon(e.deltaY > 0 ? 1 : -1);
  };
  const swallow = (e: Event): void => {
    if (!playing()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  // Keys held when the window loses the focus are let go: they stuck down, and
  // the player walked on by themselves.
  const letGo = (): void => { keys.clear(); aiming = false; };
  window.addEventListener('blur', letGo);
  document.addEventListener('visibilitychange', () => { if (document.hidden) letGo(); });
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('mousemove', onMouseMove, true);
  window.addEventListener('pointerup', onPointerUp, true);
  canvas.addEventListener('wheel', onWheel, { capture: true, passive: true });
  for (const type of ['pointerup', 'pointermove', 'wheel', 'dblclick', 'contextmenu']) {
    canvas.addEventListener(type, swallow, { capture: true, passive: false });
  }

  // ------------------------------------------------------------ walls, for the camera
  let wallsFor = -1;
  let walls: { ring: readonly Vec2[]; top: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  const wallTops = (): typeof walls => {
    if (sim.doc.buildings.revision === wallsFor) return walls;
    wallsFor = sim.doc.buildings.revision;
    walls = [];
    const scene = host.scene();
    for (const b of sim.doc.buildings.all()) {
      const top = scene.terrainHeightAt(b.x, b.y) + buildingHeight(b);
      for (const ring of solidFootprints(b)) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of ring) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
        walls.push({ ring, top, x0, y0, x1, y1 });
      }
    }
    return walls;
  };
  /** Whether a point (world x, y, height) is inside a building. */
  /** The vehicles round the player this frame, with the ground they stand on (`placeCamera` fills it). */
  let boxes: readonly VehicleBox[] = [];
  let boxGround = 0;
  const solid = (x: number, y: number, h: number): boolean => {
    for (const wl of wallTops()) {
      if (x < wl.x0 || x > wl.x1 || y < wl.y0 || y > wl.y1 || h > wl.top) continue;
      if (pointInPolygon({ x, y }, wl.ring)) return true;
    }
    // A bus or a van between the player and the camera holds the arm in too.
    for (const b of boxes) if (h < boxGround + b.height && insideBody(x, y, b.x, b.y, b.angle, b.length, b.width, m(0.3))) return true;
    return false;
  };

  // ------------------------------------------------------------ the camera
  const placeCamera = (dt: number): void => {
    const scene = host.scene();
    const car = play.car?.free ?? null;
    const at = play.viewPoint(sim);
    const px = at.x, py = at.y;
    const ground = scene.surfaceHeightAt(px, py);
    // C held: looking behind (GTA's look-behind).
    const viewYaw = keys.has('c') ? yaw + Math.PI : yaw;
    const dirX = Math.cos(viewYaw), dirY = Math.sin(viewYaw);
    const aimed = aiming && play.mode === 'foot' && !firstPerson;
    focus = [px, py, ground];
    if (firstPerson && play.mode !== 'inside' && play.mode !== 'ride') {
      let ex = px, ey = py, eh = ground + HEAD;
      if (play.mode === 'car' && car) {
        // At the wheel: the driver's seat, on the left of the car.
        const a = car.angle;
        ex = car.x - Math.sin(a) * m(0.38) + Math.cos(a) * m(0.05);
        ey = car.y + Math.cos(a) * m(0.38) + Math.sin(a) * m(0.05);
        eh = ground + m(1.18);
        yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
      }
      const cp = Math.cos(pitch * 0.9 - 0.3), sp = Math.sin(pitch * 0.9 - 0.3);
      eye = [ex, ey, eh];
      look = [ex + dirX * cp * m(10), ey + dirY * cp * m(10), eh - sp * m(10)];
      scene.setHiddenPerson(PLAYER_ID);
      smoothEye = null;
    } else {
      // Behind a car at GTA's distance; a bus or a train car framed by its own length;
      // aiming, close over the right shoulder.
      const arm = aimed ? ARM_AIM : at.vehicle ? Math.max(ARM_CAR, at.length * 1.1 + m(4)) : ARM_FOOT;
      const pivotH = ground + (at.vehicle ? PIVOT_CAR : PIVOT_FOOT);
      const shoulder = aimed ? SHOULDER : 0;
      const pvx = px + Math.sin(viewYaw) * shoulder, pvy = py - Math.cos(viewYaw) * shoulder;
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      // The spring arm: drawn in to the first building or vehicle in the way.
      boxes = play.vehicleBoxes(sim, px, py, arm + m(8));
      boxGround = ground;
      let length = arm;
      for (let k = 1; k <= 10; k++) {
        const d = (arm * k) / 10;
        const x = pvx - dirX * cp * d, y = pvy - dirY * cp * d, h = pivotH + sp * d;
        if (solid(x, y, h)) { length = Math.max(m(0.6), (arm * (k - 1)) / 10); break; }
      }
      const target: V3 = [pvx - dirX * cp * length, pvy - dirY * cp * length, pivotH + sp * length];
      // A little lag, as a camera on an arm has.
      if (!smoothEye) smoothEye = [...target];
      const k = 1 - Math.exp(-dt * 12);
      smoothEye = [smoothEye[0] + (target[0] - smoothEye[0]) * k, smoothEye[1] + (target[1] - smoothEye[1]) * k, smoothEye[2] + (target[2] - smoothEye[2]) * k];
      eye = smoothEye;
      // Aiming, the camera looks where the shot goes, past the shoulder; else at the player.
      look = aimed ? [pvx + dirX * cp * m(20), pvy + dirY * cp * m(20), pivotH - sp * m(20)] : [px, py, pivotH];
      scene.setHiddenPerson(null);
    }
    const camera: PlayCamera = { eye, look, fov: firstPerson ? 70 : aimed ? 45 : 60, focus };
    scene.setChase(camera);
  };

  // ------------------------------------------------------------ the frame
  const api: Play = {
    get active() { return active; },
    toggle() {
      const scene = host.scene();
      if (active) {
        active = false;
        play.stop(sim);
        keys.clear();
        document.documentElement.classList.remove('playing-cursorless');
        if (document.pointerLockElement) document.exitPointerLock();
        scene.setChase(null);
        scene.setHiddenPerson(null);
        if (insideShown !== null) { host.openInside(null); insideShown = null; }
        showHud();
        host.requestDraw();
        return;
      }
      const c = host.centre();
      const engine = sim.pedEngine;
      const at = engine.walkableNear?.call(engine, sim, c.x, c.y, m(60)) ?? c;
      active = true;
      firstPerson = false;
      yaw = Math.PI / 4;
      pitch = 0.32;
      smoothEye = null;
      play.start(sim, at.x, at.y, yaw);
      // The mouse captured at once, its cursor gone (the player, 2026-10-06:
      // "o cursor do mouse some e ao mover o mouse move a vista"); the J key
      // and the Play button are the player's own gestures, which the browser
      // asks for. Over the game the cursor is hidden whatever the browser allows.
      lockRefused = false;
      document.documentElement.classList.add('playing-cursorless');
      capture();
      showHud();
      host.requestDraw();
    },
    frame(dt) {
      if (!active) return;
      // Movement relative to where the camera looks.
      const fx = Math.cos(yaw), fy = Math.sin(yaw);
      const rx = Math.sin(yaw), ry = -Math.cos(yaw);
      let mx = 0, my = 0;
      if (keys.has('w') || keys.has('arrowup')) { mx += fx; my += fy; }
      if (keys.has('s') || keys.has('arrowdown')) { mx -= fx; my -= fy; }
      if (keys.has('d') || keys.has('arrowright')) { mx += rx; my += ry; }
      if (keys.has('a') || keys.has('arrowleft')) { mx -= rx; my -= ry; }
      const len = Math.hypot(mx, my);
      play.input.moveX = len > 0 ? mx / len : 0;
      play.input.moveY = len > 0 ? my / len : 0;
      play.input.run = keys.has('shift');
      play.input.throttle = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
      play.input.steer = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
      play.input.aimX = fx;
      play.input.aimY = fy;
      play.input.aiming = aiming && play.mode === 'foot';
      play.input.handbrake = keys.has(' ');
      // In a car (or riding) the camera swings round behind it by itself once the mouse rests, as GTA's does.
      if ((play.mode === 'car' || play.mode === 'ride') && performance.now() - mouseAt > 1500) {
        const a = play.viewPoint(sim).heading;
        yaw += Math.atan2(Math.sin(a - yaw), Math.cos(a - yaw)) * Math.min(1, dt * 3);
      }
      // Inside a building: the building opened at its ground floor.
      const wantInside = play.mode === 'inside' ? play.inside : null;
      if (wantInside !== insideShown) { host.openInside(wantInside); insideShown = wantInside; }
      if (!play.active) { active = false; host.scene().setChase(null); showHud(); return; }
      placeCamera(dt);
      // The shots fired since the last frame: tracers.
      const scene = host.scene();
      for (const s of play.shots.splice(0)) {
        const h0 = scene.surfaceHeightAt(s.from.x, s.from.y) + m(1.35);
        const h1 = scene.surfaceHeightAt(s.to.x, s.to.y) + m(1.2);
        scene.shot([s.from.x, s.from.y, h0], [s.to.x, s.to.y, h1]);
      }
      showHud();
      host.requestDraw();
    },
  };
  return api;
}
