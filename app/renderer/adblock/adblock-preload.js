'use strict';

// Bridge for the ad-block panel (frameless floating window) with the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('adblockPanel', {
  onData: (cb) => ipcRenderer.on('adblock:panel-data', (_e, d) => cb(d)),
  refresh: () => ipcRenderer.invoke('adblock:panel-data'),
  toggle: () => ipcRenderer.invoke('adblock:toggle'),
  setAllowlist: (host, allowed) => ipcRenderer.invoke('adblock:setAllowlist', { host, allowed }),
  reloadActive: () => ipcRenderer.send('adblock:reload-active'),
  close: () => ipcRenderer.send('adblock:panel-close'),
});
