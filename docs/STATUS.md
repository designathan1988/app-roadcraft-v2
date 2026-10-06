# Roadcraft — status

The one place for what is live in the game, who owns which area, what is open, and
the player's standing decisions. Every session reads it at the start of a task and
rewrites its own area's lines when they change (no appended logs; git keeps the
history). Rules of work are in `CLAUDE.md`, not here.

Last full rewrite: 2026-10-04 19:10; old docs, handoffs and audits removed 2026-10-05.

## Who works here

One Claude session works on this repository at a time (the player, 2026-10-04),
on `master` in `C:/Codex-Shared/Roadcraft`, pushed to `origin`
(github.com/designathan1988/app-roadcraft-v2, branch `master`).

**Work under way:** the agents engine (GTA + The Sims; not LLM agents, the
player's decision of 2026-10-04): every resident a persistent agent with their
own car, replacing the three pedestrian engines and the cars that appear from
nowhere. The player approved deleting the old engines once the new one is live
and they have seen it.

- **Slice 1, LIVE (default since slice 5)** (b3ef7ab, 0090c88; on 4180 since
  2026-10-04 20:47): a car owner's car stands in a real bay of the lot behind
  their building (`sim/agents/parking.ts`); they leave by the back door, get
  in, back out, follow the lot's aisles out (`lotNav.ts`), drive in the
  traffic, park nose first in a bay near where they go, get out, and go in by
  the back door or along the footway. No car is made or deleted at the kerb.
  Clicking a resident or their car shows their card (doing, why, going to,
  home, work, car) with a follow-camera button. Measured:
  `tests/sim/agents/ownCars.spec.ts` (6/6 chains, 0 jumps, 0 car bodies in
  walls, 0 cars not owned by a resident). Photos: `scripts/agents-shots.mjs`,
  `scripts/agent-card-shots.mjs`.
- **Slice 2, LIVE (default since slice 5)** (6957f58): needs (hunger, energy, fun,
  social, hygiene) run down by the hour; places advertise what they give and
  when they are open (`sim/agents/mind.ts`); a resident free of work or school
  goes where need, distance and the hour weigh most. The agent card shows the
  need bars. Measured: `tests/sim/agents/mind.spec.ts`.
- **Slice 3, LIVE (default since slice 5)** (2026-10-05): the agents walk with
  their own engine, `sim/agents/walk.ts`, instead of the People engine: lanes on
  the footways of `world/walkways.ts` (SUMO's striping: the stripe with the
  most room, keep right, speed from the gap ahead, a sidestep when held up),
  the body following a point ahead (never a jump, a backward or a sideways
  step), zebras waited for at the kerb by the same rule and signals the cars
  keep, a crowd leaving one building coming out one after another. Measured:
  `tests/sim/agents/walk.spec.ts` (default town, 17:00, 150 s: 211 walks, 0
  jumps, 0 backward, 0 slides, longest hold 6.8 s, kerb waits up to one
  signal cycle). Photos: `scripts/walk-shots.mjs`.
- **Slice 4, LIVE** (2026-10-05): a car owner keeps their car in the lot
  behind their building or, failing that, in the free bay nearest their door
  within a minute's walk (a lot down the street or a kerb bay); with no bay
  near home they keep no car and walk (Cities: Skylines II's rule: the bays
  are the cars a town can hold). The default town is now laid with parallel
  parking along both kerbs of its local streets, its lots set back from the
  street with its parking lanes: 761 buildings, 2004 residents, 580 cars
  (was 80 with no street parking). A kerb bay whose joining point falls behind
  it (near a street's end) is not used: the car would turn on the spot.
- **Cars and walkers on the footway, LIVE (default since slice 5)** (2026-10-05):
  a car leaving or entering a lot crosses the footway square in front of the
  lot's edge (it used to run metres along it to a joining point kept clear of
  the junction); it takes the ground of
  the rest of its manoeuvre in turn with the people, as a zebra is taken
  (`OwnCars.holdWay`): it waits until nobody is on it or about to step on, then
  drives it without stopping, the walkers keeping off it, those already on it
  walking off; a car kept waiting 3 s has the walkers give way. Parked and
  manoeuvring cars are solid to walkers. Measured: `walk.spec.ts` second test
  (18 cars across footways, 54 walkers sent through them: 0 body-ticks inside a
  car, everybody arrived).
- **Road ends, LIVE (default since slice 5)** (2026-10-05): across the end of a
  street that leads nowhere an unmarked crossing joins its two footways
  (`Walkway.unmarked`); a walker takes a gap in the traffic there (the time
  across plus 2 s, no margin after 30 s waiting) and no car is put on the map
  onto people crossing there. The player's city went from 24 walking pieces to
  16 (each lone street now one). Measured: `walk.spec.ts` third test (a
  street with traffic at the default: 18 crossings, 0 inside a vehicle, all
  across).
- **Life inside, LIVE** (2026-10-05): residents do things in the buildings
  they are in (`sim/agents/activities.ts`), the furniture advertising what it
  gives (The Sims' smart objects): at home sleep in their own bed, nap, watch
  TV, read, game, cook, eat, snack, wash the dishes, bathe, clean, mend, talk
  with the family, look after the children, exercise; in their lot garden,
  swim, sit out in front, wash the car; at work their post by trade (desk and
  computer, machine, checkout, shelves, stove, bar, reception, blackboard,
  ward, altar, guard, cleaning), pupils at their desks; out, what the place is
  for (dine, drink, dance, shop and pay, bank, cinema, pray, gym, library,
  wait), or a friend's sofa. Two needs were added: `environment` (the home
  kept) and `errands` (bank, post, council, shopping). The renderer draws each
  of them at their piece, in their pose (`render/indoors.ts`); people in their
  lots are drawn always. A building opened (two clicks) now has a floor bar in
  the game's own interface (`ui/insideBar.ts`). `CityLife.skip` no longer runs
  needs down for the hours skipped. Measured: `tests/sim/agents/activities.spec.ts`
  (03:00: 1110 asleep; 09:30: workers at posts; evening: 20+ different doings;
  no piece held by two). Photos: `scripts/life-shots.mjs`. Not yet: a walk across town takes game
  hours (20x time, 1.34 m/s), so fewer reach work than are due.
- **A person in the player's hands (GTA), LIVE** (2026-10-05): the agent
  card's Control button takes any resident (walking, driving, or inside a
  building: out of the door) into the player's hands (`sim/agents/player.ts`,
  `ui/playerHud.ts`): WASD/arrows along the screen, Shift to run, F talks with
  the person in front (both stop, face each other; their social need is met),
  Space hits (they fall and everybody round runs off; some hit back), E gets
  into the nearest car - parked, or in the traffic (its driver pulled out,
  walking off) - driven as a kinematic bicycle, crashing on walls and
  vehicles, knocking down people; Esc lets go (they walk home). Crimes seen
  put stars on (GTA's wanted level); out of sight they go one by one; the
  residents on duty at the police stations run after the player and arrest
  them on foot. Children do not drive. Measured: `tests/sim/agents/player.spec.ts`;
  photos: `scripts/player-shots.mjs`. E by
  a door (nearer than any car) takes them in: they are in the building as
  anybody there, doing what it is for (shopping at a supermarket, dining at a
  restaurant, at the bank's counter, paying at a bakery, a sofa at a home),
  and that meets their needs; the HUD shows "Dentro: <lugar> . <atividade>";
  E brings them out at the door (`CityLife.enterAs`/`leaveAs`). Not yet:
  police cars (officers run), weapons.
- **Public transport, LIVE** (2026-10-05): a Transport category in the dock
  (`editor/transitTools.ts`, `ui/v2/shell.ts`) lays out bus stops on the
  footways (a click by a street), bus terminals, train tracks (clicks, a
  double click or Enter ends; a track may cross streets but not run down one),
  metro tracks (under the ground), train and metro stations on their tracks,
  and lines (stops clicked in order); the lines are listed with their
  vehicles (+/-) and can be deleted; all saved with the map
  (`world/transit.ts`, `RoadDoc.transit`) and undoable. Buses run in the
  traffic from stop to stop (`sim/transit/transit.ts`), standing at each
  (longer at a terminal), out and back; trains and the metro run along their
  tracks, stopping at stations, keeping their distance. Residents without a
  car going far walk to a stop, wait there (standing at it), board, get off
  at their stop, walk on. Level crossings close for a train (the traffic
  stops short, `vehicles/obstacles.ts`; walkers keep off the track ahead).
  Drawn (`render/transit.ts`): tracks on ballast and sleepers (rails alone
  across a street), platforms with canopies, metro entrances, bus shelters
  at the kerb with the line's colour, trains in their line's colour.
  Measured: `tests/sim/transit/transit.spec.ts` (buses serve stop after stop,
  trains stand at stations, residents carried, nobody and no vehicle inside a
  train). Photos: `scripts/transit-shots.mjs`.
  Not yet: transfers between lines, fares, trains with windows.
  Rails near a junction: traffic waits for the junction before the track,
  never on it (`TransitSim.crossingNearEnd`, used by `vehicles/obstacles.ts`
  and `intersections/admission.ts`); walkers keep off a train's run of the
  next 7 s, and off a train about to leave a station.
- **Nannies and bus drivers, LIVE** (2026-10-05): a family whose adults all
  work, with a child, has a nanny (one family in two): an adult without a job
  from a home within 500 m (`population.ts` `hireNannies`). In their hours,
  at the family's home, they look after the children, clean and cook, turn
  about through the day (`activities.ts`, the posts of a home). Every bus of
  a line is driven by a resident (`CityLife.hireDriver`): an adult without a
  job, at home, living nearest the line's first stop, taken off their day
  while the bus runs, home again when it comes off; they are the person drawn
  at the wheel, and a click on the bus opens their card ("motorista de
  onibus", "Dirigindo o onibus da linha N"). Measured:
  `tests/sim/agents/jobs.spec.ts` (nannies at the family home doing childcare,
  cleaning, cooking) and `tests/sim/transit/transit.spec.ts` (buses driven by
  residents).
  Not yet: train and metro drivers, taxi drivers, a photo of a nanny indoors.
- **Crime in the streets and the police, LIVE** (2026-10-05): one adult in
  25 is a thief (`sim/agents/crime.ts`). From 13:00 to 23:00 a thief leaves
  where they are, follows somebody walking near, robs them (the victim
  falls), and runs for home. Round the robbery, the behaviour zones of
  Hitman's crowds: close by people run off, farther they stop and look. The
  victim calls the police: the nearest officer on foot patrol (half of those
  on duty walk beats of up to 1.2 km round their station) or one from the
  station runs after the thief; one who catches up arrests them, both walk to
  the station and the thief is held 8 game hours (`CityLife.hold`). A thief
  home first got away. The agent card shows "ladrão", the phase (robbing,
  running, arrested, held) and officers on patrol or in a chase. Measured:
  `tests/sim/agents/crime.spec.ts` (robberies, witnesses, officers out,
  arrests held at a police station). Not yet: police cars, weapons, uniforms
  (officers look like anybody), burglary of houses, car theft by NPCs.
- **Cycle lanes (ciclofaixa), LIVE** (2026-10-05): a band by the kerb can be
  `cycle` (`world/parking.ts`): painted red with a solid white line
  (`world/parkingLayout.ts`). The road tool offers "Ciclofaixa dos dois
  lados" and "Ciclofaixa a direita, vagas a esquerda"; the road panel sets
  each side. The new town's east-west local streets have one on the right
  (`world/defaultTown.ts`, `maps/cidade-com-estacionamento.json`). Bicycles
  on the lane beside it ride inside the band, easing back to the lane near
  the corners (`sim/vehicles/cycleLane.ts`, `sim/pose.ts`); cars of that
  lane pass them instead of following (`vehicles/leaderIndex.ts`). One in
  three residents without a car cycles to places 200 m to 1.6 km away (farther:
  transit), gets off at the kerb and walks in (`CityLife.start`, trip mode
  `bike`); clicking the bicycle opens their card ("De bicicleta ate ...").
  Measured: `tests/sim/agents/cycleLane.spec.ts` (bicycles in the band, cars
  pass them, no overlap, residents ride and get off). Photos:
  `scripts/cycle-shots.mjs` and the app.
  Not yet: two-way cycle tracks, bicycle parking, bicycles at give-way
  priority over turning cars.
- **By design, not missing:** every person on the streets is a resident (no
  passers-by made up); car owners without a bay near home walk; with
  residents there is no generated traffic, so no buses run (the game has no
  bus lines: public transport for the agents would be a new system: lines,
  stops, the choice to ride); roads that touch no other road stay separate
  places for walkers (nobody walks over open ground).
- **Slice 5, LIVE by default** (2026-10-05): the game runs the agents with no
  flag; `?agents=0` (or `?people=crowd`, `?peds=legacy`) brings back the old
  engines.
- **Next:** People, the Detour crowd flag and `sim/peds` deleted once the
  player has seen the agents and says so.

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
- **Universal grid (2026-10-05):** cells of 10 x 10 m cut into 1 m subdivisions
  (`world/grid.ts`). Road profiles in whole metres, footway to footway: local
  6 + 2 x 2 = 10 m, urban 8 + 2 x 2 = 12, avenue 14 (4 x 3.5) + 2 x 2 = 18,
  boulevard 18 (4 x 4 + 2 m median) + 2 x 3 = 24, highway 18 + 2 x 1, ramp 4 + 2 x 1.
  Authored sections round to whole metres. Zone cell 10 m, depth 4 cells (40 m).
  Road snapping on by default (`editor/snap.ts`: on/off, angles, points on the
  1 m grid - start and end -, length in whole 10 m cells), all four in the road
  tool's options.
- **Junctions are solved once, on the kerb line** (`world/junction/derive.ts`):
  kerb, footway and verge are offsets of the carriageway's outline, cut at the
  same trims; the kerb follows the return concentrically; the back of the
  footway and the verge turn a square corner (rounded where a square would
  pinch the footway, at acute bends). Kerb returns flattened at 8 mm.
- **Heights:** 15 cm precast kerb (15 cm wide), footway level with it, the
  verge a grass batter from the footway down to the drawn ground (no wall);
  ground beside a road laid 10 cm under the carriageway, pulled 60 cm under it
  only beneath the road. Lane lines stop at the stop line.
- **On-street parking (2026-10-05), parallel to the kerb only** (the player's
  decision): per segment and side (`RoadSegment.parking`, `world/parking.ts`),
  a 2 m lane inside the kerbs, 6 m bays (`world/parkingLayout.ts`) following
  the road round curves, clear 5 m of junction kerb lines and of crossings and
  in front of lots that hold parking, yellow no-parking line elsewhere along a
  parking kerb. Paint (ef567e3): the lane's inner edge DASHED (MER, MBST vol. IV
  7.3), closed at both ends of a run, a division line between every two bays.
  Chosen in the road tool (none / both sides / right / left) and per segment
  in the inspector. Old maps' 45/90 degree values load as parallel.
  Agents park in street bays too (`sim/agents/parking.ts`
  `kerbBays`): the car stops beside and ahead of the bay, backs in, and drives
  forward out (`manoeuvre.ts`); `tests/sim/agents/kerbParking.spec.ts`.
- **Nothing is generated on streets or terrain (ef567e3, the player's order of
  2026-10-05):** no automatic lamps, street trees, benches, bins, hydrants, post
  boxes, median shrubs, no trees or bushes scattered over the land or along the
  roads, no pole lines in the default town. Grass remains; building gardens remain.
- **Landscaping tool** (Paisagem > Paisagismo, key G, `world/landscape.ts`,
  `RoadDoc.landscape`): tree, shrub, bench, bin, street light, hydrant, post box,
  placed only on footways, in the furnishing zone by the kerb; refused on grass,
  asphalt, narrow footways, occupied spots and crossing landings. Saved with the
  map, undoable; Shift+click or bulldoze removes. `streetFurniture()` now lists
  only these (it is what pedestrians walk round).
- **Wire poles on footways only** (`editor/poles.ts`): both ends on a footway or a
  pole; the run follows the footway line and turns corners along the footways
  (shortest path); cross-arms framed by line standards (`world/utilities.ts`
  `poleArms`: square on tangents, bisector on small angles, one arm per line at
  corners of 60 degrees and over). Pole lights: none / every other / all, in the
  tool's options; the lamp reaches over the street and lights at night.
  Not yet: two poles stand a few metres apart at an inside corner (one per street).
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
- **Performance pass of 2026-10-05 (LIVE):** people re-cooked (the cook was
  stale: every body was built during play); half the residents
  (`CityLife.density = 0.5` in `main.ts`, 1071 in the parking town), at most 90
  on foot, two out of a door per game minute (`doorsPerMinute`); walkers' grid
  keyed by numbers and the parked cars' zones on a grid (`walk.ts`, pedestrians
  2.2 -> 0.8 ms/tick); indoor and yard figures listed only when drawn; empty
  blast batches hidden (were drawn and uploaded every frame); the shader
  warm-up no longer draws its meshes (it caused 3.4 s of stalls at boot);
  building gallery photos taken when the Builder opens, 6 ms a frame; road
  edits: lots replanned 450 ms after the last edit, water rebuilt only near
  water, Clipper2 first for polygon booleans (Martinez as fallback), grids for
  bays/walls/footprints, paving rings cached. Headless iGPU, rush hour: CPU
  draw 11.1 -> 5.0 ms overview, 6.8 -> 2.2 street; worst frame per road edit
  ~1 s -> ~0.45 s. Photos: `docs/audit/2026-10-05/perf/`. Open: the conflict
  zones of new junctions (~0.1 s each) and the lots raster (~0.25 s, after
  the edit) still stall a frame; a road joined to the network can move the
  grade of every street, which re-meshes the whole town once.

## Open, by area

- **Human generator (`human-generator.html`, the player's request of 2026-10-06):**
  a realistic, parametric human generator in its own page, people, hair and
  clothes all generated from parameters (plan: base, body, hair by Hair Meshes,
  clothes by GarmentCode-style sewing patterns draped by XPBD). The MakeHuman
  bodies and the SDF "toon" heads were rejected by the player. Slice 0 (base
  choice) is in the page: CharMorph's Vitruvian (37k quads, 4K skin textures,
  sex/ancestry/age down to a baby, 148 expressions) beside Meta's MHR (shape
  from 7,110 scans, no texture or eyes), converted by `scripts/build-human-base.py`
  (Blender 5.2, sources in the session scratch, not in the repo) into
  `public/models/humans/<base>`. Waiting for the player to choose the base.
