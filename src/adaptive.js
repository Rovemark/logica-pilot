'use strict';

/**
 * adaptive.js — Adaptive HTTP-vs-browser routing (Apify AdaptivePlaywrightCrawler).
 *
 * Most pages render fine over cheap HTTP; only JS-dependent or bot-walled pages need
 * a full browser. This tries the HTTP tier first and escalates to the browser ONLY on
 * concrete signals (JS-shell body, Cloudflare/DataDome challenge, blocked status), then
 * caches the per-host verdict on disk so subsequent pages skip the probe entirely.
 *
 *   const r = await smartLoad(pilot, page, url);   // r.engine = 'http' | 'browser'
 *
 * Zero-dependency. Verdict cache: ~/.logica-pilot/adaptive-verdicts.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const httpEngine = require('./http-engine');

const CACHE = path.join(process.env.LOGICA_PILOT_HOME || path.join(os.homedir(), '.logica-pilot'), 'adaptive-verdicts.json');
const TTL = 6 * 60 * 60 * 1000; // 6h — hosts can flip static↔dynamic
const CHALLENGE = /just a moment|checking your browser|cf-browser-verification|__cf_chl|turnstile|cf_chl_opt|_incapsula_|distil_r_blocked|px-captcha|access denied|enable javascript to/i;
const MOUNT = /<div[^>]+id=["'](root|__next|app|__nuxt|q-app|svelte)["'][^>]*>\s*<\/div>|id=["']__next["']/i;

function loadCache() { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; } }
function saveCache(c) { try { fs.mkdirSync(path.dirname(CACHE), { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(c)); } catch {} }
function hostOf(u) { try { return new URL(u).hostname; } catch { return u; } }

/** Decide whether an HTTP response is enough, or the page needs a real browser. */
function decide({ status, contentType, body }) {
  if (contentType && !/html|xml/i.test(contentType)) return { sufficient: true, reason: 'non-html (json/text)' };
  if ([403, 429, 503].includes(status)) return { sufficient: false, reason: `blocked-status ${status}` };
  const html = String(body || '');
  if (CHALLENGE.test(html.slice(0, 4000))) return { sufficient: false, reason: 'anti-bot challenge' };
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const scripts = (html.match(/<script\b/gi) || []).length;
  if (text.length < 200 && (MOUNT.test(html) || scripts >= 3)) return { sufficient: false, reason: 'js-shell (empty DOM + scripts)' };
  if (text.length < 50) return { sufficient: false, reason: 'near-empty body' };
  return { sufficient: true, reason: 'static content' };
}

function getVerdict(host) {
  const c = loadCache();
  const v = c[host];
  if (v && Date.now() - v.ts < TTL) return v.engine;
  return null;
}
function setVerdict(host, engine) {
  const c = loadCache();
  c[host] = { engine, ts: Date.now() };
  saveCache(c);
}

/**
 * Load `url` into `page` via the cheapest sufficient engine.
 * @returns {{engine, escalated, reason, status}}
 */
async function smartLoad(page, url, { proxy, cookies, force } = {}) {
  const host = hostOf(url);
  const cached = force ? null : getVerdict(host);

  // Known-dynamic host → straight to the browser.
  if (cached === 'browser') {
    await page.goto(url);
    return { engine: 'browser', escalated: false, reason: 'cached-verdict', status: 200 };
  }

  // Try HTTP first.
  let httpRes = null;
  try {
    httpRes = await httpEngine.httpFetch(url, { proxy, cookies });
  } catch (e) {
    await page.goto(url);
    setVerdict(host, 'browser');
    return { engine: 'browser', escalated: true, reason: 'http-fetch-failed: ' + e.message, status: 200 };
  }

  const verdict = decide(httpRes);
  if (verdict.sufficient) {
    await httpEngine.loadHtml(page, httpRes.body, httpRes.url);
    if (cached !== 'http') setVerdict(host, 'http');
    return { engine: 'http', escalated: false, reason: verdict.reason, status: httpRes.status };
  }

  // Escalate to the browser.
  await page.goto(url);
  setVerdict(host, 'browser');
  return { engine: 'browser', escalated: true, reason: verdict.reason, status: httpRes.status };
}

module.exports = { smartLoad, decide, getVerdict, setVerdict, CACHE };
