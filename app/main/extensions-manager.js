'use strict';

/**
 * extensions-manager.js — Support for CHROME EXTENSIONS (Manifest V2/V3) in Logica Pilot.
 *
 * Uses the libraries by Samuel Maddock (open-source, GPL-3.0 license — valid because the
 * product is GPL-3.0-or-later):
 *   - electron-chrome-extensions@4.9.x  → chrome.* APIs + <browser-action-list>
 *   - electron-chrome-web-store@0.13.x  → install/update extensions from the Web Store
 *
 * These versions target Electron 37+, which exposes the modern `session.extensions.*`
 * API (loadExtension / getAllExtensions / removeExtension). Note: reliable ad/tracker
 * blocking is handled by the native engine (adblock-manager.js), NOT by MV3 extensions —
 * Electron does not apply declarativeNetRequest to embedded content reliably.
 *
 * ── ARCHITECTURAL CHALLENGE ────────────────────────────────────────────────────
 * In Logica Pilot, the RENDERER owns the <webview> instances (not the main process). The library expects
 * the main process to create tabs and return [webContents, BrowserWindow] synchronously via promise.
 * Bridge: createTab() asks the renderer (channel 'ext:createTab'), the renderer creates the
 * <webview>, and on did-attach-webview the renderer reports the guestId (channel
 * 'ext:tabCreated'); here we resolve the promise with webContents.fromId(guestId).
 *
 * selectTab()/removeTab() also route back to the renderer (channels 'ext:selectTab' /
 * 'ext:removeTab') to activate/close the tab corresponding to the guestId.
 */

const path = require('path');
const fs = require('fs');
const { webContents, BrowserWindow, ipcMain, dialog } = require('electron');

let ElectronChromeExtensions = null;
let webStore = null;
try {
  ({ ElectronChromeExtensions } = require('electron-chrome-extensions'));
  webStore = require('electron-chrome-web-store');
} catch (e) {
  // Require failure cannot crash the browser: extensions become no-op.
  console.error('[ext] extension libraries unavailable:', e && e.message);
}

// Singleton instance (one session/partition across the entire app).
let extensions = null;
// Directory where installed/unpacked extensions live.
let extensionsPath = null;
let _session = null;

/**
 * Electron 35+ moved extension APIs to `session.extensions.*`
 * (getAllExtensions/loadExtension/removeExtension). Older Electron exposed them on
 * the session directly. This returns whichever surface is available.
 */
function extApi(ses) {
  return (ses && ses.extensions) || ses;
}

// Tab creation bridge: requestId → { resolve, reject, timer }.
const pendingTabCreates = new Map();
let tabCreateSeq = 0;
const TAB_CREATE_TIMEOUT_MS = 15000;

// Dependencies injected by main.
let deps = {
  // (channel, payload) → sends to renderer of ONE window (the host)
  sendToWindow: null,
  // () → active/focused BrowserWindow (fallback for createWindow / target window)
  getActiveWindow: null,
  // (opts) → creates new BrowserWindow and returns the instance (for chrome.windows.create)
  createBrowserWindow: null,
};

function configure(options = {}) {
  deps = { ...deps, ...options };
}

/** Is the integration active? (libraries present + instance created) */
function isEnabled() {
  return !!extensions;
}

/**
 * Initializes the extensions system for a session (the app's partition).
 * Must be called ONCE on app.whenReady, after configure().
 *
 * @param {Electron.Session} ses  session of the 'persist:logica-pilot' partition
 * @param {string} userDataDir    app.getPath('userData')
 */
