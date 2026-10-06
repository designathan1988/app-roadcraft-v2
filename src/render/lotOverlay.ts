import {
  BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, ShapeUtils, Vector2, type Scene,
} from 'three';
import type { Vec2 } from '@core/vec2';
import { m } from '@world/units';

/**
 * The lots drawn in the scene (`world/lots.ts`, the Zoning tool): fills and
 * outlines laid on the ground itself - the road deck, the footway, the
 * terrain - so they stay where the land is as the camera moves. Drawn on a
 * 2D canvas over the picture at a guessed height, they slid against the
 * ground with every turn of the camera and sat crooked over the footway.
 *
 * Outlines are ribbons of a constant width on the ground, subdivided so they
 * follow its relief; fills are the polygons triangulated with their edges
 * subdivided, each vertex at the ground's height. Rebuilt only when the
 * input's key changes.
 */
export interface LotOverlayInput {
  /** Changes whenever anything drawn changes. */
  readonly key: string;
  readonly polygons: readonly {
    readonly corners: readonly Vec2[];
    readonly fill: number | null;
    readonly fillAlpha: number;
    readonly line: number;
    readonly lineAlpha: number;
    /** Line width, metres on the ground. */
    readonly width: number;
  }[];
  readonly lines: readonly { readonly a: Vec2; readonly b: Vec2; readonly colour: number; readonly dashed: boolean; readonly width: number }[];
  readonly points: readonly { readonly p: Vec2; readonly colour: number; readonly radius: number }[];
}

export function createLotOverlay(scene: Scene, groundAt: (x: number, y: number) => number) {
  const group = new Group();
  group.name = 'lot-overlay';
  group.renderOrder = 10;
  scene.add(group);
  const material = (alpha: boolean): MeshBasicMaterial => new MeshBasicMaterial({
    vertexColors: true, transparent: alpha, opacity: 1, depthWrite: false, side: DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16,
  });
  const fillMat = material(true), lineMat = material(true);
  fillMat.forceSinglePass = true;
  lineMat.forceSinglePass = true;
  let key = '';
  let meshes: Mesh[] = [];
  const LIFT = m(0.12);

  /** World (x, y) on the ground, as three's (x, height, -y). */
  const at = (x: number, y: number, lift = LIFT): [number, number, number] => [x, groundAt(x, y) + lift, -y];

  function build(input: LotOverlayInput): void {
    for (const mesh of meshes) { group.remove(mesh); mesh.geometry.dispose(); }
    meshes = [];
    const fillPos: number[] = [], fillCol: number[] = [];
    const linePos: number[] = [], lineCol: number[] = [];
    const colour = new Color();
    const pushColour = (into: number[], c: number, alpha: number, n: number): void => {
      colour.set(c);
      for (let i = 0; i < n; i++) into.push(colour.r, colour.g, colour.b, alpha);
    };
    const ribbon = (a: Vec2, b: Vec2, width: number, c: number, alpha: number, lift: number): void => {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-6) return;
      const nx = -(b.y - a.y) / len * width / 2, ny = (b.x - a.x) / len * width / 2;
      const steps = Math.max(1, Math.ceil(len / m(2)));
      // Each cross-section's two ground points once: a step shares its end
      // with the next step's start (the ground was asked twice for each).
      let r0 = at(a.x - nx, a.y - ny, lift), l0 = at(a.x + nx, a.y + ny, lift);
      for (let k = 0; k < steps; k++) {
        const t1 = (k + 1) / steps;
        const p1x = a.x + (b.x - a.x) * t1, p1y = a.y + (b.y - a.y) * t1;
        const l1 = at(p1x + nx, p1y + ny, lift), r1 = at(p1x - nx, p1y - ny, lift);
        linePos.push(...r0, ...l0, ...l1, ...r0, ...l1, ...r1);
        pushColour(lineCol, c, alpha, 6);
        r0 = r1; l0 = l1;
      }
    };
    for (const poly of input.polygons) {
      const ring = poly.corners;
      if (ring.length < 3) continue;
      if (poly.fill !== null && poly.fillAlpha > 0) {
        // Edges subdivided every 3 m so the fill bends with the ground.
        const pts: Vec2[] = [];
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
          const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / m(3)));
          for (let k = 0; k < steps; k++) pts.push({ x: a.x + (b.x - a.x) * k / steps, y: a.y + (b.y - a.y) * k / steps });
        }
        const tris = ShapeUtils.triangulateShape(pts.map((p) => new Vector2(p.x, p.y)), []);
        for (const tri of tris) {
          for (const i of tri) fillPos.push(...at(pts[i]!.x, pts[i]!.y));
          pushColour(fillCol, poly.fill, poly.fillAlpha, 3);
        }
      }
      for (let i = 0; i < ring.length; i++) ribbon(ring[i]!, ring[(i + 1) % ring.length]!, m(poly.width), poly.line, poly.lineAlpha, LIFT * 1.5);
    }
    for (const line of input.lines) {
      if (!line.dashed) { ribbon(line.a, line.b, m(line.width), line.colour, 1, LIFT * 2); continue; }
      const len = Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y);
      const dash = m(2), gap = m(1.2);
      for (let s = 0; s < len; s += dash + gap) {
        const t0 = s / len, t1 = Math.min(1, (s + dash) / len);
        ribbon({ x: line.a.x + (line.b.x - line.a.x) * t0, y: line.a.y + (line.b.y - line.a.y) * t0 },
          { x: line.a.x + (line.b.x - line.a.x) * t1, y: line.a.y + (line.b.y - line.a.y) * t1 }, m(line.width), line.colour, 1, LIFT * 2);
      }
    }
    for (const point of input.points) {
      // A disc of 12 sides.
      const r = m(point.radius), c = at(point.p.x, point.p.y, LIFT * 2.5);
      for (let k = 0; k < 12; k++) {
        const a0 = k / 12 * Math.PI * 2, a1 = (k + 1) / 12 * Math.PI * 2;
        linePos.push(...c, c[0] + Math.cos(a0) * r, c[1], c[2] + Math.sin(a0) * r, c[0] + Math.cos(a1) * r, c[1], c[2] + Math.sin(a1) * r);
        pushColour(lineCol, point.colour, 1, 3);
      }
    }
    for (const [pos, col, mat, order] of [[fillPos, fillCol, fillMat, 10], [linePos, lineCol, lineMat, 11]] as const) {
      if (!pos.length) continue;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
      geometry.setAttribute('color', new Float32BufferAttribute(col, 4));
      const mesh = new Mesh(geometry, mat);
      mesh.renderOrder = order;
      mesh.frustumCulled = false;
      meshes.push(mesh);
      group.add(mesh);
    }
  }

  return {
    set(input: LotOverlayInput | null): void {
      const next = input?.key ?? '';
      if (next === key) return;
      key = next;
      if (input) build(input);
      else { for (const mesh of meshes) { group.remove(mesh); mesh.geometry.dispose(); } meshes = []; }
    },
    dispose(): void {
      for (const mesh of meshes) mesh.geometry.dispose();
      fillMat.dispose(); lineMat.dispose();
      scene.remove(group);
    },
  };
}
