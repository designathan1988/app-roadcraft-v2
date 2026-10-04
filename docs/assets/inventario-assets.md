# Inventário de assets de construção — o que precisa existir

Levantado em 2026-10-04 a partir de pesquisa (fontes no fim) e do pedido do jogador:
"existem infinitas possibilidades de criação de prédios e você faz todos iguais".

Legenda: **[existe]** já desenhado pelo motor · **[criar]** não existe · **[variar]** existe
uma versão só, precisa das variantes listadas.

Cada item abaixo é um asset paramétrico: tem forma, proporção, material e cor
escolhidos por prédio (estilo salvo no prédio, editável no Construtor), e é
combinado por uma gramática de fachada (Müller et al. 2006: divisão em andares,
vãos e elementos, com regras por tipo de prédio).

---

## 1. Janelas (esquadrias)

Tipos de abertura (cada um com caixilho de 1, 2, 3, 4 folhas e travessas):

| # | Tipo | Estado |
|---|---|---|
| 1 | Fixa (vidro único) | [variar] |
| 2 | De correr 2 folhas | [criar] |
| 3 | De correr 3/4 folhas | [criar] |
| 4 | Guilhotina (sash) com 6/6, 2/2, 1/1 vidros | [variar] |
| 5 | Casement / de abrir 1 e 2 folhas | [criar] |
| 6 | Maxim-ar | [criar] |
| 7 | Basculante (banheiro) | [criar] |
| 8 | Pivotante | [criar] |
| 9 | Veneziana de abrir (folhas de madeira/alumínio) | [criar] |
| 10 | Persiana de enrolar (rolo, parcialmente baixa) | [existe] |
| 11 | Janela com bandeira (transom/fanlight) | [criar] |
| 12 | Janela em arco pleno / segmentado / ogival | [criar] |
| 13 | Janela redonda (óculo) | [criar] |
| 14 | Bay window (saliente com base) | [variar] |
| 15 | Bow window (curva) | [criar] |
| 16 | Janela de canto (vidro em L) | [criar] |
| 17 | Faixa horizontal contínua (ribbon) | [existe] |
| 18 | Janela piso-teto (porta-janela) | [variar] |
| 19 | Janela francesa com sacada | [variar] |
| 20 | Janela com grade de ferro (reta, arabesco, quadriculada) | [criar] |
| 21 | Janela de vidro canelado/fosco | [criar] |
| 22 | Clarabóia / janela de telhado (água-furtada) | [criar] |
| 23 | Jalousie / palhetas de vidro | [criar] |
| 24 | Brise-soleil vertical e horizontal na frente da janela | [criar] |
| 25 | Cobogó (elemento vazado) em lugar da janela | [criar] |

Acessórios de janela: moldura saliente (reta, com frontão triangular, com
frontão curvo, com pedra-chave), peitoril (reto, com pingadeira, de pedra),
floreira com flores, toldo de janela, ar-condicionado de janela/split externo,
cortina, varal, grade de proteção.

## 2. Varandas e sacadas

| # | Tipo | Estado |
|---|---|---|
| 1 | Balanço (cantilever) com gradil de barras verticais | [existe] |
| 2 | Guarda-corpo de vidro com corrimão | [criar] |
| 3 | Guarda-corpo de vidro sem corrimão (structural) | [criar] |
| 4 | Mureta de alvenaria (parapeito cheio) | [criar] |
| 5 | Mureta + vidro em cima | [criar] |
| 6 | Barras horizontais (tubos) | [criar] |
| 7 | Gradil quadriculado / tela | [criar] |
| 8 | Balaústres (colunas torneadas) | [criar] |
| 9 | Ferro forjado com arabescos | [criar] |
| 10 | Chapa perfurada metálica | [criar] |
| 11 | Ripado de madeira | [criar] |
| 12 | Sacada francesa (Julieta, sem laje) | [criar] |
| 13 | Loggia (varanda recuada, dentro do volume) | [criar] |
| 14 | Varanda corrida (ao longo da fachada toda) | [criar] |
| 15 | Varanda de canto / envolvente (wraparound) | [criar] |
| 16 | Varanda apoiada em pilares (stacked) | [criar] |
| 17 | Varanda suspensa por tirantes (hung) | [criar] |
| 18 | Varanda gourmet fechada com vidro (envidraçamento de sacada) | [criar] |
| 19 | Varanda com jardineira na borda | [criar] |
| 20 | Varanda curva (laje arredondada) | [criar] |

Lajes: espessura, com/sem pingadeira, revestida, com testeira colorida.
Conteúdo da varanda: vasos, cadeiras, mesa, rede, varal, churrasqueira, ar-condicionado.

## 3. Portas e entradas

