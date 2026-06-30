# Plano de Migração — <webview> → WebContentsView (Logica Pilot)

> Gerado por workflow (8 agentes, 7 áreas, 92 touchpoints). 612444 tokens.

## Arquitetura-alvo

## Arquitetura-alvo: WebContentsView geridas pelo MAIN

### 1. Registry de views no main (`app/main/view-registry.js` — NOVO)
Substitui a posse renderer-side das `<webview>`. Estrutura central por janela:

```
ViewRegistry (por BrowserWindow):
  tabs: Map<tabId(string), { view: WebContentsView, wc, url, title, loading, favicon, audible, muted, zoomLevel }>
  activeTabId: string|null
  popovers: Map<name, WebContentsView>   // menu, omni, find, perm, panel (os que virarem view)
  layout: { toolbarH, bookmarksBarH, panelOpen }
```

- `tabId` é a NOVA fonte de verdade — string app-level (`t${++seq}`), gerada no main na criação. NUNCA `webContents.id` cru vaza pro renderer.
- Map interno `wcId→tabId` e `tabId→wcId` no registry, usado SÓ pela ponte de extensões e pelo Pilot (que precisam de webContents).
- `runs` (Pilot) e `pendingPermissions` passam a ser chaveados por `tabId` (resolvidos via registry).

### 2. Layout/coordenação de bounds (`app/main/layout.js` — NOVO)
O main é o dono do z-order e dos bounds (o renderer não posiciona mais nada do conteúdo):
- `relayout(win)`: lê `win.getContentSize()`, calcula `pageTop = toolbarH + (bookmarksBarOpen ? barH : 0)`, aplica `view.setBounds({x:0,y:pageTop,w,h:H-pageTop})` SÓ na view ativa; views inativas recebem bounds `{w:0,h:0}` ou são removidas do contentView (preferir remover via `removeChildView` p/ não pintar/consumir GPU, re-adicionar no activate).
- Ordem de empilhamento (contentView.addChildView é append-no-topo): (1) page view ativa → (2) bookmarks-bar overlay se virar view → (3) popovers. Popovers SEMPRE re-adicionados por último para garantir z-order acima da página.
- `win.on('resize')` e mudanças de barra/painel chamam `relayout`.
- Renderer (casca DOM = toolbar+tabstrip) ocupa a faixa `y < pageTop`; a casca é o webContents da própria janela, sempre ABAIXO no z-order das WebContentsView de página? Não — a casca DOM pinta no webContents da janela, que fica ATRÁS das child views. Por isso toolbar/tabstrip ficam numa faixa onde NENHUMA child view é posicionada (page começa em `pageTop`). Popovers ancorados na toolbar são child views posicionadas SOBRE a faixa da toolbar.

### 3. Contrato IPC casca↔main (canais novos, additivos)
Renderer (casca) vira camada fina de UI; comanda o main por `tabId`:

| Direção | Canal | Payload |
|---|---|---|
| R→M (handle) | `tab:create` | `{url, background, incognito}` → retorna `{tabId}` SÍNCRONO |
| R→M | `tab:activate` / `tab:close` | `{tabId}` |
| R→M | `tab:navigate`/`back`/`forward`/`reload`/`hard-reload`/`stop` | `{tabId, url?}` |
| R→M | `tab:zoom` | `{tabId, level}` |
| R→M | `tab:find-open`/`find-close` | `{tabId, query, opts}` |
| R→M | `tab:print`/`devtools-open` | `{tabId}` |
| M→R (send) | `tab:state` | `{tabId, patch:{url,title,favicon,loading,audible,canBack,canForward,zoomLevel}}` |
| M→R | `tab:created`/`tab:removed`/`tab:activated` | `{tabId, ...}` |
| M→R | `tab:home-pilot`/`home-open` | (substitui ipc-message do guest) |

