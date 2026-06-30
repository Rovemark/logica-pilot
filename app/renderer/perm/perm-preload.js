'use strict';

// Ponte do prompt de permissão flutuante (janela do SO) com o processo principal.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('permPopup', {
  // dados de abertura ({ text, dark }) enviados pelo main no did-finish-load
  onData: (cb) => ipcRenderer.on('perm:data', (_e, d) => cb(d)),
  // o usuário decidiu (granted = true/false) → main responde a permissão e fecha
  respond: (granted) => ipcRenderer.send('perm:respond', !!granted),
});