- **Procedural people (`people-lab.html`, branch `claude/sandbox`, not in the
  game yet):** one MakeHuman body per class (sex x age band), shape as 16 PCA
  coefficients summed on the GPU, joints follow the shape, clothes/hair as
  separate instanced pieces (`src/render/people/proceduralCrowd.ts`). Bodies,
  limbs and clothes are fine. **Hair grown from scratch
  (`src/people/hair/procedural.ts`) is NOT good enough close up** after many
  rounds (2026-10-05): cards from guide curves with a painted strand atlas
  read as shingles/planks, the hairline as a hard visor, the volume flat. What
  was learned: tuning the guide growth does not fix it; game-quality card
  hair is a groom of thousands of strands RENDERED into the card textures
  (Unreal Hair Card Generator, Houdini Hair Card Texture), and cards laid by
  clumps of that groom - not one texture painted for all. Next attempt
  should: (1) grow a dense strand groom per style (as Mirage Mane does:
  Fibonacci roots, regional lengths, clump to guides), (2) bake it into
  per-style card atlases (coverage, depth, root-tip, ID) offline in a script,
  (3) only then cards. The player rejected curly/afro hair and women with
  shaved-looking sides; stock items audited (see `spec.ts` comment).
  After hair: the player's full list for faces (eyes, lids, lashes, brows,
  skin, mouth, teeth, expressions, variety) is open.

