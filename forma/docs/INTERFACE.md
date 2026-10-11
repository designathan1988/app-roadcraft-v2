# FORMA: redesenho da interface

Objetivo: cara de aplicação profissional (Figma, Shapr3D, Plasticity, Spline),
não de formulário. A vista 3D ocupa a tela; a interface flutua em ilhas
compactas e só mostra o que a seleção pede.

## O que está errado hoje (analisado em 2026-10-10)

1. Catálogo fixo embaixo ocupa ~25 % da altura: cartões de 96 px com ícones
   de 32 px, abas com barra de rolagem, duas barras de rolagem visíveis.
2. Painel lateral é formulário: rótulo em cima de cada campo (duas linhas por
   valor), títulos em caixa alta, botões grandes com contorno, parágrafos de
   ajuda ("3 volume(s)…", "Olho esconde…"), caixas dentro de caixas, metade
   de baixo vazia.
3. Barra de ferramentas à esquerda sem grupos: 12 ícones soltos com letras.
4. Barra de cima com botões de texto (Modelos, Novo, Abrir, Salvar) como site.
5. Barra de estado com dica longa, dois seletores, estatística e caixa de
   medidas disputando espaço.
6. Barra contextual com rótulos de texto ("Somar Recortar Interseção").
7. Avisos e mensagens no meio da vista, sobre o modelo.

## Princípios

- Tela primeiro: nada fixo ocupa a vista além de uma barra fina em cima.
- Ilhas flutuantes, cantos de 10 px, sombra suave, tema grafite (painéis
  escuros translúcidos sobre a cena clara); claro opcional depois.
- Densidade: linhas de 26 px, fonte 12 px (rótulos 11 px), ícones 16 px,
  espaçamento 4/8 px. Nada de parágrafos: dicas em tooltip e no atalho `?`.
- Propriedades em linha: rótulo curto à esquerda ou dentro do campo
  ("L 8,00 m"), arrastar o rótulo muda o número, Enter aplica, setas mudam
  pelo passo. Pares (X/Z, L/P) na mesma linha.
- Seções recolhíveis, lembradas por tipo de seleção.
- Botões de opção viram grupos segmentados de ícones (operação, cobertura,
  alinhamento) com tooltip.
- Contexto manda: a seleção define a barra flutuante perto do objeto e as
  seções do inspetor; ferramentas que não se aplicam somem.
- Busca de comandos (Ctrl+K): qualquer ferramenta, comando, componente ou
  material pelo nome.

## Layout

