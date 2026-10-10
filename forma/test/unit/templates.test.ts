import { describe, expect, it } from 'vitest';
import { TEMPLATES } from '../../src/editor/templates';
import { emptyProject, loadProject } from '../../src/core';
import { buildBuildingParts } from '../../src/geometry/mass-parts';

describe('modelos prontos', () => {
  for (const t of TEMPLATES)
    it(t.name, () => {
      const b = t.build([5, -3], t.name);
      const p = emptyProject();
      p.buildings.push(b);
      expect(() => loadProject(p)).not.toThrow();
      const parts = buildBuildingParts(b);
      expect(parts.walls.length).toBeGreaterThan(0);
      expect(b.styleRef).toMatch(/^builtin:/);
    });
  it('casa térrea: cinco cômodos com nome e portas', () => {
    const b = TEMPLATES.find((t) => t.id === 'casa')!.build([0, 0], 'Casa');
    const names = b.storeys[0]!.rooms.map((r) => r.name).sort();
    expect(names).toEqual(['Banheiro', 'Cozinha', 'Quarto 1', 'Quarto 2', 'Sala']);
    expect(b.openings.filter((o) => o.host.kind === 'wall').length).toBe(4);
  });
  it('sobrado: escada e cômodos nos dois pavimentos', () => {
    const b = TEMPLATES.find((t) => t.id === 'sobrado')!.build([0, 0], 'Sobrado');
    expect(b.stairs).toHaveLength(1);
    expect(b.storeys[0]!.rooms.map((r) => r.name).sort()).toEqual(['Cozinha', 'Sala']);
    expect(b.storeys[1]!.rooms.map((r) => r.name).sort()).toEqual(['Banheiro', 'Quarto 1', 'Quarto 2']);
    expect(b.openings.filter((o) => o.host.kind === 'wall').length).toBe(4);
  });
});

import { scaleFootprint } from '../../src/editor/ops';
describe('redimensionar leva os cômodos', () => {
  it('áreas dos cômodos acompanham a nova base', () => {
    const b = TEMPLATES.find((t) => t.id === 'casa')!.build([0, 0], 'Casa');
    const total = () => b.storeys[0]!.rooms.reduce((s, r) => s + (r.area ?? 0), 0);
    const before = total();
    scaleFootprint(b, 'width', 12);
    scaleFootprint(b, 'depth', 9);
    expect(total() / before).toBeCloseTo((12 * 9) / (10 * 8), 1);
    expect(b.storeys[0]!.rooms.map((r) => r.name).sort()).toEqual(['Banheiro', 'Cozinha', 'Quarto 1', 'Quarto 2', 'Sala']);
  });
});
