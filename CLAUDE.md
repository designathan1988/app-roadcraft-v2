# CLAUDE.md — Roadcraft

Browser game (TypeScript, three.js, Vite): the player draws roads on sculptable
terrain, builds a town, and traffic and residents are simulated live. Every edit
takes effect at once, so every system rebuilds from the document in a fraction
of a second. The repo is in English; player-facing text lives in
`src/ui/i18n/en.ts` and `pt-BR.ts` (both, always). State: `docs/STATUS.md`.
Plan: the ATUAL stage of `docs/PLANO.md`. Each `src/` folder has a `CLAUDE.md`
with its couplings and traps.

## Research first, always

Before any change that is not a one-line fix following a pattern already in the
code, read the **official documentation** of what you will use (three.js docs
and source, MDN, Khronos WebGL, Vite, Vitest, TypeScript) and how shipped games
and engines solve it (GDC talks, engine docs, post-mortems). Search snippets do
not count as reading. Tell the player in one short message what you found, with
links, and the approach; then code. Never improvise or "try and measure" blind.
A technique already cited in the code or docs is not researched again.

## Performance, optimisation, quality

- Design every change for performance; measure before and after (frame ms, draw
  calls, triangles, rebuild ms, sim tick ms) and report the numbers.
- Judge at load: 400 people, 400 vehicles, big road networks.
- Optimise without losing visuals. Small visual trade-offs for speed are mine to
  decide; removing a feature or changing gameplay needs the player's yes.
- No allocation in hot loops (frame, sim step). Nothing computes geometry inside
  a draw call: derived data is built in `rebuildWorld` behind revision gates.
- Prefer instancing, merged geometry, shared materials; dispose what you replace.
- Fix causes, not symptoms. A visual defect is a class: fix it where it is
  generated and add a test or F9-monitor check so it cannot return. Never
  silence errors, skip or weaken tests, or loosen lint.
- Physical plausibility: nothing floats, passes through things or teleports.

## Verify

- Look at the game before saying anything works: open it in the in-app browser
  with the pane displayed (hidden it draws 0 fps), use the change as the player
  does, camera low and close, screenshot and inspect every picture. When
  another session is editing, use the production build:
  `node scripts/run-limited.mjs node node_modules/vite/bin/vite.js build --outDir C:/Codex-Shared/road-play-dist`,
  then preview `roadcraft-play` (port 4180); otherwise `roadcraft-dev`.
  Nothing visible changed: say `SEM VERIFICAÇÃO VISUAL: <motivo>`.
- Two servers, two versions. 5173 (`roadcraft-dev`) runs the code as it is
  now; 4180 (`roadcraft-play`) serves the last build in
  `C:/Codex-Shared/road-play-dist`. After every build, tell the player in the
  reply to press Ctrl+F5 on any 4180 tab opened before it: an open tab keeps
  the old bundle and shows the old defects (2026-10-09: the noise "came back"
  on 4180 while 5173 had the fix). Check which bundle 4180 serves with
  `curl -s http://127.0.0.1:4180/ | grep -o 'assets/index-[^"]*\.js'`, and
  always say which server and which build a picture or a number came from.
- Tests: only the specs of files touched (`npx vitest run <path>`), in the
  foreground. `npm run check` and a fuzz hunt (`tests/fuzz/`) once, before a
  stage closes. A probe at most twice per item.
- The game is played on this machine (RTX 3060): never saturate the CPU, one
  heavy job at a time, vitest capped at 6 workers. Headless Chrome renders on
  the Intel iGPU: compare its GPU numbers only with each other.
- "Done" is measured and photographed; "closed" only when the player checked it.

## Architecture (enforced by `eslint.config.js` and `tests/arch`)

```
core → world → sim, render;  world → editor → ui;  core → view → render, ui
```
`core` pure geometry; `world` the document and everything derived that is not a
picture; `sim` vehicles, people, signals (never reads `render`); `view`
world↔screen; `render` owns three.js (nothing else imports `three`); `editor`
mutates the document; `ui` the DOM. `main.ts` (with `buildingsWiring.ts`) is the
composition root. If `world` wants `render`, the thing belongs in `world`.

Flow: input → `main.ts` mutates `RoadDoc` (`world/doc.ts`) → `Network.rebuild()`
→ frame: `SimWorld.step()` (`sim/pipeline.ts`), `SceneHandle.draw()`
(`render/renderer.ts`) → `rebuildWorld` behind gates: `doc.revision` road
geometry, `trafficRevision` road plan, `terrainRevision` land,
`buildings.revision` buildings, `utilityRevision` poles and wires.

Invariants: road height is a continuous function of position; every band of a
road reads the same deck height; junction plates are flat; `world` and `sim`
never call `Math.random` (`core/rng.ts`); one writer per field.

| what | where |
|---|---|
| road height, ramps, grades | `world/elevation.ts` |
| junctions | `world/junction/`, `world/approach.ts` |
| road classes, widths, lanes | `world/roadTypes.ts` |
| road surfaces / mesh | `world/surfaces.ts` / `render/roadSurfaces.ts`, `render/mesh/surfaceMesh.ts` |
| terrain, water | `world/terrain.ts` / `render/terrain.ts`, `render/water.ts` |
| materials, light, post, quality tiers | `render/materials.ts`, `environment.ts`, `postprocess.ts`, `quality.ts` |
| what is rebuilt when | `render/renderer.ts` |
| markings, structures, scenery, signals | `world/markings.ts`, `render/markings.ts`, `structures.ts`, `scenery.ts`, `signals.ts` |
| vehicles and people drawn | `render/agents.ts`, `render/riggedCitizens.ts`, `render/vehicleModels.ts` |
| residents | `sim/city/life.ts`, `sim/agents/` |
| traffic | `sim/vehicles/`, `sim/intersections/admission.ts`, `sim/signals/` |
| buildings | `world/buildings/`, `editor/buildings.ts`, `render/buildings/` |
| tools, undo, save/load | `src/editor/`, `main.ts` |
| panels | `index.html`, `src/ui/` (`ui/v2/shell.ts`) |

## Git

Work on `master` in `C:/Codex-Shared/Roadcraft`, no worktrees. Stage explicit
paths, never someone else's changes; commit each verified step with code and
docs together (message in Brazilian Portuguese), then `git push v3 master` and
`git push origin master`. Never force-push. Exception: the road system
(`docs/VIAS.md`) is built by a background agent on branch `vias`; the main
session merges each stage after checking it in the game.

## Commands

```bash
npm run dev            # the game on localhost
npm run check          # lint + typecheck + tests + build
npm run verify:visual  # boots the app in Chrome and measures the scene
npm run cook:people    # after changing people code or assets (dev server up)
```

Crime and police (`src/backup/crime/`) are out of the game: never run or report them.
