'use strict';

/* Logica Pilot — renderer (orchestrator): standard browser (tabs/address bar) + autonomous panel.
   Modules: TabStrip (tabs.js), Omnibox (omnibox.js), FindBar (findbar.js), Overlays (overlays.js).
   dispatchMenu(name) is the SINGLE SOURCE of actions (native shortcuts, keydown, and menu items converge here).
   The Pilot engine (pilot:*) does not change. */

const $ = (s) => document.querySelector(s);
const views = $('#views');
const tabsEl = $('#tabs');
const address = $('#address');

if (window.pilot && window.pilot.platform === 'darwin') document.body.classList.add('darwin');

const HOME = 'pilot://newtab';

// ── Incognito mode ────────────────────────────────────────────
// The main passes ?incognito=1 in the loadFile of the incognito window. Here the renderer:
//  - uses a single NON-persistent partition for the <webview> elements of this window
//    (without 'persist:' → cookies/cache/login only live in memory and disappear on close);
//  - does NOT save history (skips historyAdd/historyUpdateTitle);
//  - marks the body + shows an "Incognito" badge in the toolbar.
const _qs = new URLSearchParams(location.search);
const IS_INCOGNITO = _qs.get('incognito') === '1';
// Initial URL (chrome.windows.create({url}) from extensions) → 1st tab opens at it
const INITIAL_URL = _qs.get('initialUrl') || '';
// In-memory partition, unique to this window (without 'persist:' = non-persistent)
const INCOGNITO_PARTITION = 'logica-pilot-incognito-' + Date.now();
const WV_PARTITION = IS_INCOGNITO ? INCOGNITO_PARTITION : 'persist:logica-pilot';
if (IS_INCOGNITO) {
  document.body.classList.add('incognito');
  document.title = 'Incognito — Logica Pilot';
  // reveals the "Incognito" badge in the toolbar (only in this window)
  const badge = document.getElementById('incognito-badge');
  if (badge) badge.hidden = false;
}

// settings cache (loaded on boot)
let settings = { theme: 'system', searchEngine: 'google', homepage: HOME };

// ── Modules ───────────────────────────────────────────────────
const omnibox = new Omnibox();
const findbar = new FindBar();
const overlays = new Overlays();
const bookmarks = new Bookmarks();

function makeWebview(url) {
  const wv = document.createElement('webview');
  wv.setAttribute('src', url);
  wv.setAttribute('allowpopups', '');
  // persistent profile (cookies/logins) — or in-memory partition in incognito mode
  wv.setAttribute('partition', WV_PARTITION);
  // Native PDF: enables the built-in viewer plugin (renders PDFs inline,
  // like in Chrome). Without this the <webview> only offers the PDF for download.
  wv.setAttribute('plugins', '');
  wv.setAttribute('webpreferences', 'plugins=true');
  // Guest preload (home channel → shell). It is GUARDED by protocol within the
  // preload itself (only pilot:// pages receive window.lpHome), so it is safe
  // to place it on ALL webviews — normal sites receive no API.
  if (window.pilot && window.pilot.webviewPreload) wv.setAttribute('preload', window.pilot.webviewPreload);
  return wv;
}

const strip = new TabStrip({
  container: tabsEl,
  viewsContainer: views,
  makeWebview: (url) => equipWebview(makeWebview(url), url),
  home: HOME,
  onActivate: (tab) => onActivateTab(tab),
  onAllClosed: () => strip.create(HOME),
  canClose: (tab) => {
    // Pilot guard: if the tab is piloting, stop the run before closing
    if (tab.piloting && tab._guestId) {
      try { window.pilot.stop({ guestId: tab._guestId }); } catch {}
      if (running) setRunning(false);
    }
    return true;
  },
});

