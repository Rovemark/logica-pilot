'use strict';

// Bridge between the floating omnibox suggestion list (system window) and the main process.
// The window is NON-FOCUSABLE: the address bar of the parent window retains focus and handles
// keyboard input. This window only DISPLAYS the list (onData) and sends back the index of the CLICK
// (choose) to the main process, which forwards it to the main renderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('omniPopup', {
  // receives { items, selected, dark } — renders the list + the selected index.
  // the same channel serves for initial opening and for each update (does not recreate the window).
  onData: (cb) => ipcRenderer.on('omni:data', (_e, d) => cb(d)),
  // user CLICKED a suggestion → sends the chosen index to the main process.
  choose: (index) => ipcRenderer.send('omni:choose', index),
});
