# Sistema de vias (agente em segundo plano, ramo `vias`)

Proposta aprovada pelo jogador em 2026-10-09. O sistema de vias completo é feito
por um agente em segundo plano, num worktree próprio (ramo `vias`), enquanto a
sessão principal segue a Etapa 5 do `docs/PLANO.md`. Uma etapa por vez; ao fim de
cada uma o agente para e relata, a sessão principal confere no jogo e repassa ao
jogador, e só com a aprovação dele a etapa entra em `master` e a seguinte começa.

## O que existe e é reaproveitado (não se refaz)
- Seção: `world/roadTypes.ts` (classes, `roadProfile()` em camadas), `world/roadSection.ts`
  (ajuste por trecho e seta por faixa), `world/section.ts` (zonas de calçada), ciclofaixa
  (`world/parking.ts`).
- Superfícies: `world/surfaces.ts`, `render/roadSurfaces.ts` (bandas por subtração de
  polígonos, tiles com digest, rebaixamento `curbRamp`).
- Elevação e estruturas: `world/elevation.ts`, `world/structures.ts`, `render/structures.ts`,
  túnel automático (`editor/commit.ts`), recusas (`editor/editRules.ts`).
- Ferramenta: `editor/roadTool.ts`, `editor/snap.ts`, `editor/commit.ts`.
- Faixas, conectores e conflitos: `world/lanelets.ts` (`buildJunctions`), `world/turnPaths.ts`,
  `world/conflictPoints.ts`.
- Controle: `JunctionControl` (`world/doc.ts`), `sim/intersections/admission.ts`, `sim/signals/`;
  roteamento por faixa (`sim/drive/tactical.ts`).
- Mobiliário, postes e placas: `world/landscape.ts`, `world/streetFurniture.ts`,
  `editor/streetscapeTool.ts`, `render/scenery.ts`, `editor/poles.ts`, `world/poleLines.ts`,
  `render/utilities.ts`, `render/signs.ts`.
- Sinalização: `world/markings.ts`, `world/parkingLayout.ts`.
- Salvar: `world/doc.ts`, `editor/persistence.ts` (campo novo opcional, com padrão).
- Detectores e medida: `tests/fuzz`, `tests/arch`, `core/health.ts` (F9), `hitch:`,
  `scripts/probe-baseline.mjs`.

## Isolamento
- Worktree com o ramo `vias`. O agente nunca faz commit em `master` nem push; a sessão
  principal faz o merge depois da conferência e da aprovação.
- Código novo em pastas próprias dentro das camadas: `src/world/roads/`, `src/editor/roads/`,
  `src/ui/roads/`, `src/render/roads/`, `src/sim/roads/` (cobertas pelo eslint e por `tests/arch`).
- Arquivos quentes (`main.ts`, `world/doc.ts`, `render/roadSurfaces.ts`, `world/markings.ts`,
  `world/lanelets.ts`, `render/agents.ts`): o agente só os edita em commits de integração
  declarados no relato; a sessão principal não os edita enquanto a etapa do agente estiver
  aberta, salvo correção de defeito, avisada.
- CPU: só os specs dos arquivos tocados, `scripts/run-limited.mjs`, `VITEST_MAX_WORKERS=2`;
  suíte e fuzz uma vez no fim da etapa, sem tarefa pesada da sessão principal ao mesmo tempo
  (marcador `docs/.heavy-lock`).

## Módulos novos
- `world/roads/tuning.ts`: valores de ajuste num lugar só (inclinação 8% via, 12% rampa curta,
  35% recusa; altura livre 5,5 m sobre via e 4,5 m sob viaduto urbano; ponte acima de 6 m do
  terreno; túnel com cobertura de 7 m ou mais; vão de pilares 25-35 m; postes 30-38 m;
  limiares de fluxo). Os valores espalhados hoje passam a ler daqui.
- `world/roads/profile.ts`: perfil ordenado (calçada, faixa, ciclovia, faixa de ônibus, bonde,
  estacionamento, canteiro, meio-fio, acostamento; largura, altura relativa, sentido, classes
  permitidas, velocidade, material) e um adaptador que gera o `RoadType` atual, para os
  consumidores migrarem um a um. As classes atuais viram modelos; `RoadSegment.profile?` opcional.