async function init(ses, userDataDir) {
  if (!ElectronChromeExtensions || !ses) return null;
  _session = ses;
  if (extensions) return extensions;

  extensionsPath = path.join(userDataDir, 'extensions');
  try { fs.mkdirSync(extensionsPath, { recursive: true }); } catch {}

  // The library's preload (browser-action) must be injected into EVERY page that
  // hosts <browser-action-list> — i.e., the shell renderer. We register
  // it as a session preload to ensure the UI (index.html) receives it.
  // (The webview-manager also injects it in app/preload.js of the main renderer.)
  const browserActionPreload = require.resolve(
    'electron-chrome-extensions/dist/browser-action',
  );

  try {
    extensions = new ElectronChromeExtensions({
      license: 'GPL-3.0', // product is GPL-3.0-or-later → valid free license
      session: ses,
      createTab,
      selectTab,
      removeTab,
      createWindow,
      removeWindow,
    });
  } catch (e) {
    console.error('[ext] failed to instantiate ElectronChromeExtensions:', e && e.message);
    extensions = null;
    return null;
  }

  // REQUIRED for <browser-action-list> toolbar icons (ece 4.9): the element loads each
  // icon via crx://extension-icon/<id>/32/2?partition=persist:logica-pilot. Without the
  // crx:// handler the Image() load errors → the element gets class 'no-icon' → no icon.
  // The shell (index.html) runs in defaultSession, so the crx:// request is dispatched
  // THERE; the handler reads ?partition and routes to this extensions instance. Register
  // on both. Use the STATIC form (the instance form is deprecated).
  try {
    const { session: electronSession } = require('electron');
    ElectronChromeExtensions.handleCRXProtocol(ses);
    if (electronSession.defaultSession !== ses) {
      ElectronChromeExtensions.handleCRXProtocol(electronSession.defaultSession);
    }
  } catch (e) { console.error('[ext] handleCRXProtocol failed:', e && e.message); }

  // Enables the Web Store in the same session + loads already-installed
  // and unpacked extensions. loadExtensions=true (default) loads what is in
  // extensionsPath; allowUnpackedExtensions=true permits unpacked ones.
  if (webStore && typeof webStore.installChromeWebStore === 'function') {
    // FIX for store preload: the library uses `opts.modulePath || __dirname`, and its __dirname
    // (dist/cjs/browser) makes web-store-preload.js become
    // .../dist/cjs/browser/dist/renderer/web-store-preload.js (ENOENT) → the integration
    // that INTERCEPTS "Add to Chrome" (what Edge does natively) did not load.
    // We pass the PACKAGE ROOT to construct the correct path.
    let webStoreModulePath;
    try {
      const entry = require.resolve('electron-chrome-web-store');
      const marker = 'electron-chrome-web-store';
      const i = entry.indexOf(marker);
      if (i >= 0) webStoreModulePath = entry.slice(0, i + marker.length);
    } catch {}
    try {
      await webStore.installChromeWebStore({
        session: ses,
        extensionsPath,
        loadExtensions: true,
        allowUnpackedExtensions: true,
        autoUpdate: true,
        ...(webStoreModulePath ? { modulePath: webStoreModulePath } : {}),
      });
    } catch (e) {
      console.error('[ext] installChromeWebStore failed:', e && e.message);
    }
  }

  // Also loads unpacked extensions loose in <extensionsPath>/<id>/manifest.json
  // that did not come from the store (e.g., developer dragged a folder). Best-effort.
  await loadUnpackedExtensions(ses).catch(() => {});

  return extensions;
}

/** Path exposed to preload (browser-action) — used by webview-manager. */
function getBrowserActionPreloadPath() {
  try { return require.resolve('electron-chrome-extensions/dist/browser-action'); }
  catch { return null; }
}

/**
 * Loads unpacked extensions from <extensionsPath>/* that have manifest.json,
 * ignoring those already loaded by the session (the web-store already loads the "installed" ones).
 */
async function loadUnpackedExtensions(ses) {
  if (!extensionsPath || !ses) return;
  let entries = [];
  try { entries = await fs.promises.readdir(extensionsPath, { withFileTypes: true }); } catch { return; }
  const already = new Set();
  try { for (const e of extApi(ses).getAllExtensions()) already.add(e.id); } catch {}

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(extensionsPath, ent.name);
    // Web-store stores as <id>/<version>/; a loose unpacked one has manifest directly.
    const manifest = path.join(dir, 'manifest.json');
    let target = null;
    if (fs.existsSync(manifest)) {
      target = dir;
    } else {
      // tries <dir>/<version>/manifest.json (store layout)
      try {
        const subs = await fs.promises.readdir(dir, { withFileTypes: true });
        const sub = subs.find((s) => s.isDirectory() && fs.existsSync(path.join(dir, s.name, 'manifest.json')));
        if (sub) target = path.join(dir, sub.name);
      } catch {}
    }
    if (!target) continue;
    try {
      const ext = await extApi(ses).loadExtension(target, { allowFileAccess: true });
      if (ext) console.log('[ext] loaded:', ext.name, ext.version);
    } catch (e) {
      // already loaded (duplicate id) or invalid — ignore silently
      if (e && !/already/i.test(String(e.message))) {
        console.error('[ext] loadExtension failed', ent.name, e.message);
      }
    }
  }
}

