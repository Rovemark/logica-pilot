'use strict';

/**
 * feeds.js — RSS/Atom as a tool, not as a hardcoded news list.
 *
 * We already parsed feeds, but only inside `app/main/news.js`, with Brazilian news sources
 * written into the file. That serves the start page and nothing else: an agent could not
 * subscribe to a changelog, a release feed or a blog.
 *
 * This reads any RSS 2.0 or Atom feed, and also finds the feed when given a site URL (most
 * sites advertise it in <link rel="alternate">). Zero dependency: global fetch + regex parsing,
 * same choice as the rest of the engine.
 */

const TIMEOUT_MS = Number(process.env.LOGICA_FEED_TIMEOUT_MS || 15000);

function decodificar(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')   // por último: senão &amp;lt; vira < em vez de &lt;
    .trim();
}

const semTags = (s) => decodificar(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function campo(bloco, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(bloco);
  return m ? decodificar(m[1]) : null;
}

// Atom guarda o link num atributo, RSS no texto do elemento. Os dois aparecem no mundo real.
function link(bloco) {
  const rss = campo(bloco, 'link');
  if (rss && /^https?:/i.test(rss)) return rss;
  const atom = /<link[^>]*\srel=["']?alternate["']?[^>]*\shref=["']([^"']+)["']/i.exec(bloco)
            || /<link[^>]*\shref=["']([^"']+)["']/i.exec(bloco);
  return atom ? decodificar(atom[1]) : null;
}

function parseFeed(xml) {
  const texto = String(xml || '');
  const tipo = /<feed[\s>]/i.test(texto) ? 'atom' : 'rss';
  const marcador = tipo === 'atom' ? 'entry' : 'item';

  const cabeca = texto.slice(0, texto.search(new RegExp(`<${marcador}[\\s>]`, 'i')) + 1 || 4000);
  const titulo = campo(cabeca, 'title');

  const itens = [];
  const re = new RegExp(`<${marcador}(?:\\s[^>]*)?>([\\s\\S]*?)</${marcador}>`, 'gi');
  let m;
  while ((m = re.exec(texto))) {
    const b = m[1];
    const resumo = campo(b, 'description') || campo(b, 'summary') || campo(b, 'content');
    itens.push({
      title: semTags(campo(b, 'title')),
      url: link(b),
      // A data vem com nome diferente em cada formato, e feed velho às vezes não traz nenhuma.
      published: campo(b, 'pubDate') || campo(b, 'published') || campo(b, 'updated') || null,
      author: semTags(campo(b, 'author') || campo(b, 'dc:creator')) || null,
      summary: resumo ? semTags(resumo).slice(0, 600) : null,
      id: campo(b, 'guid') || campo(b, 'id') || null,
    });
  }
  return { type: tipo, title: titulo ? semTags(titulo) : null, items: itens };
}

async function buscar(url, timeout = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    });
    return { ok: r.ok, status: r.status, body: await r.text(), contentType: r.headers.get('content-type') || '' };
  } finally {
    clearTimeout(t);
  }
}

// Dado o endereço de um site, achar o feed que ele anuncia. Sem isto, "assine este blog" exige
// que a pessoa descubra a URL do feed sozinha.
function descobrirNoHtml(html, base) {
  const achados = [];
  const re = /<link[^>]*\srel=["']?alternate["']?[^>]*>/gi;
  let m;
  while ((m = re.exec(String(html)))) {
    const tag = m[0];
    if (!/type=["'][^"']*(rss|atom)\+xml/i.test(tag)) continue;
    const href = /\shref=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    try { achados.push(new URL(decodificar(href), base).toString()); } catch {}
  }
  return [...new Set(achados)];
}

/**
 * Lê um feed. Se a URL for de um site, descobre o feed anunciado por ele antes de desistir.
 */
async function lerFeed(url, { limit = 20 } = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('feed: precisa de uma URL http(s)');
  let r = await buscar(url);
  if (!r.ok) return { ok: false, status: r.status, error: `o feed respondeu ${r.status}`, url };

  const pareceFeed = /(rss|atom|xml)/i.test(r.contentType) || /<(rss|feed)[\s>]/i.test(r.body.slice(0, 2000));
  if (!pareceFeed) {
    const candidatos = descobrirNoHtml(r.body, url);
    if (!candidatos.length) {
      return { ok: false, error: 'isto não é um feed e a página não anuncia nenhum', url };
    }
    const escolhido = candidatos[0];
    r = await buscar(escolhido);
    if (!r.ok) return { ok: false, status: r.status, error: `o feed respondeu ${r.status}`, url: escolhido };
    const p = parseFeed(r.body);
    return { ok: true, url: escolhido, descobertoEm: url, outros: candidatos.slice(1), ...p, items: p.items.slice(0, limit) };
  }

  const p = parseFeed(r.body);
  if (!p.items.length) return { ok: false, error: 'feed sem itens (ou formato não reconhecido)', url, type: p.type };
  return { ok: true, url, ...p, items: p.items.slice(0, limit) };
}

module.exports = { lerFeed, parseFeed, descobrirNoHtml, __teste: { decodificar, semTags, link } };
