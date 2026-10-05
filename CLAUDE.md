@AGENTS.md

# For Claude

> **Rule zero — research on the internet first, always.** Before
> implementing anything that is not trivial, search the official
> documentation (three.js and other relevant primary sources).
> Do this before editing code. If internet access is unavailable,
> report the blocker; do not treat memory or an unverified assumption
> as a substitute.

> **No trial and error.** Before changing code for a defect, establish the observed
> failure, trace it to its root cause across the affected boundaries, research the
> relevant official sources, and record a causal implementation plan. Implement
> the shared cause rather than a site-specific symptom or a speculative tweak.
> When verification fails, inspect the new evidence and revise the hypothesis
> before editing again; do not cycle through ungrounded variations or tune tests,
> references, or metrics to make the result appear successful.

The rules of work and the map of the code are in `AGENTS.md`, imported above; they
apply to Claude exactly as written there. This part only adds what is specific to
Claude Code.

## Start of every task, and after every compaction
- Read `docs/STATUS.md`: what is live, what is open, the player's standing
  decisions. It replaces the old "current work" memories.
- If two instructions disagree (this file, `AGENTS.md`, `docs/STATUS.md`, a memory,
  a skill, a handoff doc), stop and tell the player which two, in one line. Do not
  pick one silently.

## Photos and browsers
- Photograph with the headless scripts in `AGENTS.md` section 7, on a port of their
  own, and stop the server afterwards. Look at every picture before reporting.
- The in-app browser pane and Claude in Chrome are the player's windows. Open them
  only when the player asks; a hook asks the player before they open. Why: on
  2026-10-02 the player twice told agents to stop opening browsers in their face.
- When the player's game is open in the pane, it is their live game: no test
  edits, no simulation runs there.

## Tests
- `node scripts/test-light.mjs <spec files>`, in the foreground, a couple of
  minutes at most. The whole suite (`npm run check`, `npm test`, `npm run
  verify*`) only when the player asks; a hook asks them first.

## Sessions
- Only one session works on this repository: no worktrees, ownership claims or
  messages to other sessions; just do the work on `master`.
- No subagents unless the player asks for them.
- After the player corrects the same point twice, stop: write what was learned in
  `docs/STATUS.md` and suggest a fresh session with a precise prompt.
- Multi-line scripts and commit messages are written to a file with the Write tool
  and run or passed with `-F`; shell heredocs break here (a hook blocks them).

## Memory
Auto memory keeps only the player's personal preferences and facts about this
machine. Rules belong in this file or `AGENTS.md`; project state belongs in
`docs/STATUS.md`. Do not write either into memory.

## Hooks
`.claude/settings.json` runs `.claude/hooks/guard.mjs` before shell commands and
before the browser tools that open a window. It blocks shell heredocs, force
pushes, pushes to anything but `origin main`, and tests in the background; it asks
the player before the whole suite, a fuzz hunt, a visible browser, or the browser
pane. If it blocks something that should be allowed, fix the hook in the open and
say so; never work around it.

`.claude/hooks/research.mjs` is the research gate the player ordered on
2026-10-04: when an attempt did not solve the problem, the next step is research,
never another guess. A player message saying the result is still bad (ruim,
defeito, continua, não resolveu, pesquisa…) arms it; from then on every edit to
the code (Edit/Write on the repository except `docs/`, `.claude/` and the root
Markdown files, and shell commands that write into `src/`, `tests/`, `scripts/`,
`public/`) is denied until at least one WebSearch and two pages read with
WebFetch. Then tell the player what was found, with the links, the cause and the
approach, before editing. Never work around it (no edits through other tools).
