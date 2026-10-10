// Gera as peças de uma massa: lajes, paredes com vãos, caixilhos, vidros,
// sacadas, brises, cornijas, pilotis, platibanda, telhado e jardim.
// Portado do buildVolume do FORMA v1, generalizado para pavimentos de alturas
// diferentes. Com pavimentos iguais, reproduz o v1 peça por peça.
import type { Building, Mass, Opening, Storey, Vec2 } from '../core/schema';
import { edgeConfig, massExtent } from '../core/model';
import { bounds } from './polygon';
import { ringPoints, massEdges } from './ring';
import { clamp } from './polygon';
import { legacyRoofPositions } from './roofs/legacy';
import { skeletonRoof } from './roofs/skeleton-roof';
import { SkeletonError } from './roofs/skeleton';
import { stairFootprint } from './stairs';
import { buildInteriorParts } from './interior-parts';
import type { BoxPart, BuildingParts, MaterialKey, PartData, Vec3, WallHole } from './parts';
import { CAP, emptyParts } from './parts';

export interface MassPartsOptions {
  /** Corte horizontal: mostra só ~52% da altura, sem telhado. */
  section?: boolean;
  /** Corta tudo acima desta altura (y do edifício): mostra um pavimento por vez. */
  cutY?: number;
  /** Inclui paredes internas, portas e escadas (padrão: sim). */
  interiors?: boolean;
  /** Usa as coberturas do v1 (retângulo envolvente) em vez do esqueleto reto. */
  legacyRoofs?: boolean;
}

/** Abertura já resolvida no plano da aresta (u = centro / comprimento). */
export interface EdgeOpening {
  u: number;
  y: number;
  w: number;
  h: number;
  kind: 'window' | 'door' | 'void' | 'storefront';
  arch: boolean;
  storey: number;
  openingId?: string;
}

const STONE = '#c8c3b7';
const GLASS = '#34454c';
const GREEN = '#687e59';
const LINING: MaterialKey = { role: 'wall', color: '#ebe6dc', roughness: 0.9 };

const mat = (role: MaterialKey['role'], color: string, roughness = 0.8, extra: Partial<MaterialKey> = {}): MaterialKey => ({ role, color, roughness, ...extra });

/** Índice do pavimento que contém a altura relativa y. */
function storeyAt(rel: { y0: number; h: number }[], y: number): number {
  for (let i = rel.length - 1; i >= 0; i--) if (y >= rel[i]!.y0 - 1e-9) return i;
  return 0;
}

