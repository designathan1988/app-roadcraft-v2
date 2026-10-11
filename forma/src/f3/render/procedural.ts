// Materiais procedurais assados na GPU (como o Substance faz): cada acabamento
// é um gerador paramétrico (tijolo com medida real de tijolo e junta, aparelho
// e variação; reboco; pedra aparelhada; piso; tábuas; concreto com fôrma;
// telha capa-canal; ardósia; metal ondulado; chapa com junta; manta).
//
// Saída por (acabamento, parâmetros), 1024², periódica, com mipmaps:
//  - detalhe: R = luminância (média 0,8), G = máscara da 2ª cor (junta,
//    argamassa), B = rugosidade; a cor principal e a 2ª cor ficam no material,
//    então trocar só a cor não gera textura nova;
//  - normal: das diferenças centrais da altura (assada numa textura de rascunho).
// Padrões em grade com fileiras deslocadas (The Book of Shaders, cap. 9) e
// ruído fBm periódico com ganho 0,5 (Inigo Quilez, "fBm").
import * as THREE from 'three';

export interface ParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Valor inicial. */
  value: number;
  /** Opções nomeadas (valor inteiro). */
  options?: string[];
}

export interface ProcDef {
  kind: number;
  /** Relevo real (m) que a altura 0..1 representa (força da normal). */
  relief: number;
  params: ParamSpec[];
  /** Tamanho real (m) de uma repetição, múltiplo exato do padrão. */
  tile(p: Record<string, number>): [number, number];
  /** 2ª cor padrão (junta, argamassa). */
  color2: string;
}

const cells = (span: number, target: number) => Math.max(1, Math.round(target / span));

