'use strict';

/**
 * webview-manager.js — Architectural entry point for webviews (parity with the browser).
 *
 * The main process does NOT create the <webview> elements (the renderer owns them). But the main
 * process needs the `webContents` of each webview to wire features that ONLY live in the main:
 *   - native context menu (context-menu)
 *   - setWindowOpenHandler (replaces the 'new-window' event, deprecated in Electron 33)
 *   - found-in-page (find results)
 * And, ONCE per session of the 'persist:logica-pilot' partition:
 *   - will-download (downloads)
 *   - setPermissionRequestHandler (camera/mic/geolocation/notifications)
 *
 * The hook is `win.webContents.on('did-attach-webview', (e, wc) => equip(wc, win))`,
 * registered by the main in createWindow().
 *
 * CDP is EXCLUSIVE: Pilot attaches `webContents.debugger` on the tab. Opening DevTools
 * creates a second CDP consumer on the same webContents → conflict. That's why the
 * DevTools gate (runs.has(guestId)) is checked in the main before opening.
 */

const { Menu, session, clipboard } = require('electron');

const PARTITION = 'persist:logica-pilot';

// WeakSet of webContents already equipped (prevents wiring handlers twice).
const equippedWC = new WeakSet();
// Sessions of partition already configured (will-download + permissions), by name.
const wiredSessions = new Set();
// guestId → { wc }  — live registry of webviews for main process lookups.
const guests = new Map();

// Pending permission callbacks: requestId → { callback, timer, guestId, origin, permission }.
const pendingPermissions = new Map();
let permissionSeq = 0;
// Permissions already granted by the user: key `${origin}|${permission}`.
// Consulted by the setPermissionCheckHandler (navigator.permissions.query / enumerateDevices).
const grantedPermissions = new Set();
// Timeout for permission request without response (prevents orphaned callback hanging the page).
const PERMISSION_TIMEOUT_MS = 30000;

// Dependencies injected by the main (to avoid coupling IPC/stores here).
let deps = {
  // (channel, payload) => sends to renderer of the window that owns the webview
  sendToHost: null,
  // (item, emit) => registers download in downloads-store; returns record
  registerDownload: null,
  // default search engine (id) for "Search in Google/…" context menu
  getSearchEngine: null,
  // (id, query) => search URL
  buildSearchUrl: null,
  // Chrome extensions system (extensions-manager): addTab(wc, win)
  extensions: null,
};

/** Configures dependencies (called once by the main at boot). */
function configure(options = {}) {
  deps = { ...deps, ...options };
}

/**
 * Equips a webview webContents with the main process feature handlers.
 * @param {import('electron').WebContents} wc
 * @param {import('electron').BrowserWindow} hostWin  window that owns the webview
 */
function equip(wc, hostWin) {
  if (!wc || equippedWC.has(wc)) return;
  equippedWC.add(wc);

  const guestId = wc.id;
  guests.set(guestId, { wc });
  wc.once('destroyed', () => {
    guests.delete(guestId);
    // sweep orphaned permission requests from this guest: deny and clean up (no hanging callback).
    for (const [id, slot] of pendingPermissions) {
      if (slot.guestId === guestId) {
        try { clearTimeout(slot.timer); } catch {}
        try { slot.callback(false); } catch {}
        pendingPermissions.delete(id);
      }
    }
  });

  wireWindowOpen(wc, hostWin);
  wireContextMenu(wc, hostWin);
  wireFoundInPage(wc, hostWin);

  // Browser extensions: register this <webview> as a "tab" so that content
  // scripts, action buttons (browser actions), and extension popups work.
  if (deps.extensions && typeof deps.extensions.addTab === 'function') {
    try { deps.extensions.addTab(wc, hostWin); } catch (e) {
      // best-effort: navigation should not break because of an extension
    }
  }

  // Partition session: configure ONCE (downloads + permissions).
  wireSession(wc.session);
}

/** Resolves the webview's webContents by guestId, if still alive. */
function getGuest(guestId) {
  const slot = guests.get(guestId);
  return slot ? slot.wc : null;
}

// ── window.open / target=_blank (replaces deprecated 'new-window') ───────────────
function wireWindowOpen(wc, hostWin) {
  wc.setWindowOpenHandler(({ url, disposition }) => {
    // Renderer owns the webviews → ask IT to create the tab.
    sendHost(hostWin, 'tab:open', {
      url,
      background: disposition === 'background-tab',
    });
    return { action: 'deny' };
  });
}

