'use strict';

/**
 * adblock-manager.js — Native ad & tracker blocking for Logica Pilot.
 *
 * Uses @ghostery/adblocker-electron: webRequest-based network blocking with the
 * standard filter lists (EasyList + EasyPrivacy) plus cosmetic filtering. This is
 * the reliable way to block ads inside Electron — MV3 extensions
 * (declarativeNetRequest) are NOT reliably applied to embedded content, so a
 * native engine is what real Electron browsers use.
 *
 * The engine attaches to the SAME session the <webview> tabs live in
 * ('persist:logica-pilot'), so blocking covers every tab. The serialized engine
 * is cached on disk so subsequent launches are instant and work offline.
 *
 * Per-site allow (allowlist): the engine has no per-hostname toggle, but it
 * extends FiltersEngine, so we inject an exception filter at runtime via
 * updateFromDiff({added:['@@||host^$document,elemhide']}) — the uBlock-equivalent
 * "allow ads on this site". This is in-memory only, so the allowlist is persisted
 * to settings and replayed on every init.
 */

const path = require('path');
const fs = require('fs');

let ElectronBlocker = null;
try {
  ({ ElectronBlocker } = require('@ghostery/adblocker-electron'));
} catch (e) {
  console.error('[adblock] library unavailable:', e && e.message);
}

let blocker = null;
let _session = null;
let _enabled = false;
let blockedCount = 0;
const allowlist = new Set();       // normalized hostnames where blocking is disabled
const perTab = new Map();          // tabId (webContents id) → blocked count this page
let _saveAllowlist = () => {};     // (arr) => void — persists the allowlist to settings
const listeners = new Set();       // (count) => void — UI badge updates

const LISTS = ['EasyList', 'EasyPrivacy'];

function _norm(h) { return String(h || '').replace(/^www\./i, '').toLowerCase().trim(); }
function _allowFilter(h) { return '@@||' + _norm(h) + '^$document,elemhide'; }

/**
 * Builds the engine (cached) and applies blocking to the session if enabled.
 * @param {Electron.Session} ses          session of the webviews' partition
 * @param {object} opts
 * @param {boolean}  opts.enabled          start with blocking on
 * @param {string}   opts.userDataDir      where to cache the serialized engine
 * @param {string[]} opts.initialAllowlist hostnames to pre-allow (from settings)
 * @param {Function} opts.saveAllowlist    (arr) => void — persist the allowlist
 */
async function init(ses, { enabled = true, userDataDir, initialAllowlist, saveAllowlist } = {}) {
  if (!ElectronBlocker || !ses) return null;
  _session = ses;
  if (typeof saveAllowlist === 'function') _saveAllowlist = saveAllowlist;

  if (!blocker) {
    const cachePath = userDataDir ? path.join(userDataDir, 'adblock-engine.bin') : null;
    const caching = cachePath
      ? { path: cachePath, read: fs.promises.readFile, write: fs.promises.writeFile }
      : undefined;
    try {
      blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, caching);
    } catch (e) {
      try {
        blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);
      } catch (e2) {
        console.error('[adblock] failed to build engine:', (e2 && e2.message) || (e && e.message));
        blocker = null;
        return null;
      }
    }
    try {
      blocker.on('request-blocked', (req) => {
        blockedCount++;
        try { const t = req && req.tabId; if (t != null) perTab.set(t, (perTab.get(t) || 0) + 1); } catch {}
        notify();
      });
    } catch {}
    console.log('[adblock] engine ready');
  }

  // Replay the persisted per-site allowlist into the engine (in-memory exceptions).
  if (Array.isArray(initialAllowlist)) {
    for (const raw of initialAllowlist) {
      const h = _norm(raw);
      if (h && !allowlist.has(h)) {
        allowlist.add(h);
        try { blocker.updateFromDiff({ added: [_allowFilter(h)] }); } catch {}
      }
    }
  }

  setEnabled(enabled);
  return blocker;
}

/** Turns blocking on/off for the wired session. Returns the effective state. */
function setEnabled(on) {
  const want = !!on;
  if (!blocker || !_session) { _enabled = want; return _enabled; }
  try {
    if (want && !_enabled) blocker.enableBlockingInSession(_session);
    else if (!want && _enabled) blocker.disableBlockingInSession(_session);
  } catch (e) {
    console.error('[adblock] toggle failed:', e && e.message);
  }
  _enabled = want;
  return _enabled;
}

/** Adds a host to the allowlist (ads allowed on that site). */
function addAllowlist(host) {
  const h = _norm(host);
  if (!h || allowlist.has(h)) return false;
  allowlist.add(h);
  if (blocker) { try { blocker.updateFromDiff({ added: [_allowFilter(h)] }); } catch (e) { console.error('[adblock] allow add:', e && e.message); } }
  try { _saveAllowlist([...allowlist]); } catch {}
  return true;
}

/** Removes a host from the allowlist (blocking resumes on that site). */
function removeAllowlist(host) {
  const h = _norm(host);
  if (!h || !allowlist.has(h)) return false;
  allowlist.delete(h);
  if (blocker) { try { blocker.updateFromDiff({ removed: [_allowFilter(h)] }); } catch (e) { console.error('[adblock] allow remove:', e && e.message); } }
  try { _saveAllowlist([...allowlist]); } catch {}
  return true;
}

/** Convenience: allowed=true → allow ads on host; false → resume blocking. */
function setAllowed(host, allowed) {
  return allowed ? addAllowlist(host) : removeAllowlist(host);
}

function isAllowlisted(host) { return allowlist.has(_norm(host)); }
function perPageCount(tabId) { return (tabId != null && perTab.get(tabId)) || 0; }
function resetTab(tabId) { if (tabId != null) perTab.delete(tabId); }

/** Snapshot for the ad-block panel. */
function getStats(host, tabId) {
  return {
    available: !!ElectronBlocker,
    enabled: _enabled,
    count: blockedCount,
    pageCount: perPageCount(tabId),
    host: host || null,
    allowed: host ? isAllowlisted(host) : false,
    lists: LISTS,
  };
}

function isEnabled() { return _enabled; }
function isAvailable() { return !!ElectronBlocker; }
function getCount() { return blockedCount; }

/** Subscribe to blocked-count changes (for the toolbar badge). Returns an unsubscribe fn. */
function onCount(cb) { listeners.add(cb); return () => listeners.delete(cb); }
function notify() { for (const cb of listeners) { try { cb(blockedCount); } catch {} } }

module.exports = {
  init,
  setEnabled,
  isEnabled,
  isAvailable,
  getCount,
  onCount,
  addAllowlist,
  removeAllowlist,
  setAllowed,
  isAllowlisted,
  perPageCount,
  resetTab,
  getStats,
};
