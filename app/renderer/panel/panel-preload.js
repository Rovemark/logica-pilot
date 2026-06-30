'use strict';

// Ponte do painel flutuante (Settings/About) com o processo principal.
// REUSA os canais IPC JÁ EXISTENTES do main (theme:set, settings:get/set,
// search:getEngines, data:clear, app:info). Canais novos: só panel:open/panel:close.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panel', {
  // dados de abertura ({ type, dark }) enviados pelo main no did-finish-load
  onData: (cb) => ipcRenderer.on('panel:data', (_e, d) => cb(d)),
  close: () => ipcRenderer.send('panel:close'),

  // ── canais reusados (mesmos do preload.js da casca) ──
  appInfo: () => ipcRenderer.invoke('app:info'),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  getEngines: () => ipcRenderer.invoke('search:getEngines'),
  setTheme: (payload) => ipcRenderer.invoke('theme:set', payload),
  clearData: (opts) => ipcRenderer.invoke('data:clear', opts || {}),

  // prova de Chromium direto do process.versions (sem IPC)
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    v8: process.versions.v8,
    node: process.versions.node,
  },
});
