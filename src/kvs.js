'use strict';

/**
 * kvs.js — Key-Value Store (Apify KeyValueStore). Logica Pilot's dataset is tabular;
 * this is where arbitrary blobs/records live: a screenshot buffer, a downloaded PDF,
 * an Actor INPUT config, an OUTPUT object, a crawl checkpoint, a pageFunction's
 * globalStore, or RAG metadata. One primitive that backs Actor packaging, resumable
 * checkpoints, and REST blob passthrough.
 *
 * Store: ~/.logica-pilot/key_value_stores/<store>/
 *   <safeKey>.<ext>   the record body (json | txt | png | pdf | bin …)
 *   _index.json       { key -> { file, contentType, size, ts } }  (handles unsafe keys)
 *
 * Zero-dependency (fs only).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(process.env.LOGICA_PILOT_HOME || path.join(os.homedir(), '.logica-pilot'), 'key_value_stores');
const safeStore = (n) => String(n || 'default').replace(/[^a-z0-9_-]/gi, '_').slice(0, 60) || 'default';

const EXT = { 'application/json': 'json', 'text/plain': 'txt', 'text/html': 'html', 'image/png': 'png', 'image/jpeg': 'jpg', 'application/pdf': 'pdf', 'text/csv': 'csv', 'application/octet-stream': 'bin' };

function dirOf(store) { return path.join(ROOT, safeStore(store)); }
function indexPath(store) { return path.join(dirOf(store), '_index.json'); }
function loadIndex(store) { try { return JSON.parse(fs.readFileSync(indexPath(store), 'utf8')); } catch { return {}; } }
function saveIndex(store, idx) { fs.mkdirSync(dirOf(store), { recursive: true }); fs.writeFileSync(indexPath(store), JSON.stringify(idx, null, 2)); }
function fileKey(key) { const s = String(key).replace(/[^a-z0-9._-]/gi, '_').slice(0, 80); return s || crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 16); }

/**
 * Store a value. Accepts a JS object (→ JSON), a string, or {base64, contentType}
 * for binary. Explicit contentType overrides detection.
 */
function setValue(store, key, value, { contentType } = {}) {
  let buf, ct;
  if (value && typeof value === 'object' && typeof value.base64 === 'string') {
    buf = Buffer.from(value.base64, 'base64'); ct = value.contentType || contentType || 'application/octet-stream';
  } else if (Buffer.isBuffer(value)) {
    buf = value; ct = contentType || 'application/octet-stream';
  } else if (typeof value === 'string') {
    buf = Buffer.from(value, 'utf8'); ct = contentType || 'text/plain';
  } else {
    buf = Buffer.from(JSON.stringify(value, null, 2), 'utf8'); ct = contentType || 'application/json';
  }
  const ext = EXT[ct] || (ct.startsWith('text/') ? 'txt' : 'bin');
  const fname = fileKey(key) + '.' + ext;
  fs.mkdirSync(dirOf(store), { recursive: true });
  fs.writeFileSync(path.join(dirOf(store), fname), buf);
  const idx = loadIndex(store);
  idx[key] = { file: fname, contentType: ct, size: buf.length, ts: Date.now() };
  saveIndex(store, idx);
  return { store: safeStore(store), key, contentType: ct, size: buf.length };
}

/** Get a value. Returns parsed JSON, string (text/*), or {base64,contentType} (binary). null if missing. */
function getValue(store, key) {
  const idx = loadIndex(store);
  const meta = idx[key];
  if (!meta) return null;
  const buf = fs.readFileSync(path.join(dirOf(store), meta.file));
  if (meta.contentType === 'application/json') { try { return JSON.parse(buf.toString('utf8')); } catch { return buf.toString('utf8'); } }
  if (meta.contentType.startsWith('text/')) return buf.toString('utf8');
  return { base64: buf.toString('base64'), contentType: meta.contentType, size: buf.length };
}

function getMeta(store, key) { return loadIndex(store)[key] || null; }
function listKeys(store) { const idx = loadIndex(store); return Object.keys(idx).map((k) => ({ key: k, contentType: idx[k].contentType, size: idx[k].size, ts: idx[k].ts })); }
function del(store, key) { const idx = loadIndex(store); const meta = idx[key]; if (!meta) return { deleted: false }; try { fs.unlinkSync(path.join(dirOf(store), meta.file)); } catch {} delete idx[key]; saveIndex(store, idx); return { deleted: true }; }
function listStores() { try { return fs.readdirSync(ROOT).filter((d) => fs.existsSync(indexPath(d))); } catch { return []; } }
function drop(store) { const d = dirOf(store); const e = fs.existsSync(d); if (e) fs.rmSync(d, { recursive: true, force: true }); return { store: safeStore(store), dropped: e }; }

module.exports = { setValue, getValue, getMeta, listKeys, del, listStores, drop, ROOT };
