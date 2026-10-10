// Alinhar e distribuir volumes (no referencial do edifício) e edifícios (no
// mundo), pelas caixas envolventes. Sem three.
import type { Building3, Solid, Vec2 } from './schema';
import { oriented, sampleRing } from './plan';
import { toWorld, translateSolid } from './ops';

export type AlignOp = 'left' | 'centerX' | 'right' | 'front' | 'centerZ' | 'back' | 'base' | 'top' | 'distX' | 'distZ' | 'height';

interface Box {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

function boxOf(pts: Vec2[]): Box {
  const xs = pts.map((p) => p[0]),
    zs = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
}

const solidBox = (s: Solid): Box => boxOf(sampleRing(oriented(s.plan.outer, 1)).pts);

/** Deslocamentos [dx, dz] por item para alinhar/distribuir as caixas. O primeiro é a referência. */
export function alignDeltas(boxes: Box[], op: AlignOp): Vec2[] {
  const ref = boxes[0]!;
  if (op === 'distX' || op === 'distZ') {
    // Espaços iguais entre os itens, mantendo os das pontas.
    const ax = op === 'distX';
    const order = boxes.map((b, i) => ({ b, i })).sort((p, q) => (ax ? p.b.x0 - q.b.x0 : p.b.z0 - q.b.z0));
    const first = order[0]!.b,
      last = order[order.length - 1]!.b;
    const span = ax ? last.x1 - first.x0 : last.z1 - first.z0;
    const total = order.reduce((s, o) => s + (ax ? o.b.x1 - o.b.x0 : o.b.z1 - o.b.z0), 0);
    const gap = order.length > 1 ? (span - total) / (order.length - 1) : 0;
    const out: Vec2[] = boxes.map(() => [0, 0]);
    let cur = ax ? first.x0 : first.z0;
    for (const o of order) {
      const start = ax ? o.b.x0 : o.b.z0;
      out[o.i] = ax ? [cur - start, 0] : [0, cur - start];
      cur += (ax ? o.b.x1 - o.b.x0 : o.b.z1 - o.b.z0) + gap;
    }
    return out;
  }
  return boxes.map((b) => {
    switch (op) {
      case 'left':
        return [ref.x0 - b.x0, 0];
      case 'right':
        return [ref.x1 - b.x1, 0];
      case 'centerX':
        return [(ref.x0 + ref.x1) / 2 - (b.x0 + b.x1) / 2, 0];
      case 'front':
        return [0, ref.z0 - b.z0];
      case 'back':
        return [0, ref.z1 - b.z1];
      case 'centerZ':
        return [0, (ref.z0 + ref.z1) / 2 - (b.z0 + b.z1) / 2];
      default:
        return [0, 0];
    }
  });
}

/** Alinha volumes de um edifício (o primeiro da lista é a referência). */
export function alignSolids(solids: Solid[], op: AlignOp): void {
  if (solids.length < 2) return;
  const ref = solids[0]!;
  if (op === 'base') {
    for (const s of solids) s.base = ref.base;
    return;
  }
  if (op === 'top') {
    for (const s of solids) s.base = ref.base + ref.height - s.height;
    return;
  }
  if (op === 'height') {
    for (const s of solids) s.height = ref.base + ref.height - s.base;
    return;
  }
  const d = alignDeltas(solids.map(solidBox), op);
  solids.forEach((s, i) => translateSolid(s, d[i]![0], d[i]![1]));
}

/** Alinha edifícios no mundo pelas caixas das plantas. */
export function alignBuildings(bs: Building3[], op: AlignOp): void {
  if (bs.length < 2 || op === 'base' || op === 'top' || op === 'height') return;
  const boxes = bs.map((b) => boxOf(b.solids.filter((s) => s.op === 'add').flatMap((s) => sampleRing(oriented(s.plan.outer, 1)).pts.map((p) => toWorld(b, p)))));
  const d = alignDeltas(boxes, op);
  bs.forEach((b, i) => (b.position = [b.position[0] + d[i]![0], b.position[1] + d[i]![1]]));
}