// ── Tab bridge (renderer owns the <webview> instances) ──────────────────────

/**
 * chrome.tabs.create → asks renderer to create a tab and resolves with
 * [webContents, BrowserWindow] when it reports the guestId.
 */
function createTab(details = {}) {
  return new Promise((resolve, reject) => {
    const win = pickWindow(details.windowId);
    if (!win) { reject(new Error('No window available to create tab.')); return; }

    const reqId = `extreq_${Date.now()}_${++tabCreateSeq}`;
    const timer = setTimeout(() => {
      if (pendingTabCreates.has(reqId)) {
        pendingTabCreates.delete(reqId);
        reject(new Error('Timeout creating extension tab.'));
      }
    }, TAB_CREATE_TIMEOUT_MS);
    if (timer.unref) timer.unref();

    pendingTabCreates.set(reqId, { resolve, reject, timer, win });
    send(win, 'ext:createTab', {
      reqId,
      url: details.url || '',
      active: typeof details.active === 'boolean' ? details.active : true,
      background: details.active === false,
    });
  });
}

/** Called by IPC handler when renderer reports the guestId of the created tab. */
function resolveTabCreate(reqId, guestId) {
  const slot = pendingTabCreates.get(reqId);
  if (!slot) return false;
  pendingTabCreates.delete(reqId);
  try { clearTimeout(slot.timer); } catch {}
  const wc = guestId != null ? webContents.fromId(guestId) : null;
  if (!wc) { slot.reject(new Error('Tab webContents not found.')); return true; }
  slot.resolve([wc, slot.win]);
  return true;
}

/** chrome.tabs.update(active) → activates the tab of guestId in renderer. */
function selectTab(tab, browserWindow) {
  const win = browserWindow || pickWindow();
  if (!tab || !win) return;
  send(win, 'ext:selectTab', { guestId: tab.id });
}

/** chrome.tabs.remove → closes the tab of guestId in renderer. */
function removeTab(tab, browserWindow) {
  const win = browserWindow || pickWindow();
  if (!tab || !win) return;
  send(win, 'ext:removeTab', { guestId: tab.id });
}

/** chrome.windows.create → creates a new BrowserWindow and returns it. */
function createWindow(details = {}) {
  if (deps.createBrowserWindow) {
    const win = deps.createBrowserWindow({ url: details.url });
    return Promise.resolve(win);
  }
  return Promise.reject(new Error('createWindow not configured.'));
}

/** chrome.windows.remove → closes the window. */
function removeWindow(browserWindow) {
  try { if (browserWindow && !browserWindow.isDestroyed()) browserWindow.close(); } catch {}
}

// ── Tab registration (called by webview-manager.equip) ────────────────────

/** Registers a <webview> webContents as a tab for the extensions system. */
function addTab(wc, win) {
  if (!extensions || !wc) return;
  const browserWin = win || pickWindow();
  if (!browserWin) return;
  try { extensions.addTab(wc, browserWin); } catch (e) {
    console.error('[ext] addTab failed:', e && e.message);
  }
}

