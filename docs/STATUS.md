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
`C:/Codex-Shared/Roadcraft`, com push para `origin`
(github.com/designathan1988/app-roadcraft-v2).

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
- Grade universal de 10 × 10 m com subdivisão de 1 m (`world/grid.ts`); perfis
  de via em metros inteiros; encaixe ligado por padrão (`editor/snap.ts`).
- Junções resolvidas uma vez, na linha do meio-fio
  (`world/junction/derive.ts`). Meio-fio de 15 cm, calçada no nível dele,
  talude de grama até o chão.
- Estacionamento paralelo ao meio-fio, por trecho e lado
  (`world/parking.ts`), e ciclofaixas.
- Nada é gerado sozinho nas ruas nem no terreno (ordem do jogador de
  2026-10-05). Mobiliário, árvores de rua e postes só pela ferramenta de
  paisagismo e pela de postes, que ficam só nas calçadas.
- Pincel de terreno com rios e túneis; geologia por região (granito, arenito,
  basalto) e relevos (mesa, cânion, escarpa, pão de açúcar); mapas novos
  nascem num relevo natural.
- Terreno sem as luzes e efeitos que o jogador mandou tirar (`557c5384`).
- Árvores: todas as árvores e arbustos do jogo vêm de um só módulo low poly
  (`render/lowPolyTrees.ts`, de 70 a 190 triângulos), sem cartões de folha,
  inclusive a reserva da mata pintada (`groundCover.ts`). Gráfico com
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
- Pincel de terreno: o fim da pincelada refaz só a região suja dela, em
  fatias, e a água só quando a pincelada chega perto dela (P32, `3e60f67b`).
- Névoa da chuva e bruma do ar medidas do olho equivalente também na vista
  ortográfica (a câmera dela fica longe por construção): de perto a chuva
  não cobre mais metade da imagem (P35).

### Noite
- Janelas acesas à noite pela fração de pessoas acordadas na hora (ATUS):
  63% às 22 h, 6% às 2 h (P30, `4b522935`). Sem a vida dos moradores, a
  tabela de cômodos (`lightSlots.ts`) não é alimentada; se for religada, ela
  volta a mandar.

### Prédios e cidade
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
    portão de carro desenhado aberto;
  - carros entram pelo portão até o estacionamento dos fundos e saem por ele
    (`sim/agents/lotTraffic.ts`, `parking.ts`); nenhuma vaga de rua na frente
    de portão;
  - quintal em terraço na encosta, com muro de arrimo e escada.

### Pessoas
- Na rua andam só os NPCs do cenário (`sim/ambient`), entrando pelas pontas
  das vias, com o motor de caminhada `sim/agents/walk.ts` (o único motor de
  pedestre). As calçadas de toda junção se ligam em ordem angular, também
  nas junções rasas (P50); listras pelas regras do SUMO, sem girar nas
  esquinas (P52). Os carros escolhidos entram no ritmo da faixa (P51).
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

- Desempenho e defeitos: `docs/PROBLEMAS.md` (P3, P4, P7a, P16, P17-P19).
- Zoneamento: o prédio não tem meio-nível na encosta (só o quintal é
  terraceado); pedestres não entram nos lotes (o portão de pedestre é só
  desenho); primeiro traço do pincel numa sessão com ~360 ms de compilação de
  shader (P74, P75).
- Prédios: um prédio feito de referência não fica selecionado depois de
  construído; subir a altura de um prédio leva cerca de 10 s (relato do
  jogador, não investigado).
- Cidade: parece uma grade rígida; o relevo quase não aparece nela.
- Pessoas: o jogador ainda relata rostos, animação e pessoas se esbarrando.
- Simulação com 400 carros e 400 pessoas a 4x: 4,0-6,0 ms por quadro no
  headless conforme o estado da máquina (antes 7,7-8,4 com metade das
  pessoas); o orçamento de 4 ms ainda não é garantido (P70).
- Fuzz da via (`tests/fuzz`): os defeitos que restam são de geometria do
  mundo, não do trânsito: `elevationStep` (perfil de altura de uma via
  curva elevada junto a uma via no chão do mesmo nó) e corpos sobrepostos
  onde duas vias se cruzam sem junção a 1-2 m de altura (rampa sobre vias
  rebaixadas, semente 4) ou onde as pernas de uma junção de 5 vias são
  curtas demais para separar as faixas (semente 6, o cruzamento que o
  jogo já marca como impossível).

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
