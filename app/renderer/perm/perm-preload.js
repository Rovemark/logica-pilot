'use strict';

// Bridge for floating permission prompt (OS window) with the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('permPopup', {
  // Opening data ({ text, dark }) sent by main on did-finish-load
  onData: (cb) => ipcRenderer.on('perm:data', (_e, d) => cb(d)),
  // User made a decision (granted = true/false) → main responds to permission and closes
  respond: (granted) => ipcRenderer.send('perm:respond', !!granted),
});
