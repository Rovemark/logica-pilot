'use strict';

/**
 * webview-manager.js — Ponto de entrada arquitetural das webviews (paridade Chrome).
 *
 * O main NÃO cria as <webview> (o renderer é dono delas). Mas o main precisa do
 * `webContents` de cada webview para ligar features que SÓ vivem no main:
 *   - menu de contexto nativo (context-menu)
 *   - setWindowOpenHandler (substitui o evento 'new-window', MORTO no Electron 33)
 *   - found-in-page (resultado do find)
 * E, UMA vez por session da partition 'persist:logica-pilot':
 *   - will-download (downloads)
 *   - setPermissionRequestHandler (câmera/mic/geo/notif)
 *
 * O hook é `win.webContents.on('did-attach-webview', (e, wc) => equip(wc, win))`,
 * registrado pelo main em createWindow().
 *
 * CDP é EXCLUSIVO: o Pilot anexa `webContents.debugger` na aba. Abrir DevTools
 * cria um segundo consumidor de CDP no mesmo webContents → conflito. Por isso o
 * gate de DevTools (runs.has(guestId)) é checado no main antes de abrir.
 */

const { Menu, session, clipboard } = require('electron');

const PARTITION = 'persist:logica-pilot';

// WeakSet de webContents já equipados (evita ligar handlers 2x).
const equippedWC = new WeakSet();
// Sessions de partition já configuradas (will-download + permissões), por nome.
const wiredSessions = new Set();
// guestId → { wc }  — registro vivo das webviews para lookups do main.
const guests = new Map();

// Callbacks de permissão pendentes: requestId → { callback, timer, guestId, origin, permission }.
const pendingPermissions = new Map();
let permissionSeq = 0;
// Permissões já concedidas pelo usuário: chave `${origin}|${permission}`.
// Consultadas pelo setPermissionCheckHandler (navigator.permissions.query / enumerateDevices).
const grantedPermissions = new Set();
// Timeout p/ pedido de permissão sem resposta (evita callback órfão pendurando a página).
const PERMISSION_TIMEOUT_MS = 30000;

// Dependências injetadas pelo main (para não acoplar IPC/stores aqui).
let deps = {
  // (channel, payload) => envia ao renderer da janela dona da webview
  sendToHost: null,
  // (item, emit) => registra download no downloads-store; retorna record
  registerDownload: null,
  // motor de busca default (id) para "Pesquisar no Google/…" do menu de contexto
  getSearchEngine: null,
  // (id, query) => url de busca
  buildSearchUrl: null,
  // sistema de extensões do Chrome (extensions-manager): addTab(wc, win)
  extensions: null,
};

/** Configura as dependências (chamado uma vez pelo main no boot). */
function configure(options = {}) {
  deps = { ...deps, ...options };
}

/**
 * Equipa um webContents de webview com os handlers de feature do main.
 * @param {import('electron').WebContents} wc
 * @param {import('electron').BrowserWindow} hostWin  janela dona da webview
 */
function equip(wc, hostWin) {
  if (!wc || equippedWC.has(wc)) return;
  equippedWC.add(wc);

  const guestId = wc.id;
  guests.set(guestId, { wc });
  wc.once('destroyed', () => {
    guests.delete(guestId);
    // varre pedidos de permissão órfãos deste guest: nega e limpa (sem callback pendurado).
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

  // Extensões do Chrome: registra esta <webview> como uma "aba" para que content
  // scripts, botões de ação (browser actions) e popups das extensões funcionem.
  if (deps.extensions && typeof deps.extensions.addTab === 'function') {
    try { deps.extensions.addTab(wc, hostWin); } catch (e) {
      // best-effort: a navegação não pode quebrar por causa de extensão
    }
  }

  // Session da partition: configurar UMA vez (downloads + permissões).
  wireSession(wc.session);
}

/** Resolve a webContents da webview pelo guestId, se ainda viva. */
function getGuest(guestId) {
  const slot = guests.get(guestId);
  return slot ? slot.wc : null;
}

// ── window.open / target=_blank (substitui 'new-window' morto) ───────────────
function wireWindowOpen(wc, hostWin) {
  wc.setWindowOpenHandler(({ url, disposition }) => {
    // Renderer é dono das webviews → pedir que ELE crie a aba.
    sendHost(hostWin, 'tab:open', {
      url,
      background: disposition === 'background-tab',
    });
    return { action: 'deny' };
  });
}

// ── Menu de contexto NATIVO (right-click) ────────────────────────────────────
function wireContextMenu(wc, hostWin) {
  wc.on('context-menu', (_e, params) => {
    const template = buildContextTemplate(wc, hostWin, params);
    if (!template.length) return;
    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: hostWin || undefined });
  });
}

