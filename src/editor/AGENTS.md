# src/editor (and main.ts, buildingsWiring.ts) — tools that change the document

Rules for the whole repository are in the root `AGENTS.md`. `main.ts`,
`index.html` and `src/ui/**` are edited by the interface session too: check the
owner in docs/STATUS.md before changing them.

## Couplings

1. **`commitDraft` adopts its work network**, rebuilt after the draft's segments
   are added. Adopting it before that hands back a stale network stamped current.
2. **Revisions:** a road edit moves `doc.revision` (and `trafficRevision` only if the
   road plan changes); a building edit moves `doc.buildings.revision`, never
   `doc.revision`; utilities move `utilityRevision`. The wrong one rebuilds
   everything or nothing.
3. **Road snapping** (`snap.ts` `roadSnap`/`setRoadSnap`, stored in localStorage
   `roadcraft.roadSnap`) works on the universal grid (`world/grid.ts`): points on
   the 1 m subdivision, lengths in whole 10 m cells (`ZONE_CELL`).

## Traps that have already caught someone

- **Every dab of the terrain brush re-solves the whole road network.** Painting is
  rate-limited by what the last rebuild cost (`terrainPaintInterval` in
  `main.ts`), not by a fixed interval.
- **A missing hint key shows a blank hint bar, not an error.** `hintKey` derives
  the key from the tool.

## How to add

- **An editing tool:** in `main.ts` add it to the `Tool` union, a `case` in the
  `pointerdown` switch and a letter in the `shortcuts` map; add a button with
  `data-tool="…"` to `index.html` and its icon and tooltip in the interface
  (`src/ui/v2/shell.ts` presses `.tool[data-tool]`); then `tool.<name>`,
  `hint.<name>` and `hint.mobile.<name>` in both dictionaries. The junction-control
  tool (`cycleNodeControl`) is the smallest complete example.
- **A terrain brush:** `world/terrain.ts` first (see `src/world/AGENTS.md`), then its
  button in the interface, then `TERRAIN_BRUSH_COLOUR` and `TERRAIN_BRUSH_FILL` in
  `main.ts` (or the ring preview throws), then both dictionaries including
  `hint.terrain.<mode>` and `hint.mobile.terrain.<mode>`.
