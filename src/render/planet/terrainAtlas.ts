import { FACE_COUNT, FACE_HALF } from '@core/cubeSphere';
import type { CoverKind } from '@world/terrainPaint';
import type { PaintDab } from '@world/terrainPaint';
import type { TerrainStamp } from '@world/terrain';
import type { GullyDab } from '@world/gullies';
import type { RoadDoc } from '@world/doc';
import { FACE_REACH, faceCellOf, faceCentre } from '@world/planet/atlas';
import { faceGround } from '@world/planet/relief';
import type { Mesh } from 'three';
import { GroundChanges } from '../groundChanges';
import {
  createTerrainSurface,
  type TerrainPart,
  type TerrainRegion,
  type TerrainShaper,
  type TerrainSource,
  type TerrainSurface,
} from '../terrain';

/**
 * THE PLANET'S GROUND: six terrain plates, one a face of the cube, each the
 * flat map's own surface (`terrain.ts`) standing at its face's centre in the
 * atlas (`world/planet/atlas.ts`). Nothing of the surface itself changed: it
 * is handed its face's share of the document in the face's own coordinates
 * (`FaceSource`), and every question asked in the atlas's coordinates is sent
 * to the face whose cell holds the point.
 *
 * A stamp (or a painted dab) belongs to every face its disc reaches, its
 * border's reach included, so a hill on a border rises on both sides.
 */

/** Grid regions of several plates in one number line: a plate's corners are offset by its index times this. */
const REGION_STRIDE = 1000;

/** One face's share of the document, in the face's coordinates (what `TerrainSurface.update` reads). */
class FaceSource implements TerrainSource {
  changes!: RoadDoc['changes'];
  terrainRevision = 0;
  terrainStamps: TerrainStamp[] = [];
  terrainRelief!: RoadDoc['terrainRelief'];
  natureRevision = 0;
  nature: RoadDoc['nature'] = null;
  paintRevision = 0;
  terrainPaint: PaintDab[] = [];
  /** The document's own stamps and dabs this face's were made from, in order. */
  stampSources: readonly TerrainStamp[] = [];
  paintSources: readonly PaintDab[] = [];
  /** The face's land, read at the sphere so neighbours meet at the same height (`planet/relief.ts`). */
  terrainGround?: (x: number, y: number) => number;
}

interface Tile {
  readonly face: number;
  readonly cx: number;
  readonly cy: number;
  readonly surface: TerrainSurface;
  readonly source: FaceSource;
}

/** Whether a disc of the atlas reaches a face's square with its reach. */
const reaches = (tile: Tile, x: number, y: number, radius: number): boolean => {
  const h = FACE_HALF + FACE_REACH + radius;
  return Math.abs(x - tile.cx) <= h && Math.abs(y - tile.cy) <= h;
};

