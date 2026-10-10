import { PLANET_RADIUS, type Vec3 } from '@core/cubeSphere';
import { TILES, TILE_COUNT, TILE_HALF, sphereToTileInto, tileToSphereInto } from '@core/planetTiles';
import type { CoverKind } from '@world/terrainPaint';
import type { PaintDab } from '@world/terrainPaint';
import type { TerrainStamp } from '@world/terrain';
import type { GullyDab } from '@world/gullies';
import type { RoadDoc } from '@world/doc';
import { TILE_REACH, atlasToTileInto, tileCellOf, tileCentre, type TileLocal } from '@world/planet/atlas';
import { tileGround } from '@world/planet/relief';
import type { Mesh } from 'three';
import { planetSunOnPlanet } from './bend';
import { setLightFocus } from '../terrainLightPool';
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
 * THE PLANET'S GROUND: a terrain plate for each of the planet's pieces
 * (`core/planetTiles.ts`), each the flat map's own surface (`terrain.ts`)
 * standing at its piece's centre in the atlas (`world/planet/atlas.ts`).
 * Nothing of the surface itself changed: it is handed its piece's share of
 * the document in the piece's own coordinates (`FaceSource`), and every
 * question asked in the atlas's coordinates is sent to the piece whose cell
 * holds the point.
 *
 * A stamp (or a painted dab) belongs to every piece its disc reaches on the
 * sphere, each given it on its own map (carried there through the sphere, not
 * by an offset), so a hill on a border rises the same on both sides.
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

const where: TileLocal = { tile: 0, x: 0, y: 0 };
const onSphere: Vec3 = { x: 0, y: 0, z: 0 };
const there = { x: 0, y: 0 };
/** How far from a piece's centre (an arc, world units) anything of it can lie, with its reach. */
const PIECE_REACH = TILE_HALF * Math.SQRT2 + TILE_REACH;

/**
 * A disc of the atlas (its centre in its own piece's cell) on another piece's
 * map: its centre carried through the sphere, or null when it cannot reach
 * that piece.
 */
const placeOn = (tile: Tile, x: number, y: number, radius: number): { x: number; y: number } | null => {
  atlasToTileInto(x, y, where);
  if (where.tile === tile.face) return { x: where.x, y: where.y };
  tileToSphereInto(where.tile, where.x, where.y, onSphere);
  const c = TILES[tile.face]!.centre;
  const arc = Math.acos(Math.min(1, onSphere.x * c.x + onSphere.y * c.y + onSphere.z * c.z)) * PLANET_RADIUS;
  if (arc > PIECE_REACH + radius) return null;
  sphereToTileInto(tile.face, onSphere, there);
  return { x: there.x, y: there.y };
};

/** The sun on one plate's map (`setSun`). */
const sunOnPlate = { x: 0, y: 0, z: 0 };

