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

As regras de andamento e de ritmo (dois estados de entrega, um item por vez,
só a etapa ATUAL, uma sessão por vez, testes só do que foi tocado, sonda no
máximo duas vezes, documentação no mesmo commit) ficam no `CLAUDE.md`, seção
"Pace and done", que toda sessão carrega.

## Estado

| Etapa | O quê | Estado |
|---|---|---|
| 0 | Arrumar a casa: instruções do Roadcraft, um plano, um registro | feita (`e169da0a`); em 2026-10-09 o jogador restaurou o `CLAUDE.md`, o `.claude/settings.json` e o `.claude/launch.json` do Roadcraft, e a trava de pesquisa por arquivo saiu; o `CLAUDE.md` ganhou "Pace and done" |
| 1a | Estado do jogo: ferramenta, pausa, velocidade, seleção, opções das ferramentas, gesto; interface por `watch` | feita (`de0ecfe6`, `46ca5873`, `4c535183`) |
| 1b | Revisões do documento lidas do diário; zonas, lotes e prédios registrados | feita (`e2092b4e`) |
| 1c + 2 | Causas certas no diário; monitor de quebra e lentidão; inspetor único (botão de pulso / F9) | feita (`8bb31320`, `db6057fa`, `d5ad6dd1`) |
| 1d | `main.ts` dividido: cada ferramenta no seu módulo, o laço do quadro em `src/frameLoop.ts` | feita: lote/zona, cercas, postes, paisagismo, pincel de terreno, nuvens, ações, via (`5d7dd24f`), demolição (`10ea0371`), mover nó (`7a7ab0dd`), câmera (`ad3f053b`, em `view/`), laço do quadro (`65b75bb5`). `main.ts` de cerca de 6 000 para 4 533 linhas; os `let` que restam são de ligação. Cada ferramenta testada com mouse real |
| 3 | Otimização completa, guiada pelo monitor | **ATUAL**. Feitos: linha de base por sistema (`probe-baseline.mjs`, `__frames`); edição de via só refaz o que muda (P24); abertura sem a cópia JSON das texturas (P25) e com a topologia como carga (P26); câmera e criação de pessoas medidas sem custo de CPU do jogo (P27, P28); P18 e P19 fechados. 2026-10-09: P4, P7a, P22 e P23 medidos e fechados (400/400 a 4x por 80 s sem quadro longo); P70 com mais dois passos (MOBIL, curvas, motorista). Falta: P3 (medida com o painel visível), P70 (orçamento de 4 ms na iGPU) e a conferência única do jogador na RTX (ver "Metas") |
| 4 | Todos os defeitos abertos | a fazer |
| 5 | Física e realismo visual: detectores de invariantes, objeto composto do lote, pedestres sem salto, câmera, luzes, variedade (pedidos de 2026-10-09) | a fazer; ordem frente às etapas 3 e 4 a decidir pelo jogador |

**Por que 1d vem depois do monitor:** dividir o `main.ts` (6 000 linhas) é a
mudança mais arriscada do plano. Com o monitor ligado, um erro ou um quadro
lento que a divisão causar aparece na hora, com a causa; sem ele, só o
jogador veria.

## Fila (pedidos do jogador ainda não atendidos)

1. ~~Árvores low-poly bonitas~~: um só módulo para todas as árvores e
   arbustos (`7fb7fa98`, `b454120d`), depois com cartões de folhagem; a
   palmeira, a última no estilo antigo, com folhas pinadas em V (P85,
   `43860dde`). Conferência visual com o jogador.
1a. URGENTE de 2026-10-08, atendido: a cidade abria com as vias primeiro e
   os prédios de 2 a 20 s depois. Ver P20 (`8a35d468`, `5d7dd24f`).
2. ~~Quarentena de mapa ilegível com um lugar só~~: feita
   (`editor/persistence.ts` `quarantine`: um segundo mapa posto de lado vai
   para uma chave irmã com a hora, o primeiro fica). Antes: uma segunda
   falha de carregamento gravava por cima da
   primeira e o mapa posto de lado se perdia (aconteceu com o mapa de teste em
   localhost em 2026-10-08, durante uma edição em vários passos com o jogo
   aberto). Etapa 2 (uma quarentena é uma quebra que o monitor mostra) e
   correção na Etapa 4.
