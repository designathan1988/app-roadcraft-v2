#!/usr/bin/env node
/**
 * PreToolUse guard for Claude Code in this repository (CLAUDE.md, "Hooks").
 *
 * Claude Code runs it before every Bash and PowerShell command and before the
 * browser tools that open a window. It reads the hook input (JSON) on stdin and
 * prints a decision only when one of the rules below applies; otherwise it
 * prints nothing and the normal permission flow decides.
 *
 *   deny  shell heredocs (Bash), force pushes, branch deletion on the remote,
 *         pushes to any remote but app-roadcraft or to the stale remote master,
 *         tests and probes in the background, vitest on named specs with more
 *         than one worker.
 *   ask   the whole suite (npm test / check / verify / screens, vitest with no
 *         spec), a fuzz hunt, a visible browser, the in-app browser pane and
 *         Claude in Chrome.
 *
 * The rules come from AGENTS.md section 2 and CLAUDE.md. Tests:
 * tests/tooling/claudeGuard.spec.ts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE_REMOTE = /github\.com[/:]designathan1988\/app-roadcraft(\.git)?\/?$/i;
const BROWSER_TOOL =
  /^mcp__(Claude_Browser__(preview_start|navigate|tabs_create)|claude-in-chrome__(navigate|tabs_create_mcp))$/;
const PUSH_HELP = 'Publish with: git push origin master:main (AGENTS.md section 2).';
const BROWSER_HELP = 'The player approves each time (CLAUDE.md, Photos and browsers).';

/** Splits a command line into words, keeping quoted parts together. */
export function words(text) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Splits a shell line into simple commands at ; && || | and new lines. */
export function segments(command) {
  return command.split(/\r?\n|&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
}

const name = (w) => basename(w).toLowerCase().replace(/\.(exe|cmd|ps1|mjs|js)$/, '');

/**
 * The words of the program a simple command runs: environment assignments,
 * PowerShell's call operator and the scripts/run-limited.mjs wrapper are skipped.
 */
export function program(seg) {
  let w = words(seg);
  for (;;) {
    while (w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]) || w[0] === '&' || /^\$env:/i.test(w[0]))) w = w.slice(1);
    if (w.length > 1 && name(w[0]) === 'node' && name(w[1]) === 'run-limited') { w = w.slice(2); continue; }
    return w;
  }
}

/** The arguments after `git [global options] push`, or null. */
function pushArgs(seg) {
  const w = program(seg);
  if (!w.length || name(w[0]) !== 'git') return null;
  let j = 1;
  let dir = null;
  while (j < w.length && w[j].startsWith('-')) {
    if (w[j] === '-C') { dir = w[j + 1]; j += 2; } else if (w[j] === '-c') j += 2; else j += 1;
  }
  return w[j] === 'push' ? { args: w.slice(j + 1), dir } : null;
}

