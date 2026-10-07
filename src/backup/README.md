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