3. ~~O envelhecimento da cidade troca prédios a cada 3 s~~: medido, um
   prédio troca a cada ~54 min reais e sem quadro longo (P23).
4. ~~Lint vermelho~~: verde desde `74bc314c` (camadas, `release/`, escapes).
   Restam os testes (item 5). Antes: `npm run check` vermelho desde antes de 2026-10-08: o lint varre
   `release/` (o executável do Electron, 9 000 erros de código compilado) e
   `src/ui/v2/shell.ts` tem 244 escapes inúteis, 3 importações de `editor`
   na camada `ui` (proibidas) e um `prefer-const`. Etapa 4, primeiro item:
   sem o check verde nenhuma etapa pode fechar com ele.
5. **Atualização de 2026-10-09, manhã:** a suíte inteira passa. O que
   restava: `priorityBox` semente 3 (regressão de 77dea566, P86) e os testes
   dos ganchos `guard` e `research`, que testavam arquivos apagados em
   d0caae39 e saíram (bd52d19c; `git revert` os traz de volta se os ganchos
   voltarem). Fuzz: portão e regressões verdes (P82, P83).
   **Atualização de 2026-10-09:** `defects.spec` passa nas 10 cidades
   (P52, `2d466521`) e `fourWay` passa inteiro; `kerb.spec` (pedestre no
   asfalto da esquina) passa. No fuzz restam defeitos de geometria do mundo
   (`elevationStep`, vias que se cruzam sem junção, junção de pernas curtas),
   descritos no `STATUS.md`.
   **Atualização de 2026-10-08, noite:** resolvidas `curvature` (critério
   do v1), `fourWay` velocidade de curva (frenagem em rampa, 0e743d08),
   `shortTail` (geometria válida), `roundabout` ×3 (veículo pesado sem
   saída, 9fc1f050), `buildingMesh`, `heightTopology`, `citizenLocomotion`
   ×2 (limiar em m/s, a7a387cc), `streetFurniture` (achou a cabine no
   meio-fio, 2931820f), `builderCatalog` (achou 5 ícones faltando).
   Restam: `fourWay` locals (pedestre preso na faixa dentro do caminho de
   um carro admitido; o tempo segurado dele volta a zero a cada ~3 s e a
   regra de destravar do SUMO nunca vale), `defects.spec` ×4 (pedestres nas
   esquinas, ver PROBLEMAS), fuzz ×2 (degrau de altura e corpos sobrepostos
   em saídas de cruzamento), `pads` (contrato do piso a decidir),
   `occupantFit` (o script de medida mede corpos glTF que saíram do jogo:
   refazer para os corpos MakeHuman), ganchos ×9 (do jogador).
   Lista original: as 29 falhas da suíte em 2026-10-08 (todas anteriores a esta sessão,
   conferidas): fuzz (6 sequências e `open-road-drawn-over-road`), motor de
   caminhada em 4 cidades (`defects.spec`), Drive v2 (`curvature`,
   `shortTail`, `fourWay` ×2, `roundabout` ×3), `buildingMesh` (camada de
   prédios), `heightTopology`, `citizenLocomotion` ×2 (0,07 m/s),
   `groundCover`, `pads`, `streetFurniture` (prado), `occupantFit` e
   `builderCatalog` (não carregam fora do navegador), e os testes dos hooks
   de `.claude` (`claudeGuard` ×5, `researchHook` ×4), que só o jogador
   pode resolver, porque os hooks são dele. Etapa 4.
6. ~~Interface organizada, visual e testada~~ (pedido do jogador de
   2026-10-09): feita (`722ba4af`, `cb1c6aea`, `e7b08fa0`, `72576787`; P53-P58).
   Falta a conferência do jogador no jogo aberto, e o que não deu para
   testar sem dados: as linhas do transporte (a cidade de teste não tem
   nenhuma) e os painéis internos do Construtor com um prédio selecionado.

## Etapa 0 — Arrumar a casa

- O `CLAUDE.md` do Roadcraft de volta: feito pelo jogador em 2026-10-09. De
  2026-10-08 07:11 até então, as sessões trabalharam com o `CLAUDE.md` do
  criador de personagens 3D, que proibia rodar o jogo e os testes. Os ~190
  commits desse período foram conferidos só pela sessão.
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