- `world/roads/templates.ts`: modelos salvos.
- `world/roads/connectors.ts`: conectores por nó, padrão derivado + `RoadNode.laneLinks?` à mão
  (nunca sobrescrito; links para faixas que sumiram são limpos).
- `world/roads/rules.ts`: a regra é a fonte e a placa é derivada (velocidade, controle,
  `blockedMovements`, proibido estacionar).
- `world/roads/markingStyle.ts`: padrão regional trocável (Brasil/CONTRAN por padrão).
- `world/economy.ts`: saldo e custos.
- `sim/roads/flowStats.ts` e `sim/roads/controlAdvisor.ts`: fluxo por aproximação e escolha
  do controle por tendência.
- `editor/roads/`, `ui/roads/`, `render/roads/`: construção com elevação, editor de perfil e de
  conectores, painel do cruzamento, preview pelos mesmos construtores de malha.

## Donos das sobreposições com a Etapa 5
| Item | Dono | Como o outro usa |
|---|---|---|
| 5a detectores | sessão principal | o agente cobre os objetos novos e adiciona ops de fuzz |
| 5b objeto composto do lote, calçada↔portão, rebaixamento nos portões | sessão principal | sai da lista do agente |
| 5f catálogo por dados | sessão principal | o agente registra o mobiliário urbano nele |
| 5h postes que cruzam ruas | sessão principal | o agente faz a rede elétrica sobre o `planPoleRun` corrigido |
| 5e luzes por classe | sessão principal | o poste ilumina por esse sistema |
| rebaixamento e piso tátil nas faixas | 5c (feito) | o agente desenha o piso tátil sobre as rampas |

## Decisões do jogador
- Economia mínima já: saldo inicial configurável, custo por metro por elemento e por estrutura
  (ponte e túnel mais caros), custo no preview, débito na construção, devolução no desfazer,
  bloqueio sem saldo, devolução parcial na demolição; salvo no documento.
- Mobiliário automático por padrão em vias novas (conjunto "completo", trocável na construção);
  revoga a ordem de 2026-10-05 só para vias novas; vias existentes não mudam sozinhas; objeto
  automático editado à mão é preservado.
- Controle dos cruzamentos aplicado sozinho pela tendência medida (não por pico); a escolha
  manual trava o cruzamento, com opção de destravar.

## Adiado ou simplificado
- Pré-visualização do perfil na própria via selecionada, sem janela 3D à parte.
- Bonde: elemento e trilho visuais com ponto de integração; o veículo depois.
- Emergência: não há veículos de emergência; depois.
- Energia, drenagem, lixo e incêndio: ponto de integração apenas.

## Etapas (uma por vez, com aceite do jogador)
| Etapa | O quê | Aceite | Estado |
|---|---|---|---|
| V0 | Base: worktree, `tuning.ts`, contrato de dados, rede e elevação incrementais, economia mínima | mapas antigos idênticos; sem regressão no `probe-baseline`; fuzz verde; custo no preview, debitado e devolvido | em andamento (ver "Andamento da V0") |
| V1 | Perfil livre: adaptador, assimetria, material, meio-fio pela diferença de altura, UV sem esticar, modelos, aplicar sem demolir | testes de perfil; mapas antigos idênticos; perfis novos no jogo | |
| V2 | Editor visual do perfil com validação e modelos | uso no jogo | |
| V3 | Construção com elevação: preview pelo mesmo código, chão/aterro/ponte/trincheira com muro/túnel, feedback, teclas configuráveis | preview = resultado (teste); sem quadro longo no arraste | |
| V4 | Conectores de faixa, classes por faixa, troca de faixa por tipo de linha | veículos seguem as conexões; testes | |
| V5 | Cruzamentos inteligentes: CTB, Pare/Dê a preferência, minirrotatória, fluxo, escolha automática com trava, painel; semáforo editável, adaptativo, onda verde, prioridade de ônibus | testes de simulação; uso no jogo | |
| V6 | Sinalização no chão regional e editável; placas instanciadas | uso no jogo | |
| V7 | Mobiliário no catálogo da 5f, NBR 9050, conjuntos, automático, em linha, placa = regra, poste ilumina, rede elétrica | uso no jogo; detectores | |
| V8 | Complementares (ônibus com baia, retornos, balão, inverter mão, conta-gotas, edição em massa, nomes e numeração, casos de borda) | uso no jogo | |

