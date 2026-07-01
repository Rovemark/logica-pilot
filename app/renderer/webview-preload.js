'use strict';

/**
 * webview-preload.js — Minimal and guarded preload for <webview> instances.
 *
 * Runs inside EACH <webview> (guest). Its only function is to provide INTERNAL
 * PAGES (pilot://…, e.g., the home/dashboard pilot://newtab) with a secure channel
 * to request that the shell (embedder) open the Pilot panel or a new tab.
 *
 * 🔒 SECURITY GUARD (non-negotiable):
 *   The API is only exposed when `location.protocol === 'pilot:'`. On ANY
 *   normal website (http/https/file/about/…) NOTHING is exposed — the site never receives
 *   `window.lpHome`. This way web pages cannot open Pilot or create
 *   tabs on their own.
 *
 * Channel: uses `ipcRenderer.sendToHost(channel, payload)` — webview→embedder
 * message, which the shell's renderer receives via
 * `wv.addEventListener('ipc-message', …)`. There is NO access to ipcMain from here.
 */

const { ipcRenderer, contextBridge } = require('electron');

// 🔒 Protocol guard: only internal pilot:// pages receive the API.
if (location.protocol === 'pilot:') {
  const api = {
    // Requests the shell to open the Pilot panel pre-filled with the objective.
    // The shell decides (prefill + focus; does NOT auto-run).
    pilot: (objective) => ipcRenderer.sendToHost('home:pilot', String(objective || '')),
    // Requests the shell to open a URL in a new tab.
    openTab: (url) => ipcRenderer.sendToHost('home:open', String(url || '')),
  };

  // Primary path: contextBridge (contextIsolation enabled).
  // Fallback: if contextIsolation is disabled, inject directly into window.
  try {
    contextBridge.exposeInMainWorld('lpHome', api);
  } catch (_e) {
    try { window.lpHome = api; } catch (_e2) { /* no channel — no-op */ }
  }
}