// connects ALL listeners of a tab's webview (favicon, audio, progress, security, history)
function equipWebview(wv, url) {
  // the corresponding tab is resolved by getWebContentsId at event time
  const tabOf = () => strip.tabs.find((t) => t.wv === wv);

  wv.addEventListener('did-start-loading', () => { const t = tabOf(); if (t) { strip.setLoading(t.id, true); if (t.id === strip.activeId) progressStart(); } });
  wv.addEventListener('did-stop-loading', () => { const t = tabOf(); if (t) { strip.setLoading(t.id, false); if (t.id === strip.activeId) { progressDone(); syncNav(); } } });
  wv.addEventListener('page-title-updated', (e) => {
    const t = tabOf(); if (!t) return;
    strip.setTitle(t.id, e.title);
    if (t.id === strip.activeId) document.title = (e.title ? e.title + ' — ' : '') + 'Logica Pilot';
    // corrects in history the title of the current URL (did-navigate recorded the old title).
    // updateTitle doesn't inflate visitCount; uses t.url (already committed by did-navigate).
    // In incognito mode we do NOT save history.
    if (!IS_INCOGNITO) { try { window.pilot.historyUpdateTitle && window.pilot.historyUpdateTitle({ url: t.url, title: e.title }); } catch {} }
  });
  wv.addEventListener('page-favicon-updated', (e) => { const t = tabOf(); if (t) strip.setFavicon(t.id, e.favicons && e.favicons[0]); });
  wv.addEventListener('media-started-playing', () => { const t = tabOf(); if (t) strip.setAudible(t.id, true); });
  wv.addEventListener('media-paused', () => { const t = tabOf(); if (t) strip.setAudible(t.id, false); });

  wv.addEventListener('did-navigate', (e) => {
    const t = tabOf(); if (!t) return;
    const isErr = /^pilot:\/\/error\//.test(e.url);
    // On the error page, show the ORIGINAL failed URL in the address bar.
    const shownUrl = isErr ? (new URLSearchParams(new URL(e.url).search).get('url') || e.url) : e.url;
    strip.setUrl(t.id, e.url);
    if (t.id === strip.activeId) { omnibox.setUrl(shownUrl); syncNav(); bookmarks.onActiveUrl(shownUrl); }
    // persistent history: creates the entry WITHOUT a title (t.title is still from the
    // previous page). The subsequent page-title-updated fills the real title via
    // historyUpdateTitle (dedup by URL, doesn't inflate visitCount).
    // In incognito mode (or on the internal error page) we do NOT save history.
    if (!IS_INCOGNITO && !isErr) { try { window.pilot.historyAdd && window.pilot.historyAdd({ url: e.url, title: '', ts: Date.now() }); } catch {} }
  });
  wv.addEventListener('did-navigate-in-page', (e) => {
    if (!e.isMainFrame) return;
    const t = tabOf(); if (!t) return;
    strip.setUrl(t.id, e.url);
    if (t.id === strip.activeId) { omnibox.setUrl(e.url); bookmarks.onActiveUrl(e.url); }
  });
  wv.addEventListener('did-fail-load', (e) => {
    // -3 = ERR_ABORTED (navigation cancelled), -300 = ERR_INVALID_URL → ignore.
    if (!e.isMainFrame || e.errorCode === -3 || e.errorCode === -300) return;
    const t = tabOf(); if (!t) return;
    const failed = e.validatedURL || t.url || '';
    // Do not loop on our own error page.
    if (/^pilot:\/\/error\//.test(failed)) return;
    const errUrl = 'pilot://error/?url=' + encodeURIComponent(failed) +
      '&code=' + encodeURIComponent(e.errorCode) +
      '&desc=' + encodeURIComponent(e.errorDescription || '');
    try { wv.loadURL(errUrl); } catch {}
    // Keep the address bar showing the ORIGINAL attempted URL, not pilot://error.
    if (t.id === strip.activeId) { omnibox.setUrl(failed); omnibox.setSecurity(failed, true); }
  });
  wv.addEventListener('zoom-changed', (e) => {
    const t = tabOf(); if (!t) return;
    try { t.zoomLevel = wv.getZoomLevel(); } catch {}
    if (t.id === strip.activeId) showZoom(t.zoomLevel);
  });

  // Home → Shell channel: the home/dashboard (pilot://newtab, isolated, without window.pilot)
  // requests via webview-preload (window.lpHome → sendToHost). Here the shell responds.
  // The preload is guarded by protocol, so only pilot:// pages trigger this.
  wv.addEventListener('ipc-message', (e) => {
    if (e.channel === 'home:pilot') launchPilotFromHome(e.args[0]);
    else if (e.channel === 'home:open' && e.args[0]) strip.create(e.args[0]);
  });
  return wv;
}

// Opens the Pilot panel already filled with the objective from home/dashboard.
// PREFILL + FOCUS only — does NOT auto-run (safer: the user presses "Pilot").
// Additionally, the active tab here IS the home (pilot://newtab), where running doesn't make
// sense. Auto-run is a FUTURE option (e.g. open a new tab and pilot it).
function launchPilotFromHome(objective) {
  togglePilot(true); // ensures panel is visible
  const goalEl = $('#goal');
  if (goalEl) {
    goalEl.value = String(objective == null ? '' : objective);
    try { goalEl.focus(); } catch {}
  }
}

function onActivateTab(tab) {
  omnibox.setUrl(tab.url);
  document.title = (tab.title && tab.title !== 'New tab' ? tab.title + ' — ' : '') + 'Logica Pilot';
  if (findbar.isOpen) findbar.close();
  hideZoom();
  syncNav();
  bookmarks.onActiveUrl(tab.url);
  // notifies the extension system which tab is active (→ extensions.selectTab)
  notifyExtActiveTab(tab);
}

// Notifies main of the guestId of the active tab (for extensions.selectTab). The guestId
// (webContentsId) only exists after the <webview> attaches — if not yet, waits for
// dom-ready once.
function notifyExtActiveTab(tab) {
  if (!tab || !window.pilot || !window.pilot.tabActivated) return;
  let guestId = null;
  try { guestId = tab.wv.getWebContentsId(); } catch {}
  if (guestId) { try { window.pilot.tabActivated({ guestId }); } catch {} return; }
  const once = () => {
    tab.wv.removeEventListener('dom-ready', once);
    if (tab.id !== strip.activeId) return; // tab changed while loading
    try { window.pilot.tabActivated({ guestId: tab.wv.getWebContentsId() }); } catch {}
  };
  try { tab.wv.addEventListener('dom-ready', once); } catch {}
}

function active() { return strip.active(); }
function activeWebview() { const t = active(); return t ? t.wv : null; }

function syncNav() {
  const t = active();
  if (!t) return;
  try {
    $('#nav-back').disabled = !t.wv.canGoBack();
    $('#nav-fwd').disabled = !t.wv.canGoForward();
  } catch {}
}

// ── Progress bar ──────────────────────────────────────────────
const progressEl = $('#progress');
let progressTimer = null;
function progressStart() {
  clearTimeout(progressTimer);
  progressEl.hidden = false;
  progressEl.style.opacity = '1';
  progressEl.style.width = '8%';
  // gradually rises to ~80%
  requestAnimationFrame(() => { progressEl.style.width = '80%'; });
}
function progressDone() {
  progressEl.style.width = '100%';
  progressTimer = setTimeout(() => {
    progressEl.style.opacity = '0';
    setTimeout(() => { progressEl.hidden = true; progressEl.style.width = '0%'; }, 250);
  }, 200);
}

// ── Zoom indicator ────────────────────────────────────────────
const zoomPill = $('#zoom-pill');
const zoomPct = $('#zoom-pct');
let zoomHideTimer = null;
function zoomPercent(level) { return Math.round(Math.pow(1.2, level) * 100); }
function showZoom(level) {
  zoomPct.textContent = zoomPercent(level) + '%';
  zoomPill.hidden = false;
  clearTimeout(zoomHideTimer);
  if (level === 0) zoomHideTimer = setTimeout(hideZoom, 1200);
}
function hideZoom() { zoomPill.hidden = true; }

function zoomStep(delta) {
  const t = active(); if (!t) return;
  let level;
  try {
    if (delta === 0) level = 0;
    else level = Math.max(-7, Math.min(7, (t.wv.getZoomLevel() || 0) + delta));
    t.wv.setZoomLevel(level);
    t.zoomLevel = level;
    showZoom(level);
  } catch {}
}

// ── Basic navigation ──────────────────────────────────────────
function navigateActive(url) { const t = active(); if (t) { try { t.wv.loadURL(url); } catch {} } }

omnibox.init({
  getActiveUrl: () => { const t = active(); return t ? t.url : ''; },
  navigate: (url) => navigateActive(url),
  settings,
});
findbar.init({ getActiveWebview: () => activeWebview() });
// the floating find bar notifies when it closes (Esc/✕) → resets state
if (window.pilot && window.pilot.onFindClosed) window.pilot.onFindClosed(() => findbar.notifyClosed());

$('#nav-back').addEventListener('click', () => { const t = active(); if (t && t.wv.canGoBack()) t.wv.goBack(); });
$('#nav-fwd').addEventListener('click', () => { const t = active(); if (t && t.wv.canGoForward()) t.wv.goForward(); });
$('#nav-reload').addEventListener('click', () => { const t = active(); if (t) t.wv.reload(); });
$('#tab-new').addEventListener('click', () => strip.create(HOME));
// extensions button (🧩) → opens the Chrome Web Store
{ const extBtn = $('#ext-btn'); if (extBtn) extBtn.addEventListener('click', () => dispatchMenu('extensions')); }

// window controls (Windows/Linux) — on Mac uses native traffic lights
document.querySelectorAll('.wc').forEach((b) =>
  b.addEventListener('click', () => window.pilot.winControl(b.dataset.win)),
);

// ── Theme ──────────────────────────────────────────────────────
const themeBtn = $('#theme-btn');
const THEME_ICONS = {
  light: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  system: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
};
function updateThemeIcon() {
  const choice = window.LPTheme ? window.LPTheme.getChoice() : 'system';
  themeBtn.innerHTML = THEME_ICONS[choice] || THEME_ICONS.system;
  themeBtn.title = 'Theme: ' + ({ light: 'light', dark: 'dark', system: 'system' }[choice]) + ' (⌘⇧L)';
}
themeBtn.addEventListener('click', () => { if (window.LPTheme) window.LPTheme.cycle(); });
if (window.LPTheme) { window.LPTheme.onChange(() => updateThemeIcon()); updateThemeIcon(); }

// Settings/About panel as FLOATING WINDOW (OS layer, above
// <webview>). Primary path; falls back to old HTML overlay if IPC is missing.
function openPanelOrOverlay(type) {
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  if (window.pilot && window.pilot.openPanel) {
    try { window.pilot.openPanel({ type, dark }); return; } catch {}
  }
  // fallback: HTML overlay (behind webview, but preserves function)
  if (type === 'about') overlays.openAbout(); else overlays.openSettings();
}

// ── DISPATCH: single source of actions ────────────────────────
function dispatchMenu(name, arg) {
  const t = active();
  // Dynamic action: open an installed extension's options/homepage (ext-open:<id>).
  if (typeof name === 'string' && name.startsWith('ext-open:')) {
    const id = name.slice('ext-open:'.length);
    try { window.pilot.extActivate && window.pilot.extActivate({ id }); } catch {}
    return;
  }
  switch (name) {
    case 'new-tab': strip.create(HOME); address.focus(); break;
    case 'close-tab': if (strip.activeId) strip.close(strip.activeId); break;
    case 'reopen-tab': strip.reopenClosed(); break;
    case 'next-tab': strip.selectRelative(1); break;
    case 'prev-tab': strip.selectRelative(-1); break;
    case 'reload': if (t) t.wv.reload(); break;
    case 'hard-reload': if (t) { try { t.wv.reloadIgnoringCache(); } catch { t.wv.reload(); } } break;
    case 'stop': if (t) { try { t.wv.stop(); } catch {} } break;
    case 'focus-address': address.focus(); address.select(); break;
    case 'find': findbar.open(); break;
    case 'find-next': findbar.next(); break;
    case 'find-prev': findbar.prev(); break;
    case 'zoom-in': zoomStep(+1); break;
    case 'zoom-out': zoomStep(-1); break;
    case 'zoom-reset': zoomStep(0); break;
    case 'print': try { window.pilot.print ? window.pilot.print({ guestId: guestIdOf(t) }) : t && t.wv.print(); } catch { try { t && t.wv.print(); } catch {} } break;
    case 'home': navigateActive(settings.homepage || HOME); break;
    case 'theme-cycle': case 'toggle-theme': if (window.LPTheme) window.LPTheme.cycle(); break;
    case 'back': if (t && t.wv.canGoBack()) t.wv.goBack(); break;
    case 'forward': if (t && t.wv.canGoForward()) t.wv.goForward(); break;
    case 'toggle-pilot': togglePilot(true); $('#goal').focus(); break;
    case 'new-window': try { window.pilot.newWindow && window.pilot.newWindow({}); } catch {} break;
    case 'new-window-incognito': try { window.pilot.newWindow && window.pilot.newWindow({ incognito: true }); } catch {} break;
    case 'history': openInternal('pilot://history'); break;
    case 'downloads': openInternal('pilot://downloads'); break;
    case 'extensions': openExtensions(); break;
    case 'ext-store': extStore(); break;
    case 'ext-install-unpacked': extInstallUnpacked(); break;
    case 'ext-install-current': { const t = active(); const id = t ? storeIdFromUrl(t.url) : null; if (id) extInstallById(id); break; }
    case 'reader': toggleReader(); break;
    case 'translate': translatePage(); break;
    case 'settings': openPanelOrOverlay('settings'); break;
    case 'about': openPanelOrOverlay('about'); break;
    case 'clear-data': openPanelOrOverlay('settings'); break;
    case 'bookmark-page': bookmarks.toggleCurrent(); break;
    case 'toggle-bookmarks-bar': bookmarks.toggleBar(); break;
    case 'show-bookmarks': bookmarks.openManager(); break;
    case 'devtools': openDevTools(t); break;
    case 'open-url': if (arg) navigateActive(arg); break;
    case 'goto-tab-1': case 'goto-tab-2': case 'goto-tab-3': case 'goto-tab-4':
    case 'goto-tab-5': case 'goto-tab-6': case 'goto-tab-7': case 'goto-tab-8': case 'goto-tab-9':
      strip.selectIndex(Number(name.split('-').pop())); break;
    case 'goto-tab-last': strip.selectIndex(9); break; // selectIndex(9) already maps to last tab
    default: console.warn('dispatchMenu: unknown action', name); break;
  }
}
window.dispatchMenu = dispatchMenu;

function guestIdOf(t) { try { return t ? t.wv.getWebContentsId() : null; } catch { return null; } }

// ── Internal pages (history/downloads) ──────────────────────────
// Reuses the active tab if it is "empty" (newtab or on the page itself);
// otherwise opens in a new tab. Keeps the overlay as fallback if something fails.
function openInternal(url) {
  const t = active();
  const cur = t ? (t.url || '') : '';
  const reusable = !t || cur === HOME || cur.startsWith('pilot://newtab') ||
    cur.startsWith('pilot://history') || cur.startsWith('pilot://downloads');
  if (t && reusable) navigateActive(url);
  else strip.create(url);
}

// ── Extensions: floating menu listing installed extensions (icon + name +
//    pin/unpin + remove), plus "Install from folder" and "Chrome Web Store".
//    Installing from the store inside <webview> is fragile (store detects
//    "not-Chrome"); the unpacked folder is the guaranteed path. ──────
const T = (k, v) => (window.i18n ? window.i18n.t(k, v) : k);

async function openExtensions() {
  const btn = $('#ext-btn');
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  let list = [];
  try { list = (window.pilot.extList ? await window.pilot.extList() : []) || []; } catch {}

  const items = [];
  // Offer to install the extension of the current Web Store detail page.
  const t = active();
  const sid = t ? storeIdFromUrl(t.url) : null;
  if (sid && !list.some((e) => e.id === sid)) {
    let nm = ((t.title || '').replace(/\s*[-–|]\s*Chrome.*$/i, '').trim()) || 'extension';
    if (nm.length > 28) nm = nm.slice(0, 28) + '…';
    items.push({ glyph: '⬇', label: T('ext.install', { name: nm }), action: 'ext-install-current' });
    items.push({ sep: true });
  }

  items.push({ header: T('ext.installed') });
  if (!list.length) {
    items.push({ empty: T('ext.none') });
  } else {
    for (const e of list) {
      items.push({
        icon: e.icon || null,
        glyph: e.icon ? null : '🧩',
        label: e.name,
        action: 'ext-open:' + e.id,
        ext: { id: e.id, pinned: e.pinned, hasAction: e.hasAction },
      });
    }
  }
  items.push({ sep: true });
  items.push({ glyph: '📁', label: T('ext.installFolder'), action: 'ext-install-unpacked' });
  items.push({ glyph: '🛒', label: T('ext.webStore'), action: 'ext-store' });

  if (window.pilot && window.pilot.showAppMenu && btn) {
    const r = btn.getBoundingClientRect();
    window.pilot.showAppMenu({ items, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, dark });
  } else if (sid) {
    extInstallById(sid);
  } else {
    extInstallUnpacked();
  }
}

// extracts the ID (32 chars a-p) from a Chrome Web Store detail URL
function storeIdFromUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)chromewebstore\.google\.com$/.test(u.host) && u.host !== 'chrome.google.com') return null;
    const m = u.pathname.match(/\/detail\/[^/]+\/([a-p]{32})/) || u.pathname.match(/\/([a-p]{32})(?:[/?#]|$)/);
    return m ? m[1] : null;
  } catch { return null; }
}

function extInstallById(id) {
  if (window.pilot && window.pilot.extInstallById && id) {
    try { window.pilot.extInstallById({ id }); } catch {}
  }
}

function extStore() {
  if (window.pilot && window.pilot.openExtensions) {
    try { window.pilot.openExtensions({ target: 'store' }); return; } catch {}
  }
  openInternal('https://chromewebstore.google.com/');
}

function extInstallUnpacked() {
  // main opens the folder selector and shows a native confirmation dialog
  if (window.pilot && window.pilot.extInstallUnpacked) {
    try { window.pilot.extInstallUnpacked(); } catch {}
  }
}

// ── Reader mode (window.Reader) ───────────────────────────────
async function toggleReader() {
  const wv = activeWebview();
  if (!wv || !window.Reader) return;
  try {
    const res = await window.Reader.toggle(wv);
    if (res && res.ok === false) {
      const msg = res.error === 'no-article'
        ? 'Reader mode: I did not find a readable article on this page.'
        : ('Reader mode unavailable: ' + (res.error || 'unknown error') + '.');
      showResult({ success: false, result: msg });
    }
  } catch (e) {
    showResult({ success: false, result: 'Reader mode failed: ' + (e && e.message) });
  }
}

// ── Translate page (Google Translate) ─────────────────────────
function translatePage() {
  const t = active();
  if (!t) return;
  const cur = t.url || '';
  // only translates real web pages (not internal pilot://)
  if (!/^https?:\/\//i.test(cur)) {
    showResult({ success: false, result: 'Translate: open a web page first.' });
    return;
  }
  // target language follows the UI language (falls back to English)
  const tl = ((window.i18n && window.i18n.lang) || 'en').split('-')[0];
  const target =
    'https://translate.google.com/translate?sl=auto&tl=' + encodeURIComponent(tl) + '&u=' + encodeURIComponent(cur);
  navigateActive(target);
}

async function openDevTools(t) {
  if (!t) return;
  const guestId = guestIdOf(t);
  if (!guestId) return;
  try {
    if (window.pilot.openDevTools) {
      const r = await window.pilot.openDevTools({ guestId });
      if (r && r.ok === false && r.reason === 'pilot-running') {
        // CDP is exclusive: Pilot is using the debugger on this tab
        showResult({ success: false, result: 'DevTools unavailable: Pilot is controlling this tab (CDP exclusive). Stop the run first.' });
      }
    } else { try { t.wv.openDevTools(); } catch {} }
  } catch {}
}

// enables native menu (accelerators work even with focus on <webview>)
if (window.pilot && window.pilot.onMenuAction) window.pilot.onMenuAction((name) => dispatchMenu(name));

// popups / target=_blank (new-window is DEAD in Electron 33 → comes via tab:open from main)
// Opening a link in a new tab from context menu also comes via tab:open (webview-manager).
if (window.pilot && window.pilot.onTabOpen) {
  window.pilot.onTabOpen(({ url, background }) => strip.create(url, { background: !!background }));
}

// ── Extensions: main asks renderer to create/activate/close tabs ───────────────
// (the electron-chrome-extensions lib calls chrome.tabs.create/update/remove)
if (window.pilot && window.pilot.onExtCreateTab) {
  window.pilot.onExtCreateTab(({ reqId, url, background }) => {
    const tab = strip.create(url || HOME, { background: !!background });
    // reports the guestId (webContentsId) to main as soon as the webview attaches
    // the guestId is valid right AFTER the <webview> attach — which happens well
    // before dom-ready. So we do SHORT POLLING (we don't depend on page load, which
    // could never paint and blow the main's 15s timeout).
    let done = false;
    function cleanup() {
      clearInterval(poll);
      try { tab.wv.removeEventListener('did-start-loading', onEvt); } catch {}
      try { tab.wv.removeEventListener('dom-ready', onEvt); } catch {}
    }
    const report = (guestId) => { if (done) return; done = true; cleanup(); try { window.pilot.extTabCreated({ reqId, guestId }); } catch {} };
    const tryId = () => { let id = null; try { id = tab.wv.getWebContentsId(); } catch {} if (id) { report(id); return true; } return false; };
    const onEvt = () => tryId();
    let tries = 0;
    const poll = setInterval(() => { if (tryId() || ++tries > 200) { if (!done) report(null); } }, 25);
    try { tab.wv.addEventListener('did-start-loading', onEvt); } catch {}
    try { tab.wv.addEventListener('dom-ready', onEvt); } catch {}
    tryId();
  });
}
if (window.pilot && window.pilot.onExtSelectTab) {
  window.pilot.onExtSelectTab(({ guestId }) => {
    const t = tabByGuestId(guestId);
    if (t) strip.activate(t.id);
  });
}
if (window.pilot && window.pilot.onExtRemoveTab) {
  window.pilot.onExtRemoveTab(({ guestId }) => {
    const t = tabByGuestId(guestId);
    if (t) strip.close(t.id);
  });
}

// ── Extensions: pin/unpin (toolbar icon visibility) + open options ─────────────
// <browser-action-list> renders each action into its (open) shadow DOM with
// id="<extensionId>"; pinning shows/hides individual icons there.
function applyExtPins() {
  const list = document.getElementById('ext-actions');
  const root = list && list.shadowRoot;
  if (!root || !window.pilot || !window.pilot.extList) return;
  Promise.resolve(window.pilot.extList()).then((exts) => {
    for (const e of exts || []) {
      const el = root.getElementById(e.id);
      if (el) el.style.display = e.pinned === false ? 'none' : '';
    }
  }).catch(() => {});
}
(function watchExtActions() {
  const list = document.getElementById('ext-actions');
  if (!list) return;
  let observed = false;
  const mo = new MutationObserver(() => setTimeout(applyExtPins, 60));
  let tries = 0;
  const timer = setInterval(() => {
    if (list.shadowRoot && !observed) {
      try { mo.observe(list.shadowRoot, { childList: true, subtree: true }); } catch {}
      observed = true; applyExtPins();
    }
    if (observed || ++tries > 50) clearInterval(timer);
  }, 120);
})();
if (window.pilot && window.pilot.onExtChanged) window.pilot.onExtChanged(() => applyExtPins());
if (window.pilot && window.pilot.onExtOpenUrl) window.pilot.onExtOpenUrl(({ url }) => { if (url) strip.create(url); });

// ── Ad-block shield (toolbar): shows blocked count; click toggles blocking ─────
(function initAdblock() {
  const btn = document.getElementById('adblock-btn');
  const countEl = document.getElementById('adblock-count');
  if (!btn || !window.pilot || !window.pilot.adblockGet) return;
  let enabled = true, count = 0, available = true;
  function render() {
    btn.classList.toggle('off', !enabled || !available);
    if (countEl) {
      if (enabled && available && count > 0) { countEl.hidden = false; countEl.textContent = count > 999 ? '999+' : String(count); }
      else countEl.hidden = true;
    }
    const base = window.i18n ? window.i18n.t('adblock.title') : 'Ad blocker';
    btn.title = available ? (base + (enabled ? '' : ' — off')) : (base + ' — unavailable');
  }
  window.pilot.adblockGet().then((s) => { enabled = !!s.enabled; count = s.count || 0; available = s.available !== false; render(); }).catch(() => {});
  btn.addEventListener('click', () => {
    // Open the anchored panel (on/off + per-page count + per-site allow + lists).
    if (window.pilot.adblockPanel) {
      const r = btn.getBoundingClientRect();
      const dark = document.documentElement.getAttribute('data-theme') !== 'light';
      window.pilot.adblockPanel({ rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, dark });
      return;
    }
    // Fallback: plain toggle if the panel IPC is unavailable.
    if (!available) return;
    window.pilot.adblockToggle().then((s) => { enabled = !!s.enabled; if (typeof s.count === 'number') count = s.count; render(); }).catch(() => {});
  });
  if (window.pilot.onAdblockCount) window.pilot.onAdblockCount((d) => { count = (d && d.count) || 0; render(); });
  // Keep the shield in sync when toggled from the panel or Settings.
  if (window.pilot.onAdblockState) window.pilot.onAdblockState((s) => {
    if (!s) return;
    enabled = !!s.enabled; available = s.available !== false;
    if (typeof s.count === 'number') count = s.count;
    render();
  });
})();

// Resolves the tab (from TabStrip) whose <webview> has the given webContentsId.
function tabByGuestId(guestId) {
  if (guestId == null) return null;
  return strip.tabs.find((t) => {
    try { return t.wv.getWebContentsId() === guestId; } catch { return false; }
  }) || null;
}

// ── Shortcuts (shell keydown) — converge in dispatchMenu ─────
window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key;
  const lower = key.length === 1 ? key.toLowerCase() : key;

  // Ctrl+Tab / Ctrl+Shift+Tab (independent of meta)
  if (e.ctrlKey && key === 'Tab') { e.preventDefault(); dispatchMenu(e.shiftKey ? 'prev-tab' : 'next-tab'); return; }

  // Esc: closes overlays/menu/findbar; otherwise stops loading
  if (key === 'Escape') {
    if (overlays.appMenu && !overlays.appMenu.hidden) { overlays.closeMenu(); return; }
    if (bookmarks.isManagerOpen && bookmarks.isManagerOpen()) { bookmarks.closeManager(); return; }
    if (overlays.anyOverlayOpen()) { overlays.closeAll(); return; }
    if (findbar.isOpen) { findbar.close(); return; }
    if (document.activeElement === address) return; // omnibox handles its own Esc
    dispatchMenu('stop');
    return;
  }

  if (!mod) return;

  // ⌥⌘R → reader mode (Alt+Cmd/Ctrl+R). Before the shift/normal block to avoid collision
  // with ⌘R (reload) or ⌘⇧R (hard-reload).
  if (e.altKey && lower === 'r') { e.preventDefault(); dispatchMenu('reader'); return; }

  // ⌘1..9 → tab N (9 = last)
  if (!e.shiftKey && key >= '1' && key <= '9') { e.preventDefault(); dispatchMenu('goto-tab-' + key); return; }

  if (e.shiftKey) {
    switch (lower) {
      case 't': e.preventDefault(); dispatchMenu('reopen-tab'); return;
      case 'r': e.preventDefault(); dispatchMenu('hard-reload'); return;
      case 'l': e.preventDefault(); dispatchMenu('theme-cycle'); return;
      case 'n': e.preventDefault(); dispatchMenu('new-window-incognito'); return;
      case 'j': e.preventDefault(); dispatchMenu('downloads'); return;
      case 'h': e.preventDefault(); dispatchMenu('home'); return;
      case 'g': e.preventDefault(); dispatchMenu('find-prev'); return;
      case 'b': e.preventDefault(); dispatchMenu('toggle-bookmarks-bar'); return;
      case 'i': e.preventDefault(); dispatchMenu('devtools'); return;
      default: break;
    }
  }

  switch (lower) {
    case 't': e.preventDefault(); dispatchMenu('new-tab'); break;
    case 'w': e.preventDefault(); dispatchMenu('close-tab'); break;
    case 'l': e.preventDefault(); dispatchMenu('focus-address'); break;
    case 'r': e.preventDefault(); dispatchMenu('reload'); break;
    case 'k': e.preventDefault(); dispatchMenu('toggle-pilot'); break;
    case 'd': e.preventDefault(); dispatchMenu('bookmark-page'); break;
    case 'f': e.preventDefault(); dispatchMenu('find'); break;
    case 'g': e.preventDefault(); dispatchMenu('find-next'); break;
    case 'p': e.preventDefault(); dispatchMenu('print'); break;
    case 'y': e.preventDefault(); dispatchMenu('history'); break;
    case 'n': e.preventDefault(); dispatchMenu('new-window'); break;
    case ',': e.preventDefault(); dispatchMenu('settings'); break;
    case '=': case '+': e.preventDefault(); dispatchMenu('zoom-in'); break;
    case '-': e.preventDefault(); dispatchMenu('zoom-out'); break;
    case '0': e.preventDefault(); dispatchMenu('zoom-reset'); break;
    default: break;
  }
});

