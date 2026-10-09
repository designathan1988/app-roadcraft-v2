# Zoneamento, lotes e prédios que crescem

O que o zoneamento faz hoje, por que é assim e de qual análise veio. Pedido
do jogador de 2026-10-09: zoneamento fácil, prédios variados e sem repetição,
escolhidos com inteligência para o lugar, muros e cercas completos com portão
de pedestre e de carro, portão de carro funcionando até o estacionamento dos
fundos, prédios acompanhando o terreno.

## Como funciona (o fluxo, arquivo por arquivo)

1. **Via** desenhada (`editor/roadTool.ts`). Vias não criam nem mexem em
   lotes (decisão de 96e037f8).
2. **Ferramenta de zona** na mão (`editor/lotTool.ts`): a terra ao longo das
   vias é cortada em lotes em segundo plano, 4 ms por quadro
   (`world/lots.ts` `planLotsSteps`: quarteirão fechado em uma ou duas
   fileiras de lotes iguais; terra aberta numa faixa de 32 m de fundo, lotes
   de cerca de 22 m de frente). Esses lotes **propostos** aparecem em
   contorno fraco; nada é gravado.
3. **Pincel**: passa por lotes desenhados e propostos; ao soltar, os
   propostos pintados são criados e todos são zoneados, num passo de desfazer.
   Lote desenhado à mão (retângulo, polígono, cortar, juntar, curvar) continua
   valendo e tem prioridade.
4. **Crescimento** (`main.ts`, a cada 500 ms → `editor/zoning.ts`
   `growOnLot`): o lote aberto mais perto do último prédio crescido (a rua
   enche em sequência); `planLot` divide o lote em frente, lados e fundos
   (`editor/lotPlan.ts`); `madeToMeasure` faz 4 candidatos para o envelope
   (`world/buildings/procedural.ts`) e fica o menos parecido com os prédios a
   90 m; `furnishLot` mobilia o lote, fecha a divisa e terraceia o quintal em
   encosta; `addPlaced` grava (tirando trecho de muro que encosta no vizinho).
5. **Carros** (`sim/agents/parking.ts`, `lotTraffic.ts`, `manoeuvre.ts`):
   as vagas do lote são alcançadas só pelos portões de carro; carros do
   trânsito são chamados às vagas livres perto da vista, param antes do
   portão, entram, ficam 40-150 s e saem pelo mesmo portão.
6. **Desenho** (`render/buildings/buildingMesh.ts`): o lote segue
   `lotSurfaces` (terraços inclusos), muros e cercas descem em degraus de
   2 m, o portão de carro aparece aberto.

## Por que cada coisa

- **Lotes propostos pelo pincel.** Medido: via nova + pincel = 0 lotes, nada
  crescia; o jogador tinha de desenhar cada lote. Cities: Skylines mostra a
  terra zoneável ao longo de toda via com a ferramenta na mão e o jogador só
  pinta. Aqui a proposta só existe com a ferramenta na mão e só é gravada ao
  pintar, então a decisão de 96e037f8 (vias não geram lotes) continua: o que
  gerava lentidão era replanejar o mapa a cada via, e a proposta roda em
  fatias de 4 ms (medido: máx 6-8 ms por quadro).
- **Rua enchendo em sequência.** Sorteado no mapa inteiro, o prédio surgia
  longe de onde o jogador pintou; o mais perto do último dá retorno onde ele
  olha.
- **Forma por caso + candidato menos parecido.** Medido: casa tinha uma forma
  só e todos os lotes têm 22×32 m, logo todas as casas eram a mesma massa;
  com um sorteio, 19-30% dos prédios tinham quase-gêmeo a menos de 100 m. A
  forma vem das proporções do envelope (como o `LUShape` do CityEngine) e de
  um ramo aleatório; entre 4 candidatos fica o mais distante, em aparência, dos
  vizinhos (melhor candidato de Mitchell: espalha sem aglomerar e custa 4
  geradores de massa, alguns ms). Depois: 2-8 de 54 com quase-gêmeo.
- **Cores como dados.** As cores entram por vértice num material por
  acabamento (`render/buildings/finishes.ts`): paleta maior não cria material
  nem chamada de desenho. Famílias brasileiras (cremes, amarelos, pêssegos,
  verdes, azuis, lilases, cinzas), contorno que contrasta, telhados de barro,
  ardósia, fibrocimento e metal, e uma variação de tom por prédio.
- **Altura vizinha.** Prédio médio ao lado de casa baixa fica até 3 andares
  acima dela: um degrau, não um paredão.
- **Esquina.** Lote com rua no lado também ganha faixa de jardim e divisa
  baixa nesse lado, em vez de parede cega e muro de 2,2 m para a rua.
- **Divisa completa.** As peças eram postas por regra e as recusadas deixavam
  buraco; o passe final mede a borda inteira e fecha o que falta. Medido no
  teste: menos de 2% da borda aberta em todos os usos.
- **Portão de carro funcional.** Medido: 39 de 413 vagas alcançáveis, porque a
  saída era procurada na borda do próprio estacionamento, a 20-35 m da rua, e
  as cercas de 12 cm não apareciam na grade de 75 cm. Agora a saída é o
  portão (como a área de estacionamento do SUMO, presa à faixa do acesso), a
  grade marca toda célula que uma peça toca, o acesso fica livre e nenhuma
  vaga de rua é pintada na frente do portão (CTB art. 181 IX). Depois:
  430/430 (semente 3).
- **Terraços.** Na encosta o quintal inteiro era cortado ou aterrado até o
  piso. O quintal agora é uma plataforma perto do terreno natural, com muro de
  arrimo e escada (17 cm de espelho, 30 cm de piso). Medido em 30 casas numa
  encosta de 18%: corte e aterro no meio dos jardins 209 m → 95 m.

## O que ainda falta

- O prédio em si não tem meio-nível: o corpo fica na cota da rua e o terreno
  sob ele é nivelado; uma ala dos fundos numa cota própria exigiria cota por
  volume no desenho.
- Pedestres não entram nos lotes hoje (só andam entre pontas de via): o portão
  de pedestre existe em toda frente com recuo, mas ninguém passa por ele. Fazer
  os pedestres usarem a porta é trabalho em `sim/agents/walk.ts` e
  `sim/ambient/ambient.ts`.
- O primeiro traço do pincel numa sessão tem um quadro de cerca de 360 ms de
  compilação de shader (P75); pré-compilar fica em `render/renderer.ts`.
- Docas de caminhão das fábricas não são vagas de carro e não recebem carro.
