'use strict';

/**
 * view-registry.js — Core of the <webview> → WebContentsView migration.
 *
 * The MAIN process now owns the pages: each tab is a `WebContentsView`
 * (real browser engine layer) created, positioned, shown/hidden, and destroyed here.
 * The shell (renderer) stops creating `<webview>` and becomes just a remote control:
 * sends commands (create/switch/navigate) via IPC and receives state events
 * (url/title/favicon/loading) back.
 *
 * Advantages over `<webview>`:
 *  - no legacy/fragile `<webview>` layer (race conditions, overlay glitches);
 *  - the page is born in the RIGHT SESSION (partition) → pilot:// protocol and feed
 *    fetch are deterministic (no wiring race);
 *  - z-order controlled by main → popovers become in-window views above the page;
 *  - webContents is direct (no guestId via DOM) → cleaner Pilot/CDP and extensions.
 *
 * This module is LAYOUT-AGNOSTIC: the caller injects `getContentBounds()` (the area
 * where the page should appear, below the toolbar/tabstrip and beside the Pilot panel)
 * and `emit(channel, payload)` (how to send events to the shell of that window).
 */

const { WebContentsView, session } = require('electron');

const PARTITION = 'persist:logica-pilot';

/**
 * Creates a registry per WINDOW of the shell. Maintains tab state for that window.
 * @param {object} opts
 * @param {import('electron').BaseWindow} opts.window  host window (has .contentView)
 * @param {() => {x:number,y:number,width:number,height:number}} opts.getContentBounds
 * @param {(channel:string, payload:any) => void} opts.emit  sends event to the shell
 * @param {string} [opts.preload]  preload path for pages (page→shell channel)
 * @param {boolean} [opts.incognito]  uses ephemeral session (no persistence)
 */
function createRegistry(opts) {
  const win = opts.window;
  const getContentBounds = opts.getContentBounds;
  const emit = opts.emit || (() => {});
  const preload = opts.preload || null;
  const partition = opts.incognito ? '' : PARTITION; // '' = default in-memory session? no — we only use fromPartition for persist

  /** @type {Map<string, {view: import('electron').WebContentsView, wc: import('electron').WebContents, url: string}>} */
  const tabs = new Map();
  let activeId = null;
  let destroyed = false;

  function ses() {
    // persistent partition shared by all normal tabs.
    return opts.incognito
      ? session.fromPartition('logica-pilot-incognito-' + Date.now())
      : session.fromPartition(PARTITION);
  }

  function navState(wc) {
    try {
      return { canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() };
    } catch {
      // fallback for older Electron
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

  /** Creates a tab and its WebContentsView (not active by default — call activate). */
  function createTab(tabId, { url } = {}) {
    if (destroyed || tabs.has(tabId)) return tabId;
    const webPreferences = {
      session: ses(),
      sandbox: false,
      contextIsolation: true,
      // PAGE preload (page→shell channel via IPC). Stored by protocol
      // within the preload itself, same as today's webview-preload.
      ...(preload ? { preload } : {}),
    };
    const view = new WebContentsView({ webPreferences });
    const wc = view.webContents;
    tabs.set(tabId, { view, wc, url: url || '' });
    win.contentView.addChildView(view);
    wireEvents(tabId, wc);
    if (url) wc.loadURL(url);
    // born hidden; only the active one is visible
    try { view.setVisible(false); } catch {}
    return tabId;
  }

  /** Shows the given tab (hides others) and brings it to the top of the view stack. */
  function activateTab(tabId) {
    if (destroyed || !tabs.has(tabId)) return;
    activeId = tabId;
    for (const [id, t] of tabs) {
      try { t.view.setVisible(id === tabId); } catch {}
    }
    // re-adding the active tab guarantees z-order at the top (above other tabs).
    // Popovers (added later) stay above this — whoever manages popovers
    // re-stacks above the switch.
    try {
      win.contentView.removeChildView(tabs.get(tabId).view);
      win.contentView.addChildView(tabs.get(tabId).view);
    } catch {}
    layout();
    const wc = tabs.get(tabId).wc;
    emit('tab:activated', { tabId, url: tabs.get(tabId).url, ...navState(wc) });
  }

  /** Closes and destroys the tab. */
  function closeTab(tabId) {
    const t = tabs.get(tabId);
    if (!t) return;
    try { win.contentView.removeChildView(t.view); } catch {}
    try { t.wc.close(); } catch {}
    try { if (!t.wc.isDestroyed()) t.wc.destroy(); } catch {}
    tabs.delete(tabId);
    if (activeId === tabId) activeId = null;
  }

  /** Positions the active view in the content area (called on boot, resize, panel toggle). */
  function layout() {
    if (destroyed || !activeId) return;
    const t = tabs.get(activeId);
    if (!t) return;
    const b = getContentBounds() || { x: 0, y: 0, width: 800, height: 600 };
    try { t.view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }); } catch {}
  }

  // ── navigation commands (from shell via IPC) ──────────────────────
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

  // ── accessors ────────────────────────────────────────────────────────────
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
