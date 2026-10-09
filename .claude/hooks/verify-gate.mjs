#!/usr/bin/env node
// Trava de verificação no jogo para o Claude Code (o jogador, 2026-10-09).
// Chamado pelos hooks de .claude/settings.json com um modo:
//   turn  (UserPromptSubmit)                 guarda o estado do código do jogo no início do pedido
//   look  (PostToolUse do navegador)         registra o estado visto numa captura de tela
//   stop  (Stop)                             barra a resposta se o código mudou e ninguém olhou
// O "estado" é a lista de arquivos de src/ e index.html com tamanho e data: pega
// edição por Edit, Write, sed, merge ou checkout, sem depender de qual ferramenta mudou.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mode = process.argv[2];

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {
  input = {};
}

const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const GAME_ROOTS = ['src', 'index.html'];
const ESCAPE = /SEM VERIFICA[ÇC][ÃA]O VISUAL:/i;

function statePath() {
  const id = String(input.session_id || 'sem-sessao').replace(/[^\w-]/g, '_');
  return path.join(os.tmpdir(), `roadcraft-verify-${id}.json`);
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}

function save(state) {
  try {
    fs.writeFileSync(statePath(), JSON.stringify(state));
  } catch {
    // sem estado gravado, o próximo pedido recomeça do zero
  }
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

// path relativo -> "tamanho:data"; e a data mais nova
function snapshot() {
  const files = {};
  let newest = 0;
  const walk = (abs, rel) => {
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs)) walk(path.join(abs, name), `${rel}/${name}`);
      return;
    }
    if (rel.toLowerCase().endsWith('.md')) return; // documentação não muda o jogo
    files[rel] = `${st.size}:${Math.round(st.mtimeMs)}`;
    if (st.mtimeMs > newest) newest = st.mtimeMs;
  };
  for (const root of GAME_ROOTS) walk(path.join(projectDir, root), root);
  const hash = crypto
    .createHash('sha1')
    .update(JSON.stringify(Object.keys(files).sort().map((k) => [k, files[k]])))
    .digest('hex');
  return { files, newest, hash };
}

// porta -> pasta do build de produção, lida de .claude/launch.json (configurações "preview")
function previewDists() {
  const map = {};
  try {
    const launch = JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'launch.json'), 'utf8'));
    for (const c of launch.configurations || []) {
      const args = c.runtimeArgs || [];
      const i = args.indexOf('--outDir');
      if (args.includes('preview') && i >= 0) map[String(c.port)] = { name: c.name, dir: args[i + 1] };
    }
  } catch {
    // sem launch.json, nenhuma captura é tratada como build de produção
  }
  return map;
}

function distFor(target) {
  if (!target) return null;
  for (const [port, d] of Object.entries(previewDists())) {
    if (target === d.name || new RegExp(`:${port}(\\b|/|$)`).test(target)) return d.dir;
  }
  return null;
}

function isScreenshot(tool, ti) {
  if (/__browser_batch$/.test(tool)) {
    return (ti.actions || []).some(
      (a) => a && a.name === 'computer' && ['screenshot', 'zoom'].includes(a.input && a.input.action),
    );
  }
  if (/__computer$/.test(tool)) return ['screenshot', 'zoom'].includes(ti.action);
  return false;
}

// ---------------------------------------------------------------------------

if (mode === 'turn') {
  const state = load();
  const snap = snapshot();
  state.baseline = snap.hash;
  state.baselineFiles = snap.files;
  save(state);
  process.stdout.write(
    'Regra do projeto: se o código do jogo mudar neste pedido, abra o jogo no navegador do app ' +
      '(painel visível), use a mudança como o jogador e tire uma captura antes de responder. ' +
      'A hook de Stop confere.\n',
  );
  process.exit(0);
}

if (mode === 'look') {
  const tool = String(input.tool_name || '');
  const ti = input.tool_input || {};
  const state = load();

  if (/__navigate$/.test(tool) && ti.url && !/^(back|forward)$/i.test(ti.url)) state.target = String(ti.url);
  if (/__preview_start$/.test(tool)) state.target = String(ti.url || ti.name || '');

  if (isScreenshot(tool, ti)) {
    const snap = snapshot();
    const dist = distFor(state.target);
    let stale = false;
    if (dist) {
      try {
        stale = fs.statSync(path.join(dist, 'index.html')).mtimeMs < snap.newest;
      } catch {
        stale = true;
      }
    }
    if (stale) {
      save(state);
      out({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext:
            `Esta captura NÃO conta como verificação: o build de produção em ${dist} é mais velho que o ` +
            'código de src/. Refaça o build (docs/.heavy-lock) e olhe de novo.',
        },
      });
    }
    state.looked = snap.hash;
  }
  save(state);
  process.exit(0);
}

if (mode === 'stop') {
  const state = load();
  const snap = snapshot();
  if (!state.baseline || snap.hash === state.baseline || snap.hash === state.looked) process.exit(0);
  if (ESCAPE.test(String(input.last_assistant_message || ''))) process.exit(0);

  const before = state.baselineFiles || {};
  const changed = Object.keys({ ...before, ...snap.files })
    .filter((k) => before[k] !== snap.files[k])
    .slice(0, 12);
  out({
    decision: 'block',
    reason:
      `O código do jogo mudou neste pedido (${changed.join(', ')}) e o estado atual não foi visto no ` +
      'jogo. Antes de responder: abra o jogo no navegador do app com o painel visível (build de produção ' +
      'roadcraft-play refeito, ou roadcraft-dev), use a mudança como o jogador, com a câmera baixa e perto ' +
      'onde um defeito apareceria, tire a captura e confira o que ela mostra. Se a mudança não tem nada ' +
      'visível no jogo, ou se você para para perguntar algo ao jogador, escreva na resposta a linha ' +
      '"SEM VERIFICAÇÃO VISUAL: <motivo>". Nunca diga que algo funciona sem ter olhado.',
  });
}

process.exit(0);
