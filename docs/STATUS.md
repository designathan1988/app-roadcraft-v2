# Roadcraft — status

O que está ativo no jogo hoje, o que está aberto e as decisões do jogador.
Só o estado atual: o histórico fica no git (`git log -p docs/STATUS.md`; a
versão longa anterior está em `557c5384`).

## Leia primeiro

1. `docs/PLANO.md`: o único plano. Trabalhe só na etapa marcada como ATUAL;
   pedido novo entra na fila dele.
2. `docs/PROBLEMAS.md`: o único registro de desempenho e de defeitos, com a
   medida antes e depois.
3. `CLAUDE.md`: as regras de trabalho.

## Quem trabalha aqui

Uma sessão por vez (decisão do jogador de 2026-10-04, repetida em 2026-10-08,
depois que duas sessões no mesmo repositório se atropelaram), em `master`, em
`C:/Codex-Shared/Roadcraft`, com push a cada commit para o remoto `v3`
(github.com/designathan1988/app-roadcraft-v3, pedido do jogador de
2026-10-09) e para `origin` (github.com/designathan1988/app-roadcraft-v2).
Em 2026-10-09 a sessão "Análise de organização do jogo" foi encerrada e
arquivada (último commit `b30f8d2f`); a sessão de trabalho é a "ROADCRAFT",
na Etapa 5 do plano. Para jogar enquanto uma sessão edita, use a build de
produção (`roadcraft-play`, porta 4180): o servidor de desenvolvimento recarrega
o jogo a cada edição.

## Controlador de estado e eventos, e o monitor

- **Diário do mundo** (`src/world/changes.ts`, `RoadDoc.changes`): o que
  mudou, onde e por quê, com as mudanças derivadas encadeadas (estrada →
  trânsito → alturas → chão → luz → tiles). Todas as revisões do documento e
  `buildings.revision` são o serial da última entrada do seu tipo
  (`serialOf`): nada muda sem passar por ele (`tests/arch` reprova contador
  à parte). Zonas, lotes e prédios gravam onde mudaram. A causa é a
  ferramenta e o gesto do jogador, ou o que o jogo fez (desgaste, crescimento
  da zona, mapa aberto). F8 desenha as mudanças dos últimos 8 s;
  `__changes()`.
- **Estado do jogo** (`src/core/gameState.ts`): ferramenta, pausa,
  velocidade, seleção, opções de cada ferramenta e o gesto em andamento, numa
  cópia só (o `tsc` recusa escrita direta). A interface reage por `watch`,
  avisada uma vez depois de cada mudança. `__state()`.
- **Monitor** (`src/core/health.ts`, `ui/healthWatch.ts`,
  `ui/healthPanel.ts`): erros, promessas rejeitadas, `console.error`, erros
  de shader e de workers, contexto WebGL perdido, quadros acima de 50 ms com
  os sistemas que os tomaram, invariantes da simulação; cada um com o que o
  jogador fazia. Botão de pulso na barra de cima (ponto verde, amarelo ou
  vermelho) e F9: abas Saúde, Mudanças e Estado; "copiar registro" para um
  relato. O registro sobrevive a recarregar a página. `__health()`.
- **Ferramentas em módulos próprios** (`src/editor/`): via (`roadTool.ts`),
  demolição (`bulldozer.ts`), mover nó (`nodeMover.ts`), lote e zona,
  cercas, postes, paisagismo, pincel de terreno, nuvens; a câmera à mão em
  `view/cameraGestures.ts`; as ações em `actionsWiring.ts`; a contabilidade
  do quadro em `frameLoop.ts`. O `main.ts` só liga e delega.

## Ativo no jogo

### Interface
- Interface v2 (`src/ui/v2/shell.ts`) no estilo Cities: Skylines II: dock de
  ícones embaixo no centro, painel de itens acima dele, opções da ferramenta
  embaixo à esquerda, nomes só na dica (`.v2-tip`). Conferida em 1280×720,
  1920×1080 e 1024 de largura.
