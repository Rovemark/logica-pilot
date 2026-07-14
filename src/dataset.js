'use strict';

/**
 * dataset.js — Living datasets (feature #5). Scrape/gather/crawl output becomes a
 * named local table: append with dedupe by key, snapshot each run, diff between
 * runs, export CSV/JSON. Combined with the monitor, this is a free time series
 * ("the price of X over the last 30 days").
 *
 * Stored at ~/.logica-pilot/datasets/<name>.json:
 *   { name, key, rows: {<key>: {...row, _first, _last, _seen}}, runs: [{ts, added, changed, removed, total}] }
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(os.homedir(), '.logica-pilot', 'datasets');
const safe = (n) => String(n).replace(/[^a-z0-9_-]/gi, '_').slice(0, 60) || 'default';
const file = (n) => path.join(DIR, safe(n) + '.json');

function loadRaw(name) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return null; }
}
function persist(ds) { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(file(ds.name), JSON.stringify(ds)); }

function rowKey(row, key) {
  if (key && row[key] != null) return String(row[key]);
  // No key column → hash the row's stable fields (deterministic key ordering).
  const norm = JSON.stringify(row, Object.keys(row).sort());
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

/**
 * Append rows to a dataset. Dedupes by `key`; records what changed vs last run.
 * @returns {{name, added, changed, removed, total, run}}
 */
function put(name, rows, { key } = {}) {
  if (!Array.isArray(rows)) rows = rows ? [rows] : [];
  let ds = loadRaw(name);
  if (!ds) ds = { name: safe(name), key: key || null, rows: {}, runs: [] };
  if (key && !ds.key) ds.key = key;
  const k = ds.key;
  const now = Date.now();
  const seenThisRun = new Set();
  let added = 0, changed = 0;
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const id = rowKey(raw, k);
    seenThisRun.add(id);
    const prev = ds.rows[id];
    if (!prev) {
      ds.rows[id] = { ...raw, _first: now, _last: now, _seen: 1 };
      added++;
    } else {
      // Track a value change on tracked fields (ignore bookkeeping _fields).
      const before = JSON.stringify(stripMeta(prev));
      const merged = { ...prev, ...raw, _last: now, _seen: (prev._seen || 0) + 1 };
      if (JSON.stringify(stripMeta(merged)) !== before) changed++;
      ds.rows[id] = merged;
    }
  }
  // "removed" = keys present before but absent this run (only when a full set was provided).
  let removed = 0;
  const run = { ts: new Date(now).toISOString(), added, changed, removed, total: Object.keys(ds.rows).length };
  ds.runs.unshift(run);
  ds.runs = ds.runs.slice(0, 200);
  persist(ds);
  return { name: ds.name, added, changed, removed, total: run.total, run };
}

function stripMeta(row) { const r = { ...row }; delete r._first; delete r._last; delete r._seen; return r; }

function get(name, { limit = 100 } = {}) {
  const ds = loadRaw(name);
  if (!ds) return null;
  const rows = Object.values(ds.rows).map(stripMeta).slice(0, Math.max(1, limit));
  return { name: ds.name, key: ds.key, total: Object.keys(ds.rows).length, runs: ds.runs.length, rows };
}

function list() {
  try {
    return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => {
      try { const ds = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); return { name: ds.name, rows: Object.keys(ds.rows).length, runs: ds.runs.length, lastRun: ds.runs[0] && ds.runs[0].ts }; } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function history(name) {
  const ds = loadRaw(name);
  return ds ? ds.runs.slice(0, 50) : null;
}

function toCSV(rows) {
  if (!rows.length) return '';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\n');
}

function exportData(name, { format = 'json' } = {}) {
  const ds = loadRaw(name);
  if (!ds) return null;
  const rows = Object.values(ds.rows).map(stripMeta);
  return format === 'csv' ? toCSV(rows) : JSON.stringify(rows, null, 2);
}

module.exports = { put, get, list, history, exportData, DIR };
