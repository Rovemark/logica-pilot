# Logica Pilot — MCP & CLI (o substituto parrudo do Playwright)

Um motor de automação de browser **CDP puro** (sem Playwright/Puppeteer) exposto via
**CLI** e **MCP**, feito pra **economizar token**: em vez de mandar HTML cru ou
screenshot inteiro pro modelo, ele entrega **percepção compacta** (mapa indexado
`[0] button "Comprar"`) e age **por índice** — 10–100× menos tokens. Multi-agent
embutido (`fanout`).

## Por que ganha do Playwright + LLM

| | Playwright + LLM | Logica Pilot |
|---|---|---|
| O que o modelo vê | HTML cru / screenshot inteiro (milhares de tokens) | mapa indexado + texto legível (compacto) |
| Como age | seletores frágeis / coordenadas | **por índice / intenção** |
| Paralelismo | você orquestra na mão | **`fanout` nativo** (N páginas em paralelo + síntese) |
| Acesso | biblioteca | **CLI + MCP** (qualquer agente pluga) |
| Login | reloga a cada script | **`session`** (loga uma vez, reusa) |

## MCP — plugar no Claude Desktop / Cursor / Cline

```jsonc
// claude_desktop_config.json (ou o mcp.json do seu cliente)
{
  "mcpServers": {
    "logica-pilot": { "command": "logica-pilot", "args": ["mcp"] }
  }
}
```

> A IA usa a **sua** chave: rode uma vez `logica-pilot` (abre o browser) → Configurações →
> "Chave da IA", **ou** exporte `ANTHROPIC_API_KEY`, **ou** rode o LogicaProxy local.

### As 10 tools

| Tool | O que faz (token-first) |
|---|---|
| `browser_navigate` | navega e devolve o **mapa indexado** da página |
| `browser_observe` | o mapa indexado da página atual (percepção compacta) |
| `browser_act` | age por **índice**: `click` · `type` · `press` · `scroll` |
| `browser_extract` | dados **estruturados → JSON** (schema/instrução) ou seletor CSS |
| `browser_read` | conteúdo **legível** (readability) + resumo opcional |
| `browser_run` | executa um **objetivo multi-passo** autônomo |
| `browser_fanout` | **MULTI-AGENT**: N URLs em paralelo + síntese |
| `browser_watch` | diz se uma URL **mudou** desde a última checagem |
| `browser_session` | **login uma vez**, reusa cookies (`save`/`load`/`list`) |
| `browser_screenshot` | fallback visual (com set-of-marks opcional) |

## CLI

```bash
logica-pilot mcp                     # sobe o servidor MCP (stdio)
logica-pilot open <url>              # imprime o mapa indexado (observe)
logica-pilot read <url> [--summarize]
logica-pilot extract <url> --task "nome, preço e nota do produto"
logica-pilot run "<objetivo>" [--url U] [--headful] [--json]
logica-pilot fanout --urls a.com,b.com,c.com \
  --task "extraia preço e nota" \
  --synthesize "qual o melhor custo-benefício?"
```

## Receitas multi-agent (tudo em cima do `fanout`)

As "features matadoras" são invocações de `fanout` com um prompt de síntese:

- **Deep Research** — `fanout --urls <fontes> --task "resuma os fatos" --synthesize "responda X com citações"`
- **Compare Anything** — `fanout --urls <produtos> --task "specs+preço+nota (JSON)" --synthesize "tabela comparativa + recomendação"`
- **Best Deal** — `fanout --urls <lojas> --task "preço+frete+disponibilidade" --synthesize "rankeie por valor real"`
- **Fact-Check** — `fanout --urls <fontes indep> --task "o que a fonte diz sobre a afirmação" --synthesize "veredito + citações"`

## Sem dependências

Descobre o Chromium instalado (Chrome/Edge/Brave/Chromium) e fala CDP por
`--remote-debugging-pipe`. Zero Playwright, zero Puppeteer.