/** Geradores por acabamento. */
export const PROC: Record<string, ProcDef> = {
  plaster: {
    kind: 0,
    relief: 0.003,
    color2: '#ffffff',
    params: [
      { key: 'grain', label: 'Grão', min: 0, max: 1, step: 0.05, value: 0.55 },
      { key: 'vary', label: 'Manchas', min: 0, max: 1, step: 0.05, value: 0.3 },
    ],
    tile: () => [2, 2],
  },
  paint: {
    kind: 0,
    relief: 0.0012,
    color2: '#ffffff',
    params: [
      { key: 'grain', label: 'Grão', min: 0, max: 1, step: 0.05, value: 0.15 },
      { key: 'vary', label: 'Manchas', min: 0, max: 1, step: 0.05, value: 0.08 },
    ],
    tile: () => [2, 2],
  },
  brick: {
    kind: 2,
    relief: 0.012,
    color2: '#d8d2c6',
    params: [
      { key: 'len', label: 'Comprimento', min: 0.1, max: 0.6, step: 0.01, value: 0.24 },
      { key: 'h', label: 'Altura', min: 0.03, max: 0.3, step: 0.005, value: 0.065 },
      { key: 'joint', label: 'Junta', min: 0, max: 0.03, step: 0.001, value: 0.011 },
      { key: 'bond', label: 'Aparelho', min: 0, max: 2, step: 1, value: 0, options: ['Corrido', 'Empilhado', 'Inglês'] },
      { key: 'vary', label: 'Variação', min: 0, max: 1, step: 0.05, value: 0.5 },
    ],
    tile: (p) => {
      const cw = p.len! + p.joint!,
        ch = p.h! + p.joint!;
      return [cells(cw, 1.4) * cw, cells(2 * ch, 1.4) * 2 * ch];
    },
  },
  stone: {
    kind: 3,
    relief: 0.022,
    color2: '#c9c2b4',
    params: [
      { key: 'h', label: 'Fiada', min: 0.1, max: 1.2, step: 0.01, value: 0.4 },
      { key: 'len', label: 'Comprimento', min: 0.2, max: 2, step: 0.01, value: 0.75 },
      { key: 'joint', label: 'Junta', min: 0, max: 0.03, step: 0.001, value: 0.008 },
      { key: 'vary', label: 'Variação', min: 0, max: 1, step: 0.05, value: 0.6 },
    ],
    tile: (p) => [3, cells(p.h! + p.joint!, 2.4) * (p.h! + p.joint!)],
  },
  concrete: {
    kind: 6,
    relief: 0.004,
    color2: '#8f8b84',
    params: [
      { key: 'w', label: 'Placa largura', min: 0.5, max: 4, step: 0.05, value: 1.2 },
      { key: 'h', label: 'Placa altura', min: 0.3, max: 3, step: 0.05, value: 0.6 },
      { key: 'ties', label: 'Furos de fôrma', min: 0, max: 1, step: 1, value: 0, options: ['Sem', 'Com'] },
      { key: 'vary', label: 'Manchas', min: 0, max: 1, step: 0.05, value: 0.45 },
    ],
    tile: (p) => [cells(p.w!, 2.4) * p.w!, cells(p.h!, 2.4) * p.h!],
  },
  wood: {
    kind: 5,
    relief: 0.003,
    color2: '#2c241d',
    params: [
      { key: 'w', label: 'Tábua', min: 0.05, max: 0.4, step: 0.005, value: 0.12 },
      { key: 'len', label: 'Comprimento', min: 0.5, max: 4, step: 0.05, value: 2 },
      { key: 'joint', label: 'Junta', min: 0, max: 0.01, step: 0.0005, value: 0.003 },
      { key: 'vary', label: 'Variação', min: 0, max: 1, step: 0.05, value: 0.5 },
    ],
    tile: (p) => [cells(p.len!, 4) * p.len!, cells(p.w!, 1.2) * p.w!],
  },
  floor: {
    kind: 4,
    relief: 0.003,
    color2: '#9d968a',
    params: [
      { key: 'w', label: 'Peça', min: 0.1, max: 1.2, step: 0.01, value: 0.6 },
      { key: 'joint', label: 'Rejunte', min: 0, max: 0.015, step: 0.0005, value: 0.004 },
      { key: 'vary', label: 'Variação', min: 0, max: 1, step: 0.05, value: 0.25 },
      { key: 'gloss', label: 'Brilho', min: 0, max: 1, step: 0.05, value: 0.4 },
    ],
    tile: (p) => {
      const c = p.w! + p.joint!;
      return [cells(c, 2.4) * c, cells(c, 2.4) * c];
    },
  },
  paving: {
    kind: 2,
    relief: 0.01,
    color2: '#8a857c',
    params: [
      { key: 'len', label: 'Comprimento', min: 0.1, max: 0.6, step: 0.01, value: 0.2 },
      { key: 'h', label: 'Largura', min: 0.05, max: 0.4, step: 0.01, value: 0.1 },
      { key: 'joint', label: 'Junta', min: 0, max: 0.02, step: 0.001, value: 0.004 },
      { key: 'bond', label: 'Aparelho', min: 0, max: 2, step: 1, value: 0, options: ['Corrido', 'Empilhado', 'Inglês'] },
      { key: 'vary', label: 'Variação', min: 0, max: 1, step: 0.05, value: 0.4 },
    ],
    tile: (p) => {
      const cw = p.len! + p.joint!,
        ch = p.h! + p.joint!;
      return [cells(cw, 1.2) * cw, cells(2 * ch, 1.2) * 2 * ch];
    },
  },
  tile: {
    kind: 7,
    relief: 0.035,
    color2: '#5a3424',
    params: [
      { key: 'w', label: 'Largura da telha', min: 0.12, max: 0.4, step: 0.005, value: 0.21 },
      { key: 'h', label: 'Fiada', min: 0.15, max: 0.6, step: 0.005, value: 0.33 },
      { key: 'vary', label: 'Variação', min: 0, max: 1, step: 0.05, value: 0.55 },
    ],
    tile: (p) => [cells(p.w!, 1.6) * p.w!, cells(p.h!, 2) * p.h!],
  },
  slate: {
    kind: 8,
    relief: 0.012,
    color2: '#1c1f22',
    params: [
      { key: 'w', label: 'Largura', min: 0.15, max: 0.6, step: 0.01, value: 0.3 },
      { key: 'h', label: 'Fiada', min: 0.08, max: 0.4, step: 0.005, value: 0.17 },
      { key: 'vary', label: 'Variação', min: 0, max: 1, step: 0.05, value: 0.6 },
    ],
    tile: (p) => [cells(p.w!, 2) * p.w!, cells(2 * p.h!, 2) * 2 * p.h!],
  },
  metal: {
    kind: 9,
    relief: 0.018,
    color2: '#ffffff',
    params: [
      { key: 'pitch', label: 'Onda', min: 0.03, max: 0.3, step: 0.005, value: 0.076 },
      { key: 'vary', label: 'Manchas', min: 0, max: 1, step: 0.05, value: 0.3 },
    ],
    tile: (p) => [cells(p.pitch!, 1.5) * p.pitch!, 1.5],
  },
  panel: {
    kind: 10,
    relief: 0.02,
    color2: '#ffffff',
    params: [
      { key: 'w', label: 'Junta a cada', min: 0.2, max: 2, step: 0.05, value: 0.5 },
      { key: 'vary', label: 'Manchas', min: 0, max: 1, step: 0.05, value: 0.15 },
    ],
    tile: (p) => [cells(p.w!, 2) * p.w!, 2],
  },
  membrane: {
    kind: 11,
    relief: 0.002,
    color2: '#ffffff',
    params: [{ key: 'vary', label: 'Manchas', min: 0, max: 1, step: 0.05, value: 0.4 }],
    tile: () => [3, 3],
  },
};

