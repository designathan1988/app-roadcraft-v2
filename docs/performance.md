# Onde o jogo trava — registro permanente

Este arquivo existe para que ninguém precise refazer a auditoria. Cada travamento
encontrado fica aqui com: **causa** (o mecanismo, não o sintoma), **evidência
medida**, **onde está**, **correção estrutural** e **proteção contra a volta**.
Quem mexer em desempenho lê isto primeiro, mede com o mesmo roteiro e atualiza as
linhas que mudar. O histórico fica no git; aqui fica o estado atual.

## Como medir (sempre o mesmo roteiro)

```bash
npm run dev
node scripts/probe-hitches.mjs            # mapa vazio: desenha 8 vias com a ferramenta real, 10 carros, 10 pessoas
node scripts/probe-hitches.mjs --town     # a vila padrão (761 prédios): vias curtas dentro dela
```

O roteiro usa a ferramenta de vias de verdade (dois cliques e Esc) com o trânsito
e as pessoas do painel rodando. Para cada quadro acima de 50 ms ele mostra:

- programas de shader linkados, bytes enviados à placa (texturas e buffers) e
  leituras síncronas;
- o JavaScript que rodou no quadro (amostras da JS Self-Profiling API);
- as etapas cronometradas no código com `performance.measure('hitch:…')`
  (edição de via por etapa, tiles construídos/reaproveitados, classe de corpo,
  cabelo, ajuste de roupa) e `person-rig/face/bake` (corpos cozidos montados na hora).

Cuidados ao ler os números:

- O Chrome headless daqui desenha na Intel UHD 770, não na RTX 3060 do jogador:
  compare números só entre si.
- As **amostras** do profiler indicam *onde* está o custo, não *quanto*; o tempo
  exato vem dos `hitch:` (User Timing).
- Envio de textura parcial é contado inteiro (limite superior); buffers com
  intervalo (`addUpdateRange`) são contados pelo intervalo.
- A máquina é compartilhada: rode antes e depois na mesma sessão.

## Quadro geral (2026-10-06)