/** Notifies that the active tab changed (renderer → 'tabs:activated'). */
function activateTab(guestId) {
  if (!extensions || guestId == null) return;
  const wc = webContents.fromId(guestId);
  if (!wc) return;
  try { extensions.selectTab(wc); } catch (e) {
    console.error('[ext] selectTab failed:', e && e.message);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function pickWindow(windowId) {
  if (typeof windowId === 'number') {
    const w = BrowserWindow.fromId(windowId);
    if (w && !w.isDestroyed()) return w;
  }
  if (deps.getActiveWindow) {
    const w = deps.getActiveWindow();
    if (w && !w.isDestroyed()) return w;
  }
  const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  return all[0] || null;
}

function send(win, channel, payload) {
  if (deps.sendToWindow) { deps.sendToWindow(win, channel, payload); return; }
  if (win && !win.isDestroyed()) {
    try { win.webContents.send(channel, payload); } catch {}
  }
}

/** Installs an extension from the Web Store by ID (programmatic — does NOT depend
 *  on the store recognizing the browser; bypasses the "not Chrome" block). */
async function installById(id, opts = {}) {
  if (!webStore || typeof webStore.installExtension !== 'function') {
    throw new Error('Web Store support unavailable.');
  }
  if (!/^[a-p]{32}$/.test(String(id || ''))) throw new Error('Invalid extension ID.');
  // Pass extensionsPath so installById lands in the SAME lowercase dir as the store
  // install (otherwise it uses the library default 'Extensions' → uninstall mismatch).
  return webStore.installExtension(id, { session: _session || undefined, extensionsPath, ...opts });
}

// IPC handler: installs from the Web Store by ID (registered here to avoid touching main.js).
ipcMain.handle('ext:install-id', async (evt, { id } = {}) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  try {
    const ext = await installById(id);
    const name = (ext && (ext.name || (ext.manifest && ext.manifest.name))) || 'extension';
    try {
      dialog.showMessageBox(win || undefined, {
        type: 'info', title: 'Logica Pilot',
        message: 'Extension installed', detail: name + ' is now active. The icon appears in the extension bar.',
      });
    } catch {}
    return { ok: true, name };
  } catch (e) {
    try {
      dialog.showMessageBox(win || undefined, {
        type: 'error', title: 'Logica Pilot',
        message: 'Could not install from the Web Store', detail: e.message,
      });
    } catch {}
    return { ok: false, error: e.message };
  }
});

// ── Management menu (list / pin / options / uninstall) ──────────────────────

const settingsStore = require('./settings');

/** Reads an extension icon from disk → data: URL (works across sessions, unlike
 *  chrome-extension:// which is scoped to the webviews' partition). Best-effort. */
function iconDataUrl(ext) {
  try {
    const m = ext.manifest || {};
    const sets = [m.icons, m.action && m.action.default_icon, m.browser_action && m.browser_action.default_icon]
      .filter((x) => x && typeof x === 'object');
    let best = null, bestSize = -1;
    for (const set of sets) {
      for (const [sz, rel] of Object.entries(set)) {
        const n = parseInt(sz, 10) || 0;
        // prefer something around 32–48px for a crisp menu icon
        const score = n === 0 ? 24 : (n >= 32 && n <= 64 ? 100 - Math.abs(48 - n) : 50 - Math.abs(48 - n) / 4);
        if (score > bestSize) { bestSize = score; best = rel; }
      }
    }
    if (!best) return null;
    const file = path.join(ext.path, best.replace(/^\/+/, ''));
    if (!fs.existsSync(file)) return null;
    const buf = fs.readFileSync(file);
    const ext2 = path.extname(file).toLowerCase();
    const mime = ext2 === '.svg' ? 'image/svg+xml' : ext2 === '.jpg' || ext2 === '.jpeg' ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

/** Lists installed extensions with metadata for the 🧩 management menu. */
function listExtensions() {
  if (!_session) return [];
  let all = [];
  try { all = extApi(_session).getAllExtensions() || []; } catch { return []; }
  let pins = {};
  try { pins = settingsStore.get().extPins || {}; } catch {}
  return all
    .filter((e) => e && e.id && e.name !== 'Chrome Web Store')
    .map((e) => {
      const m = e.manifest || {};
      const opt = (m.options_ui && m.options_ui.page) || m.options_page || null;
      const hasAction = !!(m.action || m.browser_action);
      return {
        id: e.id,
        name: e.name || e.id,
        version: e.version || '',
        icon: iconDataUrl(e),
        optionsPage: opt ? `chrome-extension://${e.id}/${String(opt).replace(/^\/+/, '')}` : null,
        homepage: (m.homepage_url) || null,
        hasAction,
        pinned: pins[e.id] !== false, // default: pinned
      };
    });
}

/** Persists the pinned flag for an extension icon (toolbar visibility). */
function setPinned(id, pinned) {
  if (!/^[a-p]{32}$/.test(String(id || ''))) return false;
  try {
    const pins = { ...(settingsStore.get().extPins || {}) };
    pins[id] = !!pinned;
    settingsStore.set({ extPins: pins });
    return true;
  } catch { return false; }
}

/** Uninstalls an extension (from the Web Store store or an unpacked load). */
async function uninstall(id) {
  if (!/^[a-p]{32}$/.test(String(id || ''))) throw new Error('Invalid extension ID.');
  let removed = false;
  if (webStore && typeof webStore.uninstallExtension === 'function') {
    // MUST pass extensionsPath: the library defaults to <userData>/Extensions (capital E,
    // getDefaultExtensionsPath), but we install into <userData>/extensions (lowercase).
    // Without this the disk copy survives → the extension reloads on the next launch.
    try { await webStore.uninstallExtension(id, { session: _session, extensionsPath }); removed = true; }
    catch (e) { console.error('[ext] webStore.uninstallExtension failed:', e && e.message); }
  }
  // Always unload from the live session (icon disappears immediately via extension-unloaded).
  try { extApi(_session).removeExtension(id); removed = true; }
  catch (e) { if (!removed) throw new Error('Could not remove extension: ' + (e && e.message)); }
  // Belt-and-suspenders: delete the on-disk copy from BOTH possible layouts (lowercase
  // 'extensions' we configure + capital 'Extensions' library default), so extensions
  // installed via the store OR via installById are both gone for good.
  const parent = extensionsPath ? path.dirname(extensionsPath) : null;
  const dirs = [extensionsPath, parent && path.join(parent, 'Extensions')].filter(Boolean);
  for (const base of dirs) { try { await fs.promises.rm(path.join(base, id), { recursive: true, force: true }); } catch {} }
  return true;
}

/** Notifies every window's renderer that the extension set/pins changed. The 🧩
 *  menu is a CHILD popup window, so `evt.sender` is the popup — NOT the shell that
 *  hosts <browser-action-list>/applyExtPins. Broadcasting reaches the shell. */
function broadcastExtChanged() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) { try { w.webContents.send('ext:changed'); } catch {} }
  }
}

