import { Rng } from '@core/rng';
import type { CatalogPage } from '@people/gen/catalog';
import { bodyFor } from '@people/gen/clothes';
import { HumanExtras, REGION, beardMask, faceAnchors, type ExtrasMeta } from '@people/gen/extras';
import { browStrands, hairStrands, lashStrands } from '@people/gen/hair';
import { coveredBy, fitRigid, makehumanBody, parseMakeHuman, pushOut, surfaceOf, tuckUnder, type MakeHumanMeta } from '@people/gen/makehuman';
import { randomName } from '@people/gen/names';
import { fitProxy, loadProxyItem } from '@people/body/proxy';
import mhBaseBin from '../public/models/people/base.bin?url';
import { isWhole } from '@people/wardrobe';
import type { GarmentParams } from '@people/gen/clothes';
import {
  ANCESTRIES, IRIS_COLOURS, completePerson, darker, randomHair, randomOutfit, randomPerson, resolvePerson, type PersonParams, type ResolvedPerson,
} from '@people/gen/person';
import { CreatorStage, loadBase } from '@render/people/generator/stage';
import { Creator } from '@ui/creator/creator';
import { applyTranslations, initLanguage } from '@ui/i18n';

/**
 * The person creator's page (`human-generator.html`): composition root.
 * One person at a time, edited as in The Sims' Create a Sim
 * (`ui/creator/creator.ts`), drawn by `render/people/generator/stage.ts` from
 * the Vitruvian base with the MHR's scan-learned shape
 * (`people/gen/person.ts` turns the settings into a body).
 */

