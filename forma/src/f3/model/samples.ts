// Construções de exemplo do FORMA 3 (galeria e projeto inicial).
import type { Building3 } from './schema';
import { building, circlePlan, facadeRule, levelsFor, mat, planVertices, rectPlan, roofSpec, solid } from './defaults';

export function sampleBuildings(): Building3[] {
  const out: Building3[] = [];
  const at = (b: Building3, x: number, z: number) => {
    b.position = [x, z];
    out.push(b);
  };
  const brick = { wall: mat('brick', '#a8553a'), roof: mat('tile', '#7d3f2a'), trim: mat('paint', '#f2eee6'), base: mat('stone', '#9d978c') };
  // Casa de duas águas com uma torre que atravessa o telhado.
  const hp = rectPlan(12, 8);
  const house = solid({ name: 'Casa', plan: { outer: hp, holes: [] }, height: 6.2, roof: roofSpec('gable', { pitch: 32 }), facade: [facadeRule('door-panel', { levels: 'ground', edges: [hp[0]!.id], mode: 'count', value: 1, except: {} }), facadeRule('win-casement', { mode: 'max', value: 3.2 })] });
  house.facade[1]!.except[hp[0]!.id + ':0:1'] = 'none';
  at(
    building({
      name: 'Casa com torre',
      levels: levelsFor(2, 3, 3),
      solids: [
        house,
        solid({ name: 'Torre', plan: { outer: rectPlan(3.4, 3.4, 3.5, 0), holes: [] }, height: 11, roof: roofSpec('pyramid', { pitch: 50 }), materials: brick }),
      ],
    }),
    -30,
    -22,
  );
  // Mansarda em L.
  at(
    building({
      name: 'Mansarda em L',
      levels: levelsFor(2, 3.3, 3.6),
      solids: [solid({ plan: { outer: planVertices([[-8, -6], [8, -6], [8, 6], [1, 6], [1, 0], [-8, 0]]), holes: [] }, height: 7, roof: roofSpec('mansard', { pitch: 25 }), facade: [facadeRule('win-sash', { mode: 'spacing', value: 2.2 })], materials: { ...brick, roof: mat('slate', '#4d5257') } })],
    }),
    -2,
    -22,
  );
  // Rotunda com cúpula.
  at(
    building({
      name: 'Rotunda',
      levels: levelsFor(2, 4.2, 4.6),
      solids: [solid({ plan: { outer: circlePlan(6.5), holes: [] }, height: 9, roof: roofSpec('dome'), facade: [facadeRule('win-arched', { mode: 'count', value: 1 })], materials: { wall: mat('stone', '#d9d2c3'), roof: mat('metal', '#5f8a7a'), trim: mat('paint', '#efe9dc'), base: mat('stone', '#a49d90') } })],
    }),
    24,
    -22,
  );
  // Galpão com abóbada.
  at(building({ name: 'Galpão abobadado', solids: [solid({ plan: { outer: rectPlan(22, 12), holes: [] }, height: 6, roof: roofSpec('vault', { direction: 0 }), materials: { wall: mat('concrete', '#c4c2bc'), roof: mat('metal', '#9aa3a6'), trim: mat('paint', '#e8e8e4'), base: mat('concrete', '#9a9893') } })] }), 52, -22);
  // Indústria com dente de serra.
  at(building({ name: 'Fábrica', levels: levelsFor(1, 7, 7), solids: [solid({ plan: { outer: rectPlan(24, 16), holes: [] }, height: 7, roof: roofSpec('sawtooth', { pitch: 28, direction: 0 }), facade: [facadeRule('win-industrial', { mode: 'max', value: 4.5 })], materials: { wall: mat('brick', '#9c4f36'), roof: mat('metal', '#7f878a'), trim: mat('paint', '#e6e2da'), base: mat('concrete', '#8f8c86') } })] }), -30, 8);
  // Bloco com pátio (subtração) e recuo superior.
  const block = solid({ name: 'Bloco', plan: { outer: rectPlan(18, 18), holes: [] }, height: 12.4, roof: roofSpec('flat', { parapet: 0.8 }), facade: [facadeRule('shopfront', { levels: 'ground', mode: 'max', value: 5, margin: 0.6 }), facadeRule('win-sliding', { levels: 'upper', mode: 'spacing', value: 2.4 })] });
  const court = solid({ name: 'Pátio', op: 'subtract', plan: { outer: rectPlan(8, 8), holes: [] }, base: -1, height: 30 });
  at(building({ name: 'Bloco com pátio', levels: levelsFor(4, 3, 3.4), solids: [block, court] }), -2, 10);
  // Torre afunilada com paredes inclinadas.
  const tw = rectPlan(9, 9);
  const tower = solid({ name: 'Torre afunilada', plan: { outer: tw, holes: [] }, height: 30, taper: 2, roof: roofSpec('flat', { parapet: 0.4 }), facade: [facadeRule('win-ribbon', { mode: 'count', value: 1, margin: 0.5, params: { width: 5.5 } })], materials: { wall: mat('glass', '#5c7480'), roof: mat('membrane', '#777'), trim: mat('metal', '#cfd3d4'), base: mat('concrete', '#8f8c86') } });
  tower.edges[tw[0]!.id] = { lean: 8 };
  at(building({ name: 'Torre afunilada', levels: levelsFor(9, 3.3, 3.6), solids: [tower] }), 24, 10);
  // Fachada curva com cantos arredondados.
  const curved = planVertices([[-10, -5], [10, -5], [10, 5], [-10, 5]], (i) => (i === 2 ? { bulge: 0.35 } : i === 0 ? { round: 2.5 } : i === 1 ? { round: 2.5 } : {}));
  at(building({ name: 'Edifício curvo', levels: levelsFor(5, 3, 3.4), solids: [solid({ plan: { outer: curved, holes: [] }, height: 15.4, roof: roofSpec('flat', { parapet: 0.6 }), facade: [facadeRule('door-glass', { levels: 'ground', mode: 'count', value: 1 }), facadeRule('win-tall', { levels: 'upper', mode: 'spacing', value: 2.4 })], materials: { wall: mat('plaster', '#efe6d4'), roof: mat('membrane', '#8a8a88'), trim: mat('paint', '#ffffff'), base: mat('stone', '#bab3a6') } })] }), 52, 10);
  // Arcada: abóbadas subtraídas no térreo.
  const hall = solid({ name: 'Mercado', plan: { outer: rectPlan(20, 8), holes: [] }, height: 8, roof: roofSpec('hip', { pitch: 28 }), materials: { wall: mat('plaster', '#e9d8b8'), roof: mat('tile', '#9a5a3c'), trim: mat('paint', '#fff8ec'), base: mat('stone', '#b5ad9d') } });
  const arches = [-7.5, -2.5, 2.5, 7.5].map((x) =>
    solid({ name: 'Arco', op: 'subtract', plan: { outer: rectPlan(3.2, 10, x, 0), holes: [] }, base: -0.5, height: 3, roof: roofSpec('vault', { direction: 90 }) }),
  );
  at(building({ name: 'Arcada', solids: [hall, ...arches] }), -30, 36);
  // Gambrel (celeiro) e quatro águas com beiral largo.
  at(building({ name: 'Celeiro', levels: levelsFor(1, 4, 4), solids: [solid({ plan: { outer: rectPlan(10, 14), holes: [] }, height: 4, roof: roofSpec('gambrel', { pitch: 30, direction: 90 }), facade: [facadeRule('garage-carriage', { mode: 'count', value: 1, levels: 'ground' })], materials: { wall: mat('wood', '#8f2f24'), roof: mat('slate', '#4a4a4a'), trim: mat('paint', '#f5f1e8'), base: mat('stone', '#9d978c') } })] }), -2, 38);
  at(building({ name: 'Bangalô', solids: [solid({ plan: { outer: rectPlan(14, 10), holes: [] }, height: 3.2, roof: roofSpec('hip', { pitch: 22, overhang: 1.1 }), facade: [facadeRule('win-casement', { mode: 'max', value: 3 })] })] , levels: levelsFor(1, 3.2, 3.2) }), 24, 38);
  return out;
}

