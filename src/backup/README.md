# Backup

Systems taken out of the game, kept here for reference only. Nothing in this
folder is compiled, linted, tested or loaded by the game (`tsconfig.json`
excludes `src/backup`, `eslint.config.js` ignores it, vitest runs only `tests/`,
and no game module imports it).

- `crime/` (taken out 2026-10-06, the player's decision): thieves in the
  streets and the police after them. `crime.ts` was `src/sim/agents/crime.ts`,
  run every step from `CityLife` (`src/sim/city/life.ts`), with the agent card
  showing "ladrão" and the crime phase; `crime.spec.ts` was
  `tests/sim/agents/crime.spec.ts`; `crime-shots.mjs` was
  `scripts/crime-shots.mjs`. Bringing it back means wiring it into `CityLife`
  again (the step, `hold`/`isHeld`, the agent view's `thief` and `crime`, the
  card and the `agent.thief`/`agent.crime.*` texts in both languages).
- `residents/` (taken out 2026-10-08, the player's decision: "pode ser
  mantida, porém não pode ficar ativa no jogo e nem no mesmo código"): the
  residents' days and walking the city as one of them. The game's people are
  the scenery's life (`src/sim/ambient`), with the agents' walking engine
  (`src/sim/agents/walk.ts`) - which the residents walked with too and which
  stays live. Each file keeps its old path under `residents/`:
  - the days: `sim/city/life.ts` (`CityLife`: homes, jobs, diaries, trips,
    bus drivers, riders, the player's hooks) and `sim/city/population.ts`;
    `sim/agents/mind.ts` (needs, places, choices), `sim/agents/activities.ts`
    (what they do inside), `sim/agents/cars.ts` (their own cars and the car
    trip's tasks) with `sim/agents/manoeuvre.ts` (the curves in and out of a
    bay) - the traffic system only they used; `render/indoors.ts` (people
    drawn inside the cut floors; its room lamps stayed live as
    `render/roomLamps.ts`), `ui/agentCard.ts` (the card of a clicked
    resident);
  - walking the city as a person: `play.ts`, `sim/ambient/play.ts`,
    `sim/agents/player.ts`, `ui/playerHud.ts`. The Actions (pistol and bomb on
    people, cars and buildings) were NOT part of it and stay live;
  - their specs (`tests/...`) and probes (`scripts/...`).
  What stayed in the game in their place: `src/sim/city/city.ts` (`City`:
  the time of day, the public transport - buses now run without a resident
  at the wheel - and the edge traffic flag). Bringing them back means:
  `SimWorld.city` a `CityLife` again (or `City` owning one), `main.ts`
  installing it (`useAgents`, `density`, `maxWalks`, `doorsPerMinute`), the
  bus drivers in `transit.ts` (`hireDriver`/`releaseDriver`), the residents'
  car zones in `walk.ts` (`ASK_WAY`, `carSweep`, `crossesFootway`), their
  off-road cars in `render/agents.ts` and `playEffects.ts`, the people inside
  in `render/agents.ts` (`indoor`), the lit windows in `renderer.ts`
  (`updateLitRooms`), the card and its `pickAgent` in `main.ts`, and the
  people thrown out of a bombed building (`strikeAt`, `city.inside`).
