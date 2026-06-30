'use strict';

/**
 * main.js — Processo principal do BROWSER Logica Pilot (Electron = Chromium real).
 *
 * A janela é um browser de verdade: cada aba é um <webview> (Chromium). Quando o
 * usuário pede uma tarefa, o main anexa o `webContents.debugger` (CDP) na aba ativa
 * e roda o MESMO motor autônomo do modo headless. A IA tem controle total.
 *
 * Este arquivo é a PONTE: registra protocolo pilot://, Application Menu nativo,
 * tema (nativeTheme), stores (history/downloads/settings) e TODOS os handlers IPC
 * da casca. As webviews são equipadas pelo webview-manager via did-attach-webview.
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
const perception = require('../src/perception');
const actions = require('../src/actions');

const webviewManager = require('./main/webview-manager');
const extensionsManager = require('./main/extensions-manager');
const { buildMenu } = require('./main/menu');
const historyStore = require('./main/history-store');
const downloadsStore = require('./main/downloads-store');
const settingsStore = require('./main/settings');
const searchEngines = require('./main/search-engines');
const bookmarksStore = require('./main/bookmarks-store');
const newsFeed = require('./main/news');
const { createRegistry } = require('./main/view-registry');

const pkg = require('../package.json');

// Migração <webview> → WebContentsView (Fase 1). Atrás de flag: OFF (default) = o
// caminho atual com <webview>; ON = páginas geridas pelo main via view-registry.
// Permite coexistência e rollback instantâneo durante a migração.
const WCV_ENABLED = process.env.LOGICA_PILOT_WCV === '1';

// ── Guarda anti-crash do processo principal ─────────────────────────────────
// Bug conhecido da electron-chrome-extensions@4.1.1: em navegação rápida o frame
// é descartado ANTES do handler onBeforeNavigate acessar o WebFrameMain, lançando
// "Render frame was disposed before WebFrameMain could be accessed" como exceção
// NÃO-capturada → o Electron derruba o app inteiro (diálogo "A JavaScript error…").
// É uma corrida benigna (o frame já morreu; nada a fazer). Engolimos SÓ esse erro
// e seguimos vivos; qualquer outra exceção continua sendo logada para diagnóstico.
process.on('uncaughtException', (err) => {
  const msg = String((err && err.message) || err);
  if (
    /Render frame was disposed before WebFrameMain could be accessed/i.test(msg) ||
    /WebFrameMain could be accessed/i.test(msg)
  ) {
    console.warn('[safe] frame descartado durante navegação (ignorado):', msg);
    return;
  }
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// flags Chromium úteis (não-fatais se ignoradas)
app.commandLine.appendSwitch('disable-features', 'AutomationControlled');

// Apresentar como Google Chrome: UA limpo (sem "Electron/Logica Pilot") pra sites
// não quebrarem E pra a Chrome Web Store reconhecer o browser (some o aviso
// "mude para o Chrome"). A instalação real é programática (installExtension),
// mas o UA limpo deixa a loja amigável.
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

// Hosts pilot:// que servem páginas internas (cada um mapeia para app/renderer/<host>/).
// O default de cada host é <host>.html (ex.: pilot://history → history/history.html).
const PILOT_HOSTS = {
  newtab: { dir: NEWTAB_DIR, index: 'newtab.html' },
  history: { dir: path.join(RENDERER_DIR, 'history'), index: 'history.html' },
  downloads: { dir: path.join(RENDERER_DIR, 'downloads'), index: 'downloads.html' },
};

// Multi-janela: substitui o singleton 'win' por um Set.
const windows = new Set();
const runs = new Map(); // guestId -> { cancelled }

// ── Protocolo pilot:// — registrar privilégios ANTES do app.whenReady ─────────
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pilot',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

// Área de conteúdo (onde a WebContentsView ativa aparece): abaixo da titlebar
// (tab strip) + toolbar. É um FALLBACK; a casca reporta o retângulo exato do
// container #views via IPC 'view:layout' (cobre painel Pilot, barra de favoritos…).
function computeContentBounds(win) {
  const [w, h] = win.getContentSize();
  const TOP = 84; // ~ tab strip + toolbar
  return { x: 0, y: TOP, width: w, height: Math.max(0, h - TOP) };
}

// IPC da Fase 1: a casca comanda as views por tabId; executa no registry da JANELA
// do emissor. Inerte se a janela não tem registry (flag OFF). Registrado 1x.
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
  // a casca reporta o retângulo exato da área de conteúdo (resize/painel/favoritos)
  ipcMain.on('view:layout', (e, bounds) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    win._lpContentBounds = bounds;
    if (win._lpRegistry) win._lpRegistry.layout();
  });
}

// ── Criação de janela ─────────────────────────────────────────────────────────
function createWindow(opts = {}) {
  const smoke = !!process.env.LOGICA_PILOT_SMOKE;
  const uitest = !!process.env.LOGICA_PILOT_UITEST;
  const headless = smoke || uitest;

  // backgroundColor inicial pelo tema (mata flash branco/preto no boot/resize).
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

  // Equipa cada <webview> assim que ela anexa (downloads/context-menu/popups/find).
  win.webContents.on('did-attach-webview', (_e, wc) => {
    webviewManager.equip(wc, win);
  });

  // ── Fase 1 (flag LOGICA_PILOT_WCV): páginas como WebContentsView geridas pelo
  // main. Inerte com a flag OFF — o renderer segue criando <webview>. ON: o main
  // cria/posiciona/troca as views; o renderer vira controle remoto via IPC view:*.
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
    // janela única para o smoke, sem UI
    runSmoke(win).catch((e) => {
      console.error('[SMOKE] erro inesperado:', e);
      app.exit(1);
    });
    return win;
  }

  if (uitest) {
    // carrega o renderer REAL (sem GUI) e reporta erros de console/boot
    runUiTest(win).catch((e) => {
      console.error('[UITEST] erro inesperado:', e);
      app.exit(1);
    });
    return win;
  }

  // Modo anônimo: passa a partition in-memory via query (renderer escolhe).
  // initialUrl: usado por chrome.windows.create({url}) das extensões — o renderer
  // abre uma aba nessa URL ao montar (senão a janela abriria em branco/newtab).
  const query = {};
  if (opts.incognito) query.incognito = '1';
  if (opts.initialUrl && /^(https?|pilot|file|about):/i.test(opts.initialUrl)) {
    query.initialUrl = opts.initialUrl;
  }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query });

  if (process.env.LOGICA_PILOT_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });

  // força a janela pra frente (garante que o Arquiteto veja a NOVA, não uma velha)
  win.once('ready-to-show', () => { try { win.show(); win.focus(); win.moveTop(); } catch {} });

  return win;
}

/** Decide tema escuro a partir das settings + nativeTheme. */
function resolveDark() {
  try {
    const mode = settingsStore.get().theme;
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
  } catch {}
  return nativeTheme.shouldUseDarkColors;
}