// ── Native context menu (right-click) ────────────────────────────────────
function wireContextMenu(wc, hostWin) {
  wc.on('context-menu', (_e, params) => {
    const template = buildContextTemplate(wc, hostWin, params);
    if (!template.length) return;
    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: hostWin || undefined });
  });
}

/** Builds the context menu template conditional on click parameters. */
function buildContextTemplate(wc, hostWin, params) {
  const t = [];
  const editFlags = params.editFlags || {};

  // Link → open in new tab (back to renderer) + copy address.
  if (params.linkURL) {
    t.push({
      label: 'Open link in new tab',
      click: () => sendHost(hostWin, 'tab:open', { url: params.linkURL, background: false }),
    });
    t.push({
      label: 'Open link in new tab (background)',
      click: () => sendHost(hostWin, 'tab:open', { url: params.linkURL, background: true }),
    });
    t.push({
      label: 'Copy link address',
      click: () => { try { clipboard.writeText(params.linkURL); } catch {} },
    });
    t.push({ type: 'separator' });
  }

  // Image → save / copy.
  if (params.mediaType === 'image' && params.srcURL) {
    t.push({
      label: 'Save image as…',
      click: () => { try { wc.downloadURL(params.srcURL); } catch {} },
    });
    t.push({
      label: 'Copy image',
      click: () => { try { wc.copyImageAt(params.x, params.y); } catch {} },
    });
    t.push({
      label: 'Copy image address',
      click: () => { try { clipboard.writeText(params.srcURL); } catch {} },
    });
    t.push({ type: 'separator' });
  }

  // Editable field → cut/copy/paste (respecting editFlags).
  if (params.isEditable) {
    t.push({ label: 'Cut', enabled: !!editFlags.canCut, click: () => { try { wc.cut(); } catch {} } });
    t.push({ label: 'Copy', enabled: !!editFlags.canCopy, click: () => { try { wc.copy(); } catch {} } });
    t.push({ label: 'Paste', enabled: !!editFlags.canPaste, click: () => { try { wc.paste(); } catch {} } });
    t.push({ label: 'Select All', enabled: !!editFlags.canSelectAll, click: () => { try { wc.selectAll(); } catch {} } });
    t.push({ type: 'separator' });
  } else if (params.selectionText) {
    // Text selection → copy + search.
    t.push({ label: 'Copy', click: () => { try { wc.copy(); } catch {} } });
    const term = params.selectionText.trim().slice(0, 120);
    t.push({
      label: `Search for "${term.length > 40 ? term.slice(0, 40) + '…' : term}"`,
      click: () => {
        const engineId = deps.getSearchEngine ? deps.getSearchEngine() : 'google';
        const url = deps.buildSearchUrl
          ? deps.buildSearchUrl(engineId, params.selectionText)
          : 'https://www.google.com/search?q=' + encodeURIComponent(params.selectionText);
        sendHost(hostWin, 'tab:open', { url, background: false });
      },
    });
    t.push({ type: 'separator' });
  }

  // Navigation always available.
  t.push({
    label: 'Back',
    enabled: canGoBack(wc),
    click: () => { try { goBack(wc); } catch {} },
  });
  t.push({
    label: 'Forward',
    enabled: canGoForward(wc),
    click: () => { try { goForward(wc); } catch {} },
  });
  t.push({ label: 'Reload', click: () => { try { wc.reload(); } catch {} } });
  t.push({ type: 'separator' });
  t.push({
    label: 'Inspect element',
    click: () => { try { wc.inspectElement(params.x, params.y); } catch {} },
  });

  return t;
}

// navigationHistory is the new API (Electron 33); direct canGoBack/goBack have been
// deprecated. Defensive fallback for both forms.
function canGoBack(wc) {
  try {
    if (wc.navigationHistory && typeof wc.navigationHistory.canGoBack === 'function') {
      return wc.navigationHistory.canGoBack();
    }
    return wc.canGoBack();
  } catch { return false; }
}
function canGoForward(wc) {
  try {
    if (wc.navigationHistory && typeof wc.navigationHistory.canGoForward === 'function') {
      return wc.navigationHistory.canGoForward();
    }
    return wc.canGoForward();
  } catch { return false; }
}
function goBack(wc) {
  if (wc.navigationHistory && typeof wc.navigationHistory.goBack === 'function') wc.navigationHistory.goBack();
  else wc.goBack();
}
function goForward(wc) {
  if (wc.navigationHistory && typeof wc.navigationHistory.goForward === 'function') wc.navigationHistory.goForward();
  else wc.goForward();
}

