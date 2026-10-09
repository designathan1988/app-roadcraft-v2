/**
 * Route searching allowed per simulation tick, in triangles expanded.
 *
 * Detour bounds the path work of a crowd the same way: its path queue runs at
 * most `MAX_ITERS_PER_UPDATE` search iterations an update, and an agent whose
 * request has not come up yet waits for it (`dtPathQueue::update`).
 *
 * The navmesh search that spent this allowance went with the navmesh
 * pedestrian engine (2026-10-08). The allowance stays because the simulation
 * step refills it (`sim/pipeline.ts`) and the residents kept in
 * `src/backup/residents` (`sim/city/life.ts`) ask for it; with nothing
 * spending it, it is always full. Both lines go when neither needs it.
 */
const PATH_WORK_PER_TICK = 6000;
let workLeft = PATH_WORK_PER_TICK;
/** A new tick: the route searching allowance is full again (`sim/pipeline.ts`). */
export function refillPathWork(): void { workLeft = PATH_WORK_PER_TICK; }
/** Whether route searching this tick has work left for a route that can wait. */
export function pathWorkLeft(): boolean { return workLeft > 0; }