export function buildMassParts(b: Building, m: Mass, opts: MassPartsOptions = {}, out: BuildingParts = emptyParts()): BuildingParts {
  const { storeys, base, height } = massExtent(b, m);
  if (!storeys.length || height <= 0) return out;
  if (opts.cutY !== undefined && opts.cutY <= base + 0.05) return out;
  const cutHeight = opts.cutY !== undefined ? opts.cutY - base : Infinity;
  const section = !!opts.section || cutHeight < height;
  const rel = storeys.map((s: Storey) => ({ y0: s.elevation - base, h: s.height }));
  const visibleHeight = Math.min(opts.section ? Math.max(0.5, height * 0.52) : height, cutHeight);
  const outer = ringPoints(m.outer),
    holes = m.holes.map(ringPoints);
  const dataOf = (extra: Partial<PartData>): PartData => ({ buildingId: b.id, massId: m.id, part: 'wall', ...extra });

  const wallMat = mat('wall', m.finish.wall, 0.83, { doubleSide: true }),
    frameMat = mat('frame', m.finish.trim, 0.6),
    glassMat = mat('glass', GLASS, 0.22, { metalness: 0.28 }),
    stoneMat = mat('stone', STONE),
    roofMat = mat('roof', m.roof.color, 0.8, { doubleSide: true }),
    greenMat = mat('green', GREEN);

  const addBox = (material: MaterialKey, size: Vec3, pos: Vec3, angle = 0, data: PartData, roll = 0) => {
    if (size.some((n) => n < 0.001)) return;
    out.boxes.push({ mat: material, size, pos: [pos[0], pos[1] + base, pos[2]], angle, roll, data } satisfies BoxPart);
  };

  // Lajes em cada nível (base de cada pavimento e topo).
  const levels = [...rel.map((r) => r.y0), height];
  // No corte por pavimento, nenhuma laje a partir da altura do corte (deixa ver o interior).
  const slabLimit = opts.cutY !== undefined ? cutHeight - 0.05 : visibleHeight + 0.02;
  levels.forEach((y, f) => {
    if (y > slabLimit) return;
    // Laje do piso de um pavimento recebe o vão das escadas que chegam nele.
    const arriving = f > 0 && f < storeys.length ? b.stairs.filter((st) => st.toStorey === storeys[f]!.id) : [];
    const cut = arriving.flatMap((st) => stairFootprint(st.path, st.width).map((p) => p[0]!));
    out.slabs.push({ mat: stoneMat, y: base + y, thickness: 0.16, outer, holes: [...holes, ...cut], data: dataOf({ part: 'floor', storey: f }) });
  });

  const manualByEdge = new Map<string, Opening[]>();
  for (const o of b.openings) {
    if (o.host.kind !== 'massEdge' || o.host.massId !== m.id) continue;
    const list = manualByEdge.get(o.host.edgeId) ?? [];
    list.push(o);
    manualByEdge.set(o.host.edgeId, list);
  }
  const storeyIndex = new Map(storeys.map((s, i) => [s.id, i]));

  const lining = opts.interiors !== false && (opts.cutY !== undefined || b.stairs.length > 0 || b.storeys.some((st) => st.graph.walls.length > 0));
  const edges = massEdges(m);
  const ringLength = (e: (typeof edges)[number]) => (e.ring === 'outer' ? m.outer.vertices.length : m.holes[e.ring]!.vertices.length);
  for (const e of edges) {
    const a = e.a,
      bb = e.b,
      len = e.length;
    if (len < 0.1) continue;
    const isOuter = e.ring === 'outer';
    const tx = (bb[0] - a[0]) / len,
      tz = (bb[1] - a[1]) / len,
      nx = tz,
      nz = -tx,
      ang = -Math.atan2(tz, tx);
    const cfg = edgeConfig(m, m.edges[e.id]);
    const place = (s: number, y: number, outward = 0): Vec3 => [a[0] + tx * s + nx * outward, y, a[1] + tz * s + nz * outward];
    const tag = dataOf({ edgeId: e.id, part: 'wall' });

    // Aberturas: desenhadas (manual) ou ritmo automático.
    let openings: EdgeOpening[] = [];
    if (cfg.manual) {
      openings = (manualByEdge.get(e.id) ?? []).map((o) => {
        const si = storeyIndex.get(o.storeyId) ?? 0;
        return { u: o.offset / len, y: rel[si]!.y0 + o.sill, w: o.width, h: o.height, kind: o.fill.type, arch: !!o.fill.arch, storey: si, openingId: o.id };
      });
    } else if (cfg.pattern !== 'blank') {
      for (let f = 0; f < rel.length; f++) {
        const { y0, h: levelHeight } = rel[f]!;
        if (y0 >= visibleHeight) break;
        const storefront = cfg.pattern === 'storefront' && f === 0,
          curtain = cfg.pattern === 'curtain';
        const spacing = storefront || curtain ? Math.max(1.4, cfg.spacing * 0.8) : Math.max(1.1, cfg.spacing);
        const curved = ringLength(e) > 12 && len < 1.4;
        const count = curved ? (e.index % 2 === 0 ? 1 : 0) : Math.min(24, Math.max(0, Math.floor((len - 0.65) / spacing)));
        if (!count) continue;
        const pitch = (len - (curved ? 0.16 : 0.7)) / count,
          w = Math.min(storefront || curtain ? pitch - 0.18 : cfg.windowWidth, pitch - 0.15),
          h = Math.min(storefront || curtain ? levelHeight - 0.45 : cfg.windowHeight, levelHeight - 0.5),
          y = storefront ? 0.15 : y0 + Math.max(0.45, (levelHeight - h) * 0.52);
        for (let k = 0; k < count; k++)
          openings.push({
            u: ((curved ? 0.08 : 0.35) + pitch * (k + 0.5)) / len,
            y,
            w,
            h,
            kind: storefront ? 'storefront' : 'window',
            arch: cfg.pattern === 'arched',
            storey: f,
          });
      }
    }

    const firstHeight = rel[0]!.h;
    const wallBottom = m.flags.pilotis ? Math.min(firstHeight, visibleHeight) : 0;
    const faceWallMat = cfg.wall !== m.finish.wall ? mat('wall', cfg.wall, 0.83, { doubleSide: true }) : wallMat;
    const faceFrameMat = cfg.trim !== m.finish.trim ? mat('frame', cfg.trim, 0.6) : frameMat;
    const wallHoles: WallHole[] = [];
    const occupied: [number, number, number, number][] = [];
    for (const o of openings) {
      const w = Math.min(o.w, len - 0.18),
        h = Math.min(o.h, visibleHeight - 0.1),
        sx = clamp(o.u * len, w / 2 + 0.08, len - w / 2 - 0.08),
        y = clamp(o.y, 0.015, visibleHeight - h - 0.04);
      if (w < 0.25 || h < 0.3 || o.y >= visibleHeight - 0.15) continue;
      const left = sx - w / 2,
        right = sx + w / 2,
        top = y + h;
      if (y < wallBottom + 0.01) continue;
      if (occupied.some((r) => left < r[1] + 0.05 && right > r[0] - 0.05 && y < r[3] + 0.05 && top > r[2] - 0.05)) continue;
      occupied.push([left, right, y, top]);
      wallHoles.push({ center: sx, width: w, height: h, left, right, bottom: y, top, arch: o.arch });
      const data = dataOf({ edgeId: e.id, part: o.kind, storey: o.storey });
      if (o.kind !== 'void') addBox(glassMat, [w - 0.02, h - 0.02, 0.035], place(sx, y + h / 2, -0.045), ang, data);
      const frame = 0.065;
      addBox(faceFrameMat, [w + 0.14, frame, 0.14], place(sx, y, 0.01), ang, data);
      if (o.arch) {
        const radius = Math.min(w / 2, h * 0.48),
          spring = top - radius;
        addBox(faceFrameMat, [frame, h - radius, 0.14], place(left, y + (h - radius) / 2, 0.01), ang, data);
        addBox(faceFrameMat, [frame, h - radius, 0.14], place(right, y + (h - radius) / 2, 0.01), ang, data);
        for (let k = 0; k < 14; k++) {
          const t = ((k + 0.5) * Math.PI) / 14;
          addBox(faceFrameMat, [(radius * Math.PI) / 14 + 0.02, frame, 0.14], place(sx + radius * Math.cos(t), spring + radius * Math.sin(t), 0.01), ang, data, t + Math.PI / 2);
        }
      } else {
        addBox(faceFrameMat, [w + 0.14, frame, 0.14], place(sx, top, 0.01), ang, data);
        addBox(faceFrameMat, [frame, h, 0.14], place(left, y + h / 2, 0.01), ang, data);
        addBox(faceFrameMat, [frame, h, 0.14], place(right, y + h / 2, 0.01), ang, data);
      }
      if (w > 1.1 && o.kind !== 'void') addBox(faceFrameMat, [0.045, h, 0.095], place(sx, y + h / 2, 0.055), ang, data);
      if (cfg.balconies && y > firstHeight * 0.85 && isOuter) {
        const by = rel[storeyAt(rel, y)]!.y0 + 0.17;
        addBox(stoneMat, [Math.min(w + 0.5, len - 0.1), 0.15, 1.05], place(sx, by, 0.5), ang, tag);
        addBox(frameMat, [w + 0.4, 0.04, 0.035], place(sx, by + 0.95, 1), ang, tag);
        for (let k = 0; k < 5; k++) addBox(frameMat, [0.025, 0.94, 0.025], place(sx - w * 0.45 + k * w * 0.225, by + 0.48, 1), ang, tag);
        addBox(frameMat, [0.025, 0.95, 1.05], place(sx - w / 2 - 0.18, by + 0.48, 0.5), ang, tag);
        addBox(frameMat, [0.025, 0.95, 1.05], place(sx + w / 2 + 0.18, by + 0.48, 0.5), ang, tag);
      }
      if (cfg.brise) for (let k = 0; k < 4; k++) addBox(stoneMat, [w + 0.2, 0.06, 0.38], place(sx, top - 0.16 - k * 0.22, 0.24), ang, tag);
    }

    out.walls.push({
      mat: faceWallMat,
      origin: [a[0] + nx * 0.085, base, a[1] + nz * 0.085],
      angle: ang,
      length: len,
      bottom: wallBottom,
      top: visibleHeight,
      depth: 0.17,
      holes: wallHoles,
      data: tag,
    });
    // Reboco na face interna (só com interior ou corte; a fachada fica com a cor externa).
    if (lining && isOuter)
      out.walls.push({ mat: LINING, origin: [a[0] - nx * 0.085, base, a[1] - nz * 0.085], angle: ang, length: len, bottom: Math.max(wallBottom, rel[0]!.y0 + 0.16), top: visibleHeight, depth: 0.012, holes: wallHoles, data: { ...tag, part: 'lining' } });
    // Parede cortada pelo pavimento ativo: tampa escura no corte.
    if (opts.cutY !== undefined && visibleHeight < height - 1e-6) out.boxes.push({ mat: CAP, size: [len + 0.19, 0.03, 0.21], pos: [a[0] + tx * (len / 2) - nx * 0.006, base + visibleHeight + 0.016, a[1] + tz * (len / 2) - nz * 0.006], angle: ang, roll: 0, data: tag });

    if (m.flags.pilotis && isOuter) {
      addBox(stoneMat, [0.38, wallBottom, 0.38], place(0.15, wallBottom / 2, 0), 0, tag);
      if (len > 4)
        for (let k = 1; k < Math.ceil(len / 4); k++) addBox(stoneMat, [0.38, wallBottom, 0.38], place((len * k) / Math.ceil(len / 4), wallBottom / 2, 0), 0, tag);
    }
    if (m.flags.cornice)
      for (let f = 0; f < rel.length; f++) {
        const y = rel[f]!.y0 + rel[f]!.h;
        if (y > visibleHeight) continue;
        addBox(stoneMat, [len + 0.04, 0.12, 0.25], place(len / 2, y - 0.1, 0.08), ang, tag);
      }
    if (!section && m.roof.kind === 'flat') {
      addBox(wallMat, [len, 0.45, 0.19], place(len / 2, height + 0.31, 0), ang, tag);
      addBox(stoneMat, [len + 0.02, 0.08, 0.28], place(len / 2, height + 0.58, 0), ang, tag);
    }
  }

  if (!section) {
    const roofData = dataOf({ part: 'roof' });
    if (m.roof.kind === 'flat') {
      out.slabs.push({ mat: roofMat, y: base + height + 0.04, thickness: 0.16, outer, holes, data: roofData });
    } else {
      const k = m.roof.kind;
      let done = false;
      if (!opts.legacyRoofs && (k === 'hip' || k === 'gable' || k === 'mansard')) {
        try {
          // Topo da laje de cobertura: o telhado nasce na face externa das paredes.
          const g = skeletonRoof(outer, holes, { kind: k, top: base + height + 0.16, height: m.roof.height, overhang: m.roof.overhang ?? 0.4, direction: m.roof.direction });
          out.meshes.push({ mat: roofMat, positions: g.roof, data: roofData });
          if (g.gables.length) out.meshes.push({ mat: wallMat, positions: g.gables, data: dataOf({ part: 'gable' }) });
          done = true;
        } catch (e) {
          if (!(e instanceof SkeletonError)) throw e;
        }
      }
      if (!done) {
        const kind = k === 'shed' || k === 'dome' ? k : 'gable';
        out.meshes.push({ mat: roofMat, positions: legacyRoofPositions(kind, outer, holes, height, m.roof.height, base), data: roofData });
      }
    }
    if (m.flags.garden && m.roof.kind === 'flat') {
      const bd = bounds(outer),
        cx = (bd.minX + bd.maxX) / 2,
        cz = (bd.minZ + bd.maxZ) / 2;
      const candidates = outer.filter((_, i) => outer.length < 12 || i % 4 === 0);
      const gardenData = dataOf({ part: 'garden' });
      for (const p of candidates) {
        const dx = cx - p[0],
          dz = cz - p[1],
          k = Math.min(0.45, 0.95 / (Math.hypot(dx, dz) || 1)),
          x = p[0] + dx * k,
          z = p[1] + dz * k;
        addBox(stoneMat, [0.65, 0.35, 0.65], [x, height + 0.34, z], 0, gardenData);
        addBox(greenMat, [0.58, 0.3, 0.58], [x, height + 0.62, z], 0, gardenData);
      }
    }
  }
  return out;
}

export function buildBuildingParts(b: Building, opts: MassPartsOptions = {}): BuildingParts {
  const out = emptyParts();
  for (const m of b.masses) buildMassParts(b, m, opts, out);
  if (opts.interiors !== false) buildInteriorParts(b, opts.cutY !== undefined ? { cutY: opts.cutY } : {}, out);
  return out;
}

export type { Vec2 };
