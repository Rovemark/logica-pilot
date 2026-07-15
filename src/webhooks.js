'use strict';

/**
 * webhooks.js — Run-lifecycle webhooks (Apify webhooks). LP's watch/monitor fire on
 * CONTENT change; this fires on RUN OUTCOME (run.succeeded / run.failed / …), so an
 * integration can subscribe "job finished → pull the dataset". The event bus that
 * makes LP event-driven and backs the n8n/Zapier connectors.
 *
 *   webhooks.add('run.succeeded', 'https://hook…', { actor: 'book-scraper' })
 *   await webhooks.fire('run.succeeded', { actor: 'book-scraper', datasetId, stats })
 *
 * Store: ~/.logica-pilot/webhooks.json. Zero-dependency (http/https).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const FILE = path.join(process.env.LOGICA_PILOT_HOME || path.join(os.homedir(), '.logica-pilot'), 'webhooks.json');
const EVENTS = ['run.created', 'run.succeeded', 'run.failed', 'run.aborted', 'run.timed_out'];

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } }
function save(list) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(list, null, 2)); }

function add(event, url, { actor = null } = {}) {
  const list = load();
  const id = crypto.randomBytes(5).toString('hex');
  list.push({ id, event, url, actor, ts: Date.now() });
  save(list);
  return { id, event, url, actor };
}
function list() { return load(); }
function remove(id) { const l = load(); const n = l.filter((w) => w.id !== id); save(n); return { removed: l.length - n.length }; }

function post(url, payload) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch { return resolve({ url, ok: false, error: 'bad url' }); }
    const data = JSON.stringify(payload);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'user-agent': 'logica-pilot-webhook' }, timeout: 15000 }, (res) => { res.resume(); resolve({ url, ok: res.statusCode < 400, status: res.statusCode }); });
    req.on('error', (e) => resolve({ url, ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ url, ok: false, error: 'timeout' }); });
    req.write(data); req.end();
  });
}

/** Fire an event to all matching subscriptions. Returns per-delivery results. */
async function fire(event, data = {}) {
  const subs = load().filter((w) => w.event === event && (!w.actor || w.actor === data.actor));
  if (!subs.length) return [];
  const payload = { eventType: event, eventData: data, createdAt: new Date().toISOString(), resource: { actor: data.actor, datasetId: data.datasetId || data.dataset, runId: data.runId, status: data.status } };
  return Promise.all(subs.map((s) => post(s.url, payload)));
}

module.exports = { add, list, remove, fire, EVENTS, FILE };
