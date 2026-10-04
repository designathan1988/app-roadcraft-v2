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

## Startup CPU follow-up

The production startup profile transferred about 1.8 MB before the game exposed its scene; the main JavaScript transfer took about 110 ms. Two long main-thread tasks took roughly 6.4 s and 4.5–6.2 s. Source-mapped CPU samples in the first task concentrated in procedural texture baking, pedestrian path search, the region index and vehicle conflict geometry. The second concentrated in shader setup, terrain and building geometry. Splitting the JavaScript bundle alone cannot remove this synchronous work.

`normalMapFrom` spent 15.9 ms for a 512² image and 67.6 ms for 1024² in the browser. Replacing four per-pixel modulo-based neighbour lookups with identical row/edge indices reduced these medians to 11.9 and 44.9 ms. SHA-256 of the resulting pixels remained identical at sizes 1, 2, 7, 512 and 1024. Whole startup after the change measured 9.8 and 12.0 s versus 11.5–13.5 s before; this variation does not establish a precise end-to-end gain.

## Traffic and shoreline follow-up

An 80-seed, 40-operation fuzz hunt completed before changing `world/conflictPoints.ts` (one file passed). A conservative whole-sweep broad phase reduced cold conflict-index builds from 826–836 ms to 819–822 ms on the default town; the focused conflict-zone and cache specifications passed (8 tests). The larger collision specification was interrupted after several minutes under the player's instruction to favour focused tests. A post-change full fuzz hunt remains outstanding.

The water builder dropped entire 4-unit cells at the shoreline. In the same authored river and camera, clipping only mixed cells against the actual bank changed the water surface from 7,960 to 9,404 triangles and removed the square teeth; all 21 focused water tests passed. The before/after images are in this task's local `docs/audit/2026-10-03-shore-*.png` files. The visual result is stronger evidence than the triangle count; terrain and vegetation quality remain open parts of the wider audit.

## Building frontage follow-up

Road validation already held footprints 0.02 world units beyond the outer footway. Road snapping added 0.1 more units and the generated town used a separate 0.12-unit frontage gap. Both now use the validation clearance. In a browser corner probe the placed building was valid with a measured front gap of 0.02 units; 69 focused building tests and three generated-town tests passed. The corner snap still has a fixed six-unit reach: a farther cursor position left a measured 13-unit gap to the second street. That larger corner-placement case remains open and is not counted as fixed by the clearance change.

The corner reach was then replaced with a pointer/footprint check. At the same cursor position, the lateral gap fell from 13 to 0.02 units. The resulting rectangle had zero overlap with the junction's curb. Its distance to one road was `3.6e-15` below the exact threshold solely from floating-point arithmetic; a `1e-9` contact tolerance made the valid placement pass without changing the physical clearance. The new two-case corner specification, 72 existing building/town tests, typecheck and build passed. Before/after images are in this task's local `docs/audit/2026-10-03-corner-gap-*.png` files.

Sources and architectural rationale: [citizen visual lifetime research](../research/citizen-visual-lifetime.md).