const sameList = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export function createTerrainAtlas(anisotropy: number): TerrainSurface {
  const tiles: Tile[] = Array.from({ length: FACE_COUNT }, (_, face) => {
    const c = faceCentre(face);
    return { face, cx: c.x, cy: c.y, surface: createTerrainSurface(anisotropy, c), source: new FaceSource() };
  });
  // The faces meet: no backdrop round each plate, no cut sides under it.
  for (const tile of tiles) {
    for (const mesh of tile.surface.meshes) {
      if (mesh.name === 'terrain-backdrop' || mesh.name === 'terrain-walls') mesh.visible = false;
    }
  }
  const tileAt = (x: number, y: number): Tile => tiles[faceCellOf(x, y)] as Tile;

  /** A stamp or dab of the atlas in a face's coordinates. */
  const localStamp = (tile: Tile, s: TerrainStamp): TerrainStamp => ({ ...s, x: s.x - tile.cx, y: s.y - tile.cy });
  const localDab = (tile: Tile, d: PaintDab): PaintDab => ({ ...d, x: d.x - tile.cx, y: d.y - tile.cy });
  /** The local copies made, by face, so an unchanged stamp keeps its copy (the surface compares them by identity). */
  const stampCopies = tiles.map(() => new WeakMap<TerrainStamp, TerrainStamp>());
  const dabCopies = tiles.map(() => new WeakMap<PaintDab, PaintDab>());

  let seenTerrain = -1;
  let seenRelief: RoadDoc['terrainRelief'] | null = null;
  let seenPaint = -1;
  /** Brings every face's share up to the document. */
  const sync = (doc: TerrainSource): void => {
    for (const tile of tiles) {
      tile.source.changes = doc.changes;
      tile.source.natureRevision = doc.natureRevision;
      tile.source.nature = doc.nature;
    }
    if (doc.terrainRevision !== seenTerrain) {
      seenTerrain = doc.terrainRevision;
      const reliefMoved = seenRelief !== null && seenRelief !== doc.terrainRelief;
      seenRelief = doc.terrainRelief;
      tiles.forEach((tile, i) => {
        const sources = doc.terrainStamps.filter((s) => reaches(tile, s.x, s.y, s.radius));
        tile.source.terrainRelief = doc.terrainRelief;
        if (reliefMoved || !tile.source.terrainGround) tile.source.terrainGround = faceGround(tile.face, doc.terrainRelief);
        if (!reliefMoved && tile.source.terrainRevision !== 0 && sameList(sources, tile.source.stampSources)) return;
        const copies = stampCopies[i] as WeakMap<TerrainStamp, TerrainStamp>;
        tile.source.stampSources = sources;
        tile.source.terrainStamps = sources.map((s) => {
          let local = copies.get(s);
          if (!local) copies.set(s, local = localStamp(tile, s));
          return local;
        });
        tile.source.terrainRevision = doc.terrainRevision;
      });
    }
    if (doc.paintRevision !== seenPaint) {
      seenPaint = doc.paintRevision;
      tiles.forEach((tile, i) => {
        const sources = doc.terrainPaint.filter((d) => reaches(tile, d.x, d.y, d.radius));
        if (sameList(sources, tile.source.paintSources)) return;
        const copies = dabCopies[i] as WeakMap<PaintDab, PaintDab>;
        tile.source.paintSources = sources;
        tile.source.terrainPaint = sources.map((d) => {
          let local = copies.get(d);
          if (!local) copies.set(d, local = localDab(tile, d));
          return local;
        });
        tile.source.paintRevision = doc.paintRevision;
      });
    }
  };

  /** A region of the atlas's number line: its plate, and the plate's own corners. */
  const decode = (region: TerrainRegion): { tile: Tile; local: TerrainRegion } => {
    const index = Math.floor(region[0] / REGION_STRIDE);
    const off = index * REGION_STRIDE;
    return { tile: tiles[index] as Tile, local: [region[0] - off, region[1] - off, region[2], region[3]] };
  };
  const encode = (tile: Tile, region: TerrainRegion): TerrainRegion => {
    const off = tile.face * REGION_STRIDE;
    return [region[0] + off, region[1] + off, region[2], region[3]];
  };
  /** A road field asked in a face's coordinates. */
  const shaperFor = (tile: Tile, shape: TerrainShaper): TerrainShaper => ({
    shapeAt: (x, y, ground) => shape.shapeAt(x + tile.cx, y + tile.cy, ground),
    shapeBounds: () => shape.shapeBounds().map((b) => ({ minX: b.minX - tile.cx, minY: b.minY - tile.cy, maxX: b.maxX - tile.cx, maxY: b.maxY - tile.cy })),
  });

  let lastTile: Tile | null = null;
  const geologyChanges = new GroundChanges();
  const geologySeen = tiles.map(() => 0);
  const parts: TerrainPart[] = tiles.map((t) => ({ surface: t.surface, cx: t.cx, cy: t.cy }));
  const sum = (read: (s: TerrainSurface) => number): number => tiles.reduce((acc, t) => acc + read(t.surface), 0);

  const ask = <T>(x: number, y: number, read: (s: TerrainSurface, lx: number, ly: number) => T): T => {
    const tile = tileAt(x, y);
    return read(tile.surface, x - tile.cx, y - tile.cy);
  };

  const meshes: Mesh[] = tiles.flatMap((t) => [...t.surface.meshes]);
  const first = tiles[0] as Tile;
  return {
    meshes,
    ground: first.surface.ground,
    parts,
    setSun(direction) { for (const t of tiles) t.surface.setSun(direction); },
    bakeRelief(renderer, focus) {
      // The close window only where the view is; every plate its own map-wide level.
      const at = focus ? tileAt(focus.x, -focus.z) : null;
      for (const t of tiles) t.surface.bakeRelief(renderer, t === at && focus ? { x: focus.x - t.cx, z: focus.z + t.cy } : null);
    },
    setWaterLook(look) { for (const t of tiles) t.surface.setWaterLook(look); },
    setGullies(dabs: readonly GullyDab[], auto) {
      for (const t of tiles) {
        t.surface.setGullies(dabs.filter((d) => reaches(t, d.x, d.y, d.radius)).map((d) => ({ ...d, x: d.x - t.cx, y: d.y - t.cy })), auto);
      }
    },
    vergeMaterial: first.surface.vergeMaterial,
    heightAt: (x, y) => ask(x, y, (s, lx, ly) => s.heightAt(lx, ly)),
    naturalRenderedHeightAt: (x, y) => ask(x, y, (s, lx, ly) => s.naturalRenderedHeightAt(lx, ly)),
    renderedHeightAt: (x, y) => ask(x, y, (s, lx, ly) => s.renderedHeightAt(lx, ly)),
    wetAt: (x, y) => ask(x, y, (s, lx, ly) => s.wetAt(lx, ly)),
    digest(minX, minY, maxX, maxY) {
      const tile = tileAt((minX + maxX) / 2, (minY + maxY) / 2);
      return tile.surface.digest(minX - tile.cx, minY - tile.cy, maxX - tile.cx, maxY - tile.cy) + tile.face;
    },
    update(doc, stroking) {
      sync(doc);
      let moved = false;
      for (const t of tiles) {
        if (t.surface.update(t.source, stroking)) { moved = true; lastTile = t; }
      }
      return moved;
    },
    updatePaint(doc) {
      sync(doc);
      tiles.forEach((t, i) => {
        t.surface.updatePaint(t.source);
        const v = t.surface.geologyChanges.version;
        if (v !== geologySeen[i]) { geologySeen[i] = v; geologyChanges.mark(null); }
      });
    },
    forestAt: (x, y) => ask(x, y, (s, lx, ly) => s.forestAt(lx, ly)),
    coverAt: (kind: CoverKind, x, y) => ask(x, y, (s, lx, ly) => s.coverAt(kind, lx, ly)),
    get forestRevision() { return sum((s) => s.forestRevision); },
    geologyAt: (x, y) => ask(x, y, (s, lx, ly) => s.geologyAt(lx, ly)),
    ecology: () => first.surface.ecology(),
    get ecologyRevision() { return sum((s) => s.ecologyRevision); },
    ecologyTexture: first.surface.ecologyTexture,
    geologyChanges,
    shoreLevelAt: (x, y) => ask(x, y, (s, lx, ly) => s.shoreLevelAt(lx, ly)),
    waterArea() {
      let box: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
      for (const t of tiles) {
        const w = t.surface.waterArea();
        if (!w) continue;
        const b = { minX: w.minX + t.cx, maxX: w.maxX + t.cx, minY: w.minY + t.cy, maxY: w.maxY + t.cy };
        box = box ? { minX: Math.min(box.minX, b.minX), maxX: Math.max(box.maxX, b.maxX), minY: Math.min(box.minY, b.minY), maxY: Math.max(box.maxY, b.maxY) } : b;
      }
      return box;
    },
    get waterRevision() { return sum((s) => s.waterRevision); },
    get lastRegion() {
      const region = lastTile?.surface.lastRegion ?? null;
      return region && lastTile ? encode(lastTile, region) : null;
    },
    settle() { for (const t of tiles) t.surface.settle(); },
    shapeToRoads(shape, region = null) {
      const list: readonly TerrainRegion[] | null = region === null ? null
        : typeof region[0] === 'number' ? [region as TerrainRegion] : region as readonly TerrainRegion[];
      let moved = false;
      if (list === null) {
        for (const t of tiles) if (t.surface.shapeToRoads(shape && shaperFor(t, shape), null)) moved = true;
        return moved;
      }
      const byTile = new Map<Tile, TerrainRegion[]>();
      for (const r of list) {
        const { tile, local } = decode(r);
        let mine = byTile.get(tile);
        if (!mine) byTile.set(tile, mine = []);
        mine.push(local);
      }
      for (const [t, regions] of byTile) if (t.surface.shapeToRoads(shape && shaperFor(t, shape), regions)) moved = true;
      return moved;
    },
    regionOf(box) {
      const tile = tileAt((box[0] + box[2]) / 2, (box[1] + box[3]) / 2);
      return encode(tile, tile.surface.regionOf([box[0] - tile.cx, box[1] - tile.cy, box[2] - tile.cx, box[3] - tile.cy]));
    },
    rectOf(region) {
      const { tile, local } = decode(region);
      const r = tile.surface.rectOf(local);
      return [r[0] + tile.cx, r[1] + tile.cy, r[2] + tile.cx, r[3] + tile.cy];
    },
    dispose() { for (const t of tiles) t.surface.dispose(); },
  };
}