function remoteUrl(remote, dir) {
  if (/[:/@]/.test(remote)) return remote;
  try {
    return execFileSync('git', ['remote', 'get-url', remote], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Why a `git push` must not run, or null when it may. */
export function judgePush(args, dir, urlOf = remoteUrl) {
  const flags = args.filter((a) => a.startsWith('-'));
  const plain = args.filter((a) => !a.startsWith('-'));
  if (flags.some((f) => /^--force|^--mirror$|^--delete$|^--prune$|^-[a-zA-Z]*[fd]/.test(f))) {
    return 'Force pushes, mirror pushes and branch deletion on the remote are not allowed. ' + PUSH_HELP;
  }
  const [remote, ...refspecs] = plain;
  if (!remote) return 'Name the remote and the branch: the default upstream of master is the stale remote master. ' + PUSH_HELP;
  const url = urlOf(remote, dir);
  if (!url || !LIVE_REMOTE.test(url)) return `Remote "${remote}" is not github.com/designathan1988/app-roadcraft. ` + PUSH_HELP;
  if (refspecs.length === 0) return 'Name the branch to publish: master goes to main. ' + PUSH_HELP;
  for (const spec of refspecs) {
    if (spec.startsWith('+')) return 'Force pushes are not allowed. ' + PUSH_HELP;
    if (spec.startsWith(':')) return 'Deleting a remote branch is not allowed. ' + PUSH_HELP;
    const dst = (spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec).replace(/^refs\/heads\//, '');
    if (dst === 'master' || (dst === 'HEAD' && !spec.includes(':'))) {
      return 'The remote master is stale; the live branch is main. ' + PUSH_HELP;
    }
  }
  return null;
}

const SPEC_ARG = /\.(spec|test)\.[cm]?[jt]sx?$|^tests[\\/]|[\\/]tests[\\/]/;
const ONE_WORKER = /--maxWorkers[= ]1\b|VITEST_MAX_WORKERS\s*[=:]\s*['"]?1\b|--no-file-parallelism/;
const RUNNERS = new Set(['npx', 'node', 'pnpm', 'yarn', 'bunx', 'pnpx']);

/** What one simple command runs, as far as the rules care. */
function classify(seg, cwd) {
  const w = program(seg);
  const head = w.length ? name(w[0]) : '';
  const out = { npmTask: null, vitest: false, light: false, specs: [], nodeScript: null, browser: false };
  if (head === 'npm') {
    const task = w[1] === 'run' || w[1] === 'run-script' ? w[2] : w[1];
    out.npmTask = task ?? null;
  }
  if (head === 'vitest' || (RUNNERS.has(head) && w[1] && name(w[1]) === 'vitest')) out.vitest = true;
  if (head === 'node' && w[1]) {
    if (name(w[1]) === 'test-light') { out.vitest = true; out.light = true; }
    const p = isAbsolute(w[1]) ? w[1] : resolve(cwd, w[1]);
    if (/\.[cm]?js$/i.test(w[1]) && existsSync(p)) out.nodeScript = p;
  }
  if (out.vitest) out.specs = w.filter((x) => !x.startsWith('-') && SPEC_ARG.test(x));
  if (head === 'start-process' || head === 'start') out.browser = /^(chrome|msedge|firefox)/i.test(name(w[1] ?? ''));
  if (head === 'npx' && /^playwright$/.test(w[1] ?? '')) out.browser = w.includes('--headed') || w[2] === 'open' || w[2] === 'codegen';
  return out;
}

/** The decision for one shell command, or null. */
export function judgeShell(tool, command, background, cwd, urlOf = remoteUrl) {
  if (tool === 'Bash' && /(?<!<)<<(?!<)-?\s*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1/.test(command)) {
    return ['deny', 'Shell heredocs break in this environment. Write the script or message to a file with the Write tool, then run it (or pass it with -F).'];
  }
  const parts = segments(command).map((seg) => ({ seg, push: pushArgs(seg), kind: classify(seg, cwd) }));
  for (const { push } of parts) {
    if (!push) continue;
    const why = judgePush(push.args, push.dir ? resolve(cwd, push.dir) : cwd, urlOf);
    if (why) return ['deny', why];
  }
  const runsWork = parts.some(({ kind }) => kind.vitest || kind.npmTask || kind.nodeScript);
  if (background && runsWork && /vitest|test-light|\b(test|check|verify|screens)\b|bench-|perf-probe|probe-|FUZZ_HUNT/i.test(command)) {
    return ['deny', 'Tests, benchmarks and probes run in the foreground, one at a time (AGENTS.md section 2).'];
  }
  for (const { seg, kind } of parts) {
    const runs = kind.nodeScript || kind.npmTask || kind.vitest || /^npx\b/i.test(program(seg)[0] ?? '');
    const headed = runs && /KEEP_OPEN|--headed\b|headless\s*[:=]\s*false/i.test(command);
    const script = kind.nodeScript && /headless\s*:\s*false/.test(readFileSync(kind.nodeScript, 'utf8'));
    if (kind.browser || headed || script) return ['ask', 'This opens a visible browser window. ' + BROWSER_HELP];
  }
  for (const { kind } of parts) {
    if (kind.vitest && /FUZZ_HUNT/.test(command)) {
      return ['ask', 'A fuzz hunt is a heavy job: the player approves it first (AGENTS.md section 7).'];
    }
    if (kind.npmTask && /^(t|test|check|verify|screens)(:|$)/.test(kind.npmTask)) {
      return ['ask', `npm ${kind.npmTask} runs the whole suite or a full verification, many minutes on the player's machine: the player approves it first.`];
    }
    if (!kind.vitest) continue;
    if (kind.specs.length === 0) {
      return ['ask', 'vitest with no spec file runs the whole suite: the player approves it first. For a change, name the specs: node scripts/test-light.mjs <spec files>.'];
    }
    if (!kind.light && !ONE_WORKER.test(command)) {
      return ['deny', 'Run specs with one worker: node scripts/test-light.mjs <spec files> (or add --maxWorkers=1).'];
    }
  }
  return null;
}

/** The decision for one hook input, or null. */
export function judge(input, urlOf = remoteUrl) {
  const tool = input.tool_name ?? '';
  if (BROWSER_TOOL.test(tool)) {
    return ['ask', 'This opens the in-app browser pane or the player\'s Chrome. ' + BROWSER_HELP];
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    const ti = input.tool_input ?? {};
    return judgeShell(tool, String(ti.command ?? ''), Boolean(ti.run_in_background), input.cwd || process.cwd(), urlOf);
  }
  return null;
}

async function main() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const verdict = judge(JSON.parse(text));
  if (!verdict) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: verdict[0], permissionDecisionReason: verdict[1] },
  }));
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === self.toLowerCase()) {
  // A broken guard must never stop the session: on any error it stays silent.
  main().catch(() => process.exit(0));
}
