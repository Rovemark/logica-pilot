'use strict';

/**
 * view-registry.js — Núcleo da migração <webview> → WebContentsView.
 *
 * O processo PRINCIPAL passa a ser dono das páginas: cada aba é uma
 * `WebContentsView` (camada Chromium real) criada, posicionada, mostrada/escondida
 * e destruída aqui. A casca (renderer) deixa de criar `<webview>` e vira só um
 * controle remoto: manda comandos (criar/trocar/navegar) por IPC e recebe eventos
 * de estado (url/título/favicon/loading) de volta.
 *
 * Vantagens sobre `<webview>`:
 *  - sem a camada legada/frágil do `<webview>` (corridas de attach, cobertura de overlay);
 *  - a página nasce já na SESSÃO certa (partition) → o protocolo pilot:// e o fetch
 *    do feed são determinísticos (sem corrida de wiring);
 *  - z-order controlado pelo main → popovers viram views in-window por cima da página;
 *  - o webContents é direto (sem guestId via DOM) → Pilot/CDP e extensões mais limpos.
 *
 * Este módulo é AGNÓSTICO de layout: quem chama injeta `getContentBounds()` (a área
 * onde a página deve aparecer, abaixo da toolbar/tabstrip e ao lado do painel Pilot)
 * e `emit(channel, payload)` (como mandar eventos pra casca daquela janela).
 */

const { WebContentsView, session } = require('electron');

const PARTITION = 'persist:logica-pilot';

/**
 * Cria um registry por JANELA da casca. Mantém o estado das abas daquela janela.
 * @param {object} opts
 * @param {import('electron').BaseWindow} opts.window  janela host (tem .contentView)
 * @param {() => {x:number,y:number,width:number,height:number}} opts.getContentBounds
 * @param {(channel:string, payload:any) => void} opts.emit  manda evento p/ a casca
 * @param {string} [opts.preload]  caminho do preload das páginas (canal página→casca)
 * @param {boolean} [opts.incognito]  usa sessão efêmera (sem persistir)
 */
