'use strict';

/**
 * tools.js — SINGLE SOURCE OF TRUTH for every Logica Pilot capability.
 *
 * Each tool is defined ONCE here (name, schema, handler). Both surfaces generate
 * from this registry, so the MCP server and the CLI are ALWAYS identical:
 *   - MCP  (src/mcp-server.js): maps each tool to tools/list + tools/call
 *   - CLI  (bin/logica-pilot.js): maps each tool to a subcommand
 *
 * Handler contract:  run(args, ctx) -> string | { text } | { json } | { image, mimeType }
 *   ctx = { page, pilot, model }   (page = the current page; may be blank)
 *   Page-based tools accept an optional `url` and navigate first (so the CLI can
 *   run them one-shot). Tools with `pageless:true` manage their own browsing.
 *
 * Token-first everywhere: return compact perception/JSON, never raw HTML.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const perception = require('./perception');
const actions = require('./actions');
const agent = require('./agent');
const llm = require('./llm');
const { fanout, extractStructured } = require('./fanout');
const recipes = require('./recipes');
const { search } = require('./search');
const session = require('./session-store');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (id) => `[data-lpilot-id="${String(id).replace(/"/g, '')}"]`;

async function map(page, max = 120) {
  return perception.format(await perception.snapshot(page, { maxEls: max }));
}
async function ensureUrl(page, a) { if (a && a.url) await page.goto(a.url); }
// ensures elements have data-lpilot-id (needed by index-based actions)
async function ensureIds(page) { await perception.snapshot(page, { maxEls: 200 }); }

async function elementPoint(page, id) {
  return page.eval(
    `(function(){var el=document.querySelector('${q(id)}');if(!el)return null;` +
    `el.scrollIntoView({block:'center',inline:'center'});var r=el.getBoundingClientRect();` +
    `return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`,
  );
}

// ── the registry ─────────────────────────────────────────────────────────────
const TOOLS = [
  // ── navigation ──
  {
    name: 'navigate', group: 'navigation', primary: 'url',
    description: 'Navigate to a URL and return the INDEXED MAP of the page (interactive elements + readable text). Token-cheap: use instead of downloading HTML.',
    input: { properties: { url: { type: 'string', description: 'Target URL' } }, required: ['url'] },
    run: async (a, ctx) => { await ctx.page.goto(a.url); return { text: await map(ctx.page) }; },
  },
  {
    name: 'back', group: 'navigation',
    description: 'Go back in history and return the page map.',
    input: { properties: {} },
    run: async (a, ctx) => { await ctx.page.eval('history.back()'); await sleep(900); return { text: await map(ctx.page) }; },
  },
  {
    name: 'forward', group: 'navigation',
    description: 'Go forward in history and return the page map.',
    input: { properties: {} },
    run: async (a, ctx) => { await ctx.page.eval('history.forward()'); await sleep(900); return { text: await map(ctx.page) }; },
  },
  {
    name: 'reload', group: 'navigation',
    description: 'Reload the current page and return the page map.',
    input: { properties: { url: { type: 'string' } } },
    run: async (a, ctx) => { await ensureUrl(ctx.page, a); await ctx.page.send('Page.reload', {}).catch(() => {}); await sleep(1000); return { text: await map(ctx.page) }; },
  },
  {
    name: 'wait', group: 'navigation',
    description: 'Wait until text appears / a selector exists / a timeout — a SEMANTIC wait (no brittle fixed sleeps).',
    input: { properties: { text: { type: 'string', description: 'text to wait for' }, selector: { type: 'string' }, timeout: { type: 'number', description: 'ms, default 10000' } } },
    run: async (a, ctx) => {
      const start = Date.now(); const to = a.timeout || 10000;
      while (Date.now() - start < to) {
        const ok = await ctx.page.eval(
          a.text ? `((document.body&&document.body.innerText)||'').includes(${JSON.stringify(a.text)})`
            : a.selector ? `!!document.querySelector(${JSON.stringify(a.selector)})` : 'true',
        ).catch(() => false);
        if (ok) return { text: 'condition met after ' + (Date.now() - start) + 'ms' };
        await sleep(300);
      }
      return { text: 'timeout after ' + to + 'ms (condition not met)' };
    },
  },

  // ── perception ──
  {
    name: 'observe', group: 'perception', primary: 'url',
    description: 'Return the INDEXED MAP of the current page (`[n] type "label"` + text). The compact perception that replaces HTML/screenshot.',
    input: { properties: { url: { type: 'string', description: 'optional: navigate first' }, maxElements: { type: 'number' } } },
    run: async (a, ctx) => { await ensureUrl(ctx.page, a); return { text: await map(ctx.page, a.maxElements || 120) }; },
  },
  {
    name: 'read', group: 'perception', primary: 'url',
    description: 'Return the READABLE content of the page (clean text, no nav/ads). With summarize:true, summarize via AI.',
    input: { properties: { url: { type: 'string' }, summarize: { type: 'boolean' } } },
    run: async (a, ctx) => {
      await ensureUrl(ctx.page, a);
      const snap = await perception.snapshot(ctx.page, { maxEls: 0 });
      let text = String(snap.text || '').trim();
      if (a.summarize && text) {
        const resp = await llm.callClaude({ system: 'Summarize the web page objectively.', messages: [{ role: 'user', content: 'Summarize:\n\n' + text.slice(0, 8000) }], maxTokens: 700, model: ctx.model });
        text = llm.textOf(resp);
      }
      return { text: text || '(no text)' };
    },
  },
  {
    name: 'extract', group: 'perception', primary: 'url',
    description: 'Extract data. With `instruction`/`schema` returns structured JSON (AI, compact); with `query` (CSS) returns matched text.',
    input: { properties: { url: { type: 'string' }, instruction: { type: 'string' }, schema: { type: 'object' }, query: { type: 'string' } } },
    run: async (a, ctx) => {
      await ensureUrl(ctx.page, a);
      if (a.instruction || a.schema) {
        const snap = await perception.snapshot(ctx.page, { maxEls: 60 });
        return { json: await extractStructured({ text: perception.format(snap), instruction: a.instruction, schema: a.schema, model: ctx.model }) };
      }
      return { text: await actions.extract(ctx.page, a.query || '') };
    },
  },
  {
    name: 'links', group: 'perception', primary: 'url',
    description: 'Return all links on the page (text + url), compact and deduped. Good for crawling/planning.',
    input: { properties: { url: { type: 'string' } } },
    run: async (a, ctx) => {
      await ensureUrl(ctx.page, a);
      const links = await ctx.page.eval(
        `(function(){var out=[],seen={};var els=document.querySelectorAll('a[href]');` +
        `for(var i=0;i<els.length&&out.length<100;i++){var a=els[i];var h=a.href;` +
        `if(!/^https?:/.test(h)||seen[h])continue;seen[h]=1;out.push({text:(a.innerText||'').trim().slice(0,80),url:h});}return out;})()`,
      );
      return { json: links || [] };
    },
  },
  {
    name: 'screenshot', group: 'perception', primary: 'url',
    description: 'Capture the screen (visual fallback when accessibility is not enough). marks:true draws the indices first. Returns an image.',
    input: { properties: { url: { type: 'string' }, fullPage: { type: 'boolean' }, marks: { type: 'boolean' } } },
    run: async (a, ctx) => {
      await ensureUrl(ctx.page, a);
      if (a.marks) { try { await ensureIds(ctx.page); await perception.mark(ctx.page); } catch {} }
      const b64 = await actions.screenshot(ctx.page, { format: 'jpeg', quality: 65, fullPage: !!a.fullPage });
      if (a.marks) { try { await perception.unmark(ctx.page); } catch {} }
      return { image: b64, mimeType: 'image/jpeg' };
    },
  },

  // ── actions ──
  {
    name: 'act', group: 'actions', primary: 'url',
    description: 'Act on the page BY INDEX (from observe), no fragile selectors. action: click | type | press | scroll.',
    input: {
      properties: {
        url: { type: 'string' },
        action: { type: 'string', enum: ['click', 'type', 'press', 'scroll'] },
        index: { type: 'number', description: 'element index [n] (click/type)' },
        text: { type: 'string', description: 'text to type (type)' },
        submit: { type: 'boolean', description: 'Enter after typing (type)' },
        key: { type: 'string', description: 'key (press): Enter, Tab, Escape, ArrowDown…' },
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'number' },
      }, required: ['action'],
    },
    run: async (a, ctx) => {
      await ensureUrl(ctx.page, a);
      await ensureIds(ctx.page);
      let res;
      switch (a.action) {
        case 'click': res = await actions.click(ctx.page, a.index); break;
        case 'type': res = await actions.type(ctx.page, a.index, a.text || '', !!a.submit); break;
        case 'press': res = await actions.pressKey(ctx.page, a.key || 'Enter'); break;
        case 'scroll': res = await actions.scroll(ctx.page, a.direction || 'down', a.amount || 600); break;
        default: throw new Error('invalid action: ' + a.action);
      }
      await sleep(250);
      return { text: res + '\n\n' + await map(ctx.page, 80) };
    },
  },
  {
    name: 'fill', group: 'actions', primary: 'url',
    description: 'Fill several form fields at once by index (Form Autopilot). fields: [{index, text, submit?}].',
    input: { properties: { url: { type: 'string' }, fields: { type: 'array', items: { type: 'object', properties: { index: { type: 'number' }, text: { type: 'string' }, submit: { type: 'boolean' } } } } }, required: ['fields'] },
    run: async (a, ctx) => {
      await ensureUrl(ctx.page, a);
      await ensureIds(ctx.page);
      const out = [];
      for (const f of a.fields || []) { out.push(await actions.type(ctx.page, f.index, f.text || '', !!f.submit)); await sleep(150); }
      return { text: out.join('\n') + '\n\n' + await map(ctx.page, 80) };
    },
  },
  {
    name: 'select', group: 'actions', primary: 'url',
    description: 'Select an option in a <select> dropdown by index + value.',
    input: { properties: { url: { type: 'string' }, index: { type: 'number' }, value: { type: 'string' } }, required: ['index', 'value'] },
    run: async (a, ctx) => {
      await ensureUrl(ctx.page, a); await ensureIds(ctx.page);
      const ok = await ctx.page.eval(
        `(function(){var el=document.querySelector('${q(a.index)}');if(!el)return false;` +
        `el.value=${JSON.stringify(a.value)};el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`,
      );
      return { text: ok ? `selected "${a.value}" in [${a.index}]` : `index [${a.index}] not found` };
    },
  },
  {
    name: 'hover', group: 'actions', primary: 'url',
    description: 'Hover the mouse over an element by index (reveals menus/tooltips).',
    input: { properties: { url: { type: 'string' }, index: { type: 'number' } }, required: ['index'] },
    run: async (a, ctx) => {
      await ensureUrl(ctx.page, a); await ensureIds(ctx.page);
      const pt = await elementPoint(ctx.page, a.index);
      if (!pt) return { text: `index [${a.index}] not found` };
      await ctx.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, buttons: 0 });
      await sleep(200);
      return { text: `hovered [${a.index}]\n\n` + await map(ctx.page, 80) };
    },
  },
  {
    name: 'eval', group: 'actions', primary: 'url',
    description: 'Run JavaScript in the page and return the result (power tool for devs). Use sparingly.',
    input: { properties: { url: { type: 'string' }, expression: { type: 'string' } }, required: ['expression'] },
    run: async (a, ctx) => { await ensureUrl(ctx.page, a); const r = await ctx.page.eval(a.expression); return { json: r === undefined ? null : r }; },
  },
  {
    name: 'pdf', group: 'actions', primary: 'url',
    description: 'Save the current page as a PDF (Page.printToPDF). Returns the file path.',
    input: { properties: { url: { type: 'string' }, out: { type: 'string', description: 'output path (optional)' } } },
    run: async (a, ctx) => {
      await ensureUrl(ctx.page, a);
      const res = await ctx.page.send('Page.printToPDF', { printBackground: true });
      const buf = Buffer.from(res.data, 'base64');
      const out = a.out || path.join(os.tmpdir(), 'logica-pilot-' + Date.now() + '.pdf');
      fs.writeFileSync(out, buf);
      return { text: `PDF saved: ${out} (${buf.length} bytes)` };
    },
  },

  // ── autonomy ──
  {
    name: 'run', group: 'autonomy', primary: 'goal',
    description: 'Execute a multi-step OBJECTIVE autonomously (agent observes→acts in a loop). For whole tasks.',
    input: { properties: { url: { type: 'string' }, goal: { type: 'string' }, maxSteps: { type: 'number' } }, required: ['goal'] },
    run: async (a, ctx) => {
      const r = await agent.run(ctx.page, a.goal, { maxSteps: a.maxSteps || 12, model: ctx.model, startUrl: a.url });
      return { text: typeof r === 'string' ? r : (r && (r.result || r.summary)) || JSON.stringify(r) };
    },
  },

  // ── session ──
  {
    name: 'session', group: 'session',
    description: 'Manage login sessions (cookies): save | load | list. Log in once, reuse forever.',
    input: { properties: { action: { type: 'string', enum: ['save', 'load', 'list'] }, name: { type: 'string' }, url: { type: 'string' } }, required: ['action'] },
    run: async (a, ctx) => {
      if (a.action === 'list') return { json: { sessions: session.list() } };
      await ensureUrl(ctx.page, a);
      if (a.action === 'save') return { json: await session.save(ctx.page, a.name) };
      if (a.action === 'load') return { json: await session.load(ctx.page, a.name) };
      throw new Error('invalid session action: ' + a.action);
    },
  },
  {
    name: 'watch', group: 'session', primary: 'url',
    description: 'Check a URL and report whether it CHANGED since the last check (content diff). Base for monitors.',
    input: { properties: { url: { type: 'string' } }, required: ['url'] },
    run: async (a, ctx) => {
      await ctx.page.goto(a.url);
      const snap = await perception.snapshot(ctx.page, { maxEls: 0 });
      let h = 5381; const s = String(snap.text || ''); for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; h >>>= 0;
      const prev = ctx.watchLast && ctx.watchLast.get(a.url);
      if (ctx.watchLast) ctx.watchLast.set(a.url, h);
      return { json: { url: a.url, changed: prev ? prev !== h : null, firstCheck: !prev, title: snap.title, textPreview: s.slice(0, 500) } };
    },
  },

  // ── multi-agent (pageless: manage their own browsing) ──
  {
    name: 'fanout', group: 'multi-agent', pageless: true,
    description: 'MULTI-AGENT: run the same task on N URLs in PARALLEL (separate headless pages) + optional synthesis. Base of research/compare/deal.',
    input: {
      properties: {
        urls: { type: 'array', items: { type: 'string' } }, task: { type: 'string' },
        mode: { type: 'string', enum: ['extract', 'read', 'run'] }, schema: { type: 'object' },
        synthesize: { type: 'string' }, concurrency: { type: 'number' },
      }, required: ['urls', 'task'],
    },
    run: async (a, ctx) => {
      const r = await fanout({ urls: a.urls, task: a.task, mode: a.mode || 'extract', schema: a.schema, synthesize: a.synthesize, concurrency: a.concurrency, model: ctx.model, onEvent: ctx.onEvent });
      return { json: { count: r.count, ok: r.ok, synthesis: r.synthesis, results: r.results } };
    },
  },
  {
    name: 'search', group: 'multi-agent', pageless: true, primary: 'query',
    description: 'Search the web and return result URLs (title + url). Bing by default; Brave API if BRAVE_SEARCH_API_KEY.',
    input: { properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
    run: async (a) => ({ json: await search(a.query, { limit: a.limit }) }),
  },
  {
    name: 'research', group: 'multi-agent', pageless: true, primary: 'query',
    description: '🧠 Deep Research: search the question, read sources IN PARALLEL (multi-agent), synthesize with citations [n].',
    input: { properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
    run: async (a, ctx) => { const r = await recipes.research(a.query, { limit: a.limit, model: ctx.model, onEvent: ctx.onEvent }); return { text: r.synthesis || JSON.stringify(r.results, null, 2) }; },
  },
  {
    name: 'compare', group: 'multi-agent', pageless: true,
    description: '🧠 Compare: extract from N URLs in parallel and synthesize a comparison table + recommendation.',
    input: { properties: { urls: { type: 'array', items: { type: 'string' } }, task: { type: 'string' } }, required: ['urls'] },
    run: async (a, ctx) => { const r = await recipes.compare(a.urls, { task: a.task, model: ctx.model, onEvent: ctx.onEvent }); return { text: r.synthesis || JSON.stringify(r.results, null, 2) }; },
  },
  {
    name: 'deal', group: 'multi-agent', pageless: true, primary: 'product',
    description: '🧠 Best Deal: find stores for the product, extract price+shipping in parallel, rank by real value.',
    input: { properties: { product: { type: 'string' }, limit: { type: 'number' } }, required: ['product'] },
    run: async (a, ctx) => { const r = await recipes.deal(a.product, { limit: a.limit, model: ctx.model, onEvent: ctx.onEvent }); return { text: r.synthesis || JSON.stringify(r.results, null, 2) }; },
  },
  {
    name: 'factcheck', group: 'multi-agent', pageless: true, primary: 'claim',
    description: '🧠 Fact-Check: search independent sources about the claim and give a verdict with citations.',
    input: { properties: { claim: { type: 'string' }, limit: { type: 'number' } }, required: ['claim'] },
    run: async (a, ctx) => { const r = await recipes.factcheck(a.claim, { limit: a.limit, model: ctx.model, onEvent: ctx.onEvent }); return { text: r.synthesis || JSON.stringify(r.results, null, 2) }; },
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));
function get(name) { return byName.get(name); }

module.exports = { TOOLS, get };
