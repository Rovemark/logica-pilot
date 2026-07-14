'use strict';

/**
 * knowledge.js — Persisted local search indexes (feature #9). Build a BM25 index
 * from a crawl (or supplied docs), then query it offline. Stored at
 * ~/.logica-pilot/indexes/<name>.json.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const bm25 = require('./bm25');

const DIR = path.join(os.homedir(), '.logica-pilot', 'indexes');
const safe = (n) => String(n).replace(/[^a-z0-9_-]/gi, '_').slice(0, 60) || 'default';
const file = (n) => path.join(DIR, safe(n) + '.json');

function saveIndex(name, index, meta) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file(name), JSON.stringify({ name: safe(name), builtAt: new Date().toISOString(), ...meta, index }));
}
function loadIndex(name) { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return null; } }

/**
 * Build an index for `name`. Provide `docs` directly, or a `url` to crawl.
 * @returns {{name, docs, terms, builtAt}}
 */
async function build(name, { url, docs, limit = 25, maxDepth = 3, includePaths, excludePaths } = {}) {
  let pages = docs;
  if (!pages) {
    if (!url) throw new Error('index build: provide url (to crawl) or docs[]');
    const crawler = require('./crawl');
    const r = await crawler.crawl({ url, limit, maxDepth, includePaths, excludePaths, textChars: 6000, concurrency: 4 });
    pages = r.pages.filter((p) => p.ok && p.text).map((p) => ({ url: p.url, title: p.title, text: p.text }));
  }
  if (!pages.length) throw new Error('index build: no documents to index');
  const index = bm25.build(pages);
  saveIndex(name, index, { source: url || 'docs', docCount: pages.length });
  return { name: safe(name), docs: index.N, terms: Object.keys(index.df).length, builtAt: new Date().toISOString() };
}

function query(name, q, { k = 5 } = {}) {
  const stored = loadIndex(name);
  if (!stored) return null;
  return { name: stored.name, results: bm25.query(stored.index, q, { k }) };
}

function list() {
  try {
    return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => {
      try { const s = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); return { name: s.name, docs: s.index.N, source: s.source, builtAt: s.builtAt }; } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function remove(name) { try { fs.unlinkSync(file(name)); return { removed: 1 }; } catch { return { removed: 0 }; } }

module.exports = { build, query, list, remove, DIR };