// recalculates tab width on window resize
window.addEventListener('resize', () => strip.render());

// ── Pilot panel (engine — do not modify flow) ─────────────────
const pilotPanel = $('#pilot');
const timeline = $('#timeline');
const resultBox = $('#result');
const statusDot = $('#status-dot');
let running = false;

function togglePilot(force) {
  const collapsed = force === undefined ? !pilotPanel.classList.contains('collapsed') : !force;
  pilotPanel.classList.toggle('collapsed', collapsed);
  $('#pilot-toggle').classList.toggle('active', !collapsed);
}
$('#pilot-toggle').addEventListener('click', () => togglePilot());

const ICONS = { navigate: '🌐', click: '👆', type: '⌨', scroll: '↕', press: '⏎', extract: '⛏', wait: '⏱', done: '✓', error: '⚠' };

function actionDetail(action, input) {
  if (!input) return '';
  switch (action) {
    case 'navigate': return input.url || '';
    case 'click': return `element [${input.index}]` + (input.reason ? ` — ${input.reason}` : '');
    case 'type': return `[${input.index}] "${input.text}"${input.submit ? ' + Enter' : ''}`;
    case 'scroll': return `${input.direction} ${input.amount || 600}px`;
    case 'press': return input.key || '';
    case 'extract': return input.query || 'page text';
    default: return input.reason || '';
  }
}

