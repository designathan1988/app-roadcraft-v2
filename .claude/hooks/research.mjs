#!/usr/bin/env node
/**
 * Research gate for Claude Code in this repository (CLAUDE.md, "Hooks").
 *
 * The player's rule: when an attempt did not solve the problem, the next step is
 * research on the internet, never another guess. This hook enforces it.
 *
 *   UserPromptSubmit  a message saying the result is still bad (ruim, defeito,
 *                     continua, não resolveu, pesquisa…) arms the gate and tells
 *                     Claude what it has to do.
 *   PostToolUse       WebSearch and WebFetch calls are counted while armed. The
 *                     gate opens after RESEARCH_SEARCHES searches and
 *                     RESEARCH_READS pages read (a search snippet is not reading).
 *   PreToolUse        while armed, edits to the code are denied: Edit, Write,
 *                     MultiEdit, NotebookEdit on files of the repository (but
 *                     `docs/`, `.claude/` and the Markdown files at the root),
 *                     and shell commands that write files
 *                     of the repository (sed -i, redirection, Set-Content, git
 *                     apply/restore, a node script that writes into it).
 *
 * State is one file per session in the system temp folder. Tests:
 * tests/tooling/researchHook.spec.ts.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESEARCH_SEARCHES = 1;
export const RESEARCH_READS = 2;

/** Words with which the player says an attempt failed, accents removed. */
const FAILED = new RegExp(
  [
    'ruim', 'pessim', 'horrivel', 'horroros', 'defeito', 'errad', 'quebrad', 'bugad', 'piorou',
    'nao (funciona|funcionou|resolveu|mudou|ficou|esta bom|ta bom|faz|fez|presta|serve)',
    'continua', 'mesmo jeito', 'mesma coisa', 'de novo', 'outra vez', 'nada mudou', 'nao mudou nada',
    'pesquis', 'internet', 'procura na',
    'porra', 'merda', 'caralho', 'puta', 'desgraca', 'inferno', 'cansad', 'bosta',
    "doesn'?t work", 'still broken', 'still wrong', 'search the (web|internet)',
  ].join('|'),
);

export const normalise = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function saysItFailed(prompt) {
  return FAILED.test(normalise(prompt ?? ''));
}

const stateFile = (session) => join(tmpdir(), `roadcraft-research-${String(session ?? 'none').replace(/[^\w-]/g, '_')}.json`);

export function readState(session) {
  try {
    return JSON.parse(readFileSync(stateFile(session), 'utf8'));
  } catch {
    return null;
  }
}

const writeState = (session, state) => writeFileSync(stateFile(session), JSON.stringify(state));
export const clearState = (session) => rmSync(stateFile(session), { force: true });

/** True when `file` is a file of the repository that the gate protects. */
export function isCode(file, root) {
  if (!file) return false;
  const path = isAbsolute(file) ? file : resolve(root, file);
  const rel = relative(root, path).replace(/\\/g, '/');
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  // Notes and instructions (docs/, .claude/, the Markdown files at the root) are not code.
  return !/^(docs|\.claude)\//.test(rel) && !/^[^/]+\.md$/i.test(rel);
}

/** True when a shell command writes files of the repository. */
export function writesCode(command, root) {
  const text = command ?? '';
  if (/\bsed\s+(-\w*i|--in-place)|\bperl\s+-\w*i|\b(Set-Content|Add-Content|Out-File|New-Item)\b|\bgit\s+(apply|restore|checkout\s+--|stash\s+pop)\b|\bpatch\s+-/i.test(text)) return true;
  if (/(^|[^>&\d])>{1,2}\s*["']?(\.\/)?(src|tests|scripts|public|index\.html)\b/.test(text)) return true;
  if (/\b(cp|mv|copy|move|Copy-Item|Move-Item)\b[^|;&]*\s["']?(\.\/)?(src|tests|scripts|public)\//i.test(text)) return true;
  // A node script that writes into the repository.
  for (const m of text.matchAll(/\bnode\s+["']?([^"'\s|;&]+\.(?:mjs|cjs|js))/g)) {
    const script = isAbsolute(m[1]) ? m[1] : resolve(root, m[1]);
    if (!existsSync(script)) continue;
    const body = readFileSync(script, 'utf8');
    if (/writeFile(Sync)?\s*\(|appendFile(Sync)?\s*\(/.test(body) && /(Road[\\/]+|['"`](\.\/)?)(src|tests|scripts|public)[\\/]/.test(body)) return true;
  }
  return false;
}

const GATE_TEXT =
  'PESQUISA OBRIGATORIA (hook de pesquisa, pedido do jogador): a tentativa anterior nao resolveu. ' +
  'Antes de qualquer edicao de codigo: (1) WebSearch e leia com WebFetch a documentacao oficial da tecnologia ' +
  'e como jogos/estudios/projetos maduros resolvem o mesmo problema (pelo menos ' +
  `${RESEARCH_SEARCHES} busca e ${RESEARCH_READS} paginas lidas); (2) diga ao jogador, em portugues, o que encontrou, com os links, ` +
  'a causa do defeito e a abordagem escolhida; (3) so entao edite. Edicoes de codigo ficam bloqueadas ate la.';

function output(json) {
  process.stdout.write(JSON.stringify(json));
}

export function handle(input, root) {
  const session = input.session_id;
  const event = input.hook_event_name;
  const state = readState(session);
  if (event === 'UserPromptSubmit') {
    if (!saysItFailed(input.prompt)) return null;
    // The rule is "an attempt that did not solve it": after research, only a
    // code edit made since is an attempt. A complaint with no new attempt in
    // between neither re-arms the gate nor throws away research under way.
    if (state && state.open && !state.editedSince) return null;
    if (!state || state.open) writeState(session, { armedAt: Date.now(), searches: 0, reads: 0 });
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: GATE_TEXT } };
  }
  if (!state) return null;
  if (event === 'PostToolUse') {
    if (state.open) return null;
    if (input.tool_name === 'WebSearch') state.searches += 1;
    else if (input.tool_name === 'WebFetch') state.reads += 1;
    else return null;
    if (state.searches >= RESEARCH_SEARCHES && state.reads >= RESEARCH_READS) writeState(session, { open: true, editedSince: false });
    else writeState(session, state);
    return null;
  }
  if (event === 'PreToolUse') {
    const tool = input.tool_name;
    const params = input.tool_input ?? {};
    const blocked = /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)
      ? isCode(params.file_path ?? params.notebook_path, root)
      : /^(Bash|PowerShell)$/.test(tool) && writesCode(params.command, root);
    if (!blocked) return null;
    if (state.open) {
      // An attempt after research: the next complaint re-arms the gate.
      if (!state.editedSince) writeState(session, { open: true, editedSince: true });
      return null;
    }
    const left = `faltam ${Math.max(0, RESEARCH_SEARCHES - state.searches)} busca(s) e ${Math.max(0, RESEARCH_READS - state.reads)} pagina(s) lida(s)`;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${GATE_TEXT} (${left}.)`,
      },
    };
  }
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(raw); } catch { return; }
    const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    const result = handle(input, root);
    if (result) output(result);
  });
}