- Reorganizada em 2026-10-09 (`722ba4af`): opções em linhas "nome | controles"
  (uma palavra à esquerda, o nome inteiro na dica), o mapa inteiro sob um
  divisor; Paisagem em Relevo, Solo, Natureza, Céu e clima, Rua, cada coisa um
  cartão; Zonas em Zonear e Lotes; Demolir, Pistola e Bomba numa ferramenta;
  Quarteirões é um traçado da via; no topo Camadas do mapa (grade, cores das
  zonas, congestionamento, interior), céu em três ícones, Ajuda com as teclas,
  aviso de cruzamentos impossíveis; as respostas do jogo (salvo, desfeito,
  via inválida) aparecem num aviso no topo. Sonda de função: 44/44 controles
  mudam o estado do jogo.
- O jogo abre num mapa vazio. Textos em `ui/i18n/en.ts` e `pt-BR.ts`.

### Vias e terreno
- Rua transversal reta perto da emenda de um prolongamento ou do fim de uma
  via: o nó vem para a linha desenhada (desliza na própria via), em vez de
  a rua nova virar um V pelo nó (`editor/commit.ts` `slideOntoCrossing`,
  `tests/editor/crossStraight.spec.ts`). Conferido no jogo.
- Grade universal de 10 × 10 m com subdivisão de 1 m (`world/grid.ts`); perfis
  de via em metros inteiros; encaixe ligado por padrão (`editor/snap.ts`).
- Junções resolvidas uma vez, na linha do meio-fio
  (`world/junction/derive.ts`). Meio-fio de 15 cm, calçada no nível dele,
  talude de grama até o chão.
- Estacionamento paralelo ao meio-fio, por trecho e lado
  (`world/parking.ts`), e ciclofaixas.
- Nada é gerado sozinho nas ruas nem no terreno (ordem do jogador de
  2026-10-05). Mobiliário, árvores de rua e postes só pela ferramenta de
  paisagismo e pela de postes, que ficam só nas calçadas. **Revogada para
  vias novas em 2026-10-09** (sistema de vias, `docs/VIAS.md`): quando a
  etapa V7 entrar, via nova sai com o conjunto de mobiliário escolhido
  (padrão "completo"); vias existentes não mudam sozinhas.
- Pincel de terreno com rios e túneis; geologia por região (granito, arenito,
  basalto) e relevos (mesa, cânion, escarpa, pão de açúcar); mapas novos
  nascem num relevo natural.
- Terreno sem as luzes e efeitos que o jogador mandou tirar (`557c5384`).
- Árvores: todas as árvores e arbustos do jogo vêm de um só módulo
  (`render/lowPolyTrees.ts`), inclusive a reserva da mata pintada
  (`groundCover.ts`): tronco low poly e miolo escuro sob cartões de folhagem
  com recorte alpha virados para o olho. A palmeira tem folhas próprias:
  faixas dobradas em V ao longo da nervura, com textura de folha pinada, que
  lançam sombra (P85, `43860dde`). Gráfico com
  exposição de referência, grama com brilho medido, terreno e camadas do
  corte sem repetição nem chiado, nuvens sem flocos soltos; as sombras de
  nuvem tiram só a parte direta da luz do sol e as manchas do chão visto de
  longe são mais suaves (`7fb7fa98`, `b454120d`, `76a43fad`, sessão
  "Problemas visuais na otimização").
- Abertura: a cidade aparece inteira, vias e prédios no mesmo quadro
  (`renderer.ts`, marca `opening:shown`); os texels das superfícies ficam
  guardados no navegador e não são assados de novo a cada abertura; a carga
  dos prédios tem orçamento próprio (`8a35d468`, `5d7dd24f`). Cidade de
  teste (761 prédios): inteira aos 6,0-6,4 s. Os tiles das superfícies das
  vias também ficam guardados no navegador (P21, `341cd87c`): da segunda
  abertura em diante nenhum é refeito.
- O editor recusa, com o motivo, a geometria que o trânsito não suporta
  (`editor/editRules.ts`, P83/P82): ângulo fechado (< 25°), trecho curto
  demais para as faixas se separarem na junção, via sobre via sem junção nem
  vão de 14 u (5,6 m), rampa acima de 35% entre as placas. Vale ao desenhar,
  ao soltar um nó e nas edições do inspetor e das ferramentas; só o que a
  edição cria ou piora, nunca o que o mapa já tinha (abrir mapa não recusa).
  A pré-visualização pinta o rascunho de inválido com o motivo ao lado do
  comprimento antes de soltar.
