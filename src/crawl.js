'use strict';

/**
 * crawl.js — Site-wide discovery and crawling for Logica Pilot (0-dep).
 *
 * Two capabilities, both token-first:
 *   map()   — INSTANT URL discovery: robots.txt sitemaps + sitemap.xml (recursive)
 *             + same-domain links from the page itself. No LLM, no per-page load.
 *   crawl() — BFS over a site: N parallel headless pages, path filters, depth and
 *             page limits, robots.txt politeness. Each page yields a COMPACT
 *             record (url, title, bounded text) — never raw HTML.
 */

const { Browser } = require('./browser');
const perception = require('./perception');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'LogicaPilot/0.2 (+https://github.com/Rovemark/logica-pilot)' } });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; } finally { clearTimeout(t); }
}

/** robots.txt: extract Sitemap: URLs and Disallow rules for user-agent `*`. */
async function fetchRobots(origin) {
  const txt = await fetchText(origin + '/robots.txt', 6000);
  const out = { sitemaps: [], disallow: [] };
  if (!txt) return out;
  let forAll = false;
  for (const raw of txt.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(); const val = m[2].trim();
    if (key === 'sitemap' && /^https?:/i.test(val)) out.sitemaps.push(val);
    else if (key === 'user-agent') forAll = val === '*';
    else if (key === 'disallow' && forAll && val) out.disallow.push(val);
  }
  return out;
}

function disallowed(u, rules) {
  if (!rules || !rules.length) return false;
  try { const p = new URL(u).pathname; return rules.some((r) => p.startsWith(r)); } catch { return false; }
}

/** Pull <loc> URLs out of a sitemap (recursing into sitemap indexes, capped). */
async function readSitemap(url, budget) {
  if (budget.fetches <= 0) return [];
  budget.fetches--;
  const xml = await fetchText(url, 12000);
  if (!xml) return [];
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
  if (/<sitemapindex/i.test(xml)) {
    const out = [];
    for (const child of locs.slice(0, 8)) {
      out.push(...await readSitemap(child, budget));
      if (out.length >= budget.limit) break;
    }
    return out;
  }
  return locs;
}

function sameSite(u, base, allowSubdomains) {
  try {
    const a = new URL(u); const b = new URL(base);
    if (a.protocol !== 'http:' && a.protocol !== 'https:') return false;
    if (a.hostname === b.hostname) return true;
    return !!allowSubdomains && a.hostname.endsWith('.' + b.hostname.replace(/^www\./, ''));
  } catch { return false; }
}

/** Accept array, JSON-encoded array, or comma-separated string (CLI/MCP friendly). */
function toList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return [];
  try { const j = JSON.parse(v); if (Array.isArray(j)) return j; } catch {}
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function pathAllowed(u, includePaths, excludePaths) {
  let p = '/';
  try { p = new URL(u).pathname; } catch { return false; }
  const exc = toList(excludePaths); const inc = toList(includePaths);
  if (exc.length && exc.some((rx) => safeTest(rx, p))) return false;
  if (inc.length) return inc.some((rx) => safeTest(rx, p));
  return true;
}
function safeTest(rx, s) { try { return new RegExp(rx).test(s); } catch { return s.includes(rx); } }

function normalize(u) {
  try { const x = new URL(u); x.hash = ''; return x.href; } catch { return null; }
}

/**
 * Discover a site's URLs WITHOUT crawling it (sitemaps first, links as fallback).
 * @param {string} url   site root or any page on it
 * @param {object} [o]   { limit=200, search, sitemapOnly=false }
 * @returns {Promise<{count:number, source:string, urls:string[]}>}
 */
async function map(url, o = {}) {
  const limit = Math.max(1, Math.min(Number(o.limit) || 200, 2000));
  const base = new URL(/^https?:/i.test(url) ? url : 'https://' + url);
  const origin = base.origin;

  const robots = await fetchRobots(origin);
  const budget = { fetches: 15, limit: limit * 3 };
  const seen = new Set();
  let source = 'sitemap';

  const smUrls = robots.sitemaps.length ? robots.sitemaps : [origin + '/sitemap.xml'];
  for (const sm of smUrls.slice(0, 4)) {
    for (const loc of await readSitemap(sm, budget)) {
      const n = normalize(loc);
      if (n && sameSite(n, origin, true)) seen.add(n);
      if (seen.size >= limit * 3) break;
    }
  }

  // Sitemap missing/thin → collect same-domain links from the page itself.
  if (seen.size < 5 && !o.sitemapOnly) {
    source = seen.size ? 'sitemap+links' : 'links';
    const browser = await Browser.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(base.href, { timeout: 20000 }).catch(() => {});
      await sleep(700);
      const links = await page.eval(
        `(function(){var out=[];var els=document.querySelectorAll('a[href]');` +
        `for(var i=0;i<els.length&&out.length<800;i++){var h=els[i].href;if(/^https?:/.test(h))out.push(h);}return out;})()`,
      );
      for (const l of links || []) {
        const n = normalize(l);
        if (n && sameSite(n, origin, false)) seen.add(n);
      }
    } finally { try { await browser.close(); } catch {} }
  }

  let urls = [...seen];
  if (o.search) {
    const needle = String(o.search).toLowerCase();
    // Match on the path+query only — the hostname would match everything
    // (e.g. searching "crawl" on docs.firecrawl.dev).
    urls = urls.filter((u) => { try { const x = new URL(u); return (x.pathname + x.search).toLowerCase().includes(needle); } catch { return false; } });
  }
  urls = urls.slice(0, limit);
  return { count: urls.length, source, urls };
}