export function procParams(finish: string, given?: Record<string, number>): Record<string, number> {
  const d = PROC[finish];
  const out: Record<string, number> = {};
  for (const p of d?.params ?? []) out[p.key] = Math.max(p.min, Math.min(p.max, given?.[p.key] ?? p.value));
  return out;
}

const VERT = `
in vec3 position;
out vec2 vUv;
uniform float uSpan; // fração da repetição mostrada (miniaturas)
void main() { vUv = (position.xy * 0.5 + 0.5) * uSpan; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const GEN = `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform int uKind;
uniform int uTarget; // 0 = detalhe (R luminância, G máscara, B rugosidade); 1 = altura
uniform vec2 uTile;  // metros por repetição
uniform vec4 uA;
uniform vec4 uB;
uniform float uSeed;

float h1(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031 + uSeed * 0.0137);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// Ruído de valor periódico: rede módulo 'per' (inteiro) → repete na textura.
float vn(vec2 x, vec2 per) {
  vec2 i = floor(x), f = fract(x);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = h1(mod(i, per)), b = h1(mod(i + vec2(1, 0), per));
  float c = h1(mod(i + vec2(0, 1), per)), d = h1(mod(i + vec2(1, 1), per));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// fBm periódico: frequência inicial em células por repetição.
float fbm(vec2 uv, vec2 f0) {
  float t = 0.0, a = 0.5;
  vec2 f = max(vec2(1.0), floor(f0 + 0.5));
  for (int i = 0; i < 5; i++) { t += a * vn(uv * f, f); f *= 2.0; a *= 0.5; }
  return t / 0.96875;
}
// Ruído na escala de 'k' células por metro.
float nm(vec2 uv, float k) { return fbm(uv, uTile * k); }

struct S { float lum; float mask; float rough; float h; };

S plaster(vec2 uv) {
  float n = nm(uv, 1.2), g = nm(uv, 90.0), g2 = nm(uv + 0.37, 260.0);
  S s;
  s.h = 0.5 + (g - 0.5) * uA.x + (g2 - 0.5) * uA.x * 0.6 + (n - 0.5) * 0.15;
  s.lum = 1.0 + (n - 0.5) * 0.18 * uA.y + (g - 0.5) * 0.05 * uA.x;
  s.mask = 0.0;
  s.rough = 0.86 + (g2 - 0.5) * 0.1;
  return s;
}

// Tijolo e pavers: L, H, junta, aparelho (uA), variação (uB.x).
S brick(vec2 uv) {
  vec2 pos = uv * uTile;
  float L = uA.x, H = uA.y, j = uA.z; int bond = int(uA.w + 0.5);
  float ch = H + j;
  float row = floor(pos.y / ch);
  bool odd = mod(row, 2.0) > 0.5;
  float cw = (bond == 2 && odd) ? (L + j) * 0.5 : L + j;
  float off = bond == 0 ? (odd ? 0.5 * cw : 0.0) : (bond == 2 && odd ? 0.25 * (L + j) : 0.0);
  float x = pos.x + off;
  float col = floor(x / cw);
  vec2 loc = vec2(x - col * cw, pos.y - row * ch);
  float e = min(min(loc.x - j * 0.5, cw - j * 0.5 - loc.x), min(loc.y - j * 0.5, ch - j * 0.5 - loc.y));
  float cols = floor(uTile.x / cw + 0.5), rows = floor(uTile.y / ch + 0.5);
  vec2 id = vec2(mod(col, cols), mod(row, rows));
  float r = h1(id + 7.0), r2 = h1(id + 19.0);
  float surf = nm(uv, 40.0), fine = nm(uv + 0.5, 160.0);
  float inside = smoothstep(-0.0006, 0.0006, e);
  S s;
  float bl = (1.0 + (r - 0.5) * 0.55 * uB.x) * (1.0 - r2 * r2 * 0.25 * uB.x) * (0.95 + 0.1 * surf) * (0.9 + 0.1 * smoothstep(0.0, 0.006, e));
  float ml = 0.9 + 0.12 * fine;
  s.lum = mix(ml * 0.88, bl, inside);
  s.mask = 1.0 - inside;
  s.rough = mix(0.95, 0.78 + 0.1 * fine, inside);
  s.h = mix(0.25 + 0.08 * fine, 0.72 + 0.18 * smoothstep(0.0, 0.004, e) + 0.08 * (surf - 0.5), inside);
  return s;
}

// Pedra aparelhada: fiada H, comprimento médio L, junta j (uA), variação (uB.x).
S stone(vec2 uv) {
  vec2 pos = uv * uTile;
  float H = uA.x, Lm = uA.y, j = uA.z;
  float ch = H + j;
  float rows = floor(uTile.y / ch + 0.5);
  float row = floor(pos.y / ch);
  float rid = mod(row, rows);
  float n = max(1.0, floor(uTile.x / (Lm * (0.75 + 0.5 * h1(vec2(rid, 3.0)))) + 0.5));
  float cw = uTile.x / n;
  float x = pos.x + h1(vec2(rid, 9.0)) * cw;
  float col = floor(x / cw);
  vec2 loc = vec2(x - col * cw, pos.y - row * ch);
  float e = min(min(loc.x - j * 0.5, cw - j * 0.5 - loc.x), min(loc.y - j * 0.5, ch - j * 0.5 - loc.y));
  vec2 id = vec2(mod(col, n), rid);
  float r = h1(id + 5.0);
  float mott = nm(uv + r, 6.0), chip = nm(uv, 50.0);
  float inside = smoothstep(-0.0008, 0.0008, e);
  S s;
  float sl = (1.0 + (r - 0.5) * 0.4 * uB.x) * (0.88 + 0.24 * mott) * (0.92 + 0.08 * smoothstep(0.0, 0.015, e));
  s.lum = mix(0.82, sl, inside);
  s.mask = 1.0 - inside;
  s.rough = mix(0.95, 0.82 + 0.12 * chip, inside);
  s.h = mix(0.2, 0.62 + 0.25 * smoothstep(0.0, 0.02, e) + 0.18 * (chip - 0.5) + 0.1 * (mott - 0.5), inside);
  return s;
}

// Piso: peça w, rejunte j, variação, brilho (uA).
S floorTile(vec2 uv) {
  vec2 pos = uv * uTile;
  float c = uA.x + uA.y, j = uA.y;
  vec2 cell = floor(pos / c);
  vec2 loc = pos - cell * c;
  float e = min(min(loc.x - j * 0.5, c - j * 0.5 - loc.x), min(loc.y - j * 0.5, c - j * 0.5 - loc.y));
  vec2 n = floor(uTile / c + 0.5);
  float r = h1(mod(cell, n) + 3.0);
  float m = nm(uv + r, 5.0);
  float inside = smoothstep(-0.0004, 0.0004, e);
  S s;
  s.lum = mix(0.8, (1.0 + (r - 0.5) * 0.3 * uA.z) * (0.94 + 0.12 * m), inside);
  s.mask = 1.0 - inside;
  s.rough = mix(0.95, mix(0.7, 0.18, uA.w), inside);
  s.h = mix(0.3, 0.75 + 0.15 * smoothstep(0.0, 0.002, e), inside);
  return s;
}

// Tábuas: largura w, comprimento, junta (uA), variação (uB.x).
S wood(vec2 uv) {
  vec2 pos = uv * uTile;
  float W = uA.x, Lb = uA.y, j = uA.z;
  float rows = floor(uTile.y / W + 0.5);
  float row = floor(pos.y / W);
  float rid = mod(row, rows);
  float x = pos.x + h1(vec2(rid, 1.0)) * Lb;
  float col = floor(x / Lb);
  vec2 loc = vec2(x - col * Lb, pos.y - row * W);
  float e = min(min(loc.x - j * 0.5, Lb - j * 0.5 - loc.x), min(loc.y - j * 0.5, W - j * 0.5 - loc.y));
  float cols = floor(uTile.x / Lb + 0.5);
  float r = h1(vec2(mod(col, cols), rid) + 11.0);
  // Veio: ruído esticado ao longo da tábua, deslocado por tábua.
  float g = fbm(uv + vec2(r * 3.0, r), vec2(uTile.x * 1.5, uTile.y * 40.0));
  float rings = sin((g * 12.0 + loc.y * 40.0) * 3.14159) * 0.5 + 0.5;
  float inside = smoothstep(-0.0003, 0.0003, e);
  S s;
  s.lum = mix(0.5, (1.0 + (r - 0.5) * 0.45 * uB.x) * (0.78 + 0.3 * g + 0.12 * rings), inside);
  s.mask = 1.0 - inside;
  s.rough = mix(0.9, 0.55 + 0.15 * g, inside);
  s.h = mix(0.2, 0.7 + 0.1 * rings, inside);
  return s;
}

// Concreto aparente: placas w×h, furos, manchas (uA).
S concrete(vec2 uv) {
  vec2 pos = uv * uTile;
  vec2 c = uA.xy;
  vec2 cell = floor(pos / c);
  vec2 loc = pos - cell * c;
  float e = min(min(loc.x, c.x - loc.x), min(loc.y, c.y - loc.y));
  float seam = 1.0 - smoothstep(0.0, 0.003, e);
  float hole = 0.0;
  if (uA.z > 0.5) {
    vec2 q = vec2(c.x * 0.2, c.y * 0.25);
    vec2 d = min(abs(loc - q), abs(loc - vec2(c.x - q.x, q.y)));
    vec2 d2 = min(abs(loc - vec2(q.x, c.y - q.y)), abs(loc - vec2(c.x - q.x, c.y - q.y)));
    hole = 1.0 - smoothstep(0.008, 0.012, min(length(d), length(d2)));
  }
  float m = nm(uv, 1.5), f = nm(uv + 0.3, 60.0);
  vec2 n = floor(uTile / c + 0.5);
  float r = h1(mod(cell, n) + 2.0);
  S s;
  s.lum = (1.0 + (m - 0.5) * 0.35 * uA.w + (r - 0.5) * 0.08) * (0.96 + 0.06 * f) * (1.0 - 0.25 * seam) * (1.0 - 0.45 * hole);
  s.mask = 0.0;
  s.rough = 0.8 + 0.12 * f;
  s.h = 0.6 + 0.08 * (f - 0.5) - 0.3 * seam - 0.4 * hole;
  return s;
}

// Telha capa-canal: largura w, fiada h, variação (uA).
S clay(vec2 uv) {
  vec2 pos = uv * uTile;
  float W = uA.x, H = uA.y;
  float row = floor(pos.y / H), col = floor(pos.x / W);
  vec2 loc = vec2(pos.x / W - col, pos.y / H - row);
  vec2 n = floor(uTile / vec2(W, H) + 0.5);
  float r = h1(mod(vec2(col, row), n) + 4.0);
  float barrel = sin(loc.x * 3.14159);
  float m = nm(uv + r, 8.0), f = nm(uv, 70.0);
  // A telha de cima cobre a de baixo: borda inferior grossa, sombra logo abaixo.
  float lip = smoothstep(0.0, 0.06, loc.y);
  float shade = 0.55 + 0.45 * smoothstep(0.0, 0.25, loc.y);
  S s;
  s.lum = (1.0 + (r - 0.5) * 0.5 * uA.z) * (0.85 + 0.25 * m) * (0.75 + 0.25 * barrel) * shade;
  s.mask = (1.0 - barrel) * 0.35 * (1.0 - lip);
  s.rough = 0.7 + 0.15 * f;
  s.h = 0.35 * barrel + 0.55 * (1.0 - loc.y) * lip + 0.05 * f;
  return s;
}

// Ardósia: largura w, fiada h (uA), variação (uA.z); fiadas alternadas.
S slate(vec2 uv) {
  vec2 pos = uv * uTile;
  float W = uA.x, H = uA.y;
  float row = floor(pos.y / H);
  float x = pos.x + (mod(row, 2.0) > 0.5 ? W * 0.5 : 0.0);
  float col = floor(x / W);
  vec2 loc = vec2(x / W - col, pos.y / H - row);
  vec2 n = floor(uTile / vec2(W, H) + 0.5);
  float r = h1(mod(vec2(col, row), n) + 6.0);
  float gap = 1.0 - smoothstep(0.0, 0.02, min(loc.x, 1.0 - loc.x));
  float m = nm(uv + r, 12.0), f = nm(uv, 90.0);
  S s;
  s.lum = (1.0 + (r - 0.5) * 0.5 * uA.z) * (0.85 + 0.25 * m) * (0.7 + 0.3 * smoothstep(0.0, 0.2, loc.y)) * (1.0 - 0.6 * gap);
  s.mask = gap;
  s.rough = 0.55 + 0.25 * f;
  s.h = 0.4 + 0.5 * (1.0 - loc.y) - 0.3 * gap + 0.05 * f;
  return s;
}

S corrugated(vec2 uv) {
  vec2 pos = uv * uTile;
  float w = sin(pos.x / uA.x * 6.28318);
  float m = nm(uv, 2.0), st = fbm(uv, vec2(uTile.x * 0.5, uTile.y * 30.0));
  S s;
  s.lum = (1.0 + (m - 0.5) * 0.3 * uA.y) * (0.95 + 0.08 * st) * (0.92 + 0.08 * w);
  s.mask = 0.0;
  s.rough = 0.42 + 0.15 * st;
  s.h = 0.5 + 0.5 * w;
  return s;
}

S seamPanel(vec2 uv) {
  vec2 pos = uv * uTile;
  float x = mod(pos.x, uA.x);
  float d = min(x, uA.x - x);
  float rib = 1.0 - smoothstep(0.008, 0.02, d);
  float m = nm(uv, 2.0);
  S s;
  s.lum = (1.0 + (m - 0.5) * 0.25 * uA.y) * (0.95 + 0.08 * rib);
  s.mask = 0.0;
  s.rough = 0.4;
  s.h = 0.3 + 0.7 * rib;
  return s;
}

S membrane(vec2 uv) {
  float m = nm(uv, 0.8), g = nm(uv, 200.0);
  S s;
  s.lum = (1.0 + (m - 0.5) * 0.3 * uA.x) * (0.92 + 0.16 * g);
  s.mask = 0.0;
  s.rough = 0.92;
  s.h = 0.5 + 0.4 * (g - 0.5);
  return s;
}

void main() {
  vec2 uv = vUv;
  S s;
  if (uKind == 0) s = plaster(uv);
  else if (uKind == 2) s = brick(uv);
  else if (uKind == 3) s = stone(uv);
  else if (uKind == 4) s = floorTile(uv);
  else if (uKind == 5) s = wood(uv);
  else if (uKind == 6) s = concrete(uv);
  else if (uKind == 7) s = clay(uv);
  else if (uKind == 8) s = slate(uv);
  else if (uKind == 9) s = corrugated(uv);
  else if (uKind == 10) s = seamPanel(uv);
  else s = membrane(uv);
  if (uTarget == 0) outColor = vec4(clamp(s.lum * 0.8, 0.0, 1.0), clamp(s.mask, 0.0, 1.0), clamp(s.rough, 0.04, 1.0), 1.0);
  else outColor = vec4(clamp(s.h, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

const NORMAL = `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uH;
uniform vec2 uStrength; // relevo / (2 × metros por texel), por eixo
void main() {
  ivec2 sz = textureSize(uH, 0);
  ivec2 p = ivec2(vUv * vec2(sz));
  float l = texelFetch(uH, ivec2((p.x - 1 + sz.x) % sz.x, p.y), 0).r;
  float r = texelFetch(uH, ivec2((p.x + 1) % sz.x, p.y), 0).r;
  float d = texelFetch(uH, ivec2(p.x, (p.y - 1 + sz.y) % sz.y), 0).r;
  float u = texelFetch(uH, ivec2(p.x, (p.y + 1) % sz.y), 0).r;
  vec3 n = normalize(vec3(-(r - l) * uStrength.x, -(u - d) * uStrength.y, 1.0));
  outColor = vec4(n * 0.5 + 0.5, 1.0);
}
`;

export interface ProcTextures {
  detail: THREE.Texture;
  normal: THREE.Texture;
  tile: [number, number];
  def: ProcDef;
}

const SIZE = 1024;

let renderer: THREE.WebGLRenderer | null = null;
let anisotropy = 8;
const cache = new Map<string, { rtD: THREE.WebGLRenderTarget; rtN: THREE.WebGLRenderTarget; tex: ProcTextures; baked: boolean; params: Record<string, number>; finish: string }>();
const pending: string[] = [];
const listeners = new Set<() => void>();

let scene: THREE.Scene, cam: THREE.OrthographicCamera, quad: THREE.Mesh, gen: THREE.RawShaderMaterial, nrm: THREE.RawShaderMaterial, rtH: THREE.WebGLRenderTarget | null = null;

function setup(): void {
  if (scene) return;
  scene = new THREE.Scene();
  cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  gen = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: GEN,
    uniforms: { uSpan: { value: 1 }, uKind: { value: 0 }, uTarget: { value: 0 }, uTile: { value: new THREE.Vector2() }, uA: { value: new THREE.Vector4() }, uB: { value: new THREE.Vector4() }, uSeed: { value: 0 } },
    depthTest: false,
    depthWrite: false,
  });
  nrm = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: NORMAL, uniforms: { uSpan: { value: 1 }, uH: { value: null }, uStrength: { value: new THREE.Vector2() } }, depthTest: false, depthWrite: false });
  quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), gen);
  quad.frustumCulled = false;
  scene.add(quad);
}

