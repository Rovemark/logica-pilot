'use strict';

// Ponte do popup de menu (janela flutuante custom) com o processo principal.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('menuPopup', {
  onData: (cb) => ipcRenderer.on('menu:data', (_e, d) => cb(d)),
  choose: (action) => ipcRenderer.send('appmenu:choose', action),
  close: () => ipcRenderer.send('appmenu:close'),
});