Pilot mantém `pilot:run/stop/onStep/onError`, mas `{guestId}` → `{tabId}`.
A casca guarda em cada tab só `{tabId, url, title, favicon, loading, audible, canBack, canForward}` — espelho do estado do main, atualizado por `tab:state`. `tabs.js` perde `wv`, `makeWebview`, `setAudioMuted`, `getWebContentsId`; ganha `tabId`. `render()` (reconciliação DOM) fica intacto.

### 4. Sessão/partition
- Partition permanece `persist:logica-pilot`. No modelo WCV é setada via `webPreferences.session = session.fromPartition(PARTITION)` na construção de cada `WebContentsView`, e o `wireSession(ses)` é chamado UMA vez no boot do main (eager), ANTES de qualquer view carregar — eliminando a corrida lazy.
- Preload do guest (`webview-preload.js`) vira `webPreferences.preload` da view. O guard por `location.protocol === 'pilot:'` continua válido.
- Incógnito: o main cria a janela com flag e usa `session.fromPartition('logica-pilot-incognito-'+Date.now())` (não-persistente) para TODAS as views daquela janela. Sem hack de partition no renderer.
- `webPreferences` da página: `contextIsolation:true, nodeIntegration:false, sandbox:true` (pode-se endurecer agora que o main controla — antes era `sandbox:false`), `plugins:true` p/ PDF.

### Princípio de coexistência
Uma flag `PILOT_WCV` (env/setting). `off` = caminho `<webview>` atual intacto (`webviewTag:true`, `did-attach-webview`). `on` = caminho WCV (registry + layout). O `createWindow` ramifica; `webview-manager.equip(wc, win)` é compartilhado pelos dois (recebe um `webContents` — agnóstico à fonte). Toda fase entrega com a flag podendo voltar a `off`.

## Veredito do feed de notícias

SIM, o bug do feed some com WebContentsView — e o veredito é confiante porque a causa-raiz é corrida de wiring de sessão, não CSP.

Diagnóstico confirmado no código: `protocol.registerSchemesAsPrivileged` declara pilot:// como `{standard:true, secure:true, supportFetchAPI:true, corsEnabled:true}` (main.js:79-84) e `protocol.handle` é GLOBAL, registrado antes do whenReady. O CSP `connect-src 'self'` da newtab.html está CORRETO (fetch é same-origin pilot://newtab). O ponto frágil: `wireSession(ses)` é chamado LAZY, só quando a primeira <webview> daquela partition anexa (via equip→did-attach-webview). Existe uma janela em que a sessão da partition existe mas ainda não foi totalmente inicializada/wired quando o fetch dispara — resultando em erro de rede/CORS opaco ('Não consegui carregar as notícias agora') em vez do JSON do handler.

Por que WCV resolve de forma determinística: no modelo WCV o main cria a página com `webPreferences.session = session.fromPartition('persist:logica-pilot')` e chamamos `wireSession` EAGER no boot (Fase 3), ANTES de qualquer view carregar conteúdo. Não há mais attach implícito nem ordem dependente do renderer: a view nasce já na sessão certa, com o handler global pilot:// e a sessão wired. O fetch sempre alcança o handler → getNews() responde. O handler e news.js NÃO mudam; o que muda é a GARANTIA de ordem (sessão pronta antes do load), que mata a corrida. Risco: baixo-médio (depende de chamar wireSession eager — trivial).

## Estratégia de popovers

Decisão explícita, popover a popover (spike já provou view-empilhada acima da página via contentView.addChildView):

VIRAM WebContentsView in-window (z-order controlado pelo main, eliminam o hack de esconder a <webview> e o flash):
- Menu ⋮ (appmenu:popup) — simples, ganha em z-order limpo.
- Omnibox suggestions (omni) — pure display; ganha por não precisar mais de janela-OS, MAS exige gestão manual de foco (era focusable:false+showInactive nativo). Médio.
- Permission prompt (perm) — simples (texto+2 botões); trocar 'blur=deny' por botão Deny + timeout existente.
- Find bar (find) — input permanece na casca (address-bar context), a view exibe só contador/botões; found-in-page já vem do main.

