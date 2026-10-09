# CLAUDE.md — Roadcraft

A browser game: the player draws roads on a terrain they can sculpt, builds a
town, and a continuous simulation (traffic, residents as agents) runs on it.
Isometric 3D with three.js. Every edit takes effect at once, so every system is
rebuildable from the document in a fraction of a second. Everything in the repo
is in English; the interface is translated at runtime (`src/ui/i18n/`).
What is live and what is open: `docs/STATUS.md`. Each folder under `src/` has
its own `CLAUDE.md` with its couplings and traps.

## How work is done

- **Look at the game yourself before saying anything works.** This rule comes
  before every other one, including pace. After any change to game code: open
  the game in the in-app browser with the pane displayed (hidden, it draws 0
  frames a second and every number is false; if `tabs_context` says hidden, ask
  the player for Ctrl+Shift+B), use the change as the player does, with the
  camera low and close where a defect would show ("Baixar a câmera" in the
  camera menu), take a screenshot and read it. Use the production build when
  another session may be editing (the dev server reloads `main.ts` under you):
  `node scripts/run-limited.mjs node node_modules/vite/bin/vite.js build --outDir C:/Codex-Shared/road-play-dist`,
  then preview `roadcraft-play` (port 4180); otherwise `roadcraft-dev`.
  Looking at the game is not a probe and has no limit. Measurements and green
  tests come in addition, never instead. `.claude/hooks/verify-gate.mjs` blocks
  the final reply when game code changed and its current state was not
  screenshotted; a change with nothing visible says so in the reply with the
  line `SEM VERIFICAÇÃO VISUAL: <motivo>`.
- **Research first.** Before anything non-trivial (performance, loading,
  rendering, simulation, agents, tools, UI systems), read the official docs
  (three.js docs and source, MDN, Khronos) and how shipped games solve it (GDC
  talks, engine docs, post-mortems: GTA, Cities: Skylines, Unreal Mass). Tell
  the player what was found, with links, and the approach chosen; then code.
  Never improvise a technique or "try and measure" in the dark. (2026-10-02: a
  16 s loading screen was built before checking that engines cook assets offline.)
  Research once per technique, not once per file; a technique already cited in
  the code or the docs is not researched again.
- **Interface work is done only when photographed.** Open the app, drive the real
  interface, screenshot every option the change touches (each group, tool,
  gallery, parameter row, the starting state and the way back), check each
  picture, report with the pictures. A test that a selector exists is not a
  verified interface; an empty row is a defect. Check at 1280x720 too.
- **A replacement is the new system, running in the game.** Do not patch the
  model being replaced; preparation (documents, seams, refactors) is not
  delivery. Every report says plainly what is LIVE and what is not. Deliver in
  visible slices, behind a flag first, then by default.
- **Tests measure what the player sees.** A green suite does not prove a visible
  defect gone; for motion measure the drawn body per tick (`PedView`), then look
  in the game. Run the specs you touched, in the foreground, minutes at most.
  Never hour-long or parallel background runs, one heavy job at a time (the
  game is played on this machine; vitest is capped at 6 workers). No subagents
  unless the player asks.
- **Git:** work on `master` in `C:/Codex-Shared/Roadcraft`, no worktrees. Stage
  explicit paths, never someone else's changes; commit after every verified
  step. Publish to both remotes, `git push v3 master`
  (github.com/designathan1988/app-roadcraft-v3) and `git push origin master`
  (app-roadcraft-v2); never force-push.
  **Exception (the player, 2026-10-09):** the road system (docs/VIAS.md) is built
  by a background agent in a worktree on branch `vias`. It never commits to
  `master` nor pushes; the main session merges each stage after checking it in
  the game and the player's approval. The hot files (`main.ts`, `world/doc.ts`,
  `render/roadSurfaces.ts`, `world/markings.ts`, `world/lanelets.ts`,
  `render/agents.ts`) are edited by the agent only in integration commits it
  declares, and by the main session meanwhile only to fix a defect, announced.
  A heavy job (full suite, fuzz, build, probe) waits while `docs/.heavy-lock`
  exists and creates it while it runs.
- **After a compaction** read the memory index
  (`C:/Users/jonathanrodriguesti/.claude/projects/C--Codex-Shared-Roadcraft/memory/MEMORY.md`),
  `docs/PLANO.md` and `docs/STATUS.md` before anything else. Standing rules go
  in this file, the plan in `docs/PLANO.md`, project state in
  `docs/STATUS.md`, memory keeps only the player's preferences and machine
  facts.

## Pace and done (player's orders of 2026-10-09)

The work was too slow and too often "done" when the player still saw the
defect. Measured on 2026-10-08/09: 35 of 179 commits were docs only, one probe
ran 26 times, the full suite ran dozens of times, the context was compacted 3
times, and visible defects (old trees) were closed by the session's own numbers.

- **Two states.** "Done, waiting for the player" is what the session measured
  and photographed. "Closed" is only what the player checked in the game, or
  what has nothing visible (dead code, a test, a CPU number). A visible defect
  (trees, interface, colours, motion) never closes on the session's numbers.
- **One item at a time, nothing left uncommitted.** A change either goes in
  (behind a flag if not adopted) or is undone and logged under "Já tentado" in
  `docs/PROBLEMAS.md`.
- **Only the CURRENT stage of `docs/PLANO.md`.** Anything found outside it
  (fuzz, traffic rules, builder) goes into the plan's queue unless the player
  marks it URGENTE or PRIORIDADE.
- **One session at a time in this repo;** a second session only reads. Short
  sessions: after two compactions, update STATUS and the plan and stop.
