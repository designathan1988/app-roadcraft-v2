import { AmbientLight, Box3, DirectionalLight, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';

import { applyFacadePattern } from '@world/buildings/facadePatterns';
import {
  BAY_COMPONENTS,
  type Building,
  type ElementKind,
  FACADE_PATTERNS,
  type FacadePattern,
  ROOF_KINDS,
  type RoofKind,
  type BayComponent,
} from '@world/buildings/types';
import { ELEMENT_DEFAULTS, elementAt } from '@world/buildings/elements';
import { BLUEPRINTS, blueprintByKey, instantiate } from '@world/buildings/blueprints';
import { cityBuilding } from '@world/buildings/cityBuildings';
import { buildingBounds, buildingHeight } from '@world/buildings/geometry';
import { buildBuildingMeshes } from './buildingMesh';
import { type BuildingKit, createBuildingKit } from './kit';

/**
 * Pictures of the things the galleries offer - a model, a window, a roof, a
 * stair - built by the same mesh builder that will build them on the map and
 * photographed from the game camera's own angle.
 *
 * A gallery of glyphs names the options; a gallery of pictures shows them. It
 * is a studio rather than a function because a picture costs a few
 * milliseconds: an interface that photographs eighty of them in one go freezes
 * for a third of a second (measured), so the pictures are taken a few per frame
 * and handed over as they are ready.
 */
const SIZE = 224;
/** Pictures per frame: enough to fill a row, small enough to hold 60 fps. */
const PER_FRAME = 3;
/** Milliseconds of a frame the pictures may take, after the first of the frame. */
const FRAME_SHARE_MS = 6;
/** How long the second context is kept once the queue is empty. */
const IDLE_MS = 4000;

/** Which BayComponent a gallery id stands for: most carry their own name. */
const WALL_PARTS: Readonly<Record<string, BayComponent>> = {
  ...Object.fromEntries(BAY_COMPONENTS.map((component) => [component, component])),
  pillarBay: 'pillar',
  wallBay: 'wall',
};

const ROOF_PARTS: Readonly<Record<string, RoofKind>> = Object.fromEntries(
  ROOF_KINDS.map((kind) => [kind === 'flat' ? 'roofFlat' : `roof${kind[0]?.toUpperCase()}${kind.slice(1)}`, kind]),
);

const ELEMENT_PARTS = new Set<string>(Object.keys(ELEMENT_DEFAULTS));

/** The traced runs are their element, seen as the thing they lay. */
const RUN_PARTS: Readonly<Record<string, ElementKind>> = {
  wallRun: 'wall',
  fenceRun: 'fence',
  pavementRun: 'pavement',
  stairRun: 'stair',
  railing: 'railing',
};

const MODEL_KEYS = new Set(BLUEPRINTS.map((blueprint) => blueprint.key));

function blank(): Building | null {
  const blueprint = blueprintByKey('block');
  if (!blueprint) return null;
  return { ...instantiate(blueprint.body, { x: 0, y: 0 }, 0), id: -1 } as Building;
}

/**
 * The record a part is photographed from: the wall of a small block for a
 * window, that block under the roof in question, or a pad with one element
 * standing on it.
 */
export function partSample(id: string): Building | null {
  if (id.startsWith('city:')) {
    const model = cityBuilding(id.slice(5));
    return model ? ({ ...instantiate(model.body, { x: 0, y: 0 }, Math.PI / 4), id: -1 } as Building) : null;
  }
  if (MODEL_KEYS.has(id)) {
    const blueprint = blueprintByKey(id);
    if (!blueprint) return null;
    return { ...instantiate(blueprint.body, { x: 0, y: 0 }, Math.PI / 4), id: -1 } as Building;
  }

  const sample = blank();
  const volume = sample?.volumes[0];
  if (!sample || !volume) return null;
  sample.elements = [];

  const component = WALL_PARTS[id];
  if (component) {
    // One storey, one wall, filled with the part: the picture is the part.
    if (!volume.storeys[0]) return null;
    volume.storeys = [{ facade: { fill: component } }];
    return sample;
  }

  // A composition is photographed on the wall it composes.
  if ((FACADE_PATTERNS as readonly string[]).includes(id)) {
    // Applied as the panel applies it - shopfronts, glazing, piers - or every
    // pattern photographed as the same plain block.
    applyFacadePattern(sample, { scope: 'building' }, id as FacadePattern);
    return sample;
  }

  const roof = ROOF_PARTS[id];
  if (roof) {
    volume.roof = roof;
    return sample;
  }
  if (id === 'roofShape' || id === 'roofs') {
    volume.roof = 'gable';
    return sample;
  }

  const kind = RUN_PARTS[id] ?? (ELEMENT_PARTS.has(id) ? (id as ElementKind) : null);
  if (kind) {
    // No walls at all: the element alone, at the size it is placed at.
    sample.volumes = [];
    sample.cores = [];
    sample.elements = [{ ...elementAt(sample, kind, { x: 0, y: 0 }, 2), id: 1 }];
    return sample;
  }

  return null;
}

export interface ThumbnailStudio {
  /**
   * Photographs the ids that are worth a picture, a few per frame, calling
   * back with each batch. Ids already taken or already queued are ignored.
   */
  request(ids: readonly string[], onBatch: (images: ReadonlyMap<string, string>) => void): void;
  /** Releases the second GPU context at once. */
  dispose(): void;
  /** How long the studio holds its context after the last picture. */
  IDLE_MS?: number;
}

export function createThumbnailStudio(gl: WebGLRenderer): ThumbnailStudio {
  const done = new Set<string>();
  const queued = new Set<string>();
  const waiting: { id: string; onBatch: (images: ReadonlyMap<string, string>) => void }[] = [];
  let frame: number | null = null;

  let idle: ReturnType<typeof setTimeout> | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let renderer: WebGLRenderer | null = null;
  let kit: BuildingKit | null = null;
  let scene: Scene | null = null;
  let camera: PerspectiveCamera | null = null;

  const setUp = (): boolean => {
    if (renderer) return true;
    try {
      canvas = document.createElement('canvas');
      canvas.width = SIZE;
      canvas.height = SIZE;
      renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(1);
      renderer.setSize(SIZE, SIZE, false);
      renderer.setClearColor(0x000000, 0);
      void gl;
      kit = createBuildingKit();
      scene = new Scene();
      scene.add(new AmbientLight(0xffffff, 1.15));
      const sun = new DirectionalLight(0xffffff, 1.5);
      sun.position.set(-3, 6, -2);
      scene.add(sun);
      camera = new PerspectiveCamera(30, 1, 0.5, 4000);
      return true;
    } catch (error) {
      // No second context: the galleries keep their glyphs.
      console.warn('parts studio: no second context', error);
      return false;
    }
  };

  const shoot = (id: string, batch: Map<string, string>): void => {
    const sample = partSample(id);
    if (!sample || !renderer || !kit || !scene || !camera) return;
    try {
      const meshes = buildBuildingMeshes([sample], () => 0, kit);
      scene.add(meshes.group);
      const box = buildingBounds(sample);
      const height = Math.max(buildingHeight(sample), 3);
      // An element on its own stands on nothing: it is framed round itself,
      // or the camera looks over its head and the picture clips its feet.
      const alone = sample.volumes.length === 0;
      const span = Math.max(box.maxX - box.minX, box.maxY - box.minY, height * 0.9) + (alone ? 2 : 4);
      const focus = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
      // One preset per kind of thing, as engines give each asset type its own
      // thumbnail renderer: a roof is seen from above, so it is the roof that
      // differs between pictures; a window or door from in front, close, so
      // the opening fills the frame; a model and an element in 3/4.
      // Every picture is fitted the same way: the thing's bounding sphere fills
      // ~85% of the frame, so a kiosk and a tower read at the same size.
      // The drawn meshes' own box, not the record's plan: models stand rotated
      // and on plinths, and the plan's centre left them in a corner.
      const view = ROOF_PARTS[id] ? 'roof' : WALL_PARTS[id] ? 'wall' : 'model';
      const bounds = new Box3().setFromObject(meshes.group);
      const centre = bounds.getCenter(new Vector3());
      const size = bounds.getSize(new Vector3());
      // A wall part is framed on two bays of the ground storey, not the block.
      const radius = view === 'wall'
        ? 0.5 * Math.hypot(Math.min(size.x, 7.5), Math.min(size.y, 5))
        : 0.5 * Math.hypot(size.x, size.y, size.z);
      if (view === 'wall') centre.y = bounds.min.y + Math.min(size.y, 5) * 0.62;
      const dir = view === 'roof' ? new Vector3(0.5, 1.05, 0.62) : view === 'wall' ? new Vector3(0.28, 0.12, 1) : new Vector3(0.62, 0.6, 0.62);
      dir.normalize();
      const distance = (Math.max(radius, 0.8) / Math.sin((camera.fov * Math.PI) / 360)) * 1.08;
      if (view === 'wall') {
        // The front wall: the face nearest the camera's side of the box.
        centre.z = bounds.max.z;
      }
      camera.position.copy(centre).addScaledVector(dir, distance);
      void span;
      void focus;
      void alone;
      camera.lookAt(centre);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      // A part that drew nothing keeps its glyph: an empty tile is a defect.
      const gl = renderer.getContext();
      const pixels = new Uint8Array(SIZE * SIZE * 4);
      gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let solid = 0;
      for (let i = 3; i < pixels.length; i += 16) if ((pixels[i] ?? 0) > 16) solid++;
      if (solid / (pixels.length / 16) > 0.02) batch.set(id, renderer.domElement.toDataURL('image/png'));
      scene.remove(meshes.group);
      meshes.dispose();
    } catch {
      // A part that will not build keeps its glyph: the gallery still works.
    }
  };

  const step = (): void => {
    frame = null;
    if (!setUp()) {
      waiting.length = 0;
      return;
    }
    const batch = new Map<string, string>();
    // At least one a frame, and no more once the frame's share is spent: a
    // picture costs from a few to forty milliseconds, and three of the dear
    // ones in a frame were a 130 ms stall.
    const started = performance.now();
    for (let i = 0; i < PER_FRAME && waiting.length > 0 && (i === 0 || performance.now() - started < FRAME_SHARE_MS); i++) {
      const next = waiting.shift();
      if (!next) break;
      shoot(next.id, batch);
      done.add(next.id);
      if (batch.size > 0) next.onBatch(new Map(batch));
    }
    if (waiting.length > 0) {
      frame = requestAnimationFrame(step);
      return;
    }
    // Nothing left to shoot: hand the second GPU context back rather than
    // holding two of them open for the rest of the session, and take it again
    // when another gallery asks. The pictures already on screen are the ones
    // the studio was holding.
    idle = setTimeout(release, IDLE_MS);
  };

  const release = (): void => {
    idle = null;
    kit?.dispose();
    renderer?.dispose();
    canvas?.remove();
    canvas = null;
    renderer = null;
    kit = null;
    scene = null;
    camera = null;
  };

  return {
    request(ids, onBatch) {
      if (idle !== null) {
        clearTimeout(idle);
        idle = null;
      }
      for (const id of ids) {
        if (done.has(id) || queued.has(id)) continue;
        queued.add(id);
        waiting.push({ id, onBatch });
      }
      if (frame === null && waiting.length > 0) frame = requestAnimationFrame(step);
    },
    dispose() {
      if (frame !== null) cancelAnimationFrame(frame);
      if (idle !== null) clearTimeout(idle);
      frame = null;
      idle = null;
      waiting.length = 0;
      release();
    },
  };
}