SEGUE como BrowserWindow-OS (não migrar — menor risco, sem ganho real):
- Painel Settings/About (panel:open) — modal com frame/sombra/stacking nativo mapeia melhor em janela; é grande e interativo (inputs, dropdowns) e o blur-to-close é confiável como janela. Migrar só traria risco de foco/CSP sem benefício.

Mecanismos a reimplementar ao virar view (não existem em view): (1) click-outside substituindo BrowserWindow.on('blur') — listeners no webContents da página + na casca convergindo no main; (2) Esc encaminhado explicitamente; (3) foco do omnibox — manter foco na address bar via gestão manual (preventDefault no mousedown da view ou devolver foco após clique). Z-order: popover SEMPRE re-adicionado por último no contentView.

## Esforço estimado

Estimativa honesta, 1 dev focado conhecendo o código (multiplicar por incerteza alta na Fase 2):

- Fase 0 (andaime/flag/equip neutro): 2-3 dias. Baixo risco, muita leitura/auditoria.
- Fase 1 (abas main + layout + IPC + casca fina): 5-8 dias. É o coração do refactor (renderer.js + tabs.js + handlers main + listeners de estado + histórico + incógnito + foco). Maior bloco de código novo.
- Fase 2 (Pilot por tabId + ponte extensões): 4-7 dias, com CAUDA LONGA de incerteza pela electron-chrome-extensions 4.1.1 (pode estourar +3-5 dias se hostWebContents quebrar). O motor Pilot em si é ~0,5 dia (só troca o ponto de resolução do webContents — confirmado pelo mapa).
- Fase 3 (popovers/feed): 4-6 dias. Feed é trivial (eager wireSession, ~0,5 dia); o custo é a gestão manual de foco/click-outside dos popovers-view.
- Fase 4 (testes de contrato + smoke + regressão): 4-6 dias, dos quais a suíte de contrato preload↔main é a maior fatia (e é pré-requisito que o ROADMAP já cobrava).

TOTAL realista: ~3,5 a 5,5 semanas (19-30 dias úteis). Caminho crítico = Fase 1 (volume) e Fase 2 (incerteza das extensões). Honestidade do ROADMAP: ele recomendava ADIAR a migração até existir a suíte de testes; este plano respeita isso colocando os testes como gargalo da Fase 4 e do flip, não como afterthought. Se as extensões forem deixadas no caminho <webview> (flag), corta-se ~1 semana e o risco alto, ao custo de extensões não rodarem sob WCV até o upgrade de Electron (P0-1 do ROADMAP).

## Fases

### Fase 1: Fase 0 — Andaime de coexistência (flag + equip compartilhado + registry vazio)

**Meta:** Introduzir a flag PILOT_WCV e a infra-base (view-registry, layout) SEM mudar comportamento default. equip() fica neutro à fonte do webContents.

**Passos:**
- Adicionar flag `PILOT_WCV` (env `PILOT_WCV=1` + setting `wcv`) lida em main.js no boot.
- Criar `app/main/view-registry.js` (Map de tabs por janela, geração de tabId, mapas tabId↔wcId) — exportado mas ainda não usado no caminho default.
- Criar `app/main/layout.js` com `relayout(win)` e constantes de altura (toolbarH=titlebar+toolbar real medido do index.html).
- Refatorar `webview-manager.equip(wc, win)` para ser idempotente e NÃO assumir <webview> (já recebe wc puro — confirmar que nada usa wc.hostWebContents); extrair `wireSession` para poder ser chamado eager.
- No createWindow, manter `webviewTag:true` e `did-attach-webview` SÓ quando flag off; deixar o branch `if (PILOT_WCV) {...}` ainda vazio (TODO).

**Arquivos:** /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/main.js, /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/main/webview-manager.js, /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/main/view-registry.js, /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/main/layout.js

**Mantém funcional:** Flag default off: o browser roda EXATAMENTE como hoje (<webview> + did-attach-webview). Os módulos novos existem mas não são acionados.

**Riscos:** equip() ter alguma suposição <webview>-específica oculta (ex.: leitura de hostWebContents na lib de extensões) — auditar antes.

