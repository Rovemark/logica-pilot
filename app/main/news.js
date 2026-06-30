'use strict';

/**
 * news.js — Feed de notícias PT-BR/Brasil para a start page (pilot://newtab).
 *
 * O main busca RSS SERVER-SIDE (fetch do Node/undici, sem CORS, sem API key) e
 * devolve JSON normalizado para a home. SEM dependência npm: parse manual por
 * regex dos <item>, extração de imagem por fallbacks, decode de entidades e
 * limpeza de HTML/CDATA. Cache em memória por categoria (~10 min) e timeout por
 * fetch (~6s) com try/catch por feed (uma fonte caída não derruba a rota).
 *
 * Fontes validadas (30/06/2026): a família G1/Globo embute imagem rica via
 * <media:content url> em TODOS os itens; CNN Brasil e InfoMoney trazem a imagem
 * como <img src> dentro do <description>/<content:encoded> (fallback). Google
 * News BR não traz imagem (placeholder no front) mas amplia a cobertura de texto.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;   // 10 min por categoria
const FETCH_TIMEOUT_MS = 6000;          // 6s por feed
const MAX_ITEMS = 24;                    // teto de itens por categoria
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ── Mapa de categorias → feeds RSS ────────────────────────────────────────────
// Cada categoria mescla 1–2 feeds. A família G1 (dynamo/rss2.xml) é a âncora por
// trazer <media:content> em todos os itens; CNN/InfoMoney complementam com <img>.
const FEEDS = {
  // "Para você" / destaques — mescla manchetes gerais + Brasil + tecnologia
  top: [
    { url: 'https://g1.globo.com/rss/g1/', source: 'g1' },
    { url: 'https://www.cnnbrasil.com.br/feed/', source: 'CNN Brasil' },
  ],
  brasil: [
    { url: 'https://g1.globo.com/dynamo/brasil/rss2.xml', source: 'g1' },
    { url: 'https://g1.globo.com/dynamo/politica/rss2.xml', source: 'g1 — Política' },
  ],
  mundo: [
    { url: 'https://g1.globo.com/dynamo/mundo/rss2.xml', source: 'g1 — Mundo' },
    {
      url: 'https://news.google.com/rss/headlines/section/topic/WORLD?hl=pt-BR&gl=BR&ceid=BR:pt-419',
      source: 'Google Notícias',
    },
  ],
  tecnologia: [
    { url: 'https://g1.globo.com/dynamo/tecnologia/rss2.xml', source: 'g1 — Tecnologia' },
    {
      url: 'https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=pt-BR&gl=BR&ceid=BR:pt-419',
      source: 'Google Notícias',
    },
  ],
  esportes: [
    { url: 'https://ge.globo.com/rss/ge/', source: 'ge' },
  ],
  economia: [
    { url: 'https://g1.globo.com/dynamo/economia/rss2.xml', source: 'g1 — Economia' },
    { url: 'https://www.infomoney.com.br/feed/', source: 'InfoMoney' },
  ],
  entretenimento: [
    { url: 'https://g1.globo.com/dynamo/pop-arte/rss2.xml', source: 'g1 — Pop & Arte' },
  ],
};

const CATEGORIES = Object.keys(FEEDS);

// ── Cache em memória por categoria ────────────────────────────────────────────
const cache = new Map(); // cat -> { ts, items }

// ── Helpers de parsing ────────────────────────────────────────────────────────

/** Remove o envelope <![CDATA[ ... ]]> (mantém o conteúdo interno). */
function stripCdata(s) {
  if (!s) return '';
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/** Decodifica as entidades HTML mais comuns dos feeds. */
function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_m, d) => {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch { return _m; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _m; }
    })
    .replace(/&amp;/g, '&'); // por último, para não reprocessar entidades recém-decodificadas
}

