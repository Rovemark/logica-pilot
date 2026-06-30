'use strict';

/**
 * menu.js — Application Menu nativo do Electron (paridade Chrome).
 *
 * Por que menu nativo: os accelerators registrados aqui funcionam MESMO com o foco
 * dentro do <webview> (o keydown do renderer é engolido lá dentro). Cada item de
 * navegação/aba/zoom dispara `win.webContents.send('menu:action', name)` para o
 * renderer, que tem o `dispatchMenu(name)` como fonte única de verdade. Itens de
 * edição (undo/redo/cut/copy/paste/selectAll) usam os roles nativos do Electron,
 * que operam no campo com foco de graça.
 *
 * `getActiveWin()` resolve a janela-alvo na hora do clique (multi-janela).
 */

const { Menu, app } = require('electron');

const isMac = process.platform === 'darwin';

/**
 * Constrói (e devolve) o Menu da aplicação.
 * @param {() => import('electron').BrowserWindow | null} getActiveWin
 */
function buildMenu(getActiveWin) {
  // Helper: manda uma ação ao renderer da janela ativa.
  const send = (name) => {
    const win = getActiveWin && getActiveWin();
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('menu:action', name); } catch {}
    }
  };
  const item = (label, accelerator, action) => ({ label, accelerator, click: () => send(action) });

  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const template = [];

  // ── App menu (somente macOS) ──────────────────────────────────────────────
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { label: `Sobre o ${app.name}`, click: () => send('about') },
        { type: 'separator' },
        { label: 'Configurações…', accelerator: 'Cmd+,', click: () => send('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  // ── Arquivo ───────────────────────────────────────────────────────────────
  template.push({
    label: 'Arquivo',
    submenu: [
      item('Nova aba', 'CmdOrCtrl+T', 'new-tab'),
      item('Nova janela', 'CmdOrCtrl+N', 'new-window'),
      item('Nova janela anônima', 'CmdOrCtrl+Shift+N', 'new-window-incognito'),
      { type: 'separator' },
      item('Reabrir aba fechada', 'CmdOrCtrl+Shift+T', 'reopen-tab'),
      { type: 'separator' },
      item('Fechar aba', 'CmdOrCtrl+W', 'close-tab'),
      item('Imprimir…', 'CmdOrCtrl+P', 'print'),
      ...(!isMac
        ? [{ type: 'separator' }, { role: 'quit', label: 'Sair' }]
        : []),
    ],
  });

  // ── Editar (roles nativos: operam no campo com foco) ───────────────────────
  template.push({
    label: 'Editar',
    submenu: [
      { role: 'undo', label: 'Desfazer' },
      { role: 'redo', label: 'Refazer' },
      { type: 'separator' },
      { role: 'cut', label: 'Recortar' },
      { role: 'copy', label: 'Copiar' },
      { role: 'paste', label: 'Colar' },
      { role: 'selectAll', label: 'Selecionar tudo' },
      { type: 'separator' },
      item('Localizar na página…', 'CmdOrCtrl+F', 'find'),
      item('Localizar próximo', 'CmdOrCtrl+G', 'find-next'),
      item('Localizar anterior', 'CmdOrCtrl+Shift+G', 'find-prev'),
    ],
  });

  // ── Ver ────────────────────────────────────────────────────────────────────
  template.push({
    label: 'Ver',
    submenu: [
      item('Recarregar', 'CmdOrCtrl+R', 'reload'),
      item('Recarregar sem cache', 'CmdOrCtrl+Shift+R', 'hard-reload'),
      // 'Parar' SEM acelerador: o Esc é dono do renderer (fecha findbar/omnibox antes
      // de parar o loading). Um acelerador Esc no menu nativo engoliria o Esc global.
      { label: 'Parar', click: () => send('stop') },
      { type: 'separator' },
      item('Aumentar zoom', 'CmdOrCtrl+Plus', 'zoom-in'),
      // segundo acelerador para o '=' (teclado sem shift)
      { label: 'Aumentar zoom', accelerator: 'CmdOrCtrl+=', visible: false, click: () => send('zoom-in') },
      item('Diminuir zoom', 'CmdOrCtrl+-', 'zoom-out'),
      item('Tamanho normal', 'CmdOrCtrl+0', 'zoom-reset'),
      { type: 'separator' },
      item('Modo leitor', isMac ? 'Cmd+Alt+R' : 'Ctrl+Alt+R', 'reader'),
      item('Traduzir página', undefined, 'translate'),
      { type: 'separator' },
      item('Alternar tema', 'CmdOrCtrl+Shift+L', 'toggle-theme'),
      { type: 'separator' },
      item('Ferramentas do desenvolvedor', isMac ? 'Cmd+Alt+I' : 'Ctrl+Shift+I', 'devtools'),
    ],
  });

  // ── Favoritos ─────────────────────────────────────────────────────────────────
  template.push({
    label: 'Favoritos',
    submenu: [
      item('Favoritar página', 'CmdOrCtrl+D', 'bookmark-page'),
      item('Mostrar barra de favoritos', 'CmdOrCtrl+Shift+B', 'toggle-bookmarks-bar'),
      { type: 'separator' },
      { label: 'Gerenciar favoritos', click: () => send('show-bookmarks') },
    ],
  });

  // ── Histórico ───────────────────────────────────────────────────────────────
  template.push({
    label: 'Histórico',
    submenu: [
      item('Página inicial', 'CmdOrCtrl+Shift+H', 'home'),
      item('Voltar', 'CmdOrCtrl+[', 'back'),
      item('Avançar', 'CmdOrCtrl+]', 'forward'),
      { type: 'separator' },
      item('Mostrar histórico', isMac ? 'Cmd+Y' : 'Ctrl+H', 'history'),
      item('Downloads', isMac ? 'Cmd+Shift+J' : 'Ctrl+J', 'downloads'),
      { type: 'separator' },
      item('Limpar dados de navegação…', 'CmdOrCtrl+Shift+Delete', 'clear-data'),
    ],
  });

  // ── Aba ──────────────────────────────────────────────────────────────────────
  template.push({
    label: 'Aba',
    submenu: [
      item('Próxima aba', 'Ctrl+Tab', 'next-tab'),
      item('Aba anterior', 'Ctrl+Shift+Tab', 'prev-tab'),
      { type: 'separator' },
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
        item(`Ir para aba ${n}`, `CmdOrCtrl+${n}`, `goto-tab-${n}`),
      ),
      item('Última aba', 'CmdOrCtrl+9', 'goto-tab-last'),
    ],
  });

  // ── Janela ────────────────────────────────────────────────────────────────────
  template.push({
    label: 'Janela',
    submenu: [
      { role: 'minimize', label: 'Minimizar' },
      { role: 'zoom', label: 'Zoom' },
      ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close', label: 'Fechar' }]),
    ],
  });

  // ── Ajuda ─────────────────────────────────────────────────────────────────────
  template.push({
    role: 'help',
    label: 'Ajuda',
    submenu: [
      { label: `Sobre o ${app.name}`, click: () => send('about') },
      ...(!isMac ? [{ label: 'Configurações…', accelerator: 'Ctrl+,', click: () => send('settings') }] : []),
    ],
  });

  const menu = Menu.buildFromTemplate(template);
  return menu;
}

module.exports = { buildMenu };