// ── found-in-page → send the counter to renderer ─────────────────────────────
function wireFoundInPage(wc, hostWin) {
  wc.on('found-in-page', (_e, result) => {
    sendHost(hostWin, 'find:result', {
      guestId: wc.id,
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
    });
  });
}

// ── Partition session: downloads + permissions (ONCE) ────────────────────
function wireSession(ses) {
  if (!ses) return;
  // stable key per session (uses storagePath if present; otherwise the ref itself)
  const key = ses.storagePath || PARTITION;
  if (wiredSessions.has(key)) return;
  wiredSessions.add(key);

  // Downloads
  ses.on('will-download', (_e, item) => {
    if (!deps.registerDownload) return;
    deps.registerDownload(item, (payload) => {
      // emits to ALL windows (renderer decides whether to show)
      broadcast('downloads:event', payload);
    });
  });

  // Permissions: default DENY for unknown ones; prompt for sensitive ones.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const sensitive = ['media', 'geolocation', 'notifications'];
    if (!sensitive.includes(permission)) {
      // anything not sensitive: deny by default (safer than Electron's default)
      callback(false);
      return;
    }
    const requestId = `perm_${Date.now()}_${++permissionSeq}`;
    const origin = (details && (details.requestingUrl || details.requestingOrigin)) || '';
    // security timeout: if nobody responds, deny (frees the page without hanging).
    const timer = setTimeout(() => {
      if (pendingPermissions.has(requestId)) respondPermission(requestId, false);
    }, PERMISSION_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    pendingPermissions.set(requestId, { callback, timer, guestId: wc.id, origin, permission });
    // prompt the window's UI that contains this webview
    const win = ownerWindow(wc);
    sendHost(win, 'permission:request', {
      requestId,
      guestId: wc.id,
      permission,
      origin,
    });
  });

  // Synchronous check (navigator.permissions.query, enumerateDevices labels…):
  // reflects what the user has ALREADY granted; deny-by-default for everything else.
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    const sensitive = ['media', 'geolocation', 'notifications'];
    if (!sensitive.includes(permission)) return false;
    return grantedPermissions.has(`${requestingOrigin}|${permission}`);
  });
}

/** Resolves a pending permission (called by the 'permission:respond' IPC handler). */
function respondPermission(requestId, granted) {
  const slot = pendingPermissions.get(requestId);
  if (!slot) return false;
  pendingPermissions.delete(requestId);
  try { clearTimeout(slot.timer); } catch {}
  // memorizes grants for the synchronous check handler (permissions.query/enumerateDevices).
  if (granted && slot.origin && slot.permission) {
    grantedPermissions.add(`${slot.origin}|${slot.permission}`);
  }
  try { slot.callback(!!granted); } catch {}
  return true;
}

// ── Send helpers ──────────────────────────────────────────────────────────
function sendHost(win, channel, payload) {
  if (deps.sendToHost) { deps.sendToHost(win, channel, payload); return; }
  if (win && !win.isDestroyed()) {
    try { win.webContents.send(channel, payload); } catch {}
  }
}

function broadcast(channel, payload) {
  // delegates to the main, which knows all windows
  if (deps.broadcast) { deps.broadcast(channel, payload); return; }
}

/** Attempts to find the BrowserWindow that owns a webview webContents. */
function ownerWindow(wc) {
  // The hostWebContents points to the page that embeds the <webview>.
  try {
    const { BrowserWindow } = require('electron');
    const hostWC = wc.hostWebContents;
    if (hostWC) {
      const win = BrowserWindow.fromWebContents(hostWC);
      if (win) return win;
    }
  } catch {}
  // fallback: first available window
  try {
    const { BrowserWindow } = require('electron');
    return BrowserWindow.getAllWindows()[0] || null;
  } catch { return null; }
}

module.exports = {
  configure,
  equip,
  getGuest,
  respondPermission,
  PARTITION,
};
