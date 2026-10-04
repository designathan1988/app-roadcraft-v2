// The PreToolUse guard (.claude/hooks/guard.mjs) is run here exactly as Claude
// Code runs it: a JSON hook input on stdin, a decision (or nothing) on stdout.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const GUARD = resolve(ROOT, '.claude/hooks/guard.mjs');

type Decision = 'allow' | 'deny' | 'ask';

function run(tool: string, toolInput: Record<string, unknown>): Decision {
  const out = execFileSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: tool, tool_input: toolInput, cwd: ROOT, hook_event_name: 'PreToolUse' }),
    encoding: 'utf8',
  });
  if (!out.trim()) return 'allow';
  return (JSON.parse(out) as { hookSpecificOutput: { permissionDecision: Decision } }).hookSpecificOutput.permissionDecision;
}

const bash = (command: string, background = false): Decision => run('Bash', { command, run_in_background: background });
const ps = (command: string): Decision => run('PowerShell', { command });

describe('Claude guard hook', () => {
  it('blocks shell heredocs and nothing that only looks like one', () => {
    expect(bash("cat > f.txt <<'EOF'\nhello\nEOF")).toBe('deny');
    expect(bash('git commit -m "$(cat <<EOF\nmsg\nEOF\n)"')).toBe('deny');
    expect(bash('node -e "console.log(1<<3)"')).toBe('allow');
    expect(bash('grep -c x <<< "$text"')).toBe('allow');
  });

  it('lets only master:main (or a named branch) go to app-roadcraft', () => {
    expect(bash('git push origin master:main')).toBe('allow');
    expect(bash('git push -u origin feature/zoning')).toBe('allow');
    expect(bash('git push')).toBe('deny');
    expect(bash('git push origin')).toBe('deny');
    expect(bash('git push origin master')).toBe('deny');
    expect(bash('git push origin HEAD:master')).toBe('deny');
    expect(bash('git push --force origin master:main')).toBe('deny');
    expect(bash('git push origin +master:main')).toBe('deny');
    expect(bash('git push origin :old-branch')).toBe('deny');
    expect(bash('git push https://github.com/someone/else.git master:main')).toBe('deny');
    expect(ps('git push origin master:main; git status')).toBe('allow');
    expect(bash('git status && git push origin master')).toBe('deny');
  });

  it('runs named specs with one worker and asks before the whole suite', () => {
    expect(bash('node scripts/test-light.mjs tests/world/elevation.spec.ts')).toBe('allow');
    expect(bash('npx vitest run tests/world/elevation.spec.ts --maxWorkers=1')).toBe('allow');
    expect(bash('npx vitest run tests/world/elevation.spec.ts')).toBe('deny');
    expect(bash('npx vitest run')).toBe('ask');
    expect(bash('node scripts/test-light.mjs')).toBe('ask');
    expect(bash('npm test')).toBe('ask');
    expect(bash('npm run check')).toBe('ask');
    expect(bash('node scripts/run-limited.mjs npm run verify:visual')).toBe('ask');
    expect(ps("$env:FUZZ_HUNT='1'; npx vitest run tests/fuzz/fuzz.spec.ts --maxWorkers=1")).toBe('ask');
    expect(bash('node scripts/test-light.mjs tests/world/elevation.spec.ts', true)).toBe('deny');
    expect(bash('npm run build')).toBe('allow');
    expect(bash('grep -n "npm run check" AGENTS.md')).toBe('allow');
    expect(bash('grep -rn vitest package.json')).toBe('allow');
  });

  it('asks before any visible browser and leaves headless photos alone', () => {
    expect(bash('node scripts/probe-shots.mjs')).toBe('allow');
    expect(bash('KEEP_OPEN=1 node scripts/crowd-shots.mjs')).toBe('ask');
    expect(ps('Start-Process chrome http://localhost:4180')).toBe('ask');
    expect(bash('grep -n "headless: false" scripts/*.mjs')).toBe('allow');
    expect(run('mcp__Claude_Browser__preview_start', { name: 'dev' })).toBe('ask');
    expect(run('mcp__Claude_Browser__navigate', { url: 'http://localhost:4180' })).toBe('ask');
    expect(run('mcp__claude-in-chrome__navigate', { url: 'http://localhost:4180' })).toBe('ask');
    expect(run('mcp__Claude_Browser__read_page', {})).toBe('allow');
  });

  it('stays out of the way of everything else', () => {
    expect(bash('git status --porcelain')).toBe('allow');
    expect(bash('npm run dev', true)).toBe('allow');
    expect(run('Read', { file_path: 'AGENTS.md' })).toBe('allow');
  });
});