**Como fechar:** as sessões só medem na iGPU Intel desta máquina, cerca de 5×
mais lenta na GPU. A CPU é comparada com a meta direto, e a GPU contra a
linha de base de 2026-10-08 na própria iGPU (`docs/PROBLEMAS.md`, "Linha de
base"). Com isso cumprido, o item fica "feito, aguardando o jogador", e o
jogador confere uma vez na RTX, pelo F9 com 400/400. Só essa conferência
fecha a etapa.

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

## Etapa 5 — Física e realismo visual

Defeitos que o jogador viu no jogo em 2026-10-09 e que a sessão confirmou
jogando (build de produção, painel do navegador à vista). Cada um é uma
classe de defeito: a correção é onde ele nasce, e um detector impede que
volte.

**5a. Detectores de invariantes físicos** (antes de qualquer correção, para
medir o tamanho de cada classe na cidade inteira, e depois como guarda em
`tests/` e no monitor F9):
- peça sem apoio (`unsupportedElements`, `c09a4b2c`): nenhuma peça no ar;
- peça no chão a mais de 5 cm do terreno desenhado (`renderedHeightAt`) sob
  ela: nem flutuando nem enterrada;
- interpenetração: banco ou passageiro contra sólidos do interior de todo
  veículo (ônibus, carro, caminhão), peças do lote entre si e contra o prédio;
- corpo desenhado do pedestre (`PedView`) por tique: deslocamento acima do que
  a velocidade de caminhada permite ou giro brusco é salto. Medir nas
  travessias dos cruzamentos.

**5b. Objeto composto do lote.** Hoje garagem, pergolado, balanço, mesa e
trampolim são peças soltas (laje + postes) postas uma a uma
(`editor/lotPlan.ts`); o gerador pode recusar ou apagar um poste
(`stepYard`, `lift`) e deixar o teto. No desenho, as peças que não seguem o
terreno ficam numa cota única do lote (`render/buildings/buildingMesh.ts`
`emitLots`, `level`) e as que seguem ficam no chão, por isso caixas e
jardineiras saem enterradas ou altas numa encosta. Solução: um elemento
`prop` (do catálogo) posto inteiro ou recusado inteiro, com a base no
terreno sob a sua pegada (cada poste até o chão; acima do limite de
inclinação, um pódio ou a recusa) e validado pelo apoio (5a). O filtro de
desenho dos lotes já salvos (`looseParts`, `c09a4b2c`) sai quando os lotes
forem migrados para `prop`. O Construtor recusa, com o motivo, peça sem apoio.

**5c. Pedestres nos cruzamentos** (pedido repetido do jogador): deslizam e
"pulam como peça de xadrez". Medir com 5a antes; ler "Já tentado" (P52 e o
registro de 2026-10-08, três tentativas revertidas). A causa no código ainda
não foi lida nesta etapa.

**5d. Câmera:** arrastar com o botão do meio falha de perto
(`main.ts:1237-1250`, `view/cameraGestures.ts`). Os textos de ajuda trocam
os nomes `middleDrag`/`rightDrag` (`ui/i18n/pt-BR.ts:383-384`).

**5e. Luzes:** janelas acesas com listras (provável briga de profundidade
entre o plano aceso e o vidro); janelas sem brilho (o bloom existe,
`postprocess.ts:231`, só à noite); casas sem luz externa; lanterna traseira
sem brilho (a dianteira tem).

**5f. Variedade:** os detalhes do telhado e do lote se repetem em todos os
prédios (caixa d'água, placas, aparelhos, claraboias no mesmo arranjo).

**5g. Achados da avaliação jogando:**
- pincelada de zona perdida enquanto a proposta de lotes se refaz
  (`editor/lotTool.ts:135-169`);
- pincel de terreno faz brotar árvores (a confirmar com o jogador contra a
  ordem de 2026-10-05) e fecha em 210 ms de script (`ecology` 82 ms);
- monitor F9 conta como quadro longo o tempo em que o navegador ficou parado
  (entradas de 57 s sem trabalho do jogo);
- interface v2 lê e clica a interface antiga escondida a cada 250 ms
  (`ui/v2/shell.ts:1589`, botões em triplicata);
- o servidor de desenvolvimento recarrega o `main.ts` quando outra sessão
  edita, o que zera o desfazer e o relógio: jogue na build
  (`roadcraft-play`).

**Pronto quando:** os detectores de 5a passarem na cidade de teste e numa
cidade crescida em encosta, e o jogador conferir no jogo cada item de 5b a 5f.