const URLS = import.meta.glob('/public/models/humans/*/*.{json,bin,jpg}', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const urlOf = (base: string) => (file: string): string => {
  const url = URLS[`/public/models/humans/${base}/${file}`];
  if (!url) throw new Error(`missing human asset ${base}/${file}`);
  return url;
};

initLanguage();
applyTranslations();

const canvas = document.getElementById('view') as HTMLCanvasElement;
const stage = new CreatorStage(canvas);
const [b, ex, mh] = await Promise.all([
  loadBase('vitruvian', urlOf('vitruvian')),
  Promise.all([
    fetch(urlOf('vitruvian')('extras.json')).then((r) => r.json() as Promise<ExtrasMeta>),
    fetch(urlOf('vitruvian')('extras.bin')).then((r) => r.arrayBuffer()),
  ]).then(([meta, bin]) => new HumanExtras(meta, bin)),
  // MakeHuman's base mesh on ours: its hair and clothes fit our people (`people/gen/makehuman.ts`).
  Promise.all([
    fetch(urlOf('vitruvian')('makehuman.json')).then((r) => r.json() as Promise<MakeHumanMeta>),
    fetch(urlOf('vitruvian')('makehuman.bin')).then((r) => r.arrayBuffer()),
  ]).then(([meta, bin]) => parseMakeHuman(meta, bin)),
]);
// MakeHuman's own body at rest (decimetres): rigid items (shoes) are fitted there first.
const mhRest = new Float32Array(await (await fetch(mhBaseBin)).arrayBuffer(), 0, mh.positions.length);
document.getElementById('loading')?.remove();

// Per render vertex: lips, beard, scalp (the skin shader's make-up masks).
const masks = (() => {
  const beard = beardMask(ex, b.base);
  const out = new Float32Array(b.base.renderVertexCount * 3);
  for (let r = 0; r < b.base.renderVertexCount; r++) {
    const v = b.base.renderSource[r]!;
    out[r * 3] = ex.lips[v]! / 255; out[r * 3 + 1] = beard[v]! / 255; out[r * 3 + 2] = ex.scalp[v]! / 255;
  }
  return out;
})();
let first = true;

let seed = Date.now() % 100000;
const rng = (): Rng => new Rng(++seed * 7919);

// The last person resolved: drawing and the readout share one solve.
let last: { p: PersonParams; r: ResolvedPerson } | null = null;
const resolved = (p: PersonParams): ResolvedPerson => {
  if (last?.p !== p) last = { p, r: resolvePerson(b.base, p) };
  return last.r;
};

function randomPage(p: PersonParams, page: CatalogPage): PersonParams {
  const r = rng();
  switch (page.id) {
    case 'basics': {
      const q = randomPerson(b.base, r);
      return { ...p, sex: q.sex, years: q.years, heightCm: q.heightCm, bmi: q.bmi, muscle: q.muscle };
    }
    case 'build': return { ...p, body: p.body.map(() => r.normal(0, 0.8)) };
    case 'faceShape': return { ...p, head: p.head.map(() => r.normal(0, 0.7)) };
    case 'skin': {
      const ancestry = r.pick(ANCESTRIES);
      const q = randomPerson(b.base, r);
      return { ...p, ancestry, melanin: q.melanin, iris: r.weighted(IRIS_COLOURS) };
    }
    case 'hairStyle': case 'hairColour': case 'hairShape': return { ...p, hair: randomHair(r, p.sex < 0.5, p.years, p.melanin) };
    case 'top': case 'bottom': case 'shoes': {
      const o = randomOutfit(r, p.sex < 0.5);
      return { ...p, outfit: { ...p.outfit, [page.id]: o[page.id as 'top' | 'bottom' | 'shoes'] } };
    }
    case 'expression': return { ...p, expression: r.pick(['Smile_Lips_Closed', 'Happy', 'Thinking', 'Sad', 'Angry', 'Oops']), expressionAmount: r.range(0.5, 1) };
    default: {
      const detail = { ...p.detail };
      for (const name of page.morphs) {
        const m = b.base.morphs.get(name);
        if (m) detail[name] = m.min < 0 ? Math.max(-1, Math.min(1, r.normal(0, 0.35))) : r.bool(0.5) ? Math.min(1, Math.abs(r.normal(0, 0.35))) : 0;
      }
      return { ...p, detail };
    }
  }
}

/**
 * Draws a person. The body is redrawn when what shapes it changed; each worn
 * layer (hair, brows, lashes, clothes) when its own settings or, once the
 * slider is let go, the body under it changed - so a body slider moves only
 * the body while it is dragged.
 */
const SHAPE_KEYS = ['sex', 'years', 'heightCm', 'bmi', 'muscle', 'ancestry', 'detail', 'body', 'head', 'hands', 'expression', 'expressionAmount'] as const;
const sameBody = (a: PersonParams, c: PersonParams): boolean => SHAPE_KEYS.every((k) => a[k] === c[k]);
let shown: PersonParams | null = null;
let bodyVersion = 0;
let shaped: { shape: Float32Array; body: ReturnType<typeof bodyFor> | null; mh: Float32Array | null } | null = null;
const built: Record<string, { params: unknown; version: number }> = {};
const times: Record<string, number> = {};
/** The latest hair asked for: an older load that lands late is dropped. */
let hairTicket = 0;
let clothesTicket = 0;

/** A triangle list without the triangles two or three of whose corners are hidden. */
function hideFaces(index: Uint32Array, hidden: Uint8Array): Uint32Array {
  const out: number[] = [];
  for (let i = 0; i < index.length; i += 3) {
    if (hidden[index[i]!]! + hidden[index[i + 1]!]! + hidden[index[i + 2]!]! >= 2) continue;
    out.push(index[i]!, index[i + 1]!, index[i + 2]!);
  }
  return Uint32Array.from(out);
}

/** The base's skin neighbours, once. */
let skinRing: number[][] | null = null;
/** A vertex set kept only where every neighbour is in it, `passes` times. */
function erode(set: Uint8Array, passes: number): Uint8Array {
  if (!skinRing) {
    skinRing = Array.from({ length: b.base.vertexCount }, () => []);
    const t = bodyFor(b.base, ex, b.base.positions).skin;
    for (let i = 0; i < t.length; i += 3) {
      for (let k = 0; k < 3; k++) { const a = t[i + k]!, c = t[i + (k + 1) % 3]!; skinRing[a]!.push(c); skinRing[c]!.push(a); }
    }
  }
  let cur = set;
  for (let p = 0; p < passes; p++) {
    const next = new Uint8Array(cur.length);
    for (let v = 0; v < cur.length; v++) next[v] = cur[v] && skinRing[v]!.every((u) => cur[u]) ? 1 : 0;
    cur = next;
  }
  return cur;
}

/** Per base vertex, the nearest hm08 vertex (both at rest on our body): how a garment's delete_verts reach our skin. */
let nearestMh: Uint32Array | null = null;
function coveredSkin(deleted: ReadonlySet<number>): Float32Array {
  const out = new Float32Array(b.base.renderVertexCount);
  if (!deleted.size) return out;
  if (!nearestMh) {
    const C = 0.02, cells = new Map<number, number[]>();
    const key = (x: number, y: number, z: number): number => ((Math.floor(x / C) + 512) * 1024 + Math.floor(y / C) + 512) * 1024 + Math.floor(z / C) + 512;
    const P = mh.positions, n = P.length / 3;
    for (let v = 0; v < n; v++) {
      const k = key(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!);
      let l = cells.get(k);
      if (!l) cells.set(k, l = []);
      l.push(v);
    }
    const R = b.base.positions, m = R.length / 3;
    nearestMh = new Uint32Array(m);
    for (let v = 0; v < m; v++) {
      const x = R[v * 3]!, y = R[v * 3 + 1]!, z = R[v * 3 + 2]!;
      let best = -1, bd = Infinity;
      for (let r = 1; best < 0 && r <= 4; r++) {
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
          const l = cells.get(key(x + dx * C, y + dy * C, z + dz * C));
          if (!l) continue;
          for (const u of l) {
            const d = (P[u * 3]! - x) ** 2 + (P[u * 3 + 1]! - y) ** 2 + (P[u * 3 + 2]! - z) ** 2;
            if (d < bd) { bd = d; best = u; }
          }
        }
      }
      nearestMh[v] = Math.max(0, best);
    }
  }
  for (let r = 0; r < out.length; r++) out[r] = deleted.has(nearestMh[b.base.renderSource[r]!]!) ? 1 : 0;
  return out;
}

