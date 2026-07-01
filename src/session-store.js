'use strict';

/**
 * session-store.js — Session persistence (cookies) by name.
 *
 * Classic Playwright pain point: re-login on every script run. Here you log in ONCE,
 * save the session, and reuse it in any future call (CLI/MCP):
 *   logica-pilot session save my-account   # after logging in during a run/act
 *   logica-pilot ... --session my-account   # reuses the cookies
 *
 * Stores in ~/.logica-pilot/sessions/<name>.json (cookies only; 0 dep).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.logica-pilot', 'sessions');
const sane = (n) => (String(n || 'default').replace(/[^a-z0-9_-]/gi, '_') || 'default');
const fileOf = (n) => path.join(DIR, sane(n) + '.json');

/** Saves the current page cookies under a name. */
async function save(page, name) {
  await page.send('Network.enable').catch(() => {});
  const res = await page.send('Network.getAllCookies').catch(() => ({ cookies: [] }));
  const cookies = (res && res.cookies) || [];
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(fileOf(name), JSON.stringify({ name: sane(name), savedAt: Date.now(), cookies }, null, 2));
  return { name: sane(name), cookies: cookies.length };
}

/** Restores the saved cookies on the page (apply BEFORE navigating). */
async function load(page, name) {
  const f = fileOf(name);
  if (!fs.existsSync(f)) return { name: sane(name), loaded: 0, error: 'session not found' };
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  // filters to only fields that Network.setCookies accepts (avoids errors with size/session/etc.)
  const cookies = (data.cookies || [])
    .filter((c) => c && c.name && c.domain)
    .map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
      secure: !!c.secure, httpOnly: !!c.httpOnly,
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      ...(typeof c.expires === 'number' && c.expires > 0 ? { expires: c.expires } : {}),
    }));
  await page.send('Network.enable').catch(() => {});
  let ok = false;
  try { await page.send('Network.setCookies', { cookies }); ok = true; } catch {}
  if (!ok) { for (const c of cookies) { try { await page.send('Network.setCookie', c); } catch {} } }
  return { name: sane(name), loaded: cookies.length };
}

/** Lists the saved sessions. */
function list() {
  try {
    return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  } catch { return []; }
}

module.exports = { save, load, list, DIR };