/** Avisa quando um material termina de ser assado (a vista redesenha). */
export function onProcBaked(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** O renderizador da vista assa as texturas (fila processada em seguida). */
export function setProcRenderer(r: THREE.WebGLRenderer, aniso: number): void {
  renderer = r;
  anisotropy = aniso;
  flush();
}

/** Uniformes do gerador para um acabamento com parâmetros. */
function uniformsFor(finish: string, p: Record<string, number>): { kind: number; a: number[]; b: number[] } {
  const d = PROC[finish]!;
  const v = (k: string) => p[k] ?? 0;
  switch (d.kind) {
    case 0:
      return { kind: 0, a: [v('grain'), v('vary'), 0, 0], b: [0, 0, 0, 0] };
    case 2:
      return { kind: 2, a: [v('len'), v('h'), v('joint'), v('bond')], b: [v('vary'), 0, 0, 0] };
    case 3:
      return { kind: 3, a: [v('h'), v('len'), v('joint'), 0], b: [v('vary'), 0, 0, 0] };
    case 4:
      return { kind: 4, a: [v('w'), v('joint'), v('vary'), v('gloss')], b: [0, 0, 0, 0] };
    case 5:
      return { kind: 5, a: [v('w'), v('len'), v('joint'), 0], b: [v('vary'), 0, 0, 0] };
    case 6:
      return { kind: 6, a: [v('w'), v('h'), v('ties'), v('vary')], b: [0, 0, 0, 0] };
    case 7:
      return { kind: 7, a: [v('w'), v('h'), v('vary'), 0], b: [0, 0, 0, 0] };
    case 8:
      return { kind: 8, a: [v('w'), v('h'), v('vary'), 0], b: [0, 0, 0, 0] };
    case 9:
      return { kind: 9, a: [v('pitch'), v('vary'), 0, 0], b: [0, 0, 0, 0] };
    case 10:
      return { kind: 10, a: [v('w'), v('vary'), 0, 0], b: [0, 0, 0, 0] };
    default:
      return { kind: 11, a: [v('vary'), 0, 0, 0], b: [0, 0, 0, 0] };
  }
}

function makeRT(): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(SIZE, SIZE, { depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, colorSpace: THREE.NoColorSpace });
  rt.texture.anisotropy = anisotropy;
  return rt;
}