function createRegistry(opts) {
  const win = opts.window;
  const getContentBounds = opts.getContentBounds;
  const emit = opts.emit || (() => {});
  const preload = opts.preload || null;
  const partition = opts.incognito ? '' : PARTITION; // '' = sessão default em memória? não — usamos fromPartition só p/ persist

  /** @type {Map<string, {view: import('electron').WebContentsView, wc: import('electron').WebContents, url: string}>} */
  const tabs = new Map();
  let activeId = null;
  let destroyed = false;

  function ses() {
    // partition persistente compartilhada por todas as abas normais.
    return opts.incognito
      ? session.fromPartition('logica-pilot-incognito-' + Date.now())
      : session.fromPartition(PARTITION);
  }

  function navState(wc) {
    try {
      return { canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() };
    } catch {
      // fallback p/ Electron mais antigo
      try { return { canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward() }; } catch { return { canGoBack: false, canGoForward: false }; }
    }
  }

  function wireEvents(tabId, wc) {
    wc.on('did-start-loading', () => emit('tab:state', { tabId, loading: true }));
    wc.on('did-stop-loading', () => emit('tab:state', { tabId, loading: false, ...navState(wc) }));
    wc.on('did-navigate', (_e, url) => {
      const t = tabs.get(tabId); if (t) t.url = url;
      emit('tab:navigated', { tabId, url, inPage: false, ...navState(wc) });
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      const t = tabs.get(tabId); if (t) t.url = url;
      emit('tab:navigated', { tabId, url, inPage: true, ...navState(wc) });
    });
    wc.on('page-title-updated', (_e, title) => emit('tab:title', { tabId, title }));
    wc.on('page-favicon-updated', (_e, favicons) => emit('tab:favicon', { tabId, favicon: (favicons && favicons[0]) || null }));
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame) emit('tab:fail', { tabId, code, desc, url });
    });
    wc.on('media-started-playing', () => emit('tab:audio', { tabId, audible: true }));
    wc.on('media-paused', () => emit('tab:audio', { tabId, audible: false }));
  }

  /** Cria uma aba e sua WebContentsView (não ativa por padrão — chame activate). */
  function createTab(tabId, { url } = {}) {
    if (destroyed || tabs.has(tabId)) return tabId;
    const webPreferences = {
      session: ses(),
      sandbox: false,
      contextIsolation: true,
      // preload da PÁGINA (canal página→casca via IPC). Guardado por protocolo
      // dentro do próprio preload, igual ao webview-preload de hoje.
      ...(preload ? { preload } : {}),
    };
    const view = new WebContentsView({ webPreferences });
    const wc = view.webContents;
    tabs.set(tabId, { view, wc, url: url || '' });
    win.contentView.addChildView(view);
    wireEvents(tabId, wc);
    if (url) wc.loadURL(url);
    // nasce escondida; só a ativa fica visível
    try { view.setVisible(false); } catch {}
    return tabId;
  }

  /** Mostra a aba dada (esconde as outras) e a traz pro topo da pilha de views. */
  function activateTab(tabId) {
    if (destroyed || !tabs.has(tabId)) return;
    activeId = tabId;
    for (const [id, t] of tabs) {
      try { t.view.setVisible(id === tabId); } catch {}
    }
    // re-adicionar a ativa garante z-order no topo (acima das outras abas).
    // Popovers (adicionados depois) continuam acima desta — quem gerencia popover
    // re-empilha por cima após o switch.
    try {
      win.contentView.removeChildView(tabs.get(tabId).view);
      win.contentView.addChildView(tabs.get(tabId).view);
    } catch {}
    layout();
    const wc = tabs.get(tabId).wc;
    emit('tab:activated', { tabId, url: tabs.get(tabId).url, ...navState(wc) });
  }

  /** Fecha e destrói a aba. */
  function closeTab(tabId) {
    const t = tabs.get(tabId);
    if (!t) return;
    try { win.contentView.removeChildView(t.view); } catch {}
    try { t.wc.close(); } catch {}
    try { if (!t.wc.isDestroyed()) t.wc.destroy(); } catch {}
    tabs.delete(tabId);
    if (activeId === tabId) activeId = null;
  }

  /** Posiciona a view ativa na área de conteúdo (chamado no boot, resize, toggle do painel). */
  function layout() {
    if (destroyed || !activeId) return;
    const t = tabs.get(activeId);
    if (!t) return;
    const b = getContentBounds() || { x: 0, y: 0, width: 800, height: 600 };
    try { t.view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }); } catch {}
  }

  // ── comandos de navegação (vindos da casca por IPC) ──────────────────────
  function withWc(tabId, fn) {
    const t = tabs.get(tabId || activeId);
    if (t && !t.wc.isDestroyed()) try { fn(t.wc); } catch {}
  }
  const navigate = (tabId, url) => withWc(tabId, (wc) => wc.loadURL(url));
  const goBack = (tabId) => withWc(tabId, (wc) => { const h = wc.navigationHistory; (h && h.canGoBack() && h.goBack()) || (wc.canGoBack && wc.canGoBack() && wc.goBack()); });
  const goForward = (tabId) => withWc(tabId, (wc) => { const h = wc.navigationHistory; (h && h.canGoForward() && h.goForward()) || (wc.canGoForward && wc.canGoForward() && wc.goForward()); });
  const reload = (tabId) => withWc(tabId, (wc) => wc.reload());
  const reloadHard = (tabId) => withWc(tabId, (wc) => wc.reloadIgnoringCache());
  const stop = (tabId) => withWc(tabId, (wc) => wc.stop());

  // ── acessores ────────────────────────────────────────────────────────────
  const has = (tabId) => tabs.has(tabId);
  const getActiveId = () => activeId;
  const getWebContents = (tabId) => { const t = tabs.get(tabId || activeId); return t ? t.wc : null; };
  const getURL = (tabId) => { const t = tabs.get(tabId || activeId); return t ? (t.wc.getURL() || t.url) : ''; };
  const count = () => tabs.size;
  const ids = () => [...tabs.keys()];

  function destroy() {
    destroyed = true;
    for (const id of [...tabs.keys()]) closeTab(id);
  }

  return {
    createTab, activateTab, closeTab, layout,
    navigate, goBack, goForward, reload, reloadHard, stop,
    has, getActiveId, getWebContents, getURL, count, ids, destroy,
    PARTITION,
  };
}

module.exports = { createRegistry, PARTITION };
