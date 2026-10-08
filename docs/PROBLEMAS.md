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
| P3 | idem | A estrada só aparece no fim do trabalho todo | Espera de compilação e ordem dos tiles (`renderer.ts`) | Trabalho de uma estrada em ≤ 3 quadros; compilação só com programa novo | aberto | | |
| P4 | "Demora pra criar pessoas" | Corpo cozido preparado na thread principal: 7 × até 812 ms | `riggedCitizens.ts` → `citizenBake.ts` | Todos os clipes assados no worker que já existe (`bakePool.ts`) | aberto | | |
| P5 | idem | Encaixe de roupa e cabelo: 63 × até 136 ms. Medido de novo, trecho a trecho: o registro `hitch:person/fit` inclui as esperas de quadro (`breathe`). O síncrono por peça é `wear` 0,1-4,4 ms + normais ≤ 0,9 + níveis (meshoptimizer) 0,1-6,4; pele 14 ms, uma vez | `proceduralCrowd.ts` `lodPlan` (simplificação na thread do jogo) | Simplificação no worker de LOD que já existia (`lodPool.ts` compartilhado com `personRig.ts`, pedido `index` em `lodWorker.ts`); mesmo índice (conferido: 1 584 triângulos idênticos) | simplificação fora da thread do jogo; falta cache entre sessões | thread do jogo: só `wear` + normais (≤ 5 ms por peça) | (este commit) |
| P6 | idem | Rosto de cada pessoa: medido 5,5-7 ms (forma inteira + 19 158 vértices posados) + 2 formas inteiras só para a altura (~5 ms cada) | `proceduralCrowd.ts` `add` (`rig.deltas(mo.shape(...))`, `bodyHeight(mo.shape(...))`) | Traços regionais são alvos esparsos somados (MakeHuman `Target.apply`): só eles (`Morpher.addRegional`), posados só nos 5 303 vértices da cabeça pela parte linear da pele (`PersonRig.deltasAt`, MakeHuman `skinMesh`); altura só pelo Y (`Morpher.height`, MakeHuman `getHeightCm`) | fechado | rosto 0,3-1,2 ms (erro máx. 2,6e-7 contra o antigo); altura ~3 ms cada, mesmo valor | (este commit) |
| P7 | "Se tem muitas pessoas na cena trava" | Sem registro por quadro | Suspeitos: `strandsUpdate` percorre todas as pessoas por quadro; criação contínua. Lido: `update`/`strandsUpdate` são lineares no número de pessoas, sem trabalho pesado por pessoa | Medido (quadros desenhados à mão, painel escondido): 256 pedestres e 400 carros, CPU 2,8-3,8 ms por quadro, GPU 6,7-7,9 ms de mediana, nenhuma tarefa longa, nenhuma espera de link. Mas com o painel escondido o `requestAnimationFrame` não dispara e os corpos procedurais não terminam de montar (`breathe`), então o desenho das pessoas não entrou nessa medida | aberto: medir com o painel visível | | |
| P8 | "Veja como fazer as nuvens de modo leve" | Sombra: 24 nuvens × 5 passos × 7 bolhas por pixel da tela; corpos: 24 × 24 passos a ¼ dos pixels | `postprocess.ts` `CLOUD_SHADOWS` e `CLOUD_BODIES_MAIN` | Sombra num mapa 512² sobre o plano da base mais baixa (abaixo dele não há nuvem, então a sombra de um ponto é a do ponto onde seu raio de sol cruza o plano; Unreal "cloud shadow map"), retângulo calculado a cada quadro; marcha exata só acima do plano ou com sol rasante. Corpos: passos de comprimento fixo (24 no diâmetro, menos nas cordas e onde a cena corta; opacidade já integrada por passo, arXiv 1609.05344 §3.1) | sombra e corpos feitos; acumulação temporal não feita (sem como conferir o rastro na tela) | sombra: 1 leitura de textura por pixel; mapa = 262 144 marchas por quadro contra ~2 milhões (1920×1080). Comparado no navegador contra a marcha exata: diferença média 0,155/255, brilho médio igual, 3 039 pixels sombreados | (este commit) |
| P9 | "Tire os efeitos de luz e sombra que deixam pesado, mas deixe bonito" | Medido com timer de GPU (`EXT_disjoint_timer_query_webgl2`) na RTX 3060, 1280×720, mapa do jogador com 256 pedestres e 400 carros: passe de sombra do sol 0,10 ms de mediana, 0,65 máx; quadro inteiro 6,4 ms de mediana; passe da cena 1,47 ms; cada passe de pós ≤ 0,40 ms (sombra das nuvens 0,40; mapa de sombra das nuvens 0,03) | Passe de sombra do sol todo quadro (`renderer.ts`) | Medido primeiro, como o plano mandava: a sombra do sol custa 1,5% do quadro; guardar o mapa dos estáticos não paga a complexidade agora | fechado sem mudança (não é gargalo) | 0,10 ms | — |
| P12 | "As estradas mudam o terreno, ninguém sabe como, onde, por quê" | Primeira edição depois de abrir: 400 blocos e 117 tiles refeitos, quadro de 200-500 ms | `terrain.ts` `naturalRenderedHeightAt` lia os cantos naturais com a diagonal do chão moldado (`flip`): moldar o chão mudava o chão natural (soma de controle 426645 → 426722) e as alturas de todas as estradas (3-98 mm) | Diagonais próprias do chão natural (`naturalFlip`) | fechado | 30 blocos, 0 tiles antigos refeitos; só a estrada nova muda | 27a7a95e |
| P11 | "O jogo precisa de um controlador global de estados e eventos: se algo muda, saber o que, onde, por quê" | ~20 contadores de revisão soltos; só o chão desenhado registra onde mudou | `world/doc.ts`, `render/groundChanges.ts`, 132 variáveis soltas em `main.ts` | Diário de mudanças do mundo (o que, onde, causa) dono no documento, mudanças derivadas encadeadas, inspetor; depois estado do jogo tipado | em andamento: B1 feito (diário, estradas/terreno/luz/tiles encadeados, F8 e `__changes()`); B2 (consumidores e estado do jogo) aberto | estrada: corrente "estrada → alturas 24 blocos → chão 96 regiões → luz → 6 tiles"; custo 0,4-0,5 ms por estrada | 27ff122e |
| P13 | "Muita coisa que não se usa mais: vida dos moradores, mundo planeta" | — | `sim/city`, motores antigos de pedestre (`sim/people`, `sim/peds`), `render/planet.ts`, `world/planet` | Vida dos moradores guardada em `src/backup/residents` com os sistemas de que depende; planeta e motores não usados removidos | fechado | planeta −1 016 linhas; motores People/Crowd/legado −13 167; Drive v1 removido; moradores e "andar como pessoa" no backup; Ações (pistola, bomba) conferidas no jogo | 612d1f4f, 55e9d730, a4736a28, e3cd1605, 6c41c05c |
| P14 | "Tem que poder atirar nas pessoas, jogar bomba nelas, nos prédios" | Pistola e depois Bomba: a bomba não caía (o clique só inspecionava) | `ui/v2/shell.ts`: o painel apertava de novo o botão Demolir, e `pickTool` desliga a ferramenta já ativa | Só apertar Demolir quando não está ativa | fechado | Pistola derruba a pessoa; Pistola → Bomba explode | e3cd1605 |
| P15 | "Por que os pedestres estão com gráfico tão lixo?" | Toda pessoa, em todo zoom jogável (18-133 px de altura), no nível 3: malha única de ~270 triângulos sem textura | `render/people/crowdLod.ts` `LEVEL_PIXELS = [1200, 400, 150, 8]`: corpo completo só acima de 1 200 px | Faixas pela altura na tela e pelo que cada nível perde (Unity LOD Group): 100 / 45 / 18 / 4 px; custo segurado pelos tetos [20, 100] | fechado | zoom normal (58 px): nível 1 texturizado; de perto: corpo completo | (este commit) |
| P7a | "Se tem muitas pessoas trava" | Tarefas longas de 60-580 ms ao aparecerem pessoas novas; `getProgramInfoLog` 9 × até 146 ms (851 ms) | Duas causas. (1) `riggedCitizens.ts`: os stand-ins da compilação antecipada não tinham `instanceColor`, e `instancingColor` é parte da chave do programa (`WebGLPrograms.getProgramCacheKeyBooleans`): o programa compilado antes nunca era o desenhado, e cada corpo novo linkava o seu no quadro em que aparecia. (2) `skinAppearance.ts`: a chave levava `cardMask`/`garmentMask`, um programa por combinação de roupa | Stand-ins com `instanceColor` (os programas compilados antes são os desenhados); GLSL igual para toda combinação (todos os samplers declarados, textura 1×1 nos slots vazios, flags `cardTextures`/`garmentTextures` em uniform), masks fora da chave | corrigido, falta a medida no jogo | | (este commit) |
| P10 | "Onde você otimizou árvores?" | Árvores novas não carregavam; nível longe com 0 triângulos ou o modelo inteiro | `natureTrees.ts`: URL fora do Vite (`publicDir: false`); nível longe feito do original | URLs por `import.meta.glob`; cadeia de LODs (longe feito do médio) | fechado | 8 variedades carregam; longe 12-74 triângulos | fc4e2479 |

## Já tentado e que não resolveu

Para não repetir:

- **LOD das pessoas (níveis por pixels na tela, malha longe, sombras em
  mancha).** Está ativo e reduz o custo por quadro. Não resolve a criação
  lenta, porque o custo está no cozimento, no encaixe e no rosto (P4-P6).
- **"Otimização" das vias anunciada sem medir.** O caminho de desenhar
  estrada ficou como estava. A causa real está em P1 e P2.
- **Árvores do Nature Kit "com LOD".** Não carregavam (P10).

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
