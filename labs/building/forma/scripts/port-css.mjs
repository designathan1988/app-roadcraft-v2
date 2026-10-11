// Converte o CSS do FORMA legado em CSS escopado para incorporação:
//  - todo seletor ganha o prefixo .forma-app (nada vaza para a página do jogo);
//  - :root, html e body viram o próprio .forma-app;
//  - @media (max-width) vira @container forma (o layout responde ao contêiner);
//  - elementos fixos na janela passam a ser absolutos dentro do contêiner.
// Saída: src/ui/legacy.css (base que styles.css importa e complementa).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, '../forma-construtor-3d-legacy.html'), 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];

const P = '.forma-app';
function scopeSelector(sel) {
  return sel
    .split(',')
    .map((s) => {
      s = s.trim();
      if (!s) return s;
      if (s === ':root' || s === 'html' || s === 'body') return P;
      if (s.startsWith(':root')) return P + s.slice(5);
      if (s === '*') return `${P}, ${P} *`;
      return `${P} ${s}`;
    })
    .join(',');
}

// Tokenização simples por chaves (o CSS legado não tem chaves em strings).
let out = '',
  i = 0;
function block(text, depth) {
  let res = '';
  while (i < text.length) {
    const open = text.indexOf('{', i),
      close = text.indexOf('}', i);
    if (close !== -1 && (open === -1 || close < open)) {
      i = close + 1;
      return res;
    }
    if (open === -1) break;
    const head = text.slice(i, open).trim();
    i = open + 1;
    if (head.startsWith('@media')) {
      const cond = head.replace(/^@media\s*/, '');
      const inner = block(text, depth + 1);
      res += `@container forma ${cond}{${inner}}\n`;
    } else if (head.startsWith('@')) {
      const inner = block(text, depth + 1);
      res += `${head}{${inner}}\n`;
    } else {
      const end = text.indexOf('}', i);
      const body = text.slice(i, end);
      i = end + 1;
      res += `${scopeSelector(head)}{${body}}\n`;
    }
  }
  return res;
}
out = block(css, 0);
out = out
  .replace(/(#toast\{)position:fixed/, '$1position:absolute')
  .replace(/(#modal-backdrop\{)position:fixed/, '$1position:absolute')
  .replace(/(#loading\{)position:fixed/, '$1position:absolute');

const header = '/* Gerado por scripts/port-css.mjs a partir do FORMA legado. Não editar à mão. */\n';
writeFileSync(resolve(root, 'src/ui/legacy.css'), header + out);
console.log('CSS escopado:', out.length, 'caracteres');
