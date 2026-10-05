# src/sim — vehicles, pedestrians, residents, signals

Rules for the whole repository are in the root `AGENTS.md`. This file lists what
breaks far from where you edit in `sim/`.

## Which pedestrian engine runs

- Default: the People engine, `sim/people/people.ts` (ORCA locomotion, `orca.ts`,
  navmesh `nav.ts`).
- `?people=crowd`: the Detour crowd engine, `sim/people/crowd.ts` and `crowdNav.ts`
  (Recast/Detour). Its state and rules are in `docs/handoff/people-crowd.md` and
  the skill `.agents/skills/roadcraft-people-crowd/`.
- `?peds=legacy`: the old sidewalk-graph model, `sim/peds/`, kept for comparison
  and still installed by `simOf` in the traffic suites.

None of the three is the future: the player decided (2026-10-04) that the agents
engine (`sim/agents/`, `?agents=1`) replaces all of them. Spend no more work on
them; they are deleted once agents run by default and the player has seen it.

## The agents engine (`sim/agents/`)

- `cars.ts`: a resident's own car and the GTA-style task chain of a car trip
  (board, leave, drive, park, alight). The only writer of `Vehicle.free` and of
  an off-road car's doors and kerb stop.
- `parking.ts`: the bays (stalls of `parking` elements), the way out of each
  lot onto a street, the lane each bay is reached from.
- `lotNav.ts`: the grid inside a lot and the distance field to its exits.
- `manoeuvre.ts`: the curves a car drives off the road (reverse out, aisles,
  into the bay nose first).
- `mind.ts`: needs, the places that advertise what they give, and the choice of
  where to go next.
- `walk.ts`: the agents' walking engine (installed by `?agents=1` instead of
  People). Lanes on `world/walkways.ts`, SUMO striping, the body following a
  point ahead, zebras by `crossings/permission.ts`, published to
  `crossingStates` for the cars. The engine object carries `inspect` for
  probes in the page.
- `CityLife` (`city/life.ts`) still runs the diaries; with `cars` set it starts
  car trips through `OwnCars` and never makes a car at the kerb.
- Measure with `tests/sim/agents/ownCars.spec.ts`, `mind.spec.ts` and
  `walk.spec.ts`; photograph with `scripts/agents-shots.mjs`,
  `scripts/agent-card-shots.mjs` and `scripts/walk-shots.mjs`.
  `AGENT_ENGINE=agents` runs `defects.spec.ts` with this engine (its cities
  have few residents, so most of it says little).

## Couplings

1. **One writer per field.** The stage list is in `pipeline.ts`: topology in stage
   0, signals in 1, routes and population in 2, pedestrians in 3, constraints 4-5,
   position and speed only in `integrate` at 6. To write a field from a second
   place you need a new field.
2. **Seat and door numbering:** `vehicles/kerbStops.ts` counts seats with
   `archetype.doorsPerSide`, `render/vehicleModels.ts` with its door edges. They
   agree by construction only; a new body style keeps both.
3. **Population ceilings:** `FLEET_CEILING` and `PED_CEILING` (`params.ts`) also
   size the renderer's instance buffers (`render/agents.ts`).
4. **`HEADING_CHORD`** is shared with `world/conflictPoints.ts` and
   `world/turnPaths.ts` (see `src/world/AGENTS.md`).
5. **The pedestrians' crossing-reservation index** (`peds/crossingFsm.ts`) is built
   at the start of `stepPedestrians` and valid only inside it.

## Traps that have already caught someone

- **`clock.tick` and `clock.time` do not advance under test.** They move only inside
  `SimClock.advance` and `SimClock.run`, and the specs drive `step` directly.
  Behaviour keyed on the clock silently never happens in the suite (that is how
  the lane-change cooldown blocked every overtake). Use the agent's own `age`.
- **`archetype` is the machine; `driver` is the person.** Size, mass and palette
  read the archetype; acceleration, braking, headway, gap acceptance and patience
  read the driver. `driver.bEmergency` is almost constant on purpose: the
  safe-speed cap sizes every following distance from it.
- **A lane change occupies two lanes.** The occupancy index moves at once; the body
  slides across over the next second. `Vehicle.shadow` keeps it in the old lane,
  and `SimWorld.bodiesIn` is what anything asking "is this lane clear here" must
  read, not `rt(id).order`.
- **A signal stage never holds two movements whose cars could meet.**
  `signals/plan.ts` groups approaches from the conflict matrix, so a crossroads of
  two-way streets runs one approach at a time. Pairing opposing approaches brings
  back the permissive left turn the player reported; `tests/sim/fourWay.spec.ts`
  fails.
- **If the vehicle pose in `pose.ts` changes, the sweep in
  `world/conflictPoints.ts` must change with it**; `tests/sim/collisions.spec.ts`
  tells you.
- **Pedestrians face where they are going, not where the body moved.** Facing each
  tick's displacement made every sidestep swing the body (the zigzag) and turned
  a standing person round on still legs. The heading follows the path through a
  turn rate and holds while standing; the renderer steps the feet round.
- **Rejected approaches are recorded** in `docs/handoff/people-crowd.md` and in
  the research notes under `docs/research/`. Read them before retrying an idea
  for pedestrian motion.