- Sistema de vias, etapa V0 (ramo `vias`, ativo só depois do merge;
  `docs/VIAS.md`): valores de ajuste em `world/roads/tuning.ts`; rede e
  alturas refeitas só onde a edição mudou algo (PV1 no `PROBLEMAS.md`);
  economia mínima: saldo na barra de cima, custo da via no rótulo do preview,
  débito ao construir, recusa sem saldo, devolução de 25% ao demolir, desfazer
  devolve o dinheiro.
- Pincel de terreno: o fim da pincelada refaz só a região suja dela, em
  fatias, e a água só quando a pincelada chega perto dela (P98, `3e60f67b`).
- Névoa da chuva e bruma do ar medidas do olho equivalente também na vista
  ortográfica (a câmera dela fica longe por construção): de perto a chuva
  não cobre mais metade da imagem (P96).

### Noite
- Janelas acesas à noite pela fração de pessoas acordadas na hora (ATUS):
  63% às 22 h, 6% às 2 h (P30, `4b522935`). Sem a vida dos moradores, a
  tabela de cômodos (`lightSlots.ts`) não é alimentada; se for religada, ela
  volta a mandar.
- Luz por classe num lugar só (`render/lightLevels.ts`, `117534eb`): janela
  acesa 1,25 de luminância em média, lanterna 1,34, freio 2,04, seta 2,11,
  farol 3,0 (UN R7/R6), acima do limiar do bloom (0,92); lâmpada apagada e
  placa sem ganho. Luminária com luz na parede ao lado de cada porta do
  térreo. Cone de luz em cada poste (cone aditivo, técnica do Volumetric
  Light Beam). Conferido no jogo (build da porta 4180), à noite e de dia.

### Prédios e cidade
- Prédios gerados por ESTILO ARQUITETÔNICO (`world/buildings/architecture.ts`,
  ramo `predios`): 12 estilos (colonial, art déco, modernista com brises,
  contemporâneo com varandas gourmet e ático, tijolo, tropical de pastilha,
  vidro, industrial; casas colonial, bangalô, moderna, sobrado), cada um com
  família de pele e caixilho, ritmo de colunas simétrico (aberturas
  alinhadas andar a andar), térreo pelo uso (loja, portaria, casa), andar de
  coroamento, frisos e coroamento próprios (`Volume.dress`: nenhum, só
  embasamento, laje aparente ou todo andar; cornija, déco, laje, ático).
  Era do bairro (antigo, moderno, novo) e rua decidem o estilo
  (`zoning.ts` `quarterOf`). Peças novas instanciadas: loggia, brise,
  janela com venezianas, varanda gourmet com guarda-corpo de vidro
  (`kit.ts` `fin`, `louvre`, `glassRail`); laje plana nunca com telha;
  marquise na portaria moderna; casa de máquinas na pele do prédio;
  manchas de chuva sob peitoris (2 triângulos por janela). Detector:
  `tests/world/architecture.spec.ts`. Visto no jogo (build, sementes 11,
  23, 47). Aguardando o jogador.
- Cidade gerada auditada inteira (`tests/world/generatedCity.spec.ts`,
  `tests/world/cityAudit.ts`, sementes 20261009, 77 e 4242): nenhum lote
  sobre o pavimento nem sobre outro, nenhum maior que 2400 m2, todo lote
  zoneado construído, nenhum prédio entrando no vizinho nem saindo do lote,
  telhado de uma água subindo no máximo ~1,2 m e de duas águas ~3,2 m
  (`procedural.ts` `MAX_ROOF_RISE`; vão largo demais vira laje), galpão de um
  pavimento de 6-10 m. Lotes cortados à terra com folga de 8 cm do pavimento
  (`lots.ts` `landLot`, sem o snap de volta à calçada), prédio no maior
  retângulo dentro do lote (`lotBuildFrame`), recorte booleano no lote em
  `zoning.ts` `fitToLot`. Código antigo reprovado: 85-98 telhados-cunha por
  cidade. Visto no jogo (build, 3 sementes): 554/554 lotes com prédio.
  Aguardando o jogador.
- Lotes sem vazio nas esquinas: a faixa de uma rua entre duas transversais,
  e a fileira de um quarteirão com lote gravado, são cortadas no que sobra
  ao lado dos lotes que já estão lá (`world/lots.ts` `freeSpans`,
  `tests/world/lotCorners.spec.ts`). No modo Lotes os lotes da rua não
  somem: ficam desenhados e viram lotes de verdade no primeiro clique de
  edição (frente, cantos, dividir, juntar, apagar). Tirar zona tira também
  o prédio (`zoneLots`, `tests/world/unzone.spec.ts`). Conferido no jogo.
