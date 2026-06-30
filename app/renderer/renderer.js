'use strict';

/* Logica Pilot — renderer (orquestrador): navegador normal (abas/endereço) + painel autônomo.
   Módulos: TabStrip (tabs.js), Omnibox (omnibox.js), FindBar (findbar.js), Overlays (overlays.js).
   dispatchMenu(name) é a FONTE ÚNICA de ações (atalhos nativos, keydown e itens ⋮ convergem aqui).
   O motor Pilot (pilot:*) NÃO se mexe. */

const $ = (s) => document.querySelector(s);
const views = $('#views');
const tabsEl = $('#tabs');
const address = $('#address');

if (window.pilot && window.pilot.platform === 'darwin') document.body.classList.add('darwin');

const HOME = 'pilot://newtab';

// ── Modo anônimo ──────────────────────────────────────────────
// O main passa ?incognito=1 no loadFile da janela anônima. Aqui o renderer:
//  - usa uma partition NÃO-persistente única p/ as <webview> desta janela
//    (sem 'persist:' → cookies/cache/login só vivem em memória e somem ao fechar);
//  - NÃO grava histórico (pula historyAdd/historyUpdateTitle);
//  - marca o body + mostra um selo "Anônima" na toolbar.
const _qs = new URLSearchParams(location.search);
const IS_INCOGNITO = _qs.get('incognito') === '1';
// URL inicial (chrome.windows.create({url}) das extensões) → 1ª aba abre nela
const INITIAL_URL = _qs.get('initialUrl') || '';
// partition em memória, exclusiva desta janela (sem 'persist:' = não-persistente)
const INCOGNITO_PARTITION = 'logica-pilot-incognito-' + Date.now();
const WV_PARTITION = IS_INCOGNITO ? INCOGNITO_PARTITION : 'persist:logica-pilot';
if (IS_INCOGNITO) {
  document.body.classList.add('incognito');
  document.title = 'Anônima — Logica Pilot';
  // revela o selo "Anônima" na toolbar (só nesta janela)
  const badge = document.getElementById('incognito-badge');
  if (badge) badge.hidden = false;
}

// cache de settings (carregado no boot)
let settings = { theme: 'system', searchEngine: 'google', homepage: HOME };

// ── Módulos ───────────────────────────────────────────────────
const omnibox = new Omnibox();
const findbar = new FindBar();
const overlays = new Overlays();
const bookmarks = new Bookmarks();

function makeWebview(url) {
  const wv = document.createElement('webview');
  wv.setAttribute('src', url);
  wv.setAttribute('allowpopups', '');
  // perfil persistente (cookies/logins) — ou partition em memória no modo anônimo
  wv.setAttribute('partition', WV_PARTITION);
  // PDF nativo: liga o plugin viewer interno do Chromium (renderiza PDFs inline,
  // como no Chrome). Sem isto o <webview> só oferece o PDF para download.
  wv.setAttribute('plugins', '');
  wv.setAttribute('webpreferences', 'plugins=true');
  // Preload do guest (canal home → casca). É GUARDADO por protocolo dentro do
  // próprio preload (só páginas pilot:// recebem window.lpHome), então é seguro
  // colocá-lo em TODAS as webviews — sites normais não recebem nenhuma API.
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
    // guarda do Pilot: se a aba está pilotando, para o run antes de fechar
    if (tab.piloting && tab._guestId) {
      try { window.pilot.stop({ guestId: tab._guestId }); } catch {}
      if (running) setRunning(false);
    }
    return true;
  },
});

