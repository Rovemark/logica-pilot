'use strict';

/**
 * settings.js — Persistent browser preferences (theme, search engine, homepage).
 *
 * Stored in userData/settings.json with debounced writes. Safe defaults:
 *   { theme: 'system', searchEngine: 'google', homepage: 'pilot://newtab' }.
 *
 * Does not depend directly on Electron: receives the file path via init()
 * (called by main with app.getPath('userData')) to facilitate testing/portability.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  theme: 'system', // 'light' | 'dark' | 'system'
  searchEngine: 'google', // id from the catalog (search-engines.js)
  homepage: 'pilot://newtab',
  showBookmarksBar: false, // display the bookmarks bar below the toolbar
  language: 'auto', // 'auto' (follows the OS) | 'pt-BR' | 'en' | 'es'
  aiApiKey: '', // user's Anthropic key (sk-ant-…) for Pilot without LogicaProxy
});

// supported languages by the shell (must exist in renderer/i18n/locales.js)
const LANGUAGES = ['pt-BR', 'en', 'es', 'fr', 'de', 'it', 'nl', 'pl', 'ru', 'ja', 'ko', 'zh-CN'];

let filePath = null;
let state = { ...DEFAULTS };
let writeTimer = null;

/** Initializes the store pointing to the user data directory. */
function init(userDataDir) {
  filePath = path.join(userDataDir, 'settings.json');
  load();
  return get();
}

/** Reads the JSON from disk (tolerant of missing/corrupted files → keeps defaults). */
function load() {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      state = sanitize({ ...DEFAULTS, ...parsed });
    }
  } catch {
    state = { ...DEFAULTS };
  }
}

/** Ensures valid values (do not blindly trust disk data). */
function sanitize(s) {
  const out = { ...DEFAULTS };
  if (s.theme === 'light' || s.theme === 'dark' || s.theme === 'system') out.theme = s.theme;
  if (typeof s.searchEngine === 'string' && s.searchEngine) out.searchEngine = s.searchEngine;
  if (typeof s.homepage === 'string' && s.homepage) out.homepage = s.homepage;
  if (typeof s.showBookmarksBar === 'boolean') out.showBookmarksBar = s.showBookmarksBar;
  if (s.language === 'auto' || LANGUAGES.includes(s.language)) out.language = s.language;
  if (typeof s.aiApiKey === 'string') out.aiApiKey = s.aiApiKey.trim();
  return out;
}

/** Complete snapshot of settings (a copy, so the caller cannot mutate internal state). */
function get() {
  return { ...state };
}

/** Applies a partial patch, persists it, and returns the complete settings. */
function set(patch = {}) {
  const next = sanitize({ ...state, ...patch });
  state = next;
  scheduleWrite();
  return get();
}

/** Debounced write (~200ms) to avoid hammering the disk. */
function scheduleWrite() {
  if (!filePath) return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 200);
  if (writeTimer.unref) writeTimer.unref();
}

/** Persists immediately (used in debounce and on shutdown). */
function flush() {
  if (!filePath) return;
  try {
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // disk unavailable — settings remain in memory; nothing critical
  }
}

module.exports = { init, get, set, flush, DEFAULTS };
