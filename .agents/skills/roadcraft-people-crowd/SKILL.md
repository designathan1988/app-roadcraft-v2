---
name: roadcraft-people-crowd
description: Continue the Roadcraft pedestrian crowd engine (Recast/Detour, `?people=crowd`) - fixing walking defects, measuring them, photographing them in the game, committing and reporting. Use for ANY work on pedestrians, people movement, crowds, zebras/crossings for people, narrow passages, gait/animation of walkers, or the crowd scenario battery in Roadcraft. Never patch the old ORCA People engine instead.
---

# Roadcraft: the pedestrian crowd engine

The state, the files, the baseline numbers, what was already tried and the known open work are in
`docs/handoff/people-crowd.md`. The player's orders are in `docs/handoff/people-crowd-orders.md`.

## You own the plan

The player decided (2026-10-01): **you work freely.** You decide:
- the order of the work;
- the approach and the technique;
- which measurements to take;
- how to split the work (at most one agent at a time, to save the player's credits);
- when to change course, go back, or rewrite a whole layer because that is the better path.

Every change follows the workflow in the root `AGENTS.md` section 2: reproduce, trace to the
cause, research, plan, then implement and measure. Keep what the measurement and the photos
confirm; when a result contradicts the diagnosis, find the false assumption before trying
anything else. Nobody gives you a task list.

The player decided on 2026-10-04 that neither this engine nor People is the future: the agents
engine (`src/sim/agents/`) replaces both (see `docs/STATUS.md`). Do not start new work here.

**Only two things are fixed:** the GOAL and the INTEGRITY RULES below.

## The goal

Section 8 of the handoff: what the player must see in the game, in the 19 scenarios and in the
player city, with fixed-camera photos as proof. "Done" is that, not a green counter.

## Integrity rules (the player's, not negotiable)

1. **Never cheat the measurement.** Do not change a scenario, threshold, radius, spawn, destination
   or duration so that a counter turns green.
   - If a scenario is objectively wrong, fix it, document the error and keep its difficulty.
   - Changing a threshold needs the player's approval.
2. **Detour is the only thing that moves a body.** No snap, push, teleport, clamp, or position or
   velocity rewrite after `crowd.update`. You may change intent and constraints, the gait, or the
   solver's configuration. You may even replace the solver with an established one if you show it is
   better. What you may not do is add a second physics that corrects the result.
3. **Orientation and animation only READ the velocity.** They never change it.
4. **One coherent configuration** for every situation. No preset per scenario.
5. **Not vehicles** (`src/sim/vehicles`, `intersections`, `signals`): pedestrians first.
6. **Ask the player first** before:
   - switching the default engine;
   - deleting the old engines;
   - changing a threshold.
7. **Prove what you claim.** Battery numbers and photos looked at in the game. Never report from
   numbers alone.

Measuring before changing (reproduce, trace, find the cause) is the fastest way to a right fix.
A quick experiment is a way to test a diagnosis, not a substitute for one: say what it should
show before running it, and keep only what the measurement confirms.

## Save the work

- Commit and push often. Every verified improvement is a commit; do not let work pile up.
- Stage explicit paths only; never `git add -A` or `git add .`.
- Never commit scratch (`zz*`, `.claude/_*`, `*.png`) or other sessions' files
  (`.agents/skills/roadcraft-clothes/`, `docs/codex-prompts-modelos-3d.md`, `docs/audit/2026-09-30/`).
- Write commit messages in English and honestly: what changed, why, numbers before and after, what
  still fails.
- `npx tsc --noEmit` and eslint must be clean on the files you touched.
- Push: `git push origin master:main` (`origin` is github.com/designathan1988/app-roadcraft; `main`
  is the live branch, the remote `master` is stale).
  - Never force-push or rewrite pushed history.

## Do not freeze the player's computer

The player plays on this machine:
- one test run at a time, through `node scripts/test-light.mjs` (one worker);
- at most ONE browser or dev server (`PORT=5180 npm run dev`), stopped when the photos are taken;
- nothing that runs ten minutes or more;
- never stop servers you did not start.

Reading code, reading traces and planning have no limit.

This skill covers the pedestrian crowd engine. What is live, who owns which area and what is open
are in `docs/STATUS.md`; `docs/handoff/codex-program.md` is the history of the 2026-10-01 handoff.

## SHOW the player everything (player's order, binding until the end)

The player cannot see your work: photos you only "view" yourself do not exist for them. From now on,
for EVERY photo or sequence you take:
- Put it in your chat message as an image, using markdown with the absolute path:
  `![what it shows](C:/Codex-Shared/Road/docs/audit/...jpg)`. Also give the path as a clickable link.
  Never open a browser window to show it; the player opens the link.
- Under it, write one or two plain Portuguese sentences: what appears, and what changed.
- Photograph every visible change before calling it done (root `AGENTS.md` section 2). Show the
  player the photos at the end of a batch and at the end of a stage, before and after, with the same
  scene and the same camera.
- Write for someone who is not a programmer. Do not say "ticks", "sampling", "solver" or "filter".
  Say what the person in the game does: "parava e dava ré" → "agora contorna e segue".

## No overhead (player's order: the project must move, not the paperwork)

- Do not write new photo or capture scripts. Use `scripts/crowd-shots.mjs`, `scripts/probe-agents.mjs`
  and `scripts/inspect-scene.mjs` as they are.
- Do not commit JSON dumps next to photos. Do not write a `crowd-step-NN.md` per step: the commit
  message is the report.
- Add a regression test only for a defect that came back or one that is hard to see. Not one for
  every change.
- Do not re-measure what has not changed.
- Most of your time goes into code that changes the game.

## Tell the player what you are doing

The player cannot see your work unless you write it.
- Before each step, say in one line what and why.
- After each result, say what it showed.
- Never go more than 5 minutes silent.

When a piece of work is finished, report in Portuguese, in plain words:

```
O QUE ESTÁ NO JOGO AGORA: <com ?people=crowd / por padrão> ...
O QUE MUDOU E POR QUÊ
NÚMEROS: antes -> depois (bateria, cidade, custo, se medidos)
FOTOS: caminhos dos .jpg e o que se vê
PRÓXIMO: o que você decidiu fazer em seguida
COMMIT: <hash>
```
