'use strict';

// Bridge for the floating panel (Settings/About) with the main process.
// REUSES the existing IPC channels from main (theme:set, settings:get/set,
// search:getEngines, data:clear, app:info). New channels: only panel:open/panel:close.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panel', {
  // data sent from main on did-finish-load ({ type, dark })
  onData: (cb) => ipcRenderer.on('panel:data', (_e, d) => cb(d)),
  close: () => ipcRenderer.send('panel:close'),

  // ── reused channels (same as shell preload.js) ──
  appInfo: () => ipcRenderer.invoke('app:info'),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  getEngines: () => ipcRenderer.invoke('search:getEngines'),
  setTheme: (payload) => ipcRenderer.invoke('theme:set', payload),
  clearData: (opts) => ipcRenderer.invoke('data:clear', opts || {}),

  // proof of browser engine version from process.versions (no IPC)
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    v8: process.versions.v8,
    node: process.versions.node,
  },
});