/** Reaplica o backgroundColor nativo de todas as janelas (mata flash no resize). */
function applyWindowBackground() {
  const bg = nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#f1f3f4';
  for (const w of windows) {
    if (!w.isDestroyed()) {
      try { w.setBackgroundColor(bg); } catch {}
    }
  }
  return nativeTheme.shouldUseDarkColors;
}

// ── Self-test sem GUI: prova o caminho Electron(Chromium) + CDP + percepção ──
async function runSmoke(win) {
  const url = argValue('--url') || 'https://example.com';
  try {
    const page = new ElectronPage(win.webContents);
    console.log('[SMOKE] navegando para', url);
    await page.goto(url);
    const snap = await perception.snapshot(page);
    console.log(`[SMOKE] título="${snap.title}" elementos=${snap.elements.length}`);
    console.log('[SMOKE] mapa (trecho):');
    console.log(perception.format(snap).split('\n').slice(0, 10).join('\n'));
    const shot = await actions.screenshot(page);
    console.log(`[SMOKE] screenshot OK (${Math.round(shot.length / 1024)}KB base64)`);
    console.log('[SMOKE] PASS ✅ — Chromium real dirigido via CDP do Electron.');
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

// ── Teste de UI headless: carrega index.html real e caça erros de boot ──────────
async function runUiTest(win) {
  const errors = [];
  const warnings = [];

  win.webContents.on('console-message', (...a) => {
    // Electron <=33: (event, level, message, line, sourceId)
    // Electron novo: (event{level,message,lineNumber,sourceId})
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

  // diagnóstico do FEED — pega o webContents do GUEST (home pilot://newtab) direto
  // e faz o fetch da rota DENTRO do contexto/partition da home.
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

  // diagnóstico do menu ⋮ — simula o clique e reporta o estado
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

// ── Protocolo pilot:// → start page + páginas internas (history/downloads) ────
//
// Cada página pilot:// roda num <webview> ISOLADO, sem window.pilot. Para falar com
// o main ela usa fetch() de mesma origem (supportFetchAPI liga isso). Três tipos:
//   • assets estáticos  → pilot://<host>/<arquivo>      (lê do dir do host)
//   • rotas de DADOS     → GET  pilot://<host>/_data/... (retornam JSON dos stores)
//   • rotas de AÇÃO      → POST pilot://<host>/_action/.. (executam no main, {ok})
// _data/_action NÃO tocam disco — são despachadas antes da resolução de arquivo.
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

    // ── rotas dinâmicas (data/action) — antes de qualquer leitura de arquivo ──
    if (pathname.startsWith('/_data/') || pathname.startsWith('/_action/')) {
      try {
        return await handlePilotApi(host, pathname, method, request);
      } catch (e) {
        return jsonResponse({ ok: false, error: String(e && e.message || e) }, 500);
      }
    }

    // ── assets estáticos ──
    const entry = PILOT_HOSTS[host];
    if (!entry) return new Response('Not Found', { status: 404 });
    const rel = pathname === '/' || pathname === '' ? entry.index : pathname.replace(/^\/+/, '');
    const baseDir = entry.dir;
    const resolved = path.normalize(path.join(baseDir, rel));
    // trava de path traversal: precisa ficar DENTRO do dir do host (separador incluso)
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

  // Sessão DEFAULT — cobre navegações pilot:// app-wide.
  protocol.handle('pilot', pilotProtocolHandler);

  // Sessão da PARTITION dos webviews — CRÍTICO p/ o feed. O handle global serve a
  // sessão default, mas o fetch() de DENTRO do webview roda na partition
  // persist:logica-pilot; sem o handler registrado NAQUELA sessão, o fetch dava erro
  // de rede opaco (era o bug do feed "não consegui carregar"). Provado no harness
  // exp-registry: pilot://_data/news → FEED-OK numa WebContentsView dessa sessão.
  try {
    session.fromPartition('persist:logica-pilot').protocol.handle('pilot', pilotProtocolHandler);
  } catch (e) {
    console.warn('[pilot://] registro na sessão da partition falhou:', e && e.message);
  }
}

/** Lê o corpo JSON de um request POST (tolerante a corpo vazio/ inválido). */
async function readJsonBody(request) {
  try { return (await request.json()) || {}; } catch { return {}; }
}

/**
 * Despacha rotas pilot://<host>/_data/... (GET) e /_action/... (POST).
 * Retorna sempre uma Response JSON. Erros viram {ok:false}.
 */
async function handlePilotApi(host, pathname, method, request) {
  const q = (new URL(request.url)).searchParams;

  // ── newtab ──────────────────────────────────────────────────────────────
  if (host === 'newtab') {
    if (method === 'GET' && pathname === '/_data/topsites') {
      const limit = clampInt(q.get('limit'), 8, 1, 24);
      return jsonResponse({ ok: true, items: historyStore.topSites(limit) });
    }
    // Feed de notícias PT-BR/Brasil — o main busca RSS server-side (sem CORS) e
    // devolve JSON. ?cat=top|brasil|mundo|tecnologia|esportes|economia|entretenimento
    if (method === 'GET' && pathname === '/_data/news') {
      const cat = (q.get('cat') || 'top').toLowerCase();
      const data = await newsFeed.getNews(cat);
      return jsonResponse(data, data.ok ? 200 : 200); // 200 sempre; o front trata ok:false
    }
  }

  // ── history ─────────────────────────────────────────────────────────────
  if (host === 'history') {
    if (method === 'GET' && pathname === '/_data/list') {
      const search = (q.get('q') || '').trim();
      const limit = clampInt(q.get('limit'), 300, 1, 2000);
      // query() já filtra por prefixo/substring e ordena por relevância; sem termo
      // usamos recent() (ordenado por última visita) — melhor p/ agrupar por dia.
      const items = search ? historyStore.query(search, limit) : historyStore.recent(limit);
      // normaliza para { url, title, ts, visitCount }
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

  return jsonResponse({ ok: false, error: 'rota desconhecida' }, 404);
}

/** Inteiro seguro a partir de query string, com default e clamp [min,max]. */
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

// ── Broadcast a todas as janelas ──────────────────────────────────────────────
function broadcast(channel, payload) {
  for (const w of windows) {
    if (!w.isDestroyed()) {
      try { w.webContents.send(channel, payload); } catch {}
    }
  }
}

// ── IPC: rodar o agente autônomo na aba ativa (INTACTO) ───────────────────────
ipcMain.handle('pilot:run', async (evt, { guestId, objective, vision, model }) => {
  const guest = webContents.fromId(guestId);
  if (!guest) return { success: false, result: 'Aba não encontrada para pilotar.' };

  const page = new ElectronPage(guest);
  const token = { cancelled: false };
  runs.set(guestId, token);

  try {
    const res = await agent.run(page, objective, {
      vision: !!vision,
      model: model || undefined,
      maxSteps: 30,
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

// ── Controle de janela (multi-janela via fromWebContents) ─────────────────────
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

// ── Menu ⋮ — janela flutuante CUSTOM (identidade Logica), sempre acima do <webview> ──
// O <webview> é camada nativa do Chromium e pinta sobre qualquer HTML do renderer.
// Uma BrowserWindow sem moldura é uma janela do SO → fica acima, e a estilizamos
// como parte do app (cantos arredondados, tema, sombra).
let menuPopupWin = null;
let menuPopupParent = null;

ipcMain.handle('appmenu:popup', (evt, { items, rect, dark } = {}) => {
  const parent = BrowserWindow.fromWebContents(evt.sender);
  if (!parent || !Array.isArray(items)) return false;
  if (menuPopupWin && !menuPopupWin.isDestroyed()) { menuPopupWin.close(); menuPopupWin = null; }
  menuPopupParent = parent;

  const cb = parent.getContentBounds();
  const width = 270;
  let height = 12;
  for (const it of items) height += it.sep ? 11 : 33;
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

// ── Painel flutuante (Configurações / Sobre) — mesma camada do SO do menu ⋮ ──
// Mesmo motivo do menu: o <webview> é camada nativa e pinta acima de qualquer
// HTML do renderer. Uma BrowserWindow sem moldura (janela do SO) fica acima.
// Janela MAIOR, centralizada na parent. Reusa os handlers IPC já existentes
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

// ── Prompt de permissão — janela flutuante (camada do SO, acima do <webview>) ──
// O <webview> pinta acima de qualquer HTML do renderer, então o prompt antigo
// (#perm-prompt) ficava atrás dele. Aqui o pedido vira uma BrowserWindow sem
// moldura no topo-centro da mãe. A FILA/TIMEOUT de fato vivem no webview-manager
// (pendingPermissions); aqui só serializamos a UI: um prompt por vez. O clique
// responde via webviewManager.respondPermission(requestId, granted).
// guestId da aba ATIVA por janela (alimentado por 'tabs:activated'). A janela de
// localizar flutuante usa isto p/ saber em qual <webview> rodar findInPage.
const activeGuestByWindow = new WeakMap(); // BrowserWindow -> guestId

let permPopupWin = null;
let permPopupParent = null;
const permUiQueue = []; // pedidos aguardando a UI ({ requestId, origin, permission, dark })
let permCurrent = null; // pedido atualmente exibido

ipcMain.handle('perm:open', (evt, req = {}) => {
  const parent = BrowserWindow.fromWebContents(evt.sender);
  if (!parent || !req || !req.requestId) return false;
  // guarda a janela-mãe (a última que pediu); o prompt posiciona-se sobre ela.
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
  const y = Math.round(cb.y + 86); // logo abaixo da toolbar

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
      permPopupWin.webContents.send('perm:data', {
        origin: req.origin, permission: req.permission, dark: req.dark,
      });
      permPopupWin.show();
    } catch {}
  });
  // perder o foco = negar (paridade com Esc/closeAll do prompt antigo).
  permPopupWin.on('blur', () => { resolvePermPrompt(false); });
  permPopupWin.on('closed', () => { permPopupWin = null; });
}

// Responde o pedido atual no webview-manager, fecha a janela e mostra o próximo.
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

// ── Localizar na página — janela flutuante (camada do SO, acima do <webview>) ──
// O findbar HTML ficava atrás do <webview>. Aqui vira uma BrowserWindow sem
// moldura no topo-direito da mãe. A busca roda na <webview> ATIVA (wc.findInPage);
// o resultado (found-in-page) é encaminhado de volta à janela flutuante.
let findPopupWin = null;
let findPopupParent = null;
let findActiveWc = null;       // webContents da aba ativa onde rodamos a busca
let findFoundHandler = null;   // listener de found-in-page atual (p/ remover ao fechar)

// Resolve o webContents da aba ativa da janela-mãe do find.
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

  // já aberta: só refoca (⌘F repetido). Atualiza a query se veio uma seleção.
  if (findPopupWin && !findPopupWin.isDestroyed()) {
    try { findPopupWin.webContents.send('find:data', { dark, query }); findPopupWin.focus(); } catch {}
    return true;
  }

  const cb = parent.getContentBounds();
  const width = 340;
  const height = 46;
  const x = Math.round(cb.x + cb.width - width - 16); // topo-direito
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
      findPopupWin.webContents.send('find:data', { dark, query });
      findPopupWin.show();
    } catch {}
  });
  findPopupWin.on('closed', () => {
    findStopAndUnbind();
    findPopupWin = null;
    // avisa a janela-mãe que a barra fechou (reseta o estado do findbar.js).
    if (findPopupParent && !findPopupParent.isDestroyed()) {
      try { findPopupParent.webContents.send('find:closed'); } catch {}
    }
  });
  return true;
});

// liga (uma vez) o listener de found-in-page no wc ativo p/ encaminhar o contador.
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

// para a busca na aba ativa e desliga o listener.
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

// ── Sugestões da omnibox — janela flutuante NÃO-FOCÁVEL (camada do SO) ──────────
// O dropdown HTML (#omni-suggest) ficava ATRÁS do <webview> (camada nativa do
// Chromium). Aqui a lista vira uma BrowserWindow sem moldura, posicionada LOGO
// ABAIXO da .address-wrap (rect enviado pelo renderer) e mostrada com
// `showInactive()` — assim a BARRA DE ENDEREÇO da janela-mãe MANTÉM O FOCO e
// continua tratando digitação/setas/Enter/Esc. A flutuante só EXIBE a lista e o
// índice selecionado, e aceita CLIQUE (janela inativa ainda recebe cliques).
// Uma por janela-mãe. NÃO fechamos no blur (a flutuante nunca tem foco); o
// fechamento é explícito via 'omni:close' do renderer (Esc/blur/navegar/vazia).
let omniPopupWin = null;
let omniPopupParent = null;

// Calcula a geometria (x/y/largura/altura) a partir do rect da .address-wrap.
function omniBounds(parent, rect, count) {
  const cb = parent.getContentBounds();
  const width = Math.round(rect && rect.width ? rect.width : Math.min(560, cb.width - 32));
  // altura: 6px de padding (3 em cima + 3 embaixo) + ~37px por item, com teto.
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
  if (!count) { // nada a mostrar → garante fechada
    if (omniPopupWin && !omniPopupWin.isDestroyed()) omniPopupWin.close();
    return false;
  }
  const b = omniBounds(parent, rect, count);

  // já aberta: reusa a MESMA janela (reposiciona + reenvia dados, não recria).
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
    focusable: false,        // NÃO-FOCÁVEL: nunca rouba o foco da barra de endereço
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
      // showInactive: mostra SEM focar → a barra de endereço da mãe mantém o foco.
      omniPopupWin.showInactive();
    } catch {}
  });
  // NÃO fechar no blur (a flutuante nunca tem foco). Só limpa a ref ao destruir.
  omniPopupWin.on('closed', () => { omniPopupWin = null; });
  return true;
});

// Atualiza items/selected sem recriar a janela (cada tecla/seta). Reposiciona se
// veio rect (a largura/posição da address-wrap pode mudar com resize da janela).
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

// clique numa sugestão na flutuante → main → renderer principal (índice escolhido).
ipcMain.on('omni:choose', (_evt, index) => {
  if (omniPopupWin && !omniPopupWin.isDestroyed()) omniPopupWin.close();
  if (omniPopupParent && !omniPopupParent.isDestroyed() && Number.isInteger(index)) {
    try { omniPopupParent.webContents.send('omni:chosen', index); } catch {}
  }
});

// ── Tema ──────────────────────────────────────────────────────────────────────
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
  // atualiza o backgroundColor de todas as janelas (mata flash no resize)
  const dark = applyWindowBackground();
  return { shouldUseDarkColors: dark };
});

