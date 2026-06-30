'use strict';

// Ponte da barra "Localizar na página" flutuante (janela do SO) com o main.
// A busca roda na <webview> ativa, no main (wc.findInPage). Esta janela só manda
// a query e recebe o contador (n/N) de volta.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('findPopup', {
  // tema inicial enviado pelo main no did-finish-load
  onData: (cb) => ipcRenderer.on('find:data', (_e, d) => cb(d)),
  // contador atualizado (found-in-page da aba ativa) → { activeMatchOrdinal, matches }
  onResult: (cb) => ipcRenderer.on('find:count', (_e, d) => cb(d)),
  // dispara/avança a busca na aba ativa
  query: (text, opts) => ipcRenderer.send('find:query', { text, options: opts || {} }),
  // para a busca (limpa seleção) sem fechar a janela
  stop: () => ipcRenderer.send('find:stopActive'),
  // fecha a barra (para a busca + destrói a janela)
  close: () => ipcRenderer.send('find:close'),
});
