'use strict';

/**
 * fanout.js — Orquestrador MULTI-AGENT do Logica Pilot.
 *
 * Roda a MESMA tarefa em N URLs EM PARALELO (cada uma numa página headless
 * própria via CDP), colhe resultados compactos e, opcionalmente, sintetiza tudo
 * numa resposta única com citações. É o coração das "receitas": Deep Research,
 * Compare, Best Deal, Fact-Check — todas = fanout + um prompt de síntese.
 *
 * Token-first: cada worker manda pro modelo só a percepção COMPACTA da página
 * (mapa indexado + texto legível), nunca o HTML cru.
 */

const { Browser } = require('./browser');
const perception = require('./perception');
const agent = require('./agent');
const llm = require('./llm');
const actions = require('./actions');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Extrai dados estruturados (JSON) do texto compacto de uma página, via LLM. */
async function extractStructured({ text, instruction, schema, model }) {
  const system = 'Você extrai dados de uma página web e responde SÓ com JSON válido (sem markdown, sem comentários).';
  const user =
    `Instrução: ${instruction || 'extraia os dados principais da página'}\n` +
    (schema ? `Formato JSON esperado: ${JSON.stringify(schema)}\n` : '') +
    `\nConteúdo da página (compacto):\n${String(text || '').slice(0, 6000)}\n\nResponda só o JSON.`;
  const resp = await llm.callClaude({ system, messages: [{ role: 'user', content: user }], maxTokens: 1200, model });
  const out = llm.textOf(resp).replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(out); } catch { return { _raw: out }; }
}

/** Sintetiza os resultados de todas as fontes numa resposta única com citações [n]. */
async function synthesizeResults({ results, instruction, model }) {
  const compact = results
    .filter(Boolean)
    .map((r, i) => `[${i}] ${r.url}\n${JSON.stringify(r.data || r.result || { text: r.text, error: r.error }).slice(0, 1500)}`)
    .join('\n\n');
  const resp = await llm.callClaude({
    system: 'Você sintetiza resultados de várias fontes numa resposta única, objetiva, citando as fontes como [n].',
    messages: [{ role: 'user', content: `Tarefa: ${instruction}\n\nResultados por fonte:\n${compact}\n\nSintetize com citações [n].` }],
    maxTokens: 1600, model,
  });
  return llm.textOf(resp);
}

/**
 * @param {object} o
 * @param {string[]} o.urls                 URLs a processar em paralelo
 * @param {string}   [o.task]               instrução (extração) ou objetivo (mode:'run')
 * @param {object}   [o.schema]             schema JSON esperado (mode:'extract')
 * @param {'extract'|'read'|'run'} [o.mode='extract']
 * @param {string}   [o.synthesize]         se setado, sintetiza tudo nessa instrução
 * @param {number}   [o.concurrency=4]      páginas simultâneas (cap 8)
 * @param {number}   [o.maxSteps=8]         passos por página no mode:'run'
 * @param {string}   [o.model]
 * @param {boolean}  [o.headless=true]
 * @param {(ev)=>void} [o.onEvent]
 * @returns {Promise<{count,ok,results,synthesis}>}
 */
async function fanout(o = {}) {
  const urls = Array.isArray(o.urls) ? o.urls.filter(Boolean) : [];
  if (!urls.length) throw new Error('fanout: forneça urls[] (não vazio)');
  const mode = o.mode || 'extract';
  const conc = Math.max(1, Math.min(Number(o.concurrency) || 4, 8));
  const onEvent = typeof o.onEvent === 'function' ? o.onEvent : () => {};

  const browser = await Browser.launch({ headless: o.headless !== false });
  const results = new Array(urls.length);
  let cursor = 0;

  async function worker() {
    while (cursor < urls.length) {
      const my = cursor++;
      const url = urls[my];
      const rec = { url, ok: false };
      let page = null;
      onEvent({ type: 'start', index: my, url });
      try {
        page = await browser.newPage();
        await page.goto(url, { timeout: 25000 }).catch(() => {});
        await sleep(600);
        if (mode === 'run' && o.task) {
          const r = await agent.run(page, o.task, { maxSteps: o.maxSteps || 8, model: o.model });
          rec.result = (r && (r.result || r.summary || r.text)) || r;
        } else {
          const snap = await perception.snapshot(page, { maxEls: 50 });
          rec.title = snap.title;
          if (mode === 'read') {
            rec.text = String(snap.text || '').slice(0, 3000);
          } else {
            rec.data = await extractStructured({
              text: perception.format(snap), instruction: o.task, schema: o.schema, model: o.model,
            });
          }
        }
        rec.ok = true;
      } catch (e) {
        rec.error = (e && e.message) || String(e);
      } finally {
        // fecha o target (libera memória) — browser.close() no fim limpa o resto
        try { if (page) await page._c.send('Target.closeTarget', { targetId: page.targetId }); } catch {}
      }
      results[my] = rec;
      onEvent({ type: 'done', index: my, url, ok: rec.ok });
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(conc, urls.length) }, () => worker()));
    let synthesis = null;
    if (o.synthesize) {
      onEvent({ type: 'synthesize' });
      synthesis = await synthesizeResults({ results, instruction: o.synthesize, model: o.model });
    }
    return { count: results.length, ok: results.filter((r) => r && r.ok).length, results, synthesis };
  } finally {
    try { await browser.close(); } catch {}
  }
}

module.exports = { fanout, extractStructured, synthesizeResults };
