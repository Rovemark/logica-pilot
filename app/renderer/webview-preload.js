'use strict';

/**
 * webview-preload.js — Preload MÍNIMO e GUARDADO das <webview>.
 *
 * Roda dentro de CADA <webview> (guest). Sua única função é dar às PÁGINAS
 * INTERNAS (pilot://…, ex.: a home/dashboard pilot://newtab) um canal seguro
 * para pedir à casca (embedder) que abra o painel Pilot ou uma nova aba.
 *
 * 🔒 GUARDA DE SEGURANÇA (não negociável):
 *   A API só é exposta quando `location.protocol === 'pilot:'`. Em QUALQUER
 *   site normal (http/https/file/about/…) NADA é exposto — o site nunca recebe
 *   `window.lpHome`. Assim páginas web não conseguem abrir o Pilot nem criar
 *   abas por conta própria.
 *
 * Canal: usa `ipcRenderer.sendToHost(channel, payload)` — mensagem
 * webview→embedder, que o renderer da casca recebe via
 * `wv.addEventListener('ipc-message', …)`. NÃO há acesso ao ipcMain daqui.
 */

const { ipcRenderer, contextBridge } = require('electron');

// 🔒 Guarda por protocolo: só páginas internas pilot:// recebem a API.
if (location.protocol === 'pilot:') {
  const api = {
    // Pede à casca para abrir o painel Pilot já preenchido com o objetivo.
    // A casca decide (prefill + foco; NÃO auto-roda).
    pilot: (objective) => ipcRenderer.sendToHost('home:pilot', String(objective || '')),
    // Pede à casca para abrir uma URL em nova aba.
    openTab: (url) => ipcRenderer.sendToHost('home:open', String(url || '')),
  };

  // Caminho primário: contextBridge (contextIsolation ligado).
  // Fallback: se contextIsolation estiver desligado, injeta direto no window.
  try {
    contextBridge.exposeInMainWorld('lpHome', api);
  } catch (_e) {
    try { window.lpHome = api; } catch (_e2) { /* sem canal — no-op */ }
  }
}
