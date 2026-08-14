# Logica Pilot — sistema de identidade

**A web, sob seu comando.**

Este diretório contém a identidade verbal e visual do Logica Pilot. O sistema nasce da tese de **Navegação Soberana para Máquinas**: perceber a web por intenção, operar no browser real e transformar cada rota percorrida em memória local.

## Essência

- **Categoria:** Navegação Soberana para Máquinas.
- **Grande ideia:** a web como território legível, percorrível e memorável.
- **Inimigo:** a web alugada — sessões remotas, execução sem memória e custo recorrente por requisição.
- **Promessa:** dê à máquina um destino, não uma captura de tela.
- **Tagline:** **A web, sob seu comando.**
- **Personalidade:** preciso, soberano, atento, incansável.

A argumentação completa está em [`TESE.md`](./TESE.md).

## Conceito do logo: rota + beacon

O símbolo nasce de uma linha contínua que forma um **P**. Ela começa como trajeto, percorre um loop e encontra o Beacon Lime.

- **P:** Pilot, ponto de vista do produto.
- **Linha contínua:** navegação, crawler e execução persistente.
- **Loop:** memória por site; o percurso deixa aprendizado.
- **Beacon:** intenção encontrada, alvo acionável, estado conhecido.
- **Contraste azul/lime:** infraestrutura soberana + sinal vivo.

O desenho evita os clichês de IA (cérebro, faísca, robô) e os clichês de scraping (aranha, código genérico). É um instrumento de navegação, não um mascote.

## Arquivos de logo

| Arquivo | Uso |
|---|---|
| [`logo/logo-primary.svg`](./logo/logo-primary.svg) | Assinatura preferencial em fundo claro |
| [`logo/logo-primary-dark.svg`](./logo/logo-primary-dark.svg) | Assinatura em Graphite 950 ou superfícies escuras |
| [`logo/logo-wordmark.svg`](./logo/logo-wordmark.svg) | Espaços horizontais sem área para o símbolo |
| [`logo/logomark.svg`](./logo/logomark.svg) | Avatar, selo, navegação compacta |
| [`logo/logo-primary-mono-black.svg`](./logo/logo-primary-mono-black.svg) | Uma cor sobre fundo claro |
| [`logo/logo-primary-mono-white.svg`](./logo/logo-primary-mono-white.svg) | Uma cor sobre fundo escuro/fotográfico |
| [`logo/logomark-mono-black.svg`](./logo/logomark-mono-black.svg) | Símbolo preto |
| [`logo/logomark-mono-white.svg`](./logo/logomark-mono-white.svg) | Símbolo branco |
| [`logo/favicon.svg`](./logo/favicon.svg) | Aba do browser, 16–32 px |
| [`logo/app-icon.svg`](./logo/app-icon.svg) | Aplicativo, 512 × 512 |

Todos os letterings são vetoriais; não dependem de fonte instalada.

## Área de proteção

Defina **x** como o diâmetro do beacon no logomark.

- Assinatura completa: manter no mínimo `1,5x` em todos os lados.
- Logomark isolado: manter `1x` em todos os lados.
- Nenhum texto, borda, ícone ou corte pode invadir essa área.

## Tamanho mínimo

- Logo completo digital: **132 px** de largura.
- Logo completo impresso: **32 mm** de largura.
- Logomark: **24 px** digital; abaixo disso, usar `favicon.svg`.
- Favicon: aprovado em **16 px**.
- App icon: exportar a partir do SVG mestre; não redesenhar nem adicionar margem.

## Fundos e versões

1. Fundo Ivory/White: `logo-primary.svg`.
2. Fundo Graphite 950/900: `logo-primary-dark.svg`.
3. Reprodução de uma cor: versões mono preta ou branca.
4. Fotografia: preferir área calma e contraste alto; se não houver, usar placa Graphite 950 com área de proteção.

O Beacon Lime só aparece na versão colorida. Em mono, rota e beacon se fundem na mesma tinta.

## Faça

