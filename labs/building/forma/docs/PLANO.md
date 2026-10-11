# FORMA 3: plano

Objetivo: construtor 3D completo (casas, prédios, indústrias, galpões, lojas,
equipamentos públicos, curvos e irregulares), com construção direta no modelo,
componentes paramétricos e exportação para o jogo. Fontes e decisões em
`docs/PESQUISA.md`. Uma fase só fecha quando foi usada no navegador.

## Arquitetura

```
src/f3/model      documento forma/3, migração do forma/2, operações (sem three)
src/f3/kernel     Manifold: sólidos, booleanas, cortes (sem three)
src/f3/families   famílias de componentes: parâmetros → peças (sem three)
src/f3/eval       prédio → casca + peças + regiões de face + mapa de seleção (sem three, roda no worker)
src/f3/render     dados avaliados → three.js
src/f3/editor     cena, seleção, widget, ferramentas, inferência, medidas, histórico
src/f3/ui         barra contextual, inspetor compacto, catálogo
```

Documento: Projeto → Edifícios (movem e giram inteiros) → Níveis, Sólidos
(planta com arcos, base, altura, afunilamento, inclinação por lado, cantos,
operação add/sub/int, telhado, regras de fachada, materiais) e Ocorrências de
componentes (hospedadas numa face, livres, em caminho ou no telhado, com
arranjo). Tipos de componente no projeto, ligados às ocorrências.

## Fases

A. Núcleo sólido: esquema forma/3 e migração; sólidos (planta com arcos,
   cantos, afunilamento, inclinação); telhados sólidos (plano, água única,
   duas águas, quatro águas, mansarda, gambrel, cúpula, abóbada, pirâmide,
   dente de serra); booleanas vivas; regiões de face; vãos recortados;
   avaliação no worker; render. Pronto quando: volumes que se encontram viram
   um sólido só, recuo sobre telhado sem peça atravessada, cúpula de verdade.

B. Editor direto: seleção prédio/sólido/face/aresta/componente; widget (mover
   no chão, girar em Y, altura); empurrar/puxar face; desenhar retângulo,
   polígono, arco, círculo, curva; inferência (vértice, meio, aresta, eixo,
   paralelo, mesma altura) e caixa de medidas com `5x`/`5/`; booleanas pela
   seleção; afunilar, inclinar, arredondar, chanfrar com alças; desfazer.

C. Componentes: famílias paramétricas (janelas, portas, portões, sacadas,
   varandas, guarda-corpos, grades, muros, cercas, pilares, vigas, escadas,
   rampas, marquises, toldos, brises, cornijas, pilastras, ornamentos,
   chaminés, claraboias, caixas-d'água, placas solares, elementos
   industriais); tipos e ocorrências ligadas, tornar único; arranjos em
   linha, grade, curva e face; regras de fachada com quatro modos de
   distribuição; catálogo com busca, miniaturas, favoritos e arrastar;
   salvar, importar e exportar componentes próprios.

D. Pavimentos e estrutura: níveis do edifício; paredes internas, lajes com
   recortes, escadas e rampas entre níveis, terraços, pilares e vigas;
   interior em corte; modo caminhar.

E. Fechamento: lotes e índices; estilos; modelos prontos refeitos no forma/3;
   salvar, abrir, exportar GLB/OBJ completos e JSON para o jogo; desempenho;
   as cinco construções de validação; documentação.

## Validação (fase E)

Do zero, no navegador: casa com telhado inclinado; prédio com varandas;
indústria; construção curva; construção irregular com pátio interno. Mudar
medidas depois de montar, booleanas, componentes vinculados, salvar, abrir,
exportar.
