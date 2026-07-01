'use strict';

/**
 * menu.js — Native Electron Application Menu (feature parity with the browser).
 *
 * Why native menu: accelerators registered here work EVEN when focus is
 * inside the <webview> (renderer keydown is consumed there). Each navigation/tab/zoom item
 * fires `win.webContents.send('menu:action', name)` to the renderer, which has
 * `dispatchMenu(name)` as the single source of truth. Edit items (undo/redo/cut/copy/paste/selectAll)
 * use Electron's native roles, which operate on the focused field for free.
 *
 * `getActiveWin()` resolves the target window at click time (multi-window).
 */

const { Menu, app } = require('electron');

const isMac = process.platform === 'darwin';

/**
 * Builds (and returns) the application Menu.
 * @param {() => import('electron').BrowserWindow | null} getActiveWin
 */
function buildMenu(getActiveWin) {
  // Helper: sends an action to the active window's renderer.
  const send = (name) => {
    const win = getActiveWin && getActiveWin();
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('menu:action', name); } catch {}
    }
  };
  const item = (label, accelerator, action) => ({ label, accelerator, click: () => send(action) });

  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const template = [];

  // ── App menu (macOS only) ──────────────────────────────────────────────
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { label: `About ${app.name}`, click: () => send('about') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('settings') },
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

  // ── File ───────────────────────────────────────────────────────────────
  template.push({
    label: 'File',
    submenu: [
      item('New Tab', 'CmdOrCtrl+T', 'new-tab'),
      item('New Window', 'CmdOrCtrl+N', 'new-window'),
      item('New Incognito Window', 'CmdOrCtrl+Shift+N', 'new-window-incognito'),
      { type: 'separator' },
      item('Reopen Closed Tab', 'CmdOrCtrl+Shift+T', 'reopen-tab'),
      { type: 'separator' },
      item('Close Tab', 'CmdOrCtrl+W', 'close-tab'),
      item('Print…', 'CmdOrCtrl+P', 'print'),
      ...(!isMac
        ? [{ type: 'separator' }, { role: 'quit', label: 'Exit' }]
        : []),
    ],
  });

  // ── Edit (native roles: operate on the focused field) ───────────────────────
  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo', label: 'Undo' },
      { role: 'redo', label: 'Redo' },
      { type: 'separator' },
      { role: 'cut', label: 'Cut' },
      { role: 'copy', label: 'Copy' },
      { role: 'paste', label: 'Paste' },
      { role: 'selectAll', label: 'Select All' },
      { type: 'separator' },
      item('Find on Page…', 'CmdOrCtrl+F', 'find'),
      item('Find Next', 'CmdOrCtrl+G', 'find-next'),
      item('Find Previous', 'CmdOrCtrl+Shift+G', 'find-prev'),
    ],
  });

  // ── View ────────────────────────────────────────────────────────────────────
  template.push({
    label: 'View',
    submenu: [
      item('Reload', 'CmdOrCtrl+R', 'reload'),
      item('Hard Reload', 'CmdOrCtrl+Shift+R', 'hard-reload'),
      // 'Stop' WITHOUT accelerator: Esc is owned by the renderer (closes findbar/omnibox before
      // stopping the load). An Esc accelerator in the native menu would consume the global Esc.
      { label: 'Stop', click: () => send('stop') },
      { type: 'separator' },
      item('Zoom In', 'CmdOrCtrl+Plus', 'zoom-in'),
      // second accelerator for '=' (keyboard without shift)
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', visible: false, click: () => send('zoom-in') },
      item('Zoom Out', 'CmdOrCtrl+-', 'zoom-out'),
      item('Reset Zoom', 'CmdOrCtrl+0', 'zoom-reset'),
      { type: 'separator' },
      item('Reader Mode', isMac ? 'Cmd+Alt+R' : 'Ctrl+Alt+R', 'reader'),
      item('Translate Page', undefined, 'translate'),
      { type: 'separator' },
      item('Toggle Theme', 'CmdOrCtrl+Shift+L', 'toggle-theme'),
      { type: 'separator' },
      item('Developer Tools', isMac ? 'Cmd+Alt+I' : 'Ctrl+Shift+I', 'devtools'),
    ],
  });

  // ── Bookmarks ─────────────────────────────────────────────────────────────────
  template.push({
    label: 'Bookmarks',
    submenu: [
      item('Bookmark Page', 'CmdOrCtrl+D', 'bookmark-page'),
      item('Show Bookmarks Bar', 'CmdOrCtrl+Shift+B', 'toggle-bookmarks-bar'),
      { type: 'separator' },
      { label: 'Manage Bookmarks', click: () => send('show-bookmarks') },
    ],
  });

  // ── History ───────────────────────────────────────────────────────────────
  template.push({
    label: 'History',
    submenu: [
      item('Home', 'CmdOrCtrl+Shift+H', 'home'),
      item('Back', 'CmdOrCtrl+[', 'back'),
      item('Forward', 'CmdOrCtrl+]', 'forward'),
      { type: 'separator' },
      item('Show History', isMac ? 'Cmd+Y' : 'Ctrl+H', 'history'),
      item('Downloads', isMac ? 'Cmd+Shift+J' : 'Ctrl+J', 'downloads'),
      { type: 'separator' },
      item('Clear Browsing Data…', 'CmdOrCtrl+Shift+Delete', 'clear-data'),
    ],
  });

  // ── Tab ──────────────────────────────────────────────────────────────────────
  template.push({
    label: 'Tab',
    submenu: [
      item('Next Tab', 'Ctrl+Tab', 'next-tab'),
      item('Previous Tab', 'Ctrl+Shift+Tab', 'prev-tab'),
      { type: 'separator' },
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
        item(`Go to Tab ${n}`, `CmdOrCtrl+${n}`, `goto-tab-${n}`),
      ),
      item('Last Tab', 'CmdOrCtrl+9', 'goto-tab-last'),
    ],
  });

  // ── Window ────────────────────────────────────────────────────────────────────
  template.push({
    label: 'Window',
    submenu: [
      { role: 'minimize', label: 'Minimize' },
      { role: 'zoom', label: 'Zoom' },
      ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close', label: 'Close' }]),
    ],
  });

  // ── Help ─────────────────────────────────────────────────────────────────────
  template.push({
    role: 'help',
    label: 'Help',
    submenu: [
      { label: `About ${app.name}`, click: () => send('about') },
      ...(!isMac ? [{ label: 'Settings…', accelerator: 'Ctrl+,', click: () => send('settings') }] : []),
    ],
  });

  const menu = Menu.buildFromTemplate(template);
  return menu;
}

module.exports = { buildMenu };
