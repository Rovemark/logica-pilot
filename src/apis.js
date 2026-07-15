'use strict';

/**
 * apis.js — Backend XHR/AJAX/JSON-API discovery + replay (Apify page-analyzer's
 * best trick). Instead of scraping rendered HTML, find the private JSON endpoints
 * the page ITSELF calls and hit them directly — far cheaper and more reliable.
 *
 *   const cat = await discover(page, url);      // ranked catalog of JSON endpoints
 *   const data = await replay(page, cat[0].url, { params: { page: 2 } });
 *
 * discover() enables Network, navigates, and grabs each XHR/Fetch JSON body the
 * moment it finishes (before eviction). replay() re-fires via in-page fetch so it
 * carries the live session cookies/auth and bypasses CORS. Pure CDP, zero-dep.
 */

function shapeOf(v, depth = 0) {
  if (depth > 3) return '…';
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).slice(0, 25)) o[k] = shapeOf(v[k], depth + 1); return o; }
  return typeof v;
}

function richness(body) {
  try { const s = JSON.stringify(body); return s.length + (Array.isArray(body) ? body.length * 50 : Object.keys(body || {}).length * 20); } catch { return 0; }
}

function normalize(url) {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; }
}

/**
 * Discover the JSON APIs a page calls.
 * @param {object} opts { duration (ms extra after load), max, includeAll }
 */
async function discover(page, url, { duration = 5000, max = 40, includeAll = false } = {}) {
  const conn = page._c;
  const meta = new Map();   // requestId -> {method,url,headers,postData,type}
  const found = [];

  await page.send('Network.enable').catch(() => {});

  const onReq = (p, sid) => {
    if (sid !== page.sessionId) return;
    meta.set(p.requestId, { method: p.request.method, url: p.request.url, headers: p.request.headers || {}, postData: p.request.postData || null, type: p.type || '' });
  };
  const onResp = (p, sid) => {
    if (sid !== page.sessionId) return;
    const m = meta.get(p.requestId);
    if (m) { m.status = p.response.status; m.mimeType = p.response.mimeType || ''; }
  };
  const onFinished = async (p, sid) => {
    if (sid !== page.sessionId) return;
    const m = meta.get(p.requestId);
    if (!m) return;
    const isApi = /Fetch|XHR/i.test(m.type) || /json/i.test(m.mimeType || '');
    if (!isApi && !includeAll) { meta.delete(p.requestId); return; }
    try {
      const { body, base64Encoded } = await page.send('Network.getResponseBody', { requestId: p.requestId });
      const raw = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
      let parsed = null; try { parsed = JSON.parse(raw); } catch {}
      if (parsed == null && !includeAll) { meta.delete(p.requestId); return; }
      found.push({ method: m.method, url: m.url, type: m.type, status: m.status, contentType: m.mimeType, postData: m.postData, bytes: raw.length, sampleBody: parsed, shape: parsed != null ? shapeOf(parsed) : undefined });
    } catch {}
    meta.delete(p.requestId);
  };

  conn.on('Network.requestWillBeSent', onReq);
  conn.on('Network.responseReceived', onResp);
  conn.on('Network.loadingFinished', onFinished);

  try {
    if (url) await page.goto(url);
    await new Promise((r) => setTimeout(r, duration));
  } finally {
    conn.off('Network.requestWillBeSent', onReq);
    conn.off('Network.responseReceived', onResp);
    conn.off('Network.loadingFinished', onFinished);
  }

  // Dedupe by normalized URL (keep the richest sample), rank by richness.
  const byKey = new Map();
  for (const f of found) {
    const key = f.method + ' ' + normalize(f.url);
    const prev = byKey.get(key);
    if (!prev || richness(f.sampleBody) > richness(prev.sampleBody)) byKey.set(key, f);
  }
  const catalog = [...byKey.values()].sort((a, b) => richness(b.sampleBody) - richness(a.sampleBody)).slice(0, max);
  return catalog.map((c, i) => ({ id: i, ...c, sampleBody: truncate(c.sampleBody) }));
}

function truncate(v, budget = 1500) {
  try { const s = JSON.stringify(v); if (s.length <= budget) return v; return JSON.parse(s.slice(0, budget)); } catch { const s = JSON.stringify(v) || ''; return s.slice(0, budget) + '…'; }
}

/**
 * Replay an endpoint via in-page fetch (carries live cookies/auth, bypasses CORS).
 * @param {object} opts { method, params (query overrides), body, headers }
 */
async function replay(page, url, { method = 'GET', params, body, headers } = {}) {
  let target = url;
  if (params && typeof params === 'object') { try { const u = new URL(url); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); target = u.toString(); } catch {} }
  const opts = { method, headers: headers || {} };
  if (body != null) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  const expr = `fetch(${JSON.stringify(target)}, ${JSON.stringify(opts)}).then(async r => ({ status: r.status, contentType: r.headers.get('content-type'), body: await r.text() })).catch(e => ({ error: String(e) }))`;
  const res = await page.eval(expr);
  if (res && typeof res.body === 'string') { try { res.json = JSON.parse(res.body); delete res.body; } catch {} }
  return { url: target, ...res };
}

module.exports = { discover, replay, shapeOf };