```
┌ barra (40 px): ◆ FORMA · nome do projeto · salvo   [Modelar|Materiais|Interior|Luz|Caminhar]   ↶ ↷ · ⌘K · Exportar ┐
│ ┌ilha de                                                                         ┌ inspetor (280 px) ──┐ │
│ │ferramentas│                       VISTA 3D                                      │ Propriedades|Camadas │ │
│ │ (36 px)   │                                                                    │ seções recolhíveis   │ │
│ │ grupos com│          [barra contextual junto da seleção]                       │                      │ │
│ │ submenu   │                                                                    │                      │ │
│ └───────────┘                                                                    └──────────────────────┘ │
│  [migalhas: Projeto › Edifício 2 › Torre]            [Biblioteca ▴]       [medidas 10x8] [grade ▾] [cubo]  │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Barra de cima**: marca, nome editável com estado (salvo/salvando), modos
  de trabalho no centro (Modelar, Materiais, Interior, Luz, Caminhar), à
  direita desfazer/refazer, busca de comandos e Exportar; Novo/Abrir/Salvar/
  Modelos vão para o menu do projeto (clique na marca).
- **Ilha de ferramentas** (esquerda, flutuante): grupos com submenu ao manter
  clicado — Selecionar; Desenhar (retângulo, círculo, polígono, arco);
  Modificar (empurrar, extrudar, inset, offset, bisel, dividir); Colocar
  (biblioteca); Pintar; Medir (trena, cota, transferidor); Corte.
- **Inspetor** (direita, flutuante, recolhível, largura ajustável): abas
  Propriedades e Camadas; cabeçalho com nome editável e tipo; seções
  recolhíveis com linhas compactas.
- **Biblioteca** (gaveta que sobe de baixo ao clicar ou com K): categorias em
  coluna à esquerda, busca, grade de miniaturas 72 px com nome curto,
  favoritos; Blocos, Componentes, Materiais e Objetos na mesma gaveta.
- **Barra contextual**: só ícones (com tooltip) junto da seleção.
- **Canto inferior direito**: caixa de medidas compacta, grade/encaixe e
  cubo de vista (topo, frente, lados, perspectiva, enquadrar).
- **Mensagens**: toast pequeno no canto inferior esquerdo; avisos num ícone
  com contador que abre a lista.

## Componentes de interface (ui/kit.ts)

`row(label, control)`, `num(key, value, unit, step)` com arrasto no rótulo,
`pair(a, b)`, `seg(options)` com ícones, `color(key)`, `section(id, title,
body, open)`, `iconButton`, `menu`, `popover`, `tooltip`. Todo painel usa o
kit; nada de HTML solto com estilos inline.

## Ordem de implementação

1. Tema e kit (tokens, tipografia, linhas, seções, segmentados, tooltips).
2. Casca: barra de cima com modos, ilha de ferramentas com grupos, inspetor
   flutuante com abas, cantos (medidas, grade, cubo), toast e avisos.
3. Inspetor refeito no kit (edifício, volume, face, canto, componente,
   elementos, regras, frisos, alinhar).
4. Biblioteca em gaveta (blocos, componentes; depois materiais e objetos).
5. Busca de comandos (Ctrl+K).
6. Camadas refeitas no kit.
7. Verificação no navegador, foto por foto, nos tamanhos 1280×720 e 1920×1080.

Depois disso seguem, já na interface nova: materiais procedurais, luz e
noite, interiores e caminhar, objetos.


## v2 (2026-10-10): ferramentas à vista

Pedido: "uma interface tem que ter ferramenta"; nada escondido em seção
recolhida, submenu ou barra inferior. Referências: barra de ferramentas do
modo de edição do Blender (docs.blender.org/manual/en/latest/modeling/meshes/tools/toolbar.html:
Mover, Girar, Escalar, Extrudar, Inset, Bisel, Corte, Faca… todos visíveis) e a
aba contextual Modificar do Revit (ações da seleção agrupadas, ícone e nome).

- Barra esquerda: Selecionar, Mover (M), Girar (Q), Escala (S) | Empurrar (P),
  Extrudar (E) | Retângulo, Círculo, Polígono, Somar/Recortar | Biblioteca,
  Pintar, Trena. Mover/Girar/Escala mostram só as alças daquela ação.
- Selecionar basta: a seleção mostra mover, girar, cantos, seta em cada face e
  a seta verde de andares; alça visível é alça clicável em qualquer ferramenta.
- Faixa "Modificar" fixa no alto (ui/actions.ts), uma lista só de ações para
  a faixa, o menu do botão direito e a busca: edifício (editar, andares,
  duplicar, girar, excluir), vários (alinhar, distribuir), volume (somar,
  recortar, interseção, extrudar, inset, offset, dividir, bisel, arredondar,
  chanfrar, recuo, embasamento, pátio, andares, duplicar, espelhar, excluir),
  janelas (fileira, coluna, mesmo tipo, face, soltar/voltar à regra, trocar,
  remover), componente. Ação com medida aplica o padrão e aceita redigitar.
- Botão direito parado: menu com as mesmas ações; arrastar gira a vista.
- Ilha "Vista" (grade, giro, hora, encaixe, enquadrar) à direita; a barra de
  baixo só tem dica, medida e contagem. Painel sem seções recolhidas por
  padrão. Verificação de texto cortado no DOM em 8 estados.
