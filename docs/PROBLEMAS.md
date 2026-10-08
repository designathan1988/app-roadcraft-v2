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
| P5 | idem | Encaixe de roupa e cabelo: 63 × até 136 ms | `proceduralCrowd.ts` `wornItem`/`makeItem` | Preparo de LOD num worker; resultado guardado (`derivedCache.ts`); pré-aquecimento em tempo ocioso | aberto | | |
| P6 | idem | Rosto de cada pessoa: 50-80 ms (sem registro) | `proceduralCrowd.ts` `add` (`rig.deltas`) | Rosto só para quem chega perto (níveis 0-1), fora da thread principal | aberto | | |
| P7 | "Se tem muitas pessoas na cena trava" | Sem registro por quadro | Suspeitos: `strandsUpdate` percorre todas as pessoas por quadro; criação contínua | Registros por quadro; corrigir o que aparecer | aberto | | |
| P8 | "Veja como fazer as nuvens de modo leve" | Sombra: 24 nuvens × 5 passos × 7 bolhas por pixel da tela; corpos: 24 × 24 passos a ¼ dos pixels | `postprocess.ts` `CLOUD_SHADOWS` e `CLOUD_BODIES_MAIN` | Sombra num mapa 2D refeito só quando as nuvens andam; corpos com 8 passos sorteados por quadro + acumulação temporal | aberto | | |
| P9 | "Tire os efeitos de luz e sombra que deixam pesado, mas deixe bonito" | A medir (timer de GPU) | Passe de sombra do sol todo quadro (`environment.ts`) | Mapa dos estáticos guardado e refeito só quando algo estático muda; móveis por quadro | aberto | | |
| P12 | "As estradas mudam o terreno, ninguém sabe como, onde, por quê" | Primeira edição depois de abrir: 400 blocos e 117 tiles refeitos, quadro de 200-500 ms | `terrain.ts` `naturalRenderedHeightAt` lia os cantos naturais com a diagonal do chão moldado (`flip`): moldar o chão mudava o chão natural (soma de controle 426645 → 426722) e as alturas de todas as estradas (3-98 mm) | Diagonais próprias do chão natural (`naturalFlip`) | fechado | 30 blocos, 0 tiles antigos refeitos; só a estrada nova muda | 27a7a95e |
| P11 | "O jogo precisa de um controlador global de estados e eventos: se algo muda, saber o que, onde, por quê" | ~20 contadores de revisão soltos; só o chão desenhado registra onde mudou | `world/doc.ts`, `render/groundChanges.ts`, 132 variáveis soltas em `main.ts` | Diário de mudanças do mundo (o que, onde, causa) dono no documento, mudanças derivadas encadeadas, inspetor; depois estado do jogo tipado | aberto | | |
| P13 | "Muita coisa que não se usa mais: vida dos moradores, mundo planeta" | — | `sim/city`, motores antigos de pedestre (`sim/people`, `sim/peds`), `render/planet.ts`, `world/planet` | Vida dos moradores guardada em `src/backup/residents` com os sistemas de que depende; planeta e motores não usados removidos | aberto | | |
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
