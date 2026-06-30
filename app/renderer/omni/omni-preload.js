'use strict';

// Ponte da lista de sugestões da omnibox flutuante (janela do SO) com o main.
// A janela é NÃO-FOCÁVEL: a barra de endereço da janela-mãe mantém o foco e trata
// o teclado. Esta janela só EXIBE a lista (onData) e manda o índice do CLIQUE
// (choose) de volta ao main, que repassa ao renderer principal.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('omniPopup', {
  // recebe { items, selected, dark } — renderiza a lista + o índice selecionado.
  // mesmo canal serve p/ abertura inicial e p/ cada atualização (não recria a janela).
  onData: (cb) => ipcRenderer.on('omni:data', (_e, d) => cb(d)),
  // usuário CLICOU numa sugestão → manda o índice escolhido ao main.
  choose: (index) => ipcRenderer.send('omni:choose', index),
});
