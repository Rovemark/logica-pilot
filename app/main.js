'use strict';

/**
 * main.js — Main process of the BROWSER Logica Pilot (Electron = real browser engine).
 *
 * The window is a real browser: each tab is a <webview> (browser engine). When the
 * user requests a task, main attaches the `webContents.debugger` (CDP) to the active tab
 * and runs the SAME autonomous engine as headless mode. The AI has full control.
 *
 * This file is the BRIDGE: registers pilot:// protocol, native Application Menu,
 * theme (nativeTheme), stores (history/downloads/settings) and ALL IPC handlers
 * from the shell. Webviews are equipped by webview-manager via did-attach-webview.
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  webContents,
  shell,
  Menu,
  nativeTheme,
  session,
  protocol,
  dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { ElectronPage } = require('../src/electron-page');
const agent = require('../src/agent');
const llm = require('../src/llm');
const perception = require('../src/perception');
const actions = require('../src/actions');

const webviewManager = require('./main/webview-manager');
const extensionsManager = require('./main/extensions-manager');
const adblockManager = require('./main/adblock-manager');
const { buildMenu } = require('./main/menu');
const historyStore = require('./main/history-store');
const downloadsStore = require('./main/downloads-store');
const settingsStore = require('./main/settings');
const searchEngines = require('./main/search-engines');
const bookmarksStore = require('./main/bookmarks-store');
const newsFeed = require('./main/news');
const { createRegistry } = require('./main/view-registry');

const pkg = require('../package.json');

// Migration <webview> → WebContentsView (Phase 1). Behind flag: OFF (default) = current
// path with <webview>; ON = pages managed by main via view-registry.
// Allows coexistence and instant rollback during migration.
const WCV_ENABLED = process.env.LOGICA_PILOT_WCV === '1';

// App name = "Logica Pilot" (default would be "Electron"). Affects userData and
// branding read by libs via app.getName() — e.g., Chrome Web Store shows "Use in
// Logica Pilot" (lib replaces "Chrome" with app name in store preload).
app.setName('Logica Pilot');

// ── Anti-crash guard for main process ─────────────────────────────────
// Known bug in electron-chrome-extensions@4.1.1: on rapid navigation the frame
// is discarded BEFORE the onBeforeNavigate handler accesses WebFrameMain, throwing
// "Render frame was disposed before WebFrameMain could be accessed" as an
// UNCAUGHT exception → Electron kills the entire app (dialog "A JavaScript error…").
// It's a benign race (frame already dead; nothing to do). We swallow ONLY this error
// and keep running; any other exception continues to be logged for diagnosis.
process.on('uncaughtException', (err) => {
  const msg = String((err && err.message) || err);
  if (
    /Render frame was disposed before WebFrameMain could be accessed/i.test(msg) ||
    /WebFrameMain could be accessed/i.test(msg)
  ) {
    console.warn('[safe] frame discarded during navigation (ignored):', msg);
    return;
  }
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// Useful browser engine flags (non-fatal if ignored)
app.commandLine.appendSwitch('disable-features', 'AutomationControlled');
// Screenshot mode: force an English UI everywhere (shell + newtab webview) for the README.
if (process.env.LOGICA_PILOT_CAPTURE) app.commandLine.appendSwitch('lang', 'en-US');

// Present as Google Chrome: clean UA (without "Electron/Logica Pilot") so sites
// don't break AND so Chrome Web Store recognizes the browser (warning
// "switch to Chrome" disappears). Real install is programmatic (installExtension),
// but clean UA makes the store friendly.
try {
  const _chrome = process.versions.chrome || '130.0.0.0';
  const _os = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
    : 'X11; Linux x86_64';
  app.userAgentFallback =
    `Mozilla/5.0 (${_os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${_chrome} Safari/537.36`;
} catch {}

const PARTITION = webviewManager.PARTITION; // 'persist:logica-pilot'
const RENDERER_DIR = path.join(__dirname, 'renderer');
const NEWTAB_DIR = path.join(RENDERER_DIR, 'newtab');

// Pilot:// hosts that serve internal pages (each maps to app/renderer/<host>/).
// The default for each host is <host>.html (e.g., pilot://history → history/history.html).
const PILOT_HOSTS = {
  newtab: { dir: NEWTAB_DIR, index: 'newtab.html' },
  history: { dir: path.join(RENDERER_DIR, 'history'), index: 'history.html' },
  downloads: { dir: path.join(RENDERER_DIR, 'downloads'), index: 'downloads.html' },
  error: { dir: path.join(RENDERER_DIR, 'error'), index: 'error.html' },
};

// Multi-window: replaces singleton 'win' with a Set.
const windows = new Set();
const runs = new Map(); // guestId -> { cancelled }

// ── Register pilot:// protocol — register privileges BEFORE app.whenReady ─────────
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pilot',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

// Content area (where active WebContentsView appears): below titlebar
// (tab strip) + toolbar. It's a FALLBACK; shell reports exact container bounds for #views
// via IPC 'view:layout' (covers Pilot panel, bookmarks bar…).
function computeContentBounds(win) {
  const [w, h] = win.getContentSize();
  const TOP = 84; // ~ tab strip + toolbar
  return { x: 0, y: TOP, width: w, height: Math.max(0, h - TOP) };
}

// Phase 1 IPC: shell commands views by tabId; executes in registry of sender's WINDOW.
// Inert if window has no registry (flag OFF). Registered 1x.
function registerViewIpc() {
  const regOf = (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win && win._lpRegistry ? win._lpRegistry : null;
  };
  ipcMain.handle('view:enabled', () => ({ enabled: WCV_ENABLED }));
  ipcMain.handle('view:create', (e, p = {}) => { const r = regOf(e); if (r) r.createTab(p.tabId, { url: p.url }); return { ok: !!r }; });
  ipcMain.handle('view:activate', (e, p = {}) => { const r = regOf(e); if (r) r.activateTab(p.tabId); });
  ipcMain.handle('view:close', (e, p = {}) => { const r = regOf(e); if (r) r.closeTab(p.tabId); });
  ipcMain.handle('view:navigate', (e, p = {}) => { const r = regOf(e); if (r) r.navigate(p.tabId, p.url); });
  ipcMain.handle('view:back', (e, p = {}) => { const r = regOf(e); if (r) r.goBack(p.tabId); });
  ipcMain.handle('view:forward', (e, p = {}) => { const r = regOf(e); if (r) r.goForward(p.tabId); });
  ipcMain.handle('view:reload', (e, p = {}) => { const r = regOf(e); if (r) (p.hard ? r.reloadHard(p.tabId) : r.reload(p.tabId)); });
  ipcMain.handle('view:stop', (e, p = {}) => { const r = regOf(e); if (r) r.stop(p.tabId); });
  // shell reports exact bounds of content area (resize/panel/bookmarks)
  ipcMain.on('view:layout', (e, bounds) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    win._lpContentBounds = bounds;
    if (win._lpRegistry) win._lpRegistry.layout();
  });
}

// ── Window creation ─────────────────────────────────────────────────────────
function createWindow(opts = {}) {
  const smoke = !!process.env.LOGICA_PILOT_SMOKE;
  const uitest = !!process.env.LOGICA_PILOT_UITEST;
  const headless = smoke || uitest;

  // Initial backgroundColor by theme (kills white/black flash on boot/resize).
  const dark = resolveDark();
  const win = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: !headless,
    backgroundColor: dark ? '#0b0d12' : '#f1f3f4',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  windows.add(win);
  win.on('closed', () => windows.delete(win));

  // Equip each <webview> as soon as it attaches (downloads/context-menu/popups/find).
  win.webContents.on('did-attach-webview', (_e, wc) => {
    webviewManager.equip(wc, win);
  });

  // ── Phase 1 (flag LOGICA_PILOT_WCV): pages as WebContentsView managed by
  // main. Inert with flag OFF — renderer keeps creating <webview>. ON: main
  // creates/positions/swaps views; renderer becomes remote control via IPC view:*.
  if (WCV_ENABLED && !headless) {
    const registry = createRegistry({
      window: win,
      getContentBounds: () => win._lpContentBounds || computeContentBounds(win),
      emit: (channel, payload) => { try { if (!win.isDestroyed()) win.webContents.send(channel, payload); } catch {} },
      preload: path.join(__dirname, 'renderer', 'webview-preload.js'),
    });
    win._lpRegistry = registry;
    win.on('resize', () => registry.layout());
    win.on('closed', () => { try { registry.destroy(); } catch {} });
  }

  if (smoke) {
    // single window for smoke test, no UI
    runSmoke(win).catch((e) => {
      console.error('[SMOKE] unexpected error:', e);
      app.exit(1);
    });
    return win;
  }

  if (uitest) {
    // load REAL renderer (no GUI) and report console/boot errors
    runUiTest(win).catch((e) => {
      console.error('[UITEST] unexpected error:', e);
      app.exit(1);
    });
    return win;
  }

  // Incognito mode: pass in-memory partition via query (renderer chooses).
  // initialUrl: used by chrome.windows.create({url}) from extensions — renderer
  // opens a tab at that URL on mount (otherwise window would open blank/newtab).
  const query = {};
  if (opts.incognito) query.incognito = '1';
  if (opts.initialUrl && /^(https?|pilot|file|about):/i.test(opts.initialUrl)) {
    query.initialUrl = opts.initialUrl;
  }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query });

  // Screenshot mode: capture real app states to PNGs (for the README). Best-effort.
  if (process.env.LOGICA_PILOT_CAPTURE) {
    win.webContents.once('did-finish-load', () => { runCapture(win).catch((e) => console.error('[capture]', e && e.message)); });
  }

  if (process.env.LOGICA_PILOT_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });

  // force window to front (ensures Architect sees the NEW one, not an old one)
  win.once('ready-to-show', () => { try { win.show(); win.focus(); win.moveTop(); } catch {} });

  return win;
}

/** Decide dark theme from settings + nativeTheme. */
function resolveDark() {
  try {
    const mode = settingsStore.get().theme;
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
  } catch {}
  return nativeTheme.shouldUseDarkColors;
}

