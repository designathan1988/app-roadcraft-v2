# AGENTS.md — Roadcraft

Read by every coding agent (Codex directly, Claude through `CLAUDE.md`): the rules
of work and the map of the code. One area's detail lives in its folder's
`AGENTS.md` (section 4); what is live and what is open, in
[docs/STATUS.md](docs/STATUS.md). Keep this file under 200 lines.

## 1. What this is

A browser city game in three.js: the player draws roads on a terrain they sculpt,
places and models buildings, and traffic, pedestrians and residents are simulated
on it continuously. Every edit takes effect at once, so every system rebuilds from
the document in a fraction of a second.

## 2. How work is done here

### Find the cause, then fix it
- Before changing behaviour or performance, reproduce the defect and trace the data
  and control flow until the cause is found. When a check contradicts the
  diagnosis, find the false assumption and revise the plan. Stacking guesses,
  tuning a number until a test passes, or hiding a symptom is not a fix.
- Before using a technique that is new to this code (rendering, loading,
  simulation, agents, tools, UI systems), read the official documentation
  (three.js, MDN, Khronos; Unreal and Unity as references) and how shipped games
  solve it (GDC talks, engine docs, post-mortems). Tell the player what was found,
  with links, which approach fits and why; then plan and write the code. For a
  technique this repository already uses, its doc in `docs/` is the source.
  Why: on 2026-10-02 a 16 s loading screen was built before anyone checked that
  engines prepare their assets offline.
- When the player orders a system replaced, build the new one and switch it on in
  the game in slices they can see (behind a flag first, then by default). Do not
  patch the system being replaced. Design notes, research and seams that change
  no behaviour are preparation, never reported as progress.

### Done means the player can see it
A change is done when all of these hold:
1. `npx tsc --noEmit` passes, and `npx eslint <changed files>` passes.
2. The specs that cover the change pass:
   `node scripts/test-light.mjs <spec files>` (one worker, low priority).
3. A visible change is photographed in the running game with a headless script
   (section 7), and the pictures are looked at one by one. For interface work:
   every option the change touches, the state the tool starts in, and the way
   back. Measurements (rects, counts, styles) diagnose; pictures verify.
4. The report says in plain words what is LIVE in the game now and what is not.

A green suite does not prove a visible defect is gone: measure what is drawn (for
motion, the published `PedView` per tick), then look at it.

### When to ask the player
- Do not ask about implementation details, downloads, commits or pushes. Decide,
  then report.
- Ask first before:
  - deleting, moving or overwriting a file the player received (docs, prompts,
    deliverables); untracked files have no git safety net;
  - opening a visible browser window or the in-app browser pane;
  - running the full suite, a fuzz hunt, or any job longer than about 2 minutes;
  - building a visual result the request leaves open: describe what will be on
    screen and get a yes first. On 2026-10-04 the block interiors were built
    three times and reverted because nobody showed the picture first.

### Sharing the machine and the repository
- The player plays on this machine while agents work. One heavy job at a time
  (suite, build, browser harness, benchmark), always in the foreground. Stop every
  server and browser you start. Only the player's game server (port 4180) stays up.
- One agent works on this repository at a time (the player, 2026-10-04): work on
  `master` in `C:/Codex-Shared/Road`, stage by explicit path, commit after every
  verified step. No worktrees, claims or messages to other sessions.
- Publish with `git push origin master:main`. `origin` is
  github.com/designathan1988/app-roadcraft; `main` is the live branch and the
  remote `master` is stale. Never force-push.
- Scratch (probes, traces, logs, one-off scripts) goes to your session's scratch
  directory, never into the repository. A tool worth keeping goes to `scripts/`
  with a header comment that says how to run it.
- State (what is live, who owns which area, what is open) is kept in
  [docs/STATUS.md](docs/STATUS.md). Rewrite your area's lines when they change;
  do not append logs.
- One writer per field: every piece of simulation state has exactly one module
  that writes it (the list is in `src/sim/pipeline.ts`). A number used in two
  places is declared once.

### Language
- The repository is in English (code, names, comments, commits, docs); talk to the
  player in Brazilian Portuguese.
- Player-facing text only through i18n: a key in both `src/ui/i18n/en.ts` and
  `pt-BR.ts` (a test fails if they drift); `data-i18n` in markup, `t('key')` in code.

## 3. Dependency order (enforced by `eslint.config.js`)

