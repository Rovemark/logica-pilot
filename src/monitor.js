'use strict';

/**
 * monitor.js — Scheduled change monitors with real alerts (feature #4).
 *
 * `watch` tells you if a page changed once; a monitor keeps checking on a cadence
 * and NOTIFIES (Telegram / webhook / desktop) only when it actually changes.
 * Runs locally as a daemon (pm2/launchd/systemd-friendly), zero external deps.
 *
 * Store: ~/.logica-pilot/monitors.json
 *   { monitors: [{ id, url, tag, everyMs, notify:{telegram?,webhook?,desktop?}, label,
 *                  lastCheck, lastStatus, lastChangeAt, changes }] }
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { checkUrlHeadless } = require('./change');

const FILE = path.join(os.homedir(), '.logica-pilot', 'monitors.json');

function loadStore() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { monitors: [] }; }
}
function saveStore(s) { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(s, null, 2)); } catch {} }

function parseEvery(v) {
  if (typeof v === 'number') return v;
  const m = String(v || '').trim().match(/^(\d+)\s*([smhd]?)$/i);
  if (!m) return 30 * 60 * 1000;
  const n = parseInt(m[1], 10); const u = (m[2] || 'm').toLowerCase();
  return n * ({ s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[u] || 6e4);
}

function add({ url, tag, every, notify, label } = {}) {
  if (!url) throw new Error('monitor: url required');
  const s = loadStore();
  const id = crypto.randomBytes(4).toString('hex');
  const mon = {
    id, url, tag: tag || '', everyMs: parseEvery(every || '30m'),
    notify: notify || {}, label: label || url,
    lastCheck: null, lastStatus: null, lastChangeAt: null, changes: 0,
  };
  s.monitors.push(mon);
  saveStore(s);
  return mon;
}
function remove(id) { const s = loadStore(); const before = s.monitors.length; s.monitors = s.monitors.filter((m) => m.id !== id); saveStore(s); return { removed: before - s.monitors.length }; }
function get(id) { return loadStore().monitors.find((m) => m.id === id) || null; }
function list() { return loadStore().monitors.map((m) => ({ id: m.id, url: m.url, tag: m.tag || undefined, every: Math.round(m.everyMs / 60000) + 'm', lastStatus: m.lastStatus, changes: m.changes, lastChangeAt: m.lastChangeAt })); }

// ── notifications ────────────────────────────────────────────────────────────
async function notifyTelegram(cfg, text) {
  const token = cfg.token || process.env.TELEGRAM_BOT_TOKEN;
  const chat = cfg.chatId || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { ok: false, error: 'missing telegram token/chatId' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    return { ok: res.ok };
  } catch (e) { return { ok: false, error: e.message }; }
}
async function notifyWebhook(url, payload) {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: ctrl.signal }).finally(() => clearTimeout(t));
    return { ok: res.ok };
  } catch (e) { return { ok: false, error: e.message }; }
}
function notifyDesktop(title, message) {
  return new Promise((resolve) => {
    try {
      if (process.platform === 'darwin') {
        const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`;
        execFile('osascript', ['-e', script], () => resolve({ ok: true }));
      } else if (process.platform === 'linux') {
        execFile('notify-send', [title, message], () => resolve({ ok: true }));
      } else { resolve({ ok: false, error: 'unsupported platform' }); }
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

async function fireNotifications(mon, result) {
  const head = `🔔 ${mon.label} changed`;
  const body = `${mon.url}\n+${result.added || 0}/-${result.removed || 0} lines${result.diff ? '\n\n' + String(result.diff).slice(0, 900) : ''}`;
  const out = {};
  if (mon.notify.desktop) out.desktop = await notifyDesktop(head, `${mon.url} (+${result.added}/-${result.removed})`);
  if (mon.notify.telegram) out.telegram = await notifyTelegram(mon.notify.telegram === true ? {} : mon.notify.telegram, `<b>${head}</b>\n${body}`);
  if (mon.notify.webhook) out.webhook = await notifyWebhook(typeof mon.notify.webhook === 'string' ? mon.notify.webhook : mon.notify.webhook.url, { monitor: mon.id, url: mon.url, label: mon.label, ...result });
  return out;
}

/** Check one monitor now; notify if changed. Returns the change result. */
async function checkOne(mon, { force = false } = {}) {
  const result = await checkUrlHeadless(mon.url, { tag: mon.tag, proxy: mon.proxy, location: mon.location });
  const s = loadStore();
  const cur = s.monitors.find((m) => m.id === mon.id) || mon;
  cur.lastCheck = new Date().toISOString();
  cur.lastStatus = result.changeStatus;
  let notified = null;
  if (result.changeStatus === 'changed' || (force && result.changeStatus !== 'new')) {
    cur.changes = (cur.changes || 0) + 1;
    cur.lastChangeAt = cur.lastCheck;
    notified = await fireNotifications(cur, result);
  }
  saveStore(s);
  return { ...result, notified };
}

/** Foreground daemon: check due monitors on a tick. Ctrl-C to stop. */
async function runDaemon({ tickMs = 30000, log = console.error } = {}) {
  log(`[monitor] daemon up — ${list().length} monitor(s). checking due ones every ${Math.round(tickMs / 1000)}s.`);
  let running = false;
  const tick = async () => {
    if (running) return; running = true;
    try {
      const s = loadStore();
      const now = Date.now();
      for (const mon of s.monitors) {
        const last = mon.lastCheck ? Date.parse(mon.lastCheck) : 0;
        if (now - last < mon.everyMs) continue;
        try {
          const r = await checkOne(mon);
          log(`[monitor] ${mon.label} → ${r.changeStatus}${r.notified ? ' (notified)' : ''}`);
        } catch (e) { log(`[monitor] ${mon.label} check failed: ${e.message}`); }
      }
    } finally { running = false; }
  };
  await tick();
  const timer = setInterval(tick, tickMs);
  process.on('SIGINT', () => { clearInterval(timer); log('[monitor] daemon stopped.'); process.exit(0); });
  process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
  // keep alive
  await new Promise(() => {});
}

module.exports = { add, remove, get, list, checkOne, runDaemon, parseEvery, FILE };
