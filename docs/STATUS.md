# Roadcraft — status

The one place for what is live in the game, who owns which area, what is open, and
the player's standing decisions. Every session reads it at the start of a task and
rewrites its own area's lines when they change (no appended logs; git keeps the
history). Rules of work are in `AGENTS.md`, not here.

Last full rewrite: 2026-10-04 19:10, from the agents' memories and the sessions
then running. Live build: `main` at a3b9757, served on http://127.0.0.1:4180.

## Who works here

One Claude session works on this repository at a time (the player, 2026-10-04),
on `master` in `C:/Codex-Shared/Road`. The Codex handoff of 2026-10-01 ended on
2026-10-02 (`docs/handoff/` is history); old branches on the remote
(`codex/performance-audit`, `codex/stages-b`, `perf-audit-followup`) are unmerged:
ask the player before merging any of them.

**Work under way:** the agents engine (GTA + The Sims): every resident a
persistent agent with their own car, replacing the three pedestrian engines and
the cars that appear from nowhere. Slice 1, a person who uses their own car, is
being built behind `?agents=1`.

## Live in the game (main, 4180)

### Interface
- Interface v2 (`src/ui/v2/shell.ts`) is the interface, laid out like Cities:
  Skylines II: icon-only dock bottom centre; asset panel above it (mode tabs on
  top, square 64 px thumbnails, one row, sideways scroll, fitted between the side
  panels by `fitDrawer()`); tool options bottom-left (`.v2-toolopts`, icon rows, no
  headings, no vertical scroll); names only in the interface's own tooltip
  (`.v2-tip`); demolish and inspect open no panel. `index.html` picks v2 before
  the first paint. Checked at 1280x720 with no overlaps or spills (a3b9757).
- Person Creator rebuilt as create-a-person: rail of categories → page icons → one
  page; numbered face presets; galleries; icon sliders.
- The game boots on an empty map. "A vila" is gone from the menus;
  `clearOldMapsOnce()` in `main.ts` wiped the old saved maps once
  (`roadcraft.mapsCleared=2026-10-04`).

### Roads and terrain
- Freeform roads; road snapping on by default (`editor/snap.ts`: on/off, angles,
  length in whole 8 m zone cells). Zone cell 8 m, depth 4 cells. Road widths kerb
  to kerb with footways: local 9.6 m, urban 12.8, avenue 18.4, boulevard 24.
- A raised road drawn in one stroke comes out continuous; a crossing joins, passes
  over with clearance, or is refused.
- Terrain brush is opacity per stroke (strength 1-160); a cut deeper than 18 m is
  bored as a tunnel; water floods adjacent basins.
- Pedestrian walkways graph (`world/walkways.ts`) and the cross-section model
  (`world/section.ts`, NACTO zones) exist; the section is not yet stored on
  `RoadSegment`.

### Buildings and town
- Builder: non-destructive blocks with booleans (union, void, intersect, xor),
  extrude, inset, offset, bevel, point mode, facade scopes (bay, row, column,
  floor, face, block), basic shapes, interior cut view with cores.
- Build from reference: Builder > Mass > 3D reference reads a GLB into blocks,
  facade and lantern (`editor/fromReference.ts`).
- Lot planner (`editor/lotPlan.ts`): front, side and back zones, parking, drives,
  gates, surfaces; walls, fences and paths follow the ground in 2 m steps.
- Default town (`world/defaultTown.ts`, `world/town.ts`): each block keeps its court
  or park in the middle. The block-interior commits b0dea6d, ca7c8a3 and 1484b62
  were rejected by the player and reverted in 429e098.

### People and city life
- Pedestrian engine by default: People (ORCA, `sim/people/people.ts`). The Detour
  crowd engine runs only with `?people=crowd`; the old model with `?peds=legacy`.
- People are MakeHuman bodies (Rocketbox removed in 64ecfa1), with all 453
  community items importable in the Creator; the street wardrobe is
  `wardrobeSelection.json`. Bodies are cooked ahead (`npm run cook:people`,
  `cooked/people`). Faces use 13 ARKit channel morphs.
- Residents live, work, shop and travel (`sim/city/`): walk, drive kerb to kerb,
  park and walk to the door; clock 1 s = 20 game s from 06:30; indoor life by
  hour; windows lit per room; day and night with bloom and a film grade.

### Vehicles
- Drive v2; cars stop at the kerb with doors and occupants; a signal stage holds
  only movements that cannot meet (one approach at a time on two-way crossroads);
  turn-taking with pedestrians at zebras.

