'use strict';

/**
 * bm25.js — Pure-JS BM25 full-text index (feature #9), 0-dep. Crawl a site once,
 * then query it forever with ZERO tokens and ZERO network. Turns any docs set
 * into an offline knowledge base your agents can grep semantically.
 */

const STOP = new Set(('a an and are as at be but by for if in into is it no not of on or such that the their then there these they this to was will with ' +
  'o a os as um uma de do da dos das e ou que se na no em para por com como mais mas ao aos').split(' '));

function tokenize(text) {
  return String(text || '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && t.length < 40 && !STOP.has(t));
}

/** Build a serializable BM25 index from docs [{url,title,text}]. */
function build(docs) {
  const D = [];
  const postings = Object.create(null); // term -> { [docIdx]: tf }
  const df = Object.create(null);
  let totalLen = 0;
  docs.forEach((d, i) => {
    const toks = tokenize((d.title || '') + ' ' + (d.text || ''));
    const tf = Object.create(null);
    for (const t of toks) tf[t] = (tf[t] || 0) + 1;
    for (const t in tf) {
      (postings[t] || (postings[t] = Object.create(null)))[i] = tf[t];
      df[t] = (df[t] || 0) + 1;
    }
    // Keep a bounded text sample for snippets.
    D.push({ url: d.url, title: d.title || '', len: toks.length, sample: String(d.text || '').replace(/\s+/g, ' ').slice(0, 1200) });
    totalLen += toks.length;
  });
  return { v: 1, N: D.length, avgdl: D.length ? totalLen / D.length : 0, docs: D, df, postings };
}

/** Query the index (BM25, k1=1.5 b=0.75). Returns top-k {url,title,score,snippet}. */
function query(index, q, { k = 5 } = {}) {
  const k1 = 1.5, b = 0.75;
  const terms = [...new Set(tokenize(q))];
  const scores = Object.create(null);
  for (const t of terms) {
    const post = index.postings[t];
    if (!post) continue;
    const idf = Math.max(0, Math.log(1 + (index.N - index.df[t] + 0.5) / (index.df[t] + 0.5)));
    for (const docIdx in post) {
      const tf = post[docIdx];
      const dl = index.docs[docIdx].len;
      const denom = tf + k1 * (1 - b + b * (dl / (index.avgdl || 1)));
      scores[docIdx] = (scores[docIdx] || 0) + idf * (tf * (k1 + 1)) / denom;
    }
  }
  return Object.entries(scores)
    .sort((a, b2) => b2[1] - a[1])
    .slice(0, Math.max(1, k))
    .map(([idx, score]) => {
      const d = index.docs[idx];
      return { url: d.url, title: d.title, score: +score.toFixed(3), snippet: snippet(d.sample, terms) };
    });
}

/** A short passage around the first matching term. */
function snippet(sample, terms) {
  const low = sample.toLowerCase();
  let at = -1;
  for (const t of terms) { const p = low.indexOf(t); if (p >= 0 && (at < 0 || p < at)) at = p; }
  if (at < 0) return sample.slice(0, 180);
  const start = Math.max(0, at - 70);
  return (start > 0 ? '…' : '') + sample.slice(start, start + 200).trim() + '…';
}

module.exports = { build, query, tokenize };
