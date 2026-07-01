'use strict';

/**
 * news.js — PT-BR/Brazil news feed for the start page (pilot://newtab).
 *
 * The main fetches RSS SERVER-SIDE (fetch from Node/undici, no CORS, no API key) and
 * returns normalized JSON for the home. NO npm dependency: manual regex parsing of
 * <item> tags, image extraction via fallbacks, HTML entity decoding, and HTML/CDATA
 * cleanup. Memory cache per category (~10 min) and fetch timeout (~6s) with try/catch
 * per feed (one downed source does not crash the route).
 *
 * Validated sources (30/06/2026): the G1/Globo family embeds rich images via
 * <media:content url> in ALL items; CNN Brasil and InfoMoney bring images
 * as <img src> inside <description>/<content:encoded> (fallback). Google
 * News BR does not include images (placeholder on front) but broadens text coverage.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;   // 10 min per category
const FETCH_TIMEOUT_MS = 6000;          // 6s per feed
const MAX_ITEMS = 24;                    // ceiling of items per category
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ── Category map → RSS feeds ────────────────────────────────────────────
// Each category blends 1–2 feeds. The G1 family (dynamo/rss2.xml) is the anchor because
// it delivers <media:content> in all items; CNN/InfoMoney supplement with <img>.
const FEEDS = {
  // "For you" / highlights — blends general headlines + Brazil + technology
  top: [
    { url: 'https://g1.globo.com/rss/g1/', source: 'g1' },
    { url: 'https://www.cnnbrasil.com.br/feed/', source: 'CNN Brasil' },
  ],
  brasil: [
    { url: 'https://g1.globo.com/dynamo/brasil/rss2.xml', source: 'g1' },
    { url: 'https://g1.globo.com/dynamo/politica/rss2.xml', source: 'g1 — Politics' },
  ],
  mundo: [
    { url: 'https://g1.globo.com/dynamo/mundo/rss2.xml', source: 'g1 — World' },
    {
      url: 'https://news.google.com/rss/headlines/section/topic/WORLD?hl=pt-BR&gl=BR&ceid=BR:pt-419',
      source: 'Google News',
    },
  ],
  tecnologia: [
    { url: 'https://g1.globo.com/dynamo/tecnologia/rss2.xml', source: 'g1 — Technology' },
    {
      url: 'https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=pt-BR&gl=BR&ceid=BR:pt-419',
      source: 'Google News',
    },
  ],
  esportes: [
    { url: 'https://ge.globo.com/rss/ge/', source: 'ge' },
  ],
  economia: [
    { url: 'https://g1.globo.com/dynamo/economia/rss2.xml', source: 'g1 — Economy' },
    { url: 'https://www.infomoney.com.br/feed/', source: 'InfoMoney' },
  ],
  entretenimento: [
    { url: 'https://g1.globo.com/dynamo/pop-arte/rss2.xml', source: 'g1 — Pop & Arts' },
  ],
};

const CATEGORIES = Object.keys(FEEDS);

// ── Memory cache per category ────────────────────────────────────────────
const cache = new Map(); // cat -> { ts, items }

// ── Parsing helpers ────────────────────────────────────────────────────────

/** Removes the <![CDATA[ ... ]]> envelope (keeps inner content). */
function stripCdata(s) {
  if (!s) return '';
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/** Decodes the most common HTML entities from feeds. */
function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/'/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_m, d) => {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch { return _m; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _m; }
    })
    .replace(/&/g, '&'); // last, to avoid reprocessing freshly-decoded entities
}

