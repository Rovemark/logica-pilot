'use strict';

/**
 * extensions-manager.js — Suporte a EXTENSÕES DO CHROME (Manifest V2/V3) no Logica Pilot.
 *
 * Usa as libs do Samuel Maddock (open-source, licença GPL-3.0 — válida porque o
 * produto é GPL-3.0-or-later):
 *   - electron-chrome-extensions@4.1.x  → APIs chrome.* + <browser-action-list>
 *   - electron-chrome-web-store@0.6.x   → instalar/atualizar extensões da Web Store
 *
 * Versões FIXADAS para Electron 33 (Chromium 130): a partir de
 * electron-chrome-extensions@4.2.0 / web-store@0.7.0 as libs passaram a exigir
 * Electron 35+ (protocolo webui://, contextBridge.executeInMainWorld). As 4.1.x /
 * 0.6.x são as últimas da era Electron 25–33.
 *
 * ── DESAFIO ARQUITETURAL ───────────────────────────────────────────────────────
 * No Logica Pilot, o RENDERER é dono das <webview> (não o main). A lib espera que o
 * main crie abas e devolva [webContents, BrowserWindow] de forma síncrona-promise.
 * Ponte: createTab() pede ao renderer (canal 'ext:createTab'), o renderer cria a
 * <webview>, e no did-attach-webview o renderer reporta o guestId (canal
 * 'ext:tabCreated'); aqui resolvemos a promise com webContents.fromId(guestId).
 *
 * selectTab()/removeTab() também voltam ao renderer (canais 'ext:selectTab' /
 * 'ext:removeTab') para ele ativar/fechar a aba correspondente ao guestId.
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
  // Falha de require não pode derrubar o browser: extensões viram no-op.
  console.error('[ext] libs de extensão indisponíveis:', e && e.message);
}

// Instância única (uma session/partition no app inteiro).
let extensions = null;
// Diretório onde as extensões instaladas/descompactadas vivem.
let extensionsPath = null;
let _session = null;

// Ponte de criação de aba: requestId → { resolve, reject, timer }.
const pendingTabCreates = new Map();
let tabCreateSeq = 0;
const TAB_CREATE_TIMEOUT_MS = 15000;

// Dependências injetadas pelo main.
let deps = {
  // (channel, payload) → envia ao renderer de UMA janela (o host)
  sendToWindow: null,
  // () → BrowserWindow ativa/foco (fallback p/ createWindow / janela alvo)
  getActiveWindow: null,
  // (opts) → cria nova BrowserWindow e devolve a instância (p/ chrome.windows.create)
  createBrowserWindow: null,
};

function configure(options = {}) {
  deps = { ...deps, ...options };
}

/** A integração está ativa? (libs presentes + instância criada) */
function isEnabled() {
  return !!extensions;
}

/**
 * Inicializa o sistema de extensões para uma session (a partition do app).
 * Deve ser chamado UMA vez no app.whenReady, depois de configure().
 *
 * @param {Electron.Session} ses  session da partition 'persist:logica-pilot'
 * @param {string} userDataDir    app.getPath('userData')
 */
