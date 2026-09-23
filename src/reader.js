'use strict';

/**
 * reader.js — Jina Reader as the cheapest rung on the ladder.
 *
 * The ladder, from cheapest to heaviest:
 *   reader  → r.jina.ai returns the page already as clean text. No browser, no key, no JS engine.
 *   http    → raw fetch + our own HTML cleanup. Needs the page to ship real HTML.
 *   browser → full CDP. Runs JS, holds the session, clicks things.
 *
 * Why it earns a place: for an article, a doc page or a public profile, the reader answers in
 * one request what the browser needs a whole process for. It is not a replacement — it cannot
 * log in, cannot click, and a site that blocks it still needs the browser. It is the rung you
 * try first when the page is just text you want to read.
 *
 * Zero dependency: global fetch.
 */

const BASE = process.env.LOGICA_READER_URL || 'https://r.jina.ai/';
const TIMEOUT_MS = Number(process.env.LOGICA_READER_TIMEOUT_MS || 20000);

// Um corpo praticamente vazio não é a página: é resposta em branco. Mas o limiar tem que ser
// baixo aqui, porque página curta LEGÍTIMA existe (example.com inteira dá 127 bytes, e por um
// tempo o doctor a reprovou como "bloqueada" por causa de um limiar de 300).
//
// Quem sabe quanto texto é pouco é o CHAMADOR, não o motor: um perfil de rede social com 200
// chars é login wall, um aviso de erro de 200 chars é a página toda. Por isso o limiar de
// contexto mora em quem pede (ver rotas-redes.mjs), e aqui fica só o piso de "veio algo".
const MINIMO_UTIL = 40;

async function fetchReader(url, { markdown = true, timeout = TIMEOUT_MS } = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    throw new Error('reader: precisa de uma URL http(s)');
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(BASE + url, {
      signal: ctrl.signal,
      headers: {
        // text = plain reading; markdown keeps headings, links and tables for a model.
        'x-return-format': markdown ? 'markdown' : 'text',
      },
    });
    const body = await r.text();
    if (!r.ok) {
      return { ok: false, status: r.status, error: `o leitor respondeu ${r.status}`, url };
    }
    const texto = String(body || '').trim();
    if (texto.length < MINIMO_UTIL) {
      return { ok: false, status: r.status, error: 'veio vazio ou bloqueado', url, chars: texto.length };
    }
    // The reader prefixes Title:/URL Source: lines; keep them out of the body but use the title.
    const title = /^Title:\s*(.+)$/m.exec(texto)?.[1]?.trim() || null;
    const corpo = texto
      .replace(/^Title:.*$/m, '')
      .replace(/^URL Source:.*$/m, '')
      .replace(/^Published Time:.*$/m, '')
      .replace(/^Markdown Content:\s*$/m, '')
      .trim();
    return { ok: true, status: r.status, url, title, text: corpo, chars: corpo.length, engine: 'reader' };
  } catch (e) {
    return {
      ok: false,
      error: e.name === 'AbortError' ? 'o leitor demorou demais' : e.message,
      url,
    };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { fetchReader, MINIMO_UTIL };
