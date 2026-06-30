'use strict';

/**
 * search-engines.js — Catálogo de motores de busca (paridade Chrome).
 *
 * Cada motor tem um `searchTemplate` (URL de busca com {q}) e um `suggestTemplate`
 * (endpoint de autocomplete, opcional). O renderer usa o template para montar a URL
 * a partir do que o usuário digita no omnibox. `{q}` é substituído pelo termo já
 * URL-encodado.
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

/** Lista completa do catálogo (cópia defensiva). */
function getEngines() {
  return ENGINES.map((e) => ({ ...e }));
}

/** Resolve um motor por id; cai no Google se não achar. */
function getEngine(id) {
  return ENGINES.find((e) => e.id === id) || ENGINES[0];
}

/** Monta a URL de busca final substituindo {q} pelo termo (já encodado pelo caller, se quiser). */
function buildSearchUrl(id, query) {
  const engine = getEngine(id);
  return engine.searchTemplate.replace('{q}', encodeURIComponent(query));
}

module.exports = { getEngines, getEngine, buildSearchUrl, ENGINES };