function bake(key: string): void {
  const c = cache.get(key);
  if (!c || c.baked || !renderer) return;
  setup();
  const r = renderer;
  const prev = r.getRenderTarget();
  const prevClear = r.autoClear;
  r.autoClear = false;
  const u = uniformsFor(c.finish, c.params);
  const [tw, th] = c.tex.tile;
  gen.uniforms.uKind!.value = u.kind;
  gen.uniforms.uTile!.value.set(tw, th);
  gen.uniforms.uA!.value.fromArray(u.a);
  gen.uniforms.uB!.value.fromArray(u.b);
  gen.uniforms.uSeed!.value = 1;
  quad.material = gen;
  gen.uniforms.uTarget!.value = 0;
  r.setRenderTarget(c.rtD);
  r.render(scene, cam);
  rtH ??= new THREE.WebGLRenderTarget(SIZE, SIZE, { depthBuffer: false, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, colorSpace: THREE.NoColorSpace });
  gen.uniforms.uTarget!.value = 1;
  r.setRenderTarget(rtH);
  r.render(scene, cam);
  quad.material = nrm;
  nrm.uniforms.uH!.value = rtH.texture;
  nrm.uniforms.uStrength!.value.set(c.tex.def.relief / (2 * (tw / SIZE)), c.tex.def.relief / (2 * (th / SIZE)));
  r.setRenderTarget(c.rtN);
  r.render(scene, cam);
  r.setRenderTarget(prev);
  r.autoClear = prevClear;
  c.baked = true;
}