### Fase 2: Fase 1 — Abas geridas pelo main (tabId→WebContentsView) + layout + navegação/eventos/estado

**Meta:** Com PILOT_WCV=1, abas viram WebContentsView criadas pelo main; casca (tabs.js/renderer.js) vira camada fina por tabId. Navegação, título, favicon, loading, áudio, zoom, find, print, devtools, histórico, bookmarks, incógnito funcionam pelo IPC novo.

**Passos:**
- main: implementar handlers `tab:create/activate/close/navigate/back/forward/reload/hard-reload/stop/zoom/find-open/find-close/print/devtools-open` operando sobre o registry; criar WebContentsView com session da partition + preload + plugins.
- main: anexar listeners no `view.webContents` (did-navigate, did-navigate-in-page, page-title-updated, page-favicon-updated, did-start/stop-loading, media-started/paused-playing, zoom-changed, did-fail-load) → emitir `tab:state` por tabId; gravar histórico DIRETO no main (did-navigate + título numa transação, fim da corrida de título); chamar equip(view.webContents, win) na criação.
- main: `activate` re-posiciona/adiciona a view ativa, remove as outras do contentView; `close` para Pilot se rodando (runs.has(tabId)) e destrói a view; relayout em resize/barra/painel.
- main: substituir o canal `ipc-message`(home:pilot/home:open) do guest — como não há mais ipc-to-host de <webview>, o guest pilot:// usa `ipcRenderer` via preload → main reemite `tab:home-pilot`/`home-open` pra casca.
- renderer/tabs.js: remover `makeWebview`/`wv`/`getWebContentsId`/`setAudioMuted`; tab passa a ter `tabId` + estado espelhado; `create` chama `window.pilot.tabCreate` (await tabId); `activate/close` mandam IPC; `render()` (reconciliação) intacto; mute via `tab:mute` IPC.
- renderer/renderer.js: `active()` lê estado espelhado; `syncNav` usa `canBack/canForward` do `tab:state` (cacheado, não wv.canGoBack); `zoomStep`/`navigateActive`/dispatchMenu (reload/stop/back/forward/print/devtools) viram IPC por tabId; `runPilot`/stop usam tabId; assinar `tab:state/created/removed/activated`.
- renderer/findbar.js: caminho fallback wv.findInPage removido; usa só IPC (find-open/close por tabId); `find:result` já vem do main (trocar guestId→tabId).
- renderer/index.html: `#views` deixa de receber <webview> (vira placeholder/área reservada só p/ reservar a faixa de layout; conteúdo é child view do main).

**Arquivos:** /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/main.js, /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/main/view-registry.js, /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/main/layout.js, /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/main/webview-manager.js, /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/preload.js, /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/renderer/renderer.js, /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/renderer/tabs.js, /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/renderer/findbar.js, /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/renderer/index.html, /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/renderer/webview-preload.js

**Mantém funcional:** Flag off = caminho <webview> intocado (pode shippar). Flag on = browser navega, abas abrem/fecham/ativam, título/favicon/loading/áudio/zoom/find/print/devtools/histórico/bookmarks/incógnito funcionam. Extensões e popovers ainda no modelo antigo NÃO funcionam sob flag on (cobertos nas fases 2/3); por isso valida-se a Fase 1 sem extensões habilitadas.

**Riscos:** Z-order: a casca DOM (toolbar) pinta no webContents da janela, ATRÁS das child views — garantir que nenhuma page view seja posicionada sobre a faixa da toolbar (pageTop correto, inclusive com bookmarks bar).; Latência: syncNav assíncrono pode piscar botões back/fwd — cachear canBack/canForward do tab:state.; Race de criação: garantir tabId retornado SÍNCRONO antes da casca tentar ativar/operar.; did-navigate-in-page + histórico: dedup correto agora no main.; Foco do teclado: child view ativa rouba foco; atalhos da casca (keydown no renderer) podem não disparar quando o foco está na page view — pode exigir before-input-event no webContents da view encaminhando ao main (igual menu nativo hoje cobre accelerators).

