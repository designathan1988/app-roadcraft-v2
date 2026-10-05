// The research gate (.claude/hooks/research.mjs) is run here exactly as Claude
// Code runs it: a JSON hook input on stdin, a decision (or nothing) on stdout.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const HOOK = resolve(ROOT, '.claude/hooks/research.mjs');
const SESSION = `spec-${process.pid}`;

function run(input: Record<string, unknown>): string {
  return execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: SESSION, cwd: ROOT, ...input }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
  });
}

const prompt = (text: string): string => run({ hook_event_name: 'UserPromptSubmit', prompt: text });
const tool = (name: string, toolInput: Record<string, unknown>): 'allow' | 'deny' => {
  const out = run({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: toolInput });
  return out.trim() ? 'deny' : 'allow';
};
const researched = (name: 'WebSearch' | 'WebFetch'): string => run({ hook_event_name: 'PostToolUse', tool_name: name, tool_input: {} });

describe('research gate hook', () => {
  afterEach(() => {
    // Opens the gate for the next case: one search and two pages read.
    researched('WebSearch');
    researched('WebFetch');
    researched('WebFetch');
  });

  it('leaves edits alone until the player says an attempt failed', () => {
    expect(prompt('abra o jogo para eu ver')).toBe('');
    expect(tool('Edit', { file_path: resolve(ROOT, 'src/render/planet.ts') })).toBe('allow');
  });

  it('blocks code edits after a complaint, until searched and read', () => {
    expect(prompt('PELA ULTIMA VEZ, ESTÁ RUIM')).toContain('PESQUISA OBRIGATORIA');
    expect(tool('Edit', { file_path: resolve(ROOT, 'src/render/planet.ts') })).toBe('deny');
    expect(tool('Write', { file_path: 'tests/x.spec.ts' })).toBe('deny');
    expect(tool('Bash', { command: "sed -i 's/a/b/' src/main.ts" })).toBe('deny');
    expect(tool('PowerShell', { command: 'Set-Content src/a.ts "x"' })).toBe('deny');
    expect(tool('Bash', { command: 'echo x > src/a.ts' })).toBe('deny');
    // Notes, the hooks themselves and reading are not code edits.
    expect(tool('Edit', { file_path: resolve(ROOT, 'docs/STATUS.md') })).toBe('allow');
    expect(tool('Bash', { command: 'git status && grep -n planet src/render/renderer.ts' })).toBe('allow');
    expect(tool('Bash', { command: 'npx tsc --noEmit 2>&1 | head' })).toBe('allow');
    researched('WebSearch');
    researched('WebFetch');
    expect(tool('Edit', { file_path: 'src/render/planet.ts' })).toBe('deny');
    researched('WebFetch');
    expect(tool('Edit', { file_path: 'src/render/planet.ts' })).toBe('allow');
  });

  it('hears the complaint without accents and in other words', () => {
    expect(prompt('nao resolveu, continua do mesmo jeito')).toContain('PESQUISA');
    expect(prompt('pesquisa na internet como faz')).toContain('PESQUISA');
  });
});
