# Plano do Roadcraft — o único

Este é o plano em execução. Toda sessão o lê antes de qualquer coisa e
trabalha só na etapa marcada como **ATUAL**. Ele substitui
`~/.claude/plans/encapsulated-enchanting-wirth.md`, cuja parte B2 ficou pela
metade e foi dada como feita.

## Como um pedido novo entra

- **URGENTE:** interrompe a etapa atual, é feito e a etapa continua.
- **PRIORIDADE:** entra na fila logo depois da etapa atual.
- **Sem marca:** entra no fim da fila.

Nenhuma etapa começa com a anterior aberta. Uma etapa só fecha com o critério
de pronto dela verificado no jogo aberto, com fotos, e com a linha do
`docs/PROBLEMAS.md` atualizada.

## Estado

| Etapa | O quê | Estado |
|---|---|---|
| 0 | Arrumar a casa: instruções do Roadcraft, um plano, um registro | feita (`e169da0a`); falta o jogador restaurar o `CLAUDE.md` |
| 1a | Estado do jogo: ferramenta, pausa, velocidade, seleção, opções das ferramentas, gesto; interface por `watch` | feita (`de0ecfe6`, `46ca5873`, `4c535183`) |
| 1b | Revisões do documento lidas do diário; zonas, lotes e prédios registrados | feita (`e2092b4e`) |
| 1c + 2 | Causas certas no diário; monitor de quebra e lentidão; inspetor único (botão de pulso / F9) | feita (`8bb31320`, `db6057fa`, `d5ad6dd1`) |
| 1d | `main.ts` dividido: cada ferramenta no seu módulo, o laço do quadro em `src/frameLoop.ts` | **ATUAL**. Feitos: lote/zona, cercas, postes, paisagismo, pincel de terreno, nuvens, ações (`actionsWiring.ts`) e via (`roadTool.ts`, `5d7dd24f`). Falta: o laço do quadro (`frameLoop.ts`) |
| 3 | Otimização completa, guiada pelo monitor | a fazer |
| 4 | Todos os defeitos abertos | a fazer |

**Por que 1d vem depois do monitor:** dividir o `main.ts` (6 000 linhas) é a
mudança mais arriscada do plano. Com o monitor ligado, um erro ou um quadro
lento que a divisão causar aparece na hora, com a causa; sem ele, só o
jogador veria.

## Fila (pedidos do jogador ainda não atendidos)

1. ~~Árvores low-poly bonitas~~: feitas pela sessão "Problemas visuais na
   otimização" (`7fb7fa98`, `b454120d`): um só módulo low poly para todas as
   árvores e arbustos, de 70 a 190 triângulos, sem cartões de folha.
   Conferência visual com o jogador.
1a. URGENTE de 2026-10-08, atendido: a cidade abria com as vias primeiro e
   os prédios de 2 a 20 s depois. Ver P20 (`8a35d468`, `5d7dd24f`).
2. Quarentena de mapa ilegível com um lugar só (`editor/persistence.ts`
   `quarantine`): uma segunda falha de carregamento grava por cima da
   primeira e o mapa posto de lado se perde (aconteceu com o mapa de teste em
   localhost em 2026-10-08, durante uma edição em vários passos com o jogo
   aberto). Etapa 2 (uma quarentena é uma quebra que o monitor mostra) e
   correção na Etapa 4.
3. O envelhecimento da cidade troca prédios a cada 3 s e cada troca move
   `buildings.revision` (visto no diário em 2026-10-08): medir na Etapa 3 o
   que isso refaz. (P23)
4. `npm run check` vermelho desde antes de 2026-10-08: o lint varre
   `release/` (o executável do Electron, 9 000 erros de código compilado) e
   `src/ui/v2/shell.ts` tem 244 escapes inúteis, 3 importações de `editor`
   na camada `ui` (proibidas) e um `prefer-const`. Etapa 4, primeiro item:
   sem o check verde nenhuma etapa pode fechar com ele.
5. As 29 falhas da suíte em 2026-10-08 (todas anteriores a esta sessão,
   conferidas): fuzz (6 sequências e `open-road-drawn-over-road`), motor de
   caminhada em 4 cidades (`defects.spec`), Drive v2 (`curvature`,
   `shortTail`, `fourWay` ×2, `roundabout` ×3), `buildingMesh` (camada de
   prédios), `heightTopology`, `citizenLocomotion` ×2 (0,07 m/s),
   `groundCover`, `pads`, `streetFurniture` (prado), `occupantFit` e
   `builderCatalog` (não carregam fora do navegador), e os testes dos hooks
   de `.claude` (`claudeGuard` ×5, `researchHook` ×4), que só o jogador
   pode resolver, porque os hooks são dele. Etapa 4.

## Etapa 0 — Arrumar a casa

- O `CLAUDE.md` do Roadcraft de volta. Ele foi trocado, sem commit, pelo do
  criador de personagens 3D, que importa um `docs/PROJETO.md` inexistente.
  Só o jogador pode restaurá-lo, porque a trava `.claude/hooks/research-gate.mjs`
  protege o arquivo: `git checkout HEAD -- CLAUDE.md`.
- `AGENTS.md` e `maps/cidade-com-estacionamento.json` (usado por
  `roadTiles.spec` e `conflictCache.spec`) restaurados.
