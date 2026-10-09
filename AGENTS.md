# AGENTS.md — Roadcraft

Browser game (TypeScript, three.js, Vite): the player draws roads on sculptable
terrain, builds a town, and traffic and residents are simulated live. Every edit
takes effect at once, so every system must rebuild from the document fast.
The repo is in English; player-facing text is in `src/ui/i18n/en.ts` and
`pt-BR.ts` (both, always). State of the game: `docs/STATUS.md`. Current work:
the ATUAL stage of `docs/PLANO.md`.

## Research first, always

Before any change that is not a one-line fix following a pattern already in the
code, read the **official documentation** of what you are about to use (three.js
docs and source, MDN, Khronos WebGL, Vite, Vitest, TypeScript) and how shipped
games or engines solve the same problem. Search results do not count as reading.
State in one short message what you found (with links) and the approach, then
code. Never improvise a technique or "try and measure" blind.

## Priorities: performance, optimisation, quality

- Design every change for performance and measure before and after (frame ms,
  draw calls, triangles, rebuild ms, CPU per sim tick). Report the numbers.
- Judge at load: 400 people, 400 vehicles, big road networks.
- Optimise without losing visuals. Small visual trade-offs for speed are fine;
  removing a feature or changing gameplay needs the player's yes.
- No allocation in hot loops (frame, sim step); reuse buffers and objects.
  Nothing computes geometry inside a draw call: derived data is built in
  `rebuildWorld` behind the revision gates (`doc.revision` roads,
  `trafficRevision` road plan, `terrainRevision` land, `buildings.revision`,
  `utilityRevision`). The wrong gate rebuilds everything or nothing.
- Prefer instancing, merged geometry and shared materials; dispose what you
  replace (three.js "How to dispose of objects").
- Quality: fix causes, not symptoms. A visual defect is a class: fix where it is
  generated and add a test or a check so it cannot come back. Never silence
  errors, skip or weaken tests, or loosen lint.
- Physical plausibility: nothing floats, passes through things or teleports.

## Architecture (enforced by `eslint.config.js` and `tests/arch`)

```
core → world → sim, render;  world → editor → ui;  core → view → render, ui
```
`core` pure geometry; `world` the document and everything derived that is not a
picture; `sim` vehicles, people, signals (never reads `render`); `render` owns
three.js (nothing else imports `three`); `editor` mutates the document; `ui` DOM.
`src/main.ts` is the composition root. Each `src/` folder has a `CLAUDE.md` with
its couplings and traps: read it before editing there.
Invariants: road height is continuous; junction plates are flat; `world` and
`sim` never call `Math.random` (use `core/rng.ts`); one writer per field.

## Verify

- Run only the specs of the files you touched: `npx vitest run <path>`.
  Full check (`npm run check`) once, before a stage closes.
- Look at the game yourself before saying it works: `npm run dev`, use the
  change as the player does, camera low and close, screenshot and inspect it.
  If you could not look, say so plainly; never write "works".
- The game is played on this machine (RTX 3060). Never saturate the CPU: one
  heavy job at a time, vitest capped at 6 workers, no long background runs.
  Headless Chrome renders on the Intel iGPU: compare its GPU numbers only with
  each other.

## Git

Work on `master` in `C:/Codex-Shared/Roadcraft`. Stage explicit paths, never
someone else's changes. Commit each verified step (message in Brazilian
Portuguese), then `git push v3 master` and `git push origin master`. Never
force-push.

## Out of scope

Crime and police (`src/backup/crime/`) are not part of the game: do not run,
cite, report or revive them unless the player asks.
