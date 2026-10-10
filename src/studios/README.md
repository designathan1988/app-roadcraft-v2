# Roadcraft creation studios

Six independent, offline HTML editors. They author studio projects and portable
assets; they do not modify the game's document, catalogues or simulation.
Existing HTML laboratories define the visual language: forest header, pale
panels, sage canvas, lime primary actions, Segoe UI and compact controls.

## Implementation plan

1. Test the data contracts, signal conflicts and transitions, route calculation,
   peak demand, transit scheduling, pose interpolation, sound falloff and WAV output.
2. Implement independent validated project types and deterministic calculations.
3. Build the common shell: selection, undo/redo, open/save, local recovery,
   playback, exports, navigation and responsive panels.
4. Implement junction, traffic and transit editing with interactive map previews.
5. Implement PBR material preview/export, articulated pose timeline/glTF export,
   and spatial sound playback/import/WAV export.
6. Bundle six self-contained HTML files using the existing Vite installation.
7. Run focused tests, type and lint checks; exercise all six in the browser,
   including file round-trips, playback, malformed input and a narrow viewport.

## Commands

`node scripts/build-studios.mjs` rebuilds the six HTML files at the project root.
`npx vitest run tests/studios/model.spec.ts` checks the studio calculations.
`node --test tests/studios/model.native.mjs` checks the standalone data model
with Node's built-in runner. `node scripts/serve-studios.mjs` serves the editors
on `http://127.0.0.1:5196` for browser testing.
Open any `*-system.html` listed below directly, or serve the project directory.

| File | Editor | Portable export |
|---|---|---|
| signal-system.html | Junctions and traffic lights | Signal plan JSON |
| traffic-system.html | Traffic and scenarios | Demand JSON, result CSV |
| transit-system.html | Public transport | Line JSON, timetable CSV |
| material-system.html | Materials and surfaces | glTF/GLB, texture PNG |
| animation-system.html | Animation and poses | glTF/GLB with animation |
| sound-system.html | Spatial audio | Sound scene JSON, stereo WAV |

Assumption: "create the six" means standalone editors like the existing labs.
No dependencies are added. Traffic is a route/demand preview, not the game's
car-following simulation; importing these projects into the game is a separate
integration task. Material Studio extends the asset-authoring workflow as a
standalone companion, without changing the existing untracked Asset Studio.
Undo retains at most 60 states and a 16-million-character shared history budget
(one oversized nearest state can remain). Animation export samples the authored
angular path rather than taking a quaternion shortcut between large rotations.