// ── Settings ────────────────────────────────────────────────────────────────
ipcMain.handle('settings:get', () => settingsStore.get());
ipcMain.handle('settings:set', (evt, patch) => {
  const next = settingsStore.set(patch || {});
  // propaga pra TODAS as janelas-casca (o painel flutuante de Settings é janela
  // separada; sem isto a casca aberta ficava com searchEngine/homepage/tema stale).
  try { broadcast('settings:changed', settingsStore.get()); } catch {}
  return next;
});

// ── About / versões ───────────────────────────────────────────────────────────
ipcMain.handle('app:info', () => ({
  appVersion: pkg.version,
  chrome: process.versions.chrome,
  electron: process.versions.electron,
  v8: process.versions.v8,
  node: process.versions.node,
}));

// ── Nova janela / anônima ─────────────────────────────────────────────────────
ipcMain.handle('win:new', (evt, opts = {}) => {
  createWindow({ incognito: !!(opts && opts.incognito) });
});

// ── Limpar dados de navegação ─────────────────────────────────────────────────
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

// ── Histórico ───────────────────────────────────────────────────────────────
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

// ── Downloads ───────────────────────────────────────────────────────────────
ipcMain.handle('downloads:list', () => downloadsStore.list());
ipcMain.handle('downloads:action', (evt, { id, action } = {}) =>
  downloadsStore.action(id, action),
);