/** Clean title/source text: strips CDATA, HTML tags, and normalizes whitespace. */
function cleanText(raw) {
  if (!raw) return '';
  let s = stripCdata(raw);
  s = s.replace(/<[^>]+>/g, ' ');     // remove any HTML tag
  s = decodeEntities(s);
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Captures the content of a tag within a block (first occurrence). */
function tag(block, name) {
  // accepts namespaces (e.g. dc:creator) and attributes in the opening tag
  const re = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

/**
 * Extracts the best image from the item, in order of preference:
 *   1. <media:content url="..."> (with type image/* or medium image, or without type)
 *   2. <media:thumbnail url="...">
 *   3. <enclosure type="image/..." url="...">
 *   4. first <img src="..."> in description/content:encoded
 * Returns absolute https URL or null.
 */
function extractImage(block) {
  // 1) media:content — prioritizes those marked as images; falls back to first url
  const mediaContents = block.match(/<media:content\b[^>]*>/gi) || [];
  let firstMediaUrl = null;
  for (const mc of mediaContents) {
    const u = (mc.match(/\burl="([^"]+)"/i) || [])[1];
    if (!u) continue;
    if (!firstMediaUrl) firstMediaUrl = u;
    const type = (mc.match(/\btype="([^"]+)"/i) || [])[1] || '';
    const medium = (mc.match(/\bmedium="([^"]+)"/i) || [])[1] || '';
    if (/^image\//i.test(type) || /image/i.test(medium)) {
      return sanitizeImg(u);
    }
  }
  if (firstMediaUrl && looksLikeImage(firstMediaUrl)) return sanitizeImg(firstMediaUrl);

  // 2) media:thumbnail
  const thumb = (block.match(/<media:thumbnail\b[^>]*\burl="([^"]+)"/i) || [])[1];
  if (thumb) return sanitizeImg(thumb);

  // 3) enclosure image/*
  const enclosures = block.match(/<enclosure\b[^>]*>/gi) || [];
  for (const en of enclosures) {
    const type = (en.match(/\btype="([^"]+)"/i) || [])[1] || '';
    const u = (en.match(/\burl="([^"]+)"/i) || [])[1];
    if (u && (/^image\//i.test(type) || looksLikeImage(u))) return sanitizeImg(u);
  }

  // 4) first <img src> inside description / content:encoded
  const body = stripCdata(tag(block, 'content:encoded') || tag(block, 'description'));
  const imgSrc = (body.match(/<img\b[^>]*\bsrc="([^"]+)"/i) || [])[1];
  if (imgSrc) return sanitizeImg(decodeEntities(imgSrc));

  // 5) fallback: media:content without type that still exists
  if (firstMediaUrl) return sanitizeImg(firstMediaUrl);

  return null;
}

function looksLikeImage(u) {
  return /\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i.test(u || '');
}

/** Accepts only https images (CSP img-src https:). Rejects data:/http: for security. */
function sanitizeImg(u) {
  if (!u) return null;
  const url = decodeEntities(String(u).trim());
  if (/^https:\/\//i.test(url)) return url;
  // promotes http→https where possible (image CDNs serve both)
  if (/^http:\/\//i.test(url)) return url.replace(/^http:/i, 'https:');
  return null;
}

/** pubDate → epoch ms (NaN-safe → 0). */
function parseDate(s) {
  if (!s) return 0;
  const t = Date.parse(cleanText(s));
  return Number.isFinite(t) ? t : 0;
}

/** Clean hostname from a URL (for source fallback). */
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

/**
 * Parses RSS/Atom XML into normalized items.
 * @param {string} xml
 * @param {string} category
 * @param {string} sourceLabel label for the source (falls back to <channel><title> / host)
 */
function parseRss(xml, category, sourceLabel) {
  if (!xml) return [];
  const channelTitle = cleanText(tag(xml, 'title')); // first <title> = channel
  // supports RSS (<item>) and Atom (<entry>)
  let blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi);
  let isAtom = false;
  if (!blocks || !blocks.length) {
    blocks = xml.match(/<entry\b[\s\S]*?<\/entry>/gi);
    isAtom = !!blocks;
  }
  if (!blocks) return [];

  const out = [];
  for (const block of blocks) {
    const title = cleanText(tag(block, 'title'));
    if (!title) continue;

    // link: RSS <link>...</link>; Atom <link href="..."/>
    let link = cleanText(tag(block, 'link'));
    if (!link && isAtom) {
      link = (block.match(/<link\b[^>]*\bhref="([^"]+)"/i) || [])[1] || '';
      link = decodeEntities(link);
    }
    if (!/^https?:\/\//i.test(link)) continue;

    const image = extractImage(block);
    const ts =
      parseDate(tag(block, 'pubDate')) ||
      parseDate(tag(block, 'published')) ||
      parseDate(tag(block, 'updated')) ||
      parseDate(tag(block, 'dc:date'));

    // item source: <source> from RSS (Google News uses) > configured label >
    // channel title > host from link
    const itemSource =
      cleanText(tag(block, 'source')) ||
      sourceLabel ||
      channelTitle ||
      hostOf(link);

    out.push({
      title,
      link,
      source: itemSource,
      image: image || null,
      ts: ts || 0,
      category,
    });
  }
  return out;
}

// ── Fetch with timeout (AbortController) ───────────────────────────────────────
async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/rss+xml, application/xml, text/xml, */*',
        'accept-language': 'pt-BR,pt;q=0.9',
      },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ── Dedup + sorting ─────────────────────────────────────────────────────
function dedupeAndSort(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = (it.link || '').split('#')[0] + '|' + it.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  // prioritizes items WITH images at top (MSN/Edge-style UX), then by date desc
  out.sort((a, b) => {
    if (!!a.image !== !!b.image) return a.image ? -1 : 1;
    return (b.ts || 0) - (a.ts || 0);
  });
  return out;
}

/**
 * Fetches + parses all feeds for a category, with memory cache.
 * A downed source (timeout/HTTP/parse) is ignored without crashing the category.
 * @returns {Promise<{ok:boolean, items:Array, cached?:boolean, error?:string}>}
 */
async function getNews(rawCat) {
  const cat = CATEGORIES.includes(rawCat) ? rawCat : 'top';

  const hit = cache.get(cat);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    return { ok: true, items: hit.items, cached: true };
  }

  const feeds = FEEDS[cat] || FEEDS.top;
  const results = await Promise.allSettled(
    feeds.map(async (f) => {
      const xml = await fetchText(f.url);
      return parseRss(xml, cat, f.source);
    }),
  );

  let items = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) items = items.concat(r.value);
  }

  items = dedupeAndSort(items).slice(0, MAX_ITEMS);

  if (!items.length) {
    // keeps old cache if it exists (graceful degradation); otherwise signals error
    if (hit) return { ok: true, items: hit.items, cached: true, stale: true };
    return { ok: false, items: [], error: 'no items' };
  }

  cache.set(cat, { ts: Date.now(), items });
  return { ok: true, items };
}

module.exports = {
  getNews,
  CATEGORIES,
  // exported for testing/internal use
  parseRss,
  extractImage,
  cleanText,
  decodeEntities,
};
