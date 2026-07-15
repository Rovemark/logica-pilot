'use strict';

/**
 * http-engine.js — Browserless HTTP fetch + parse tier (Apify/Crawlee's cheap path).
 *
 * ~70% of the web renders fine over plain HTTP. Spinning a whole Chrome for those
 * pages is 10-50x slower and ~100x more RAM. This module fetches over raw HTTP
 * (zero-dependency: Node http/https/zlib/net/tls) and then — to reuse Logica Pilot's
 * EXISTING DOM-based parsers (read/observe/extract/meta/product) without paying for
 * a navigation — loads the fetched HTML into a page via CDP Page.setDocumentContent
 * (no network, no subresources, no JS execution, no render).
 *
 *   const { status, body, url } = await httpFetch('https://…', { proxy, cookies });
 *   await loadHtml(page, body, url);   // now read/extract/meta/product work on it
 *
 * Supports: redirects, gzip/deflate/br, browser-like headers, a cookie jar, and
 * HTTP(S) proxies via CONNECT tunneling (so a proxy string user:pass@host:port works
 * for plain requests — no Chromium needed).
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Browser-like headers in Chrome's canonical order. When a fingerprint is supplied,
// UA + client-hints + accept-language are all derived from it (internally consistent,
// and rotatable) instead of static — closing the cheapest anti-bot signals. Pure Node
// can't byte-match a browser's JA3/TLS ClientHello, so for JA3-sensitive hosts route
// through the real browser (engine:'browser'/adaptive) — this hardens the cheap path.
function defaultHeaders(u, fp) {
  if (fp) {
    const ch = require('./fingerprint').clientHints(fp);
    return {
      'user-agent': fp.userAgent,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': fp.acceptLanguage || 'en-US,en;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      ...ch,
      'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none',
      'upgrade-insecure-requests': '1', host: u.host,
    };
  }
  return {
    'user-agent': CHROME_UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'upgrade-insecure-requests': '1',
    host: u.host,
  };
}

// parse "user:pass@host:port" (or "http://host:port") → { host, port, auth }
function parseProxy(p) {
  if (!p) return null;
  let s = String(p).replace(/^https?:\/\//, '');
  let auth = null;
  const at = s.lastIndexOf('@');
  if (at >= 0) { auth = s.slice(0, at); s = s.slice(at + 1); }
  const [host, port] = s.split(':');
  return { host, port: Number(port) || 8080, auth };
}

// Send one request (no redirect handling) — direct, or via an HTTP(S) proxy.
// Resolves with the Node response object (a stream).
function doRequest(current, { method, headers, body, px, timeout }) {
  const u = new URL(current);
  const isTls = u.protocol === 'https:';
  const port = Number(u.port) || (isTls ? 443 : 80);

  return new Promise((resolve, reject) => {
    const finish = (req) => {
      req.setTimeout(timeout, () => req.destroy(new Error('request timeout')));
      req.on('error', reject);
      if (body != null) req.write(body);
      req.end();
    };

    if (!px) {
      // Direct — let Node handle DNS/TCP/TLS.
      const lib = isTls ? https : http;
      finish(lib.request(
        { hostname: u.hostname, port, method, path: u.pathname + u.search, headers, servername: u.hostname },
        resolve,
      ));
      return;
    }

    const pauth = px.auth ? { 'proxy-authorization': 'Basic ' + Buffer.from(px.auth).toString('base64') } : {};

    if (!isTls) {
      // Plain HTTP through the proxy: request the absolute URI from the proxy.
      finish(http.request(
        { host: px.host, port: px.port, method, path: current, headers: { ...headers, ...pauth } },
        resolve,
      ));
      return;
    }

    // HTTPS through the proxy: CONNECT tunnel, then TLS on the tunneled socket.
    const creq = http.request({
      host: px.host, port: px.port, method: 'CONNECT', path: `${u.hostname}:${port}`,
      headers: { host: `${u.hostname}:${port}`, ...pauth },
    });
    creq.setTimeout(timeout, () => creq.destroy(new Error('proxy connect timeout')));
    creq.on('error', reject);
    creq.on('connect', (cres, socket) => {
      if (cres.statusCode !== 200) { socket.destroy(); return reject(new Error(`proxy CONNECT ${cres.statusCode}`)); }
      finish(https.request(
        { method, path: u.pathname + u.search, headers, createConnection: () => tls.connect({ socket, servername: u.hostname }) },
        resolve,
      ));
    });
    creq.end();
  });
}

function decompress(buf, encoding) {
  try {
    if (/\bbr\b/.test(encoding)) return zlib.brotliDecompressSync(buf);
    if (/\bgzip\b/.test(encoding)) return zlib.gunzipSync(buf);
    if (/\bdeflate\b/.test(encoding)) return zlib.inflateSync(buf);
  } catch { /* fall through: return as-is */ }
  return buf;
}