function addStep({ step, action, input, result }) {
  $('#timeline-empty')?.remove();
  const el = document.createElement('div');
  el.className = `step act-${action}`;
  el.innerHTML =
    `<div class="ico">${ICONS[action] || '•'}</div>` +
    '<div class="body">' +
    `<div class="head"><span class="act">${action}</span><span class="n">#${step}</span></div>` +
    `<div class="detail">${escapeHtml(actionDetail(action, input))}</div>` +
    (result && action !== 'done' ? `<div class="res">${mdInline(String(result).slice(0, 120))}</div>` : '') +
    '</div>';
  timeline.appendChild(el);
  timeline.scrollTop = timeline.scrollHeight;
}

function showResult(res) {
  resultBox.hidden = false;
  resultBox.className = 'result ' + (res.success ? 'ok' : 'fail');
  resultBox.innerHTML =
    `<h4>${res.success ? 'Result' : 'Not completed'} · ${res.steps || 0} steps</h4>` +
    `<p>${mdInline(res.result || '')}</p>`;
  resultBox.scrollIntoView({ behavior: 'smooth' });
}

function setRunning(on) {
  running = on;
  $('#run').hidden = on;
  $('#stop').hidden = !on;
  statusDot.className = 'status-dot' + (on ? ' busy' : '');
}