// ── Permissões ─────────────────────────────────────────────────────────────
ipcMain.handle('permission:respond', (evt, { requestId, granted } = {}) =>
  webviewManager.respondPermission(requestId, !!granted),
);

// ── Imprimir a aba ativa ─────────────────────────────────────────────────────
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

// ── DevTools da página — guarda de CDP exclusivo ─────────────────────────────
ipcMain.handle('devtools:open', (evt, { guestId } = {}) => {
  // O Pilot usa CDP (debugger) nessa webContents. DevTools é um 2º consumidor
  // de CDP → conflito. Recusar enquanto houver run ativo.
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

// ── Catálogo de motores de busca ──────────────────────────────────────────────
ipcMain.handle('search:getEngines', () => searchEngines.getEngines());

// ── Favoritos (bookmarks) ─────────────────────────────────────────────────────
// Convenção de IPC: o renderer manda OBJETO; o preload é pass-through; aqui
// desestruturamos o objeto. Toda mutação é broadcast p/ as janelas reagirem
// (barra + estrela sincronizadas em multi-janela).
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

// ── Find-in-page via IPC (de reserva; barra vive no renderer no fluxo padrão) ─
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

// ── Extensões do Chrome ───────────────────────────────────────────────────────
// O renderer é dono das <webview>. Quando uma extensão chama chrome.tabs.create,
// o extensions-manager pede ao renderer criar a aba (canal 'ext:createTab') e o
// renderer responde aqui com o guestId da nova webview.
ipcMain.on('ext:tabCreated', (evt, { reqId, guestId } = {}) => {
  try { extensionsManager.resolveTabCreate(reqId, guestId); } catch {}
});

// Aba ativa mudou no renderer → avisa o sistema de extensões (selectTab) e
// registra o guestId da aba ativa POR JANELA (a barra de localizar flutuante
// precisa saber em qual <webview> rodar findInPage). O mapa é declarado lá em
// cima (activeGuestByWindow), antes dos handlers da janela de localizar.
ipcMain.on('tabs:activated', (evt, { guestId } = {}) => {
  try { extensionsManager.activateTab(guestId); } catch {}
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (win && guestId != null) activeGuestByWindow.set(win, guestId);
});

// Botão "Extensões" / item do menu → abre a Chrome Web Store numa aba.
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

// Instalar extensão DESEMPACOTADA de uma pasta (caminho que SEMPRE funciona,
// sem depender da Web Store detectar o browser). Abre seletor de pasta.
ipcMain.handle('ext:install-unpacked', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  let res;
  try {
    res = await dialog.showOpenDialog(win || undefined, {
      title: 'Escolha a pasta da extensão (com manifest.json)',
      properties: ['openDirectory'],
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
  try {
    const ext = await extensionsManager.loadUnpacked(res.filePaths[0]);
    const name = (ext && ext.name) || 'extensão';
    try {
      dialog.showMessageBox(win || undefined, {
        type: 'info', title: 'Logica Pilot',
        message: 'Extensão instalada', detail: name + ' está ativa. O ícone aparece na barra de extensões.',
      });
    } catch {}
    return { ok: true, name, id: ext && ext.id };
  } catch (e) {
    try {
      dialog.showMessageBox(win || undefined, {
        type: 'error', title: 'Logica Pilot',
        message: 'Não consegui instalar a extensão', detail: e.message,
      });
    } catch {}
    return { ok: false, error: e.message };
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Stores (precisam de app.getPath, só disponível após whenReady).
  const userData = app.getPath('userData');
  settingsStore.init(userData);
  historyStore.init(userData);
  downloadsStore.init(userData, shell);
  bookmarksStore.init(userData);

  // Aplica o tema persistido ao nativeTheme.
  try { nativeTheme.themeSource = settingsStore.get().theme; } catch {}

  // Liga as dependências do webview-manager (envio ao host, downloads, busca).
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
    // sistema de extensões: o webview-manager chama addTab(wc, win) na equip()
    extensions: extensionsManager,
  });

  // Extensões do Chrome: configura a ponte (renderer é dono das webviews) e
  // inicializa na session da partition. Best-effort — falha não derruba o browser.
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
    .then((ex) => { if (ex) console.log('[ext] sistema de extensões pronto'); })
    .catch((e) => console.error('[ext] init falhou:', e && e.message));

  registerPilotProtocol();
  registerViewIpc(); // Fase 1: handlers view:* (inertes com a flag OFF)

  // Application Menu nativo (accelerators funcionam sobre o <webview>).
  Menu.setApplicationMenu(buildMenu(getActiveWindow));

  // nativeTheme muda (OS trocou o esquema) → reavalia 'system' no renderer.
  nativeTheme.on('updated', () => {
    // só reaplica a cor nativa se a escolha efetiva for 'system' (em light/dark
    // fixo o SO não afeta a cor — reaplicar regrediria uma janela em modo fixo).
    let choice = 'system';
    try { choice = settingsStore.get().theme; } catch {}
    if (choice === 'system') applyWindowBackground();
    broadcast('theme:native-updated', { shouldUseDarkColors: nativeTheme.shouldUseDarkColors });
  });

  createWindow();
});

/** Janela ativa para o menu (foco) ou a primeira disponível.
 *  Se uma janela FLUTUANTE (menu ⋮ / painel) estiver focada, roteia pra mãe —
 *  senão as ações do menu bar nativo cairiam numa janela sem listener. */
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

// Persiste os stores ao sair (flush imediato dos debounces).
app.on('before-quit', () => {
  try { settingsStore.flush(); } catch {}
  try { historyStore.flush(); } catch {}
  try { downloadsStore.flush(); } catch {}
  try { bookmarksStore.flush(); } catch {}
});
