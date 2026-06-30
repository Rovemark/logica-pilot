<div align="center">

# ◢ Logica Pilot

**O browser que a IA pilota.**

Um navegador Chromium de verdade — abas, barra de endereço, logins — com um
copiloto autônomo embutido. A IA **vê** a página por intenção (não por pixel),
**clica, digita, rola e lê** sozinha até cumprir o objetivo.

Motor **CDP puro** · zero dependência de Playwright · headless **e** janela real.

`open source (GPL-3.0)` · `parte da suíte Logica™ · Rovemark` · `integrado ao LogicaOS`

</div>

---

## O que é

O Playwright (e o jeito antigo de "IA + browser") é **burro**: tira screenshot,
a IA chuta coordenadas `x,y`, clica no pixel — e quebra a cada mudança de layout.

O **Logica Pilot** inverte isso. Ele injeta percepção na página e entrega à IA um
**mapa semântico indexado**:

```
[0] button "Aceitar cookies"
[1] textbox "Pesquisar"        ph="O que você procura?"
[2] link "Entrar"
...
```

A IA age por **intenção**: *"digita 'iPhone 15' no [1] e aperta Enter"*. Resiliente,
barato e rápido. Quando a página é opaca (canvas, mapas), ele cai pro modo **visão**
(screenshot com os mesmos índices desenhados como etiquetas).

## Dois shells, um motor

```
            ┌──────────── MOTOR LOGICA PILOT ────────────┐
            │  percepção (a11y + visão)                   │
            │  ações por intenção (click/type/scroll)     │
            │  loop autônomo (Claude via LogicaProxy)     │
            └───────┬─────────────────────────┬───────────┘
        CDP via pipe│                          │CDP via webContents.debugger
                    ▼                          ▼
        ┌───────────────────────┐   ┌──────────────────────────────┐
        │  MODO HEADLESS        │   │  BROWSER (Electron = Chromium)│
        │  p/ os agentes        │   │  janela real · abas · painel  │
        │  scraping/automação   │   │  Pilot ao vivo                │
        └───────────────────────┘   └──────────────────────────────┘
```

O Electron **é** o Chromium. O `webContents.debugger` **é** o Chrome DevTools
Protocol. Então o mesmíssimo motor que roda headless dirige a janela real — a IA
tem controle total porque fala CDP com o Chromium embarcado.

## Navegador completo

Não é só o motor de IA — é um navegador de verdade, com identidade própria
(clean/futurista, tema claro/escuro/sistema):

- **Abas** com favicon, indicador de áudio, spinner, overflow, reabrir fechada (⌘⇧T), ⌘1–9
- **Omnibox** com sugestões (histórico + busca), cadeado de segurança, barra de progresso
- ⭐ **Favoritos** — estrela, barra (⌘⇧B) e gerenciador
- 🆕 **New Tab** com mais visitados · 🕘 **Histórico** · ⬇️ **Downloads** (páginas `pilot://`)
- 📄 **PDF nativo** · 📖 **Modo leitor** (⌥⌘R) · 🌐 **Traduzir**
- 🔎 **Localizar na página** (⌘F) · 🔍 **Zoom** (⌘ +/−/0) · 🖨️ **Imprimir** (⌘P)
- 🔐 **Permissões** (câmera/mic/localização) · 🕵️ **Janela anônima** isolada (⌘⇧N)
- 🧩 **Extensões do Chrome** — content scripts, botões na toolbar, instalar de pasta ou da Web Store

> **Detalhe técnico:** o `<webview>` do Chromium pinta acima de qualquer overlay HTML
> do renderer. Por isso todos os menus/popovers (⋮, Configurações, Sobre, permissão,
> find, sugestões da omnibox) são **janelas flutuantes** sem moldura — camada do SO,
> estilizadas como parte do app.

## Quickstart

### Browser (janela real)

```bash
npm install            # baixa o runtime do Electron
npm run browser        # abre a janela do Logica Pilot
```

Navegue normal (como no Chrome). Quando quiser, abra o painel **Pilot** (⌘K),
escreva um objetivo e assista a IA navegar — *na sua sessão* (seus logins/cookies).

**Instalar extensão:** clique no 🧩 da toolbar → *Instalar extensão (escolher pasta)*
→ aponte uma extensão desempacotada (com `manifest.json`). Ou abra a Chrome Web Store
pelo mesmo menu. *(Instalar pela loja dentro de um `<webview>` é limitado — a loja
detecta "não-Chrome"; a pasta desempacotada é o caminho garantido.)*

### Headless (pros agentes / scripts)

```bash
node bin/logica-pilot.js run "encontre o horário de funcionamento do MASP" --vision
node bin/logica-pilot.js open https://example.com     # imprime o mapa indexado
```

### Programático

```js
const { LogicaPilot } = require('logica-pilot');

const pilot = await new LogicaPilot({ headless: true }).launch();
const res = await pilot.run('compare o preço do RTX 4090 em 2 lojas e me diga a mais barata');
console.log(res.result);   // resposta final em PT-BR
await pilot.close();
```

## Configuração (env)

| Variável | Default | Para quê |
|---|---|---|
| `LOGICA_PILOT_LLM_URL` | `http://127.0.0.1:8317/v1/messages` | endpoint do cérebro (LogicaProxy) |
| `LOGICA_PILOT_MODEL` | `claude-sonnet-4-6` | modelo |
| `LOGICA_PILOT_BROWSER` / `CHROME_PATH` | auto | binário Chromium (Chrome/Edge/Brave/Chromium) |
| `ANTHROPIC_API_KEY` | — | se for bater direto na Anthropic em vez do proxy |
| `LOGICA_PILOT_DEBUG` | — | logs do Chrome no stderr |
| `LOGICA_PILOT_SMOKE` | — | self-test do caminho Electron+CDP e sai |

## Arquitetura (arquivos)

```
src/
  cdp-pipe.js      transporte CDP sobre pipe (--remote-debugging-pipe), zero-dep
  browser.js       acha o Chromium, sobe via pipe, gerencia páginas/sessões
  perception.js    mapa indexado de elementos (a11y/DOM) + badges de visão
  actions.js       click/type/scroll/press/extract por índice (eventos reais)
  llm.js           cérebro (Messages API via LogicaProxy)
  agent.js         loop autônomo (perceber → decidir → agir → repetir)
  electron-page.js adaptador webContents.debugger → contrato de page
  index.js         API pública (classe LogicaPilot)
bin/logica-pilot.js  CLI
app/                 browser Electron (main, preload, UI)
```

## Integração com o LogicaOS

Exposto como skill `pilot` em `LogicaOS/skills/pilot/`, com o contrato
`{ ok, data | error }` das demais skills. **Substitui** a skill `playwright`.

```js
const pilot = require('./skills/pilot');
await pilot.run('...');           // loop autônomo
await pilot.snapshot(url);        // mapa indexado
await pilot.extractText(url, sel);
```

## Por que não forkar o Chromium?

Forkar Chromium em C++ (como Brave/Edge) custa meses de build infra e um time só
pra manter. Electron entrega o **Chromium real com controle total da IA** hoje,
cross-platform. Se um dia o Pilot virar flagship de mercado, aí avalia CEF/fork.

---

<div align="center">
<sub>Rovemark · Infraestrutura de IA · feito para o Arquiteto.</sub>
</div>
