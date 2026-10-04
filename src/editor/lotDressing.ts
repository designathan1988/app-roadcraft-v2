import type { Rng } from '@core/rng';
import type { BlueprintBody } from '@world/buildings/blueprints';
import type { BuildingElement, ElementKind, LotSurface, Side } from '@world/buildings/types';
import { MAX_ELEMENTS } from '@world/buildings/types';
import { m } from '@world/units';
import type { ZoneDensity, ZoneUse } from '@world/zones';

/**
 * A grown building's whole property, as a lot is in a real street: not a box
 * against the pavement with leftover strips between it and its neighbours,
 * but a plot used to its edges.
 *
 * - A house stands back behind a front garden, walled or fenced, with a gate
 *   for people and a garage gate onto a driveway; its back yard has trees.
 * - Flats and towers stand in a walled compound: a pedestrian gate and a car
 *   gate, a courtyard with benches and trees, the residents' car park behind.
 * - Shops stand wall to wall along the street, stretched to their plot's full
 *   width, with tables and planters on the forecourt and a walled service
 *   yard behind.
 * - Industry stands back in a yard behind a tall fence with a truck gate and
 *   lorry bays.
 *
 * Everything is the building system's own parts (open lot blocks and
 * elements), so a grown property is edited, moved and demolished like any
 * other building.
 */

type Kind = 'house' | 'compound' | 'shop' | 'industry';

function kindOf(use: ZoneUse, density: ZoneDensity): Kind {
  if (use === 'industrial') return 'industry';
  if (use === 'commercial') return 'shop';
  return density === 'low' ? 'house' : 'compound';
}

interface Box { x0: number; y0: number; x1: number; y1: number }

const solidBox = (body: BlueprintBody): Box => {
  const v = body.volumes.filter((q) => !q.open);
  return {
    x0: Math.min(...v.map((q) => q.x)), y0: Math.min(...v.map((q) => q.y)),
    x1: Math.max(...v.map((q) => q.x + q.w)), y1: Math.max(...v.map((q) => q.y + q.d)),
  };
};

/**
 * Dresses `body` for a lot `lotW` wide and `lotD` deep (world units), the
 * street along local -y. Returns false if the model cannot stand on it.
 */
