# FORMA 3: pesquisa e decisões

Registro curto do que foi lido e do que foi decidido. Cada decisão aponta a fonte.

## Fontes lidas

Modelagem direta
- SketchUp, inferência e travas de eixo: https://help.sketchup.com/en/sketchup/introducing-drawing-basics-and-concepts
- SketchUp, Push/Pull: https://help.sketchup.com/en/sketchup/pushing-and-pulling-shapes-3d
- SketchUp, caixa de medidas (`5x`, `5/`): https://help.sketchup.com/using-measurements-box
- SketchUp, girar, espelhar, arranjos: https://help.sketchup.com/en/sketchup/flipping-mirroring-rotating-and-arrays
- SketchUp, componentes (Glue To, Cut Opening): https://help.sketchup.com/sketchup/creating-basic-component
- SketchUp, componentes dinâmicos (cópias pelo comprimento): https://help.sketchup.com/en/sketchup/repeating-sub-component-within-dynamic-component-1-dimension
- SketchUp, Solid Tools: https://help.sketchup.com/sketchup-ipad/solid-tools
- Blender, modificadores, Boolean, Array, Bevel, Solidify: https://docs.blender.org/manual/en/latest/modeling/modifiers/introduction.html
- Blender, snapping e entrada numérica: https://docs.blender.org/manual/en/latest/editors/3dview/controls/snapping.html, https://docs.blender.org/manual/en/latest/scene_layout/object/editing/transform/control/numeric_input.html
- Archipack (paredes, janelas com furo automático, telhados): https://github.com/s-leger/archipack/wiki
- Rhino 8, Gumball: https://docs.mcneel.com/rhino/8/help/en-us/commands/gumball.htm
- Rhino 8, PushPull, Osnaps, History, ArrayCrv, Loft: https://docs.mcneel.com/rhino/8/help/en-us/commands/
- Townscaper (blocos que resolvem quinas e telhados pelos vizinhos): https://www.gamedeveloper.com/game-platforms/how-townscaper-works-a-story-four-games-in-the-making

Arquitetura paramétrica
- Revit, famílias, tipo × instância, aninhamento: https://help.autodesk.com/cloudhelp/2024/ENU/Revit-Customize/files/GUID-921F7A15-D191-4F75-8243-4989C482E253.htm
- Revit, pele de vidro (Fixed Distance, Fixed Number, Maximum Spacing, Justification): https://help.autodesk.com/cloudhelp/2018/ENU/Revit-Model/files/GUID-B9263125-74EA-4C78-AAAA-F40916EFE2DB.htm
- Revit, telhado por contorno (inclinação e beiral por aresta): https://help.autodesk.com/cloudhelp/2016/ENU/Revit-Model/files/GUID-682B3B19-A4F7-4EE7-B994-F3EA3154BB08.htm
- Revit, guarda-corpo (padrão, Spread Pattern to Fit, sobra): https://help.autodesk.com/cloudhelp/2023/ENU/Revit-ArchDesign/files/GUID-426BE12E-A906-457B-A205-A5DFF08B07D7.htm
- Revit, peça hospedada que não cabe ("Can't cut instance out of wall"): https://help.autodesk.com/cloudhelp/2019/ENU/Revit-Troubleshooting/files/GUID-3C9C035F-BFA8-44A5-923A-C4E75F5D5E1C.htm
- Archicad, Curtain Wall Scheme (Best Division, cadeados): https://help.graphisoft.com/AC/26/INT/_AC26_Help/040_ElementsVB/040_ElementsVB-157.htm
- Archicad, Roof multiplano e Shell (extrudado, revolvido, regrado): https://help.graphisoft.com/AC/29/INT/_AC29_Help/150_UserInterfaceToolSettings/150_UserInterfaceToolSettings-4.htm, ...-5.htm
- Archicad GDL, hotspots que editam parâmetros: https://gdl.graphisoft.com/gdl-basics/hotspots-graphical-editing
- Vectorworks, parâmetros de janela: https://app-help.vectorworks.net/2021/eng/VW2021_Guide/Windows/Inserting_windows.htm
- Chief Architect, telhado automático por parede: https://www.chiefarchitect.com/support/article/KB-00758/generating-automatic-hip-and-gable-roofs.html
- FreeCAD BIM (janela, parede, telhado por aresta, escada com Blondel, arranjos): https://github.com/FreeCAD/FreeCAD-documentation/tree/main/wiki
- Autodesk Forma, esboço 3D e pavimentos por função: https://blogs.autodesk.com/forma/2026/04/21/how-to-create-a-3d-sketch-building-in-forma-site-design/
- CityEngine CGA, split/repeat/comp e telhados: https://doc.arcgis.com/en/cityengine/latest/cga/cga-split.htm

