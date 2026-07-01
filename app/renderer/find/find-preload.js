'use strict';

// Bridge for the floating "Find in Page" bar (OS window) with main.
// The search runs in the active <webview>, in main (wc.findInPage). This window only sends
// the query and receives the counter (n/N) back.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('findPopup', {
  // initial theme sent by main on did-finish-load
  onData: (cb) => ipcRenderer.on('find:data', (_e, d) => cb(d)),
  // updated counter (found-in-page of active tab) → { activeMatchOrdinal, matches }
  onResult: (cb) => ipcRenderer.on('find:count', (_e, d) => cb(d)),
  // triggers/advances search in active tab
  query: (text, opts) => ipcRenderer.send('find:query', { text, options: opts || {} }),
  // stops search (clears selection) without closing window
  stop: () => ipcRenderer.send('find:stopActive'),
  // closes bar (stops search + destroys window)
  close: () => ipcRenderer.send('find:close'),
});