function serializeCookies(jar, u) {
  if (!jar) return '';
  const host = u.hostname;
  return Object.entries(jar)
    .filter(([, c]) => !c.domain || host.endsWith(c.domain.replace(/^\./, '')))
    .map(([k, c]) => `${k}=${c.value}`)
    .join('; ');
}

function absorbSetCookie(jar, headers) {
  if (!jar) return;
  const sc = headers['set-cookie'];
  if (!sc) return;
  for (const line of Array.isArray(sc) ? sc : [sc]) {
    const [pair, ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const domAttr = attrs.map((a) => a.trim()).find((a) => /^domain=/i.test(a));
    jar[name] = { value, domain: domAttr ? domAttr.split('=')[1] : null };
  }
}

/**
 * Fetch a URL over raw HTTP (no browser).
 * @param {string} url
 * @param {object} opts { method, headers, body, cookies(jar obj), proxy(str), timeout, maxRedirects, maxBytes }
 * @returns {{status, headers, body, url, redirects, contentType}}
 */
async function httpFetch(url, opts = {}) {
  const {
    method = 'GET', body = null, cookies = null, proxy = null,
    timeout = 30000, maxRedirects = 8, maxBytes = 15 * 1024 * 1024,
  } = opts;
  const px = parseProxy(proxy);
  const jar = cookies && typeof cookies === 'object' ? cookies : (cookies ? {} : null);
  // Optional realistic fingerprint (true = generate one; or pass a generated fp).
  const fp = opts.fingerprint === true ? require('./fingerprint').generate({}) : (opts.fingerprint && typeof opts.fingerprint === 'object' ? opts.fingerprint : null);

  let current = url;
  let redirects = 0;
  for (;;) {
    const u = new URL(current);
    const headers = { ...defaultHeaders(u, fp), ...(opts.headers || {}) };
    const ck = serializeCookies(jar, u);
    if (ck) headers.cookie = ck;
    if (body != null) headers['content-length'] = Buffer.byteLength(body);

    const res = await doRequest(current, { method, headers, body, px, timeout });

    absorbSetCookie(jar, res.headers);

    // Follow redirects.
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < maxRedirects) {
      res.resume(); // drain
      current = new URL(res.headers.location, current).toString();
      redirects++;
      continue;
    }

    const chunks = [];
    let total = 0;
    const raw = await new Promise((resolve, reject) => {
      res.on('data', (c) => {
        total += c.length;
        if (total > maxBytes) { res.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    const decoded = decompress(raw, res.headers['content-encoding'] || '');
    return {
      status: res.statusCode,
      headers: res.headers,
      contentType: res.headers['content-type'] || '',
      body: decoded.toString('utf8'),
      url: current,
      redirects,
    };
  }
}

/**
 * Load already-fetched HTML into a CDP page so the DOM-based parsers work — WITHOUT
 * a navigation (no network, no subresources, no JS). Injects a <base> so relative
 * links/images resolve against the real URL.
 */
async function loadHtml(page, html, baseUrl) {
  let doc = String(html || '');
  if (baseUrl && !/<base\b/i.test(doc)) {
    const baseTag = `<base href="${baseUrl.replace(/"/g, '&quot;')}">`;
    doc = /<head[^>]*>/i.test(doc) ? doc.replace(/<head[^>]*>/i, (m) => m + baseTag) : baseTag + doc;
  }
  const { frameTree } = await page.send('Page.getFrameTree');
  const frameId = frameTree && frameTree.frame && frameTree.frame.id;
  await page.send('Page.setDocumentContent', { frameId, html: doc });
  return { loaded: true, bytes: doc.length, url: baseUrl };
}

module.exports = { httpFetch, loadHtml, parseProxy, CHROME_UA };