// IPC: management surface for the 🧩 menu.
ipcMain.handle('ext:list', () => listExtensions());
ipcMain.handle('ext:set-pinned', (evt, { id, pinned } = {}) => {
  const ok = setPinned(id, pinned);
  broadcastExtChanged();
  return { ok };
});
ipcMain.handle('ext:set-enabled', async (evt, { id, enabled } = {}) => {
  // Electron has no stable enable/disable; disabling = uninstall (reinstall to re-enable).
  // Normalized to always return a Promise<{ok,…}> and only take the destructive path
  // on an explicit disable.
  if (enabled === false) {
    try { await uninstall(id); broadcastExtChanged(); return { ok: true, removed: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  return { ok: true };
});
ipcMain.handle('ext:uninstall', async (evt, { id } = {}) => {
  try {
    await uninstall(id);
    broadcastExtChanged();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('ext:activate', (evt, { id } = {}) => {
  // "Activate" from the menu = open the extension's options page (if any) in a new tab.
  const list = listExtensions();
  const ext = list.find((e) => e.id === id);
  const url = ext && (ext.optionsPage || ext.homepage);
  if (url) { try { evt.sender.send('ext:open-url', { url }); } catch {} return { ok: true, url }; }
  return { ok: false };
});

/** Loads an unpacked extension from a folder chosen by the user. */
async function loadUnpacked(dir) {
  if (!_session) throw new Error('Extensions system not initialized.');
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
    throw new Error('Folder does not contain manifest.json — not an unpacked extension.');
  }
  return extApi(_session).loadExtension(dir, { allowFileAccess: true });
}

module.exports = {
  configure,
  init,
  isEnabled,
  addTab,
  activateTab,
  resolveTabCreate,
  getBrowserActionPreloadPath,
  loadUnpacked,
  listExtensions,
  setPinned,
  uninstall,
};