const sameList = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export function createTerrainAtlas(anisotropy: number): TerrainSurface {
  const tiles: Tile[] = Array.from({ length: TILE_COUNT }, (_, face) => {
    const c = tileCentre(face);
    return { face, cx: c.x, cy: c.y, surface: createTerrainSurface(anisotropy, c, face), source: new FaceSource() };
  });
  // The pieces meet: a plate with a piece has no backdrop round it, no cut sides (`createTerrainSurface`).
  const tileAt = (x: number, y: number): Tile => tiles[tileCellOf(x, y)] as Tile;

  /**
   * The local copies made, by piece (null: it does not reach that piece), so
   * an unchanged stamp keeps its copy - the surface compares them by identity.
   */
  const stampCopies = tiles.map(() => new WeakMap<TerrainStamp, TerrainStamp | null>());
  const dabCopies = tiles.map(() => new WeakMap<PaintDab, PaintDab | null>());
  const copyOn = <T extends { readonly x: number; readonly y: number; readonly radius: number }>(copies: WeakMap<T, T | null>, tile: Tile, item: T): T | null => {
    let local = copies.get(item);
    if (local === undefined) {
      const at = placeOn(tile, item.x, item.y, item.radius);
      copies.set(item, local = at ? { ...item, x: at.x, y: at.y } : null);
    }
    return local;
  };

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
        const copies = stampCopies[i] as WeakMap<TerrainStamp, TerrainStamp | null>;
        const sources = doc.terrainStamps.filter((s) => copyOn(copies, tile, s) !== null);
        tile.source.terrainRelief = doc.terrainRelief;
        if (reliefMoved || !tile.source.terrainGround) tile.source.terrainGround = tileGround(tile.face, doc.terrainRelief);
        if (!reliefMoved && tile.source.terrainRevision !== 0 && sameList(sources, tile.source.stampSources)) return;
        tile.source.stampSources = sources;
        tile.source.terrainStamps = sources.map((s) => copies.get(s) as TerrainStamp);
        tile.source.terrainRevision = doc.terrainRevision;
      });
    }
    if (doc.paintRevision !== seenPaint) {
      seenPaint = doc.paintRevision;
      tiles.forEach((tile, i) => {
        const copies = dabCopies[i] as WeakMap<PaintDab, PaintDab | null>;
        const sources = doc.terrainPaint.filter((d) => copyOn(copies, tile, d) !== null);
        if (sameList(sources, tile.source.paintSources)) return;
        tile.source.paintSources = sources;
        tile.source.terrainPaint = sources.map((d) => copies.get(d) as PaintDab);
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
  /** The water's look last passed to the plates (`setWaterLook`); NaN: none yet. */
  const lastLook = { waves: NaN, foam: NaN, current: NaN, windX: NaN, windZ: NaN, windSpeed: NaN };
  return {
    meshes,
    ground: first.surface.ground,
    parts,
    // Each plate is its piece's flat map (east x, up y, north -z at its
    // centre, `bend.ts`), and its land's light is baked for the sun ON THAT
    // MAP: the sun fixed over the planet, it turns only with the hour. Given
    // three's direction instead - which turns as the planet is set down under
    // each new view - every pan of a degree or two re-baked the light of all
    // 864 plates in the workers (140 s of work for one dab of the brush).
    setSun() {
      // The planet's own sun (bend.ts planetSunOnPlanet), never three's direction carried back.
      const sunOnPlanet = planetSunOnPlanet();
      for (const t of tiles) {
        const f = TILES[t.face]!;
        sunOnPlate.x = sunOnPlanet.x * f.east.x + sunOnPlanet.y * f.east.y + sunOnPlanet.z * f.east.z;
        sunOnPlate.y = sunOnPlanet.x * f.centre.x + sunOnPlanet.y * f.centre.y + sunOnPlanet.z * f.centre.z;
        sunOnPlate.z = -(sunOnPlanet.x * f.north.x + sunOnPlanet.y * f.north.y + sunOnPlanet.z * f.north.z);
        t.surface.setSun(sunOnPlate);
      }
    },
    bakeRelief(renderer, focus) {
      // The close window only where the view is; every plate its own map-wide level.
      const at = focus ? tileAt(focus.x, -focus.z) : null;
      // The plates nearest the view are lit first (terrainLightPool.ts).
      if (at) setLightFocus(at.face);
      for (const t of tiles) t.surface.bakeRelief(renderer, t === at && focus ? { x: focus.x - t.cx, z: focus.z + t.cy } : null);
    },
    // Asked every frame; passed to the 864 plates only when the weather
    // changed it (the loop alone was some 2% of a frame at the globe).
    setWaterLook(look) {
      const was = lastLook;
      if (was.waves === look.waves && was.foam === look.foam && was.current === look.current
        && was.windX === look.windX && was.windZ === look.windZ && was.windSpeed === look.windSpeed) return;
      Object.assign(was, look);
      for (const t of tiles) t.surface.setWaterLook(look);
    },
    setGullies(dabs: readonly GullyDab[], auto) {
      for (const t of tiles) {
        const mine: GullyDab[] = [];
        for (const d of dabs) {
          const at = placeOn(t, d.x, d.y, d.radius);
          if (at) mine.push({ ...d, x: at.x, y: at.y });
        }
        t.surface.setGullies(mine, auto);
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