- Construtor com blocos não destrutivos, operações booleanas e fachadas;
  construir a partir de um modelo 3D de referência (`editor/fromReference.ts`).
- Zoneamento com crescimento de prédios nos lotes (`world/lots.ts`), planejador
  de lote (`editor/lotPlan.ts`). Estratégia e medidas em `docs/ZONEAMENTO.md`:
  - com a ferramenta de zona na mão, lotes propostos ao longo das vias
    (contorno fraco); o pincel cria e zoneia os que pinta (`lotTool.ts`);
  - prédio escolhido entre 4 candidatos, o menos parecido com os vizinhos a
    90 m; 6 formas de casa, 5 de prédio, esquemas de cor como dados
    (`procedural.ts`); altura perto da dos vizinhos baixos; lote de esquina
    olha para as duas ruas;
  - divisa completa (muro, cerca, gradil) com portão de pedestre e de carro;
    os dois desenhados abertos; vão do portão de pedestre livre de mobiliário;
  - carros entram pelo portão até o estacionamento dos fundos e saem por ele
    (`sim/agents/lotTraffic.ts`, `parking.ts`); nenhuma vaga de rua na frente
    de portão;
  - quintal em terraço na encosta, com muro de arrimo e escada;
  - prédio em meio-nível na encosta (`world/buildings/splitLevel.ts`,
    `Volume.lift`): o fundo meio andar ou um andar acima ou abaixo da rua,
    cada bloco no seu platô, o quintal na cota dos fundos (P74).

### Pessoas
- Na rua andam só os NPCs do cenário (`sim/ambient`), entrando pelas pontas
  das vias, com o motor de caminhada `sim/agents/walk.ts` (o único motor de
  pedestre). As calçadas de toda junção se ligam em ordem angular, também
  nas junções rasas (P50); listras pelas regras do SUMO, sem girar nas
  esquinas (P52). Os carros escolhidos entram no ritmo da faixa (P51).
- Pessoas saem de casa, chegam, entram em lojas pelo portão de pedestre dos
  lotes (P84, `sim/agents/lotDoors.ts`): da porta pelo caminho do lote, pelo
  meio do portão, até a calçada, ou o contrário, e somem na porta. Quantas:
  a densidade do cenário por uso e hora contra o número escolhido; saindo ou
  entrando pela presença por hora do ATUS; a outra ponta pelo modelo
  gravitacional. O resto continua de ponta de via a ponta de via.
- Desenho: a multidão procedural (`render/people/proceduralCrowd.ts`) por
  nível de detalhe, com faixas pela altura na tela (P15). Quem está em
  veículos ainda usa os corpos cozidos (`riggedCitizens.ts`).
- Depois de mexer em código de pessoas: `npm run cook:people`, à mão, uma vez.

### Veículos e transporte
- Drive v2 é o único modelo de direção. Veículos por nível de detalhe.
- Transporte público (`sim/transit/transit.ts`, `editor/transitTools.ts`):
  ônibus de parada em parada, trens e metrô nos trilhos, passagens de nível.

### Ações
- Pistola e bomba em pessoas, carros e prédios (`render/playEffects.ts`,
  `render/ragdollJolt.ts`). O laboratório de armas (`?lab=armas`,
  `src/weaponsLab.ts`, `scripts/weapons-lab.mjs`) NÃO abre: `main.ts` só o
  carrega com `__PLAY_MODE__`, que `vite.config.ts` define como `false`
  (o modo de andar como pessoa foi para o backup).

### Outras páginas
- `human-generator.html` (criador de pessoas) e `people-lab.html`.

## Guardado fora do código ativo

- `src/backup/residents`: a vida dos moradores (casa, trabalho, necessidades,
  carro próprio, vida dentro dos prédios) e andar como uma pessoa. O README
  diz como religar.
- `src/backup/crime`: crime e polícia, fora do jogo por decisão do jogador
  (2026-10-06). Não rodar, citar nem relatar.