- **Planet (the world as a real sphere): put aside on branch `planeta`
  (2026-10-05, the player's decision).** The game is the flat city again;
  `master` has no planet page. The branch holds `planet.html` and
  `src/planet/` (cube sphere of quadtree patches with skirts, relief on the
  sphere, sea sphere, Google-Earth camera). Open there: the camera rides the
  height of the ground it looks at and re-picks the ground on every move (the
  globe jumps and slips; Cesium keeps the camera's own height and picks once
  per drag), the middle button tilts about a point that may be 45 km away,
  the altitude label is the range, the sky is a flat colour, and the planet's
  scale (13.5 km radius, relief 11% of it) is undecided.

- **Zoning:** the grid is laid a row at a time across every street, and of two
  overlapping cells the one nearer its street keeps the land (ties to the older
  street), as Cities: Skylines' zone blocks do; overlap is a separating-axis test
  (`world/zoneGrid.ts`, `tests/world/zoneGridOverlap.spec.ts`). Every street side
  now has its front row; leftover strips under a cell deep stay unzoned. Open: cells
  are not removed under player-placed buildings; growth sometimes puts a building
  across a junction corner. The player's next order: implement zoning on a new city.
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
- **Decided by the player (2026-10-04):** none of the three pedestrian engines
  is the future; the agents engine replaces all of them (see "Work under way").
  Do not spend more work on People, the Detour crowd flag or `sim/peds`.
- **City life:** interior editor (place, move, rotate, remove furniture and lights);
  floor plans for all base buildings; more actions (lie down, carry, fall, read,
  hold hands, drive for real, open windows).
- **Performance:** body-loading hitches in the first ~30 s; next candidates are the
  simulation in a worker and animation shared per skeleton.
- **Tests known red before any recent change:** `tests/world/walkways.spec.ts` (8
  failures); `tests/sim/kerbStops.spec.ts` takes over 200 s.

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

- The player's data on 127.0.0.1 storage is theirs; test on another origin
  (localhost) and never overwrite it.
- Headless Chrome renders on the Intel UHD 770; the player has an RTX 3060 and an
  i9-12900K. A visible slowdown that only the player sees: check `chrome://gpu`.
