'use strict';

/**
 * persist.js — Domain-keyed cookie persistence (Cloudflare clearance survival).
 *
 * `session-store` saves cookies by an explicit NAME. This is the automatic sibling:
 * it keys by DOMAIN and is tuned for surviving bot-walls — it preserves and flags
 * the Cloudflare cookies (cf_clearance, __cf_bm, __cfduid, __cflb) so a solved
 * challenge (via `handoff` or stealth) carries across future runs instead of
 * re-triggering "Just a moment…".
 *
 * Store: ~/.logica-pilot/persist/<domain>.json   (0 dep)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(process.env.LOGICA_PILOT_HOME || path.join(os.homedir(), '.logica-pilot'), 'persist');
const CF = ['cf_clearance', '__cf_bm', '__cfduid', '__cflb', 'cf_chl_2', 'cf_chl_prog'];
const sane = (d) => String(d || 'unknown').replace(/[^a-z0-9._-]/gi, '_').replace(/^\.+/, '') || 'unknown';
const fileOf = (d) => path.join(DIR, sane(d) + '.json');

function baseDomain(host) {
  if (!host) return '';
  const parts = host.replace(/^\./, '').split('.');
  return parts.length <= 2 ? host.replace(/^\./, '') : parts.slice(-2).join('.');
}

async function currentDomain(page) {
  const host = await page.eval('location.hostname').catch(() => '');
  return baseDomain(host);
}

/** Save cookies for a domain (defaults to the page's current domain). */
async function save(page, domain) {
  const dom = domain || (await currentDomain(page));
  await page.send('Network.enable').catch(() => {});
  const res = await page.send('Network.getAllCookies').catch(() => ({ cookies: [] }));
  const all = (res && res.cookies) || [];
  const cookies = all.filter((c) => c && c.domain && (c.domain.includes(dom) || dom.includes(c.domain.replace(/^\./, ''))));
  const cf = cookies.filter((c) => CF.includes(c.name)).map((c) => c.name);
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(fileOf(dom), JSON.stringify({ domain: dom, savedAt: Date.now(), cloudflare: cf, cookies }, null, 2));
  return { domain: dom, cookies: cookies.length, cloudflare: cf };
}

/** Restore a domain's cookies (apply BEFORE navigating for CF clearance to take). */
async function load(page, domain) {
  const dom = domain || (await currentDomain(page));
  const f = fileOf(dom);
  if (!fs.existsSync(f)) return { domain: dom, loaded: 0, error: 'no persisted cookies' };
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
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
  return { domain: dom, loaded: cookies.length, cloudflare: data.cloudflare || [] };
}

/** List persisted domains. */
function list() {
  try {
    return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => {
      try { const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); return { domain: d.domain, cookies: (d.cookies || []).length, cloudflare: d.cloudflare || [], savedAt: d.savedAt }; }
      catch { return { domain: f.replace(/\.json$/, '') }; }
    });
  } catch { return []; }
}

/** Forget a domain. */
function clear(domain) {
  const f = fileOf(domain);
  const existed = fs.existsSync(f);
  if (existed) fs.unlinkSync(f);
  return { domain: sane(domain), cleared: existed };
}

module.exports = { save, load, list, clear, currentDomain, DIR };