/** Monta o template do menu de contexto condicional aos params do clique. */
function buildContextTemplate(wc, hostWin, params) {
  const t = [];
  const editFlags = params.editFlags || {};

  // Link → abrir em nova aba (volta ao renderer) + copiar endereço.
  if (params.linkURL) {
    t.push({
      label: 'Abrir link em nova aba',
      click: () => sendHost(hostWin, 'tab:open', { url: params.linkURL, background: false }),
    });
    t.push({
      label: 'Abrir link em nova aba (segundo plano)',
      click: () => sendHost(hostWin, 'tab:open', { url: params.linkURL, background: true }),
    });
    t.push({
      label: 'Copiar endereço do link',
      click: () => { try { clipboard.writeText(params.linkURL); } catch {} },
    });
    t.push({ type: 'separator' });
  }

  // Imagem → salvar / copiar.
  if (params.mediaType === 'image' && params.srcURL) {
    t.push({
      label: 'Salvar imagem como…',
      click: () => { try { wc.downloadURL(params.srcURL); } catch {} },
    });
    t.push({
      label: 'Copiar imagem',
      click: () => { try { wc.copyImageAt(params.x, params.y); } catch {} },
    });
    t.push({
      label: 'Copiar endereço da imagem',
      click: () => { try { clipboard.writeText(params.srcURL); } catch {} },
    });
    t.push({ type: 'separator' });
  }

  // Campo editável → recortar/copiar/colar (respeitando editFlags).
  if (params.isEditable) {
    t.push({ label: 'Recortar', enabled: !!editFlags.canCut, click: () => { try { wc.cut(); } catch {} } });
    t.push({ label: 'Copiar', enabled: !!editFlags.canCopy, click: () => { try { wc.copy(); } catch {} } });
    t.push({ label: 'Colar', enabled: !!editFlags.canPaste, click: () => { try { wc.paste(); } catch {} } });
    t.push({ label: 'Selecionar tudo', enabled: !!editFlags.canSelectAll, click: () => { try { wc.selectAll(); } catch {} } });
    t.push({ type: 'separator' });
  } else if (params.selectionText) {
    // Seleção de texto → copiar + pesquisar.
    t.push({ label: 'Copiar', click: () => { try { wc.copy(); } catch {} } });
    const term = params.selectionText.trim().slice(0, 120);
    t.push({
      label: `Pesquisar por "${term.length > 40 ? term.slice(0, 40) + '…' : term}"`,
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

  // Navegação sempre disponível.
  t.push({
    label: 'Voltar',
    enabled: canGoBack(wc),
    click: () => { try { goBack(wc); } catch {} },
  });
  t.push({
    label: 'Avançar',
    enabled: canGoForward(wc),
    click: () => { try { goForward(wc); } catch {} },
  });
  t.push({ label: 'Recarregar', click: () => { try { wc.reload(); } catch {} } });
  t.push({ type: 'separator' });
  t.push({
    label: 'Inspecionar elemento',
    click: () => { try { wc.inspectElement(params.x, params.y); } catch {} },
  });

  return t;
}

// navigationHistory é a API nova (Electron 33); canGoBack/goBack diretos foram
// depreciados. Fallback defensivo para ambas as formas.
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

// ── found-in-page → manda o contador ao renderer ─────────────────────────────
function wireFoundInPage(wc, hostWin) {
  wc.on('found-in-page', (_e, result) => {
    sendHost(hostWin, 'find:result', {
      guestId: wc.id,
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
    });
  });
}

// ── Session da partition: downloads + permissões (UMA vez) ────────────────────
function wireSession(ses) {
  if (!ses) return;
  // chave estável por session (usa o storagePath se houver; senão a própria ref)
  const key = ses.storagePath || PARTITION;
  if (wiredSessions.has(key)) return;
  wiredSessions.add(key);

  // Downloads
  ses.on('will-download', (_e, item) => {
    if (!deps.registerDownload) return;
    deps.registerDownload(item, (payload) => {
      // emite a TODAS as janelas (renderer decide se mostra)
      broadcast('downloads:event', payload);
    });
  });

  // Permissões: default DENY para desconhecidas; pergunta para as sensíveis.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const sensitive = ['media', 'geolocation', 'notifications'];
    if (!sensitive.includes(permission)) {
      // tudo que não for sensível: negar por padrão (mais seguro que o default do Electron)
      callback(false);
      return;
    }
    const requestId = `perm_${Date.now()}_${++permissionSeq}`;
    const origin = (details && (details.requestingUrl || details.requestingOrigin)) || '';
    // timeout de segurança: se ninguém responder, nega (libera a página sem pendurar).
    const timer = setTimeout(() => {
      if (pendingPermissions.has(requestId)) respondPermission(requestId, false);
    }, PERMISSION_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    pendingPermissions.set(requestId, { callback, timer, guestId: wc.id, origin, permission });
    // pergunta à UI da janela que contém essa webview
    const win = ownerWindow(wc);
    sendHost(win, 'permission:request', {
      requestId,
      guestId: wc.id,
      permission,
      origin,
    });
  });

  // Checagem síncrona (navigator.permissions.query, enumerateDevices labels…):
  // reflete o que o usuário JÁ concedeu; deny-by-default para o resto.
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    const sensitive = ['media', 'geolocation', 'notifications'];
    if (!sensitive.includes(permission)) return false;
    return grantedPermissions.has(`${requestingOrigin}|${permission}`);
  });
}