// liga TODOS os listeners do webview de uma aba (favicon, áudio, progresso, segurança, histórico)
function equipWebview(wv, url) {
  // o tab correspondente é resolvido por getWebContentsId no momento do evento
  const tabOf = () => strip.tabs.find((t) => t.wv === wv);

  wv.addEventListener('did-start-loading', () => { const t = tabOf(); if (t) { strip.setLoading(t.id, true); if (t.id === strip.activeId) progressStart(); } });
  wv.addEventListener('did-stop-loading', () => { const t = tabOf(); if (t) { strip.setLoading(t.id, false); if (t.id === strip.activeId) { progressDone(); syncNav(); } } });
  wv.addEventListener('page-title-updated', (e) => {
    const t = tabOf(); if (!t) return;
    strip.setTitle(t.id, e.title);
    if (t.id === strip.activeId) document.title = (e.title ? e.title + ' — ' : '') + 'Logica Pilot';
    // corrige no histórico o título da URL atual (did-navigate gravou o título antigo).
    // updateTitle não infla visitCount; usa t.url (já commitada por did-navigate).
    // No modo anônimo NÃO gravamos histórico.
    if (!IS_INCOGNITO) { try { window.pilot.historyUpdateTitle && window.pilot.historyUpdateTitle({ url: t.url, title: e.title }); } catch {} }
  });
  wv.addEventListener('page-favicon-updated', (e) => { const t = tabOf(); if (t) strip.setFavicon(t.id, e.favicons && e.favicons[0]); });
  wv.addEventListener('media-started-playing', () => { const t = tabOf(); if (t) strip.setAudible(t.id, true); });
  wv.addEventListener('media-paused', () => { const t = tabOf(); if (t) strip.setAudible(t.id, false); });

  wv.addEventListener('did-navigate', (e) => {
    const t = tabOf(); if (!t) return;
    strip.setUrl(t.id, e.url);
    if (t.id === strip.activeId) { omnibox.setUrl(e.url); syncNav(); bookmarks.onActiveUrl(e.url); }
    // histórico persistente: cria a entrada SEM título (t.title ainda é o da página
    // anterior). O page-title-updated subsequente preenche o título real via
    // historyUpdateTitle (dedup por URL, sem inflar visitCount).
    // No modo anônimo NÃO gravamos histórico.
    if (!IS_INCOGNITO) { try { window.pilot.historyAdd && window.pilot.historyAdd({ url: e.url, title: '', ts: Date.now() }); } catch {} }
  });
  wv.addEventListener('did-navigate-in-page', (e) => {
    if (!e.isMainFrame) return;
    const t = tabOf(); if (!t) return;
    strip.setUrl(t.id, e.url);
    if (t.id === strip.activeId) { omnibox.setUrl(e.url); bookmarks.onActiveUrl(e.url); }
  });
  wv.addEventListener('did-fail-load', (e) => {
    if (e.isMainFrame && e.errorCode !== -3) { // -3 = ERR_ABORTED (navegação cancelada)
      const t = tabOf(); if (t && t.id === strip.activeId) omnibox.setSecurity(t.url, true);
    }
  });
  wv.addEventListener('zoom-changed', (e) => {
    const t = tabOf(); if (!t) return;
    try { t.zoomLevel = wv.getZoomLevel(); } catch {}
    if (t.id === strip.activeId) showZoom(t.zoomLevel);
  });

  // Canal home → casca: a home/dashboard (pilot://newtab, isolada, sem window.pilot)
  // pede via webview-preload (window.lpHome → sendToHost). Aqui a casca atende.
  // O preload é guardado por protocolo, então só páginas pilot:// disparam isto.
  wv.addEventListener('ipc-message', (e) => {
    if (e.channel === 'home:pilot') launchPilotFromHome(e.args[0]);
    else if (e.channel === 'home:open' && e.args[0]) strip.create(e.args[0]);
  });
  return wv;
}

// Abre o painel Pilot já preenchido com o objetivo vindo da home/dashboard.
// PREFILL + FOCO apenas — NÃO auto-roda (mais seguro: o usuário aperta "Pilotar").
// Além disso, a aba ativa aqui É a home (pilot://newtab), onde rodar não faz
// sentido. Auto-run é opção FUTURA (ex.: abrir nova aba e pilotar nela).
function launchPilotFromHome(objective) {
  togglePilot(true); // garante o painel visível
  const goalEl = $('#goal');
  if (goalEl) {
    goalEl.value = String(objective == null ? '' : objective);
    try { goalEl.focus(); } catch {}
  }
}