Porta de madeira almofadada · lisa · de vidro com caixilho · de correr de vidro ·
porta dupla · porta pivotante grande · porta com bandeira · porta de enrolar
(loja) · portaria de prédio (porta de vidro + hall) · eclusa · porta de serviço ·
porta corta-fogo · porta de garagem (basculante, seccional, de enrolar) ·
portão de doca industrial.

Coberturas de entrada: marquise de laje [existe] · marquise de vidro com
tirantes · marquise metálica curva · toldo · pórtico com colunas · frontão ·
pergolado · arco.

Escada de entrada, rampa de acessibilidade, corrimão, campainha/interfone,
caixa de correio, número da casa, luminária de parede.

## 4. Fachadas (pele, revestimento, composição)

Materiais/texturas: reboco liso, textura grafiato, chapisco, tijolo aparente
(vários aparelhos e cores), pedra (canjiquinha, ardósia, miracema, granito),
pastilha cerâmica, porcelanato, madeira (ripado, deck), concreto aparente,
painel ACM, chapa metálica ondulada/trapezoidal, vidro (pele de vidro),
spandrel, cobogó, brise.

Composição: embasamento de outra cor/material, frisos e faixas por andar,
cornija, platibanda com coroamento, cunhais nas quinas, pilastras, colunas,
pórticos, molduras, bossagem, painéis em cores alternadas, faixa vertical de
destaque, cantos chanfrados/arredondados, recuos escalonados.

Pele de vidro (curtain wall): montantes e travessas, vidro de visão e spandrel,
vidro reflexivo azul/verde/bronze/prata, structural glazing, fachada dupla.

## 5. Telhados e coberturas

Formas: duas águas [existe] · quatro águas [existe] · uma água [existe] ·
plano/laje [existe] · terraço [existe] · dente de serra [existe] ·
mansarda · gambrel · borboleta · cúpula · abóbada · telhado verde ·
telhado escondido por platibanda · shed com claraboias.

Materiais: telha colonial, francesa, portuguesa, cerâmica esmaltada,
concreto, fibrocimento ondulada, metálica trapezoidal, sanduíche, shingle,
ardósia, laje impermeabilizada, telhado verde.

Elementos: beiral com caibros/forro, rufo, calha e condutor, cumeeira,
água-furtada (dormer), chaminé, claraboia, caixa d'água (fibra, concreto,
metálica com torre), casa de máquinas, antena, parabólica, placa solar
fotovoltaica, aquecedor solar, condensadoras de ar, exaustor, para-raios,
heliponto, piscina na cobertura, pergolado na cobertura, guarda-corpo.

## 6. Elevadores e circulação externa

Elevador panorâmico externo com cabine de vidro que sobe e desce (animado,
visto de fora) · torre de elevador de vidro · escada externa metálica · escada
de incêndio (fire escape) · passarela entre blocos · rampa · escada rolante
externa (comércio).

## 7. Comércio

Vitrine (vários tamanhos), porta de enrolar, toldo reto/curvo/em concha/
corrido/listrado, marquise corrida, letreiro (caixa luminosa, letra caixa,
bandeira/blade, neon), adesivo de vitrine, outdoor, painel de LED, cardápio na
calçada, mesas e cadeiras na calçada com guarda-sol, deck/parklet, floreiras,
expositor de mercadoria na calçada, caixa eletrônico, câmera, alarme,
ar-condicionado na fachada, galeria com arcada, rua coberta.

## 8. Indústria

Galpão (metálico, alvenaria, pré-moldado), docas com portas seccionais,
niveladores, abrigos de doca, para-choques de doca, marquise de doca, pátio de
manobra, vagas de carreta, balança rodoviária, guarita com cancela, silos,
tanques, chaminé, torre de resfriamento, ponte rolante externa, esteiras,
tubulações e racks de tubo, subestação e transformadores, caixa d'água
industrial, empilhadeiras, paletes, contêineres, caçambas, cerca de
alambrado com concertina, portão industrial de correr.

## 9. Lote: muros, cercas, grades, portões

Muros: reboco liso, chapisco, grafiato, tijolo aparente, bloco de concreto
aparente, pedra, cobogó, muro baixo + gradil, muro com capa/pingadeira,
muro com cerca elétrica, muro verde (trepadeira), muro com iluminação.

Cercas e grades: gradil de ferro vertical, gradil de ferro com lança, gradil
de aço galvanizado (tela soldada), alambrado, madeira (ripas, piquete, rústica),
cerca viva, concertina, vidro.

Portões: de correr (cheio, vazado, misto), basculante, pivotante 1 e 2 folhas,
de pedestre com cobertura, eletrônico com motor, de grade, de chapa lisa, de
madeira, de lambri, com visor.

Equipamentos de acesso: interfone, caixa de correio, lixeira de calçada,
guarita, cancela, catraca, eclusa social, passa-volumes.

## 10. Lote: pisos, paisagismo, áreas