function draw(p: PersonParams, live: boolean): void {
  const t0 = performance.now();
  if (!shown || !shaped || !sameBody(shown, p)) {
    const r = resolved(p);
    const shape = b.base.shape(r.weights);
    const drawn = { shape, scale: r.scale, melanin: p.melanin, iris: p.iris };
    if (first) { stage.setPerson(b, drawn, masks); first = false; } else stage.updatePerson(b, drawn);
    shaped = { shape, body: null, mh: null };
    bodyVersion++;
  } else if (shown.melanin !== p.melanin || shown.iris !== p.iris) {
    stage.updatePerson(b, { shape: shaped.shape, scale: resolved(p).scale, melanin: p.melanin, iris: p.iris });
  }
  times['body'] = Math.round(performance.now() - t0);
  const current = shaped;
  // The body's normals, worked out only when a layer is rebuilt.
  const body = (): ReturnType<typeof bodyFor> => (current.body ??= bodyFor(b.base, ex, current.shape));
  const stale = (name: string, params: unknown): boolean => {
    const was = built[name];
    const changed = !was || was.params !== params;
    const moved = !was || was.version !== bodyVersion;
    if (changed || (moved && !live)) { built[name] = { params, version: bodyVersion }; return true; }
    return false;
  };
  const h = p.hair;
  let t = performance.now();
  if (stale('hair', h)) {
    // Hair is a MakeHuman hair mesh fitted to this body, as a game draws
    // hair (the strand groom it replaced is for close-ups, not a city).
    stage.strands('hair', hairStrands(ex, b.base, body(), { ...h, style: 'none' }, p.seed), { root: 0, tip: 0, shine: 0 });
    stage.follicles(null);
    const ticket = ++hairTicket;
    if (h.style === 'none') stage.proxies('hair', []);
    else {
      const mhBody = (current.mh ??= makehumanBody(mh, b.base, current.shape));
      void loadProxyItem(h.style).then((item) => {
        if (ticket !== hairTicket) return;
        const dm = fitProxy(item.pack, mhBody);
        const m = new Float32Array(dm.length);
        for (let i = 0; i < dm.length; i++) m[i] = dm[i]! * 0.1;
        stage.proxies('hair', [{ item, positions: m, tint: h.colour }]);
      }).catch(() => { if (ticket === hairTicket) stage.proxies('hair', []); });
    }
  }
  times['hair'] = Math.round(performance.now() - t); t = performance.now();
  if (stale('brows', p.brows)) stage.strands('brows', browStrands(ex, b.base, shaped.shape, p.brows, p.seed + 1), { root: p.brows.colour, tip: p.brows.colour, shine: 0.25, fadeThin: true });
  if (stale('lashes', p.lashes)) stage.strands('lashes', lashStrands(ex, b.base, shaped.shape, p.lashes, p.seed + 2), { root: p.lashes.colour, tip: p.lashes.colour, shine: 0.15 });
  times['face'] = Math.round(performance.now() - t); t = performance.now();
  if (stale('clothes', p.outfit) || stale('clothesSex', p.sex < 0.5)) {
    // Clothes are MakeHuman garments fitted to this body, as hair is.
    stage.clothes([]);
    const o = p.outfit;
    const worn = [o.top, o.top?.item && isWhole(o.top.item) ? null : o.bottom, o.shoes].filter((g): g is GarmentParams => !!g?.item);
    const ticket = ++clothesTicket;
    const mhBody = (current.mh ??= makehumanBody(mh, b.base, current.shape));
    const shape = current.shape;
    const bodyNow = body();
    void Promise.all(worn.map((g) => loadProxyItem(g.item!))).then((items) => {
      if (ticket !== clothesTicket) return;
      const hidden = new Set<number>(), shoeHidden = new Set<number>();
      let lift = 0, floor = Infinity;
      for (let i = 1; i < shape.length; i += 3) floor = Math.min(floor, shape[i]!);
      // Layers from the skin out: shoes (and their socks) under the trouser
      // legs - boots over them - then the bottom, then the top over the waistband (MakeHuman's own z_depth is the same 50 for
      // most items, so it cannot order them). Each is pushed out of the body
      // and of every layer under it.
      const boots = /boot/i.test(o.shoes?.item ?? '');
      const order = worn.map((g, k) => [g === o.shoes ? (boots ? 1.5 : 0) : g === o.bottom ? 1 : 2, k] as const).sort((x, y) => x[0] - y[0]).map(([, k]) => k);
      const covered = new Uint8Array(b.base.vertexCount);
      // Skin inside a shoe: hidden without a margin (a shoe hugs the foot to its rim).
      const inShoe = new Uint8Array(b.base.vertexCount);
      const under: { shape: Float32Array; normals: Float32Array; skin: Uint32Array }[] = [];
      const underShoe: boolean[] = [];
      const fitted: Float32Array[] = [];
      for (const k of order) {
        const item = items[k]!;
        const shoe = worn[k] === o.shoes;
        // A shoe is rigid: fitted on MakeHuman's own foot, then carried whole (fitRigid).
        // Only the foot of it: a boot's shaft follows the leg (rigid groups, not
        // a rigid boot), blended over the 5 cm above the ankle.
        const flex = fitProxy(item.pack, mhBody);
        const dm = flex.slice();
        let shaft: Float32Array | null = null;
        if (shoe) {
          const rigid = fitProxy(item.pack, mhRest);
          fitRigid(rigid, item.pack.refs, mhRest, mhBody);
          let lo = Infinity;
          const rest = fitProxy(item.pack, mhRest);
          for (let i = 1; i < rest.length; i += 3) lo = Math.min(lo, rest[i]!);
          shaft = new Float32Array(rest.length / 3);
          for (let v = 0; v < shaft.length; v++) {
            const t = Math.min(1, Math.max(0, (rest[v * 3 + 1]! - lo - 0.9) / 0.5));
            shaft[v] = t * t * (3 - 2 * t);
            for (let c = 0; c < 3; c++) dm[v * 3 + c] = rigid[v * 3 + c]! + (flex[v * 3 + c]! - rigid[v * 3 + c]!) * shaft[v]!;
          }
        }
        const m = new Float32Array(dm.length);
        for (let i = 0; i < dm.length; i++) m[i] = dm[i]! * 0.1;
        if (!shoe) pushOut(m, item.pack.index, bodyNow, 0.003);
        else {
          // The shaft kept off the leg; the rigid foot left as it is.
          const pushed = m.slice();
          pushOut(pushed, item.pack.index, bodyNow, 0.003);
          for (let v = 0; v < shaft!.length; v++) for (let c = 0; c < 3; c++) m[v * 3 + c] = m[v * 3 + c]! + (pushed[v * 3 + c]! - m[v * 3 + c]!) * shaft![v]!;
        }
        // Kept off the layers under it - not off a shoe: pushed against its
        // cut-up surface a hem goes to spikes; the shoe's covered part hides instead.
        under.forEach((inner, i) => { if (!underShoe[i]) pushOut(m, item.pack.index, inner, 0.003); });
        // Skin poking through (the item inside it, up to 3 cm) counts as covered too.
        coveredBy(m, item.pack.index, bodyNow, shoe ? inShoe : covered, 0.01, shoe ? 0.06 : 0.03);
        // A shoe's own delete_verts (the foot it encloses) hide without a margin.
        for (const v of item.pack.deleteVerts) (shoe ? shoeHidden : hidden).add(v);
        // Shoes stand the person on their soles.
        if (worn[k] === o.shoes) {
          let lo = Infinity;
          for (let i = 1; i < m.length; i += 3) lo = Math.min(lo, m[i]!);
          lift = Math.max(lift, floor - lo);
        }
        under.push(surfaceOf(m, item.pack.index, bodyNow));
        underShoe.push(shoe);
        fitted[k] = m;
      }
      // An inner garment's faces under an outer one are hidden too (Auto Hide
      // Mesh works on the clothes as on the body), a ring kept round openings.
      const keptIndex: Uint32Array[] = [];
      for (let i = 0; i < order.length; i++) {
        const k = order[i]!, item = items[k]!;
        const n = fitted[k]!.length / 3;
        const flags = new Uint8Array(n);
        const self = under[i]!;
        // Tucked under every layer over it, then kept off the skin.
        // (A rigid shoe keeps its shape: what goes over it is pushed out instead.)
        if (worn[k] !== o.shoes) {
          for (let j = i + 1; j < order.length; j++) tuckUnder(self, fitted[order[j]!]!);
          pushOut(fitted[k]!, item.pack.index, bodyNow, 0.0015);
        }
        // Clothes are coarser than skin: a wider reach. No ring of the inner
        // garment is kept (its own edge, a waistband, is what must not show);
        // the outer garment's open edge, which never hides, is the margin.
        for (let j = i + 1; j < order.length; j++) coveredBy(fitted[order[j]!]!, items[order[j]!]!.pack.index, self, flags, 0.015, 0.012);
        keptIndex[k] = hideFaces(item.pack.index, flags);
      }
      const layers = items.map((item, k) => ({ item, positions: fitted[k]!, tint: worn[k]!.dye ? worn[k]!.colour : null, index: keptIndex[k]! }));
      stage.proxies('clothes', layers);
      stage.setLift(lift);
      // Skin under the clothes, shrunk by two rings of vertices: only skin
      // well inside a garment is hidden, so none goes missing at a neckline,
      // a strap or a cuff (the garment is kept off the skin by pushOut).
      // As Character Creator's Auto Hide Mesh: a ring of skin kept round every
      // opening, and the head, neck, hands and wrists never hidden.
      const beneath = coveredSkin(hidden);
      const mask = new Uint8Array(b.base.vertexCount);
      for (let r = 0; r < beneath.length; r++) if (beneath[r]) mask[b.base.renderSource[r]!] = 1;
      for (let v = 0; v < mask.length; v++) {
        if (covered[v] === 1) mask[v] = 1;
        const r = ex.region[v]!;
        if (r === REGION.head || r === REGION.neck || r === REGION.hand || (r === REGION.forearm && ex.along[v]! > 220)) mask[v] = 0;
      }
      const kept = erode(mask, 2);
      const footInShoe = coveredSkin(shoeHidden);
      for (let r = 0; r < footInShoe.length; r++) if (footInShoe[r]) inShoe[b.base.renderSource[r]!] = 1;
      for (let v = 0; v < kept.length; v++) {
        const r = ex.region[v]!;
        const always = r !== REGION.head && r !== REGION.neck && r !== REGION.hand;
        // Inside a shoe, or poking through any garment: hidden, margin or not.
        if (always && (inShoe[v] || covered[v] === 2)) kept[v] = 1;
      }
      const hide = new Float32Array(b.base.renderVertexCount);
      for (let r = 0; r < hide.length; r++) hide[r] = kept[b.base.renderSource[r]!]!;
      stage.hideSkin(hide);
    }).catch(() => { if (ticket === clothesTicket) stage.proxies('clothes', []); });
  }
  times['clothes'] = Math.round(performance.now() - t);
  if (stale('accessories', p.accessories)) stage.accessories(p.accessories.glasses, p.accessories.earrings, faceAnchors(ex, b.base, current.shape));
  stage.skin({
    undertone: p.undertone, lipColour: p.makeup.lipColour, lipAmount: p.makeup.lipAmount,
    stubble: p.makeup.stubble, stubbleColour: h.grey > 0.6 ? 0x8a8680 : darker(h.colour, 0.9), follicleColour: h.grey > 0.6 ? 0x8a8680 : darker(h.colour, 0.85),
  });
  shown = p;
  times['total'] = Math.round(performance.now() - t0);
  (window as unknown as { __hgenTimes: object }).__hgenTimes = { ...times };
}

const creator = new Creator({
  base: b.base,
  random: () => {
    const r = rng();
    const p = randomPerson(b.base, r);
    return { ...p, name: randomName(r, p.sex) };
  },
  complete: (p) => completePerson(p, rng()),
  randomPage,
  show: (p, live = false) => draw(p, live),
  measure: (p) => resolved(p),
  focus: (f) => stage.frame(f),
  pick: (x, y) => stage.pick(x, y),
  portrait: () => stage.portrait(),
}, document.getElementById('creator')!, canvas);

// The person is framed between the category rail and the page panel.
const insets = (): void => {
  const rail = document.querySelector('.cr-rail')!.getBoundingClientRect();
  const page = document.querySelector('.cr-page')!.getBoundingClientRect();
  stage.setInsets(rail.right, window.innerWidth - page.left);
};
insets();
window.addEventListener('resize', insets);

// For probes: a known state without clicking.
(window as unknown as { __hgen: object }).__hgen = { creator, stage, open: (c: string, p?: string) => creator.open(c, p) };