### Fase 3: Fase 2 — Pilot CDP no webContents da view + ponte de extensões por tabId

**Meta:** O motor Pilot (agent/perception/actions/electron-page) ataca o webContents da WebContentsView; ponte electron-chrome-extensions registra views por tabId sem polling nem did-attach-webview.

**Passos:**
- main: `pilot:run` resolve `view.webContents` pelo tabId no registry (em vez de webContents.fromId(guestId)); `runs` chaveado por tabId; gate de DevTools usa runs.has(tabId). NENHUMA mudança em electron-page.js/agent.js/perception.js/actions.js (são transport-agnósticos — confirmado pelo mapa pilot-cdp-motor).
- extensions-manager: `createTab` resolve via tabId→view.webContents do registry; remover o protocolo de polling/ext:tabCreated (tabId é síncrono na criação); `selectTab/removeTab` por tabId acionam activate/close no registry; manter o tuple [webContents, BrowserWindow] que a lib espera, montado a partir do registry.
- webview-manager: `addTab(view.webContents, win)` chamado na criação da view (Fase 1 já cria), não mais via did-attach-webview.
- renderer.js: remover `onExtCreateTab` polling, `guestIdOf`, `tabByGuestId(guestId)`, `notifyExtActiveTab(guestId)`; `tabActivated` manda tabId; criação de aba por extensão devolve tabId direto.
- Auditar electron-chrome-extensions@4.1.1 por uso de hostWebContents (mapa extensions alerta) — se houver, adaptar shim no registry; validar injeção do browser-action preload no contexto da view (Electron 33 suporta preload em WebContentsView).

**Arquivos:** /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/main.js, /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/main/extensions-manager.js, /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/main/webview-manager.js, /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/preload.js, /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/renderer/renderer.js, /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/src/electron-page.js

**Mantém funcional:** Flag off intocada. Flag on: agora Pilot roda no webContents da view (CDP attach, perception, actions, screenshot — tudo igual pois falam CDP puro) e extensões Chrome criam/ativam/fecham abas pela ponte tabId. Gate CDP-vs-DevTools preservado.

**Riscos:** electron-chrome-extensions 4.1.1 não tem suporte nativo a WebContentsView; pode ler hostWebContents → quebra de chrome.tabs. ALTO risco; mitigar com shim e testes por extensão real.; browser-action preload pode não injetar/renderizar <browser-action-list> no novo contexto — testar uBlock/1Password.; chrome.windows.create deve abrir nova janela também em modo WCV (consistência).

### Fase 4: Fase 3 — Popovers/feed como views in-window + protocolo eager (mata bug do feed)

**Meta:** Migrar os popovers que se beneficiam (omni, find, perm, menu) para WebContentsView empilhadas pelo main (provado no spike); manter painel Settings/About como BrowserWindow-OS. Feed de notícias passa a carregar de forma determinística.

**Passos:**
- main: `wireSession(ses)` chamado EAGER no boot, e protocolo pilot:// já é global e registrado antes do whenReady — com a view criada já na session certa, o fetch(pilot://newtab/_data/news) sempre alcança o handler. Sem mudança em news.js/newtab.js.
- Popovers como view: refatorar handlers `appmenu:popup`, `omni:open/update/close`, `find:open`, `perm:open` para criar WebContentsView via factory comum `makePopoverView(name, htmlFile)`; posicionar por `setBounds` relativo aos rects vindos da casca; adicionar ao contentView por ÚLTIMO (z-order acima da página).
- Implementar click-outside (substitui blur): listener no webContents da view ativa + na casca → main fecha popover; Esc encaminhado; omnibox: pointer-events e foco gerenciados para não roubar foco da address bar (ou aceitar foco e devolver).
- Permission prompt: trocar semântica 'blur=deny' por botão Deny explícito + timeout (já existe timeout de 30s).
- Find bar: input continua na casca (address-bar context); a view de find exibe só contador/botões; `found-in-page` (já no main) atualiza por tabId.
- Manter Settings/About (`panel:open`) como BrowserWindow-OS (modal, sombra, frame) — menor risco, não há ganho em virar view.
- renderer/overlays.js: ajustar chamadas (rects por tabId/casca), remover dependência de blur.

