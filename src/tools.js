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
const siteMemory = require('./site-memory');
const actions = require('./actions');
const agent = require('./agent');
const llm = require('./llm');
const { fanout, extractStructured } = require('./fanout');
const recipes = require('./recipes');
const { search } = require('./search');
const session = require('./session-store');
const crawler = require('./crawl');
const { lineDiff } = require('./diff');
const crypto = require('crypto');
const pageData = require('./page-data');
const jobs = require('./jobs');

// ── local page cache (opt-in via read's maxAge) ─────────────────────────────
const CACHE_DIR = path.join(os.homedir(), '.logica-pilot', 'cache');
function cacheKey(parts) { return crypto.createHash('sha1').update(parts.join('|')).digest('hex'); }
function cacheLoad(key, maxAgeMs) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, key + '.json'), 'utf8'));
    if (Date.now() - j.ts <= maxAgeMs) return j;
  } catch {}
  return null;
}
function cacheSave(key, data) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(path.join(CACHE_DIR, key + '.json'), JSON.stringify({ ts: Date.now(), ...data })); } catch {}
}

// ── change-tracking store (persistent snapshots per url+tag) ────────────────
const WATCH_DIR = path.join(os.homedir(), '.logica-pilot', 'watch');
function watchKey(url, tag) { return crypto.createHash('sha1').update(url + '|' + (tag || '')).digest('hex'); }
function watchLoad(url, tag) {
  try { return JSON.parse(fs.readFileSync(path.join(WATCH_DIR, watchKey(url, tag) + '.json'), 'utf8')); } catch { return null; }
}
function watchSave(url, tag, text) {
  try {
    fs.mkdirSync(WATCH_DIR, { recursive: true });
    fs.writeFileSync(path.join(WATCH_DIR, watchKey(url, tag) + '.json'),
      JSON.stringify({ url, tag: tag || '', ts: new Date().toISOString(), text: String(text).slice(0, 300000) }));
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (id) => `[data-lpilot-id="${String(id).replace(/"/g, '')}"]`;

async function map(page, max = 120) {
  const text = perception.format(await perception.snapshot(page, { maxEls: max }));
  // Learning flywheel (MOAT): record the visit + append what we've learned about
  // this site, so the model warm-starts on repeat visits. Best-effort.
  try {
    const url = await page.eval('location.href');
    siteMemory.recordVisit(url);
    const hint = siteMemory.hintLine(url);
    if (hint) return text + '\n\n' + hint;
  } catch {}
  return text;
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
    description: 'READABLE page content. markdown:true = LLM-ready Markdown (headings/links/lists/tables); default = clean text. Paginate long pages with maxChars/offset. summarize:true = AI summary.',
    input: {
      properties: {
        url: { type: 'string' }, summarize: { type: 'boolean' },
        markdown: { type: 'boolean', description: 'return Markdown instead of plain text' },
        maxChars: { type: 'number', description: 'chars per page (default 6000, max 20000)' },
        offset: { type: 'number', description: 'start position for pagination' },
        maxAge: { type: 'number', description: 'ms: reuse a cached read this fresh (0 = always live)' },
      },
    },
    run: async (a, ctx) => {
      const maxChars = Math.max(200, Math.min(Number(a.maxChars) || 6000, 20000));
      const offset = Math.max(0, Number(a.offset) || 0);
      // Opt-in cache (Firecrawl-style maxAge): serve a fresh-enough previous read
      // of the same url+format+window without reloading the page. 0 = always live.
      const maxAge = Math.max(0, Number(a.maxAge) || 0);
      const ck = a.url ? cacheKey(['read', a.url, a.markdown ? 'md' : 'txt', String(offset), String(maxChars)]) : null;
      if (ck && maxAge > 0 && !a.summarize) {
        const hit = cacheLoad(ck, maxAge);
        if (hit) return { text: hit.text };
      }
      await ensureUrl(ctx.page, a);
      let text; let total;
      if (a.markdown) {
        const md = await perception.markdown(ctx.page, { maxChars: Math.min(offset + maxChars + 1, 60000) });
        total = md.length; text = md.slice(offset, offset + maxChars);
      } else {
        const snap = await perception.snapshot(ctx.page, { maxEls: 0, maxChars: Math.min(offset + maxChars + 1, 60000) });
        total = snap.textTotal || String(snap.text || '').length;
        text = String(snap.text || '').trim().slice(offset, offset + maxChars);
      }
      if (a.summarize && text) {
        const resp = await llm.callClaude({ system: 'Summarize the web page objectively.', messages: [{ role: 'user', content: 'Summarize:\n\n' + text.slice(0, 8000) }], maxTokens: 700, model: ctx.model });
        return { text: llm.textOf(resp) || '(no text)' };
      }
      if (!text) return { text: '(no text)' };
      // Honest truncation: always say when there is more, and how to get it.
      if (offset + text.length < total) {
        text += `\n\n[showing ${offset}–${offset + text.length} of ${total} chars — pass offset=${offset + text.length} for more]`;
      }
      if (ck) cacheSave(ck, { text });
      return { text };
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
    name: 'meta', group: 'perception', primary: 'url',
    description: "Page METADATA, deterministic (no AI, no tokens): title, description, canonical, favicon, OpenGraph/Twitter tags, JSON-LD types. Instant identity card of any URL.",
    input: { properties: { url: { type: 'string' } } },
    run: async (a, ctx) => { await ensureUrl(ctx.page, a); return { json: await pageData.meta(ctx.page) }; },
  },
  {
    name: 'images', group: 'perception', primary: 'url',
    description: 'All meaningful IMAGES on the page (url + alt + size), og:image first, icons/trackers skipped. Deterministic, compact.',
    input: { properties: { url: { type: 'string' }, max: { type: 'number', description: 'default 40' } } },
    run: async (a, ctx) => { await ensureUrl(ctx.page, a); return { json: await pageData.images(ctx.page, { max: a.max }) }; },
  },
  {
    name: 'product', group: 'perception', primary: 'url',
    description: 'DETERMINISTIC product data from what the page itself declares (JSON-LD Product → microdata → og:price): name, brand, price, currency, availability, rating. Fails closed ({found:false}) instead of guessing — use `extract` for AI extraction.',
    input: { properties: { url: { type: 'string' } } },
    run: async (a, ctx) => {
      await ensureUrl(ctx.page, a);
      // SPAs inject JSON-LD after load — retry briefly before failing closed.
      let out = await pageData.product(ctx.page);
      for (let i = 0; i < 3 && !out.found; i++) { await sleep(1000); out = await pageData.product(ctx.page); }
      return { json: out };
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
      // Learning flywheel (MOAT): capture the target element + url BEFORE acting,
      // because a click can navigate away and destroy the element.
      let acted = null, actedUrl = null;
      if ((a.action === 'click' || a.action === 'type') && a.index != null) {
        try {
          actedUrl = await ctx.page.eval('location.href');
          acted = await ctx.page.eval(
            `(function(){var el=document.querySelector('${q(a.index)}');if(!el)return null;` +
            `var t=(el.getAttribute('aria-label')||el.textContent||el.value||el.placeholder||'').trim().slice(0,60);` +
            `return {label:t,type:(el.tagName||'').toLowerCase()};})()`);
        } catch {}
      }
      let res;
      switch (a.action) {
        case 'click': res = await actions.click(ctx.page, a.index); break;
        case 'type': res = await actions.type(ctx.page, a.index, a.text || '', !!a.submit); break;
        case 'press': res = await actions.pressKey(ctx.page, a.key || 'Enter'); break;
        case 'scroll': res = await actions.scroll(ctx.page, a.direction || 'down', a.amount || 600); break;
        default: throw new Error('invalid action: ' + a.action);
      }
      if (acted && acted.label) { try { siteMemory.recordAction(actedUrl, acted); } catch {} }
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
    name: 'memory', group: 'session', pageless: true,
    description: 'Show what Logica Pilot has LEARNED about sites (the flywheel): visit counts, most-used elements and known recipes. Repeat tasks warm-start from this. Optional domain filter.',
    input: { properties: { domain: { type: 'string', description: 'filter to one hostname (e.g. github.com)' } } },
    run: async (a) => {
      const stats = siteMemory.stats();
      if (a.domain) return { json: { stats, site: siteMemory.dump(a.domain) } };
      return { json: { stats, sites: siteMemory.dump() } };
    },
  },
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
    description: 'CHANGE TRACKING: compare a URL against its last snapshot (persisted across sessions). Returns changeStatus new|same|changed + a git-style diff of what changed. `tag` keeps separate histories for the same URL (e.g. hourly vs daily); `webhook` POSTs the result when changed.',
    input: {
      properties: {
        url: { type: 'string' },
        tag: { type: 'string', description: 'separate tracking history for the same URL' },
        diff: { type: 'boolean', description: 'include the line diff (default true)' },
        webhook: { type: 'string', description: 'POST the result here when the page changed' },
      }, required: ['url'],
    },
    run: async (a, ctx) => {
      await ctx.page.goto(a.url);
      await sleep(600);
      const snap = await perception.snapshot(ctx.page, { maxEls: 0, maxChars: 60000 });
      const text = String(snap.text || '');
      const prev = watchLoad(a.url, a.tag);
      watchSave(a.url, a.tag, text);

      const out = { url: a.url, title: snap.title, changeStatus: 'new', previousScrapeAt: null };
      if (a.tag) out.tag = a.tag;
      if (prev) {
        out.previousScrapeAt = prev.ts;
        if (prev.text === text) out.changeStatus = 'same';
        else {
          out.changeStatus = 'changed';
          const d = lineDiff(prev.text, text, { maxOut: 100 });
          out.added = d.added; out.removed = d.removed;
          if (a.diff !== false) out.diff = d.text;
        }
      } else {
        out.textPreview = text.slice(0, 400);
      }
      if (a.webhook && out.changeStatus === 'changed') {
        try {
          const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
          await fetch(a.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out), signal: ctrl.signal })
            .then(() => { out.webhookDelivered = true; }, () => { out.webhookDelivered = false; })
            .finally(() => clearTimeout(t));
        } catch { out.webhookDelivered = false; }
      }
      return { json: out };
    },
  },

  // ── site (whole-site capabilities: discovery, crawling, llms.txt) ──
  {
    name: 'map', group: 'site', pageless: true, primary: 'url',
    description: "DISCOVER a site's URLs instantly (robots.txt sitemaps + sitemap.xml, falls back to on-page links). Optional `search` filters URLs by substring. Use before crawl to plan.",
    input: {
      properties: {
        url: { type: 'string', description: 'site root or any page on it' },
        search: { type: 'string', description: 'filter: keep URLs containing this' },
        limit: { type: 'number', description: 'max URLs (default 200)' },
      }, required: ['url'],
    },
    run: async (a) => ({ json: await crawler.map(a.url, { limit: a.limit, search: a.search }) }),
  },
  {
    name: 'crawl', group: 'site', pageless: true, primary: 'url',
    description: 'CRAWL a whole site/section breadth-first (parallel pages): follows same-domain links with includePaths/excludePaths regex filters, maxDepth and page limit; respects robots.txt. Returns compact {url,title,text} per page — never raw HTML.',
    input: {
      properties: {
        url: { type: 'string' },
        limit: { type: 'number', description: 'max pages (default 15, cap 100)' },
        maxDepth: { type: 'number', description: 'link depth from start (default 3)' },
        includePaths: { type: 'array', items: { type: 'string' }, description: 'regex allowlist on pathname (e.g. "^/docs")' },
        excludePaths: { type: 'array', items: { type: 'string' }, description: 'regex blocklist on pathname' },
        allowSubdomains: { type: 'boolean' },
        textChars: { type: 'number', description: 'text budget per page (default 1200; 0 = urls+titles only)' },
        concurrency: { type: 'number' },
      }, required: ['url'],
    },
    run: async (a, ctx) => {
      const r = await crawler.crawl({
        url: a.url, limit: a.limit, maxDepth: a.maxDepth, includePaths: a.includePaths, excludePaths: a.excludePaths,
        allowSubdomains: a.allowSubdomains, textChars: a.textChars === undefined ? 1200 : a.textChars,
        concurrency: a.concurrency, onEvent: ctx.onEvent,
      });
      return { json: r };
    },
  },
  {
    name: 'batch', group: 'site', pageless: true, primary: 'action',
    description: "ASYNC jobs: start a fanout/crawl in the background and check it later (action: start|status|get|list). start returns a jobId immediately; the job runs detached and survives this call. status → progress; get → the results when done.",
    input: {
      properties: {
        action: { type: 'string', enum: ['start', 'status', 'get', 'list'] },
        kind: { type: 'string', enum: ['fanout', 'crawl'], description: 'for start' },
        id: { type: 'string', description: 'jobId, for status/get' },
        // start passthrough (fanout: urls/task/mode/schema/synthesize — crawl: url/limit/maxDepth/includePaths/excludePaths/textChars)
        urls: { type: 'array', items: { type: 'string' } }, task: { type: 'string' },
        mode: { type: 'string', enum: ['extract', 'read', 'run'] }, schema: { type: 'object' }, synthesize: { type: 'string' },
        url: { type: 'string' }, limit: { type: 'number' }, maxDepth: { type: 'number' },
        includePaths: { type: 'array', items: { type: 'string' } }, excludePaths: { type: 'array', items: { type: 'string' } },
        textChars: { type: 'number' },
      }, required: ['action'],
    },
    run: async (a) => {
      if (a.action === 'start') {
        const kind = a.kind || (a.urls ? 'fanout' : 'crawl');
        const params = kind === 'fanout'
          ? { urls: a.urls, task: a.task, mode: a.mode, schema: a.schema, synthesize: a.synthesize }
          : { url: a.url, limit: a.limit, maxDepth: a.maxDepth, includePaths: a.includePaths, excludePaths: a.excludePaths, textChars: a.textChars };
        const id = jobs.start(kind, params);
        return { json: { jobId: id, kind, status: 'queued', hint: `check with batch action=status id=${id}` } };
      }
      if (a.action === 'list') return { json: jobs.list() };
      const job = a.id && jobs.readJob(a.id);
      if (!job) return { json: { error: 'job not found', id: a.id || null } };
      if (a.action === 'status') {
        return { json: { id: job.id, kind: job.kind, status: job.status, progress: job.progress, startedAt: job.startedAt, finishedAt: job.finishedAt || null, error: job.error || undefined } };
      }
      // get
      if (job.status !== 'done') return { json: { id: job.id, status: job.status, progress: job.progress, error: job.error || undefined } };
      return { json: { id: job.id, kind: job.kind, result: job.result } };
    },
  },
  {
    name: 'llmstxt', group: 'site', pageless: true, primary: 'url',
    description: 'GENERATE an llms.txt for a site: discovers key pages (map), reads them in parallel, and writes the standard llms.txt (site summary + curated links with one-line descriptions).',
    input: { properties: { url: { type: 'string' }, limit: { type: 'number', description: 'pages to read (default 10)' } }, required: ['url'] },
    run: async (a, ctx) => {
      const limit = Math.max(3, Math.min(Number(a.limit) || 10, 20));
      const m = await crawler.map(a.url, { limit: 60 });
      if (!m.urls.length) return { text: '(no URLs discovered — is the site reachable?)' };
      // Prefer shallow paths (home/docs/pricing/about) over deep leaves.
      const ranked = m.urls
        .map((u) => { try { return { u, d: new URL(u).pathname.split('/').filter(Boolean).length }; } catch { return null; } })
        .filter(Boolean).sort((x, y) => x.d - y.d).slice(0, limit).map((x) => x.u);
      const r = await fanout({ urls: ranked, mode: 'read', concurrency: 4, onEvent: ctx.onEvent });
      const compact = r.results.filter((x) => x && x.ok)
        .map((x) => `URL: ${x.url}\nTITLE: ${x.title || ''}\n${String(x.text || '').slice(0, 900)}`)
        .join('\n\n---\n\n');
      const resp = await llm.callClaude({
        system: 'You generate llms.txt files (the standard: https://llmstxt.org). Output ONLY the llms.txt content in Markdown: "# Site Name", a one-paragraph "> summary", then sections (## Docs, ## Pages...) with "- [Title](url): one-line description" entries. No commentary.',
        messages: [{ role: 'user', content: `Generate the llms.txt for this site from these pages:\n\n${compact.slice(0, 24000)}` }],
        maxTokens: 1600, model: ctx.model,
      });
      return { text: llm.textOf(resp) || '(generation failed)' };
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
        includeResults: { type: 'boolean', description: 'Return the full per-URL results[] even when synthesizing (default: only synthesis + sources).' },
      }, required: ['urls', 'task'],
    },
    run: async (a, ctx) => {
      const r = await fanout({ urls: a.urls, task: a.task, mode: a.mode || 'extract', schema: a.schema, synthesize: a.synthesize, concurrency: a.concurrency, model: ctx.model, onEvent: ctx.onEvent });
      // When synthesis was requested, the caller wants the answer — not N raw pages.
      // Drop results[] (often ~20KB) for a slim sources[] list; citations [n] in the
      // synthesis stay resolvable. `includeResults:true` is the escape hatch.
      if (a.synthesize && !a.includeResults) {
        const out = { count: r.count, ok: r.ok, sources: r.results.map((x) => ({ url: x.url, title: x.title, ok: x.ok, ...(x.error && { error: x.error }) })) };
        if (r.synthesis != null) out.synthesis = r.synthesis;
        return { json: out };
      }
      return { json: { count: r.count, ok: r.ok, synthesis: r.synthesis, results: r.results } };
    },
  },
  {
    name: 'search', group: 'multi-agent', pageless: true, primary: 'query',
    description: 'Search the web and return result URLs (title + url). content:true also READS the top results in parallel and attaches their text — search with full content in one call.',
    input: { properties: { query: { type: 'string' }, limit: { type: 'number' }, content: { type: 'boolean', description: 'fetch and attach the text of each result' } }, required: ['query'] },
    run: async (a, ctx) => {
      const results = await search(a.query, { limit: a.limit });
      if (!a.content || !results.length) return { json: results };
      const top = results.slice(0, Math.min(results.length, 6));
      const r = await fanout({ urls: top.map((x) => x.url), mode: 'read', concurrency: 4, onEvent: ctx.onEvent });
      const byUrl = new Map(r.results.filter(Boolean).map((x) => [x.url, x]));
      return {
        json: results.map((x) => {
          const rec = byUrl.get(x.url);
          return rec && rec.ok ? { ...x, text: String(rec.text || '').slice(0, 1200) } : x;
        }),
      };
    },
  },
  {
    name: 'ask', group: 'multi-agent', pageless: true, primary: 'question',
    description: 'ASK a question. With `url`: answers grounded ONLY in that page (quotes the passage). Without `url`: searches the web, reads the top results in parallel and answers with citations [n]. Tighter than research — one direct answer.',
    input: { properties: { question: { type: 'string' }, url: { type: 'string' }, limit: { type: 'number', description: 'web mode: sources to read (default 4)' } }, required: ['question'] },
    run: async (a, ctx) => {
      if (a.url) {
        const { Browser } = require('./browser');
        const browser = await Browser.launch({ headless: true });
        try {
          const page = await browser.newPage();
          await page.goto(a.url, { timeout: 25000 }).catch(() => {});
          await sleep(600);
          const md = await perception.markdown(page, { maxChars: 12000 });
          const resp = await llm.callClaude({
            system: 'Answer the question using ONLY the page content provided. Quote the relevant passage. If the answer is not on the page, say so plainly.',
            messages: [{ role: 'user', content: `PAGE (${a.url}):\n${md}\n\nQUESTION: ${a.question}` }],
            maxTokens: 700, model: ctx.model,
          });
          return { text: llm.textOf(resp) || '(no answer)' };
        } finally { try { await browser.close(); } catch {} }
      }
      const results = await search(a.question, { limit: Math.max(2, Math.min(Number(a.limit) || 4, 8)) });
      if (!results.length) return { text: '(no search results)' };
      const r = await fanout({ urls: results.map((x) => x.url), mode: 'read', concurrency: 4, onEvent: ctx.onEvent });
      const compact = r.results.filter((x) => x && x.ok)
        .map((x, i) => `[${i}] ${x.url}\n${String(x.text || '').slice(0, 1500)}`).join('\n\n');
      const resp = await llm.callClaude({
        system: 'Answer the question directly and concisely from the sources, citing [n]. If sources disagree, say so.',
        messages: [{ role: 'user', content: `SOURCES:\n${compact}\n\nQUESTION: ${a.question}` }],
        maxTokens: 800, model: ctx.model,
      });
      return { text: llm.textOf(resp) || '(no answer)' };
    },
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
