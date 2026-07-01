'use strict';

/**
 * bookmarks-store.js — Persistent bookmarks (parity with Chrome).
 *
 * Stores entries { url, title, favicon, ts } in userData/bookmarks.json with
 * debounced writes. Dedup by URL (one URL = one bookmark). Feeds the omnibox star,
 * the bookmarks bar, and the bookmark manager.
 *
 * Same PATTERN as history-store.js / settings.js: init(userData),
 * state in memory, debounce + flush, tolerant to missing/corrupted disk.
 */

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 5000; // hard ceiling so the file doesn't grow unbounded

let filePath = null;
/** @type {Map<string, {url,title,favicon,ts}>} insertion order = bookmarks bar order */
let byUrl = new Map();
let writeTimer = null;

/** Initializes pointing to the user data directory. */
function init(userDataDir) {
  filePath = path.join(userDataDir, 'bookmarks.json');
  load();
}

function load() {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      byUrl = new Map();
      for (const e of arr) {
        if (e && typeof e.url === 'string') byUrl.set(e.url, normalize(e));
      }
    }
  } catch {
    byUrl = new Map();
  }
}

function normalize(e) {
  return {
    url: String(e.url),
    title: typeof e.title === 'string' && e.title ? e.title : String(e.url),
    favicon: typeof e.favicon === 'string' ? e.favicon : '',
    ts: Number.isFinite(e.ts) ? e.ts : Date.now(),
  };
}

/** Internal/empty URLs are not bookmarkable (no point in saving pilot://newtab). */
function isBookmarkable(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('about:')) return false;
  if (url.startsWith('chrome://') || url.startsWith('devtools://')) return false;
  // pilot:// (newtab) does not become a bookmark; http/https/file do
  if (url.startsWith('pilot://')) return false;
  return /^https?:\/\//i.test(url) || /^file:\/\//i.test(url);
}

/** List (array) in insertion order — this is how the bookmarks bar displays it. */
function list() {
  return [...byUrl.values()].map((e) => ({ ...e }));
}

function isBookmarked(url) {
  return !!url && byUrl.has(url);
}

/** Adds/updates a bookmark (dedup by url). Returns the saved record (or null). */
function add({ url, title, favicon, ts } = {}) {
  if (!isBookmarkable(url)) return null;
  const now = Number.isFinite(ts) ? ts : Date.now();
  const existing = byUrl.get(url);
  if (existing) {
    // updates metadata without losing position in the bar
    if (title) existing.title = title;
    if (favicon) existing.favicon = favicon;
    scheduleWrite();
    return { ...existing };
  }
  const rec = normalize({ url, title, favicon, ts: now });
  byUrl.set(url, rec);
  enforceCap();
  scheduleWrite();
  return { ...rec };
}

/** Removes a bookmark by URL. Returns true if removed. */
function remove(url) {
  const ok = byUrl.delete(url);
  if (ok) scheduleWrite();
  return ok;
}

/**
 * Toggles the bookmark for a URL. Returns { bookmarked: bool } with the FINAL state.
 * If it wasn't bookmarked → adds it (requires title/favicon); if it was → removes it.
 */
function toggle({ url, title, favicon } = {}) {
  if (!isBookmarkable(url)) return { bookmarked: false };
  if (byUrl.has(url)) {
    byUrl.delete(url);
    scheduleWrite();
    return { bookmarked: false };
  }
  add({ url, title, favicon });
  return { bookmarked: true };
}

/** Edits an existing bookmark (partial patch: title/favicon/url). Returns the record or null. */
function update(url, patch = {}) {
  const existing = byUrl.get(url);
  if (!existing) return null;
  const next = { ...existing };
  if (typeof patch.title === 'string' && patch.title) next.title = patch.title;
  if (typeof patch.favicon === 'string') next.favicon = patch.favicon;

  // URL change (re-keys while preserving relative position)
  if (typeof patch.url === 'string' && patch.url && patch.url !== url) {
    if (!isBookmarkable(patch.url)) return { ...existing };
    next.url = patch.url;
    // rebuilds the Map preserving order, swapping the entry in place
    const rebuilt = new Map();
    for (const [k, v] of byUrl) {
      if (k === url) rebuilt.set(next.url, normalize(next));
      else if (k === next.url) continue; // avoids duplication if it already existed
      else rebuilt.set(k, v);
    }
    byUrl = rebuilt;
    scheduleWrite();
    return { ...next };
  }

  byUrl.set(url, normalize(next));
  scheduleWrite();
  return { ...next };
}

/** If the ceiling is exceeded, removes the oldest bookmarks. */
function enforceCap() {
  if (byUrl.size <= MAX_ENTRIES) return;
  const all = [...byUrl.values()].sort((a, b) => a.ts - b.ts);
  const toRemove = byUrl.size - MAX_ENTRIES;
  for (let i = 0; i < toRemove; i++) byUrl.delete(all[i].url);
}

function scheduleWrite() {
  if (!filePath) return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 300);
  if (writeTimer.unref) writeTimer.unref();
}

function flush() {
  if (!filePath) return;
  try {
    fs.writeFileSync(filePath, JSON.stringify([...byUrl.values()], null, 2), 'utf8');
  } catch {
    // disk unavailable — bookmarks remain in memory only
  }
}

module.exports = {
  init,
  list,
  add,
  remove,
  toggle,
  isBookmarked,
  update,
  flush,
};