**Arquivos:** /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/main.js, /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/renderer/overlays.js, /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/renderer/findbar.js, /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/main/webview-manager.js

**Mantém funcional:** Flag off intocada. Flag on: menu ⋮, omnibox, find, permissão renderizam como views ACIMA da página (sem o flash/hack de esconder webview); Settings/About seguem janela-OS. Feed da New Tab carrega de forma confiável.

**Riscos:** Foco do omnibox não-focável é nativo de BrowserWindow; replicar em view exige gestão manual de foco (médio).; Click-outside próprio pode deixar popover preso se mal-amarrado.; z-order com múltiplas views sobrepostas exige re-add disciplinado.

### Fase 5: Fase 4 — Re-teste, regressões e default flip

**Meta:** Cobrir o caminho WCV com testes de contrato/smoke, rodar matriz de regressão completa, e (só então) considerar ligar PILOT_WCV por padrão, mantendo rollback.

**Passos:**
- Smoke headless (LOGICA_PILOT_SMOKE/UITEST) cobrindo: abrir/fechar/ativar abas, navegar, back/fwd, find, zoom, print stub, devtools-gate, incógnito (isolamento de cookies), histórico, bookmarks, feed da New Tab carregando JSON.
- Teste de contrato preload↔main para todos os canais tab:* (o ROADMAP já pedia essa suíte — pré-requisito da migração).
- Regressão manual: vídeo HTML5/fullscreen, PDF inline, áudio/mute por aba, extensões reais (uBlock, 1Password) criando/ativando/fechando abas, Pilot run completo + tentar DevTools durante run (deve barrar), multi-janela, atalhos de teclado com foco na page view.
- Comparar paridade com o caminho <webview> (flag off) lado a lado.
- Decidir flip do default só com tudo verde; manter flag e código <webview> por ao menos 1 release de convivência.

**Arquivos:** /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/main.js, /Users/andreambrosio/logicaos/projects/rovemark/Logica Pilot/app/preload.js

**Mantém funcional:** Ambos os caminhos coexistem; default permanece off até a matriz passar. Flip é uma linha (default da flag), reversível.

**Riscos:** Sem testes prévios a migração é cega (ROADMAP destaca isso como a dívida real) — a suíte de contrato é gargalo de cronograma.; Regressões sutis de foco/teclado/áudio só aparecem em uso manual.

## Risk register

- **[high]** electron-chrome-extensions@4.1.1 não suporta WebContentsView nativamente e pode ler hostWebContents (ausente em view.webContents), quebrando chrome.tabs.* das extensões. → _Auditar o source da lib por hostWebContents/suposições <webview> ANTES da Fase 2; montar shim no registry (tuple [wc, win] + propriedades esperadas); testar com extensões reais (uBlock, 1Password). Pin 4.1.1 (4.2+ exige Electron 35). Se inviável, manter extensões só no caminho <webview> até upgrade do Electron._
- **[high]** Z-order/foco: casca DOM pinta atrás das child views; page view pode cobrir toolbar e popovers podem ficar sob a página ou roubar foco do omnibox. → _Main é dono único do layout: pageTop reservado para toolbar+bookmarks bar; popovers re-adicionados por último; gestão manual de foco no omnibox (preventDefault/devolução). Validar no spike (já provado p/ 1 popover) e em regressão manual._
- **[medium]** Atalhos de teclado da casca (keydown no renderer) podem não disparar quando o foco está na WebContentsView ativa. → _Menu nativo já cobre accelerators globalmente (independe de foco). Para atalhos não-menu, usar before-input-event no webContents da view encaminhando ao main→casca. Testar Esc/Ctrl+Tab/Cmd+1..9 com foco na página._
- **[high]** Migração sem testes prévios é cega (ROADMAP marca a ausência de testes como a dívida real que tornaria o refactor seguro). → _Fase 4 e a suíte de contrato preload↔main são pré-requisito do flip; manter flag PILOT_WCV e o caminho <webview> por ≥1 release de convivência. Comparação lado-a-lado off vs on._
- **[medium]** Race na criação de aba (tabId precisa estar válido síncrono antes da casca ativar/operar). → _tabId é app-level gerado no main na construção da view e retornado por ipcMain.handle SÍNCRONO; casca só opera após receber tabId. Elimina o polling de getWebContentsId (200×25ms) que era a fonte de fragilidade._
- **[medium]** Vídeo HTML5 fullscreen/PiP, PDF inline e áudio por aba comportam-se diferente em WebContentsView vs <webview>. → _Regressão manual dedicada na Fase 4 (YouTube fullscreen, PDF, mute por aba). plugins:true mantido p/ PDF; tratar enter-html-full-screen no main ajustando bounds da view._
- **[low]** Popover como view perde blur-to-close; click-outside mal amarrado pode deixar popover preso. → _Click-outside convergindo casca+webContents no main, Esc explícito, timeout no perm. Settings/About ficam como janela-OS (sem esse risco)._
- **[medium]** Isolamento de incógnito: se a session não-persistente vazar cookies para a normal. → _Main cria todas as views da janela anônima com session.fromPartition não-persistente única; teste de regressão verificando ausência de cookies cruzados._

