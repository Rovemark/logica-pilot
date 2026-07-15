'use strict';

/**
 * jsdata.js — Surface in-page JS state (hydration blobs) + reverse-locate a value.
 *
 * Framework hydration state holds clean, structured data BEFORE it's rendered into
 * HTML — invisible to a DOM/a11y map. `surface()` pulls the well-known blobs
 * (__NEXT_DATA__, __NUXT__, __APOLLO_STATE__, __INITIAL_STATE__, self.__next_f, …)
 * plus every <script type="application/json"|"application/ld+json">.
 *
 * `locate(value)` is the reverse-lookup that authors a scraper: paste a value you
 * SEE on the page and it tells you the exact JSON-path (and source) that yields it —
 * across the hydration blobs, JSON scripts, and (optionally) a discovered API catalog.
 *
 * Pure CDP page.eval, zero-dep.
 */

const SURFACE = `(() => {
  const out = { hydration: {}, jsonScripts: [], globals: [] };
  const KNOWN = ['__NEXT_DATA__','__NUXT__','__APOLLO_STATE__','__INITIAL_STATE__','__PRELOADED_STATE__','__data','__remixContext','__sveltekit','_sharedData','__STATE__','__REDUX_STATE__'];
  const clip = (v) => { try { const s = JSON.stringify(v); return s.length > 200000 ? JSON.parse(s.slice(0, 200000)) : v; } catch { return undefined; } };
  for (const k of KNOWN) { try { if (window[k] != null) out.hydration[k] = clip(window[k]); } catch(e){} }
  // Next.js streaming (self.__next_f) — concatenated flight payload
  try { if (Array.isArray(self.__next_f) && self.__next_f.length) out.hydration.__next_f_len = self.__next_f.length; } catch(e){}
  for (const s of document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]')) {
    try { const data = JSON.parse(s.textContent); out.jsonScripts.push({ id: s.id || null, type: s.type, data: clip(data) }); } catch(e){}
  }
  return out;
})()`;

/** Pull hydration state + JSON script blobs from the current page. */
async function surface(page) {
  return page.eval(SURFACE);
}

// Walk a structure, collecting JSON-paths whose leaf matches the predicate.
function walk(node, pred, pathParts, hits, source, depth) {
  if (depth > 8 || hits.length > 50) return;
  if (node && typeof node === 'object') {
    const entries = Array.isArray(node) ? node.map((v, i) => [i, v]) : Object.entries(node);
    for (const [k, v] of entries) {
      const p = Array.isArray(node) ? `${pathParts}[${k}]` : `${pathParts}${pathParts ? '.' : ''}${k}`;
      if (v && typeof v === 'object') walk(v, pred, p, hits, source, depth + 1);
      else if (pred(v)) hits.push({ source, path: p, value: String(v).slice(0, 120) });
    }
  } else if (pred(node)) {
    hits.push({ source, path: pathParts || '(root)', value: String(node).slice(0, 120) });
  }
}

/**
 * Reverse-locate `value` across in-page state (+ optional API catalog).
 * @param {string} value  the on-page value to find
 * @param {object} opts { regex, catalog (from apis.discover) }
 * @returns {Array<{source, path, value}>}
 */
async function locate(page, value, { regex = false, catalog = null } = {}) {
  const src = await surface(page);
  let pred;
  if (regex) { const re = new RegExp(value, 'i'); pred = (v) => v != null && re.test(String(v)); }
  else { const needle = String(value).toLowerCase(); pred = (v) => v != null && String(v).toLowerCase().includes(needle); }

  const hits = [];
  for (const [k, v] of Object.entries(src.hydration)) walk(v, pred, '', hits, `window.${k}`, 0);
  src.jsonScripts.forEach((s, i) => walk(s.data, pred, '', hits, `script[${s.id || s.type}#${i}]`, 0));
  if (Array.isArray(catalog)) catalog.forEach((c) => walk(c.sampleBody, pred, '', hits, `api ${c.method} ${c.url}`, 0));

  // Also check the raw HTML text (fallback, ranked last).
  const inHtml = await page.eval(`(() => { const t = document.body ? document.body.innerText : ''; return t.toLowerCase().includes(${JSON.stringify(String(value).toLowerCase())}); })()`).catch(() => false);

  // Structured/API hits first, HTML fallback last.
  const rank = (h) => (h.source.startsWith('api') ? 0 : h.source.startsWith('window') ? 1 : 2);
  hits.sort((a, b) => rank(a) - rank(b));
  return { value, hits: hits.slice(0, 25), alsoInVisibleText: !!inHtml, sources: { hydration: Object.keys(src.hydration), jsonScripts: src.jsonScripts.length } };
}

module.exports = { surface, locate };