### Performance
- Buildings batched per 240 m cell; people simulated in full only where the camera
  looks (`SimWorld.focus`); person LODs in a worker; far facade parts flat; one
  citizen shader program; texture upload queue. Rush-hour bench, best of 3
  (headless, Intel iGPU): overview 16.6 ms, street 16.7, close 16.7, 4x 17.6.
  Graphics are what the player chooses: the automatic quality governor was
  removed. There is no loading screen.

## Open, by area

- **Zoning:** the zoning grids of neighbouring roads overlap (one road's cells cover
  the other's). The player's next order: implement zoning on a new city.
- **Interface:** the selection panel (Builder inspector) is still text fields; face,
  expression and shape detail sliders still carry short text labels; facade
  pattern thumbnails arrive late.
- **Buildings:** a building made from a reference is not selected after it is built
  (`buildingsWiring.ts`); column galleries are not read as such; no clock on the
  Banespa front; no free vertex sculpting; interior partitions cannot be edited;
  raising a building's height takes about 10 s (player report, not investigated).
- **Town:** reads as a rigid procedural grid; relief barely visible in it; the works
  forecourt is a large grey car park. Block interiors: not to be touched without
  the player's explicit design.
- **People:** the player still reports faces, animation and people bumping into each
  other. The 2026-10-02 audit of zebra deadlocks and crowds
  (`permission.ts` courtesy timer against `admission.ts`, one wait point per gate,
  fixed crossing cost, ghosting after being stuck) was partly applied and never
  measured: `tests/sim/agents/defects.spec.ts` was not run afterwards. The
  agents' laboratory (`sandbox.html`, `src/sandbox/`) never reached the street
  pedestrians.
- **Open decision for the player:** which pedestrian engine is the future. The
  Detour crowd engine (`?people=crowd`) was ordered as the replacement and its
  skill says never to patch People; since 2026-10-02 fixes went into People, the
  default.
- **City life:** interior editor (place, move, rotate, remove furniture and lights);
  floor plans for all base buildings; more actions (lie down, carry, fall, read,
  hold hands, drive for real, open windows).
- **Performance:** body-loading hitches in the first ~30 s; next candidates are the
  simulation in a worker and animation shared per skeleton.
- **Tests known red before any recent change:** `tests/world/walkways.spec.ts` (8
  failures); `tests/sim/kerbStops.spec.ts` takes over 200 s.
- **The 14-stage plan of 2026-10-01** (`docs/handoff/master-plan.md`): stage 0 done
  (1c431c3); stage 1 partly (`section.ts`, `walkways.ts`). Work since 2026-10-02
  has followed the player's direct orders instead; ask the player before resuming
  it in order.

## The player's standing decisions

- Interface: icons and tooltips, no names written on everything; no panels with
  vertical scroll; small panels; the look of Cities: Skylines II and professional
  builders. Never call interface work done without full-size photos, checked at
  an emulated 1280x720 with a DOM overlap and overflow audit.
- Town: no empty ground inside blocks, but the courts and parks in the middle of
  the blocks stay; never put new buildings in the middle of a block.
- Objects follow the terrain ("o objeto acompanha o terreno").
- The player chooses the graphics quality; no loading screen.
- Assets: download whatever the work needs without asking. MakeHuman community
  packs: import them, keep ordinary pedestrians plausible (no weapons, horns,
  fantasy skins or masks on the street; those only in the Person Creator).
- Never raise licences, credits or attribution with the player; record a licence
  silently in metadata when a tool needs it.

## This machine

- The player's game: `vite preview` of `C:/Codex-Shared/road-play-dist` on 4180,
  built with `npx vite build --outDir C:/Codex-Shared/road-play-dist --emptyOutDir`
  from a clean worktree of HEAD (junction `node_modules`, and copy `cooked/` and
  `public/models/people` from the main tree, or the cook fingerprint fails).
- The player's data on 127.0.0.1 storage is theirs; test on another origin
  (localhost) and never overwrite it.
- Headless Chrome renders on the Intel UHD 770; the player has an RTX 3060 and an
  i9-12900K. A visible slowdown that only the player sees: check `chrome://gpu`.
- Old scratch files (root `zz-*`, `.claude/_*`, untracked `zz*` scripts and specs)
  were moved on 2026-10-04 to `C:/Codex-Shared/Road-archive/2026-10-04/`, with the
  same relative paths. Superseded agent memories are in the memory folder's
  `archive/`.