## Rollback

Rollback em três camadas, garantindo coexistência e volta-atrás a qualquer fase:

1) Flag de runtime PILOT_WCV (env + setting): default OFF durante toda a migração. Off = caminho <webview> histórico 100% intacto (webviewTag:true, did-attach-webview, makeWebview no renderer). On = caminho WCV (registry+layout). createWindow ramifica no boot; webview-manager.equip é compartilhado (recebe webContents, agnóstico à fonte). Reverter = setar flag off e reiniciar — sem rebuild.

2) Branch dedicada (ex.: feat/wcv-migration) com a flag; merge na main só quando a Fase 4 estiver verde, mantendo o código <webview> presente. O flip do default é uma única linha (default da flag), reversível por release.

3) Convivência por ≥1 release: o código <webview> NÃO é deletado no flip; fica como fallback selecionável. Só remover depois de 1 release estável com WCV default. Cada fase entrega com o browser funcional sob flag off (shippável) e testável sob flag on, então nenhum ponto da migração bloqueia um release.

Gatilho de reversão: qualquer regressão alto-severidade (extensões quebradas, perda de foco/teclado, vazamento de incógnito) → flag off imediato em produção enquanto se corrige na branch.

## Perguntas abertas

- A versão electron-chrome-extensions@4.1.1 lê hostWebContents ou outras propriedades exclusivas de <webview> internamente? Precisa de auditoria do source ANTES da Fase 2 — define se o risco alto se materializa ou se basta um shim no registry.
- O upgrade de Electron 33→41 (P0-1 do ROADMAP, que destrava electron-chrome-extensions 4.2+ com suporte melhor a WebContentsView) deve vir ANTES ou DEPOIS desta migração? Fazer antes reduz o risco das extensões mas é épico próprio; fazer depois mantém o pin frágil.
- Atalhos de teclado não-menu com foco na page view: before-input-event encaminhado é aceitável em latência/UX, ou prefere-se promover todos os atalhos a accelerators no menu nativo (que já funcionam independente de foco)?
- HTML5 fullscreen/PiP de vídeo dentro de WebContentsView: o main precisará tratar enter/leave-html-full-screen ajustando bounds (a view ativa cobre a janela toda em fullscreen) — confirmar comportamento desejado (fullscreen real da janela vs view ocupando tudo).
- Vale migrar o omnibox suggestions para view (exige gestão manual de foco não-trivial) ou mantê-lo como BrowserWindow-OS focusable:false como Settings/About, reduzindo risco? Decisão de custo-benefício a confirmar com o Arquiteto.
- O flip do default da flag para ON deve ocorrer dentro deste ciclo ou ficar para release seguinte após convivência? Afeta cronograma de testes da Fase 4.