/** Assa já o que estiver na fila (miniaturas precisam das texturas prontas). */
export function flushProc(): void {
  flush();
}

function flush(): void {
  if (!renderer || !pending.length) return;
  while (pending.length) bake(pending.shift()!);
  for (const fn of listeners) fn();
}

export function procKey(finish: string, params?: Record<string, number>): string {
  const p = procParams(finish, params);
  return `${finish}|${Object.keys(p)
    .sort()
    .map((k) => `${k}=${p[k]!.toFixed(4)}`)
    .join(',')}`;
}

/** Texturas de um acabamento procedural (assadas assim que houver renderizador). */
export function procFor(finish: string, params?: Record<string, number>): ProcTextures | null {
  const def = PROC[finish];
  if (!def || typeof document === 'undefined') return null;
  const key = procKey(finish, params);
  let c = cache.get(key);
  if (!c) {
    const p = procParams(finish, params);
    const tile = def.tile(p);
    const rtD = makeRT(),
      rtN = makeRT();
    for (const t of [rtD.texture, rtN.texture]) t.repeat.set(1 / tile[0], 1 / tile[1]);
    c = { rtD, rtN, tex: { detail: rtD.texture, normal: rtN.texture, tile, def }, baked: false, params: p, finish };
    cache.set(key, c);
    pending.push(key);
    // Assa já se houver renderizador (fora do quadro atual).
    if (renderer) queueMicrotask(flush);
  }
  return c.tex;
}