- Um registro de desempenho só: `docs/PROBLEMAS.md`. O que ainda estava aberto
  em `docs/performance.md` virou P17, P18 e P19, junto com o roteiro de medida e
  as regras. O `performance.md` ficou congelado como arquivo histórico, não
  apagado, porque cerca de 40 arquivos de código citam os números dele.
- `docs/STATUS.md` só com o estado atual (o histórico fica no git).

**Pronto quando:** as instruções forem as do Roadcraft, existir este plano e
um registro só, e houver commit.

## Etapa 1 — Controlador global de estado e eventos

O que existe hoje e não basta:
- `core/gameState.ts` guarda 7 valores e ninguém o lê.
- `main.ts` tem 91 variáveis soltas no topo do arquivo.
- O diário do mundo (`world/changes.ts`) tem 2 leitores. Cerca de 30
  contadores `*Revision` em `world/doc.ts` decidem o que é refeito, lidos em
  15 arquivos.

### 1a. Estado do jogo

- `GameState.watch(keys, fn)`: observadores chamados uma vez por quadro, num
  ponto só (início de `frame()`), com as mudanças desde o serial que cada um
  viu. Nada é chamado de dentro de `set`.
- **Escolhas do jogador** viram chaves do estado, e a variável solta é apagada:
  - ferramenta;
  - tipo e altura de via, alinhamento;
  - pincel de terreno;
  - cerca, zona, lote, rotatória;
  - perspectiva, congestionamento, trânsito ligado;
  - seleção.
- **Gesto em andamento** vira uma chave `gesture` por ferramenta. Ela é gravada
  no início e no fim do gesto. O estado e os tratadores de cada ferramenta vão
  para um módulo próprio em `src/editor/`.
- **Contabilidade do quadro** vai para `src/frameLoop.ts`.
- Painel, barra de status e inspetor reagem por `watch`.

### 1b. Eventos do mundo

- `changes.serialOf(kind)` substitui cada `doc.xRevision`, incluindo o clone e
  o digest do documento.
- Cada leitor troca a comparação de contador por `changes.since(visto, KINDS)`,
  usando os retângulos onde já sabe refazer por região.
- Ordem: `renderer.ts` → `main.ts` → `lots.ts` → `sim/world.ts` →
  `terrain.ts` → os demais.
- Todo mutador do documento grava no diário.
- `tests/arch` proíbe incrementar revisão fora de `changes.ts`.

### 1c. Inspetor único

O F8 mostra o diário do mundo, o estado do jogo e o monitor, com a corrente de
causa. `__changes()` e `__state()` continuam.

**Pronto quando:**
- nenhum `*Revision` existir no `doc.ts`;
- `main.ts` só tiver variáveis de ligação;
- no jogo, cada ferramenta, opção e seleção aparecer no inspetor com a causa;
- via, terreno, zona, cerca, árvore e poste mostrarem cada um a sua corrente.

## Etapa 2 — Monitor de quebra e de lentidão

Arquivos novos: `src/core/health.ts` (anel de entradas) e `src/ui/healthPanel.ts`.

- **Quebra:**
  - `error` e `unhandledrejection`;
  - contexto WebGL perdido;
  - erro de shader (`renderer.debug.onShaderError`);
  - `onerror` dos workers;
  - invariantes da simulação amostradas no jogo.
  - Cada entrada leva a pilha e a última mudança do diário.
- **Lentidão:**
  - o tempo de cada sistema em `frame()`, com orçamento declarado num lugar só;
  - um quadro acima de 50 ms vira entrada com os sistemas, a atribuição do
    Long Animation Frames e a corrente do diário;
  - os `hitch:…` capturados por `PerformanceObserver`;
  - GPU por amostragem.
- **Visível:** selo no HUD, painel F9, `__health()`, últimas entradas guardadas
  no navegador.
- **Automático:** `npm run check:perf` falha acima do orçamento.

**Pronto quando:** um erro forçado, um quadro lento forçado e uma via
desenhada na vila aparecem no painel com o sistema certo.

## Etapa 3 — Otimização completa

**Linha de base por sistema**, nos cenários:
- mapa vazio com 8 vias;
- vila padrão com vias curtas;
- 400 carros e 400 pessoas em rede grande;
- câmera;
- criação de pessoas;
- pistola e bomba.

**Correção em ordem do custo medido, sem tirar visual:**
- P3, P4 e P7a;
- os 2,8 milhões de triângulos das árvores sem LOD;
- o que o monitor mostrar.

**Metas:**
- nenhum quadro acima de 50 ms;
- mediana até 16,6 ms em 400/400 na RTX 3060;
- edição de via até 100 ms no total.

## Etapa 4 — Todos os defeitos abertos

- Fila acima (árvores).
- **P16:**
  - pedestres girando nos cruzamentos;
  - testes do Drive v2 com critérios do v1;
  - passos a 0,07 m/s;
  - pads;
  - cobertura do chão;
  - mobiliário no prado;
  - camada de prédios;
  - topologia por altura;
  - testes de hooks e de `docs/audit`.
- Fuzz `near-bridge`.
- O que o monitor acusar no passeio completo pelo jogo: cada ferramenta, cada
  aba, salvar e carregar, desfazer.

**Pronto quando:** a suíte da simulação passar sem afrouxar limite, e o passeio
pelo jogo terminar sem quebra no monitor.
