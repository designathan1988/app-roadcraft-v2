# Performance audit, 2026-10-03

## Method

Chrome on the local GPU, 1600 × 900, the sample town, fixed cameras in `scripts/bench-render.mjs`, and memory from `scripts/probe-memory.mjs` after forced GC. Memory and frame numbers describe this machine and these scenarios, not a universal frame-rate guarantee. The baseline ran without cooked people; final frame measurements ran with cooked people, so frame-time differences include that asset preparation. An uncooked after-run is also reported for the closest memory comparison.

## Confirmed findings

- Character meshes were already instanced and hidden when a batch contained no visible person. Walkers, vehicles and indoor figures were already filtered by zoom and view. The main defect was unconditional preparation of all 84 character models after startup, followed by lifetime retention even on an empty map.
- The initial town after 30 seconds retained 84 models, 395 MiB of baked animation arrays, 237 MiB of scene geometry arrays, 1,404 MiB of JS heap, 428 renderer geometries and 567 renderer textures. The empty map still retained all 84 models and 395 MiB of animation arrays.
- With visible-demand loading and the same uncooked asset path, the town after 30 seconds retained 52 models, 260 MiB of animation arrays, 186 MiB of scene geometry arrays and 1,080 MiB of heap. With cooked assets in the final run, the town retained 52 models, 256 MiB of animation arrays and 1,051 MiB of heap. In that 120-second load/empty/return run, an empty map retained zero models and zero animation arrays, with 47 renderer geometries and 85 textures; returning to the town reloaded 47 models and displayed 46 active citizen meshes (102 active instances at the sample instant).
- Garden and scenery foliage stayed hidden after returning from map zoom because `setMap(false)` never restored it. The state transition now restores those meshes and skips repeated geometry/visibility writes between zoom changes.
- The heavy simulation fixture averaged 21.94 ms per tick; pedestrian simulation accounted for 13.949 ms. That engine is owned by the separate crowd workstream and was not changed in this branch.

## Frame profile

| Camera | Baseline GPU / CPU draw / median frame | Final GPU / CPU draw / median frame | Calls / triangles, baseline → final |
|---|---|---|---|
| Overview | 9.17 / 7.55 / 16.7 ms | 8.45 / 4.17 / 16.7 ms | 467 / 4.80 M → 479 / 5.37 M |
| Street | 11.05 / 10.55 / 17.2 ms | 7.49 / 3.20 / 16.7 ms | 275 / 6.93 M → 273 / 6.71 M |
| Close | 5.67 / 3.15 / 16.6 ms | 6.23 / 1.86 / 16.6 ms | 113 / 1.46 M → 117 / 1.52 M |

The frame median is display limited near 16.7 ms. The added overview geometry is restored foliage. GPU/CPU measurements vary with asset readiness and activity on the shared computer; they are evidence of no clear frame regression in these views, not proof of the exact percentage speed-up.

## Verification and remaining work

- `node scripts/cook-people.mjs --base=http://127.0.0.1:4190`: 84 cooked people, 233.9 MB, 63 seconds. `npm run build:raw` then passed.
- Targeted citizen locomotion and occupant tests: 18 passed. Typecheck and lint of touched production modules passed.
- `npm run check` stopped at 220 lint errors in existing diagnostic scripts. The coverage suite reported failures in crowd scenarios, walkway geometry and a pedestrian scenario before being interrupted after several minutes; none of those files was edited here.
- `node scripts/verify-visual.mjs` completed its geometry and scene scenarios but failed the fixed-time vehicle-occupant sample. Diagnostic sampling found one active citizen mesh 300 ms after framing the moving car, none five seconds later, and two after another 15 seconds. The car moves out of the tight 30× camera view; the current verifier's single delayed sample cannot distinguish timing from missing representation. The verifier remains red and this needs an evidence-based repair within the test policy.
- The initial JavaScript entry chunk is 3.87 MB minified (1.64 MB gzip). The next asset-specific investigation should measure whether code splitting reduces startup cost. KTX2 conversion needs a texture-specific memory/bandwidth profile and a cooked transcoder path; it was not applied without evidence.

Sources and architectural rationale: [citizen visual lifetime research](../research/citizen-visual-lifetime.md).
