import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { landscapeNear, snapLandscape, type LandscapeKind, type LandscapeSnap } from '@world/landscape';
import type { SignType } from '@world/landscape';
import { m } from '@world/units';

/** What the landscaping tool reads of the game and does to it. */
export interface StreetscapeToolHost {
  readonly doc: RoadDoc;
  readonly net: Network;
  zoom(): number;
  /** The item chosen in the tool (`ui/toolChoices.ts`). */
  kind(): LandscapeKind;
  /** What the chosen item carries: a sign's type and text, a street name, a planting date. */
  extra(kind: LandscapeKind): { signType?: SignType; text?: string; planted?: number };
  /** An edit of the document, one undo step. */
  mutate(fn: () => boolean): void;
  hint(key: string): void;
  redraw(): void;
}

/**
 * THE LANDSCAPING TOOL: benches, bins, street lights, trees, signs... placed
 * on the footways, where `snapLandscape` puts them (the furnishing zone by
 * the kerb), Shift-click to take one away. Where the item would go under the
 * pointer lives here, with the handlers that use it.
 */
export class StreetscapeTool {
  /** Where the chosen item would go under the pointer: a ring, red where it cannot. */
  hover: LandscapeSnap | null = null;

  constructor(private readonly host: StreetscapeToolHost) {}

  /** Pick radius for a placed item and the reach of the footway snap, world units. */
  reach(): number {
    return Math.max(m(1.5), 26 / this.host.zoom());
  }

  down(world: Vec2, shift: boolean): void {
    const { host } = this;
    const { doc } = host;
    if (shift) {
      const hit = landscapeNear(doc.landscape.values(), world, this.reach());
      if (hit) {
        host.mutate(() => doc.removeLandscape(hit.id));
        host.hint('hint.streetscape.removed');
      }
      return;
    }
    const kind = host.kind();
    const placed = snapLandscape(host.net, doc.landscape.values(), kind, world, this.reach());
    if (placed.ok) {
      host.mutate(() => {
        doc.addLandscape(kind, placed.at, host.extra(kind));
        return true;
      });
    } else {
      host.hint(`hint.streetscape.${placed.reason}`);
    }
    this.hover = null;
    host.redraw();
  }

  move(world: Vec2): void {
    const { host } = this;
    this.hover = snapLandscape(host.net, host.doc.landscape.values(), host.kind(), world, this.reach());
    host.redraw();
  }
}
