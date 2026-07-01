'use strict';

/**
 * preload.js — Secure bridge (contextIsolation) between the UI and the main process.
 * Exposes only what is necessary in window.pilot. Identifiers in English; comments now translated.
 */

const { contextBridge, ipcRenderer } = require('electron');
// preload runs in Node (sandbox:false) → path available to mount the file:// of the
// preload for <webview> (home channel → shell).
const path = require('path');

// ── Chrome Extensions: API for <browser-action-list> ──────────────────────────
// The lib (electron-chrome-extensions) injects `window.browserAction` + defines the
// custom elements <browser-action> / <browser-action-list>. Runs via
// webFrame.executeJavaScript (main world), which does NOT violate the page's CSP
// (script-src 'self'), as it is not a <script> from the page. Best-effort: if the lib
// is missing, the toolbar simply does not show the extension buttons.
try {
  const { injectBrowserAction } = require('electron-chrome-extensions/dist/browser-action');
  injectBrowserAction();
} catch (e) {
  // no extensions — carry on (cannot crash the shell's renderer)
}

contextBridge.exposeInMainWorld('pilot', {
  // ── Pilot Engine (INTACT) ───────────────────────────────────────────────
  run: (payload) => ipcRenderer.invoke('pilot:run', payload),
  stop: (payload) => ipcRenderer.invoke('pilot:stop', payload),

  // ── Preload for <webview> (home channel → shell) ──────────────────────────
  // file:// of preload GUARDED by protocol (only pilot:// pages receive the API).
  // The renderer sets this preload on ALL <webview>; the internal guard ensures
  // that normal websites NEVER receive window.lpHome.
  webviewPreload: 'file://' + path.join(__dirname, 'renderer', 'webview-preload.js'),
  winControl: (action) => ipcRenderer.invoke('win:control', action),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),

  onStep: (cb) => ipcRenderer.on('pilot:step', (_e, d) => cb(d)),
  onDone: (cb) => ipcRenderer.on('pilot:done', (_e, d) => cb(d)),
  onError: (cb) => ipcRenderer.on('pilot:error', (_e, d) => cb(d)),

  // ── Theme ────────────────────────────────────────────────────────────────
  getTheme: () => ipcRenderer.invoke('theme:get'),
  // pass-through: the renderer sends the payload object from the spec ({ mode }); we just forward it.
  setTheme: (payload) => ipcRenderer.invoke('theme:set', payload),
  onNativeThemeUpdated: (cb) => ipcRenderer.on('theme:native-updated', (_e, d) => cb(d)),

  // ── Native Application Menu → action in renderer ──────────────────────────
  onMenuAction: (cb) => ipcRenderer.on('menu:action', (_e, name) => cb(name)),
  // menu ⋮ as a native popup (always above the <webview>)
  showAppMenu: (payload) => ipcRenderer.invoke('appmenu:popup', payload),
  // Settings/About panel as a native floating window (above the <webview>)
  openPanel: (payload) => ipcRenderer.invoke('panel:open', payload),
  // permission prompt as a native floating window (above the <webview>)
  openPermPrompt: (payload) => ipcRenderer.invoke('perm:open', payload),
  // find-in-page bar as a native floating window (above the <webview>)
  findOpen: (payload) => ipcRenderer.invoke('find:open', payload),
  findClose: () => ipcRenderer.send('find:close'),
  onFindClosed: (cb) => ipcRenderer.on('find:closed', () => cb()),

  // ── Omnibox suggestions as a non-focusable floating window (above the <webview>) ─
  // The address bar retains focus (showInactive in main) and handles keyboard input;
  // the floating window only displays the list and sends the index on click.
  omniOpen: (payload) => ipcRenderer.invoke('omni:open', payload),
  omniUpdate: (payload) => ipcRenderer.invoke('omni:update', payload),
  omniClose: () => ipcRenderer.send('omni:close'),
  onOmniChosen: (cb) => ipcRenderer.on('omni:chosen', (_e, index) => cb(index)),

  // ── window.open / target=_blank → new tab ──────────────────────────────
  onTabOpen: (cb) => ipcRenderer.on('tab:open', (_e, d) => cb(d)),

  // ── Chrome Extensions ─────────────────────────────────────────────────────
  // The main process asks the renderer to create/activate/close tabs (the lib calls chrome.tabs.*).
  onExtCreateTab: (cb) => ipcRenderer.on('ext:createTab', (_e, d) => cb(d)),
  onExtSelectTab: (cb) => ipcRenderer.on('ext:selectTab', (_e, d) => cb(d)),
  onExtRemoveTab: (cb) => ipcRenderer.on('ext:removeTab', (_e, d) => cb(d)),
  // renderer reports back the guestId of the created tab to the extension
  extTabCreated: (payload) => ipcRenderer.send('ext:tabCreated', payload),
  // renderer notifies main when the active tab changes (→ extensions.selectTab)
  tabActivated: (payload) => ipcRenderer.send('tabs:activated', payload),
  // opens the Chrome Web Store / extensions management
  openExtensions: (payload) => ipcRenderer.invoke('ext:open', payload || {}),
  // installs an unpacked extension from a folder (picker) — always works
  extInstallUnpacked: () => ipcRenderer.invoke('ext:install-unpacked'),
  // installs from the Chrome Web Store by ID (bypasses the "not Chrome" block)
  extInstallById: (payload) => ipcRenderer.invoke('ext:install-id', payload),

  // ── History ────────────────────────────────────────────────────────────
  // pass-through: the renderer sends the payload object from the spec; main destructures it.
  historyAdd: (entry) => ipcRenderer.send('history:add', entry),
  historyUpdateTitle: (payload) => ipcRenderer.send('history:updateTitle', payload),
  historyQuery: (payload) => ipcRenderer.invoke('history:query', payload),
  historyTopSites: (payload) => ipcRenderer.invoke('history:topSites', payload),
  historyRecent: (payload) => ipcRenderer.invoke('history:recent', payload),
  historyClear: (payload) => ipcRenderer.invoke('history:clear', payload),

  // ── Bookmarks ───────────────────────────────────────────────────────────
  // pass-through: the renderer sends the payload object; main destructures it. Do NOT re-wrap.
  bookmarksList: () => ipcRenderer.invoke('bookmarks:list'),
  bookmarksAdd: (payload) => ipcRenderer.invoke('bookmarks:add', payload),
  bookmarksRemove: (payload) => ipcRenderer.invoke('bookmarks:remove', payload),
  bookmarksToggle: (payload) => ipcRenderer.invoke('bookmarks:toggle', payload),
  bookmarksIsBookmarked: (payload) => ipcRenderer.invoke('bookmarks:isBookmarked', payload),
  bookmarksUpdate: (payload) => ipcRenderer.invoke('bookmarks:update', payload),
  // change event (syncs bar/star across windows)
  onBookmarksChanged: (cb) => ipcRenderer.on('bookmarks:changed', (_e, d) => cb(d)),

  // ── Downloads ────────────────────────────────────────────────────────────
  downloadsList: () => ipcRenderer.invoke('downloads:list'),
  downloadsAction: (payload) => ipcRenderer.invoke('downloads:action', payload),
  onDownloadEvent: (cb) => ipcRenderer.on('downloads:event', (_e, d) => cb(d)),

  // ── Permissions ───────────────────────────────────────────────────────────
  onPermissionRequest: (cb) => ipcRenderer.on('permission:request', (_e, d) => cb(d)),
  permissionRespond: (payload) =>
    ipcRenderer.invoke('permission:respond', payload),

  // ── Settings / About / window / data / search / print / devtools ────────
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  onSettingsChanged: (cb) => ipcRenderer.on('settings:changed', (_e, d) => cb(d)),
  appInfo: () => ipcRenderer.invoke('app:info'),
  newWindow: (opts) => ipcRenderer.invoke('win:new', opts || {}),
  clearData: (opts) => ipcRenderer.invoke('data:clear', opts || {}),
  // pass-through: the renderer sends the payload object from the spec ({ guestId }); we just forward it.
  print: (payload) => ipcRenderer.invoke('print:start', payload),
  openDevTools: (payload) => ipcRenderer.invoke('devtools:open', payload),
  getEngines: () => ipcRenderer.invoke('search:getEngines'),

  // ── Find-in-page via IPC (reserve; standard bar uses the <webview> API) ─
  findStart: (guestId, text, options) =>
    ipcRenderer.invoke('find:start', { guestId, text, options }),
  findStop: (guestId, action) => ipcRenderer.invoke('find:stop', { guestId, action }),
  onFindResult: (cb) => ipcRenderer.on('find:result', (_e, d) => cb(d)),

  // ── Browser engine proof (no IPC, direct from preload's process.versions) ──
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    v8: process.versions.v8,
    node: process.versions.node,
  },

  platform: process.platform,

  // ── Phase 1: pages as WebContentsView managed by main (flag LOGICA_PILOT_WCV) ─
  // The shell becomes a remote control: sends commands by tabId and receives state events.
  // Inert with the flag OFF (view.enabled() → {enabled:false} → shell uses <webview>).
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
