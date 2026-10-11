# Seleção múltipla, grupos de elementos e exceções

Pedido: selecionar vários elementos (caixa, Shift, Ctrl), ver os elementos do
edifício agrupados (janelas, portas…) com parâmetros, e deixar alguns fora da
regra dos demais (estilo, tamanho ou posição próprios).

Estado (2026-10-10): tudo abaixo está feito e foi usado no editor (5792):
caixa em janela e cruzada, modificadores, grupo que move/copia/gira/apaga
junto, grupos automáticos com pré-destaque, variação "só os selecionados",
soltar da regra (sem refluir a regra) e voltar à regra (com a variação).

## Referências lidas

- SketchUp, *Selecting geometry* (help.sketchup.com/en/sketchup/selecting-geometry):
  Ctrl adiciona, Shift alterna, Ctrl+Shift tira; arrastar para a direita pega
  só o que fica inteiro na caixa, para a esquerda também o que ela toca.
- Figma, *Apply overrides to instances*: a instância guarda só as diferenças
  em relação ao principal; "Restaurar" desfaz; "Desanexar" tira da regra.
- Revit (tipo × ocorrência): o tipo vale para todas as ocorrências; para
  algumas serem diferentes, duplica-se o tipo e troca-se o tipo delas.
- three.js r170 `SelectionBox`: testa só o centro de cada objeto. Aqui a caixa
  de cada elemento é projetada (8 cantos) para distinguir "inteiro dentro" de
  "tocado".

## Modelo (o que já existia e o que entra)

- Elemento = ocorrência de uma regra de fachada (`r|sólido|regra|posição`) ou
  componente avulso (`i|item|cópia`). Já existiam: Fileira, Coluna, Crescer,
  Encolher, Mesmo tipo, Face; trocar tipo; remover; "só os selecionados" cria
  uma **variação** do tipo (Revit: duplicar tipo) só para eles.
- **Grupos automáticos**: o edifício lista os elementos por categoria da
  família (Janelas, Portas, Sacadas…), e dentro dela por tipo, com contagem.
  Variações aparecem sob o tipo de origem. Clique seleciona o grupo; os
  modificadores valem como no modelo. Os parâmetros do grupo são os do tipo
  ("Todos do tipo"); mudar com "Só os selecionados" cria a variação.
- **Soltar da regra** (Figma: desanexar): o elemento vira componente avulso no
  mesmo lugar (a regra deixa a posição vazia) e passa a ser movido e
  dimensionado sozinho. Guarda a origem; **Voltar à regra** apaga o avulso e
  devolve a posição à regra.

## Interação

| gesto | efeito |
|---|---|
| clique | substitui a seleção |
| Ctrl+clique | adiciona |
| Shift+clique | alterna |
| Ctrl+Shift+clique | tira |
| Alt+clique (elemento) | o trecho entre o último e este |
| arrastar no vazio, ou com Ctrl/Shift em qualquer lugar | caixa de seleção |
| caixa →  | janela: só o que fica inteiro dentro (borda contínua) |
| caixa ←  | cruzada: o que ela toca (borda tracejada) |

Fora de um edifício a caixa pega edifícios; dentro, elementos (só os de faces
voltadas para a câmera, para não pegar o fundo) e componentes; sem elementos
na caixa, pega volumes. Os modificadores da caixa são os mesmos do clique.
