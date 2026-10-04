import { Box3, DoubleSide, Group, type Material, type Mesh, type Scene, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { UNITS_PER_METER } from '@world/units';

/**
 * A reference model in the Builder: a real building's 3D model (glTF/GLB),
 * shown translucent where a building stands, to build it over - the way an
 * architect traces a survey. It is a drawing aid only: never saved with the
 * city, never part of a building, and it casts no shadow.
 *
 * Placed on the selected building: its plan centred on the building's plan,
 * its foot on the building's floor, turned with the building, in metres (glTF
 * is Y-up in metres). The player turns it in quarter turns, mirrors it front
 * to back, fades it, hides it or removes it.
 */
export interface ReferenceTarget {
  /** Centre of the building's plan, world units. */
  readonly x: number;
  readonly y: number;
  /** Height of its floor, world units. */
  readonly floor: number;
  /** The building's rotation, radians. */
  readonly rotation: number;
}

export interface ReferenceInfo {
  readonly name: string;
  /** Size in metres: across, deep, tall. */
  readonly size: readonly [number, number, number];
}

export interface ReferenceModel {
  load(file: File): Promise<ReferenceInfo>;
  placeOn(target: ReferenceTarget): void;
  turn(): void;
  flip(): void;
  fade(step: number): void;
  toggle(): void;
  remove(): void;
  readonly loaded: boolean;
  readonly info: ReferenceInfo | null;
  readonly opacity: number;
}

export function createReferenceModel(scene: Scene, redraw: () => void): ReferenceModel {
  const holder = new Group();
  holder.name = 'builder-reference';
  holder.visible = false;
  scene.add(holder);
  const inner = new Group();
  holder.add(inner);
  let info: ReferenceInfo | null = null;
  let opacity = 0.5;
  let quarter = 0;
  let mirrored = false;
  let target: ReferenceTarget | null = null;
  const materials: Material[] = [];

  const apply = (): void => {
    for (const m of materials) {
      m.transparent = opacity < 0.999;
      m.opacity = opacity;
      m.depthWrite = opacity >= 0.999;
      m.needsUpdate = true;
    }
    if (target) {
      // World (x, y, height) is three (x, height, -y); a world turn of +a is +a about three's Y.
      holder.position.set(target.x, target.floor, -target.y);
      holder.rotation.y = target.rotation + quarter * Math.PI / 2;
    }
    inner.scale.set(UNITS_PER_METER, UNITS_PER_METER, (mirrored ? -1 : 1) * UNITS_PER_METER);
    redraw();
  };

  return {
    async load(file) {
      const data = await file.arrayBuffer();
      const gltf = await new GLTFLoader().parseAsync(data, '');
      inner.clear();
      materials.length = 0;
      const model = gltf.scene;
      // Its plan centred on the origin, its foot at 0: in metres, Y up.
      const box = new Box3().setFromObject(model);
      const centre = box.getCenter(new Vector3());
      model.position.set(-centre.x, -box.min.y, -centre.z);
      model.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.renderOrder = 2;
        for (const m of [mesh.material].flat()) {
          m.side = DoubleSide;
          materials.push(m);
        }
      });
      inner.add(model);
      const size = box.getSize(new Vector3());
      info = { name: file.name, size: [size.x, size.z, size.y] };
      quarter = 0;
      mirrored = false;
      holder.visible = true;
      apply();
      return info;
    },
    placeOn(next) {
      target = next;
      apply();
    },
    turn() {
      quarter = (quarter + 1) % 4;
      apply();
    },
    flip() {
      mirrored = !mirrored;
      apply();
    },
    fade(step) {
      opacity = Math.min(1, Math.max(0.1, Math.round((opacity + step) * 10) / 10));
      apply();
    },
    toggle() {
      if (!info) return;
      holder.visible = !holder.visible;
      redraw();
    },
    remove() {
      inner.clear();
      materials.length = 0;
      info = null;
      holder.visible = false;
      redraw();
    },
    get loaded() { return info !== null; },
    get info() { return info; },
    get opacity() { return opacity; },
  };
}
