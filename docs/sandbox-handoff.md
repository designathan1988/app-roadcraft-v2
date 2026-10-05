# Sandbox handoff (branch `claude/sandbox`, worktree `C:/Codex-Shared/Road-claude`)

Work done in an isolated worktree from `bd95da9`, each change photographed in
the running game (headless). To bring it to `master`: `git log bd95da9..claude/sandbox`
and `git diff master...claude/sandbox`; the commits are self-contained and in order.

## What changed, by area

- **Wire poles** (`world/poleLines.ts`, `editor/poles.ts`, `render/utilities.ts`):
  the pole line is the kerb outline offset into the footway (Clipper2), one pole
  per corner (RDP), reuse of nearby poles, 3D preview of the run, Build/Remove
  modes, lamp towards the nearest kerb, insulators/braces/cap/transformer,
  wires sway in the wind.
- **Footway edge** (`render/roadSurfaces.ts`, `render/terrain.ts`): the ground
  verge is drawn with the terrain's own material (slope bands off), its fall
  measured from the drawn footway edge; no green strip.
- **Interface**: road centre line only with the Information tool open; panels
  re-render only on real state changes (no flicker); options panel scrolls.
- **Signals** life-size and swaying slightly; **crosswalks** striped along travel.
- **Trees**: lathe trunk with flare and bark; garden shrubs keep proportions;
  planted trees/shrubs grow over 3 city days (`plantGrowth`).
- **Barriers**: double click builds; guardrail and railing at the kerb.
- **Zones** (`world/zoneGrid.ts`, `editor/zoning.ts`): columns run the whole
  street, cells trimmed on the 1 m subgrid, no floating/overlapping cells,
  partial cells join lots, 4 m lots allowed; buildings share party walls
  (`validate.ts` PARTY_WALL) and volumes are clipped to the lot.
- **Lots** (`editor/lotPlan.ts`): gates first and wall gaps only for placed
  gates, refused boundary pieces split, element reserve; real pool (water part,
  coping), richer yards, alleys and shop backs.
- **Terrain paint** (`world/terrainPaint.ts`): splat-map layers stored as dabs.
- **Landscaping**: phone booth, kerb drain, long grass (no automatic grass),
  signs tool (10 types, editable text) and street names with corner plates.
- **Roads**: preview follows terrain, zoning grid shown while drawing, total
  width in 1 m steps, blocks-at-once grid tool.
- **Life**: exhaust smoke and dust, wear of streets/footways with use
  (`render/wear.ts`), buildings decay without maintenance (Shift+click with
  Information renovates), roofs with fascia/soffit/ridge.
- **Destruction** (`render/destruction.ts`): Demolish > Strike with force 1-10;
  buildings break block by block (interior shown), debris, dust, support
  collapse, removal; street craters; people in reach die, nearby flee
  (`PedestrianEngine.impact`).

- **Explosion** (`render/blast.ts`, `main.ts` `strikeAt`): the Strike is an
  explosion of radius `m(2.5 + force*1.1)`: flash, fireball, flames, black
  smoke column, sparks, shockwave, camera shake, rigid debris (impulse
  contacts), crater (road decal + heaved slabs; terrain `lower` stamp on
  earth); every building in reach struck by distance; poles break whole,
  snapped or to splinters, pull neighbours, wires fall as Verlet ropes and
  arc; signal posts in reach thrown and the junction set to `none`; vehicles
  in reach removed and thrown as burning car-shaped shells; landscape items
  removed and thrown.
- **Ragdolls** (`render/ragdoll.ts`): Jakobsen Verlet stick figure driving the
  citizen's own skeleton palette (`riggedCitizens` `capturedPose`/
  `drawPalette`/`clipPose`). Dead never get up; near the centre torn apart;
  knocked people fall, lie, blend into `crouchUp` and get up where they lie
  (`PeopleEngine.getUp`); street trips too. The old stiff `fallLean` is gone.
- **Panic** (`people.ts` `panic`): the scared drop what they do and run by
  route to walkable ground away from the blow at up to 3.4x pace, ignoring
  crossings; `PedView.panic` drives a FACS fear/scream face.

- **People shading** (`people/skinAppearance.ts`): skin wrap lighting with a
  scatter band, Kajiya-Kay/Scheuermann hair highlights, rough cloth, little
  sky reflection; the three r186 lighting strings are asserted. ONE program
  for every dressed person (texture slots are uniforms, blank 1x1 where
  empty) - each new outfit mix used to compile a program (0.5 s hitch).
- **Performance**: zone overlay caches `marksByCell`; wear field uploads only
  changed row stretches (RGBA for three's `updateRanges`); `headPoints`
  inverts once per mesh; resting rubble is not rewritten. Run
  `node scripts/cook-people.mjs` after merging: uncooked bodies are built on
  the main thread (100+ ms hitches).

## Not done / caveats

- A built road on a hill is cut/filled, so it ends flatter than its preview.
- Ruins live in the renderer only (not saved); reloading restores the building.
- Residents inside a struck building are not counted; only walkers near the blow.
