'use strict';

// Bridge for menu popup (custom floating window) with the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('menuPopup', {
  onData: (cb) => ipcRenderer.on('menu:data', (_e, d) => cb(d)),
  choose: (action) => ipcRenderer.send('appmenu:choose', action),
  close: () => ipcRenderer.send('appmenu:close'),
});