/**
 * Crawl a site breadth-first with parallel headless pages.
 * @param {object} o
 * @param {string}  o.url
 * @param {number}  [o.limit=15]           max pages scraped (cap 100)
 * @param {number}  [o.maxDepth=3]         link depth from the start URL
 * @param {string[]} [o.includePaths]      regex allowlist on pathname
 * @param {string[]} [o.excludePaths]      regex blocklist on pathname
 * @param {boolean} [o.allowSubdomains]
 * @param {boolean} [o.ignoreRobots]       skip robots.txt Disallow rules
 * @param {number}  [o.concurrency=4]
 * @param {number}  [o.textChars=1500]     text budget per page (0 = urls+titles only)
 * @param {(ev)=>void} [o.onEvent]
 * @returns {Promise<{count:number, ok:number, pages:Array}>}
 */
async function crawl(o = {}) {
  if (!o.url) throw new Error('crawl: provide url');
  const limit = Math.max(1, Math.min(Number(o.limit) || 15, 100));
  // NOTE: `Number(undefined) ?? 3` is NaN (NaN isn't nullish) — guard explicitly.
  const maxDepth = o.maxDepth === undefined ? 3 : Math.max(0, Math.min(Number(o.maxDepth) || 0, 10));
  const conc = Math.max(1, Math.min(Number(o.concurrency) || 4, 8));
  const textChars = o.textChars === 0 ? 0 : Math.min(Number(o.textChars) || 1500, 6000);
  const onEvent = typeof o.onEvent === 'function' ? o.onEvent : () => {};

  const start = normalize(/^https?:/i.test(o.url) ? o.url : 'https://' + o.url);
  const origin = new URL(start).origin;
  const robots = o.ignoreRobots ? { disallow: [] } : await fetchRobots(origin);

  const queue = [{ url: start, depth: 0 }];
  const seen = new Set([start]);
  const pages = [];
  let scraped = 0;

  const browser = await Browser.launch({ headless: true });
  let active = 0; // in-flight pages: the frontier can still grow while they run,
  //                so idle workers must WAIT, not exit (else BFS turns sequential).
  async function worker() {
    while (scraped < limit) {
      if (!queue.length) {
        if (active === 0) break; // frontier exhausted for good
        await sleep(150);
        continue;
      }
      const item = queue.shift();
      if (!item) continue;
      scraped++;
      active++;
      const rec = { url: item.url, depth: item.depth, ok: false };
      let page = null;
      onEvent({ type: 'start', url: item.url });
      try {
        page = await browser.newPage();
        await page.goto(item.url, { timeout: 25000 }).catch(() => {});
        await sleep(600);
        const snap = await perception.snapshot(page, { maxEls: 0 });
        rec.title = snap.title || '';
        if (textChars) rec.text = String(snap.text || '').slice(0, textChars);
        rec.ok = true;
        if (item.depth < maxDepth && scraped + queue.length < limit * 3) {
          const links = await page.eval(
            `(function(){var out=[];var els=document.querySelectorAll('a[href]');` +
            `for(var i=0;i<els.length&&out.length<300;i++){var h=els[i].href;if(/^https?:/.test(h))out.push(h);}return out;})()`,
          ).catch(() => []);
          for (const l of links || []) {
            const n = normalize(l);
            if (!n || seen.has(n)) continue;
            if (!sameSite(n, origin, o.allowSubdomains)) continue;
            if (!pathAllowed(n, o.includePaths, o.excludePaths)) continue;
            if (disallowed(n, robots.disallow)) continue;
            seen.add(n);
            queue.push({ url: n, depth: item.depth + 1 });
          }
        }
      } catch (e) {
        rec.error = (e && e.message) || String(e);
      } finally {
        active--;
        try { if (page) await page._c.send('Target.closeTarget', { targetId: page.targetId }); } catch {}
      }
      pages.push(rec);
      onEvent({ type: 'done', url: item.url, ok: rec.ok });
    }
  }

  try {
    await Promise.all(Array.from({ length: conc }, () => worker()));
    return { count: pages.length, ok: pages.filter((p) => p.ok).length, pages };
  } finally {
    try { await browser.close(); } catch {}
  }
}

module.exports = { map, crawl, fetchRobots };
