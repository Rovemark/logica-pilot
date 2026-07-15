'use strict';

/**
 * session-pool.js — Rotating identity pool with health scoring (Apify SessionPool).
 *
 * Spreading load across many scored identities is how you dodge rate-limits at scale.
 * Each Session = a sticky {fingerprint + proxy exit + cookie jar} with success/error
 * scores. borrow() hands out the least-used healthy one; on a 403/429/CAPTCHA you
 * markBad(), and past a threshold the session is RETIRED and a fresh identity (new
 * fingerprint bound to a new sticky proxy) takes its place.
 *
 * Store: ~/.logica-pilot/session-pools/<name>.json. Zero-dependency; composes with
 * fingerprint.generate + proxy-pool.pick.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fingerprint = require('./fingerprint');
const proxyPool = require('./proxy-pool');

const DIR = path.join(process.env.LOGICA_PILOT_HOME || path.join(os.homedir(), '.logica-pilot'), 'session-pools');
const safe = (n) => String(n || 'default').replace(/[^a-z0-9_-]/gi, '_').slice(0, 60) || 'default';

class SessionPool {
  constructor(name, { maxPoolSize = 10, maxErrorScore = 3, pool = null, browser, os: osFilter } = {}) {
    this.name = safe(name);
    this.file = path.join(DIR, this.name + '.json');
    this.maxPoolSize = maxPoolSize;
    this.maxErrorScore = maxErrorScore;
    this.proxyPoolName = pool;
    this.fpFilter = { browser, os: osFilter };
    this.sessions = [];
  }

  open() {
    try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.sessions = d.sessions || []; } catch { this.sessions = []; }
    return this;
  }
  _persist() { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ name: this.name, sessions: this.sessions }, null, 2)); }

  _spawn() {
    const id = crypto.randomBytes(4).toString('hex');
    const fp = fingerprint.generate({ ...this.fpFilter, seed: id });
    const proxy = this.proxyPoolName ? proxyPool.pick(this.proxyPoolName, { session: id, strategy: 'sticky' }) : null;
    const s = { id, fingerprint: fp, proxy, cookies: {}, usageCount: 0, successScore: 0, errorScore: 0, state: 'active', createdAt: Date.now() };
    this.sessions.push(s);
    return s;
  }

  /** Borrow the least-used active session (spawns one if room / none available). */
  borrow() {
    const active = this.sessions.filter((s) => s.state === 'active');
    let s;
    if (active.length < this.maxPoolSize) s = this._spawn();
    else { s = active.sort((a, b) => a.usageCount - b.usageCount)[0]; }
    if (!s) s = this._spawn();
    s.usageCount++;
    this._persist();
    return s;
  }

  markGood(id) { const s = this.sessions.find((x) => x.id === id); if (s) { s.successScore++; s.errorScore = Math.max(0, s.errorScore - 1); this._persist(); } return !!s; }

  /** Register a failure; retire the session past the error threshold. */
  markBad(id, { retire = false } = {}) {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return { ok: false };
    s.errorScore++;
    let retired = false;
    if (retire || s.errorScore >= this.maxErrorScore) { s.state = 'retired'; s.retiredAt = Date.now(); retired = true; }
    this._persist();
    return { ok: true, retired, errorScore: s.errorScore };
  }

  get(id) { return this.sessions.find((x) => x.id === id) || null; }
  stats() {
    const active = this.sessions.filter((s) => s.state === 'active');
    return { name: this.name, total: this.sessions.length, active: active.length, retired: this.sessions.length - active.length, maxPoolSize: this.maxPoolSize, avgUsage: active.length ? Math.round(active.reduce((a, s) => a + s.usageCount, 0) / active.length) : 0 };
  }
  list() { return this.sessions.map((s) => ({ id: s.id, state: s.state, usageCount: s.usageCount, successScore: s.successScore, errorScore: s.errorScore, os: s.fingerprint.os, browser: s.fingerprint.browser, hasProxy: !!s.proxy })); }
}

function open(name, opts) { return new SessionPool(name, opts).open(); }
function drop(name) { const f = path.join(DIR, safe(name) + '.json'); const e = fs.existsSync(f); if (e) fs.unlinkSync(f); return { name: safe(name), dropped: e }; }
function pools() { try { return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')); } catch { return []; } }

module.exports = { SessionPool, open, drop, pools, DIR };
