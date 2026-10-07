# AGENTS.md — Roadcraft

Rules for every agent working on this repository. The full rules of work are in
`CLAUDE.md`; what is live in the game is in `docs/STATUS.md`. Read both first.

## Out of scope: crime and the police

The crime and police simulation (thieves robbing people in the streets, officers
on patrol chasing and arresting them) is **not part of the game**. It was taken
out on 2026-10-06 by the player's decision and kept only as a backup in
`src/backup/crime/` (`src/backup/README.md`), which nothing compiles, lints, tests or
loads.

- Do not run, cite or report on it, and do not count it as a failing or
  passing test.
- Do not bring it back, wire it in or change it unless the player asks for it.
- Do not mention crime or police scenarios in reports.
