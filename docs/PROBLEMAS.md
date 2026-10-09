# Problemas de desempenho e soluções

Registro vivo. Uma linha por problema relatado pelo jogador. Uma linha só fecha
com a medida "depois", tirada do mesmo jeito que a "antes": na página aberta,
pelos registros que o próprio jogo grava (`performance.measure('hitch:…')`).
Antes de mexer num problema, leia a linha dele e a seção "Já tentado".

Máquina das medidas: CPU desta máquina; o que é GPU foi medido na iGPU Intel
UHD 770, cerca de 5× mais lenta que a RTX 3060 do jogador.

## Tabela

| # | Problema (relato do jogador) | Antes | Causa (arquivo:linha) | Estratégia | Estado | Depois | Commit |
|---|---|---|---|---|---|---|---|
| P1 | "Na terceira estrada já demora mais de dois segundos" | Luz do terreno do mapa inteiro refeita 14× por estrada: 16 × até 223 ms = 2 247 ms | Cada passo da moldagem do chão marca `landMoved` (`terrain.ts`), e `setSun` (`terrain.ts`) refaz `terrainShape` + `terrainLight` em 90 601 cantos | Luz refeita uma vez por edição, só na região suja (com margem do alcance do céu, do núcleo da forma e da sombra do relevo), num worker | fechado | 0 ms na thread do jogo; worker 12 ms (68×68 cantos) | 27a7a95e |
| P2 | idem | Superfícies de via: 54 tiles refeitos, 0 reaproveitados, 233 ms | Chave do tile (`roadSurfaces.ts`, `dependsOn` em `renderer.ts`) muda para tiles longe da estrada nova | Achar a parte da chave que muda em todo o mapa; só os tiles alcançados são refeitos. Achado: `dependsOn` mudava em todos os tiles porque as alturas de todas as estradas mudavam (P12) | fechado | 9 tiles construídos, 147 aproveitados (8 ms); estrada inteira 78 ms em 5 quadros | 27a7a95e |
| P3 | idem | Depois de P1/P2: 78 ms de trabalho em 5 quadros (fatias de 28 ms); a moldagem do chão 51 ms em ~120 quartos de quarteirão | `terrain.ts` `shapeToRoads`, uma chamada por quarto: percorria todos os cantos moldados do mapa (lista recriada a cada chamada) e recalculava a esfera envolvente dos 90 601 vértices (0,80 ms medido por chamada) | Marcador por canto (`Uint8Array`), restauração só dentro dos retângulos da região; esfera crescida por `expandByPoint` nos cantos que mudaram (three `Sphere`: contém a antiga) | feito; falta a medida com o painel visível | custo fixo por quarto tirado (0,8 ms de esfera + varredura) | (este commit) |
| P4 | "Demora pra criar pessoas" | Corpo cozido preparado na thread principal: 7 × até 812 ms | `riggedCitizens.ts` → `citizenBake.ts` | Todos os clipes assados no worker que já existe (`bakePool.ts`) | aberto | | |
| P5 | idem | Encaixe de roupa e cabelo: 63 × até 136 ms. Medido de novo, trecho a trecho: o registro `hitch:person/fit` inclui as esperas de quadro (`breathe`). O síncrono por peça é `wear` 0,1-4,4 ms + normais ≤ 0,9 + níveis (meshoptimizer) 0,1-6,4; pele 14 ms, uma vez | `proceduralCrowd.ts` `lodPlan` (simplificação na thread do jogo) | Simplificação no worker de LOD que já existia (`lodPool.ts` compartilhado com `personRig.ts`, pedido `index` em `lodWorker.ts`); mesmo índice (conferido: 1 584 triângulos idênticos) ; o plano de cada peça guardado no navegador entre sessões (`derivedCache.ts`, sob a impressão de `crowdLod.ts` + a do cozimento procedural, `cook-plugin.ts` DERIVED `__CROWD_LOD_HASH__`), índices validados contra a peça ao ler | fechado | thread do jogo: só `wear` + normais (≤ 5 ms por peça); da segunda sessão em diante, nem o worker | b7d73a56, (este commit) |
| P6 | idem | Rosto de cada pessoa: medido 5,5-7 ms (forma inteira + 19 158 vértices posados) + 2 formas inteiras só para a altura (~5 ms cada) | `proceduralCrowd.ts` `add` (`rig.deltas(mo.shape(...))`, `bodyHeight(mo.shape(...))`) | Traços regionais são alvos esparsos somados (MakeHuman `Target.apply`): só eles (`Morpher.addRegional`), posados só nos 5 303 vértices da cabeça pela parte linear da pele (`PersonRig.deltasAt`, MakeHuman `skinMesh`); altura só pelo Y (`Morpher.height`, MakeHuman `getHeightCm`) | fechado | rosto 0,3-1,2 ms (erro máx. 2,6e-7 contra o antigo); altura ~3 ms cada, mesmo valor | (este commit) |
| P7 | "Se tem muitas pessoas na cena trava" | Sem registro por quadro | Suspeitos: `strandsUpdate` percorre todas as pessoas por quadro; criação contínua. Lido: `update`/`strandsUpdate` são lineares no número de pessoas, sem trabalho pesado por pessoa | Medido (quadros desenhados à mão, painel escondido): 256 pedestres e 400 carros, CPU 2,8-3,8 ms por quadro, GPU 6,7-7,9 ms de mediana, nenhuma tarefa longa, nenhuma espera de link. Mas com o painel escondido o `requestAnimationFrame` não dispara e os corpos procedurais não terminam de montar (`breathe`), então o desenho das pessoas não entrou nessa medida. Medido de novo com corpos procedurais montados e na tela (RTX 3060, 1280×720, 269 pedestres simulados, 5-10 desenhados na vista; árvores novas sem LOD; 2,8 milhões de triângulos): CPU 4,7-5,3 ms, GPU 8,6-9,0 ms de mediana (p90 21 ms), nenhuma tarefa longa | medido | CPU ≤ 5,3 ms, GPU ≤ 9,0 ms de mediana | — |
| P8 | "Veja como fazer as nuvens de modo leve" | Sombra: 24 nuvens × 5 passos × 7 bolhas por pixel da tela; corpos: 24 × 24 passos a ¼ dos pixels | `postprocess.ts` `CLOUD_SHADOWS` e `CLOUD_BODIES_MAIN` | Sombra num mapa 512² sobre o plano da base mais baixa (abaixo dele não há nuvem, então a sombra de um ponto é a do ponto onde seu raio de sol cruza o plano; Unreal "cloud shadow map"), retângulo calculado a cada quadro; marcha exata só acima do plano ou com sol rasante. Corpos: passos de comprimento fixo (24 no diâmetro, menos nas cordas e onde a cena corta; opacidade já integrada por passo, arXiv 1609.05344 §3.1) ; com a câmera parada, 16 passos com início sorteado a cada quadro e o quadro anterior misturado com peso 0,9 (TAA da Playdead, `lerp(atual, histórico, feedback)`), histórico descartado ao mover a câmera (24 passos, sem rastro) | fechado (sem cintilação: de um quadro parado ao seguinte, máx. 13 níveis em 41 valores) | sombra: 1 leitura de textura por pixel; mapa = 262 144 marchas por quadro contra ~2 milhões (1920×1080). Comparado no navegador contra a marcha exata: diferença média 0,155/255, brilho médio igual, 3 039 pixels sombreados | (este commit) |
| P9 | "Tire os efeitos de luz e sombra que deixam pesado, mas deixe bonito" | Medido com timer de GPU (`EXT_disjoint_timer_query_webgl2`) na RTX 3060, 1280×720, mapa do jogador com 256 pedestres e 400 carros: passe de sombra do sol 0,10 ms de mediana, 0,65 máx; quadro inteiro 6,4 ms de mediana; passe da cena 1,47 ms; cada passe de pós ≤ 0,40 ms (sombra das nuvens 0,40; mapa de sombra das nuvens 0,03) | Passe de sombra do sol todo quadro (`renderer.ts`) | Medido primeiro, como o plano mandava: a sombra do sol custa 1,5% do quadro; guardar o mapa dos estáticos não paga a complexidade agora | fechado sem mudança (não é gargalo) | 0,10 ms | — |
| P12 | "As estradas mudam o terreno, ninguém sabe como, onde, por quê" | Primeira edição depois de abrir: 400 blocos e 117 tiles refeitos, quadro de 200-500 ms | `terrain.ts` `naturalRenderedHeightAt` lia os cantos naturais com a diagonal do chão moldado (`flip`): moldar o chão mudava o chão natural (soma de controle 426645 → 426722) e as alturas de todas as estradas (3-98 mm) | Diagonais próprias do chão natural (`naturalFlip`) | fechado | 30 blocos, 0 tiles antigos refeitos; só a estrada nova muda | 27a7a95e |
| P11 | "O jogo precisa de um controlador global de estados e eventos: se algo muda, saber o que, onde, por quê" | ~20 contadores de revisão soltos; só o chão desenhado registra onde mudou | `world/doc.ts`, `render/groundChanges.ts`, 132 variáveis soltas em `main.ts` | Diário de mudanças do mundo (o que, onde, causa) dono no documento, mudanças derivadas encadeadas, inspetor; depois estado do jogo tipado | em andamento: B1 feito (diário, estradas/terreno/luz/tiles encadeados, F8 e `__changes()`); B2: zonas e lotes só sobem de revisão quando mudam (antes subiam em todo `replaceWith`, a cada estrada), comparados uma vez só; estado do jogo num dono só (`core/gameState.ts`: ferramenta, pausa, velocidade, qualidade, seleção), toda escrita por `set` com a causa, registro próprio (fora do diário do mundo, para uma entrada sem lugar não valer "o mapa inteiro"), `__state()` no console; o que fica sobre o chão (prédios, barreiras, transporte, jardins, árvores) lê o diário (`'elevation'`, `'ground'`) em vez de um segundo registro (`GroundChanges` só para a geologia do terreno) | estrada: corrente "estrada → alturas 24 blocos → chão 96 regiões → luz → 6 tiles"; `replaceWith` 0,100 ms de mediana no mapa do jogador (antes 0,4-0,5 ms por estrada); 30 substituições sem mudança: 0 revisões movidas | 27ff122e, (este commit) |
| P13 | "Muita coisa que não se usa mais: vida dos moradores, mundo planeta" | — | `sim/city`, motores antigos de pedestre (`sim/people`, `sim/peds`), `render/planet.ts`, `world/planet` | Vida dos moradores guardada em `src/backup/residents` com os sistemas de que depende; planeta e motores não usados removidos | fechado | planeta −1 016 linhas; motores People/Crowd/legado −13 167; Drive v1 removido; moradores e "andar como pessoa" no backup; Ações (pistola, bomba) conferidas no jogo | 612d1f4f, 55e9d730, a4736a28, e3cd1605, 6c41c05c |
| P14 | "Tem que poder atirar nas pessoas, jogar bomba nelas, nos prédios" | Pistola e depois Bomba: a bomba não caía (o clique só inspecionava) | `ui/v2/shell.ts`: o painel apertava de novo o botão Demolir, e `pickTool` desliga a ferramenta já ativa | Só apertar Demolir quando não está ativa | fechado | Pistola derruba a pessoa; Pistola → Bomba explode | e3cd1605 |
| P15 | "Por que os pedestres estão com gráfico tão lixo?" | Toda pessoa, em todo zoom jogável (18-133 px de altura), no nível 3: malha única de ~270 triângulos sem textura | `render/people/crowdLod.ts` `LEVEL_PIXELS = [1200, 400, 150, 8]`: corpo completo só acima de 1 200 px | Faixas pela altura na tela e pelo que cada nível perde (Unity LOD Group): 100 / 45 / 18 / 4 px; custo segurado pelos tetos [20, 100] | fechado | zoom normal (58 px): nível 1 texturizado; de perto: corpo completo | (este commit) |
| P7a | "Se tem muitas pessoas trava" | Tarefas longas de 60-580 ms ao aparecerem pessoas novas; `getProgramInfoLog` 9 × até 146 ms (851 ms) | Duas causas. (1) `riggedCitizens.ts`: os stand-ins da compilação antecipada não tinham `instanceColor`, e `instancingColor` é parte da chave do programa (`WebGLPrograms.getProgramCacheKeyBooleans`): o programa compilado antes nunca era o desenhado, e cada corpo novo linkava o seu no quadro em que aparecia. (2) `skinAppearance.ts`: a chave levava `cardMask`/`garmentMask`, um programa por combinação de roupa | Stand-ins com `instanceColor` (os programas compilados antes são os desenhados); GLSL igual para toda combinação (todos os samplers declarados, textura 1×1 nos slots vazios, flags `cardTextures`/`garmentTextures` em uniform), masks fora da chave | corrigido, falta a medida no jogo | | (este commit) |
| P16 | Suíte de testes depois de tirar o motor de pedestre legado e o Drive v1 | 73 falhas em 30 arquivos | (1) `sim/city/city.ts`: sem o cenário ligado em 'edges' nenhum carro entrava pelas pontas (o `CityLife` sem moradores deixava sempre); (2) testes lendo `sim.peds` (motor legado) e `simOf` sem motor de pedestre; (3) `kerbStops.ts`: o Drive v2 rastejava até o ponto da parada de porta aberta; (4) três defeitos do fuzz que não se reproduzem mais | Regra do `CityLife` de volta; testes leem `pedViews` e `simOf` monta como o jogo; parada fixa onde o carro parou (freio de intertravamento de porta, Transalt); marca `open` tirada | corrigido o que a remoção quebrou. Aberto, anterior a esta conversa (código não mexido): comportamento do Drive v2 contra critérios medidos no v1 (curva, conversão a 13,5 contra 17, rotatória, cauda curta), passos a 0,07 m/s (`citizenLocomotion`), pads, cobertura do chão (102 triângulos contra 90), mobiliário no prado, camada de prédios, topologia por altura; arquivos de outra pessoa (`.claude/hooks`, `maps/cidade-com-estacionamento.json` apagado, `docs/audit`). Aberto, do motor de caminhada com o cenário: pessoas girando no lugar em 3 cidades (`defects.spec`, millingSpell 1,6-2,5 s contra 1 s) | ver a linha "Depois" na resposta final | 84ad81d2 |
| P17 | Portas religadas em todo prédio a cada via (vindo de `performance.md` #11 e #42) | ≈ 40 ms por via na vila (medido 2026-10-06) | `sim/peds/sidewalk.ts`, `world/walkways.ts`: a religação passa por todos os prédios | Religar só as portas perto do que mudou, pelos retângulos do diário (`world/changes.ts`) | aberto (Etapa 3) | | |
| P18 | Cenário e placas refeitos no mapa inteiro a cada via (vindo de `performance.md` #13; viadutos, postes e mobiliário já fechados em #43) | < 10 ms na vila (2026-10-06) | `render/renderer.ts` `rebuildWorld` | Mantidos quando os blocos da edição não os alcançam, como #43 | fechado | Medido de novo (sonda de edição, cidade de teste, 3 vias curtas): `road-edit/details`, `scenery`, `utilities`, `furniture` 0-1 ms cada | |
| P19 | Kit de árvores (ez-tree, 4 MB) gerado a cada abertura (vindo de `performance.md` #50) | não medido | `render/natureTrees.ts` | Guardar o kit no cache derivado (`derivedCache.ts`) | fechado | As árvores passaram a vir de um só módulo low poly (`lowPolyTrees.ts`, outra sessão); no perfil de amostragem da abertura (2026-10-08) nenhuma função das árvores aparece entre as 30 de maior tempo | 7fb7fa98 |
| P24 | Edição de via refaz chão e tiles longe da via | Via curta na cidade de teste: elevação marca 47 blocos de 160 u (1280 × 1120 u) para uma via numa caixa de 400 × 300 u; 192 regiões de chão (73 ms); 43 tiles (315 ms) | `renderer.ts` `changedBlocks` e `dependsOn` usavam `elevation.digest`, que inclui a identidade dos perfis (id, índice e número de estações) e o ponto mais próximo de cada via a qualquer distância: uma via que divide uma avenida muda a chave ao longo dela toda, sem altura nenhuma mudar (na bancada: 6 trechos mudam até 6 cm, 42 blocos marcados) | A chave cobre exatamente o que a construção lê (Bazel, cache de ações): o bloco de chão compara o `shapeAt` nos cantos da grade do terreno e o tabuleiro sobre a via; o tile só depende das vias a até `SURFACE_READ_REACH` (alcance do perfil + corte da mistura exp(-Δ/2,5) < 1e-4) | fechado | 14 blocos, 60 regiões (33-36 ms), 26 tiles (171 ms) | 325f6133 |
| P25 | Abertura: 283 ms serializando texturas | Perfil de amostragem da abertura: `serializeImage` 283 ms, chamado de `Material.copy` ← `material.clone()` em `terrain.ts` | `terrain.ts` `vergeMaterial = material.clone()`: o `Material.copy` do three r186 copia o `userData` por `JSON.stringify`, e o do terreno guarda as texturas | Clonar sem o `userData`; os dois materiais dividem o mesmo objeto (nada lê a cópia) | fechado | `serializeImage` some do perfil | 90d5667f |
| P26 | Abertura: zonas de conflito de uma vez antes do primeiro quadro | `pairZones` 392 ms (+ `overlap`, `widen`: 515 ms) no `sim.rebuildTopology()` síncrono do `main.ts` | `main.ts` boot; `world/conflictPoints.ts` | A topologia é carga: montada pelo `TopologyCatchUp` durante a abertura escondida, com orçamento próprio (120 ms por quadro), ao lado das vias e dos prédios | fechado | Cidade de teste, 3 aberturas: aparece aos 5,6-5,8 s (antes 6,0-6,5), trânsito andando 0,1-0,4 s depois | 90d5667f |
| P27 | Câmera: quadros de 370-460 ms ao girar e arrastar (sonda headless) | `hitch:draw/Render` 320-430 ms na primeira rodada de gestos, nenhum na segunda | Não é o jogo: a primeira chamada síncrona sobre um programa novo (água, camada de detalhe do chão; `getProgramInfoLog` do three no primeiro uso) espera a fila da iGPU Intel do Chrome headless, onde até um `gl.getError()` leva 100-400 ms | Nenhuma correção de código: medir câmera e GPU na RTX do jogador, não na iGPU | fechado (método) | Na RTX a mesma espera é de um quadro de GPU | |
| P28 | Criação de pessoas (P4) na sonda | `hitch:person/fit` 355-409 ms | É tempo decorrido, não CPU: a medida cobre `await makeItem`. Atribuição do LoAF enchendo 400/400 por 15 s: 496 ms de script no total, nenhum trecho acima de 40 ms | Nada a corrigir aqui; P4 (corpos cozidos dos ocupantes de veículos) segue aberto | fechado (método) | | |
| P20 | Abertura e mapa aberto: o mundo montado em quadros de até 1 s (registro do monitor, 2026-10-08) | Vila padrão aberta: 42 quadros longos atribuídos a "desenho", até 1 136 ms; `draw/Pump` 233 ms e `road-edit/ground shape` 78 ms dentro deles; um quadro de 2,2 s fora do laço do jogo | `render/renderer.ts` job do mundo (`pumpWorld`) e montagem dos prédios; `surfaceBake` | (1) Os prédios da cidade inteira montados a 6 ms por quadro, o orçamento de uma edição: viraram carga, 50 ms por quadro (`buildings/layer.ts` `LOADING_SLICE_MS`, a prioridade High do `backgroundLoadingPriority` da Unity). (2) O primeiro mundo só é apresentado com vias e prédios prontos (`allowSceneActivation` da Unity), marca `opening:shown`. (3) O cliente encerrava o worker das superfícies antes de ele gravar os texels no IndexedDB (`terminate()` para na hora, MDN): toda abertura assava tudo de novo, cerca de 3 s antes do primeiro quadro; agora o worker se fecha depois do `complete` da transação (`keepDerivedDurably`). Fontes: Unity `Application-backgroundLoadingPriority` e `AsyncOperation-allowSceneActivation`; MDN `Worker/terminate` e `IDBTransaction/complete_event` | parcial | Antes, com o painel visível: vias sozinhas aos 8 s, prédios aos 10 s; com o painel escondido, prédios de 10 a 20 s depois das vias. Depois de (1) e (2): nenhum quadro só de vias; a cidade inteira aparece aos 8,7 s, 2,1 s depois do primeiro quadro (6,5 s). Depois de (3): os texels ficam guardados; o worker responde em 284 ms em vez de assar por cerca de 3 s. (4) A carga dos prédios dividia o orçamento de 10 ms das edições, que a topologia do trânsito gastava inteiro: a cidade de teste abriu sem prédios até o limite de 20 s. Ganhou orçamento próprio de 50 ms (Unity: o limite da carga por quadro é dela). Medida final (sonda headless, cidade de teste com 761 prédios, duas aberturas): primeiro quadro aos 4,0–4,4 s, cidade inteira aos 6,0–6,4 s (`whole: true`). Resta uma tarefa longa de 1,57 s no começo (o `main.ts` montando a cena), para a Etapa 3 | 8a35d468, 5d7dd24f |
| P21 | Superfícies das vias refeitas inteiras ao abrir um mapa | `surfaces` 1 337 ms: 107 tiles feitos, 0 aproveitados (diário, 2026-10-08) | `render/roadSurfaces.ts` | Etapa 3 | aberto | | |
| P22 | Quadros longos da simulação com a cidade rodando | "Quadro longo: simulação" 77-84 ms, simulação 41 ms + desenho 27 ms num quadro (monitor, 2026-10-08) | `sim/pipeline.ts` `step` | Etapa 3 | aberto | | |
| P23 | O envelhecimento troca prédios a cada 3 s | cada troca grava `buildings` no diário e move `buildings.revision` (visto no diário, 2026-10-08) | `main.ts` desgaste (`decayOf`) | Medir o que cada troca refaz; dirty flag pelo que o desgaste muda de fato (Etapa 3) | aberto | | |
| P10 | "Onde você otimizou árvores?" | Árvores novas não carregavam; nível longe com 0 triângulos ou o modelo inteiro | `natureTrees.ts`: URL fora do Vite (`publicDir: false`); nível longe feito do original | URLs por `import.meta.glob`; cadeia de LODs (longe feito do médio) | fechado | 8 variedades carregam; longe 12-74 triângulos | fc4e2479 |

## Já tentado e que não resolveu

Para não repetir:

- **LOD das pessoas (níveis por pixels na tela, malha longe, sombras em
  mancha).** Está ativo e reduz o custo por quadro. Não resolve a criação
  lenta, porque o custo está no cozimento, no encaixe e no rosto (P4-P6).
- **"Otimização" das vias anunciada sem medir.** O caminho de desenhar
  estrada ficou como estava. A causa real está em P1 e P2.
- **Árvores do Nature Kit "com LOD".** Não carregavam (P10).
- **Cozinhar pessoas automaticamente no servidor de desenvolvimento.** A cada
  reinício ele abria um Chrome invisível; com edições seguidas pôs a CPU do
  jogador a 100% e travou o computador (2026-10-06). Depois de mexer em código
  de pessoas: `npm run cook:people` à mão, uma vez.
- **Não são causa:** o coletor de lixo (uma coleta de 11 ms em quatro edições
  na vila); `forestPlants` no topo das amostras (medido abaixo de 8 ms, amostra
  mal atribuída); "7 MB por quadro" de buffers de veículos (erro de contagem: os
  veículos já enviam só o intervalo usado).

## Regras que já custaram caro

- Nada em `render/` usa um contador global como chave de cache de coisa local.
  O que depende do chão ou do mundo lê o diário (`world/changes.ts`) pela área.
- Nunca criar material dentro de uma reconstrução: um material por combinação
  de parâmetros, feito uma vez (cada material novo relinka um shader).
- O que fica sobre o chão espera o job da edição terminar, e é testado contra o
  retângulo de cada item, não contra a união da camada.
- Um registro novo de prédio não é um lote novo: nivelamento e vagas comparam o
  texto do registro sem idade, nome e versão do plano do lote.
- Conteúdo que depende só dos assets e do código é cozido (`npm run cook:people`)
  ou guardado no cache derivado (`render/derivedCache.ts`), não refeito em jogo.

## Como medir

```bash
npm run dev
node scripts/probe-hitches.mjs            # mapa vazio: 8 vias com a ferramenta real, 10 carros, 10 pessoas
node scripts/probe-hitches.mjs --town     # a vila padrão (761 prédios): vias curtas dentro dela
```

Para cada quadro acima de 50 ms o roteiro mostra os programas de shader
linkados, os bytes enviados à placa, as leituras síncronas, as amostras de
JavaScript do quadro e as etapas `hitch:…` que o código grava.

- O Chrome headless daqui desenha na Intel UHD 770: compare números de GPU só
  entre si. A medida que vale é a do jogo aberto na RTX 3060.
- As amostras do profiler dizem *onde* está o custo; o tempo exato vem dos
  `hitch:…` (User Timing).
- Rode antes e depois na mesma sessão: a máquina é compartilhada.
- Na iGPU do headless qualquer chamada síncrona à GPU (até `gl.getError()`)
  espera a fila de quadros: 100-400 ms. Um quadro longo com
  `hitch:draw/Render` no primeiro uso de um programa é essa espera, não CPU
  do jogo (P27). Para CPU, use o perfil de amostragem (CDP `Profiler`) e a
  atribuição de scripts do Long Animation Frames.
- `node scripts/probe-baseline.mjs` roda os cenários da Etapa 3 e imprime,
  por sistema, mediana, p95 e máximo pelo próprio monitor (`__frames`).

### Linha de base de 2026-10-08 (headless, iGPU)

| Cenário | Quadros longos | Total ms (mediana / p95 / máx) | Observação |
|---|---|---|---|
| Mapa vazio, 8 vias | 16 de 240 | 8,7 / 53,8 / 210,7 | Edição: 0,3-2,9 s até assentar (quadros presos à iGPU) |
| Cidade de teste, 3 vias curtas | 8 de 114 | 15,5 / 111,4 / 316,5 | Edição: 2,5-3,9 s; depois de P24, 26 tiles e 14 blocos por via |
| 400/400 enchendo | 1 de 123 | 6,0 / 13,2 / 305,2 | Nenhum script acima de 40 ms (P28) |
| 400/400 rodando | 0 de 41 | 5,6 / 7,1 / 9,1 | Simulação 1,7 ms de mediana |
| Câmera | 5 de 63 | 7,0 / 374,3 / 456,8 | Espera da iGPU no primeiro uso de programas (P27) |

## Arquivo histórico

`docs/performance.md` guarda os mecanismos #1-#50 corrigidos até 2026-10-08,
com causa, evidência e proteção. Está congelado: o código cita os números dele
(`performance.md #11`, `#28`…). Problema novo ou aberto entra só nesta tabela.

## Fontes

- Unity, região suja do heightmap: https://docs.unity3d.com/ScriptReference/TerrainData.DirtyHeightmapRegion.html
- Unity, atualização de região suja: https://docs.unity3d.com/ScriptReference/TerrainData.UpdateDirtyRegion.html
- Stewart, horizonte rápido em terreno: https://www.dgp.toronto.edu/public_user/jstewart/papers/tvcg97.html
- Timonen, oclusão por horizonte: https://www.doria.fi/handle/10024/95729
- MDN, objetos transferíveis: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects
- three.js r186 `LightShadow`: https://raw.githubusercontent.com/mrdoob/three.js/r186/src/lights/LightShadow.js
- Fórum three.js, sombra guardada: https://discourse.threejs.org/t/how-to-render-shadow-map-one-time/7176
- Nuvens com menos passos e acumulação temporal: https://ar5iv.labs.arxiv.org/html/1609.05344
- Unreal, mapa de sombra das nuvens: https://dev.epicgames.com/documentation/en-us/unreal-engine/volumetric-cloud-component-properties-in-unreal-engine
- meshoptimizer, cadeia de LODs: https://raw.githubusercontent.com/zeux/meshoptimizer/master/README.md
- meshoptimizer JS (`simplify`, `simplifySloppy`, `ready`): https://raw.githubusercontent.com/zeux/meshoptimizer/master/js/README.md
- three.js r186, chave do programa (`instancingColor`, `morphTargetsCount`, `customProgramCacheKey`): https://raw.githubusercontent.com/mrdoob/three.js/r186/src/renderers/webgl/WebGLPrograms.js
- three.js r186, programa compartilhado e uniforms por material (`getProgram`): https://raw.githubusercontent.com/mrdoob/three.js/r186/src/renderers/WebGLRenderer.js
- MakeHuman, alvos esparsos somados (`Target.apply`): https://raw.githubusercontent.com/makehumancommunity/makehuman/master/makehuman/core/algos3d.py
- MakeHuman, pele aplicada a deslocamentos só pela parte 3×3 (`skinMesh`): https://raw.githubusercontent.com/makehumancommunity/makehuman/master/makehuman/shared/animation.py
- MakeHuman, altura pelo Y da caixa (`getHeightCm`): https://raw.githubusercontent.com/makehumancommunity/makehuman/master/makehuman/apps/human.py
- MDN, `postMessage` com transferência: https://developer.mozilla.org/en-US/docs/Web/API/Worker/postMessage