## Andamento da V0
- `world/roads/tuning.ts`: feito. Os valores que já valiam no jogo continuam iguais (travados por
  `tests/world/roadTuning.spec.ts`); onde a referência real diverge, ela fica ao lado, para decisão
  do jogador: inclinação de via em nível 12% no jogo contra 8% de referência (TxDOT); altura do
  viaduto 5,6 m na superfície (4,4 m livres sob a laje) contra 5,5 m livres sobre via e 4,5 m sob
  viaduto urbano; túnel automático a 18 m de cobertura contra 7 m de cobertura mínima; vão dos
  pilares 29,6 m (elevado) e 38,4 m (ponte) contra 25-35 m; postes 38 m contra 30-38 m.
- Rede e alturas incrementais: feito (`docs/PROBLEMAS.md` PV1). `Network.rebuild()` compara de que
  cada trecho e nó foi feito com o que a última reconstrução registrou e só refaz o que mudou;
  `rebuild({ full: true })` ao abrir mapa (`editor/history.ts` `restoreInto`).
  `buildRoadElevation(net, chão, anterior)` reaproveita as estações e os pedaços conexos iguais; o
  renderizador passa a solução anterior enquanto o chão não muda, as regras de edição usam
  `FLAT_GROUND`. Oráculo `tests/world/incrementalRebuild.spec.ts`; medida `tests/bench/roadRebuild.spec.ts`.
- Economia mínima: feito. `world/economy.ts` (preço por metro quadrado de pista, canteiro e calçada,
  vezes o comprimento em cada modo de construção: chão 1, aterro 1,4, trincheira 1,8, ponte/viaduto 2,5,
  túnel 6; o modo vem da estrutura ou da altura definida sobre o chão projetado) e
  `editor/roads/economy.ts` (cobrança única: o que as vias valem depois menos antes; devolução de 25% do
  que sai). Cobrado em `commitRoadPath`, `commitDraft`, `guardRoadEdit` (todas as edições no lugar),
  `moveNodeChecked` e no Demolir; recusa `funds` com o motivo no preview; custo no rótulo do preview;
  saldo no documento (`RoadDoc.economy`, gravado só fora do saldo inicial, validado em
  `isSerializedDoc`), por isso o desfazer devolve; saldo na barra de cima. Saldo inicial 20 milhões
  (a cidade de teste vale 16,5 milhões). A cidade gerada (`generateCity`) não é cobrada.
- Contrato de dados da V0: só `SerializedDoc.economy?: { balance }`.
- Fechamento da V0 no ramo (2026-10-09): lint e typecheck limpos; suíte inteira 1068 testes verdes, fuzz
  smoke verde; 2 falhas que já falham em `e10aab08` (antes da V0): `tests/world/terrace.spec.ts`
  (degraus do quintal, lotes da sessão principal) e `tests/render/occupantFit.spec.ts` (falta
  `docs/audit/seated-pose-extents.json`, arquivo não versionado). Fotografado na build de
  desenvolvimento do ramo: saldo na barra, custo no rótulo do preview, débito, desfazer devolvendo,
  preview vermelho "dinheiro insuficiente". Aguardando a conferência no jogo e a aprovação do jogador.

## Desempenho
- Rede e elevação incrementais (V0). Preview em fatias, sem alocar por quadro. Placas em atlas e
  instância. Fluxo em anéis fixos a 1 Hz. Editor de conectores refaz só o nó.
- Cada etapa relata antes e depois pelo `probe-baseline`, `__frames` e os orçamentos do F9.