async function runPilot() {
  const goal = $('#goal').value.trim();
  const t = active();
  if (!goal || !t || running) return;

  let guestId;
  try { guestId = t.wv.getWebContentsId(); } catch { showResult({ success: false, result: 'Tab still loading — try again.' }); return; }

  // clears timeline
  timeline.innerHTML = '';
  resultBox.hidden = true;
  setRunning(true);
  togglePilot(true);

  t._guestId = guestId;
  strip.setPiloting(t.id, true); // visual indicator + guard on close
  try {
    const res = await window.pilot.run({ guestId, objective: goal, vision: $('#vision').checked });
    showResult(res);
    statusDot.className = 'status-dot ' + (res.success ? 'ok' : 'err');
  } catch (e) {
    showResult({ success: false, result: e.message });
    statusDot.className = 'status-dot err';
  } finally {
    setRunning(false);
    strip.setPiloting(t.id, false);
  }
}

$('#run').addEventListener('click', runPilot);
$('#stop').addEventListener('click', () => { const t = active(); if (t && t._guestId) window.pilot.stop({ guestId: t._guestId }); });
$('#goal').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') runPilot(); });

window.pilot.onStep(addStep);
window.pilot.onError((d) => { showResult({ success: false, result: d.message }); setRunning(false); statusDot.className = 'status-dot err'; const t = active(); if (t) strip.setPiloting(t.id, false); });