/** Texto limpo de título/fonte: tira CDATA, tags HTML e normaliza espaços. */
function cleanText(raw) {
  if (!raw) return '';
  let s = stripCdata(raw);
  s = s.replace(/<[^>]+>/g, ' ');     // remove qualquer tag HTML
  s = decodeEntities(s);
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Captura o conteúdo de uma tag dentro de um bloco (primeira ocorrência). */
function tag(block, name) {
  // aceita namespaces (ex.: dc:creator) e atributos na tag de abertura
  const re = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

/**
 * Extrai a melhor imagem do item, na ordem de preferência:
 *   1. <media:content url="..."> (com type image/* ou medium image, ou sem type)
 *   2. <media:thumbnail url="...">
 *   3. <enclosure type="image/..." url="...">
 *   4. primeiro <img src="..."> no description/content:encoded
 * Retorna URL https absoluta ou null.
 */
function extractImage(block) {
  // 1) media:content — prioriza os marcados como imagem; cai pro primeiro url
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

  // 4) primeiro <img src> dentro de description / content:encoded
  const body = stripCdata(tag(block, 'content:encoded') || tag(block, 'description'));
  const imgSrc = (body.match(/<img\b[^>]*\bsrc="([^"]+)"/i) || [])[1];
  if (imgSrc) return sanitizeImg(decodeEntities(imgSrc));

  // 5) fallback: media:content sem type que ainda assim exista
  if (firstMediaUrl) return sanitizeImg(firstMediaUrl);

  return null;
}

function looksLikeImage(u) {
  return /\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i.test(u || '');
}

/** Só aceita imagens https (CSP img-src https:). Recusa data:/http: por segurança. */
function sanitizeImg(u) {
  if (!u) return null;
  const url = decodeEntities(String(u).trim());
  if (/^https:\/\//i.test(url)) return url;
  // promove http→https quando possível (CDNs de imagem servem ambos)
  if (/^http:\/\//i.test(url)) return url.replace(/^http:/i, 'https:');
  return null;
}

/** pubDate → epoch ms (NaN-safe → 0). */
function parseDate(s) {
  if (!s) return 0;
  const t = Date.parse(cleanText(s));
  return Number.isFinite(t) ? t : 0;
}

/** Host "limpo" de uma URL (para fallback de fonte). */
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

/**
 * Parseia um XML RSS/Atom em itens normalizados.
 * @param {string} xml
 * @param {string} category
 * @param {string} sourceLabel rótulo da fonte (cai pro <channel><title> / host)
 */
function parseRss(xml, category, sourceLabel) {
  if (!xml) return [];
  const channelTitle = cleanText(tag(xml, 'title')); // primeiro <title> = canal
  // suporta RSS (<item>) e Atom (<entry>)
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

    // fonte do item: <source> do RSS (Google News usa) > rótulo configurado >
    // título do canal > host do link
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

// ── Fetch com timeout (AbortController) ───────────────────────────────────────
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

// ── Dedup + ordenação ─────────────────────────────────────────────────────────
function dedupeAndSort(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = (it.link || '').split('#')[0] + '|' + it.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  // prioriza itens COM imagem no topo (UX estilo MSN/Edge), depois por data desc
  out.sort((a, b) => {
    if (!!a.image !== !!b.image) return a.image ? -1 : 1;
    return (b.ts || 0) - (a.ts || 0);
  });
  return out;
}

/**
 * Busca + parseia todos os feeds de uma categoria, com cache em memória.
 * Uma fonte caída (timeout/HTTP/parse) é ignorada sem derrubar a categoria.
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
    // mantém cache antigo se existir (degrada com elegância); senão sinaliza erro
    if (hit) return { ok: true, items: hit.items, cached: true, stale: true };
    return { ok: false, items: [], error: 'sem itens' };
  }

  cache.set(cat, { ts: Date.now(), items });
  return { ok: true, items };
}

module.exports = {
  getNews,
  CATEGORIES,
  // exportados para teste/uso interno
  parseRss,
  extractImage,
  cleanText,
  decodeEntities,
};
