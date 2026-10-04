@AGENTS.md

# For Claude

The rules of work and the map of the code are in `AGENTS.md`, imported above; they
apply to Claude exactly as written there. This part only adds what is specific to
Claude Code.

## Start of every task, and after every compaction
- Read `docs/STATUS.md`: what is live, who owns each area, what is open, the
  player's standing decisions. It replaces the old "current work" memories.
- Run `git status` and `git log -5` before editing: other sessions work in this
  repository at the same time.
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
- Several Claude and Codex sessions run here at once. Before touching a file
  another session owns (`docs/STATUS.md` → Owners), message it with `ListAgents` and
  `SendMessage`, and record your own claim in `docs/STATUS.md`.
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
