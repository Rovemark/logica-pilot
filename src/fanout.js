'use strict';

/**
 * fanout.js — Multi-agent orchestrator for Logica Pilot.
 *
 * Runs the SAME task on N URLs IN PARALLEL (each in its own headless page
 * via CDP), collects compact results and, optionally, synthesizes everything
 * into a single response with citations. This is the heart of "recipes": Deep Research,
 * Compare, Best Deal, Fact-Check — all of them = fanout + a synthesis prompt.
 *
 * Token-first: each worker sends to the model only the COMPACT perception of the page
 * (indexed map + readable text), never raw HTML.
 */

const { Browser } = require('./browser');
const perception = require('./perception');
const agent = require('./agent');
const llm = require('./llm');
const actions = require('./actions');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Extracts structured data (JSON) from a page's compact text, via LLM. */
async function extractStructured({ text, instruction, schema, model }) {
  const system = 'You extract data from a web page and respond ONLY with valid JSON (no markdown, no comments).';
  const user =
    `Instruction: ${instruction || 'extract the main data from the page'}\n` +
    (schema ? `Expected JSON format: ${JSON.stringify(schema)}\n` : '') +
    `\nPage content (compact):\n${String(text || '').slice(0, 6000)}\n\nRespond with JSON only.`;
  const resp = await llm.callClaude({ system, messages: [{ role: 'user', content: user }], maxTokens: 1200, model });
  const out = llm.textOf(resp).replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(out); } catch { return { _raw: out }; }
}

/** Synthesizes results from all sources into a single response with citations [n]. */
async function synthesizeResults({ results, instruction, model }) {
  const compact = results
    .filter(Boolean)
    .map((r, i) => `[${i}] ${r.url}\n${JSON.stringify(r.data || r.result || { text: r.text, error: r.error }).slice(0, 1500)}`)
    .join('\n\n');
  const resp = await llm.callClaude({
    system: 'You synthesize results from multiple sources into a single, objective response, citing sources as [n].',
    messages: [{ role: 'user', content: `Task: ${instruction}\n\nResults by source:\n${compact}\n\nSynthesize with citations [n].` }],
    maxTokens: 1600, model,
  });
  return llm.textOf(resp);
}

/**
 * @param {object} o
 * @param {string[]} o.urls                 URLs to process in parallel
 * @param {string}   [o.task]               instruction (extraction) or objective (mode:'run')
 * @param {object}   [o.schema]             expected JSON schema (mode:'extract')
 * @param {'extract'|'read'|'run'} [o.mode='extract']
 * @param {string}   [o.synthesize]         if set, synthesizes everything in this instruction
 * @param {number}   [o.concurrency=4]      simultaneous pages (cap 8)
 * @param {number}   [o.maxSteps=8]         steps per page in mode:'run'
 * @param {string}   [o.model]
 * @param {boolean}  [o.headless=true]
 * @param {(ev)=>void} [o.onEvent]
 * @returns {Promise<{count,ok,results,synthesis}>}
 */
async function fanout(o = {}) {
  const urls = Array.isArray(o.urls) ? o.urls.filter(Boolean) : [];
  if (!urls.length) throw new Error('fanout: provide urls[] (non-empty)');
  const mode = o.mode || 'extract';
  const conc = Math.max(1, Math.min(Number(o.concurrency) || 4, 8));
  const onEvent = typeof o.onEvent === 'function' ? o.onEvent : () => {};

  const browser = await Browser.launch({ headless: o.headless !== false, proxy: o.proxy, location: o.location });
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
        // closes the target (frees memory) — browser.close() at the end cleans up the rest
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
