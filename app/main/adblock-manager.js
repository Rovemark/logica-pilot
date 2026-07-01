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

let _cachePath = null;             // serialized-engine cache on disk
let _refreshTimer = null;          // periodic filter-list refresh
let _updatedAt = 0;                // epoch ms of the last successful list refresh
let _saveUpdatedAt = () => {};     // (ts) => void — persists the refresh timestamp

const LISTS = ['EasyList', 'EasyPrivacy'];
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h

function _norm(h) { return String(h || '').replace(/^www\./i, '').toLowerCase().trim(); }
function _allowFilter(h) { return '@@||' + _norm(h) + '^$document,elemhide'; }

/** Wires the blocked-request counter onto an engine instance (used on init + refresh). */
function wireBlockedListener(b) {
  try {
    b.on('request-blocked', (req) => {
      blockedCount++;
      try { const t = req && req.tabId; if (t != null) perTab.set(t, (perTab.get(t) || 0) + 1); } catch {}
      notify();
    });
  } catch {}
}

/**
 * Builds the engine (cached) and applies blocking to the session if enabled.
 * @param {Electron.Session} ses          session of the webviews' partition
 * @param {object} opts
 * @param {boolean}  opts.enabled          start with blocking on
 * @param {string}   opts.userDataDir      where to cache the serialized engine
 * @param {string[]} opts.initialAllowlist hostnames to pre-allow (from settings)
 * @param {Function} opts.saveAllowlist    (arr) => void — persist the allowlist
 */
async function init(ses, { enabled = true, userDataDir, initialAllowlist, saveAllowlist, updatedAt, saveUpdatedAt } = {}) {
  if (!ElectronBlocker || !ses) return null;
  _session = ses;
  if (typeof saveAllowlist === 'function') _saveAllowlist = saveAllowlist;
  if (typeof saveUpdatedAt === 'function') _saveUpdatedAt = saveUpdatedAt;
  if (typeof updatedAt === 'number') _updatedAt = updatedAt;

  if (!blocker) {
    _cachePath = userDataDir ? path.join(userDataDir, 'adblock-engine.bin') : null;
    const caching = _cachePath
      ? { path: _cachePath, read: fs.promises.readFile, write: fs.promises.writeFile }
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
    wireBlockedListener(blocker);
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

  // Filter lists would otherwise stay frozen at the first-launch snapshot (the cache's
  // fromCached only re-fetches when the .bin is missing/corrupt). Refresh shortly after
  // boot, then every 12h. Best-effort — a failed refresh never disables blocking.
  if (!_refreshTimer) {
    const boot = setTimeout(() => { refresh(); }, 30_000);
    if (boot.unref) boot.unref();
    _refreshTimer = setInterval(() => { refresh(); }, REFRESH_INTERVAL_MS);
    if (_refreshTimer.unref) _refreshTimer.unref();
  }

  return blocker;
}

/**
 * Rebuilds the engine from the remote lists, re-serializes the cache, hot-swaps it
 * into the session, and replays the allowlist. Silent no-op when offline.
 */
async function refresh() {
  if (!ElectronBlocker || !_session) return;
  let fresh;
  try {
    fresh = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);
  } catch {
    return; // offline / fetch failed — keep the current engine
  }
  try {
    if (_cachePath) { try { await fs.promises.writeFile(_cachePath, Buffer.from(fresh.serialize())); } catch {} }
    wireBlockedListener(fresh);
    for (const h of allowlist) { try { fresh.updateFromDiff({ added: [_allowFilter(h)] }); } catch {} }
    if (_enabled) {
      try { blocker.disableBlockingInSession(_session); } catch {}
      try { fresh.enableBlockingInSession(_session); } catch {}
    }
    blocker = fresh;
    _updatedAt = Date.now();
    try { _saveUpdatedAt(_updatedAt); } catch {}
    console.log('[adblock] filter lists refreshed');
  } catch (e) {
    console.error('[adblock] refresh failed:', e && e.message);
  }
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
    updatedAt: _updatedAt || null,
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
  refresh,
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