function onActivateTab(tab) {
  omnibox.setUrl(tab.url);
  document.title = (tab.title && tab.title !== 'Nova aba' ? tab.title + ' — ' : '') + 'Logica Pilot';
  if (findbar.isOpen) findbar.close();
  hideZoom();
  syncNav();
  bookmarks.onActiveUrl(tab.url);
  // avisa o sistema de extensões qual aba é a ativa (→ extensions.selectTab)
  notifyExtActiveTab(tab);
}

// Notifica o main do guestId da aba ativa (para extensions.selectTab). O guestId
// (webContentsId) só existe após a <webview> anexar — se ainda não, espera o
// dom-ready uma vez.
function notifyExtActiveTab(tab) {
  if (!tab || !window.pilot || !window.pilot.tabActivated) return;
  let guestId = null;
  try { guestId = tab.wv.getWebContentsId(); } catch {}
  if (guestId) { try { window.pilot.tabActivated({ guestId }); } catch {} return; }
  const once = () => {
    tab.wv.removeEventListener('dom-ready', once);
    if (tab.id !== strip.activeId) return; // mudou de aba enquanto carregava
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

// ── Barra de progresso ────────────────────────────────────────
const progressEl = $('#progress');
let progressTimer = null;
function progressStart() {
  clearTimeout(progressTimer);
  progressEl.hidden = false;
  progressEl.style.opacity = '1';
  progressEl.style.width = '8%';
  // sobe gradualmente até ~80%
  requestAnimationFrame(() => { progressEl.style.width = '80%'; });
}
function progressDone() {
  progressEl.style.width = '100%';
  progressTimer = setTimeout(() => {
    progressEl.style.opacity = '0';
    setTimeout(() => { progressEl.hidden = true; progressEl.style.width = '0%'; }, 250);
  }, 200);
}

// ── Indicador de zoom ─────────────────────────────────────────
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

// ── Navegação básica ──────────────────────────────────────────
function navigateActive(url) { const t = active(); if (t) { try { t.wv.loadURL(url); } catch {} } }

omnibox.init({
  getActiveUrl: () => { const t = active(); return t ? t.url : ''; },
  navigate: (url) => navigateActive(url),
  settings,
});
findbar.init({ getActiveWebview: () => activeWebview() });
// a barra de localizar flutuante avisa quando fecha (Esc/✕) → reseta o estado
if (window.pilot && window.pilot.onFindClosed) window.pilot.onFindClosed(() => findbar.notifyClosed());

$('#nav-back').addEventListener('click', () => { const t = active(); if (t && t.wv.canGoBack()) t.wv.goBack(); });
$('#nav-fwd').addEventListener('click', () => { const t = active(); if (t && t.wv.canGoForward()) t.wv.goForward(); });
$('#nav-reload').addEventListener('click', () => { const t = active(); if (t) t.wv.reload(); });
$('#tab-new').addEventListener('click', () => strip.create(HOME));
// botão de extensões (🧩) → abre a Chrome Web Store
{ const extBtn = $('#ext-btn'); if (extBtn) extBtn.addEventListener('click', () => dispatchMenu('extensions')); }

// controles de janela (Windows/Linux) — no mac usa traffic-lights nativos
document.querySelectorAll('.wc').forEach((b) =>
  b.addEventListener('click', () => window.pilot.winControl(b.dataset.win)),
);

// ── Tema ──────────────────────────────────────────────────────
const themeBtn = $('#theme-btn');
const THEME_ICONS = {
  light: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  system: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
};
function updateThemeIcon() {
  const choice = window.LPTheme ? window.LPTheme.getChoice() : 'system';
  themeBtn.innerHTML = THEME_ICONS[choice] || THEME_ICONS.system;
  themeBtn.title = 'Tema: ' + ({ light: 'claro', dark: 'escuro', system: 'sistema' }[choice]) + ' (⌘⇧L)';
}
themeBtn.addEventListener('click', () => { if (window.LPTheme) window.LPTheme.cycle(); });
if (window.LPTheme) { window.LPTheme.onChange(() => updateThemeIcon()); updateThemeIcon(); }

// Painel Configurações/Sobre como JANELA FLUTUANTE (camada do SO, acima do
// <webview>). Caminho primário; cai no overlay HTML antigo se o IPC faltar.
function openPanelOrOverlay(type) {
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  if (window.pilot && window.pilot.openPanel) {
    try { window.pilot.openPanel({ type, dark }); return; } catch {}
  }
  // fallback: overlay HTML (fica atrás do webview, mas preserva a função)
  if (type === 'about') overlays.openAbout(); else overlays.openSettings();
}

// ── DISPATCH: fonte única de ações ────────────────────────────
function dispatchMenu(name, arg) {
  const t = active();
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
    case 'goto-tab-last': strip.selectIndex(9); break; // selectIndex(9) já mapeia pra última aba
    default: console.warn('dispatchMenu: ação desconhecida', name); break;
  }
}
window.dispatchMenu = dispatchMenu;

function guestIdOf(t) { try { return t ? t.wv.getWebContentsId() : null; } catch { return null; } }

// ── Páginas internas (history/downloads) ──────────────────────
// Reusa a aba ativa se ela estiver "vazia" (newtab ou na própria página interna);
// senão abre numa aba nova. Mantém o overlay como fallback se algo der errado.
function openInternal(url) {
  const t = active();
  const cur = t ? (t.url || '') : '';
  const reusable = !t || cur === HOME || cur.startsWith('pilot://newtab') ||
    cur.startsWith('pilot://history') || cur.startsWith('pilot://downloads');
  if (t && reusable) navigateActive(url);
  else strip.create(url);
}

// ── Extensões: menu flutuante com "Instalar da pasta" (sempre funciona) +
//    "Chrome Web Store". Instalar da loja dentro de <webview> é frágil (a loja
//    detecta "não-Chrome"); a pasta desempacotada é o caminho garantido. ──────
function openExtensions() {
  const items = [];
  const t = active();
  const sid = t ? storeIdFromUrl(t.url) : null;
  if (sid) {
    let nm = ((t.title || '').replace(/\s*[-–|]\s*Chrome.*$/i, '').trim()) || 'esta extensão';
    if (nm.length > 34) nm = nm.slice(0, 34) + '…';
    items.push({ label: '⬇ Instalar “' + nm + '” aqui', action: 'ext-install-current' });
    items.push({ sep: true });
  }
  items.push({ label: 'Instalar extensão (escolher pasta)…', action: 'ext-install-unpacked' });
  items.push({ label: 'Abrir Chrome Web Store', action: 'ext-store' });
  const btn = $('#ext-btn');
  if (window.pilot && window.pilot.showAppMenu && btn) {
    const r = btn.getBoundingClientRect();
    const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    window.pilot.showAppMenu({ items, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, dark });
  } else if (sid) {
    extInstallById(sid);
  } else {
    extInstallUnpacked();
  }
}

// extrai o ID (32 chars a-p) de uma URL de detalhe da Chrome Web Store
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
  // o main abre o seletor de pasta e mostra um diálogo nativo de confirmação
  if (window.pilot && window.pilot.extInstallUnpacked) {
    try { window.pilot.extInstallUnpacked(); } catch {}
  }
}