Pisos: asfalto, concreto, cimentado, intertravado (vários desenhos e cores),
pedra portuguesa, cerâmica, porcelanato externo, deck de madeira, brita,
grama, grama + piso (concregrama), areia, piso tátil.

Estacionamento que funciona: vagas com faixa, para-choque/batente, vaga PCD,
moto, bicicletário, rampa de acesso com rebaixo de guia, cancela, guarita,
cobertura de vagas (metálica, lona, solar), garagem coberta, garagem subterrânea
com rampa.

Paisagismo: árvores (várias espécies), palmeiras, arbustos, cerca viva,
canteiros, jardineiras, gramado, horta, pergolado, fonte, espelho d'água,
piscina, deck, iluminação de jardim, banco, mesa, guarda-sol, rede.

Lazer de condomínio: guarita, portaria com eclusa, piscina, playground,
quadra, churrasqueira, salão de festas, academia ao ar livre, pet place,
bicicletário, área de lixo.

## 11. Prédios públicos

Escadarias monumentais, colunatas, frontão, cúpula, relógio, mastro de
bandeiras, praça cívica, letreiro institucional, rampa, estacionamento
oficial, guarita, grades históricas, monumento/estátua, fonte.

## 12. Mobiliário e objetos urbanos ligados ao lote

Poste de iluminação, luminária de parede, câmera, placa de número, placa de
"vende-se/aluga-se", caixa de correio, lixeira, caçamba, botijão de gás
(abrigo), medidor de luz/água (padrão de entrada), relógio de luz, antena,
varal, bicicleta, carro estacionado, vaso.

## 13. Publicidade

Outdoor sobre estrutura, outdoor de parede (empena), painel de LED,
totem, letreiro de cobertura, front-light/back-light, banner, placa de obra.

## 14. Cores e pinturas

Paletas por estilo (colonial, moderno, art déco, industrial, contemporâneo,
popular brasileiro), cor do embasamento, cor de detalhe (molduras, frisos),
cor de esquadria, cor de grade/gradil, cor de portão, cor de toldo, cor de
letreiro, desgaste/sujeira/pichação controlados.

---

## Ordem de construção

1. Estilo por prédio salvo e editável (dados + Construtor).
2. Janelas, varandas, portas, molduras, frisos (§1–§4).
3. Telhados e elementos de cobertura (§5).
4. Muros, cercas, portões, pisos de lote (§9–§10).
5. Comércio, indústria, públicos, publicidade (§7, §8, §11, §13).
6. Elevador panorâmico animado e circulação externa (§6).
7. Estacionamento e entradas que funcionam na simulação (§10).

## Fontes

- Müller, Wonka et al., *Procedural Modeling of Buildings* (SIGGRAPH 2006): https://dl.acm.org/doi/10.1145/1141911.1141931
- Zweig, *Procedural Architectural Facade Modeling*: https://cs.brown.edu/media/filer_public/40/59/4059db66-c7dd-480e-8b5c-2899208e233e/zweig.pdf
- Tipos de janela: https://www.homestratosphere.com/types-of-windows/ · https://grammareco.com/types-of-windows-and-pictures/
- Tipos de varanda: https://en.wikipedia.org/wiki/Balcony · https://thearchitectsdiary.com/20-types-of-balcony-that-redefine-outdoor-spaces/
- Tipos de telhado e elementos: https://www.iko.com/na/blog/roof-types-shapes-and-styles-of-residential-roofs/ · https://en.wikipedia.org/wiki/Dormer · https://cob.org/wp-content/uploads/architectural-term-high-res2.pdf
- Fachada residencial (elementos): https://www.maelco.com.br/2020/10/13/elementos-que-compoem-uma-fachada/
- Portões: https://meuserralheiro.com.br/diferentes-tipos-de-portao-eletronico-basculante-de-correr-pivotante-de-abrir-e-etc/ · https://www.decorfacil.com/modelos-de-portoes/
- Indústria / docas: https://en.wikipedia.org/wiki/Loading_dock · https://www.linklogistics.com/news-insights/industrial-real-estate-101/what-is-a-loading-dock-a-guide-to-types-configurations-and-key-features/
- Comércio / toldos / letreiros: https://www.nyc.gov/site/buildings/dob/key-project-terms-storefront.page · https://duraluxcanopies.com/storefront-awnings-canopy-guide/ · https://www.davessigns.com/storefront-signs-the-ultimate-guide/
- Condomínio / áreas comuns: https://www.helbor.com.br/blog/mercado-imobiliario/areas-comuns-de-condominio
- Pele de vidro, spandrel, elevador panorâmico: https://www.guardianglass.com/us/en/why-glass/build-with-glass/applications-of-glass/glass-for-facades/curtain-wall · https://fgglass.com/blogs-details/lift-shafts-and-glass-cladding-of-elevators
- Pacote de referência de jogo (escala de um kit de cidade): https://syntystore.com/products/polygon-city-pack
