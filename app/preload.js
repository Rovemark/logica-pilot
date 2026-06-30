'use strict';

/**
 * preload.js — Ponte segura (contextIsolation) entre a UI e o processo principal.
 * Expõe só o necessário em window.pilot. Identificadores em inglês; comentários PT-BR.
 */

const { contextBridge, ipcRenderer } = require('electron');
// preload roda em Node (sandbox:false) → path disponível p/ montar o file:// do
// preload das <webview> (canal home → casca).
const path = require('path');

// ── Extensões do Chrome: API do <browser-action-list> ──────────────────────────
// A lib (electron-chrome-extensions) injeta `window.browserAction` + define os
// custom elements <browser-action> / <browser-action-list>. Roda via
// webFrame.executeJavaScript (main world), o que NÃO viola a CSP da página
// (script-src 'self'), pois não é um <script> da página. Best-effort: se faltar a
// lib, a toolbar simplesmente não mostra os botões de extensão.
try {
  const { injectBrowserAction } = require('electron-chrome-extensions/dist/browser-action');
  injectBrowserAction();
} catch (e) {
  // sem extensões — segue a vida (não pode derrubar o renderer da casca)
}

contextBridge.exposeInMainWorld('pilot', {
  // ── Motor Pilot (INTACTO) ───────────────────────────────────────────────
  run: (payload) => ipcRenderer.invoke('pilot:run', payload),
  stop: (payload) => ipcRenderer.invoke('pilot:stop', payload),

  // ── Preload das <webview> (canal home → casca) ──────────────────────────
  // file:// do preload GUARDADO por protocolo (só páginas pilot:// recebem a API).
  // O renderer seta este preload em TODAS as <webview>; a guarda interna garante
  // que sites normais NUNCA recebam window.lpHome.
  webviewPreload: 'file://' + path.join(__dirname, 'renderer', 'webview-preload.js'),
  winControl: (action) => ipcRenderer.invoke('win:control', action),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),

  onStep: (cb) => ipcRenderer.on('pilot:step', (_e, d) => cb(d)),
  onDone: (cb) => ipcRenderer.on('pilot:done', (_e, d) => cb(d)),
  onError: (cb) => ipcRenderer.on('pilot:error', (_e, d) => cb(d)),

  // ── Tema ────────────────────────────────────────────────────────────────
  getTheme: () => ipcRenderer.invoke('theme:get'),
  // pass-through: o renderer manda o objeto-payload da spec ({ mode }); aqui só repassamos.
  setTheme: (payload) => ipcRenderer.invoke('theme:set', payload),
  onNativeThemeUpdated: (cb) => ipcRenderer.on('theme:native-updated', (_e, d) => cb(d)),

  // ── Application Menu nativo → ação no renderer ──────────────────────────
  onMenuAction: (cb) => ipcRenderer.on('menu:action', (_e, name) => cb(name)),
  // menu ⋮ como popup NATIVO (sempre acima do <webview>)
  showAppMenu: (payload) => ipcRenderer.invoke('appmenu:popup', payload),
  // painel Configurações/Sobre como janela flutuante NATIVA (acima do <webview>)
  openPanel: (payload) => ipcRenderer.invoke('panel:open', payload),
  // prompt de permissão como janela flutuante NATIVA (acima do <webview>)
  openPermPrompt: (payload) => ipcRenderer.invoke('perm:open', payload),
  // barra de localizar na página como janela flutuante NATIVA (acima do <webview>)
  findOpen: (payload) => ipcRenderer.invoke('find:open', payload),
  findClose: () => ipcRenderer.send('find:close'),
  onFindClosed: (cb) => ipcRenderer.on('find:closed', () => cb()),

  // ── Sugestões da omnibox como janela flutuante NÃO-FOCÁVEL (acima do <webview>) ─
  // A barra de endereço mantém o foco (showInactive no main) e trata o teclado;
  // a flutuante só exibe a lista e manda o índice no clique.
  omniOpen: (payload) => ipcRenderer.invoke('omni:open', payload),
  omniUpdate: (payload) => ipcRenderer.invoke('omni:update', payload),
  omniClose: () => ipcRenderer.send('omni:close'),
  onOmniChosen: (cb) => ipcRenderer.on('omni:chosen', (_e, index) => cb(index)),

  // ── window.open / target=_blank → nova aba ──────────────────────────────
  onTabOpen: (cb) => ipcRenderer.on('tab:open', (_e, d) => cb(d)),

  // ── Extensões do Chrome ─────────────────────────────────────────────────
  // O main pede ao renderer criar/ativar/fechar abas (a lib chama chrome.tabs.*).
  onExtCreateTab: (cb) => ipcRenderer.on('ext:createTab', (_e, d) => cb(d)),
  onExtSelectTab: (cb) => ipcRenderer.on('ext:selectTab', (_e, d) => cb(d)),
  onExtRemoveTab: (cb) => ipcRenderer.on('ext:removeTab', (_e, d) => cb(d)),
  // renderer reporta de volta o guestId da aba criada p/ a extensão
  extTabCreated: (payload) => ipcRenderer.send('ext:tabCreated', payload),
  // renderer avisa o main quando a aba ativa muda (→ extensions.selectTab)
  tabActivated: (payload) => ipcRenderer.send('tabs:activated', payload),
  // abre a Chrome Web Store / gerência de extensões
  openExtensions: (payload) => ipcRenderer.invoke('ext:open', payload || {}),
  // instala extensão desempacotada de uma pasta (seletor) — sempre funciona
  extInstallUnpacked: () => ipcRenderer.invoke('ext:install-unpacked'),
  // instala da Chrome Web Store pelo ID (bypassa o bloqueio "não é Chrome")
  extInstallById: (payload) => ipcRenderer.invoke('ext:install-id', payload),

  // ── Histórico ────────────────────────────────────────────────────────────
  // pass-through: o renderer manda o objeto-payload da spec; o main desestrutura.
  historyAdd: (entry) => ipcRenderer.send('history:add', entry),
  historyUpdateTitle: (payload) => ipcRenderer.send('history:updateTitle', payload),
  historyQuery: (payload) => ipcRenderer.invoke('history:query', payload),
  historyTopSites: (payload) => ipcRenderer.invoke('history:topSites', payload),
  historyRecent: (payload) => ipcRenderer.invoke('history:recent', payload),
  historyClear: (payload) => ipcRenderer.invoke('history:clear', payload),

  // ── Favoritos (bookmarks) ───────────────────────────────────────────────
  // pass-through: o renderer manda o objeto-payload; o main desestrutura. NÃO re-embrulhar.
  bookmarksList: () => ipcRenderer.invoke('bookmarks:list'),
  bookmarksAdd: (payload) => ipcRenderer.invoke('bookmarks:add', payload),
  bookmarksRemove: (payload) => ipcRenderer.invoke('bookmarks:remove', payload),
  bookmarksToggle: (payload) => ipcRenderer.invoke('bookmarks:toggle', payload),
  bookmarksIsBookmarked: (payload) => ipcRenderer.invoke('bookmarks:isBookmarked', payload),
  bookmarksUpdate: (payload) => ipcRenderer.invoke('bookmarks:update', payload),
  // evento de mudança (sincroniza barra/estrela entre janelas)
  onBookmarksChanged: (cb) => ipcRenderer.on('bookmarks:changed', (_e, d) => cb(d)),

  // ── Downloads ────────────────────────────────────────────────────────────
  downloadsList: () => ipcRenderer.invoke('downloads:list'),
  downloadsAction: (payload) => ipcRenderer.invoke('downloads:action', payload),
  onDownloadEvent: (cb) => ipcRenderer.on('downloads:event', (_e, d) => cb(d)),

  // ── Permissões ───────────────────────────────────────────────────────────
  onPermissionRequest: (cb) => ipcRenderer.on('permission:request', (_e, d) => cb(d)),
  permissionRespond: (payload) =>
    ipcRenderer.invoke('permission:respond', payload),

  // ── Settings / About / janela / dados / busca / print / devtools ────────
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  onSettingsChanged: (cb) => ipcRenderer.on('settings:changed', (_e, d) => cb(d)),
  appInfo: () => ipcRenderer.invoke('app:info'),
  newWindow: (opts) => ipcRenderer.invoke('win:new', opts || {}),
  clearData: (opts) => ipcRenderer.invoke('data:clear', opts || {}),
  // pass-through: o renderer manda o objeto-payload da spec ({ guestId }); aqui só repassamos.
  print: (payload) => ipcRenderer.invoke('print:start', payload),
  openDevTools: (payload) => ipcRenderer.invoke('devtools:open', payload),
  getEngines: () => ipcRenderer.invoke('search:getEngines'),

  // ── Find-in-page via IPC (reserva; barra padrão usa a API do <webview>) ─
  findStart: (guestId, text, options) =>
    ipcRenderer.invoke('find:start', { guestId, text, options }),
  findStop: (guestId, action) => ipcRenderer.invoke('find:stop', { guestId, action }),
  onFindResult: (cb) => ipcRenderer.on('find:result', (_e, d) => cb(d)),

  // ── Prova de Chromium (sem IPC, direto do process.versions do preload) ──
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    v8: process.versions.v8,
    node: process.versions.node,
  },

  platform: process.platform,

  // ── Fase 1: páginas como WebContentsView geridas pelo main (flag LOGICA_PILOT_WCV) ─
  // A casca vira controle remoto: manda comandos por tabId e recebe eventos de estado.
  // Inerte com a flag OFF (view.enabled() → {enabled:false} → casca usa <webview>).
  view: {
    enabled: () => ipcRenderer.invoke('view:enabled'),
    create: (payload) => ipcRenderer.invoke('view:create', payload),
    activate: (payload) => ipcRenderer.invoke('view:activate', payload),
    close: (payload) => ipcRenderer.invoke('view:close', payload),
    navigate: (payload) => ipcRenderer.invoke('view:navigate', payload),
    back: (payload) => ipcRenderer.invoke('view:back', payload),
    forward: (payload) => ipcRenderer.invoke('view:forward', payload),
    reload: (payload) => ipcRenderer.invoke('view:reload', payload),
    stop: (payload) => ipcRenderer.invoke('view:stop', payload),
    layout: (bounds) => ipcRenderer.send('view:layout', bounds),
    onState: (cb) => ipcRenderer.on('tab:state', (_e, d) => cb(d)),
    onNavigated: (cb) => ipcRenderer.on('tab:navigated', (_e, d) => cb(d)),
    onTitle: (cb) => ipcRenderer.on('tab:title', (_e, d) => cb(d)),
    onFavicon: (cb) => ipcRenderer.on('tab:favicon', (_e, d) => cb(d)),
    onFail: (cb) => ipcRenderer.on('tab:fail', (_e, d) => cb(d)),
    onActivated: (cb) => ipcRenderer.on('tab:activated', (_e, d) => cb(d)),
    onAudio: (cb) => ipcRenderer.on('tab:audio', (_e, d) => cb(d)),
  },
});
