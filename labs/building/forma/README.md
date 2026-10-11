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

### Coberturas

Quatro águas, duas águas e mansarda saem de um esqueleto reto próprio (Felkel & Obdržálek, com pesos), em `src/geometry/roofs/skeleton.ts`. Funcionam em qualquer planta: L, U, T, pátios, polígonos livres.
- **Duas águas:** as pontas da cumeeira viram empenas verticais. `roof.direction` (graus no eixo local; 0 = largura, 90 = profundidade) escolhe a orientação.
- **Beiral:** `roof.overhang` (m, padrão 0,4) prolonga as águas para fora das paredes.
- **Falhas:** se o esqueleto falhar ou passar de 250 ms, a massa volta à cobertura simples do v1 (`roofs/legacy.ts`). A opção `legacyRoofs: true` em `buildBuilding` força esse modo.

```ts
import { skeletonRoof, straightSkeleton } from 'forma';
const { roof, gables } = skeletonRoof(outer, holes, { kind: 'gable', top: 9.6, height: 2.5, overhang: 0.5 });
```

### Estilos

Um estilo é um arquivo JSON (`forma-style/1`) com:
- **materiais** (cor, aspereza, textura procedural em escala real: tijolo, reboco, pedra, concreto, telha, madeira, metal);
- **regras de fachada por pavimento** (térreo, tipo, último e exceções por índice);
- embasamento, cobertura e detalhes;
- **módulos glTF** opcionais.

A fachada de cada pavimento é dividida como no `split` do CityEngine: tamanho absoluto (`2.5`), relativo (`"'0.2"`), flutuante (`"~1.4"`) e um grupo `repeat`. Cada pedaço vira parede, janela, porta, vitrine, pilastra ou módulo.

São seis estilos incluídos: Colonial brasileiro, Moderno, Art déco, Galpão industrial, Comercial com lojas e Torre envidraçada. Um exemplo de estilo próprio com módulo glTF está em `test/fixtures/styles/ornamentado.json`.

```ts
editor.addStyle(meuEstilo); // valida e guarda no projeto (project.styles)
editor.applyStyle('builtin:colonial'); // na seleção; sem seleção, vale para os próximos volumes
validateStylePack(json); // lista de erros em português (vazia = válido)
```

Na interface, a aba **Estilos** aplica com um clique. No modo avançado ela também importa e exporta arquivos de estilo. Faces com ajuste próprio e aberturas desenhadas à mão continuam valendo por cima do estilo.

### Facilidades

- **Modelos prontos** (aba Volumes): Casa térrea (com cômodos e portas), Sobrado (com escada), Prédio, Galpão e Torre. Escolha o modelo e clique no chão. API: `TEMPLATES` e `templateById`.
- **Medidas digitadas** (como a caixa de medidas do SketchUp): durante ou logo depois de desenhar, puxar ou mover, digite o valor e Enter. `12;8` ou `12x8` dá largura × profundidade; um número sozinho dá altura ou distância. A vírgula é decimal (`9,5`).
- **Conta-gotas de estilo** (`I`): copia o visual de um volume (estilo, materiais, cobertura, fachada e detalhes) e aplica em outros com um clique. Alt + clique copia de outro volume.
- **Tutorial** de 4 passos na primeira visita (`onboarding: false` desliga); reaparece pela Ajuda (`?`).
- **Toque:** um dedo seleciona e arrasta; dois dedos orbitam e aproximam. As alças têm alvo maior no toque.

### Jogo e desempenho

```ts
import { buildLOD, buildBatchedCity, createPartsGenerator, enableBVH } from 'forma';

// Três níveis por distância (THREE.LOD):
// LOD0 completo, LOD1 fundido sem caixilhos, LOD2 caixa com telhado.
const casa = buildLOD(building, { context });
scene.add(casa.group);

// Bairro distante inteiro em 2 draw calls (BatchedMesh, cor por instância).
const bairro = buildBatchedCity(project.buildings);
scene.add(bairro.group);

// Peças geradas num Web Worker (embutido); depois buildBuilding(b, { parts }).
const gen = await createPartsGenerator(project);
const parts = await gen.generate(project.buildings);

// Raycast acelerado opcional: o jogo instala e passa o three-mesh-bvh.
import * as bvh from 'three-mesh-bvh';
enableBVH(casa.group, bvh);
```

Medido no navegador de testes (Chromium + SwiftShader, 1440 × 860), com 120 volumes na vista inteira:

| | Draw calls | Triângulos |
| --- | --- | --- |
| LOD0 (sem LOD) | 2.589 | 293 mil |
| LOD1 | 489 | 51 mil |
| LOD2 | 129 | 5,9 mil |
| Editor com LOD (níveis misturados) | 301 | 18,6 mil |

O Playwright confere esse orçamento a cada execução (`e2e/editor.spec.ts`). O app usa `lod: true`. Volumes selecionados ficam sempre no detalhe completo.

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
