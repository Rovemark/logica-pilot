'use strict';

/**
 * recipes.js — The "killer features" = search + fanout + tuned synthesis.
 * Reuse the engine (0-dep). Each one is callable via CLI and MCP.
 */

const { search } = require('./search');
const { fanout } = require('./fanout');

/** Deep Research — searches the question, reads sources in parallel, synthesizes with citations. */
async function research(query, o = {}) {
  const hits = await search(query, { limit: o.limit || 6 });
  if (!hits.length) throw new Error('search returned no results (provide urls or set BRAVE_SEARCH_API_KEY)');
  const r = await fanout({
    urls: hits.map((h) => h.url),
    task: 'Extract facts, data, and relevant points to answer: ' + query,
    mode: 'extract',
    synthesize: 'Respond comprehensively and concisely to the question "' + query + '", citing sources as [n].',
    concurrency: o.concurrency || 4, model: o.model, onEvent: o.onEvent,
  });
  return { query, sources: hits, ...r };
}

/** Compare Anything — extracts from each URL/item and builds a comparison table + recommendation. */
async function compare(urls, o = {}) {
  if (!Array.isArray(urls) || !urls.length) throw new Error('compare: provide urls[]');
  return fanout({
    urls,
    task: o.task || 'Extract name, main specs/attributes, price, and rating/score as JSON.',
    mode: 'extract',
    synthesize: 'Build a clear comparison table of the items and recommend the best, justifying and citing [n].',
    concurrency: o.concurrency || 4, model: o.model, onEvent: o.onEvent,
  });
}

/** Best Deal — searches stores for the product, extracts price/shipping and ranks by real value. */
async function deal(product, o = {}) {
  const hits = await search(product + ' price buy', { limit: o.limit || 8 });
  if (!hits.length) throw new Error('search returned no stores');
  const r = await fanout({
    urls: hits.map((h) => h.url),
    task: 'Extract: product name, price, shipping, availability, and store, as JSON.',
    mode: 'extract',
    synthesize: 'Rank by REAL VALUE (price + shipping) and point out the best deal for "' + product + '", citing [n].',
    concurrency: o.concurrency || 5, model: o.model, onEvent: o.onEvent,
  });
  return { product, sources: hits, ...r };
}

/** Fact-Check — searches independent sources about the claim and delivers a verdict with citations. */
async function factcheck(claim, o = {}) {
  const hits = await search(claim, { limit: o.limit || 6 });
  if (!hits.length) throw new Error('search returned no sources');
  const r = await fanout({
    urls: hits.map((h) => h.url),
    task: 'What does this source claim about: "' + claim + '"? Extract evidence and the source\'s position.',
    mode: 'extract',
    synthesize: 'Give a VERDICT (true / false / misleading / inconclusive) about "' + claim + '", based on the sources and citing [n].',
    concurrency: o.concurrency || 4, model: o.model, onEvent: o.onEvent,
  });
  return { claim, sources: hits, ...r };
}

module.exports = { research, compare, deal, factcheck };
