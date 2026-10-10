# CLAUDE.md — Roadcraft

Browser game (TypeScript, three.js, Vite): the player draws roads on sculptable
terrain, builds a town, and traffic and residents are simulated live. Every edit
takes effect at once, so every system rebuilds from the document in a fraction
of a second. Code and docs are in English; player-facing text lives in
`src/ui/i18n/en.ts` and `pt-BR.ts` (always both). State: `docs/STATUS.md`.
Plan: the ATUAL stage of `docs/PLANO.md`. `src/{world,sim,render,editor}` each
have a `CLAUDE.md` with their couplings and traps. Crime and police
(`src/backup/crime/`) are out of the game: never run or report them.

## Research before every change (non-negotiable)

1. Before writing or changing any code (features, fixes, tweaks, refactors),
   search the internet for the task and the intended approach. Memory and local
   files do not replace it; no exception for simplicity or urgency.
2. Open and read the sources; snippets do not count. Prefer official docs and
   source (three.js, MDN, Khronos WebGL, Vite, Vitest, TypeScript), maintainer
   issues, and how shipped games and engines solve it (GDC talks, engine docs,
   post-mortems). Search the exact error, and check the versions this repo uses.
3. Before editing, tell the player in one short message what you found, with
   links, and the approach. Then code; never improvise or "try and measure" blind.
4. After two failed attempts at the same problem (verification failed or did not
   confirm the fix), stop and research again before a third. Changing tool or
   approach does not reset the count. Report what the new research showed and
   the hypothesis to test.
5. No internet or not enough evidence: stop and report it. Never invent sources
   or claim research you did not do.

Research never widens scope or replaces local verification.

## Performance and quality

- Design every change for performance; measure before and after (frame ms, draw
  calls, triangles, rebuild ms, sim tick ms) and report the numbers.
- Judge at load: 400 people, 400 vehicles, big road networks.
- Optimise without losing visuals. Small visual trade-offs for speed are yours
  to decide; removing a feature or changing gameplay needs the player's yes.
- No allocation in hot loops (frame, sim step). Nothing computes geometry inside
  a draw call: derived data is built in `rebuildWorld` behind revision gates.
- Prefer instancing, merged geometry, shared materials; dispose what you replace.
- Fix causes, not symptoms. A visual defect is a class: fix it where it is
  generated and add a test or F9-monitor check so it cannot return. Never
  silence errors, skip or weaken tests, or loosen lint.
- Physical plausibility: nothing floats, passes through things or teleports.

## Verify

- Any visible change (UI, styles, models, materials, light, camera, animation)
  is checked in the real game before it is called done: in-app browser with the
  pane displayed (hidden it draws 0 fps), used as the player does, camera low
  and close. Open and inspect every screenshot; watch motion over time. Code,
  logs, no errors or green tests prove nothing visual. Fix what you see, look
  again, and report what each picture showed.
- Cannot look, or nothing visible changed: say so plainly with the reason;
  never claim it works.
- Servers: 5173 `roadcraft-dev` runs the current code; 4180 `roadcraft-play`
  serves the last build in `C:/Codex-Shared/road-play-dist`. Use 4180 when
  another session is editing; build with
  `node scripts/run-limited.mjs node node_modules/vite/bin/vite.js build --outDir C:/Codex-Shared/road-play-dist`.
  After each build, tell the player to press Ctrl+F5 on 4180 tabs opened
  before it (they keep the old bundle). Check the served bundle with
  `curl -s http://127.0.0.1:4180/ | grep -o 'assets/index-[^"]*\.js'`. Always
  say which server and build a picture or number came from.
- Tests: only the specs of touched files (`npx vitest run <path>`), in the
  foreground. `npm run check` and a fuzz hunt (`tests/fuzz/`) once, before a
  stage closes. A probe at most twice per item.
- The game is played on this machine (RTX 3060): never saturate the CPU, one
  heavy job at a time, vitest at most 6 workers. Headless Chrome renders on the
  Intel iGPU: compare its GPU numbers only with each other.
- "Done" is measured and seen; "closed" only when the player checked it.

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
→ frame: `SimWorld.step()` (`sim/world.ts`, `sim/pipeline.ts`),
`SceneHandle.draw()` (`render/renderer.ts`) → `rebuildWorld` behind gates:
`doc.revision` road geometry, `trafficRevision` road plan, `terrainRevision`
land, `buildings.revision` buildings, `utilityRevision` poles and wires.

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
| residents | `sim/city/city.ts`, `sim/people/`, `sim/agents/` |
| traffic | `sim/vehicles/`, `sim/intersections/admission.ts`, `sim/signals/` |
| buildings | `world/buildings/`, `editor/buildings.ts`, `render/buildings/` |
| tools, undo, save/load | `editor/`, `main.ts` |
| panels | `index.html`, `ui/` (`ui/v2/shell.ts`) |

## Git

Work on `master` in `C:/Codex-Shared/Roadcraft`, no worktrees. Stage explicit
paths, never someone else's changes. Commit each verified step with code and
docs together (message in Brazilian Portuguese), then `git push v3 master` and
`git push origin master`. Never force-push.

## Commands

```bash
npm run dev            # the game on localhost
npm run check          # lint + typecheck + tests + build
npm run verify:visual  # boots the app in Chrome and measures the scene
npm run cook:people    # after changing people code or assets (dev server up)
```
