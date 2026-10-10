# FORMA 2

Construtor de edifícios para three.js: editor completo, editor incorporado na cena de um jogo e gerador de prédios sem interface.

## Uso no jogo (three.js)

O three.js é dependência compartilhada (`peerDependencies`): o FORMA usa a cópia do jogo e nunca carrega a sua própria.

```ts
import * as THREE from 'three';
import { createEditor, buildBuilding, loadProject } from 'forma';

// 1) Editor dentro da cena do jogo, sem a interface do FORMA.
const editor = createEditor({ renderer, scene, camera, ui: 'none', storage: false });
editor.setTool('draw'); // select, draw, polygon, extrude, move, cut, window, door, opening, editpoints
editor.on('commit', ({ message }) => console.log(message));
editor.on('error', ({ message }) => mostrarAviso(message));
const json = editor.exportJSON(); // projeto forma/2
editor.dispose(); // remove só o que o editor criou

// 2) Editor completo com a interface, num elemento da página.
createEditor({ container: document.getElementById('editor')! });

// 3) Gerador: projeto salvo → objetos prontos para a cena.
const project = loadProject(json); // aceita forma/2 e migra projetos v1
for (const b of project.buildings) scene.add(buildBuilding(b).group);
```

### Lotes e índices urbanísticos

```ts
const lotId = editor.addLotPolygon([[0, 0], [20, 0], [20, 40], [0, 40]], {
  setbacks: { front: 5, side: 1.5, back: 3 }, // recuos em metros
  maxOccupancy: 0.6, // taxa de ocupação
  maxFAR: 2.5, // coeficiente de aproveitamento
  maxHeight: 30, // gabarito (até a cumeeira; heightTo: 'eave' mede até o beiral)
  maxStoreys: 10,
  minPermeability: 0.15,
  enforcement: 'block', // 'block' impede; 'warn' só avisa
});
editor.getIndices(lotId); // ocupação, coeficiente, altura, permeabilidade, área edificável, violações
editor.fillLot(lotId); // gera um edifício dentro das regras
editor.on('violation', ({ lotId, violations }) => { /* ... */ });
```

Os índices também podem ser calculados sem editor (por exemplo, no servidor), com `computeLotIndices(project, lot)` de `forma/core`.

No modo incorporado o editor:
- adiciona um único grupo (`FORMA-editor`) à cena;
- não roda laço de renderização próprio;
- não altera protótipos do three;
- controla a câmera recebida enquanto estiver ativo.

O exemplo completo está em `src/app/host-scene.html`.

## Formato do projeto (`forma/2`)

Lote → Edifício → Pavimentos → Massas → Aberturas. Unidades em metros, Y para cima, planta em `[x, z]`.

- Todos os objetos têm IDs estáveis.
- Fachadas e aberturas pertencem a arestas identificadas por ID, então sobrevivem a recortar, unir, espelhar e redimensionar.
- O esquema completo está em `src/core/schema.ts`; a validação, com mensagens em português, em `src/core/validate.ts`.
- Projetos do FORMA v1 são migrados automaticamente (`src/core/migrate/v1.ts`).

## Scripts

| Comando | O que faz |
| --- | --- |
| `npm run dev` | App em http://localhost:5173 (exemplo incorporado em `/host-scene.html`) |
| `npm test` | Testes unitários, incluindo paridade com o FORMA v1 e testes aleatórios |
| `npm run e2e` | Testes de ponta a ponta no navegador (Playwright) |
| `npm run typecheck` | Checagem de tipos |
| `npm run build` | `dist/` (biblioteca) e `dist-app/index.html` (app em arquivo único) |

Scripts de manutenção, em `scripts/`:
- `extract-legacy.mjs`: extrai o núcleo do HTML legado para os testes de paridade.
- `make-fixtures.mjs`: gera os projetos v1 de referência.
- `record-legacy.mjs`: grava as peças geradas pelo app legado.
- `port-css.mjs`: escopa o CSS legado.

O arquivo `../forma-construtor-3d.html` é o build de `dist-app/index.html`. A versão antiga fica em `../forma-construtor-3d-legacy.html`.