- Preserve proporção, espessura e posição do beacon.
- Use o arquivo apropriado para o contraste do fundo.
- Deixe a marca respirar; ela é deliberadamente econômica.
- Use Beacon Lime como sinal pequeno e funcional.
- Combine o logomark com Manrope nos materiais, nunca tente recompor o lettering.

## Não faça

- Não rotacione a rota nem mova o beacon.
- Não aplique gradiente, glow, sombra ou contorno ao logo.
- Não altere as cores fora das versões aprovadas.
- Não estique, comprima ou reescreva o wordmark com uma fonte.
- Não coloque o logo colorido sobre Sovereign Blue: perdem-se rota e hierarquia.
- Não transforme Beacon Lime em cor dominante de página.
- Não use o símbolo como letra P dentro de frases.

## Cor

O sistema completo e as combinações acessíveis estão em [`color.md`](./color.md). Os tokens prontos para produto estão em [`tokens.css`](./tokens.css).

Regra de composição: **70% neutros / 25% Sovereign Blue / 5% Beacon Lime**. O lime é sempre evento, não ambiente.

## Tipografia

Manrope é a família principal de comunicação. O wordmark é desenho próprio e não deve ser digitado. Escala, pesos e regras estão em [`type.md`](./type.md).

Princípios rápidos:

- Títulos curtos, peso 700, tracking negativo.
- Texto corrido em 400, 16 px ou mais, entrelinha generosa.
- Labels em 700, caixa alta, tracking aberto.
- Dados e rotas em mono, com numerais tabulares.
- Sentence case por padrão.

## Linguagem gráfica

### Route line

Linhas de 2–3 px com cantos redondos podem conectar etapas, módulos ou provas. Sempre começam num estado conhecido e terminam em um beacon. Não criar circuitos decorativos sem significado.

### Semantic index

Interfaces e materiais podem usar índices como `[01]`, `[02]`, `[03]` para mostrar que a página foi reduzida a intenções acionáveis. O índice deve organizar conteúdo real.

### Beacon

O círculo lime indica uma destas situações: alvo atual, rota ativa, aprendizado salvo ou conclusão válida. Uma composição deve ter um único beacon dominante.

### Superfícies

Cards usam borda fina e pouco relevo. Cantos arredondados vêm do browser e do instrumento, não de uma estética “fofa”. Evitar excesso de cápsulas.

## Aplicações

### Ícone do app

Usar [`app-icon.svg`](./logo/app-icon.svg) sem moldura adicional. Em macOS/iOS, o sistema pode aplicar máscara; o desenho já contém zona segura. Não inserir texto no ícone.

### Aba do browser

Usar [`favicon.svg`](./logo/favicon.svg). O campo azul mantém reconhecimento em abas claras e escuras; rota branca e beacon lime sobrevivem em 16 px.

### Splash / loading

Fundo Graphite 950. Logomark dark ou app icon centralizado a 72–96 px. Se houver animação, revelar a rota em 520 ms e acender o beacon uma vez; nunca pulsar indefinidamente. Abaixo, usar “Preparando a rota” — não “Pensando”.

### Interface de produto

Sovereign Blue marca ação e estrutura; Beacon Lime marca o ponto atual. Logs e IDs usam mono. Mensagens devem nomear o que o motor está fazendo: “Indexando intenções”, “Rota aprendida”, “Sessão local ativa”.

### Marketing

Começar pela tese, não pela lista de features. Sequência recomendada:

1. “A web, sob seu comando.”
2. Percepção por intenção, com prova de 5–185×.
3. Browser real + memória local.
4. Plataforma completa de 82 ferramentas.

## Co-branding Rovemark

Quando as duas marcas aparecem, Logica Pilot é o produto e Rovemark é o endosso. Usar a linha “by Rovemark” em Manrope Medium, Graphite 600, com altura óptica de 18% do wordmark. Nunca acoplar o logo Rovemark dentro do símbolo Pilot.

## Preview

Abra [`preview.html`](./preview.html) diretamente no browser. A página é auto-contida, funciona offline e mostra assinatura, tese, paleta, tipografia, sistema claro/escuro, ícone de aplicativo e aba.