Técnica
- Manifold (booleanas 3D robustas, IDs de face preservados): https://github.com/elalish/manifold, https://manifoldcad.org/docs/jsapi/classes/manifold.Manifold.html
- three-bvh-csg, problemas com faces coplanares: https://github.com/gkjohnson/three-bvh-csg/issues/199, /issues/210
- three.js TransformControls r170 e r186 (código-fonte comparado), ExtrudeGeometry, LatheGeometry, Path
- three.js, leitura assíncrona de render target: `WebGLRenderer.readRenderTargetPixelsAsync`; MDN WebGL best practices: https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices
- That Open Components, `SnapResolver` (pontos, linhas, faces): https://github.com/ThatOpen/engine_components

## Medição

manifold-3d 3.5.4 em Node (inicialização 10 ms). Prédio do zero, com união, pátio, vãos e vazios por pavimento:

| volumes | pavimentos | vãos | tempo |
|---|---|---|---|
| 20 | 6 | 120 | 30 ms |
| 20 | 10 | 400 | 45 ms |
| 40 | 15 | 900 | 92 ms |

## Decisões

1. **Sólidos reais com booleanas 3D (Manifold).** Cada volume vira um sólido fechado. União, diferença e interseção ficam no documento como operandos vivos, e o resultado é recalculado (modificador do Blender, não Solid Tools destrutivo do SketchUp). Isso também resolve o encontro de volumes: o volume de cima e o telhado de baixo viram um sólido só, sem peças atravessadas.
2. **Telhados como sólidos** unidos ao corpo: esqueleto reto (quatro águas, duas águas, mansarda), água única, gambrel, cúpula por revolução, abóbada por extrusão de arco, pirâmide e cone.
3. **Planta com arcos** (vértice com `bulge`, como polilinha do CAD), cantos arredondados e chanfrados por vértice. Afunilamento e paredes inclinadas por lado: o topo é um deslocamento da base, e o volume é o sólido entre os dois anéis (Loft com seções retas do Rhino).
4. **Fachada pela região visível de cada face.** O Manifold mantém o ID da face de origem em cada triângulo do resultado. A parte de cada face que sobrou depois das booleanas define onde cabem as janelas: parede escondida dentro de outro volume não recebe janela.
5. **Componentes que abrem o próprio vão** (Cut Opening do SketchUp, AutoBoolean do Archipack): janelas, portas e portões presos a uma face carregam o recorte e acompanham a face quando ela muda.
6. **Repetição pelo comprimento** (componente dinâmico do SketchUp, Array do Blender): quantidade = piso(comprimento / passo), por contagem, distância ou entre extremos. Esticar a fachada acrescenta peças em vez de esticá-las.
7. **Definição compartilhada**: editar o tipo muda todas as ocorrências; "tornar único" cria um tipo novo para aquela ocorrência.
8. **Um widget de manipulação** (Gumball do Rhino): setas para mover no chão, arco para girar em Y, alça de altura, empurrar e puxar faces com prévia e cotas ao vivo.
9. **Inferência e caixa de medidas** (SketchUp, Blender): encaixe em vértice, meio, aresta, eixo, paralelo e mesma altura; travas por tecla; digitar o valor durante ou logo depois da operação, com `5x` e `5/` para cópias.
11. **Família → tipo → ocorrência** (Revit, FreeCAD): a família é uma função pura `parâmetros → peças` com esquema declarado (unidade, faixa, tipo ou ocorrência). A ocorrência guarda posição e sobreposições, marcadas na interface com "voltar ao tipo".
12. **Peça hospedada nunca anda sozinha** (Revit): guarda a distância ao longo da face e a cota; se a face muda e ela não cabe, fica marcada como inválida e é avisada, nunca reposicionada em silêncio.
13. **Quatro modos de distribuição** para janelas, pilares, brises, balaústres e mourões (Revit, Archicad): distância fixa com justificação, espaçamento máximo, número fixo e melhor divisão.
14. **Telhado com parâmetros por aresta** (Revit, FreeCAD, Chief): cada aresta escolhe se inclina, com qual inclinação e beiral; sem nada definido, todas inclinam. Abóbadas e cúpulas por extrusão e revolução (Shell do Archicad).
15. **Escada derivada da altura** (FreeCAD, Revit): `n = ceil(desnível / espelho máximo)`, guarda-corpo gerado junto.
16. **Cálculo no worker.** O documento vai para o worker, que devolve arrays; a tela nunca trava. Durante o arrasto, só o corpo é refeito.