- **Tests of what you touched.** While working, only the specs of the files
  changed. The full suite (`npm run check`) and a fuzz hunt run once, before
  a stage closes, not per item.
- **A probe at most twice per item,** before and after. Needing a third means
  the hypothesis is wrong: go back to the code. A probe is a measuring script;
  looking at the game in the in-app browser is not one and is never rationed.
- **Docs in the same commit as the code** (the `PROBLEMAS.md` line, STATUS).
  A docs-only commit only at the end of a session.
- **Similar defects in one batch:** one cycle of reading, fixing, testing and
  committing for several defects of the same area.
- **Never idle:** while a test or probe runs, read the code of the next item.
- **Faster never means unverified.** The pace rules cut repeated suites, probes
  and docs commits; they never cut looking at the game (first rule above).
- **A visual defect the player reports is a class, not an instance.** Find
  where it is generated, fix it there, and add a detector (a test, or a check
  in the F9 monitor) so the class cannot come back. Hiding it in the renderer,
  or closing it "by method", is not a fix.
- **Physical plausibility is an invariant:** nothing floats, nothing passes
  through anything, nothing jumps from place to place. Check it like the
  layer rules (docs/PLANO.md, Etapa 5a).

## Layers (enforced by `eslint.config.js` and `tests/arch`)

```
core → world → sim, render;  world → editor → ui;  core → view → render, ui
```
`core` pure geometry; `world` the document and everything derived that is not a
picture (widths, junctions, surfaces, elevation, lanelets, terrain, bounds);
`sim` vehicles, people, signals (never reads `render`); `view` world↔screen;
`render` owns three.js (**nothing else imports `three`**); `editor` mutates the
document; `ui` is the DOM (may read `sim`). `main.ts` (with `buildingsWiring.ts`)
is the composition root: input and the frame loop. If `world` wants `render`,
the thing belongs in `world`.

## Where to change what

| what | where |
|---|---|
| road height, ramps, plates, grades | `world/elevation.ts` (docs/elevation.md) |
| junction shape, trims, mouths | `world/junction/`, `world/approach.ts` |
| road classes, widths, lanes, line colours | `world/roadTypes.ts` |
| surface polygons / their mesh | `world/surfaces.ts` / `render/roadSurfaces.ts`, `render/mesh/surfaceMesh.ts` |
| terrain, brushes, rivers / its mesh, water | `world/terrain.ts` / `render/terrain.ts`, `render/water.ts` |
| materials, light, shadows, post, quality tiers | `render/materials.ts`, `environment.ts`, `postprocess.ts`, `quality.ts` |
| scene graph, what is rebuilt when | `render/renderer.ts` |
| markings, structures, scenery, signals | `world/markings.ts` + `render/markings.ts`, `render/structures.ts`, `render/scenery.ts`, `render/signals.ts` |
| vehicles drawn, people drawn | `render/agents.ts`, `render/riggedCitizens.ts`, `render/vehicleModels.ts` |
| residents: days, needs, cars, walking | `sim/city/life.ts`, `sim/agents/` (mind, activities, cars, parking, walk) |
| traffic: following, lane change, admission, signals | `sim/vehicles/`, `sim/intersections/admission.ts`, `sim/signals/` |
| conflict zones, turn paths | `world/conflictPoints.ts`, `world/turnPaths.ts` |
| buildings: model / commands, tool / look | `world/buildings/` / `editor/buildings.ts`, `buildingTool.ts` / `render/buildings/` |
| tools, undo, save/load | `src/editor/`, `main.ts` |
| any player-facing text | `ui/i18n/en.ts` **and** `pt-BR.ts` (a test fails if they drift) |
| panels and buttons | `index.html`, `src/ui/` (interface v2: `ui/v2/shell.ts`) |

## Execution flow and revisions

Pointer/key → `main.ts` mutates the `RoadDoc` (`world/doc.ts`) → `Network.rebuild()`
→ frame: `SimWorld.step()` (`sim/pipeline.ts`), then `SceneHandle.draw()`
(`render/renderer.ts`) → `rebuildWorld` behind revision gates (one elevation
solve, road surfaces in cached tiles, structures, scenery).
Revisions: `doc.revision` road geometry (network, road meshes, minimap);
`trafficRevision` the road plan (lanelets, crossings, sim topology);
`terrainRevision` the land (and roads on it); `buildings.revision` buildings
(never `doc.revision`); `utilityRevision` poles and wires. The wrong one rebuilds
everything or nothing.

## Invariants

1. The road height field is a continuous function of position.
2. Every band of a road reads the same deck height.
3. A junction plate is flat, and every leg is flat over the plate's reach.
4. Nothing computes geometry inside a draw call: derived things are built in
   `rebuildWorld` behind the revision gates.
5. `world` and `sim` never call `Math.random` (use `core/rng.ts`).
6. One writer per field (the simulation's list is in `sim/pipeline.ts`); a number
   used in two places is declared once.

## What to run

```bash
npm run dev            # the game on localhost
npm run check          # lint + typecheck + tests with coverage + build
npm run verify:visual  # boots the real app in Chrome and measures the scene
npm run cook:people    # after any change to people code or assets (dev server up)
```
The defect detector is `tests/fuzz/`: in a stage that touches `world/` or
`sim/`, run a hunt at its start and again before it closes, and compare the
tally (not before every change). Headless Chrome here renders on the
Intel iGPU, not the player's RTX 3060: compare GPU numbers only with each other.
Probe scripts are scratch: keep them in the session's scratch directory.