```
core  →  world  →  sim
                →  render
        world  →  editor  →  ui
core  →  view   →  render, ui
```

- `core`: pure 2D geometry and numerics. `world`: the authored document and all
  that derives from it but is not a picture. `sim`: vehicles, pedestrians,
  residents, signals; never reads `render`. `view`: the world/screen seam.
- `render` owns three.js: nothing outside `src/render/` imports `three`
  (`tests/arch/layers.spec.ts` checks it, and that `world`/`sim` never call
  `Math.random`).
- `editor` mutates the document; `ui` is the DOM and may read `sim`. `main.ts`
  (composition root: input, frame loop) and `buildingsWiring.ts` may touch all.

## 4. Where to change what

Read the folder file before editing a folder: `src/world/AGENTS.md`,
`src/sim/AGENTS.md`, `src/render/AGENTS.md`, `src/editor/AGENTS.md` (also for
`main.ts` and `buildingsWiring.ts`). They list the couplings that break far from
where you edit and the traps that have already caught someone.

| I want to change… | Go to | Also read |
|---|---|---|
| road height, ramps, junction plates, grade limits | `src/world/elevation.ts` | [docs/elevation.md](docs/elevation.md) |
| junction shape (corner radii, trims, mouths) | `src/world/junction/` | [docs/intersections.md](docs/intersections.md) |
| road widths, lanes, classes, cross-section | `src/world/roadTypes.ts`, `src/world/section.ts` | [docs/road-system.md](docs/road-system.md) |
| surface polygons, footways | `src/world/surfaces.ts`, `src/world/walkways.ts` | [docs/road-system.md](docs/road-system.md) |
| elevated, viaduct, bridge, tunnel | `src/world/structures.ts` | [docs/elevation.md](docs/elevation.md) |
| terrain, brushes, rivers | `src/world/terrain.ts`, `src/render/terrain.ts`, `src/render/water.ts` | [docs/terrain.md](docs/terrain.md) |
| polygon to triangles | `src/render/mesh/surfaceMesh.ts` | [docs/mesh-generation.md](docs/mesh-generation.md) |
| materials, asphalt detail | `src/render/materials.ts`, `src/render/mesh/textureBaker.ts` | [docs/materials-textures.md](docs/materials-textures.md) |
| sun, sky, shadows, fog, time of day | `src/render/environment.ts` | [docs/lighting.md](docs/lighting.md) |
| AO, anti-aliasing, bloom, film grade | `src/render/postprocess.ts` | [docs/rendering.md](docs/rendering.md) |
| what is built when, scene graph | `src/render/renderer.ts` | [docs/rendering.md](docs/rendering.md) |
| markings, crossings, stop bars | `src/world/markings.ts`, `src/render/markings.ts` | [docs/road-system.md](docs/road-system.md) |
| piers, parapets, portals; lamps, trees | `src/render/structures.ts`, `src/render/scenery.ts` | [docs/rendering.md](docs/rendering.md) |
| quality tiers | `src/render/quality.ts` | [docs/performance.md](docs/performance.md) |
| vehicle fleet, drivers, lane changes, spawning | `src/sim/vehicles/` (`archetypes.ts`, `driver.ts`, `laneChange.ts`) | [docs/architecture.md](docs/architecture.md) |
| cars at the kerb, doors, getting in and out | `src/sim/vehicles/kerbStops.ts` | `tests/sim/kerbStops.spec.ts` |
| right of way, gap acceptance, deadlock | `src/sim/intersections/admission.ts`, `src/sim/crossings/` | [docs/architecture.md](docs/architecture.md) |
| conflicting movements, turn paths | `src/world/conflictPoints.ts`, `src/world/turnPaths.ts` | `tests/sim/collisions.spec.ts` |
| signal plans and phases | `src/sim/signals/` | [docs/architecture.md](docs/architecture.md) |
| resident agents (`?agents=1`): own cars, bays, lots, task chain | `src/sim/agents/` | `src/sim/AGENTS.md` |
| pedestrians today (being replaced by the agents) | `src/sim/people/people.ts` (default), `crowd.ts` (`?people=crowd`), `src/sim/peds/` | `src/sim/AGENTS.md` |
| residents, trips, day clock | `src/sim/city/` | [docs/STATUS.md](docs/STATUS.md) |
| how a person's body moves and looks | `src/render/riggedCitizens.ts`, `src/render/citizenWalk.ts` | [docs/pedestrians.md](docs/pedestrians.md) |
| people models, wardrobe, cooking | `public/models/people/`, `scripts/import-makehuman*.mjs`, `npm run cook:people` | `src/render/AGENTS.md` |
| vehicle bodies, seats; riders' poses | `src/render/vehicleModels.ts`, `src/render/riderPoses.ts` | `tests/render/occupantFit.spec.ts` |
| tools, undo, save/load, road snapping | `src/editor/` (`snap.ts`, `commit.ts`) | [docs/architecture.md](docs/architecture.md) |
| building model, lots | `src/world/buildings/`, `src/editor/lotPlan.ts` | [docs/buildings.md](docs/buildings.md) |
| building tool, snapping; how buildings look | `src/editor/buildings*.ts`, `src/render/buildings/` | [docs/buildings.md](docs/buildings.md) |
| the interface (CS2 layout) | `src/ui/v2/shell.ts`, `src/ui/builder/`, `src/ui/creator/`, `index.html` | [docs/i18n.md](docs/i18n.md) |
| any text the player reads | `src/ui/i18n/en.ts` and `pt-BR.ts` | [docs/i18n.md](docs/i18n.md) |
| the road and traffic defect detector | `tests/fuzz/` | [docs/fuzzing.md](docs/fuzzing.md) |