async function init(ses, userDataDir) {
  if (!ElectronChromeExtensions || !ses) return null;
  _session = ses;
  if (extensions) return extensions;

  extensionsPath = path.join(userDataDir, 'extensions');
  try { fs.mkdirSync(extensionsPath, { recursive: true }); } catch {}

  // O preload da lib (browser-action) precisa ser injetado em TODA página que
  // hospede <browser-action-list> — ou seja, o renderer da casca. Registramos
  // como preload de session p/ garantir que a UI (index.html) o receba.
  // (O webview-manager também injeta no app/preload.js do renderer principal.)
  const browserActionPreload = require.resolve(
    'electron-chrome-extensions/dist/browser-action',
  );

  try {
    extensions = new ElectronChromeExtensions({
      license: 'GPL-3.0', // produto é GPL-3.0-or-later → licença válida e grátis
      session: ses,
      createTab,
      selectTab,
      removeTab,
      createWindow,
      removeWindow,
    });
  } catch (e) {
    console.error('[ext] falha ao instanciar ElectronChromeExtensions:', e && e.message);
    extensions = null;
    return null;
  }

  // Habilita a Chrome Web Store na mesma session + carrega extensões já instaladas
  // e desempacotadas. loadExtensions=true (default) carrega o que está em
  // extensionsPath; allowUnpackedExtensions=true permite as desempacotadas.
  if (webStore && typeof webStore.installChromeWebStore === 'function') {
    try {
      await webStore.installChromeWebStore({
        session: ses,
        extensionsPath,
        loadExtensions: true,
        allowUnpackedExtensions: true,
        autoUpdate: true,
      });
    } catch (e) {
      console.error('[ext] installChromeWebStore falhou:', e && e.message);
    }
  }

  // Carrega ainda extensões desempacotadas soltas em <extensionsPath>/<id>/manifest.json
  // que não tenham vindo da store (ex.: dev arrastou uma pasta). Best-effort.
  await loadUnpackedExtensions(ses).catch(() => {});

  return extensions;
}

/** Caminho exposto p/ o preload (browser-action) — usado pelo webview-manager. */
function getBrowserActionPreloadPath() {
  try { return require.resolve('electron-chrome-extensions/dist/browser-action'); }
  catch { return null; }
}

/**
 * Carrega extensões desempacotadas de <extensionsPath>/* que tenham manifest.json,
 * ignorando as que a session já carregou (a web-store já carrega as "instaladas").
 */
async function loadUnpackedExtensions(ses) {
  if (!extensionsPath || !ses) return;
  let entries = [];
  try { entries = await fs.promises.readdir(extensionsPath, { withFileTypes: true }); } catch { return; }
  const already = new Set();
  try { for (const e of ses.getAllExtensions()) already.add(e.id); } catch {}

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(extensionsPath, ent.name);
    // Web-store guarda como <id>/<version>/; uma desempacotada solta tem manifest direto.
    const manifest = path.join(dir, 'manifest.json');
    let target = null;
    if (fs.existsSync(manifest)) {
      target = dir;
    } else {
      // tenta <dir>/<versão>/manifest.json (layout da store)
      try {
        const subs = await fs.promises.readdir(dir, { withFileTypes: true });
        const sub = subs.find((s) => s.isDirectory() && fs.existsSync(path.join(dir, s.name, 'manifest.json')));
        if (sub) target = path.join(dir, sub.name);
      } catch {}
    }
    if (!target) continue;
    try {
      const ext = await ses.loadExtension(target, { allowFileAccess: true });
      if (ext) console.log('[ext] carregada:', ext.name, ext.version);
    } catch (e) {
      // já carregada (id duplicado) ou inválida — ignora silenciosamente
      if (e && !/already/i.test(String(e.message))) {
        console.error('[ext] loadExtension falhou', ent.name, e.message);
      }
    }
  }
}

// ── Ponte de tabs (renderer é dono das <webview>) ──────────────────────────────

/**
 * chrome.tabs.create → pede ao renderer criar uma aba e resolve com
 * [webContents, BrowserWindow] quando ele reportar o guestId.
 */