- Removidos: o mundo planeta e os motores de pedestre People, Crowd e de
  calçada legado; o Drive v1. Em 2026-10-09, o que ainda restava deles: a
  navmesh (`world/nav/navmesh.ts`), o publicador legado das faixas
  (`sim/peds/publish.ts`), e no `SidewalkGraph` as esquinas, os corredores,
  a ligação de cada porta, os destinos e a ocupação (`corridor.ts`,
  `behaviour.ts`); o grafo ficou só com meio-fios, faixas e calçadas, que os
  veículos e sinais leem. Também `scripts/verify-citizens.mjs` (e
  `npm run verify:citizens`) e `scripts/ped-sequence.mjs`, que liam o mapa
  `sim.peds` do motor legado, vazio desde 2026-10-08.

## Aberto

- Desempenho e defeitos: `docs/PROBLEMAS.md` (P16, P20, P70).
- Zoneamento: o meio-nível só é escolhido no crescimento (o construtor não
  tem controle para mudar `lift`; as alças e os arrastes já seguem a cota de
  cada bloco, P89); andar de baixo com garagem no lado da descida não é
  feito (o carro entra pela rua, na cota da frente); lojas e prédios com
  estacionamento ou pátio de carga atrás não são escalonados.
- Prédios: subir a altura de um prédio (relato: cerca de 10 s): na
  cidade de teste, 83 ms até o prédio redesenhado, e andar, fachada e
  telhado não renivelam mais o chão em volta (P87); em relevo, conferir no
  mapa do jogador.
- Cidade: parece uma grade rígida; o relevo quase não aparece nela.
- Pessoas: o jogador ainda relata rostos, animação e pessoas se esbarrando.
- Pessoas articuladas com morph targets: o programa delas usa 17 unidades de
  textura e a GPU do teste tem 16 (aviso do three a cada quadro); uma das
  texturas fica sem ligar (achado em 2026-10-09, a corrigir).
- Simulação com 400 carros e 400 pessoas a 4x: 4,0-10 ms por quadro no
  headless conforme o estado da máquina (antes 7,7-8,4 com metade das
  pessoas); nenhum quadro longo em 80 s; o orçamento de 4 ms ainda não é
  garantido (P70). Último passo: o conjunto de obstáculos de cada carro não
  é mais refeito a cada passo (6,7 % do passo, antes 9,2 %); o próximo
  custo é o passo das pessoas (`stepWalkers`).
- Edição de via na cidade de teste com o F9 aberto (P3): a moldagem do chão
  em quartos de no máximo 2,3 ms; o maior passo das fatias caiu de 51,6 para
  33,4 ms. Feito, aguardando o jogador.
- Fuzz da via (`tests/fuzz`): as 6 sementes do portão e as 29 regressões
  passam, sem fixture aberta para corpos sobrepostos. Fora do portão
  (sementes 7-30) restam 4 defeitos: `poseJump` (semente 19) e
  `elevationStep` em via mudada para túnel pela operação `structure`, que o
  jogo não oferece (sementes 26 e 28), e um degrau de 0,25 u no limite
  (semente 24).

## Decisões do jogador

- Interface: ícones e dicas, sem nome escrito em tudo; sem painéis com
  rolagem vertical; painéis pequenos; o visual de Cities: Skylines II. Trabalho
  de interface só é dado como feito com fotos em tamanho real, conferidas em
  1280×720.
- Cidade: sem chão vazio dentro das quadras, mas os pátios e praças do meio
  das quadras ficam; nunca prédio novo no meio de uma quadra.
- O objeto acompanha o terreno.
- O jogador escolhe a qualidade gráfica; sem tela de carregamento.
- Otimizar sem tirar visual. Mudanças visuais pequenas por velocidade são
  decisão minha; pergunto só se mudar a jogabilidade ou sair um recurso.
- Assets: baixar o que o trabalho precisar sem perguntar. Pedestres comuns
  plausíveis (sem armas, chifres ou máscaras na rua).
- Nunca levantar licença, crédito ou atribuição com o jogador.

## Esta máquina

- Os dados do jogador em 127.0.0.1 são dele: teste em outra origem
  (localhost) e nunca os sobrescreva.
- O Chrome headless desenha na Intel UHD 770; o jogador tem uma RTX 3060 e um
  i9-12900K. Medida de GPU que vale é a do jogo aberto.
- Nunca saturar a CPU: trabalho pesado em prioridade baixa, um por vez.
