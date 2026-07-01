'use strict';

/**
 * history-store.js — Persistent navigation history (Chrome parity).
 *
 * Stores entries { url, title, visitCount, lastVisit, firstVisit } in
 * userData/history.json with debounced writes. Dedup by URL (same URL increments visitCount).
 * Feeds omnibox suggestions (query) and new tab most-visited (topSites).
 */

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 5000; // hard cap so file doesn't grow unbounded

let filePath = null;
/** @type {Map<string, {url,title,visitCount,lastVisit,firstVisit}>} */
let byUrl = new Map();
let writeTimer = null;

/** Initializes pointing to user data directory. */
function init(userDataDir) {
  filePath = path.join(userDataDir, 'history.json');
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
    title: typeof e.title === 'string' ? e.title : '',
    visitCount: Number.isFinite(e.visitCount) ? e.visitCount : 1,
    lastVisit: Number.isFinite(e.lastVisit) ? e.lastVisit : Date.now(),
    firstVisit: Number.isFinite(e.firstVisit) ? e.firstVisit : Date.now(),
  };
}

/** Internal/empty URLs do not enter history. */
function isTrackable(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('pilot://')) return false;
  if (url.startsWith('about:')) return false;
  if (url.startsWith('chrome://') || url.startsWith('devtools://')) return false;
  if (url === 'about:blank') return false;
  return /^https?:\/\//i.test(url) || /^file:\/\//i.test(url);
}

/** Registers/updates a visit (dedup by url, increment visitCount, update title). */
function add({ url, title, ts } = {}) {
  if (!isTrackable(url)) return;
  const now = Number.isFinite(ts) ? ts : Date.now();
  const existing = byUrl.get(url);
  if (existing) {
    existing.visitCount += 1;
    existing.lastVisit = now;
    if (title) existing.title = title;
  } else {
    byUrl.set(url, {
      url,
      title: title || '',
      visitCount: 1,
      lastVisit: now,
      firstVisit: now,
    });
    enforceCap();
  }
  scheduleWrite();
}

/**
 * Updates ONLY the title of an already-existing URL (without incrementing visitCount).
 * Used by page-title-updated, which arrives after did-navigate (which creates the
 * entry with the old tab title). Prevents inflating visitCount by ~2x per navigation.
 */
function updateTitle(url, title) {
  if (!isTrackable(url) || !title) return;
  const existing = byUrl.get(url);
  if (existing) {
    existing.title = title;
    scheduleWrite();
  }
}

/** If exceeding the cap, removes least relevant entries (lower visitCount and older). */
function enforceCap() {
  if (byUrl.size <= MAX_ENTRIES) return;
  const all = [...byUrl.values()].sort((a, b) => {
    if (a.visitCount !== b.visitCount) return a.visitCount - b.visitCount;
    return a.lastVisit - b.lastVisit;
  });
  const toRemove = byUrl.size - MAX_ENTRIES;
  for (let i = 0; i < toRemove; i++) byUrl.delete(all[i].url);
}

/** Relevance score: frequency + recency (decays over time). */
function score(e) {
  const ageDays = (Date.now() - e.lastVisit) / 86400000;
  const recency = 1 / (1 + ageDays); // 1.0 today → decays over time
  return e.visitCount * 2 + recency * 5;
}

/** Suggestions by prefix (match on url or title), ordered by relevance. */
function query(prefix, limit = 8) {
  const p = String(prefix || '').toLowerCase().trim();
  let entries = [...byUrl.values()];
  if (p) {
    entries = entries.filter(
      (e) => e.url.toLowerCase().includes(p) || (e.title && e.title.toLowerCase().includes(p)),
    );
  }
  entries.sort((a, b) => score(b) - score(a));
  return entries.slice(0, Math.max(0, limit)).map((e) => ({
    url: e.url,
    title: e.title,
    visitCount: e.visitCount,
    lastVisit: e.lastVisit,
  }));
}

/** Most visited sites (for new tab grid). */
function topSites(limit = 8) {
  const entries = [...byUrl.values()].sort((a, b) => {
    if (b.visitCount !== a.visitCount) return b.visitCount - a.visitCount;
    return b.lastVisit - a.lastVisit;
  });
  return entries.slice(0, Math.max(0, limit)).map((e) => ({
    url: e.url,
    title: e.title,
    visitCount: e.visitCount,
  }));
}

/** Most recent items (for history screen). */
function recent(limit = 100) {
  const entries = [...byUrl.values()].sort((a, b) => b.lastVisit - a.lastVisit);
  return entries.slice(0, Math.max(0, limit)).map((e) => ({
    url: e.url,
    title: e.title,
    ts: e.lastVisit,
    visitCount: e.visitCount,
  }));
}

/** Removes a single entry by URL. Returns true if removed. */
function remove(url) {
  if (!url || typeof url !== 'string') return false;
  const had = byUrl.delete(url);
  if (had) scheduleWrite();
  return had;
}

/** Clears by range: 'hour' | 'day' | 'all'. Returns true. */
function clear(range = 'all') {
  if (range === 'all') {
    byUrl.clear();
  } else {
    const cutoff = Date.now() - (range === 'hour' ? 3600000 : 86400000);
    for (const [url, e] of byUrl) {
      if (e.lastVisit >= cutoff) byUrl.delete(url);
    }
  }
  scheduleWrite();
  return true;
}

function scheduleWrite() {
  if (!filePath) return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 400);
  if (writeTimer.unref) writeTimer.unref();
}

function flush() {
  if (!filePath) return;
  try {
    fs.writeFileSync(filePath, JSON.stringify([...byUrl.values()]), 'utf8');
  } catch {
    // disk unavailable — history remains in memory only
  }
}

module.exports = { init, add, updateTitle, query, topSites, recent, remove, clear, flush };