function createTab(details = {}) {
  return new Promise((resolve, reject) => {
    const win = pickWindow(details.windowId);
    if (!win) { reject(new Error('Nenhuma janela para criar a aba.')); return; }

    const reqId = `extreq_${Date.now()}_${++tabCreateSeq}`;
    const timer = setTimeout(() => {
      if (pendingTabCreates.has(reqId)) {
        pendingTabCreates.delete(reqId);
        reject(new Error('Timeout ao criar aba para extensão.'));
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

/** Chamado pelo handler IPC quando o renderer reporta o guestId da aba criada. */
function resolveTabCreate(reqId, guestId) {
  const slot = pendingTabCreates.get(reqId);
  if (!slot) return false;
  pendingTabCreates.delete(reqId);
  try { clearTimeout(slot.timer); } catch {}
  const wc = guestId != null ? webContents.fromId(guestId) : null;
  if (!wc) { slot.reject(new Error('webContents da aba não encontrado.')); return true; }
  slot.resolve([wc, slot.win]);
  return true;
}

/** chrome.tabs.update(active) → ativa a aba do guestId no renderer. */
function selectTab(tab, browserWindow) {
  const win = browserWindow || pickWindow();
  if (!tab || !win) return;
  send(win, 'ext:selectTab', { guestId: tab.id });
}

/** chrome.tabs.remove → fecha a aba do guestId no renderer. */
function removeTab(tab, browserWindow) {
  const win = browserWindow || pickWindow();
  if (!tab || !win) return;
  send(win, 'ext:removeTab', { guestId: tab.id });
}

/** chrome.windows.create → cria uma BrowserWindow nova e devolve. */
function createWindow(details = {}) {
  if (deps.createBrowserWindow) {
    const win = deps.createBrowserWindow({ url: details.url });
    return Promise.resolve(win);
  }
  return Promise.reject(new Error('createWindow não configurado.'));
}

/** chrome.windows.remove → fecha a janela. */
function removeWindow(browserWindow) {
  try { if (browserWindow && !browserWindow.isDestroyed()) browserWindow.close(); } catch {}
}

// ── Registro de abas (chamado pelo webview-manager.equip) ──────────────────────

/** Registra o webContents de uma <webview> como uma aba para o sistema de extensões. */
function addTab(wc, win) {
  if (!extensions || !wc) return;
  const browserWin = win || pickWindow();
  if (!browserWin) return;
  try { extensions.addTab(wc, browserWin); } catch (e) {
    console.error('[ext] addTab falhou:', e && e.message);
  }
}

/** Notifica que a aba ativa mudou (renderer → 'tabs:activated'). */
function activateTab(guestId) {
  if (!extensions || guestId == null) return;
  const wc = webContents.fromId(guestId);
  if (!wc) return;
  try { extensions.selectTab(wc); } catch (e) {
    console.error('[ext] selectTab falhou:', e && e.message);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

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

/** Instala uma extensão da Chrome Web Store pelo ID (programático — NÃO depende
 *  da loja reconhecer o browser; bypassa o bloqueio "não é Chrome"). */
async function installById(id, opts = {}) {
  if (!webStore || typeof webStore.installExtension !== 'function') {
    throw new Error('Suporte à Chrome Web Store indisponível.');
  }
  if (!/^[a-p]{32}$/.test(String(id || ''))) throw new Error('ID de extensão inválido.');
  return webStore.installExtension(id, { session: _session || undefined, ...opts });
}

// Handler IPC: instala da Web Store pelo ID (registrado aqui p/ não tocar no main.js).
ipcMain.handle('ext:install-id', async (evt, { id } = {}) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  try {
    const ext = await installById(id);
    const name = (ext && (ext.name || (ext.manifest && ext.manifest.name))) || 'extensão';
    try {
      dialog.showMessageBox(win || undefined, {
        type: 'info', title: 'Logica Pilot',
        message: 'Extensão instalada', detail: name + ' está ativa. O ícone aparece na barra de extensões.',
      });
    } catch {}
    return { ok: true, name };
  } catch (e) {
    try {
      dialog.showMessageBox(win || undefined, {
        type: 'error', title: 'Logica Pilot',
        message: 'Não consegui instalar da Web Store', detail: e.message,
      });
    } catch {}
    return { ok: false, error: e.message };
  }
});

/** Carrega uma extensão desempacotada de uma pasta escolhida pelo usuário. */
async function loadUnpacked(dir) {
  if (!_session) throw new Error('Sistema de extensões não inicializado.');
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
    throw new Error('A pasta não contém manifest.json — não é uma extensão desempacotada.');
  }
  return _session.loadExtension(dir, { allowFileAccess: true });
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
};