/** Miniatura 2D (cor × detalhe, com relevo) para a biblioteca de materiais. */
export function procThumb(finish: string, params: Record<string, number> | undefined, color: string, color2: string, px = 96): string | null {
  const t = procFor(finish, params);
  if (!t || !renderer) return null;
  flush();
  const c = cache.get(procKey(finish, params))!;
  // Lê a textura de detalhe reduzida: assa de novo num alvo pequeno.
  setup();
  const r = renderer;
  const small = new THREE.WebGLRenderTarget(px, px, { depthBuffer: false, colorSpace: THREE.NoColorSpace });
  const u = uniformsFor(finish, c.params);
  // A miniatura mostra ~1,2 m de material (escala parecida com a da vista).
  const span = Math.min(1, 1.2 / Math.max(c.tex.tile[0], c.tex.tile[1]));
  gen.uniforms.uKind!.value = u.kind;
  gen.uniforms.uTile!.value.set(c.tex.tile[0], c.tex.tile[1]);
  gen.uniforms.uA!.value.fromArray(u.a);
  gen.uniforms.uB!.value.fromArray(u.b);
  gen.uniforms.uTarget!.value = 0;
  quad.material = gen;
  gen.uniforms.uSpan!.value = span;
  const prev = r.getRenderTarget();
  r.setRenderTarget(small);
  r.render(scene, cam);
  const buf = new Uint8Array(px * px * 4);
  r.readRenderTargetPixels(small, 0, 0, px, px, buf);
  r.setRenderTarget(prev);
  gen.uniforms.uSpan!.value = 1;
  small.dispose();
  const a = new THREE.Color(color),
    b = new THREE.Color(color2);
  const cv = document.createElement('canvas');
  cv.width = cv.height = px;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(px, px);
  for (let y = 0; y < px; y++)
    for (let x = 0; x < px; x++) {
      const i = ((px - 1 - y) * px + x) * 4,
        o = (y * px + x) * 4;
      const lum = buf[i]! / 255 / 0.8,
        m = buf[i + 1]! / 255;
      const lin = (ch: 'r' | 'g' | 'b') => (a[ch] * (1 - m) + b[ch] * m) * lum;
      const enc = (v: number) => Math.round(255 * Math.max(0, Math.min(1, v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)));
      img.data[o] = enc(lin('r'));
      img.data[o + 1] = enc(lin('g'));
      img.data[o + 2] = enc(lin('b'));
      img.data[o + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return cv.toDataURL();
}

export function disposeProc(): void {
  for (const c of cache.values()) {
    c.rtD.dispose();
    c.rtN.dispose();
  }
  cache.clear();
  rtH?.dispose();
  rtH = null;
}
