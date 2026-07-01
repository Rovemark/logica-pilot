'use strict';

/**
 * search-engines.js — Catalog of search engines (Chrome parity).
 *
 * Each engine has a `searchTemplate` (search URL with {q}) and a `suggestTemplate`
 * (autocomplete endpoint, optional). The renderer uses the template to build the URL
 * from what the user types in the omnibox. `{q}` is replaced with the term already
 * URL-encoded.
 */

const ENGINES = [
  {
    id: 'google',
    name: 'Google',
    searchTemplate: 'https://www.google.com/search?q={q}',
    suggestTemplate: 'https://suggestqueries.google.com/complete/search?client=firefox&q={q}',
  },
  {
    id: 'bing',
    name: 'Bing',
    searchTemplate: 'https://www.bing.com/search?q={q}',
    suggestTemplate: 'https://www.bing.com/osjson.aspx?query={q}',
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    searchTemplate: 'https://duckduckgo.com/?q={q}',
    suggestTemplate: 'https://duckduckgo.com/ac/?q={q}&type=list',
  },
  {
    id: 'brave',
    name: 'Brave Search',
    searchTemplate: 'https://search.brave.com/search?q={q}',
    suggestTemplate: 'https://search.brave.com/api/suggest?q={q}',
  },
];

/** Complete catalog list (defensive copy). */
function getEngines() {
  return ENGINES.map((e) => ({ ...e }));
}

/** Resolves an engine by id; defaults to Google if not found. */
function getEngine(id) {
  return ENGINES.find((e) => e.id === id) || ENGINES[0];
}

/** Builds the final search URL by replacing {q} with the term (already encoded by caller, if desired). */
function buildSearchUrl(id, query) {
  const engine = getEngine(id);
  return engine.searchTemplate.replace('{q}', encodeURIComponent(query));
}

module.exports = { getEngines, getEngine, buildSearchUrl, ENGINES };
