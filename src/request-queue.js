'use strict';

/**
 * request-queue.js — Durable, resumable, deduplicated request queue (Apify/Crawlee's
 * RequestQueue). Turns crawl from a RAM-bound BFS that loses everything on a crash
 * into a persisted frontier: a 1M-URL crawl killed at 40k resumes at 40k, dedupes
 * across runs, and tracks per-URL retry / dead-letter state.
 *
 * Store: ~/.logica-pilot/request_queues/<name>/queue.ndjson  (append-only WAL).
 *   - "add" lines carry the full request; "upd" lines carry a state delta.
 *   - open() streams the WAL and replays it (last-write-wins per uniqueKey).
 *   - compaction rewrites the file from memory when it grows past ~2x live records.
 *
 * Zero-dependency (fs + crypto).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(process.env.LOGICA_PILOT_HOME || path.join(os.homedir(), '.logica-pilot'), 'request_queues');
const safe = (n) => String(n || 'default').replace(/[^a-z0-9_-]/gi, '_').slice(0, 60) || 'default';

// Normalize a URL for dedup: drop fragment, lowercase host, sort query params.
function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    url.searchParams.sort();
    return url.toString();
  } catch { return String(u); }
}

function uniqueKeyOf(req) {
  const s = `${(req.method || 'GET').toUpperCase()}\n${normalizeUrl(req.url)}\n${req.payload || ''}`;
  return crypto.createHash('sha1').update(s).digest('hex');
}

class RequestQueue {
  constructor(name) {
    this.name = safe(name);
    this.dir = path.join(ROOT, this.name);
    this.file = path.join(this.dir, 'queue.ndjson');
    this.records = new Map(); // uniqueKey -> record
    this._order = 0;
    this._forefront = 0;
    this._lines = 0;
  }

  _append(obj) {
    fs.appendFileSync(this.file, JSON.stringify(obj) + '\n');
    this._lines++;
  }

  open({ clear = false } = {}) {
    fs.mkdirSync(this.dir, { recursive: true });
    if (clear && fs.existsSync(this.file)) fs.unlinkSync(this.file);
    if (fs.existsSync(this.file)) {
      const data = fs.readFileSync(this.file, 'utf8');
      for (const line of data.split('\n')) {
        if (!line.trim()) continue;
        this._lines++;
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (row.op === 'add') {
          this.records.set(row.k, { k: row.k, url: row.url, method: row.method || 'GET', label: row.label || null, userData: row.userData || {}, depth: row.depth || 0, orderNo: row.orderNo, retryCount: 0, state: 'pending' });
          this._order = Math.max(this._order, Math.abs(row.orderNo || 0));
        } else if (row.op === 'upd') {
          const r = this.records.get(row.k);
          if (r) Object.assign(r, row.patch);
        }
      }
    }
    // Any request left "in-progress" from a crashed run is reclaimed to pending.
    for (const r of this.records.values()) if (r.state === 'in-progress') r.state = 'pending';
    return this;
  }

  /** Add a request. Deduped by uniqueKey. forefront → handled next (priority). */
  add(req, { forefront = false } = {}) {
    const request = typeof req === 'string' ? { url: req } : req;
    const k = uniqueKeyOf(request);
    if (this.records.has(k)) return { added: false, key: k, duplicate: true };
    const orderNo = forefront ? --this._forefront : ++this._order;
    const rec = { k, url: request.url, method: request.method || 'GET', label: request.label || null, userData: request.userData || {}, depth: request.depth || 0, orderNo, retryCount: 0, state: 'pending' };
    this.records.set(k, rec);
    this._append({ op: 'add', k, url: rec.url, method: rec.method, label: rec.label, userData: rec.userData, depth: rec.depth, orderNo });
    return { added: true, key: k };
  }

  /** Add many; returns {added, duplicates}. */
  addBatch(reqs, opts) {
    let added = 0, dup = 0;
    for (const r of reqs || []) { (this.add(r, opts).added ? added++ : dup++); }
    return { added, duplicates: dup };
  }

  /** Claim the next pending request (lowest orderNo first, forefront negative → first). */
  fetchNext() {
    let best = null;
    for (const r of this.records.values()) {
      if (r.state !== 'pending') continue;
      if (!best || r.orderNo < best.orderNo) best = r;
    }
    if (!best) return null;
    best.state = 'in-progress';
    this._append({ op: 'upd', k: best.k, patch: { state: 'in-progress' } });
    return best;
  }

  markHandled(key) {
    const r = this.records.get(key);
    if (!r) return false;
    r.state = 'handled'; r.handledAt = Date.now();
    this._append({ op: 'upd', k: key, patch: { state: 'handled', handledAt: r.handledAt } });
    this._maybeCompact();
    return true;
  }

  /** Retry: back to pending unless retryCount exceeds max → dead-letter (failed). */
  reclaim(key, { maxRetries = 3 } = {}) {
    const r = this.records.get(key);
    if (!r) return { ok: false };
    r.retryCount = (r.retryCount || 0) + 1;
    if (r.retryCount > maxRetries) {
      r.state = 'failed';
      this._append({ op: 'upd', k: key, patch: { state: 'failed', retryCount: r.retryCount } });
      return { ok: true, deadLettered: true, retryCount: r.retryCount };
    }
    r.state = 'pending';
    this._append({ op: 'upd', k: key, patch: { state: 'pending', retryCount: r.retryCount } });
    return { ok: true, deadLettered: false, retryCount: r.retryCount };
  }

  stats() {
    const s = { total: this.records.size, pending: 0, inProgress: 0, handled: 0, failed: 0 };
    for (const r of this.records.values()) {
      if (r.state === 'pending') s.pending++;
      else if (r.state === 'in-progress') s.inProgress++;
      else if (r.state === 'handled') s.handled++;
      else if (r.state === 'failed') s.failed++;
    }
    return s;
  }

  isFinished() {
    for (const r of this.records.values()) if (r.state === 'pending' || r.state === 'in-progress') return false;
    return true;
  }

  failed() {
    return [...this.records.values()].filter((r) => r.state === 'failed').map((r) => ({ url: r.url, retryCount: r.retryCount, label: r.label }));
  }

  // Rewrite the WAL from memory once it accumulates too many delta lines.
  _maybeCompact() {
    if (this._lines < 200 || this._lines < this.records.size * 3) return;
    const tmp = this.file + '.tmp';
    const out = [];
    for (const r of this.records.values()) {
      out.push(JSON.stringify({ op: 'add', k: r.k, url: r.url, method: r.method, label: r.label, userData: r.userData, depth: r.depth, orderNo: r.orderNo }));
      if (r.state !== 'pending' || r.retryCount) out.push(JSON.stringify({ op: 'upd', k: r.k, patch: { state: r.state, retryCount: r.retryCount, ...(r.handledAt ? { handledAt: r.handledAt } : {}) } }));
    }
    fs.writeFileSync(tmp, out.join('\n') + '\n');
    fs.renameSync(tmp, this.file);
    this._lines = out.length;
  }
}

function open(name, opts) { return new RequestQueue(name).open(opts); }
function list() { try { return fs.readdirSync(ROOT).filter((f) => fs.existsSync(path.join(ROOT, f, 'queue.ndjson'))); } catch { return []; } }
function drop(name) { const d = path.join(ROOT, safe(name)); const e = fs.existsSync(d); if (e) fs.rmSync(d, { recursive: true, force: true }); return { name: safe(name), dropped: e }; }

module.exports = { RequestQueue, open, list, drop, normalizeUrl, uniqueKeyOf, ROOT };