| # | Mecanismo | Quando trava | Medido antes | Estado |
|---|---|---|---|---|
| 1 | Coisas sobre o chão com chave de cache global | toda edição de via | trens relinkavam shader a cada via; todos os dependentes refeitos no mapa inteiro | **CORRIGIDO** |
| 2 | Mapa sem prédios remodelava o chão inteiro | toda edição de via em mapa sem prédios | invalidava tudo (via #1) | **CORRIGIDO** |
| 3 | Chão remodelado bloco a bloco, cada bloco com laços globais | edição de via que move vários blocos | 35–100 ms de "ground" | **CORRIGIDO** (medir de novo) |
| 4 | Materiais do transporte criados a cada reconstrução | toda edição de via | 1 shader relinkado por via | **CORRIGIDO** |
| 5 | Cabelo: busca de vizinho por força bruta | cada penteado novo | 70–225 ms | **CORRIGIDO** (grade; 27–100 ms restantes são o resto da geração) |
| 6 | Classe de corpo procedural montada de uma vez | cada classe nova (8) | 40–240 ms | **PALIATIVO** (fatiada); causa: não é pré-cozida (#8) |
| 7 | Corpos cozidos vencidos: queda silenciosa para montagem em runtime | motorista, pessoas em prédios | 200–550 ms por corpo | **CORRIGIDO** (impressão pelo fecho de imports; recozido) |
| 8 | Pessoas procedurais (classes, cabelo, roupas) sem caminho de cozimento | primeiros minutos, cada tipo novo | soma de segundos | **ABERTO** |
| 9 | Malha das vias: todos os tiles fundidos e reenviados a cada edição | toda edição de via | fusão 28–35 ms + 50–80 MB enviados (quadros de 400–850 ms na vila) | **CORRIGIDO** (blocos 4×4 mantidos na placa) |
| 10 | Digest da solução de alturas invalidava a rua inteira / o mapa inteiro | toda edição de via | 900 blocos na primeira via; rua inteira por junção | **CORRIGIDO** (digest local); custo por tile ainda **ABERTO** |
| 11 | Topologia de pedestres refeita no mapa inteiro | toda edição de via | quadro de 113 ms (`buildWalkways`) | **ABERTO** |
| 12 | Prédios: células remontadas depois de edição de via | edição de via perto de prédios | quadro de 285 ms (`assembleByCell`) | **ABERTO** (medir de novo depois de #1) |
| 13 | Calçadas, cenário, mobiliário, postes, placas refeitos no mapa inteiro | toda edição de via | baratos hoje (< 10 ms na vila), mas globais | **ABERTO** |

---

## 1. Chave de cache global para tudo que está sobre o chão — CORRIGIDO

**Causa.** Em `render/renderer.ts`, muros/cercas, transporte, jardins, floresta,
prédios e as plantas sob prédios tinham como chave de cache dois contadores
globais: `rebuilds` (sobe a cada reconstrução do mundo, ou seja, a cada via) e
`groundVersion` (sobe a cada nivelamento do chão em qualquer lugar). Uma via
desenhada num canto reconstruía todos eles no mapa inteiro, mesmo sem nada perto
e até sem nada (a malha vazia dos trens era refeita e seu shader relinkado a cada
via). A reconstrução do chão era por região, mas a invalidação era global.

**Evidência.** Programas de shader comparados antes e depois de cada via
(`scripts/probe-hitches.mjs`, relink): a cada via, um programa `transit-trains`
destruído e outro criado; `link=1` em todo quadro de edição.

**Correção estrutural.** `render/groundChanges.ts`: um registro único de
**onde e quando** o chão desenhado mudou. Quem altera o chão marca o retângulo:
`shapeGround` marca a região remodelada; `rebuildWorld` marca os blocos onde a
solução das vias mudou (`changedBlocks`, que já existia). Cada dependente é um
`GroundDependant`: é refeito só se a **sua própria revisão** mudou ou se uma
mudança desde a última construção **toca a sua área**. Sem conteúdo, não tem
área e nunca é refeito por causa do chão. Os prédios fazem o mesmo prédio a prédio
(`buildings/layer.ts`, `groundTouched`): só reamostram o chão os prédios cuja
encosta uma mudança alcançou. As plantas sob prédios passam a depender só dos
prédios (`buildings.revision`).

| dependente | chave própria | área |
|---|---|---|
| muros, cercas, sebes | `barrierRevision` | pontos dos muros |
| transporte | `transitRevision` | paradas e trilhos + 40 m (entrada de metrô procura lugar em volta) |
| jardins | plantas dos prédios | encosta dos prédios com plantas |
| floresta | `forestRevision` | pinceladas de floresta |
| prédios | — | encosta de cada prédio |

**Proteção.** A regra: nada em `render/` usa contador global como chave de
cache de coisa local; o que depende do chão usa `GroundDependant`. A fazer: teste
em `tests/render/` que desenha uma via longe de um muro e conta que o muro não foi
refeito.

## 2. Mapa sem prédios remodelava o chão inteiro a cada via — CORRIGIDO

**Causa.** `rebuildWorld` só usava o caminho por blocos (`shapeBlocks`) se
`padsCache` existisse, e ele é `null` em mapa sem prédios. Resultado: em mapa
sem prédios, que é o caso do jogador que começa desenhando vias, toda via
remodelava o mapa inteiro e marcava "tudo mudou".

**Correção.** Os blocos vêm só das duas soluções de via; a condição de `padsCache`
saiu (`renderer.ts`, comentário no lugar).

## 3. Chão remodelado bloco a bloco com laços globais — CORRIGIDO

**Causa.** `shapeBlocks` chamava `terrain.shapeToRoads` uma vez **por bloco**, e
cada chamada percorre todos os cantos já moldados, as caixas de todas as vias e
recalcula a esfera envolvente do terreno inteiro (90 mil vértices). Uma via que
mexe em 20 blocos pagava os laços globais 20 vezes.

**Evidência.** Com a #2 ligada, `hitch:road-edit/ground` subiu para 35–50 ms no
mapa vazio e 45–100 ms na vila.

**Correção.** `shapeToRoads` aceita várias regiões numa passada só
(`render/terrain.ts`); `shapeBlocks` passa todos os blocos de uma vez.

## 4. Materiais do transporte criados a cada reconstrução — CORRIGIDO

**Causa.** `render/transit.ts` criava materiais novos em toda reconstrução e os
descartava na seguinte. Contraria a regra do `src/render/CLAUDE.md` ("nunca crie
material dentro de uma reconstrução"). Com a #1, o transporte nem é mais refeito
por causa das vias; os materiais compartilhados garantem que, quando for, nenhum
shader é relinkado.

**Correção.** `sharedMaterial()`: um material por combinação de parâmetros, feito
uma vez.

## 5. Cabelo: vizinho mais próximo por força bruta — CORRIGIDO

**Causa.** `people/hair/procedural.ts` `pinned`: cada vértice do penteado
(dezenas de milhares) procurava os 3 vértices mais próximos da cabeça percorrendo
todos (cerca de 3 mil).

**Evidência.** `hitch:person/hair` de 70 a 225 ms por penteado novo (manBun 186,
longHeadband 225, bob 180).

**Correção.** `nearestThree`: grade uniforme percorrida em anéis (hash espacial),
com o mesmo critério de desempate. **Proteção:** `tests/people/hairPinning.spec.ts`
compara com a busca antiga em 4 mil pontos, incluindo empates exatos.

**Restante.** A geração do penteado ainda custa 27–100 ms (outras partes de
`generateHair`). A causa de fundo é a #8.

## 6. Classe de corpo procedural montada de uma vez — PALIATIVO

**Causa aparente.** `render/people/proceduralCrowd.ts` `buildClass`: o rig, 16
componentes de forma (`rig.deltas` no corpo inteiro), 12 canais de expressão e os
clipes rodavam numa tacada só: 40–240 ms por classe (são 8: 2 sexos × 4 faixas
de idade).

**Feito.** O trabalho foi fatiado em pedaços de ~4 ms por quadro (`breathe`, o
mesmo de `citizenBake.ts`). Isso **só espalha o custo**. A causa é a #8: esses
dados são determinísticos e deveriam vir prontos do disco.

## 7. Corpos cozidos vencidos: queda silenciosa para runtime — ABERTO

**Causa.** Os corpos cozidos (`cooked/people`, `npm run cook:people`) levam uma
impressão digital de **todo** o código em `src/people` e `src/render/people`
(`cook-plugin.ts`). Qualquer edição ali, mesmo uma que não muda esses corpos (como
a multidão procedural), invalida o cozimento. O jogo então monta cada corpo na
hora sem avisar ninguém: o aviso só aparece no console do servidor de
desenvolvimento.

**Evidência.** Manifesto cozido em 2026-10-05 22:55; o código de pessoas mudou
depois disso (e7174cf, 2a1cbac). Medido: `person-rig` 35–80 ms, `person-face`
33–80 ms e `person-bake` 130–555 ms por corpo, durante o jogo.

**Correção (6673cfb).** A impressão é o fecho de imports de
`riggedCitizens.ts` (`cook-plugin.ts` `importClosure`): editar a multidão
procedural não invalida mais os corpos. Recozido (`npm run cook:people`, 14 s).
**Proteção:** `tests/tooling/cookFingerprint.spec.ts`; o build (e portanto o
`npm run check`) recusa cozimento vencido.

**Não fazer:** cozinhar automaticamente no servidor de desenvolvimento. Foi
tentado: a cada reinício do servidor ele abria um Chrome invisível, e com edições
seguidas isso pôs a CPU do jogador a 100% e travou o computador (2026-10-06).
Removido. Depois de mexer em código de pessoas, rode `npm run cook:people` à mão,
uma vez.

## 8. Pessoas procedurais sem caminho de cozimento — ABERTO

**Causa.** A multidão procedural (2a1cbac) monta tudo no navegador do jogador:
8 classes de corpo (base de forma, expressões, clipes), cada penteado
(`generateHair`) e cada roupa ajustada a cada classe (`rig.wear`). Tudo isso é
função só dos assets e do código, igual em toda partida. É o caso clássico de
conteúdo que se cozinha antes (*cooked assets*, como as engines fazem).

**Correção a fazer.** Incluir no cozimento os dados de cada classe (texturas de
forma e expressão, base das juntas, clipes; 6,3 MB por classe, medido) e os
pacotes de cabelo. Tentado em 2026-10-06: as 8 classes cozinham bem, mas algum
penteado em `HAIR_STYLES` estoura a memória ao ser gerado (a aba do cozimento
caiu; num teste em Node a geração não terminou em 300 s). Achar esse penteado
antes de retomar, e nunca rodar o cozimento em segundo plano.

## 9. Malha das vias fundida e reenviada inteira a cada edição — ABERTO

**Causa.** `render/roadSurfaces.ts`: os tiles são reaproveitados (só os
alcançados são refeitos), mas no fim **todos** os tiles são fundidos numa malha
por superfície (`mergeTiles`) e a malha inteira vai de novo para a placa. Na
vila, uma via curta: fusão de 28–35 ms e 50–80 MB enviados, com quadros de 400 a
850 ms.

**Correção a fazer.** Malhas por bloco de tiles (por exemplo 4×4). Bloco com os
mesmos tiles mantém a malha e o buffer na placa; só os blocos tocados são
fundidos e enviados.

## 10. Tiles de via: quantos e quanto custam — ABERTO

Na vila, uma via curta refaz de 9 a 34 tiles (o resto é reaproveitado), a 4–13 ms
cada. Falta verificar se a solução de altura (`changedBlocks`) está marcando
blocos além dos que a via realmente muda (o greide de uma rua se propagando) e
onde o tempo de `buildTile` se concentra.

## 11. Topologia de pedestres refeita no mapa inteiro — ABERTO

`sim`: `rebuildWalkTopology` → `rebindPeds` → `buildWalkways` reconstrói toda a
rede de calçadas a cada edição de via (quadro de 113 ms na vila).

## 12. Prédios remontados por célula depois de edição — ABERTO

`buildings/layer.ts` `assembleByCell` aparece num quadro de 285 ms depois de uma
via na vila. Medir de novo com a #1 (agora só reamostram prédios tocados) e ver
se as células remontadas são só as tocadas.

## 13. Reconstruções globais ainda baratas — ABERTO

`rebuildWorld` refaz no mapa inteiro, a cada via, as estruturas
(`buildStructureDetails`), o cenário (`buildScenery`), os postes
(`buildUtilities`), o mobiliário e as placas. Hoje somam menos de 10 ms na vila,
mas crescem com o mapa. Devem passar a depender de regiões, como a #1.

## Já descartado (não é causa)

- `forestPlants` aparecia no topo das amostras ao desenhar vias, mas o tempo
  medido é menor que 8 ms. A amostra estava mal atribuída.
- "7 MB por quadro" de buffers de veículos: era erro de contagem do roteiro. Os
  veículos já enviam só o intervalo usado (`addUpdateRange` em `agents.ts`).