// ── Downloads / permissions (from main) ───────────────────
if (window.pilot && window.pilot.onDownloadEvent) window.pilot.onDownloadEvent((d) => overlays.onDownload(d));
// Permission as FLOATING WINDOW (OS layer, above <webview>). The queue/
// timeout/response live in main+webview-manager; renderer just relays the request.
// Falls back to old HTML overlay if the floating panel's IPC is missing.
if (window.pilot && window.pilot.onPermissionRequest) {
  window.pilot.onPermissionRequest((req) => {
    const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    if (window.pilot.openPermPrompt) {
      try { window.pilot.openPermPrompt(Object.assign({ dark }, req)); return; } catch {}
    }
    overlays.showPermission(req);
  });
}

// ── util ─────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Safe inline markdown for AI results: escape first, then render **bold**, *italic*,
// `code` and line breaks. Never injects raw HTML from the model.
function mdInline(s) {
  let h = escapeHtml(s);
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/\r?\n/g, '<br>');
  return h;
}

// ── boot ──────────────────────────────────────────────────────
async function boot() {
  overlays.wireMenu(); // wires the ⋮ menu NOW, before any await (doesn't depend on IPC)
  // loads settings (search engine, homepage) before the first tab
  try {
    if (window.pilot && window.pilot.settingsGet) {
      const s = await window.pilot.settingsGet();
      if (s) settings = Object.assign(settings, s);
    }
  } catch {}
  // i18n: applies the saved language (or 'auto' → follows the OS via navigator.language) across
  // the entire shell (translates [data-i18n*] from index.html).
  try { if (window.i18n) window.i18n.setLang(settings.language || 'auto'); } catch {}
  let engines = [];
  try { if (window.pilot && window.pilot.getEngines) engines = (await window.pilot.getEngines()) || []; } catch {}

  // propagates settings/engine to modules
  omnibox.updateSettings(settings);
  // if the catalog brought a default engine template, injects it into the omnibox
  const def = engines.find((e) => e.id === settings.searchEngine);
  if (def && def.searchTemplate) omnibox.updateSettings({ searchTemplate: def.searchTemplate });

  overlays.init({
    dispatch: (name, arg) => dispatchMenu(name, arg),
    settings,
    engines,
    onSettingsChange: (patch) => {
      settings = Object.assign(settings, patch);
      const sel = engines.find((e) => e.id === settings.searchEngine);
      omnibox.updateSettings(Object.assign({}, patch, sel && sel.searchTemplate ? { searchTemplate: sel.searchTemplate } : {}));
    },
  });

  // The floating Settings panel is a SEPARATE window → when it saves via
  // settings:set, main emits settings:changed; reapplies in the already-open shell.
  if (window.pilot && window.pilot.onSettingsChanged) {
    window.pilot.onSettingsChanged((s) => {
      if (!s) return;
      settings = Object.assign(settings, s);
      const sel = engines.find((e) => e.id === settings.searchEngine);
      omnibox.updateSettings(Object.assign(
        { searchEngine: settings.searchEngine, homepage: settings.homepage },
        sel && sel.searchTemplate ? { searchTemplate: sel.searchTemplate } : {},
      ));
      if (s.theme && window.LPTheme && window.LPTheme.apply && window.LPTheme.current !== s.theme) {
        try { window.LPTheme.apply(s.theme); } catch {}
      }
      // language change made in Settings panel → reapplies in the shell.
      if (s.language) { try { if (window.i18n) window.i18n.setLang(s.language); } catch {} }
    });
  }

  // Bookmarks: bar + star + manager. getActive() delivers the active tab
  // (url/title/favicon) to the star; bar preference comes from settings.
  bookmarks.init({
    navigate: (url) => navigateActive(url),
    openTab: (url, opts) => strip.create(url, opts || {}),
    getActive: () => { const t = active(); return t ? { url: t.url, title: t.title, favicon: t.favicon } : null; },
    showBar: typeof settings.showBookmarksBar === 'boolean' ? settings.showBookmarksBar : undefined,
    persistBarPref: (on) => { settings.showBookmarksBar = on; try { window.pilot?.settingsSet?.({ showBookmarksBar: on }); } catch {} },
  });

  // 1st tab: at the URL requested by the extension (chrome.windows.create) or at home.
  strip.create(INITIAL_URL || HOME);
}
boot();
