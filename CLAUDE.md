# CLAUDE.md — Roadcraft

A browser game: the player draws roads on a terrain they can sculpt, builds a
town, and a continuous simulation (traffic, residents as agents) runs on it.
Isometric 3D with three.js. Every edit takes effect at once, so every system is
rebuildable from the document in a fraction of a second. Everything in the repo
is in English; the interface is translated at runtime (`src/ui/i18n/`).
What is live and what is open: `docs/STATUS.md`. Each folder under `src/` has
its own `CLAUDE.md` with its couplings and traps.

## How work is done

- **Research first.** Before anything non-trivial (performance, loading,
  rendering, simulation, agents, tools, UI systems), read the official docs
  (three.js docs and source, MDN, Khronos) and how shipped games solve it (GDC
  talks, engine docs, post-mortems: GTA, Cities: Skylines, Unreal Mass). Tell
  the player what was found, with links, and the approach chosen; then code.
  Never improvise a technique or "try and measure" in the dark. (2026-10-02: a
  16 s loading screen was built before checking that engines cook assets offline.)
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
  step. Publish with `git push origin master`
  (github.com/designathan1988/app-roadcraft-v2); never force-push.
- **After a compaction** read the memory index
  (`C:/Users/jonathanrodriguesti/.claude/projects/C--Codex-Shared-Roadcraft/memory/MEMORY.md`)
  and `docs/STATUS.md` before anything else. Standing rules go in this file,
  project state in `docs/STATUS.md`, memory keeps only the player's
  preferences and machine facts.

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
The defect detector is `tests/fuzz/` (docs/fuzzing.md): before touching `world/`
or `sim/`, run a hunt and compare the tally. Headless Chrome here renders on the
Intel iGPU, not the player's RTX 3060: compare GPU numbers only with each other.
Probe scripts are scratch: keep them in the session's scratch directory.