// ── Modo leitor (window.Reader) ───────────────────────────────
async function toggleReader() {
  const wv = activeWebview();
  if (!wv || !window.Reader) return;
  try {
    const res = await window.Reader.toggle(wv);
    if (res && res.ok === false) {
      const msg = res.error === 'sem-artigo'
        ? 'Modo leitor: não encontrei um artigo legível nesta página.'
        : ('Modo leitor indisponível: ' + (res.error || 'erro desconhecido') + '.');
      showResult({ success: false, result: msg });
    }
  } catch (e) {
    showResult({ success: false, result: 'Modo leitor falhou: ' + (e && e.message) });
  }
}

// ── Traduzir página (Google Tradutor) ─────────────────────────
function translatePage() {
  const t = active();
  if (!t) return;
  const cur = t.url || '';
  // só traduz páginas web reais (não as internas pilot://)
  if (!/^https?:\/\//i.test(cur)) {
    showResult({ success: false, result: 'Traduzir: abra uma página web primeiro.' });
    return;
  }
  const target =
    'https://translate.google.com/translate?sl=auto&tl=pt&u=' + encodeURIComponent(cur);
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
        // CDP é exclusivo: o Pilot está usando o debugger desta aba
        showResult({ success: false, result: 'DevTools indisponível: o Pilot está controlando esta aba (CDP exclusivo). Pare o run primeiro.' });
      }
    } else { try { t.wv.openDevTools(); } catch {} }
  } catch {}
}

