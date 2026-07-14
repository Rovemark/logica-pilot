'use strict';

/**
 * change.js — Shared change-tracking core (used by the `watch` tool and the
 * monitor daemon, feature #4). Persists a text snapshot per url+tag and diffs
 * the next visit against it. Snapshots live in ~/.logica-pilot/watch and survive
 * across sessions.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { lineDiff } = require('./diff');
const perception = require('./perception');
const { dismissConsent } = require('./consent');

const WATCH_DIR = path.join(os.homedir(), '.logica-pilot', 'watch');

function watchKey(url, tag) { return crypto.createHash('sha1').update(url + '|' + (tag || '')).digest('hex'); }
function load(url, tag) {
  try { return JSON.parse(fs.readFileSync(path.join(WATCH_DIR, watchKey(url, tag) + '.json'), 'utf8')); } catch { return null; }
}
function save(url, tag, text, title) {
  try {
    fs.mkdirSync(WATCH_DIR, { recursive: true });
    fs.writeFileSync(path.join(WATCH_DIR, watchKey(url, tag) + '.json'),
      JSON.stringify({ url, tag: tag || '', ts: new Date().toISOString(), title: title || '', text: String(text).slice(0, 300000) }));
  } catch {}
}

/**
 * Compare `text` against the stored snapshot for url+tag, persist the new one.
 * @returns {{url,title,changeStatus,previousScrapeAt,added?,removed?,diff?,textPreview?}}
 */
function checkChange(url, tag, text, { title = '', diff = true } = {}) {
  const prev = load(url, tag);
  save(url, tag, text, title);
  const out = { url, title, changeStatus: 'new', previousScrapeAt: null };
  if (tag) out.tag = tag;
  if (prev) {
    out.previousScrapeAt = prev.ts;
    if (prev.text === text) out.changeStatus = 'same';
    else {
      out.changeStatus = 'changed';
      const d = lineDiff(prev.text, text, { maxOut: 100 });
      out.added = d.added; out.removed = d.removed;
      if (diff) out.diff = d.text;
    }
  } else {
    out.textPreview = String(text).slice(0, 400);
  }
  return out;
}

/** Launch a throwaway headless page, dismiss consent, snapshot text, check change. */
async function checkUrlHeadless(url, { tag, proxy, location } = {}) {
  const { Browser } = require('./browser');
  const browser = await Browser.launch({ headless: true, proxy, location });
  try {
    const page = await browser.newPage();
    await page.goto(url, { timeout: 25000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    await dismissConsent(page);
    const snap = await perception.snapshot(page, { maxEls: 0, maxChars: 60000 });
    return checkChange(url, tag, String(snap.text || ''), { title: snap.title });
  } finally { try { await browser.close(); } catch {} }
}

module.exports = { checkChange, checkUrlHeadless, WATCH_DIR };