export function dressLot(body: BlueprintBody, use: ZoneUse, density: ZoneDensity, lotW: number, lotD: number, rng: Rng): boolean {
  const kind = kindOf(use, density);
  let box = solidBox(body);

  // Shops join their neighbours: the model is stretched to the plot's width.
  if (kind === 'shop') {
    const k = lotW / (box.x1 - box.x0);
    if (k > 1.001 && k < 2.2) {
      for (const v of body.volumes) { v.x = box.x0 + (v.x - box.x0) * k; v.w *= k; }
      for (const e of body.elements ?? []) e.x = box.x0 + (e.x - box.x0) * k;
      for (const c of (body.cores ?? []) as { x: number }[]) c.x = box.x0 + (c.x - box.x0) * k;
      box = solidBox(body);
    }
  }
  const depth = box.y1 - box.y0;
  const wanted = { house: m(5), compound: m(4), shop: m(3.5), industry: m(6) }[kind];
  const back = { house: m(5), compound: m(6), shop: m(4), industry: m(6) }[kind];
  if (depth > lotD) return false;
  // The setback the plot allows, leaving the back its share first.
  const setback = Math.max(0, Math.min(wanted, lotD - depth - Math.min(back, Math.max(0, lotD - depth - m(1)))));
  const midX = (box.x0 + box.x1) / 2;
  const L = midX - lotW / 2, R = midX + lotW / 2;
  const F = box.y0 - setback, B = F + lotD;

  let nextVolume = Math.max(0, ...body.volumes.map((v) => v.id ?? 0)) + 1;
  const ground = (x0: number, y0: number, x1: number, y1: number, open: LotSurface): void => {
    // A block is at least 2 m (`MIN_SIZE`); a narrower side passage is just
    // the ground between the building and its boundary wall.
    if (x1 - x0 < m(2) || y1 - y0 < m(2)) return;
    body.volumes.push({
      id: nextVolume++, x: x0, y: y0, w: x1 - x0, d: y1 - y0, base: 0,
      roof: 'flat', storeys: [{ facade: { fill: 'wall' } }], open,
    } as BlueprintBody['volumes'][number]);
  };
  const front: LotSurface = kind === 'house' ? 'grass' : kind === 'industry' ? 'gravel' : 'paving';
  const sides: LotSurface = kind === 'house' ? 'paving' : kind === 'industry' ? 'gravel' : 'paving';
  // A shop's back is what it is in a real street: a back garden or a car
  // park - never a walled slab of paving with nothing on it.
  const shopBack: 'garden' | 'parking' = rng.float() < 0.55 ? 'garden' : 'parking';
  const yard: LotSurface = kind === 'house' ? 'grass' : kind === 'industry' ? 'gravel'
    : kind === 'shop' && shopBack === 'garden' ? 'grass' : 'paving';
  ground(L, F, R, box.y0, front);
  ground(L, box.y0, box.x0, box.y1, sides);
  ground(box.x1, box.y0, R, box.y1, sides);
  ground(L, box.y1, R, B, yard);
  (body as { nextVolumeId?: number }).nextVolumeId = nextVolume;

  const elements: BuildingElement[] = (body.elements ??= []);
  let nextElement = Math.max(0, ...elements.map((e) => e.id)) + 1;
  const put = (kind: ElementKind, x: number, y: number, facing: Side, w: number, d: number, h: number): void => {
    if (elements.length >= MAX_ELEMENTS || w < m(0.1) || d < m(0.1)) return;
    elements.push({ id: nextElement++, kind, x, y, facing, w: Math.min(w, m(40)), d, z: 0, h });
  };
  /** A wall or fence along x at `y`, from `x0` to `x1`, with gaps [centre, width]. */
  const runX = (k: ElementKind, y: number, x0: number, x1: number, h: number, gaps: [number, number][] = []): void => {
    const cuts = gaps.map(([c, w]) => [c - w / 2, c + w / 2] as const).sort((p, q) => p[0] - q[0]);
    let from = x0;
    for (const [g0, g1] of [...cuts, [x1, x1] as const]) {
      const to = Math.min(g0, x1);
      if (to - from > m(0.3)) put(k, (from + to) / 2, y, 0, to - from, k === 'fence' ? m(0.12) : m(0.2), h);
      from = Math.max(from, g1);
    }
  };
  /** A wall or fence along y at `x`, from `y0` to `y1`. */
  const runY = (k: ElementKind, x: number, y0: number, y1: number, h: number): void => {
    if (y1 - y0 > m(0.3)) put(k, x, (y0 + y1) / 2, 1, y1 - y0, k === 'fence' ? m(0.12) : m(0.2), h);
  };
  const inset = m(0.15);

  switch (kind) {
    case 'house': {
      // Garage on the wider side gap if a car fits there, else in the front garden.
      const leftGap = box.x0 - L, rightGap = R - box.x1;
      const garageLeft = leftGap >= rightGap;
      const sideRoom = Math.max(leftGap, rightGap);
      const garageX = sideRoom >= m(3) ? (garageLeft ? (L + box.x0) / 2 : (box.x1 + R) / 2)
        : (garageLeft ? L + m(2) : R - m(2));
      const gateX = midX + (garageLeft ? m(1.5) : -m(1.5));
      const fenced = rng.float() < 0.35;
      runX(fenced ? 'fence' : 'wall', F + inset, L + inset, R - inset, fenced ? m(1.2) : m(1.3),
        [[gateX, m(1.2)], [garageX, m(3)]]);
      runY('wall', L + inset, F + inset, B - inset, m(2));
      runY('wall', R - inset, F + inset, B - inset, m(2));
      runX('wall', B - inset, L + inset, R - inset, m(2));
      // Driveway and the car's place; the path to the door.
      put('parking', garageX, sideRoom >= m(3) ? (box.y0 + Math.min(box.y1, box.y0 + m(5.5))) / 2 : (F + box.y0) / 2,
        0, m(2.6), Math.min(m(5), Math.max(m(2), sideRoom >= m(3) ? box.y1 - box.y0 : setback - m(0.4))), m(0.12));
      if (setback > m(1.5)) put('pavement', gateX, (F + box.y0) / 2, 0, m(1.2), setback - m(0.3), m(0.1));
      // Front garden and back yard.
      for (const x of [L + m(1.2), R - m(1.2)]) if (setback > m(2)) put(rng.float() < 0.5 ? 'flowers' : 'shrub', x, F + setback / 2, 0, m(1.2), m(1.2), m(0.6));
      if (B - box.y1 > m(4)) {
        put('tree', L + lotW * 0.3, (box.y1 + B) / 2, 0, m(3), m(3), m(5));
        if (lotW > m(12)) put('tree', L + lotW * 0.75, (box.y1 + B) / 2 + m(0.5), 0, m(3), m(3), m(5.5));
      }
      break;
    }
    case 'compound': {
      const carGate = R - m(3);
      runX('fence', F + inset, L + inset, R - inset, m(1.8), [[midX, m(1.6)], [carGate, m(4)]]);
      runY('wall', L + inset, F + inset, B - inset, m(2.2));
      runY('wall', R - inset, F + inset, B - inset, m(2.2));
      runX('wall', B - inset, L + inset, R - inset, m(2.2));
      if (setback > m(1.5)) put('pavement', midX, (F + box.y0) / 2, 0, m(1.6), setback - m(0.3), m(0.1));
      for (const x of [L + m(1.5), midX - m(3.5)]) if (setback > m(2.5)) put('tree', x, F + setback / 2, 0, m(2.5), m(2.5), m(4.5));
      // The residents' car park behind, in bays of 2.6 m.
      const yardD = B - box.y1;
      if (yardD > m(5.5)) {
        for (let x = L + m(1.6); x + m(2.6) < R - m(0.5) && elements.length < MAX_ELEMENTS - 4; x += m(2.8)) {
          put('parking', x + m(1.3), box.y1 + m(3), 0, m(2.5), m(5), m(0.12));
        }
        if (yardD > m(8)) put('bench', midX, B - m(1.2), 0, m(1.6), m(0.5), m(0.45));
      }
      break;
    }
    case 'shop': {
      // Tables on the forecourt: benches in pairs with planters between.
      if (setback > m(2)) {
        for (let x = L + m(1.5); x < R - m(1.5) && elements.length < MAX_ELEMENTS - 8; x += m(4)) {
          if (rng.float() < 0.6) {
            put('bench', x, F + setback * 0.35, 0, m(1.4), m(0.45), m(0.45));
            put('bench', x, F + setback * 0.75, 2, m(1.4), m(0.45), m(0.45));
          } else put('planter', x, F + setback * 0.5, 0, m(1), m(1), m(0.6));
        }
      }
      // Behind: a walled back garden, or a car park with its gate.
      const yardD = B - box.y1;
      if (yardD > m(1)) {
        runY('wall', L + inset, box.y1, B - inset, m(2));
        runY('wall', R - inset, box.y1, B - inset, m(2));
        if (shopBack === 'parking') {
          runX('wall', B - inset, L + inset, R - inset, m(2), [[midX, m(3.5)]]);
          if (yardD > m(6)) {
            for (let x = L + m(0.8); x + m(2.5) < R - m(0.6) && elements.length < MAX_ELEMENTS - 3; x += m(2.7)) {
              put('parking', x + m(1.25), box.y1 + m(3), 0, m(2.5), m(5), m(0.12));
            }
          }
        } else {
          runX('wall', B - inset, L + inset, R - inset, m(2));
          if (yardD > m(4)) {
            put('tree', L + lotW * 0.28, box.y1 + yardD * 0.6, 0, m(3), m(3), m(5));
            if (lotW > m(10)) put('tree', L + lotW * 0.75, box.y1 + yardD * 0.45, 0, m(3), m(3), m(4.5));
            put('bench', midX, box.y1 + m(1.5), 0, m(1.4), m(0.45), m(0.45));
            put(rng.float() < 0.5 ? 'flowers' : 'shrub', R - m(1.2), B - m(1.4), 0, m(1.2), m(1.2), m(0.6));
            put('shrub', L + m(1.2), B - m(1.4), 0, m(1.2), m(1.2), m(0.9));
          }
        }
      }
      break;
    }
    case 'industry': {
      const truckGate = midX + (rng.float() < 0.5 ? -1 : 1) * Math.min(lotW / 4, m(6));
      runX('fence', F + inset, L + inset, R - inset, m(2.2), [[truckGate, m(6)]]);
      runY('fence', L + inset, F + inset, B - inset, m(2.2));
      runY('fence', R - inset, F + inset, B - inset, m(2.2));
      runX('fence', B - inset, L + inset, R - inset, m(2.2));
      // Lorry bays in the yard behind, cars in front.
      if (B - box.y1 > m(10)) {
        for (let x = L + m(2.5); x + m(4) < R - m(1); x += m(5)) put('parking', x + m(2), box.y1 + m(5.5), 0, m(3.6), m(10), m(0.12));
      }
      if (setback > m(5)) {
        for (let x = L + m(2); x + m(2.6) < truckGate - m(3.5); x += m(2.8)) put('parking', x + m(1.3), F + setback / 2, 0, m(2.5), m(5), m(0.12));
      }
      break;
    }
  }
  return true;
}