// liga o menu nativo (accelerators funcionam mesmo com foco no <webview>)
if (window.pilot && window.pilot.onMenuAction) window.pilot.onMenuAction((name) => dispatchMenu(name));

// popups / target=_blank (new-window está MORTO no Electron 33 → vem por tab:open do main)
// Abrir link em nova aba do menu de contexto também chega por tab:open (webview-manager).
if (window.pilot && window.pilot.onTabOpen) {
  window.pilot.onTabOpen(({ url, background }) => strip.create(url, { background: !!background }));
}

// ── Extensões: o main pede ao renderer criar/ativar/fechar abas ───────────────
// (a lib electron-chrome-extensions chama chrome.tabs.create/update/remove)
if (window.pilot && window.pilot.onExtCreateTab) {
  window.pilot.onExtCreateTab(({ reqId, url, background }) => {
    const tab = strip.create(url || HOME, { background: !!background });
    // reporta o guestId (webContentsId) ao main assim que a webview anexar
    // o guestId fica válido logo APÓS o attach da <webview> — que acontece bem
    // antes do dom-ready. Por isso fazemos POLL curto (não dependemos do load da
    // página, que poderia nunca pintar e estourar o timeout de 15s do main).
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

// Resolve a aba (do TabStrip) cujo <webview> tem o webContentsId dado.
function tabByGuestId(guestId) {
  if (guestId == null) return null;
  return strip.tabs.find((t) => {
    try { return t.wv.getWebContentsId() === guestId; } catch { return false; }
  }) || null;
}

// ── Atalhos (keydown da casca) — convergem em dispatchMenu ─────
window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key;
  const lower = key.length === 1 ? key.toLowerCase() : key;

  // Ctrl+Tab / Ctrl+Shift+Tab (independe de meta)
  if (e.ctrlKey && key === 'Tab') { e.preventDefault(); dispatchMenu(e.shiftKey ? 'prev-tab' : 'next-tab'); return; }

  // Esc: fecha overlays/menu/findbar; senão para o loading
  if (key === 'Escape') {
    if (overlays.appMenu && !overlays.appMenu.hidden) { overlays.closeMenu(); return; }
    if (bookmarks.isManagerOpen && bookmarks.isManagerOpen()) { bookmarks.closeManager(); return; }
    if (overlays.anyOverlayOpen()) { overlays.closeAll(); return; }
    if (findbar.isOpen) { findbar.close(); return; }
    if (document.activeElement === address) return; // omnibox trata o próprio Esc
    dispatchMenu('stop');
    return;
  }

  if (!mod) return;

  // ⌥⌘R → modo leitor (Alt+Cmd/Ctrl+R). Antes do bloco shift/normal p/ não colidir
  // com ⌘R (reload) nem ⌘⇧R (hard-reload).
  if (e.altKey && lower === 'r') { e.preventDefault(); dispatchMenu('reader'); return; }

  // ⌘1..9 → aba N (9 = última)
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

// recalcula largura das abas no resize da janela
window.addEventListener('resize', () => strip.render());

// ── Painel Pilot (motor — NÃO mexer no fluxo) ─────────────────
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
    case 'click': return `elemento [${input.index}]` + (input.reason ? ` — ${input.reason}` : '');
    case 'type': return `[${input.index}] "${input.text}"${input.submit ? ' + Enter' : ''}`;
    case 'scroll': return `${input.direction} ${input.amount || 600}px`;
    case 'press': return input.key || '';
    case 'extract': return input.query || 'texto da página';
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
    (result && action !== 'done' ? `<div class="res">${escapeHtml(String(result).slice(0, 120))}</div>` : '') +
    '</div>';
  timeline.appendChild(el);
  timeline.scrollTop = timeline.scrollHeight;
}

function showResult(res) {
  resultBox.hidden = false;
  resultBox.className = 'result ' + (res.success ? 'ok' : 'fail');
  resultBox.innerHTML =
    `<h4>${res.success ? 'Resultado' : 'Não concluído'} · ${res.steps || 0} passos</h4>` +
    `<p>${escapeHtml(res.result || '')}</p>`;
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
  try { guestId = t.wv.getWebContentsId(); } catch { showResult({ success: false, result: 'Aba ainda carregando — tente de novo.' }); return; }

  // limpa timeline
  timeline.innerHTML = '';
  resultBox.hidden = true;
  setRunning(true);
  togglePilot(true);

  t._guestId = guestId;
  strip.setPiloting(t.id, true); // indicador visual + guarda ao fechar
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

// ── Downloads / permissões (vindos do main) ───────────────────
if (window.pilot && window.pilot.onDownloadEvent) window.pilot.onDownloadEvent((d) => overlays.onDownload(d));
// Permissão como JANELA FLUTUANTE (camada do SO, acima do <webview>). A fila/
// timeout/resposta vivem no main+webview-manager; o renderer só repassa o pedido.
// Cai no overlay HTML antigo se o IPC da flutuante faltar.
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

// ── boot ──────────────────────────────────────────────────────
async function boot() {
  overlays.wireMenu(); // liga o menu ⋮ JÁ, antes de qualquer await (não depende de IPC)
  // carrega settings (motor de busca, homepage) antes da primeira aba
  try {
    if (window.pilot && window.pilot.settingsGet) {
      const s = await window.pilot.settingsGet();
      if (s) settings = Object.assign(settings, s);
    }
  } catch {}
  let engines = [];
  try { if (window.pilot && window.pilot.getEngines) engines = (await window.pilot.getEngines()) || []; } catch {}

  // propaga settings/motor pros módulos
  omnibox.updateSettings(settings);
  // se o catálogo trouxe template do motor default, injeta no omnibox
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

  // O painel flutuante de Settings é janela SEPARADA → quando ele grava via
  // settings:set, o main emite settings:changed; reaplica na casca já aberta.
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
    });
  }

  // Favoritos: barra + estrela + gerenciador. getActive() entrega a aba ativa
  // (url/title/favicon) p/ a estrela; preferência da barra vem das settings.
  bookmarks.init({
    navigate: (url) => navigateActive(url),
    openTab: (url, opts) => strip.create(url, opts || {}),
    getActive: () => { const t = active(); return t ? { url: t.url, title: t.title, favicon: t.favicon } : null; },
    showBar: typeof settings.showBookmarksBar === 'boolean' ? settings.showBookmarksBar : undefined,
    persistBarPref: (on) => { settings.showBookmarksBar = on; try { window.pilot?.settingsSet?.({ showBookmarksBar: on }); } catch {} },
  });

  // 1ª aba: na URL pedida pela extensão (chrome.windows.create) ou na home.
  strip.create(INITIAL_URL || HOME);
}
boot();
