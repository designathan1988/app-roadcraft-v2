# FORMA: arsenal de ferramentas

Inventário de tudo o que um construtor precisa para fazer qualquer construção,
com o estado real no código (conferido em 2026-10-10) e como cada ferramenta
entra no FORMA. Fontes no fim. Estado: **ok** existe e foi usado no navegador;
**parcial** existe com falta; **falta** não existe.

## Princípio

O FORMA guarda volumes paramétricos (planta + altura + telhado + regras),
combinados por booleanas na ordem da lista. Ferramentas de malha dos
modeladores (Blender, 3ds Max, SketchUp) entram como **operações não
destrutivas no documento**, como os modificadores do Blender: o resultado
continua editável por números no painel de propriedades e refeito a cada
mudança. Nada vira malha solta.

## 1. Criar

| ferramenta | referência | estado | no FORMA |
|---|---|---|---|
| Retângulo, círculo, polígono no chão ou sobre laje | SketchUp | ok | ferramentas R, C, L |
| Blocos prontos (L, U, T, cruz, cilindro…) | Townscaper, Forma | ok | catálogo Blocos |
| Arco / curva livre na planta | Rhino, SketchUp | parcial | dobrar lado em arco; falta desenhar arco direto |
| Girar perfil (revolução) | Blender Spin, Rhino Revolve | falta (só em componentes) | futuro |
| Varrer perfil por caminho (cornija contínua) | SketchUp Follow Me | falta | futuro |

## 2. Modelar volumes (operações de face, aresta e vértice)

| ferramenta | referência | estado | no FORMA |
|---|---|---|---|
| Empurrar/puxar face lateral | SketchUp Push/Pull | ok | alça e campo "Empurrar" |
| Altura (puxar topo) | SketchUp | ok | alça verde e campo |
| **Extrudar face** (novo volume a partir da face) | 3ds Max Extrude, SketchUp Ctrl+Push/Pull | falta | face lateral → anexo (somar) ou reentrância (recortar) do tamanho da face; topo → volume novo empilhado |
| **Inset de face** (com profundidade) | Blender Inset (espessura + profundidade), Max Inset/Bevel | falta | face lateral → saliência ou loggia com margens; topo → volume recuado (profundidade > 0) ou poço/átrio (< 0) |
| **Offset da planta** (contorno paralelo) | SketchUp Offset, Rhino Offset (cantos vivo/redondo/chanfro) | falta | desloca a planta para dentro/fora mantendo arcos; aplicar no volume ou criar volume novo |
| **Bevel de arestas horizontais** | Blender Bevel (largura, segmentos, perfil) | falta | parâmetro do volume: bisel no topo e na base, segmentos, perfil reto↔redondo, por lado |
| Chanfro/arredondamento de cantos verticais | Blender Bevel Vertices, Rhino Fillet | parcial | todos de uma vez; falta **um canto só** |
| Inclinar parede | Max Hinge | ok | campo por face |
| Afunilar topo | Max Taper | ok | campo |
| **Escala** do volume (largura, profundidade) | SketchUp Scale | falta | campos de largura e profundidade da caixa envolvente |
| **Dividir volume** na altura | Blender Bisect, Max Slice | falta | parte em dois volumes editáveis (materiais e recuos diferentes) |
| Mover vértice, dividir lado, apagar vértice | SketchUp, Blender | ok | alças de vértice, "Dividir lado" |
| Booleanas somar/recortar/interseção | Rhino, Blender Boolean | ok | por volume, editáveis |
| Espelhar, duplicar, matriz | todos | ok | Ctrl+D, 5x, 5/ |
| Ponte entre volumes | Max Bridge | falta | futuro |

## 3. Elementos paramétricos

| ferramenta | referência | estado | no FORMA |
|---|---|---|---|
| Famílias com parâmetros (janela, porta, sacada…) | Revit families | ok | ~75 tipos |
| Tipo × ocorrência (mudar o tipo muda todos) | Revit type/instance | parcial | só para peças avulsas; **clicar numa janela de fachada não mostra os parâmetros** |
| Regra de fachada editável por completo | Revit curtain grid, Archicad | parcial | só nível e valor; faltam modo, margem, peitoril, alinhamento, lados e parâmetros |
| Variação de um grupo | Revit duplicate type | ok | "Editar só estes" |

## 4. Organizar

| ferramenta | referência | estado | no FORMA |
|---|---|---|---|
| **Camadas** (visível, travada, cor, ativa) | SketchUp Tags, Rhino Layers | falta | camadas do projeto; volumes e peças avulsas têm camada; travada = visível e não selecionável |
| **Visibilidade por categoria** | Revit Visibility/Graphics | falta | esconder janelas, portas, sacadas… na vista |
| **Árvore de elementos** | SketchUp Outliner | falta | edifício → volumes → peças; clicar seleciona; olho e cadeado |
| Ocultar / isolar seleção | Revit Hide/Isolate | falta | olho na árvore; isolar volume |

## 5. Precisão e medida

| ferramenta | referência | estado | no FORMA |
|---|---|---|---|
| Caixa de medidas (10, 10x8, 5x, 5/) | SketchUp VCB | ok | |
| Inferência (vértice, meio, eixo, paralelo) | SketchUp | ok | |
| Grade e giro com passo | todos | ok | barra de estado |
| Trena e cotas | SketchUp Tape/Dimension | ok | T |
| Alinhar e distribuir | Illustrator, Max Align | ok | |

## Ordem de implementação

1. Parâmetros visíveis ao clicar em qualquer elemento; regra de fachada completa.
2. Extrudar face, Inset de face, Offset, Bevel (topo/base/por lado/um canto), Escala, Dividir na altura.
3. Camadas, visibilidade por categoria, árvore de elementos, ocultar/isolar.
4. As cinco construções de validação com essas ferramentas.

## Fontes

- Blender Inset Faces: https://docs.blender.org/manual/en/latest/modeling/meshes/editing/face/inset_faces.html
- Blender Bevel: https://docs.blender.org/manual/en/latest/modeling/meshes/editing/edge/bevel.html
- 3ds Max Edit Poly (polígono): https://help.autodesk.com/cloudhelp/2026/ENU/3DSMax-Modeling/files/GUID-FF7D7633-03AD-4427-821A-65F8AC484CDD.htm
- SketchUp Offset + Push/Pull: https://sketchup.trimble.com/en/blog/article/thick-walls-offset-tool
- Rhino Offset: https://docs.mcneel.com/rhino/8/help/en-us/commands/offset.htm
- SketchUp Tags: https://help.sketchup.com/en/sketchup/controlling-visibility-tags
- Rhino Layer: https://docs.mcneel.com/rhino/8/help/en-us/commands/layer.htm
- Revit Visibility/Graphics: https://help.autodesk.com/cloudhelp/2023/ENU/Revit-GetStarted/files/GUID-FB8D0ABE-8521-4EA0-A47E-FF3DEBC403A5.htm
