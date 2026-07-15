'use strict';

/**
 * scheduler.js — Cron scheduling of Actors (Apify schedules). Generalizes LP's
 * monitor daemon from "check a URL on a cadence" to "run any actor on a cron", so a
 * scrape can run every morning and (via webhooks) notify downstream when done.
 *
 *   scheduler.add('0 9 * * *', 'book-scraper', { startUrls: [...] })
 *   await scheduler.runDue(runner)   // called by the daemon tick
 *
 * Standard 5-field cron (min hour dom mon dow), with step, range, and list syntax.
 * Store: ~/.logica-pilot/schedules.json. Zero-dependency.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const FILE = path.join(process.env.LOGICA_PILOT_HOME || path.join(os.homedir(), '.logica-pilot'), 'schedules.json');

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } }
function save(list) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(list, null, 2)); }

// Parse one cron field into a predicate over [min..max].
function parseField(field, min, max) {
  if (field === '*' || field === '?') return () => true;
  const allowed = new Set();
  for (const part of field.split(',')) {
    let m;
    if ((m = part.match(/^\*\/(\d+)$/))) { for (let i = min; i <= max; i += Number(m[1])) allowed.add(i); }
    else if ((m = part.match(/^(\d+)-(\d+)\/(\d+)$/))) { for (let i = Number(m[1]); i <= Number(m[2]); i += Number(m[3])) allowed.add(i); }
    else if ((m = part.match(/^(\d+)-(\d+)$/))) { for (let i = Number(m[1]); i <= Number(m[2]); i++) allowed.add(i); }
    else if (/^\d+$/.test(part)) allowed.add(Number(part));
  }
  return (v) => allowed.has(v);
}

function parseCron(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error('cron must have 5 fields: min hour dom mon dow');
  return { min: parseField(f[0], 0, 59), hour: parseField(f[1], 0, 23), dom: parseField(f[2], 1, 31), mon: parseField(f[3], 1, 12), dow: parseField(f[4], 0, 6), raw: expr };
}

function matches(cron, d) {
  return cron.min(d.getMinutes()) && cron.hour(d.getHours()) && cron.dom(d.getDate()) && cron.mon(d.getMonth() + 1) && cron.dow(d.getDay());
}

/** Next fire time (ms epoch) strictly after `fromMs`. Brute-force minute stepping, capped 2y. */
function nextFire(expr, fromMs = Date.now()) {
  const cron = parseCron(expr);
  const d = new Date(fromMs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const cap = fromMs + 733 * 24 * 60 * 60 * 1000;
  while (d.getTime() <= cap) {
    if (matches(cron, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

function add(cron, actor, input = {}, { tz = null, enabled = true } = {}) {
  parseCron(cron); // validate
  const list = load();
  const id = crypto.randomBytes(5).toString('hex');
  const next = nextFire(cron);
  list.push({ id, cron, actor, input, tz, enabled, createdAt: Date.now(), lastRun: null, nextRun: next });
  save(list);
  return { id, cron, actor, nextRun: next ? new Date(next).toISOString() : null };
}

function list() { return load().map((s) => ({ ...s, nextRunISO: s.nextRun ? new Date(s.nextRun).toISOString() : null })); }
function remove(id) { const l = load(); const n = l.filter((s) => s.id !== id); save(n); return { removed: l.length - n.length }; }
function setEnabled(id, enabled) { const l = load(); const s = l.find((x) => x.id === id); if (s) { s.enabled = enabled; if (enabled && !s.nextRun) s.nextRun = nextFire(s.cron); save(l); } return { id, enabled }; }

function due(nowMs = Date.now()) { return load().filter((s) => s.enabled && s.nextRun && s.nextRun <= nowMs); }

/**
 * Run all due schedules. `runner(actor, input)` executes one; we update lastRun/nextRun.
 */
async function runDue(runner, nowMs = Date.now()) {
  const list = load();
  const ran = [];
  for (const s of list) {
    if (!s.enabled || !s.nextRun || s.nextRun > nowMs) continue;
    let result = null, error = null;
    try { result = await runner(s.actor, s.input); } catch (e) { error = e.message; }
    s.lastRun = nowMs;
    s.nextRun = nextFire(s.cron, nowMs);
    ran.push({ id: s.id, actor: s.actor, ok: !error, error });
  }
  save(list);
  return ran;
}

module.exports = { add, list, remove, setEnabled, due, runDue, nextFire, parseCron, FILE };
