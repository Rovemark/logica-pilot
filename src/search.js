'use strict';

/**
 * search.js — Web search (0-dep) to feed the fanout (research/compare/deal).
 *
 * Order: if BRAVE_SEARCH_API_KEY is available, uses Brave Search API (reliable).
 * Otherwise, performs best-effort scraping of Bing (tolerant to bots; decodes the
 * redirect u=a1<base64>). The DuckDuckGo HTML was discarded (bot challenge).
 */

const { Browser } = require('./browser');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Decodes the search result link from Bing (bing.com/ck/a?...&u=a1<base64>). */
function decodeBing(href) {
  try {
    const u = new URL(href, 'https://www.bing.com');
    const p = u.searchParams.get('u');
    if (p && /^a1/.test(p)) {
      let b64 = p.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      b64 += '='.repeat((4 - (b64.length % 4)) % 4);
      const dec = Buffer.from(b64, 'base64').toString('utf8');
      if (/^https?:/i.test(dec)) return dec;
    }
    if (u.hostname !== 'www.bing.com' && /^https?:/i.test(href)) return href;
    return href;
  } catch { return href; }
}

async function searchBrave(query, limit, key) {
  const url = 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=' + limit;
  const res = await fetch(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': key } });
  if (!res.ok) return [];
  const j = await res.json();
  return ((j.web && j.web.results) || []).slice(0, limit).map((r) => ({ title: r.title, url: r.url }));
}

async function searchBing(query, limit) {
  const browser = await Browser.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('https://www.bing.com/search?q=' + encodeURIComponent(query), { timeout: 20000 }).catch(() => {});
    await sleep(700);
    const raw = await page.eval(
      '(function(){var out=[];var els=document.querySelectorAll(".b_algo h2 a");' +
      'for(var i=0;i<els.length;i++){var a=els[i];out.push({title:(a.innerText||"").trim().slice(0,160),href:a.getAttribute("href")||""});}' +
      'return out;})()',
    );
    const results = [];
    const seen = {};
    for (const r of raw || []) {
      const url = decodeBing(r.href);
      if (!/^https?:/i.test(url)) continue;
      let host = '';
      try { host = new URL(url).hostname; } catch { continue; }
      if (/(^|\.)bing\.com$/.test(host) || /microsoft/.test(host)) continue;
      if (seen[url]) continue; seen[url] = 1;
      results.push({ title: r.title, url });
      if (results.length >= limit) break;
    }
    return results;
  } finally {
    try { await browser.close(); } catch {}
  }
}

/**
 * @param {string} query
 * @param {object} [o]  { limit=8 }
 * @returns {Promise<Array<{title:string,url:string}>>}
 */
async function search(query, o = {}) {
  const limit = Math.max(1, Math.min(o.limit || 8, 20));
  const key = process.env.BRAVE_SEARCH_API_KEY || process.env.BRAVE_API_KEY;
  if (key) {
    const r = await searchBrave(query, limit, key).catch(() => []);
    if (r.length) return r;
  }
  return searchBing(query, limit);
}

module.exports = { search, decodeBing };
