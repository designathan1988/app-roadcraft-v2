// Interpreta as regras de um estilo numa fachada (uma aresta da massa):
// escolhe a regra de cada pavimento, divide o comprimento e converte cada
// pedaço em abertura (janela, porta, vitrine) ou ornamento (pilastra, faixa,
// venezianas, embasamento, módulo glTF).
import type { FloorRule, StylePack, Tile } from './schema';
import { resolveSplit } from './split';

export interface StyledOpening {
  /** Centro ao longo da aresta (m). */
  s: number;
  y: number;
  w: number;
  h: number;
  kind: 'window' | 'door' | 'storefront' | 'void';
  arch: boolean;
  storey: number;
  balcony?: boolean;
  brise?: boolean;
  shutters?: boolean;
}

export interface Ornament {
  kind: 'pilaster' | 'band' | 'plinth' | 'module';
  /** Trecho ao longo da aresta e altura (relativa à base da massa). */
  s0: number;
  s1: number;
  y0: number;
  y1: number;
  depth: number;
  material: 'trim' | 'stone' | 'wall';
  module?: string;
  storey: number;
}

export interface StyledFacade {
  openings: StyledOpening[];
  ornaments: Ornament[];
}

export interface FloorBand {
  y0: number;
  h: number;
}

/** Regra do pavimento f (0 = térreo) num edifício de n pavimentos. */
export function floorRule(pack: StylePack, f: number, n: number): FloorRule {
  const fl = pack.floors;
  return fl.byIndex?.[String(f)] ?? (f === 0 && fl.ground ? fl.ground : f === n - 1 && n > 1 && fl.top ? fl.top : fl.typical);
}

export function styleFacade(pack: StylePack, len: number, floors: FloorBand[], visibleHeight: number, opts: { groundFloor?: boolean; pitchedRoof?: boolean } = {}): StyledFacade {
  const openings: StyledOpening[] = [],
    ornaments: Ornament[] = [];
  const total = floors.length;
  floors.forEach(({ y0, h }, f) => {
    if (y0 >= visibleHeight) return;
    // Massa que começa acima do chão (recuo, torre): sem regra de térreo.
    const idx = opts.groundFloor === false && f === 0 && total > 1 ? 1 : f;
    const rule = floorRule(pack, idx, total);
    const top = Math.min(y0 + h, visibleHeight);
    // Sob telhado inclinado o beiral faz o papel da cornija do último pavimento,
    // e os ornamentos salientes param antes dele.
    const underEave = opts.pitchedRoof && f === total - 1;
    const ornTop = underEave && top >= y0 + h - 1e-6 ? top - 0.3 : top;
    for (const p of resolveSplit(rule.split, len)) {
      const width = p.u1 - p.u0,
        mid = (p.u0 + p.u1) / 2;
      const t: Tile = p.tile;
      if (t.kind === 'wall') continue;
      if (t.kind === 'pilaster') {
        ornaments.push({ kind: 'pilaster', s0: mid - Math.min(t.width ?? width, width) / 2, s1: mid + Math.min(t.width ?? width, width) / 2, y0, y1: ornTop, depth: t.depth ?? 0.1, material: t.material ?? 'stone', storey: f });
        continue;
      }
      if (t.kind === 'module') {
        const mw = Math.min(t.width ?? width * 0.8, width - 0.1),
          mh = Math.min(t.height ?? 1.6, h - 0.4),
          sill = t.sill ?? Math.max(0.4, (h - mh) * 0.5);
        if (mw < 0.2 || mh < 0.2) continue;
        ornaments.push({ kind: 'module', s0: mid - mw / 2, s1: mid + mw / 2, y0: y0 + sill, y1: y0 + sill + mh, depth: 0, material: 'trim', module: t.module, storey: f });
        if (t.hole) openings.push({ s: mid, y: y0 + sill, w: mw, h: mh, kind: 'void', arch: false, storey: f });
        continue;
      }
      if (t.kind === 'storefront') {
        const w = width - 0.18;
        if (w < 0.4) continue;
        openings.push({ s: mid, y: y0 + 0.15, w, h: Math.max(0.5, h - 0.45), kind: 'storefront', arch: false, storey: f });
        continue;
      }
      if (t.kind === 'door') {
        const w = Math.min(t.width ?? 1.0, width - 0.15),
          dh = Math.min(t.height ?? 2.2, h - 0.35);
        if (w < 0.5 || dh < 1.6) continue;
        openings.push({ s: mid, y: y0 + 0.02, w, h: dh, kind: 'door', arch: !!t.arch, storey: f });
        continue;
      }
      // Janela.
      const w = Math.min(t.width ?? width - 0.2, width - 0.15);
      const wh = Math.min(t.height ?? 1.6, h - 0.35 - (t.sill ?? 0.3));
      const sill = t.sill ?? Math.max(0.45, (h - wh) * 0.52);
      if (w < 0.3 || wh < 0.4) continue;
      openings.push({ s: mid, y: y0 + sill, w, h: Math.min(wh, h - sill - 0.25), kind: 'window', arch: !!t.arch, storey: f, balcony: t.balcony, brise: t.brise, shutters: t.shutters });
    }
    if (rule.band && !underEave && y0 + h <= visibleHeight + 1e-6) ornaments.push({ kind: 'band', s0: 0, s1: len, y0: y0 + h - rule.band.height, y1: y0 + h, depth: rule.band.depth, material: rule.band.material ?? 'stone', storey: f });
  });
  if (pack.plinth && opts.groundFloor !== false) ornaments.push({ kind: 'plinth', s0: 0, s1: len, y0: 0, y1: Math.min(pack.plinth.height, visibleHeight), depth: 0.05, material: 'stone', storey: 0 });
  return { openings, ornaments };
}