/** Resolve a permissão pendente (chamado pelo handler IPC 'permission:respond'). */
function respondPermission(requestId, granted) {
  const slot = pendingPermissions.get(requestId);
  if (!slot) return false;
  pendingPermissions.delete(requestId);
  try { clearTimeout(slot.timer); } catch {}
  // memoriza concessões p/ o check handler síncrono (permissions.query/enumerateDevices).
  if (granted && slot.origin && slot.permission) {
    grantedPermissions.add(`${slot.origin}|${slot.permission}`);
  }
  try { slot.callback(!!granted); } catch {}
  return true;
}

// ── Helpers de envio ──────────────────────────────────────────────────────────
function sendHost(win, channel, payload) {
  if (deps.sendToHost) { deps.sendToHost(win, channel, payload); return; }
  if (win && !win.isDestroyed()) {
    try { win.webContents.send(channel, payload); } catch {}
  }
}

function broadcast(channel, payload) {
  // delega ao main, que conhece todas as janelas
  if (deps.broadcast) { deps.broadcast(channel, payload); return; }
}

/** Tenta achar a BrowserWindow dona de uma webContents de webview. */
function ownerWindow(wc) {
  // O hostWebContents aponta para a página que embute a <webview>.
  try {
    const { BrowserWindow } = require('electron');
    const hostWC = wc.hostWebContents;
    if (hostWC) {
      const win = BrowserWindow.fromWebContents(hostWC);
      if (win) return win;
    }
  } catch {}
  // fallback: primeira janela disponível
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