## 5. The execution flow

```
pointer / key
  └─ main.ts ─────────────────────────── mutates the document (src/world/doc.ts)
       revision++
       Network.rebuild()                 (src/world/network.ts)
       requestAnimationFrame → frame()   (src/main.ts)
         ├─ SimWorld.step()              (src/sim/pipeline.ts)
         └─ SceneHandle.draw()           (src/render/renderer.ts)
              ├─ terrain.update(doc)     terrain revision gate
              └─ rebuildWorld(net)       network + terrain revision gate
                   ├─ buildRoadElevation()   one height field (the keystone)
                   ├─ buildRoadSurfaces()    4 bands per structural level
                   ├─ buildStructureDetails()
                   └─ buildScenery()
```

Revisions gate the rebuilds: `doc.revision` (road geometry), `doc.trafficRevision`
(the road plan read by traffic and pedestrian topology), `doc.terrainRevision`
(the land), `buildings.revision`, `utilityRevision`. An edit that moves the wrong
one rebuilds everything or nothing.

## 6. The five invariants

1. The road height field is a continuous function of position
   (`tests/world/elevation.spec.ts` halves the sampling step to check it).
2. Every band of a road (verge, footway, kerb, carriageway) reads the same deck
   height; no band has its own elevation source.
3. A junction plate is flat, and every leg is flat over the plate's reach
   (`Network.trims`).
4. Nothing computes geometry inside a draw call: derived geometry is built in
   `rebuildWorld` behind the revision gates.
5. `world` and `sim` never call `Math.random`; use `core/rng.ts`.

## 7. What to run

| Command | What it does | When |
|---|---|---|
| `npx tsc --noEmit` | type check | every change |
| `npx eslint <files>` | lint, including the layer rules | every change |
| `node scripts/test-light.mjs <spec files>` | the named specs, one worker, low priority | every change |
| `npm run dev` | the game in development, on localhost | while working; stop it after |
| `node scripts/probe-shots.mjs`, `scripts/capture-scene.mjs`, `scripts/crowd-shots.mjs` | headless photos of the running game | every visible change |
| `npm run verify:ui` | builds, then photographs the Builder panel states | interface changes |
| `npm run check`, `npm test`, `npm run verify*`, `npm run screens` | lint, types, the whole suite, build, browser checks | only when the player asks: many minutes |
| `FUZZ_HUNT=1 FUZZ_SEEDS=80 FUZZ_OPS=40 npx vitest run tests/fuzz/fuzz.spec.ts --maxWorkers=1 --testTimeout=0` | the road and traffic defect hunt | large `world/` or `sim/` changes, after asking |
| `npx vite build --outDir C:/Codex-Shared/road-play-dist --emptyOutDir` | rebuilds the player's game on 4180 | after a change lands on master, from a clean worktree of HEAD |

Headless browsers on this machine render on the Intel iGPU, not the player's RTX
3060: compare GPU timings only with each other, never as the player's frame rate.
After any change to people code or assets, run `npm run cook:people` or bodies are
built slowly at runtime.