/** Reapply native backgroundColor to all windows (kills flash on resize). */
function applyWindowBackground() {
  const bg = nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#f1f3f4';
  for (const w of windows) {
    if (!w.isDestroyed()) {
      try { w.setBackgroundColor(bg); } catch {}
    }
  }
  return nativeTheme.shouldUseDarkColors;
}

// ── Self-test without GUI: proves Electron(browser engine) + CDP + perception path ──
async function runSmoke(win) {
  const url = argValue('--url') || 'https://example.com';
  try {
    const page = new ElectronPage(win.webContents);
    console.log('[SMOKE] navigating to', url);
    await page.goto(url);
    const snap = await perception.snapshot(page);
    console.log(`[SMOKE] title="${snap.title}" elements=${snap.elements.length}`);
    console.log('[SMOKE] map (excerpt):');
    console.log(perception.format(snap).split('\n').slice(0, 10).join('\n'));
    const shot = await actions.screenshot(page);
    console.log(`[SMOKE] screenshot OK (${Math.round(shot.length / 1024)}KB base64)`);
    console.log('[SMOKE] PASS ✅ — real browser engine driven via CDP from Electron.');
    app.exit(0);
  } catch (e) {
    console.error('[SMOKE] FAIL ❌', e.message);
    app.exit(1);
  }
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

// ── Screenshot capture: real app states → PNGs for the README ────────────────
async function runCapture(win) {
  const dir = process.env.LOGICA_PILOT_CAPTURE;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true).catch(() => {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shotOf = async (target, name, ms) => {
    if (ms) await sleep(ms);
    try {
      const img = await target.webContents.capturePage();
      fs.writeFileSync(path.join(dir, name), img.toPNG());
      console.log('[capture] wrote', name);
    } catch (e) { console.error('[capture] shot failed', name, e && e.message); }
  };
  const shot = (name, ms) => shotOf(win, name, ms);
  try {
    try { win.show(); win.focus(); } catch {}
    // Force English everywhere: shell i18n + the newtab webview's own runtime i18n.
    try { settingsStore.set({ language: 'en' }); } catch {}
    await js(`window.i18n && window.i18n.setLang('en')`);
    await js(`window.dispatchMenu && window.dispatchMenu('reload')`);
    await sleep(1200);
    await shot('home.png', 2600);                                  // new-tab (branded)

    // ── THE money shot: the Pilot AUTONOMOUSLY executing a real task ──
    // Navigate a real page, open the panel, give a goal, click Run — the LogicaProxy
    // drives the observe→decide→act loop and the timeline fills with real steps.
    await js(`window.dispatchMenu && window.dispatchMenu('open-url','https://en.wikipedia.org/wiki/Coffee')`);
    await sleep(4500);
    await js(`window.dispatchMenu && window.dispatchMenu('toggle-pilot');` +
      `var g=document.getElementById('goal');` +
      `if(g){g.value='Scroll the page and tell me which country is the largest coffee producer.'; g.dispatchEvent(new Event('input'));}` +
      `var r=document.getElementById('run'); if(r) r.click();`);
    await shot('pilot-running.png', 30000);                        // let the loop produce steps

    // ── Ad-block panel (separate popup window) ──
    await js(`var b=document.getElementById('adblock-btn'); if(b) b.click();`);
    await sleep(1400);
    if (typeof adblockPanelWin !== 'undefined' && adblockPanelWin && !adblockPanelWin.isDestroyed()) {
      await shotOf(adblockPanelWin, 'adblock-panel.png', 400);
    }
    await js(`document.body.click();`);
    await sleep(400);

    // ── Extensions menu (separate popup window) ──
    await js(`var e=document.getElementById('ext-btn'); if(e) e.click();`);
    await sleep(1600);
    if (typeof menuPopupWin !== 'undefined' && menuPopupWin && !menuPopupWin.isDestroyed()) {
      await shotOf(menuPopupWin, 'ext-menu.png', 400);
    }
  } catch (e) { console.error('[capture] error', e && e.message); }
  app.exit(0);
}

// ── Headless UI test: load real index.html and hunt for boot errors ──────────
async function runUiTest(win) {
  const errors = [];
  const warnings = [];

  win.webContents.on('console-message', (...a) => {
    // Electron <=33: (event, level, message, line, sourceId)
    // Newer Electron: (event{level,message,lineNumber,sourceId})
    let level, message, line, src;
    if (a.length >= 3 && typeof a[1] === 'number') {
      level = a[1]; message = a[2]; line = a[3]; src = a[4];
    } else {
      const ev = a[0] || {};
      level = ({ verbose: 0, info: 1, warning: 2, error: 3 })[ev.level] ?? 1;
      message = ev.message; line = ev.lineNumber; src = ev.sourceId;
    }
    const tag = `${String(src || '').split('/').pop()}:${line || '?'}`;
    if (level >= 3) errors.push(`[console.error] ${message} (${tag})`);
    else if (level === 2) warnings.push(`[console.warn] ${message} (${tag})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    errors.push(`did-fail-load ${code} ${desc} ${url}`),
  );
  win.webContents.on('render-process-gone', (_e, d) =>
    errors.push(`render-process-gone ${d && d.reason}`),
  );
  win.webContents.on('preload-error', (_e, p, err) =>
    errors.push(`preload-error ${err && err.message}`),
  );

  try {
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  } catch (e) {
    errors.push('loadFile throw: ' + e.message);
  }

  await new Promise((r) => setTimeout(r, 1800));

  let probe = {};
  try {
    probe = await win.webContents.executeJavaScript(
      `(function(){try{return {
        title: document.title,
        theme: document.documentElement.getAttribute('data-theme'),
        bodyClass: document.body.className,
        tabs: document.querySelectorAll('.tab').length,
        webviews: document.querySelectorAll('webview').length,
        addr: (document.getElementById('address')||{}).value,
        hasTabStrip: !!window.TabStrip, hasOmnibox: !!window.Omnibox,
        hasFindBar: !!window.FindBar, hasOverlays: !!window.Overlays,
        hasTheme: !!window.LPTheme, dispatchType: typeof window.dispatchMenu,
        i18nLang: (window.i18n && window.i18n.lang) || null,
        navBackTitle: (document.getElementById('nav-back') || {}).title || null,
        pilotKeys: window.pilot ? Object.keys(window.pilot).length : 0,
        missingEls: ['views','address','tabs','findbar','app-menu','settings-overlay','about-overlay']
          .filter(function(id){return !document.getElementById(id);})
      };}catch(e){return {probeError: e.message, stack:String(e.stack||'')};}})()`,
      true,
    );
  } catch (e) {
    probe = { evalError: e.message };
  }

  console.log('[UITEST] probe: ' + JSON.stringify(probe));

  // Feed diagnostics — grab webContents of GUEST (home pilot://newtab) directly
  // and fetch from route INSIDE its context/partition.
  let news = {};
  try {
    let guest = null;
    for (let i = 0; i < 25 && !guest; i++) {
      guest = webContents.getAllWebContents().find((w) => { try { return /pilot:\/\/newtab/.test(w.getURL()); } catch { return false; } });
      if (!guest) await new Promise((r) => setTimeout(r, 200));
    }
    if (!guest) {
      news = { noGuest: true, urls: webContents.getAllWebContents().map((w) => { try { return w.getURL(); } catch { return '?'; } }) };
    } else {
      for (let i = 0; i < 25; i++) {
        news = await guest.executeJavaScript(`(async function(){var o={url:location.href,grid:((document.getElementById('news-grid')||{}).children||[]).length,has:!!document.getElementById('news-grid')};try{var resp=await fetch('pilot://newtab/_data/news?cat=top');o.st=resp.status;var j=await resp.json();o.items=(j.items||[]).length;o.ok=j.ok;}catch(e){o.err=String(e&&e.message||e);}return o;})()`).catch((e) => ({ evalErr: e.message }));
        if (news && (news.grid > 0 || news.items > 0 || news.err || news.evalErr)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  } catch (e) { news = { outerErr: e.message }; }
  console.log('[UITEST] news: ' + JSON.stringify(news));

  // Menu ⋮ diagnostics — simulate click and report state
  let menu = {};
  try {
    menu = await win.webContents.executeJavaScript(
      `(function(){try{
        var btn=document.getElementById('menu-btn'); var m=document.getElementById('app-menu');
        if(!btn||!m) return {found:false, hasBtn:!!btn, hasMenu:!!m};
        var before=m.hidden;
        var tgt=btn.querySelector('svg')||btn;
        tgt.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
        var cs=getComputedStyle(m); var r=m.getBoundingClientRect();
        var wv=document.querySelector('.views webview.active');
        var wcs=wv?getComputedStyle(wv):null;
        return {found:true, hiddenBefore:before, hiddenAfter:m.hidden,
          display:cs.display, visibility:cs.visibility,
          wvDisplayWhenMenuOpen:(wcs?wcs.display:'no-wv'), wvVis:(wcs?wcs.visibility:'no-wv'),
          children:m.children.length};
      }catch(e){return {error:e.message};}})()`,
      true,
    );
  } catch (e) { menu = { evalError: e.message }; }
  console.log('[UITEST] menu: ' + JSON.stringify(menu));

  console.log(`[UITEST] warnings: ${warnings.length}`);
  warnings.slice(0, 12).forEach((w) => console.log('  ' + w));
  console.log(`[UITEST] errors: ${errors.length}`);
  errors.forEach((e) => console.log('  ' + e));
  console.log(errors.length === 0 ? '[UITEST] PASS ✅' : '[UITEST] FAIL ❌');
  app.exit(errors.length === 0 ? 0 : 1);
}

// ── Pilot:// protocol → start page + internal pages (history/downloads) ────
//
// Each pilot:// page runs in an isolated <webview>, without window.pilot. To talk to
// main it uses fetch() of same origin (supportFetchAPI enables this). Three types:
//   • static assets  → pilot://<host>/<file>      (read from host's dir)
//   • DATA routes    → GET  pilot://<host>/_data/... (return JSON from stores)
//   • ACTION routes  → POST pilot://<host>/_action/.. (execute in main, {ok})
// _data/_action don't touch disk — dispatched before file resolution.
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

function registerPilotProtocol() {
  const pilotProtocolHandler = async (request) => {
    let url;
    try { url = new URL(request.url); } catch { return new Response('Bad Request', { status: 400 }); }
    const host = url.hostname;
    const pathname = url.pathname || '/';
    const method = (request.method || 'GET').toUpperCase();

    // ── dynamic routes (data/action) — before any file read ──
    if (pathname.startsWith('/_data/') || pathname.startsWith('/_action/')) {
      try {
        return await handlePilotApi(host, pathname, method, request);
      } catch (e) {
        return jsonResponse({ ok: false, error: String(e && e.message || e) }, 500);
      }
    }

    // ── static assets ──
    const entry = PILOT_HOSTS[host];
    if (!entry) return new Response('Not Found', { status: 404 });
    const rel = pathname === '/' || pathname === '' ? entry.index : pathname.replace(/^\/+/, '');
    const baseDir = entry.dir;
    const resolved = path.normalize(path.join(baseDir, rel));
    // path traversal lock: must stay INSIDE host's dir (separator inclusive)
    if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const data = await fs.promises.readFile(resolved);
      return new Response(data, { headers: { 'content-type': contentType(resolved) } });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  };

  // DEFAULT session — covers app-wide pilot:// navigations.
  protocol.handle('pilot', pilotProtocolHandler);

  // Session of webviews PARTITION — CRITICAL for feed. Global handle serves default
  // session, but fetch() from INSIDE webview runs in partition persist:logica-pilot;
  // without handler registered in THAT session, fetch gave opaque network error
  // (was the feed bug "couldn't load"). Proven in harness exp-registry: pilot://_data/news
  // → FEED-OK in a WebContentsView of that partition.
  try {
    session.fromPartition('persist:logica-pilot').protocol.handle('pilot', pilotProtocolHandler);
  } catch (e) {
    console.warn('[pilot://] registration in partition session failed:', e && e.message);
  }
}

/** Read JSON body from POST request (tolerant of empty/invalid body). */
async function readJsonBody(request) {
  try { return (await request.json()) || {}; } catch { return {}; }
}

/**
 * Dispatch pilot://<host>/_data/... (GET) and /_action/... (POST) routes.
 * Always return JSON Response. Errors become {ok:false}.
 */
// Load translation catalog (renderer/i18n/locales.js) in main process
// to serve to isolated home (pilot://). Cached; read via VM with window shim.
let _uiLocales = null;
function loadLocales() {
  if (_uiLocales) return _uiLocales;
  try {
    const src = fs.readFileSync(path.join(__dirname, 'renderer', 'i18n', 'locales.js'), 'utf8');
    const sandbox = { window: {} };
    require('vm').runInNewContext(src, sandbox, { timeout: 1000 });
    _uiLocales = sandbox.window.LP_LOCALES || {};
  } catch (e) {
    console.warn('[i18n] loadLocales failed:', e && e.message);
    _uiLocales = {};
  }
  return _uiLocales;
}

// Resolve UI language: 'auto'/empty → OS language (app.getLocale), with smart fallback
// (en-US→en, pt-PT→pt-BR) to a supported locale.
function resolveUiLang(setting) {
  const codes = Object.keys(loadLocales());
  let want = setting;
  if (!want || want === 'auto') { try { want = app.getLocale(); } catch { want = 'en'; } }
  if (codes.includes(want)) return want;
  const base = String(want || '').toLowerCase().split('-')[0];
  const hit = codes.find((c) => c.toLowerCase().split('-')[0] === base);
  return hit || (codes.includes('en') ? 'en' : (codes[0] || 'en'));
}

// Resolved locale string-map for the current UI language — for native popup
// windows (find bar, permission prompt) that must localize without their own
// i18n bundle. They receive the strings they need inside their data payload.
function uiLocaleMap() {
  const all = loadLocales();
  const lang = resolveUiLang(settingsStore.get().language);
  return all[lang] || all.en || all['pt-BR'] || {};
}

async function handlePilotApi(host, pathname, method, request) {
  const q = (new URL(request.url)).searchParams;

  // ── newtab ──────────────────────────────────────────────────────────────
  if (host === 'newtab') {
    if (method === 'GET' && pathname === '/_data/topsites') {
      const limit = clampInt(q.get('limit'), 8, 1, 24);
      return jsonResponse({ ok: true, items: historyStore.topSites(limit) });
    }
    // Brazil news feed — main fetches RSS server-side (no CORS) and
    // returns JSON. ?cat=top|brasil|mundo|tecnologia|esportes|economia|entretenimento
    if (method === 'GET' && pathname === '/_data/news') {
      const cat = (q.get('cat') || 'top').toLowerCase();
      const data = await newsFeed.getNews(cat);
      return jsonResponse(data, data.ok ? 200 : 200); // 200 always; front handles ok:false
    }
    // Home i18n: home is isolated (pilot://) and doesn't share window with shell,
    // so main delivers resolved language + string map (read locales.js).
    if (method === 'GET' && pathname === '/_data/i18n') {
      const lang = resolveUiLang(settingsStore.get().language);
      return jsonResponse({ ok: true, lang, map: loadLocales()[lang] || {} });
    }
  }

  // ── history ─────────────────────────────────────────────────────────────
  if (host === 'history') {
    if (method === 'GET' && pathname === '/_data/list') {
      const search = (q.get('q') || '').trim();
      const limit = clampInt(q.get('limit'), 300, 1, 2000);
      // query() already filters by prefix/substring and sorts by relevance; without term
      // we use recent() (sorted by last visit) — better for grouping by day.
      const items = search ? historyStore.query(search, limit) : historyStore.recent(limit);
      // normalize to { url, title, ts, visitCount }
      const norm = items.map((e) => ({
        url: e.url,
        title: e.title || '',
        ts: Number.isFinite(e.ts) ? e.ts : (Number.isFinite(e.lastVisit) ? e.lastVisit : Date.now()),
        visitCount: e.visitCount || 1,
      }));
      return jsonResponse({ ok: true, items: norm });
    }
    if (method === 'POST' && pathname === '/_action/delete') {
      const { url } = await readJsonBody(request);
      const ok = url ? historyStore.remove(url) : false;
      return jsonResponse({ ok: !!ok });
    }
    if (method === 'POST' && pathname === '/_action/clear') {
      const { range } = await readJsonBody(request);
      const valid = range === 'hour' || range === 'day' || range === 'all';
      historyStore.clear(valid ? range : 'all');
      return jsonResponse({ ok: true });
    }
  }

  // ── downloads ───────────────────────────────────────────────────────────
  if (host === 'downloads') {
    if (method === 'GET' && pathname === '/_data/list') {
      return jsonResponse({ ok: true, items: downloadsStore.list() });
    }
    if (method === 'POST' && pathname === '/_action') {
      const { id, action } = await readJsonBody(request);
      const ok = id && action ? downloadsStore.action(id, action) : false;
      return jsonResponse({ ok: !!ok });
    }
  }

  return jsonResponse({ ok: false, error: 'unknown route' }, 404);
}

/** Safe integer from query string, with default and clamp [min,max]. */
function clampInt(raw, def, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function contentType(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  if (p.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

// ── Broadcast to all windows ──────────────────────────────────────────────
function broadcast(channel, payload) {
  for (const w of windows) {
    if (!w.isDestroyed()) {
      try { w.webContents.send(channel, payload); } catch {}
    }
  }
}

// ── IPC: run autonomous agent on active tab (INTACT) ───────────────────────
ipcMain.handle('pilot:run', async (evt, { guestId, objective, vision, model }) => {
  const guest = webContents.fromId(guestId);
  if (!guest) return { success: false, result: 'Tab not found to pilot.' };

  const page = new ElectronPage(guest);
  const token = { cancelled: false };
  runs.set(guestId, token);

  try {
    // The AI answers in the browser's UI language (not a hardcoded one).
    const uiLang = resolveUiLang(settingsStore.get().language);
    const langName = {
      'pt-BR': 'Brazilian Portuguese', en: 'English', es: 'Spanish', fr: 'French',
      de: 'German', it: 'Italian', nl: 'Dutch', pl: 'Polish', ru: 'Russian',
      ja: 'Japanese', ko: 'Korean', 'zh-CN': 'Chinese',
    }[uiLang] || 'English';
    const res = await agent.run(page, objective, {
      vision: !!vision,
      model: model || undefined,
      maxSteps: 30,
      language: langName,
      onStep: (s) => {
        try { evt.sender.send('pilot:step', s); } catch {}
      },
      shouldStop: () => token.cancelled,
    });
    try { evt.sender.send('pilot:done', res); } catch {}
    return res;
  } catch (e) {
    try { evt.sender.send('pilot:error', { message: e.message }); } catch {}
    return { success: false, result: e.message };
  } finally {
    runs.delete(guestId);
    try { page.detach(); } catch {}
  }
});

ipcMain.handle('pilot:stop', (evt, { guestId }) => {
  const t = runs.get(guestId);
  if (t) t.cancelled = true;
  return true;
});

// ── Window control (multi-window via fromWebContents) ─────────────────────
ipcMain.handle('win:control', (evt, action) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return false;
  if (action === 'min') win.minimize();
  else if (action === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === 'close') win.close();
  return true;
});

ipcMain.handle('open:external', (evt, url) => {
  try { shell.openExternal(url); } catch {}
});

// ── Menu ⋮ — floating CUSTOM window (Logica identity), always above <webview> ──
// The <webview> is native browser engine layer and paints over any HTML in renderer.
// A frameless BrowserWindow is an OS window → stays on top, and we style it
// as part of the app (rounded corners, theme, shadow).
let menuPopupWin = null;
let menuPopupParent = null;

ipcMain.handle('appmenu:popup', (evt, { items, rect, dark } = {}) => {
  const parent = BrowserWindow.fromWebContents(evt.sender);
  if (!parent || !Array.isArray(items)) return false;
  if (menuPopupWin && !menuPopupWin.isDestroyed()) { menuPopupWin.close(); menuPopupWin = null; }
  menuPopupParent = parent;

  const cb = parent.getContentBounds();
  const width = 288;
  let height = 12;
  for (const it of items) height += it.sep ? 11 : (it.header ? 24 : 33);
  height = Math.max(48, Math.min(height, cb.height - 24));

  let x = Math.round(cb.x + (rect ? rect.right - width : cb.width - width - 12));
  let y = Math.round(cb.y + (rect ? rect.bottom + 6 : 88));
  x = Math.max(cb.x + 6, Math.min(x, cb.x + cb.width - width - 6));
  y = Math.max(cb.y + 6, Math.min(y, cb.y + cb.height - height - 6));

  menuPopupWin = new BrowserWindow({
    width, height, x, y,
    frame: false, resizable: false, movable: false, minimizable: false,
    maximizable: false, fullscreenable: false, skipTaskbar: true,
    hasShadow: true, roundedCorners: true, parent, show: false,
    backgroundColor: dark === false ? '#ffffff' : '#12151f',
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'menu', 'popup-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  menuPopupWin.loadFile(path.join(__dirname, 'renderer', 'menu', 'popup.html'));
  menuPopupWin.webContents.once('did-finish-load', () => {
    try {
      menuPopupWin.webContents.send('menu:data', { items, dark });
      menuPopupWin.show();
    } catch {}
  });
  menuPopupWin.on('blur', () => { if (menuPopupWin && !menuPopupWin.isDestroyed()) menuPopupWin.close(); });
  menuPopupWin.on('closed', () => { menuPopupWin = null; });
  return true;
});

ipcMain.on('appmenu:choose', (evt, action) => {
  if (menuPopupWin && !menuPopupWin.isDestroyed()) menuPopupWin.close();
  if (menuPopupParent && !menuPopupParent.isDestroyed() && action) {
    try { menuPopupParent.webContents.send('menu:action', action); } catch {}
  }
});
ipcMain.on('appmenu:close', () => {
  if (menuPopupWin && !menuPopupWin.isDestroyed()) menuPopupWin.close();
});

// ── Floating panel (Settings / About) — same OS layer as menu ⋮ ──
// Same reason as menu: <webview> is native layer and paints over any renderer HTML.
// A frameless BrowserWindow (OS window) stays on top.
// LARGER window, centered in parent. Reuses existing IPC handlers
// (theme:set, settings:get/set, search:getEngines, data:clear, app:info).
let panelWin = null;

ipcMain.handle('panel:open', (evt, { type, dark } = {}) => {
  const parent = BrowserWindow.fromWebContents(evt.sender);
  if (!parent) return false;
  if (panelWin && !panelWin.isDestroyed()) { panelWin.close(); panelWin = null; }

  const cb = parent.getContentBounds();
  const width = 560;
  const height = Math.round(Math.min(620, cb.height * 0.7));
  const x = Math.round(cb.x + (cb.width - width) / 2);
  const y = Math.round(cb.y + Math.max(24, (cb.height - height) / 2));

  panelWin = new BrowserWindow({
    width, height, x, y,
    frame: false, resizable: false, minimizable: false,
    maximizable: false, fullscreenable: false, skipTaskbar: true,
    hasShadow: true, roundedCorners: true, parent, show: false,
    backgroundColor: dark === false ? '#ffffff' : '#12151f',
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'panel', 'panel-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  panelWin.loadFile(path.join(__dirname, 'renderer', 'panel', 'panel.html'));
  panelWin.webContents.once('did-finish-load', () => {
    try {
      panelWin.webContents.send('panel:data', { type: type === 'about' ? 'about' : 'settings', dark });
      panelWin.show();
    } catch {}
  });
  panelWin.on('blur', () => { if (panelWin && !panelWin.isDestroyed()) panelWin.close(); });
  panelWin.on('closed', () => { panelWin = null; });
  return true;
});

ipcMain.on('panel:close', () => {
  if (panelWin && !panelWin.isDestroyed()) panelWin.close();
});

// ── Permission prompt — floating window (OS layer, above <webview>) ──
// The <webview> paints over any renderer HTML, so the old prompt
// (#perm-prompt) was behind it. Here the request becomes a frameless BrowserWindow
// in top-center of parent. QUEUE/TIMEOUT actually live in webview-manager
// (pendingPermissions); here we just serialize the UI: one prompt at a time. Click
// responds via webviewManager.respondPermission(requestId, granted).
// guestId of ACTIVE tab per window (fed by 'tabs:activated'). Find bar
// floating window uses this to know which <webview> to run findInPage on.
const activeGuestByWindow = new WeakMap(); // BrowserWindow -> guestId

let permPopupWin = null;
let permPopupParent = null;
const permUiQueue = []; // requests waiting for UI ({ requestId, origin, permission, dark })
let permCurrent = null; // request currently displayed

ipcMain.handle('perm:open', (evt, req = {}) => {
  const parent = BrowserWindow.fromWebContents(evt.sender);
  if (!parent || !req || !req.requestId) return false;
  // store parent window (last one to ask); prompt positions over it.
  permPopupParent = parent;
  permUiQueue.push(req);
  if (!permPopupWin) showNextPermPrompt();
  return true;
});

function showNextPermPrompt() {
  const parent = permPopupParent;
  const req = permUiQueue.shift();
  if (!req || !parent || parent.isDestroyed()) { permCurrent = null; return; }
  permCurrent = req;

  const cb = parent.getContentBounds();
  const width = Math.min(440, Math.max(320, cb.width - 48));
  const height = 56;
  const x = Math.round(cb.x + (cb.width - width) / 2);
  const y = Math.round(cb.y + 86); // just below toolbar

  permPopupWin = new BrowserWindow({
    width, height, x, y,
    frame: false, resizable: false, movable: false, minimizable: false,
    maximizable: false, fullscreenable: false, skipTaskbar: true,
    hasShadow: true, roundedCorners: true, parent, show: false,
    backgroundColor: req.dark === false ? '#ffffff' : '#12151f',
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'perm', 'perm-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  permPopupWin.loadFile(path.join(__dirname, 'renderer', 'perm', 'perm.html'));
  permPopupWin.webContents.once('did-finish-load', () => {
    try {
      const m = uiLocaleMap();
      permPopupWin.webContents.send('perm:data', {
        origin: req.origin, permission: req.permission, dark: req.dark,
        labels: {
          site: m['perm.site'], allow: m['perm.allow'], deny: m['perm.deny'], text: m['perm.text'],
          what: {
            media: m['perm.media'], geolocation: m['perm.geolocation'],
            notifications: m['perm.notifications'], generic: m['perm.generic'],
          },
        },
      });
      permPopupWin.show();
    } catch {}
  });
  // lose focus = deny (parity with Esc/closeAll of old prompt).
  permPopupWin.on('blur', () => { resolvePermPrompt(false); });
  permPopupWin.on('closed', () => { permPopupWin = null; });
}

// Respond to current request in webview-manager, close window, show next.
function resolvePermPrompt(granted) {
  const req = permCurrent;
  permCurrent = null;
  if (req) { try { webviewManager.respondPermission(req.requestId, !!granted); } catch {} }
  const w = permPopupWin;
  permPopupWin = null;
  if (w && !w.isDestroyed()) { try { w.removeAllListeners('blur'); w.close(); } catch {} }
  if (permUiQueue.length) showNextPermPrompt();
}

ipcMain.on('perm:respond', (_evt, granted) => resolvePermPrompt(!!granted));

// ── Find on page — floating window (OS layer, above <webview>) ──
// HTML findbar was behind <webview>. Here it becomes a frameless BrowserWindow
// in top-right of parent. Search runs on ACTIVE <webview> (wc.findInPage);
// result (found-in-page) is forwarded back to floating window.
let findPopupWin = null;
let findPopupParent = null;
let findActiveWc = null;       // webContents of active tab where we run search
let findFoundHandler = null;   // current found-in-page listener (to remove on close)

// Resolve webContents of active tab of find popup's parent window.
function findResolveActiveWc() {
  if (!findPopupParent || findPopupParent.isDestroyed()) return null;
  const guestId = activeGuestByWindow.get(findPopupParent);
  if (guestId == null) return null;
  try { return webContents.fromId(guestId) || null; } catch { return null; }
}

ipcMain.handle('find:open', (evt, { dark, query } = {}) => {
  const parent = BrowserWindow.fromWebContents(evt.sender);
  if (!parent) return false;
  findPopupParent = parent;

  const fm = uiLocaleMap();
  const findLabels = {
    placeholder: fm['find.placeholder'], prev: fm['find.prev'],
    next: fm['find.next'], close: fm['find.close'],
  };

  // already open: just refocus (Cmd+F repeated). Update query if a selection came.
  if (findPopupWin && !findPopupWin.isDestroyed()) {
    try { findPopupWin.webContents.send('find:data', { dark, query, labels: findLabels }); findPopupWin.focus(); } catch {}
    return true;
  }

  const cb = parent.getContentBounds();
  const width = 340;
  const height = 46;
  const x = Math.round(cb.x + cb.width - width - 16); // top-right
  const y = Math.round(cb.y + 80);

  findPopupWin = new BrowserWindow({
    width, height, x, y,
    frame: false, resizable: false, movable: false, minimizable: false,
    maximizable: false, fullscreenable: false, skipTaskbar: true,
    hasShadow: true, roundedCorners: true, parent, show: false,
    backgroundColor: dark === false ? '#ffffff' : '#12151f',
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'find', 'find-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  findPopupWin.loadFile(path.join(__dirname, 'renderer', 'find', 'find.html'));
  findPopupWin.webContents.once('did-finish-load', () => {
    try {
      findPopupWin.webContents.send('find:data', { dark, query, labels: findLabels });
      findPopupWin.show();
    } catch {}
  });
  findPopupWin.on('closed', () => {
    findStopAndUnbind();
    findPopupWin = null;
    // notify parent window that find bar closed (reset findbar.js state).
    if (findPopupParent && !findPopupParent.isDestroyed()) {
      try { findPopupParent.webContents.send('find:closed'); } catch {}
    }
  });
  return true;
});

// attach (once) found-in-page listener on active wc to forward counter.
function findBindActiveWc(wc) {
  if (findActiveWc === wc) return;
  findUnbindFound();
  findActiveWc = wc || null;
  if (!findActiveWc) return;
  findFoundHandler = (_e, result) => {
    if (findPopupWin && !findPopupWin.isDestroyed()) {
      try {
        findPopupWin.webContents.send('find:count', {
          activeMatchOrdinal: result.activeMatchOrdinal,
          matches: result.matches,
        });
      } catch {}
    }
  };
  try { findActiveWc.on('found-in-page', findFoundHandler); } catch {}
}

function findUnbindFound() {
  if (findActiveWc && findFoundHandler) {
    try { findActiveWc.removeListener('found-in-page', findFoundHandler); } catch {}
  }
  findFoundHandler = null;
}

// stop search on active tab and detach listener.
function findStopAndUnbind() {
  if (findActiveWc && !findActiveWc.isDestroyed()) {
    try { findActiveWc.stopFindInPage('clearSelection'); } catch {}
  }
  findUnbindFound();
  findActiveWc = null;
}

ipcMain.on('find:query', (_evt, { text, options } = {}) => {
  const wc = findResolveActiveWc();
  if (!wc || !text) return;
  findBindActiveWc(wc);
  try { wc.findInPage(text, options || {}); } catch {}
});

ipcMain.on('find:stopActive', () => {
  if (findActiveWc && !findActiveWc.isDestroyed()) {
    try { findActiveWc.stopFindInPage('clearSelection'); } catch {}
  }
});

ipcMain.on('find:close', () => {
  if (findPopupWin && !findPopupWin.isDestroyed()) findPopupWin.close();
  else findStopAndUnbind();
});

// ── Omnibox suggestions — non-focusable floating window (OS layer) ──────────
// HTML dropdown (#omni-suggest) was BEHIND <webview> (native browser engine layer).
// Here list becomes a frameless BrowserWindow, positioned RIGHT BELOW .address-wrap
// (rect sent by renderer) and shown with `showInactive()` — so the ADDRESS BAR of
// parent window KEEPS FOCUS and keeps handling typing/arrows/Enter/Esc. Floating
// window just DISPLAYS the list and selected index, accepts CLICK (inactive window
// still receives clicks). One per parent window. DON'T close on blur (floating never
// gets focus); closing is explicit via 'omni:close' from renderer (Esc/blur/navigate/empty).
let omniPopupWin = null;
let omniPopupParent = null;

// Calculate geometry (x/y/width/height) from .address-wrap rect.
function omniBounds(parent, rect, count) {
  const cb = parent.getContentBounds();
  const width = Math.round(rect && rect.width ? rect.width : Math.min(560, cb.width - 32));
  // height: 6px padding (3 top + 3 bottom) + ~37px per item, with ceiling.
  const n = Math.max(1, Math.min(8, count || 1));
  let height = 12 + n * 37;
  height = Math.max(46, Math.min(height, cb.height - 100));
  let x = Math.round(cb.x + (rect ? rect.x : 16));
  let y = Math.round(cb.y + (rect ? rect.bottom + 6 : 92));
  x = Math.max(cb.x + 4, Math.min(x, cb.x + cb.width - width - 4));
  y = Math.max(cb.y + 4, Math.min(y, cb.y + cb.height - height - 4));
  return { x, y, width, height };
}

ipcMain.handle('omni:open', (evt, { items, selected, rect, dark } = {}) => {
  const parent = BrowserWindow.fromWebContents(evt.sender);
  if (!parent) return false;
  omniPopupParent = parent;

  const count = Array.isArray(items) ? items.length : 0;
  if (!count) { // nothing to show → ensure closed
    if (omniPopupWin && !omniPopupWin.isDestroyed()) omniPopupWin.close();
    return false;
  }
  const b = omniBounds(parent, rect, count);

  // already open: reuse SAME window (reposition + resend data, don't recreate).
  if (omniPopupWin && !omniPopupWin.isDestroyed()) {
    try {
      omniPopupWin.setBounds(b);
      omniPopupWin.webContents.send('omni:data', { items, selected, dark });
      if (!omniPopupWin.isVisible()) omniPopupWin.showInactive();
    } catch {}
    return true;
  }

  omniPopupWin = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, resizable: false, movable: false, minimizable: false,
    maximizable: false, fullscreenable: false, skipTaskbar: true,
    focusable: false,        // NON-FOCUSABLE: never steal focus from address bar
    transparent: true, hasShadow: true, roundedCorners: true, parent, show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'omni', 'omni-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  omniPopupWin.loadFile(path.join(__dirname, 'renderer', 'omni', 'omni.html'));
  omniPopupWin.webContents.once('did-finish-load', () => {
    try {
      omniPopupWin.webContents.send('omni:data', { items, selected, dark });
      // showInactive: show WITHOUT focus → parent's address bar keeps focus.
      omniPopupWin.showInactive();
    } catch {}
  });
  // DON'T close on blur (floating never has focus). Just clear ref on destroy.
  omniPopupWin.on('closed', () => { omniPopupWin = null; });
  return true;
});

// Update items/selected without recreating window (each key/arrow). Reposition if
// rect came (address-wrap width/position may change on window resize).
ipcMain.handle('omni:update', (evt, { items, selected, rect, dark } = {}) => {
  const parent = BrowserWindow.fromWebContents(evt.sender);
  const count = Array.isArray(items) ? items.length : 0;
  if (!omniPopupWin || omniPopupWin.isDestroyed() || !count) {
    if (!count && omniPopupWin && !omniPopupWin.isDestroyed()) omniPopupWin.close();
    return false;
  }
  try {
    if (parent) omniPopupWin.setBounds(omniBounds(parent, rect, count));
    omniPopupWin.webContents.send('omni:data', { items, selected, dark });
    if (!omniPopupWin.isVisible()) omniPopupWin.showInactive();
  } catch {}
  return true;
});

ipcMain.on('omni:close', () => {
  if (omniPopupWin && !omniPopupWin.isDestroyed()) omniPopupWin.close();
});

// click on suggestion in floating window → main → renderer (chosen index).
ipcMain.on('omni:choose', (_evt, index) => {
  if (omniPopupWin && !omniPopupWin.isDestroyed()) omniPopupWin.close();
  if (omniPopupParent && !omniPopupParent.isDestroyed() && Number.isInteger(index)) {
    try { omniPopupParent.webContents.send('omni:chosen', index); } catch {}
  }
});

// ── Theme ──────────────────────────────────────────────────────────────────────
ipcMain.handle('theme:get', () => {
  return {
    source: settingsStore.get().theme, // 'light' | 'dark' | 'system'
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
  };
});

ipcMain.handle('theme:set', (evt, { mode } = {}) => {
  const valid = mode === 'light' || mode === 'dark' || mode === 'system';
  const next = valid ? mode : 'system';
  nativeTheme.themeSource = next; // 'system' | 'light' | 'dark'
  settingsStore.set({ theme: next });
  // update backgroundColor of all windows (kill flash on resize)
  const dark = applyWindowBackground();
  return { shouldUseDarkColors: dark };
});

// ── Settings ────────────────────────────────────────────────────────────
ipcMain.handle('settings:get', () => settingsStore.get());
ipcMain.handle('settings:set', (evt, patch) => {
  const next = settingsStore.set(patch || {});
  // if AI key changed, reconfigure Pilot's brain on the fly.
  if (patch && 'aiApiKey' in patch) { try { llm.configure({ apiKey: next.aiApiKey }); } catch {} }
  // if ad-block toggled, apply live to the webviews' session + sync the shield.
  if (patch && 'adBlock' in patch) { try { adblockManager.setEnabled(next.adBlock); broadcastAdblockState(); } catch {} }
  // propagate to ALL shell windows (Settings floating panel is separate window;
  // without this open shell would have stale searchEngine/homepage/theme).
  try { broadcast('settings:changed', settingsStore.get()); } catch {}
  return next;
});

// ── Ad-block (toolbar shield + anchored panel) ──────────────────────────────────
let adblockPanelWin = null;
let adblockPanelCtx = null;

function broadcastAdblockState() {
  const st = {
    available: adblockManager.isAvailable(),
    enabled: adblockManager.isEnabled(),
    count: adblockManager.getCount(),
  };
  try { broadcast('adblock:state', st); } catch {}
  return st;
}
// http(s) hostname of a tab (for the per-site allow toggle); internal pages → null.
function adblockHostOf(guestId) {
  try {
    const wc = guestId != null ? webContents.fromId(guestId) : null;
    if (!wc) return null;
    const u = new URL(wc.getURL());
    return /^https?:$/.test(u.protocol) ? u.hostname : null;
  } catch { return null; }
}
function adblockLabels() {
  const lang = resolveUiLang(settingsStore.get().language);
  const m = loadLocales()[lang] || {};
  const pick = (k, fb) => (m[k] != null ? m[k] : fb);
  return {
    title: pick('adblock.title', 'Ad blocker'),
    master: pick('settings.adblock', 'Block ads and trackers'),
    here: pick('adblock.blockedHere', 'Blocked on this page'),
    total: pick('adblock.blockedTotal', '{n} blocked in total'),
    allow: pick('adblock.allowSite', 'Allow ads on this site'),
    lists: pick('adblock.listsLabel', 'Filter lists'),
  };
}
function adblockPanelData(extra) {
  const ctx = adblockPanelCtx || {};
  return Object.assign({ labels: adblockLabels() }, extra || {}, adblockManager.getStats(ctx.host, ctx.guestId));
}

ipcMain.handle('adblock:get', () => ({
  available: adblockManager.isAvailable(),
  enabled: adblockManager.isEnabled(),
  count: adblockManager.getCount(),
}));
ipcMain.handle('adblock:toggle', () => {
  const enabled = adblockManager.setEnabled(!adblockManager.isEnabled());
  try { settingsStore.set({ adBlock: enabled }); } catch {}
  try { broadcast('settings:changed', settingsStore.get()); } catch {}
  broadcastAdblockState();
  return { enabled, count: adblockManager.getCount() };
});
ipcMain.handle('adblock:panel-data', () => adblockPanelData());
ipcMain.handle('adblock:setAllowlist', (evt, { host, allowed } = {}) => {
  adblockManager.setAllowed(host, allowed);
  return adblockPanelData();
});
ipcMain.on('adblock:reload-active', () => {
  const gid = adblockPanelCtx && adblockPanelCtx.guestId;
  if (gid != null) { try { const wc = webContents.fromId(gid); if (wc) wc.reload(); } catch {} }
});
ipcMain.on('adblock:panel-close', () => {
  if (adblockPanelWin && !adblockPanelWin.isDestroyed()) adblockPanelWin.close();
});

// Anchored floating panel under the 🛡️ shield (clones the appmenu:popup pattern —
// the shell sits behind the <webview>, so the panel must be a native window).
ipcMain.handle('adblock:panel', (evt, { rect, dark } = {}) => {
  const parent = BrowserWindow.fromWebContents(evt.sender);
  if (!parent) return false;
  if (adblockPanelWin && !adblockPanelWin.isDestroyed()) { adblockPanelWin.close(); adblockPanelWin = null; }

  const guestId = activeGuestByWindow.get(parent);
  adblockPanelCtx = { host: adblockHostOf(guestId), guestId, parent };

  const cb = parent.getContentBounds();
  const width = 300;
  const height = 236;
  let x = Math.round(cb.x + (rect ? rect.right - width : cb.width - width - 12));
  let y = Math.round(cb.y + (rect ? rect.bottom + 6 : 88));
  x = Math.max(cb.x + 6, Math.min(x, cb.x + cb.width - width - 6));
  y = Math.max(cb.y + 6, Math.min(y, cb.y + cb.height - height - 6));

  adblockPanelWin = new BrowserWindow({
    width, height, x, y,
    frame: false, resizable: false, movable: false, minimizable: false,
    maximizable: false, fullscreenable: false, skipTaskbar: true,
    hasShadow: true, roundedCorners: true, parent, show: false,
    backgroundColor: dark === false ? '#ffffff' : '#12151f',
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'adblock', 'adblock-preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  adblockPanelWin.loadFile(path.join(__dirname, 'renderer', 'adblock', 'adblock.html'));
  adblockPanelWin.webContents.once('did-finish-load', () => {
    try {
      adblockPanelWin.webContents.send('adblock:panel-data', adblockPanelData({ dark: dark !== false }));
      adblockPanelWin.show();
    } catch {}
  });
  adblockPanelWin.on('blur', () => { if (adblockPanelWin && !adblockPanelWin.isDestroyed()) adblockPanelWin.close(); });
  adblockPanelWin.on('closed', () => { adblockPanelWin = null; });
  return true;
});

// ── About / versions ───────────────────────────────────────────────────────────
ipcMain.handle('app:info', () => ({
  appVersion: pkg.version,
  chrome: process.versions.chrome,
  electron: process.versions.electron,
  v8: process.versions.v8,
  node: process.versions.node,
}));

// ── New window / incognito ─────────────────────────────────────────────────────
ipcMain.handle('win:new', (evt, opts = {}) => {
  createWindow({ incognito: !!(opts && opts.incognito) });
});

// ── Clear navigation data ─────────────────────────────────────────────────
ipcMain.handle('data:clear', async () => {
  try {
    const ses = session.fromPartition(PARTITION);
    await ses.clearStorageData();
    await ses.clearCache();
    historyStore.clear('all');
    return true;
  } catch {
    return false;
  }
});

// ── History ───────────────────────────────────────────────────────────────
ipcMain.on('history:add', (evt, entry) => {
  try { historyStore.add(entry || {}); } catch {}
});
ipcMain.on('history:updateTitle', (evt, { url, title } = {}) => {
  try { historyStore.updateTitle(url, title); } catch {}
});
ipcMain.handle('history:query', (evt, { prefix, limit } = {}) =>
  historyStore.query(prefix, limit),
);
ipcMain.handle('history:topSites', (evt, { limit } = {}) => historyStore.topSites(limit));
ipcMain.handle('history:recent', (evt, { limit } = {}) => historyStore.recent(limit));
ipcMain.handle('history:clear', (evt, { range } = {}) => historyStore.clear(range || 'all'));

// ── Downloads ───────────────────────────────────────────────────────────
ipcMain.handle('downloads:list', () => downloadsStore.list());
ipcMain.handle('downloads:action', (evt, { id, action } = {}) =>
  downloadsStore.action(id, action),
);

// ── Permissions ─────────────────────────────────────────────────────────
ipcMain.handle('permission:respond', (evt, { requestId, granted } = {}) =>
  webviewManager.respondPermission(requestId, !!granted),
);

// ── Print active tab ─────────────────────────────────────────────────────
ipcMain.handle('print:start', (evt, { guestId } = {}) => {
  const wc = webContents.fromId(guestId);
  if (!wc) return false;
  try {
    wc.print({});
    return true;
  } catch {
    return false;
  }
});

// ── Page DevTools — exclusive CDP guard ─────────────────────────────
ipcMain.handle('devtools:open', (evt, { guestId } = {}) => {
  // Pilot uses CDP (debugger) on this webContents. DevTools is a 2nd CDP consumer
  // → conflict. Reject if run is active.
  if (runs.has(guestId)) return { ok: false, reason: 'pilot-running' };
  const wc = webContents.fromId(guestId);
  if (!wc) return { ok: false, reason: 'not-found' };
  try {
    wc.openDevTools({ mode: 'detach' });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

// ── Catalog of search engines ──────────────────────────────────────────────
ipcMain.handle('search:getEngines', () => searchEngines.getEngines());

// ── Bookmarks (bookmarks) ─────────────────────────────────────────────────
// IPC convention: renderer sends OBJECT; preload is pass-through; here
// we destructure object. All mutations are broadcast to windows so they react
// (bar + star synced in multi-window).
ipcMain.handle('bookmarks:list', () => bookmarksStore.list());
ipcMain.handle('bookmarks:isBookmarked', (evt, { url } = {}) =>
  bookmarksStore.isBookmarked(url),
);
ipcMain.handle('bookmarks:add', (evt, { url, title, favicon } = {}) => {
  const rec = bookmarksStore.add({ url, title, favicon });
  broadcast('bookmarks:changed', { reason: 'add', url });
  return rec;
});
ipcMain.handle('bookmarks:remove', (evt, { url } = {}) => {
  const ok = bookmarksStore.remove(url);
  broadcast('bookmarks:changed', { reason: 'remove', url });
  return ok;
});
ipcMain.handle('bookmarks:toggle', (evt, { url, title, favicon } = {}) => {
  const res = bookmarksStore.toggle({ url, title, favicon });
  broadcast('bookmarks:changed', { reason: 'toggle', url, bookmarked: res.bookmarked });
  return res;
});
ipcMain.handle('bookmarks:update', (evt, { url, patch } = {}) => {
  const rec = bookmarksStore.update(url, patch || {});
  broadcast('bookmarks:changed', { reason: 'update', url });
  return rec;
});

// ── Find-in-page via IPC (backup; bar lives in renderer in standard flow) ─
ipcMain.handle('find:start', (evt, { guestId, text, options } = {}) => {
  const wc = webContents.fromId(guestId);
  if (!wc || !text) return { requestId: null };
  try {
    const requestId = wc.findInPage(text, options || {});
    return { requestId };
  } catch {
    return { requestId: null };
  }
});
ipcMain.handle('find:stop', (evt, { guestId, action } = {}) => {
  const wc = webContents.fromId(guestId);
  if (!wc) return;
  try { wc.stopFindInPage(action === 'keepSelection' ? 'keepSelection' : 'clearSelection'); } catch {}
});

// ── Chrome extensions ───────────────────────────────────────────────────────
// Renderer owns <webview>. When extension calls chrome.tabs.create,
// extensions-manager asks renderer to create tab (channel 'ext:createTab') and
// renderer responds here with new webview's guestId.
ipcMain.on('ext:tabCreated', (evt, { reqId, guestId } = {}) => {
  try { extensionsManager.resolveTabCreate(reqId, guestId); } catch {}
});

// Active tab changed in renderer → notify extensions system (selectTab) and
// register active tab's guestId PER WINDOW (floating find bar needs to know
// which <webview> to run findInPage on). Map declared above (activeGuestByWindow),
// before find bar window handlers.
ipcMain.on('tabs:activated', (evt, { guestId } = {}) => {
  try { extensionsManager.activateTab(guestId); } catch {}
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (win && guestId != null) activeGuestByWindow.set(win, guestId);
});

// "Extensions" button / menu item → open Chrome Web Store in a tab.
ipcMain.handle('ext:open', (evt, { target } = {}) => {
  const url = target === 'manage'
    ? 'https://chromewebstore.google.com/category/extensions'
    : 'https://chromewebstore.google.com/';
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('tab:open', { url, background: false }); } catch {}
  }
  return { ok: true, url };
});

// Install unpacked extension from folder (path that ALWAYS works,
// independent of Web Store detecting the browser). Opens folder picker.
ipcMain.handle('ext:install-unpacked', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  let res;
  try {
    res = await dialog.showOpenDialog(win || undefined, {
      title: 'Choose extension folder (with manifest.json)',
      properties: ['openDirectory'],
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
  try {
    const ext = await extensionsManager.loadUnpacked(res.filePaths[0]);
    const name = (ext && ext.name) || 'extension';
    try {
      dialog.showMessageBox(win || undefined, {
        type: 'info', title: 'Logica Pilot',
        message: 'Extension installed', detail: name + ' is active. Icon appears in extension bar.',
      });
    } catch {}
    return { ok: true, name, id: ext && ext.id };
  } catch (e) {
    try {
      dialog.showMessageBox(win || undefined, {
        type: 'error', title: 'Logica Pilot',
        message: 'Could not install extension', detail: e.message,
      });
    } catch {}
    return { ok: false, error: e.message };
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // 1x userData migration: app ran without name ("Electron"), so data
  // (installed extensions, history, bookmarks, settings, cookies of partition)
  // ended up in .../Electron. Now that name is "Logica Pilot", userData points to
  // .../Logica Pilot — rename old dir to not lose anything. rename is instant
  // (same volume) and runs BEFORE any store/extension reads path.
  try {
    const appData = app.getPath('appData');
    const newUD = path.join(appData, 'Logica Pilot');
    const oldUD = path.join(appData, 'Electron');
    // marker proving it's OUR data (not another unnamed Electron app): the
    // partition persist:logica-pilot. Electron already creates new dir (cache/cookies)
    // before here, so we copy only our items that don't yet exist in new
    // (rename would fail: new dir already exists).
    const ours = fs.existsSync(path.join(oldUD, 'Partitions', 'logica-pilot'));
    if (oldUD !== newUD && ours) {
      const items = ['settings.json', 'history.json', 'bookmarks.json', 'downloads.json',
        'extensions', 'Partitions', 'Local Storage', 'Cookies'];
      let migrated = 0;
      for (const it of items) {
        const src = path.join(oldUD, it);
        const dst = path.join(newUD, it);
        try {
          if (fs.existsSync(src) && !fs.existsSync(dst)) { fs.cpSync(src, dst, { recursive: true }); migrated++; }
        } catch {}
      }
      if (migrated) console.log('[name] userData migrated (Electron → Logica Pilot):', migrated, 'items');
    }
  } catch (e) {
    console.warn('[name] userData migration failed (continuing with new dir):', e && e.message);
  }

  // Stores (need app.getPath, only available after whenReady).
  const userData = app.getPath('userData');
  settingsStore.init(userData);
  // inject AI key (from user settings) into Pilot's brain — enables
  // Pilot out-of-the-box (Anthropic direct) when no local LogicaProxy.
  try { llm.configure({ apiKey: settingsStore.get().aiApiKey }); } catch {}
  historyStore.init(userData);
  downloadsStore.init(userData, shell);
  bookmarksStore.init(userData);

  // Apply persisted theme to nativeTheme.
  try { nativeTheme.themeSource = settingsStore.get().theme; } catch {}

  // Wire up webview-manager dependencies (send to host, downloads, search).
  webviewManager.configure({
    sendToHost: (win, channel, payload) => {
      if (win && !win.isDestroyed()) {
        try { win.webContents.send(channel, payload); } catch {}
      }
    },
    broadcast,
    registerDownload: (item, emit) => downloadsStore.register(item, emit),
    getSearchEngine: () => settingsStore.get().searchEngine,
    buildSearchUrl: (id, q) => searchEngines.buildSearchUrl(id, q),
    // extensions system: webview-manager calls addTab(wc, win) in equip()
    extensions: extensionsManager,
  });

  // Chrome extensions: configure bridge (renderer owns webviews) and
  // initialize in partition session. Best-effort — failure doesn't kill browser.
  extensionsManager.configure({
    sendToWindow: (win, channel, payload) => {
      if (win && !win.isDestroyed()) {
        try { win.webContents.send(channel, payload); } catch {}
      }
    },
    getActiveWindow,
    createBrowserWindow: (opts = {}) => createWindow({ initialUrl: opts.url }),
  });
  extensionsManager
    .init(session.fromPartition(PARTITION), userData)
    .then((ex) => { if (ex) console.log('[ext] extensions system ready'); })
    .catch((e) => console.error('[ext] init failed:', e && e.message));

  // Native ad & tracker blocking (EasyList + EasyPrivacy) on the webviews' session.
  // Reliable where MV3 extensions are not. Best-effort — failure doesn't kill browser.
  adblockManager
    .init(session.fromPartition(PARTITION), {
      enabled: settingsStore.get().adBlock,
      userDataDir: userData,
      initialAllowlist: settingsStore.get().adBlockAllowlist || [],
      saveAllowlist: (arr) => { try { settingsStore.set({ adBlockAllowlist: arr }); } catch {} },
      updatedAt: settingsStore.get().adBlockUpdatedAt || 0,
      saveUpdatedAt: (ts) => { try { settingsStore.set({ adBlockUpdatedAt: ts }); } catch {} },
    })
    .then((b) => { if (b) console.log('[adblock] ready · enabled=', adblockManager.isEnabled()); })
    .catch((e) => console.error('[adblock] init failed:', e && e.message));
  // Push blocked-count updates to the toolbar badge.
  adblockManager.onCount((count) => broadcast('adblock:count', { count }));

  registerPilotProtocol();
  registerViewIpc(); // Phase 1: view:* handlers (inert with flag OFF)

  // Native Application Menu (accelerators work over <webview>).
  Menu.setApplicationMenu(buildMenu(getActiveWindow));

  // nativeTheme changed (OS switched scheme) → reevaluate 'system' in renderer.
  nativeTheme.on('updated', () => {
    // only reapply native color if effective choice is 'system' (on light/dark
    // fixed the OS doesn't affect color — reapplying would regress a fixed-mode window).
    let choice = 'system';
    try { choice = settingsStore.get().theme; } catch {}
    if (choice === 'system') applyWindowBackground();
    broadcast('theme:native-updated', { shouldUseDarkColors: nativeTheme.shouldUseDarkColors });
  });

  createWindow();
});

/** Active window for menu (focused) or first available.
 *  If a FLOATING window (menu ⋮ / panel) is focused, route to parent —
 *  else native menu bar actions would land in a window with no listener. */
function getActiveWindow() {
  const f = BrowserWindow.getFocusedWindow();
  if (f && windows.has(f)) return f;
  if (f && typeof f.getParentWindow === 'function') {
    const p = f.getParentWindow();
    if (p && windows.has(p)) return p;
  }
  return [...windows][0] || null;
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Persist stores on exit (immediate flush of debounces).
app.on('before-quit', () => {
  try { settingsStore.flush(); } catch {}
  try { historyStore.flush(); } catch {}
  try { downloadsStore.flush(); } catch {}
  try { bookmarksStore.flush(); } catch {}
});
