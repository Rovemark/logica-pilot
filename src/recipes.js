'use strict';

/**
 * recipes.js — As "features matadoras" = search + fanout + síntese afinada.
 * Reusam o motor (0-dep). Cada uma é chamável por CLI e MCP.
 */

const { search } = require('./search');
const { fanout } = require('./fanout');

/** Deep Research — pesquisa a pergunta, lê as fontes em paralelo, sintetiza com citações. */
async function research(query, o = {}) {
  const hits = await search(query, { limit: o.limit || 6 });
  if (!hits.length) throw new Error('busca não retornou resultados (forneça urls ou defina BRAVE_SEARCH_API_KEY)');
  const r = await fanout({
    urls: hits.map((h) => h.url),
    task: 'Extraia fatos, dados e pontos relevantes para responder: ' + query,
    mode: 'extract',
    synthesize: 'Responda de forma completa e objetiva à pergunta "' + query + '", citando as fontes como [n].',
    concurrency: o.concurrency || 4, model: o.model, onEvent: o.onEvent,
  });
  return { query, sources: hits, ...r };
}

/** Compare Anything — extrai de cada URL/item e monta tabela comparativa + recomendação. */
async function compare(urls, o = {}) {
  if (!Array.isArray(urls) || !urls.length) throw new Error('compare: forneça urls[]');
  return fanout({
    urls,
    task: o.task || 'Extraia nome, principais specs/atributos, preço e nota/avaliação como JSON.',
    mode: 'extract',
    synthesize: 'Monte uma tabela comparativa clara dos itens e recomende o melhor, justificando e citando [n].',
    concurrency: o.concurrency || 4, model: o.model, onEvent: o.onEvent,
  });
}

/** Best Deal — busca lojas do produto, extrai preço/frete e rankeia por valor real. */
async function deal(product, o = {}) {
  const hits = await search(product + ' preço comprar', { limit: o.limit || 8 });
  if (!hits.length) throw new Error('busca não retornou lojas');
  const r = await fanout({
    urls: hits.map((h) => h.url),
    task: 'Extraia: nome do produto, preço, frete, disponibilidade e loja, como JSON.',
    mode: 'extract',
    synthesize: 'Rankeie por VALOR REAL (preço + frete) e aponte o melhor negócio para "' + product + '", citando [n].',
    concurrency: o.concurrency || 5, model: o.model, onEvent: o.onEvent,
  });
  return { product, sources: hits, ...r };
}

/** Fact-Check — busca fontes independentes sobre a afirmação e dá veredito com citações. */
async function factcheck(claim, o = {}) {
  const hits = await search(claim, { limit: o.limit || 6 });
  if (!hits.length) throw new Error('busca não retornou fontes');
  const r = await fanout({
    urls: hits.map((h) => h.url),
    task: 'O que esta fonte afirma sobre: "' + claim + '"? Extraia evidências e a posição da fonte.',
    mode: 'extract',
    synthesize: 'Dê um VEREDITO (verdadeiro / falso / enganoso / inconclusivo) sobre "' + claim + '", com base nas fontes e citando [n].',
    concurrency: o.concurrency || 4, model: o.model, onEvent: o.onEvent,
  });
  return { claim, sources: hits, ...r };
}

module.exports = { research, compare, deal, factcheck };
