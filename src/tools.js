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
const crypto = require('crypto');
const pageData = require('./page-data');
const jobs = require('./jobs');
const { redactPII } = require('./redact');
const { dismissConsent } = require('./consent');
const { checkChange } = require('./change');
const monitor = require('./monitor');
const dataset = require('./dataset');
const flight = require('./flight');
const adapters = require('./adapters');
const workflow = require('./workflow');
const knowledge = require('./knowledge');
const handoffLib = require('./handoff');
const stealth = require('./stealth');
const deviceEmulation = require('./device-emulation');
const network = require('./network');
const assertions = require('./assertions');
const devtools = require('./devtools');
const feedbackLib = require('./feedback');
const hygiene = require('./hygiene');
const primitives = require('./primitives');
const tabs = require('./tabs');
const captchaLib = require('./captcha');
const video = require('./video');
const proxyPool = require('./proxy-pool');
const persist = require('./persist');
const httpEngine = require('./http-engine');
const requestQueue = require('./request-queue');
const kvs = require('./kvs');
const fingerprintLib = require('./fingerprint');
const crawlerLib = require('./crawler');
const adaptive = require('./adaptive');

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
// Self-repair (#3) + recipes (#1): learn from a finished run's trace. Records a
// per-host fix when an action clearly failed and a DIFFERENT one recovered, and a
// reusable recipe on success. Best-effort; never throws.
const FAIL_RE = /ERROR|not found|no effect|did NOT|invalid|timeout|⚠️/i;
function learnFromTrace(startUrl, goal, r) {
  try {
    const trace = (r && r.trace) || [];
    if (!trace.length) return;
    let host = startUrl || null;
    const acts = trace.filter((s) => s.action && s.action !== 'done');
    for (let i = 0; i < acts.length; i++) {
      const s = acts[i];
      if (s.action === 'navigate' && s.input && s.input.url) host = s.input.url;
      const failed = FAIL_RE.test(String(s.result || ''));
      if (!failed) continue;
      // find the next DIFFERENT successful-looking action = the recovery
      for (let j = i + 1; j < acts.length; j++) {
        const nxt = acts[j];
        if (FAIL_RE.test(String(nxt.result || ''))) continue;
        if (nxt.action === s.action && JSON.stringify(nxt.input) === JSON.stringify(s.input)) continue;
        const problem = `${s.action}${s.input && s.input.reason ? ' (' + String(s.input.reason).slice(0, 50) + ')' : ''} failed`;
        const fix = `${nxt.action}${nxt.input && nxt.input.reason ? ' — ' + String(nxt.input.reason).slice(0, 60) : ''}`;
        if (host) siteMemory.recordFix(host, { problem, fix });
        break;
      }
    }
    if (r && r.success && host && goal) {
      const steps = acts.slice(0, 12).map((s) => ({ action: s.action, input: s.input && s.input.reason ? s.input.reason : (s.input && (s.input.url || s.input.text || s.input.index)) }));
      siteMemory.recordRecipe(host, goal, steps);
    }
  } catch {}
}

async function ensureUrl(page, a) {
  if (a && a.url) {
    await page.goto(a.url);
    // Consent killer (#8): clear cookie/consent walls right after navigation, once,
    // so the perception map isn't polluted (and the real content isn't blocked).
    if (a.consent !== false) { try { await dismissConsent(page); } catch {} }
  }
}

// engine:'http' → fetch over raw HTTP (no browser navigation) and load the HTML into
// the page so the existing DOM parsers (read/observe/extract/meta/product) run on it
// at a fraction of the cost. engine:'browser' (default) navigates normally. Returns
// the http response meta (or null for the browser path) so callers can read status.
async function ensureContent(page, a) {
  if (a && a.engine === 'http' && a.url) {
    const r = await httpEngine.httpFetch(a.url, { proxy: a.proxy, cookies: a.cookies });
    await httpEngine.loadHtml(page, r.body, r.url);
    return { engine: 'http', status: r.status, contentType: r.contentType, finalUrl: r.url };
  }
  if (a && a.engine === 'adaptive' && a.url) {
    return adaptive.smartLoad(page, a.url, { proxy: a.proxy, cookies: a.cookies });
  }
  await ensureUrl(page, a);
  return { engine: 'browser' };
}
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
    run: async (a, ctx) => { await ctx.page.goto(a.url); if (a.consent !== false) { try { await dismissConsent(ctx.page); } catch {} } return { text: await map(ctx.page) }; },
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
        redactPII: { type: 'boolean', description: 'mask emails, phones, CPF/CNPJ, cards (Luhn), IPs — deterministic, local' },
        engine: { type: 'string', enum: ['browser', 'http', 'adaptive'], description: 'browser (default, full CDP) · http (raw fetch, 10-50x cheaper, no JS) · adaptive (try http, auto-escalate to browser on JS-shell/anti-bot; caches per-host verdict).' },
        proxy: { type: 'string', description: 'http/adaptive engine — user:pass@host:port' },
      },
    },
    run: async (a, ctx) => {
      const maxChars = Math.max(200, Math.min(Number(a.maxChars) || 6000, 20000));
      const offset = Math.max(0, Number(a.offset) || 0);
      // Opt-in cache (Firecrawl-style maxAge): serve a fresh-enough previous read
      // of the same url+format+window without reloading the page. 0 = always live.
      const maxAge = Math.max(0, Number(a.maxAge) || 0);
      const ck = a.url ? cacheKey(['read', a.url, a.markdown ? 'md' : 'txt', String(offset), String(maxChars), a.redactPII ? 'pii' : '', a.engine || '']) : null;
      if (ck && maxAge > 0 && !a.summarize) {
        const hit = cacheLoad(ck, maxAge);
        if (hit) return { text: hit.text };
      }
      await ensureContent(ctx.page, a);
      let text; let total;
      if (a.markdown) {
        const md = await perception.markdown(ctx.page, { maxChars: Math.min(offset + maxChars + 1, 60000) });
        total = md.length; text = md.slice(offset, offset + maxChars);
      } else {
        const snap = await perception.snapshot(ctx.page, { maxEls: 0, maxChars: Math.min(offset + maxChars + 1, 60000) });
        total = snap.textTotal || String(snap.text || '').length;
        text = String(snap.text || '').trim().slice(offset, offset + maxChars);
      }
      // Redact BEFORE anything leaves this process (including the summarize LLM call).
      // Keep the PRE-redaction length: pagination (offset/total) works on raw text,
      // and redaction shrinks the string — the marker must not claim missing content.
      const rawShown = text.length;
      if (a.redactPII && text) text = redactPII(text).text;
      if (a.summarize && text) {
        const resp = await llm.callClaude({ system: 'Summarize the web page objectively.', messages: [{ role: 'user', content: 'Summarize:\n\n' + text.slice(0, 8000) }], maxTokens: 700, model: ctx.model });
        return { text: llm.textOf(resp) || '(no text)' };
      }
      if (!text) return { text: '(no text)' };
      // Honest truncation: always say when there is more, and how to get it.
      if (offset + rawShown < total) {
        text += `\n\n[showing ${offset}–${offset + rawShown} of ${total} chars — pass offset=${offset + rawShown} for more]`;
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
    name: 'media', group: 'perception', primary: 'url',
    description: 'Discover MEDIA on the page: <video>/<audio> sources, og:video, direct file links (.mp4/.mp3/.m3u8…) and known embeds (YouTube/Vimeo/Spotify — reported, not downloadable). download:true saves DIRECT files to disk (size-capped).',
    input: {
      properties: {
        url: { type: 'string' },
        download: { type: 'boolean', description: 'download direct video/audio/file URLs' },
        dir: { type: 'string', description: 'download folder (default ~/Downloads/logica-pilot)' },
        maxMB: { type: 'number', description: 'per-file cap in MB (default 200)' },
      },
    },
    run: async (a, ctx) => {
      await ensureUrl(ctx.page, a);
      const found = await pageData.media(ctx.page);
      if (!a.download) return { json: found };
      const dir = a.dir || path.join(os.homedir(), 'Downloads', 'logica-pilot');
      fs.mkdirSync(dir, { recursive: true });
      const capBytes = Math.max(1, Math.min(Number(a.maxMB) || 200, 2000)) * 1024 * 1024;
      const direct = [...found.videos, ...found.audios, ...found.files]
        .map((x) => x.url).filter((u) => /^https?:/.test(u) && !/\.(m3u8|mpd)(\?|$)/i.test(u)).slice(0, 5);
      const saved = [];
      for (const u of direct) {
        try {
          const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 120000);
          const res = await fetch(u, { signal: ctrl.signal });
          if (!res.ok || !res.body) { saved.push({ url: u, ok: false, error: 'HTTP ' + res.status }); clearTimeout(t); continue; }
          const len = Number(res.headers.get('content-length') || 0);
          if (len && len > capBytes) { saved.push({ url: u, ok: false, error: `larger than cap (${Math.round(len / 1e6)}MB)` }); ctrl.abort(); clearTimeout(t); continue; }
          const name = (new URL(u).pathname.split('/').pop() || 'media').replace(/[^\w.-]/g, '_').slice(0, 80) || 'media';
          const file = path.join(dir, Date.now().toString(36) + '-' + name);
          const { Readable } = require('stream');
          const ws = fs.createWriteStream(file);
          let bytes = 0; let tooBig = false;
          await new Promise((resolve, reject) => {
            const rs = Readable.fromWeb(res.body);
            rs.on('data', (c) => { bytes += c.length; if (bytes > capBytes) { tooBig = true; rs.destroy(); } });
            rs.on('error', reject); ws.on('error', reject); ws.on('finish', resolve);
            rs.pipe(ws);
          }).catch((e) => { if (!tooBig) throw e; });
          clearTimeout(t);
          if (tooBig) { try { fs.unlinkSync(file); } catch {} saved.push({ url: u, ok: false, error: 'exceeded cap mid-download' }); }
          else saved.push({ url: u, ok: true, file, bytes });
        } catch (e) { saved.push({ url: u, ok: false, error: (e && e.message) || String(e) }); }
      }
      return { json: { ...found, downloads: saved, dir } };
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
    name: 'handoff', group: 'perception', primary: 'action',
    description: 'HUMAN HANDOFF: detect when the page needs a human (login / captcha / Cloudflare / payment) instead of trying to bypass it (action: check|wait). `wait` polls until you resolve it in a VISIBLE window (desktop/headful/attach), then lets the agent continue with the now-authenticated session.',
    input: { properties: { action: { type: 'string', enum: ['check', 'wait'] }, url: { type: 'string' }, timeout: { type: 'number', description: 'wait: max ms (default 180000)' } } },
    run: async (a, ctx) => {
      await ensureUrl(ctx.page, a);
      if (a.action === 'wait') {
        const bringToFront = ctx.pilot && ctx.pilot.opts && ctx.pilot.opts.attached ? null : () => ctx.page.send('Page.bringToFront').catch(() => {});
        return { json: await handoffLib.waitForHuman(ctx.page, { timeoutMs: a.timeout || 180000, bringToFront }) };
      }
      return { json: await handoffLib.detect(ctx.page) };
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
    description: 'Execute a multi-step OBJECTIVE autonomously (agent observes→acts in a loop). For whole tasks. Every run is saved by the flight recorder (see the `runs` tool); shots:true also captures a screenshot per step for the HTML report.',
    input: { properties: { url: { type: 'string' }, goal: { type: 'string' }, maxSteps: { type: 'number' }, shots: { type: 'boolean', description: 'save a screenshot per step in the flight report' } }, required: ['goal'] },
    run: async (a, ctx) => {
      const rec = flight.record({ goal: a.goal, url: a.url, model: ctx.model });
      const onStep = async (s) => {
        rec.step(s);
        if (a.shots && ctx.page && s.action !== 'done') {
          try { rec.shot(s.step, await actions.screenshot(ctx.page, { format: 'jpeg', quality: 55 })); } catch {}
        }
      };
      const r = await agent.run(ctx.page, a.goal, { maxSteps: a.maxSteps || 12, model: ctx.model, startUrl: a.url, onStep });
      learnFromTrace(a.url, a.goal, r); // self-repair + recipe learning
      const rep = rec.done(r);
      const text = typeof r === 'string' ? r : (r && (r.result || r.summary)) || JSON.stringify(r);
      return { text: `${text}\n\n📼 flight: ${rep.id} · report: ${rep.report}` };
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
      try { await dismissConsent(ctx.page); } catch {}
      const snap = await perception.snapshot(ctx.page, { maxEls: 0, maxChars: 60000 });
      const out = checkChange(a.url, a.tag, String(snap.text || ''), { title: snap.title, diff: a.diff !== false });
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
  {
    name: 'monitor', group: 'session', pageless: true, primary: 'action',
    description: 'SCHEDULED change monitors with alerts (action: add|list|remove|check). add a URL with `every` (30m/2h/1d) and `notify` (telegram/webhook/desktop); a background daemon (`logica-pilot monitor-daemon`) checks due ones and alerts only when they actually change.',
    input: {
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove', 'check'] },
        url: { type: 'string' }, id: { type: 'string' }, tag: { type: 'string' },
        every: { type: 'string', description: 'cadence: 30m, 2h, 1d (default 30m)' },
        label: { type: 'string' },
        notify: { type: 'object', description: '{desktop:true} | {webhook:"https://…"} | {telegram:{token,chatId}} (or true for env TELEGRAM_BOT_TOKEN/CHAT_ID)' },
      }, required: ['action'],
    },
    run: async (a) => {
      if (a.action === 'add') return { json: monitor.add({ url: a.url, tag: a.tag, every: a.every, notify: a.notify, label: a.label }) };
      if (a.action === 'list') return { json: monitor.list() };
      if (a.action === 'remove') return { json: monitor.remove(a.id) };
      if (a.action === 'check') {
        const mon = a.id ? monitor.get(a.id) : { id: 'adhoc', url: a.url, tag: a.tag, notify: {} };
        if (!mon || !mon.url) return { json: { error: 'pass id (existing monitor) or url' } };
        return { json: await monitor.checkOne(mon, { force: true }) };
      }
      return { json: { error: 'unknown action' } };
    },
  },
  {
    name: 'adapter', group: 'autonomy', primary: 'action',
    description: 'SITE ADAPTERS: turn a site task into a named, parameterized tool (action: save|list|run|remove). save a `goal` template with {params} for a host; `run` fills the params and drives the agent (warm-started by site memory). Saved adapters also appear as their own MCP tools (x_<name>).',
    input: {
      properties: {
        action: { type: 'string', enum: ['save', 'list', 'run', 'remove'] },
        name: { type: 'string' }, host: { type: 'string' }, goal: { type: 'string', description: 'template, e.g. "search {query} on Amazon and return the top 5 with price"' },
        description: { type: 'string' }, params: { type: 'object', description: 'values for {params} when running' },
        maxSteps: { type: 'number' },
      }, required: ['action'],
    },
    run: async (a, ctx) => {
      if (a.action === 'save') return { json: adapters.save({ name: a.name, host: a.host, goal: a.goal, description: a.description }) };
      if (a.action === 'list') return { json: adapters.list() };
      if (a.action === 'remove') return { json: adapters.remove(a.name) };
      if (a.action === 'run') {
        const ad = adapters.get(a.name);
        if (!ad) return { json: { error: 'adapter not found: ' + a.name } };
        const goal = adapters.fillGoal(ad.goal, a.params || {});
        const rec = flight.record({ goal, url: ad.host, model: ctx.model });
        const r = await agent.run(ctx.page, goal, { maxSteps: a.maxSteps || 15, model: ctx.model, startUrl: ad.host, onStep: (s) => rec.step(s) });
        learnFromTrace(ad.host, goal, r);
        const rep = rec.done(r);
        return { text: `${(r && r.result) || JSON.stringify(r)}\n\n📼 ${rep.id}` };
      }
      return { json: { error: 'unknown action' } };
    },
  },
  {
    name: 'workflow', group: 'autonomy', primary: 'action',
    description: 'AUTOPILOT RECORDER: save a task as a replayable workflow of concrete steps and REPLAY it deterministically (almost free, no LLM). Steps target elements by LABEL so replay survives layout changes; on a miss it falls back to the AI agent (action: save|list|replay|remove).',
    input: {
      properties: {
        action: { type: 'string', enum: ['save', 'list', 'replay', 'remove'] },
        name: { type: 'string' }, host: { type: 'string' }, goal: { type: 'string', description: 'natural-language fallback if a step fails' },
        steps: { type: 'array', items: { type: 'object' }, description: '[{action:"navigate",url}|{action:"type",label,text,submit}|{action:"click",label}|{action:"scroll",direction}|{action:"press",key}|{action:"wait",ms}]' },
        params: { type: 'object', description: '{key} substitutions at replay' },
        fallback: { type: 'boolean', description: 'run the AI agent to finish if a step fails (default true)' },
      }, required: ['action'],
    },
    run: async (a, ctx) => {
      if (a.action === 'save') return { json: workflow.save({ name: a.name, host: a.host, goal: a.goal, steps: a.steps }) };
      if (a.action === 'list') return { json: workflow.list() };
      if (a.action === 'remove') return { json: workflow.remove(a.name) };
      if (a.action === 'replay') {
        const wf = workflow.get(a.name);
        if (!wf) return { json: { error: 'workflow not found: ' + a.name } };
        const agentFallback = a.fallback === false ? null : (goal) => agent.run(ctx.page, goal, { maxSteps: 12, model: ctx.model });
        return { json: await workflow.replay(ctx.page, wf, { params: a.params, agentFallback }) };
      }
      return { json: { error: 'unknown action' } };
    },
  },
  {
    name: 'runs', group: 'session', pageless: true, primary: 'action',
    description: 'FLIGHT RECORDER: browse past autonomous runs (action: list|show). Every `run` is saved with its steps, token usage and screenshots as a self-contained HTML report. show returns the report path to open.',
    input: { properties: { action: { type: 'string', enum: ['list', 'show'] }, id: { type: 'string' } } },
    run: async (a) => {
      if (a.action === 'show') { const r = flight.load(a.id); if (!r) return { json: { error: 'run not found' } }; return { json: { id: r.id, goal: r.goal, steps: r.steps.length, result: r.result, report: flight.reportPath(a.id) } }; }
      return { json: flight.list() };
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
        proxy: { type: 'string', description: 'BYO proxy: user:pass@host:port (Webshare, Bright Data, …); default: LOGICA_PILOT_PROXY env' },
        location: { type: 'object', description: '{country:"BR", languages:["pt-BR"]} — timezone/locale/Accept-Language emulation' },
        redactPII: { type: 'boolean', description: 'mask PII in each page text before returning' },
      }, required: ['url'],
    },
    run: async (a, ctx) => {
      const r = await crawler.crawl({
        url: a.url, limit: a.limit, maxDepth: a.maxDepth, includePaths: a.includePaths, excludePaths: a.excludePaths,
        allowSubdomains: a.allowSubdomains, textChars: a.textChars === undefined ? 1200 : a.textChars,
        concurrency: a.concurrency, proxy: a.proxy, location: a.location, onEvent: ctx.onEvent,
      });
      if (a.redactPII) for (const p of r.pages) { if (p.text) p.text = redactPII(p.text).text; }
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
    name: 'index', group: 'site', pageless: true, primary: 'action',
    description: 'LOCAL SEARCH (BM25, 0 tokens, 0 network): crawl a site once into a named index, then query it forever offline (action: build|query|list|remove). Turn docs into an offline knowledge base your agents can grep semantically.',
    input: {
      properties: {
        action: { type: 'string', enum: ['build', 'query', 'list', 'remove'] },
        name: { type: 'string' }, url: { type: 'string', description: 'site to crawl for build' },
        q: { type: 'string', description: 'query text' }, k: { type: 'number', description: 'top results (default 5)' },
        limit: { type: 'number', description: 'pages to crawl for build (default 25)' },
        maxDepth: { type: 'number' }, includePaths: { type: 'array', items: { type: 'string' } },
        docs: { type: 'array', items: { type: 'object' }, description: 'index these {url,title,text} instead of crawling' },
      }, required: ['action'],
    },
    run: async (a) => {
      if (a.action === 'build') return { json: await knowledge.build(a.name, { url: a.url, docs: a.docs, limit: a.limit, maxDepth: a.maxDepth, includePaths: a.includePaths }) };
      if (a.action === 'query') { const r = knowledge.query(a.name, a.q, { k: a.k }); return { json: r || { error: 'index not found: ' + a.name } }; }
      if (a.action === 'list') return { json: knowledge.list() };
      if (a.action === 'remove') return { json: knowledge.remove(a.name) };
      return { json: { error: 'unknown action' } };
    },
  },
  {
    name: 'dataset', group: 'site', pageless: true, primary: 'action',
    description: 'LIVING DATASETS (action: put|get|list|history|export). Turn scrape/gather output into a named local table: append with dedupe by `key`, track added/changed per run, export CSV/JSON. Combine with monitor for a free price/stock time series.',
    input: {
      properties: {
        action: { type: 'string', enum: ['put', 'get', 'list', 'history', 'export'] },
        name: { type: 'string' }, rows: { type: 'array', items: { type: 'object' } },
        key: { type: 'string', description: 'dedupe column (e.g. "url" or "sku")' },
        format: { type: 'string', enum: ['json', 'csv'] }, limit: { type: 'number' },
      }, required: ['action'],
    },
    run: async (a) => {
      if (a.action === 'put') return { json: dataset.put(a.name, a.rows || [], { key: a.key }) };
      if (a.action === 'get') return { json: dataset.get(a.name, { limit: a.limit }) || { error: 'dataset not found' } };
      if (a.action === 'list') return { json: dataset.list() };
      if (a.action === 'history') return { json: dataset.history(a.name) || { error: 'dataset not found' } };
      if (a.action === 'export') { const out = dataset.exportData(a.name, { format: a.format }); return out == null ? { json: { error: 'dataset not found' } } : { text: out }; }
      return { json: { error: 'unknown action' } };
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
    name: 'gather', group: 'multi-agent', pageless: true, primary: 'instruction',
    description: 'AGENT-style data gathering (schema in, JSON out): give an instruction + JSON schema and it finds sources (or takes your urls), extracts from each IN PARALLEL and merges everything into ONE validated JSON with a sources list. The local answer to "describe the data you need".',
    input: {
      properties: {
        instruction: { type: 'string', description: 'what data to gather' },
        schema: { type: 'object', description: 'expected JSON shape of the FINAL merged result' },
        urls: { type: 'array', items: { type: 'string' }, description: 'source pages (skip web search)' },
        query: { type: 'string', description: 'web search query (default: the instruction)' },
        limit: { type: 'number', description: 'sources when searching (default 4)' },
        proxy: { type: 'string' }, location: { type: 'object' },
        dataset: { type: 'string', description: 'append the gathered rows to this named dataset (dedupe + history)' },
        datasetKey: { type: 'string', description: 'dedupe column for the dataset (e.g. "url")' },
      }, required: ['instruction'],
    },
    run: async (a, ctx) => {
      let sources = Array.isArray(a.urls) && a.urls.length ? a.urls : null;
      if (!sources) {
        const found = await search(a.query || a.instruction, { limit: Math.max(2, Math.min(Number(a.limit) || 4, 8)) });
        sources = found.map((x) => x.url);
      }
      if (!sources.length) return { json: { error: 'no sources found — pass urls[] or refine query' } };
      const r = await fanout({
        urls: sources, task: a.instruction, mode: 'extract', schema: a.schema,
        model: ctx.model, proxy: a.proxy, location: a.location, onEvent: ctx.onEvent,
      });
      const perSource = r.results.filter(Boolean).map((x, i) => `[${i}] ${x.url}\n${JSON.stringify(x.data || { error: x.error }).slice(0, 1800)}`).join('\n\n');
      const resp = await llm.callClaude({
        system: 'You merge per-source extraction results into ONE final JSON. Deduplicate, prefer values confirmed by multiple sources, drop nulls. Respond ONLY with valid JSON' + (a.schema ? ' conforming to the provided schema.' : '.'),
        messages: [{ role: 'user', content: `Instruction: ${a.instruction}\n${a.schema ? `Final schema: ${JSON.stringify(a.schema)}\n` : ''}\nPer-source extractions:\n${perSource}\n\nRespond with the merged JSON only.` }],
        maxTokens: 1600, model: ctx.model,
      });
      const raw = llm.textOf(resp).replace(/```json/gi, '').replace(/```/g, '').trim();
      let data; try { data = JSON.parse(raw); } catch { data = { _raw: raw }; }
      const out = { data, sources: r.results.map((x) => ({ url: x.url, ok: !!x.ok })) };
      // Optionally persist to a living dataset: use the first array field of the result.
      if (a.dataset) {
        const rows = Array.isArray(data) ? data : (Object.values(data || {}).find((v) => Array.isArray(v)) || []);
        if (rows.length) out.dataset = dataset.put(a.dataset, rows, { key: a.datasetKey });
      }
      return { json: out };
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

  // ── browser control (stealth, device, geo, tabs, hygiene) ──
  {
    name: 'stealth', group: 'browser', primary: 'mode',
    description: 'Anti-fingerprint stealth for the session (mode: regular|stealth|undetected). Patches navigator.webdriver, chrome.runtime, permissions, and (undetected) plugins/WebGL/languages. OPT-IN. NOTE: for CAPTCHAs prefer the `handoff` tool over bypass.',
    input: { properties: { mode: { type: 'string', enum: ['regular', 'stealth', 'undetected'] } } },
    run: async (a, ctx) => { const r = await stealth.applyStealthPatches(ctx.page, a.mode || 'stealth'); return { json: { applied: (a.mode || 'stealth') !== 'regular', mode: a.mode || 'stealth', patches: r || undefined } }; },
  },
  {
    name: 'fingerprint', group: 'browser',
    description: 'Apply a statistically-realistic, INTERNALLY-CONSISTENT browser fingerprint (unlike stealth\'s static patches): coherent UA + UA-CH + platform + screen + webgl + languages + hardware, weighted by real market share. Filter by browser (chrome|edge|firefox|safari) / os (windows|macos|android|ios); seed = sticky identity. Apply BEFORE navigating.',
    input: { properties: { url: { type: 'string' }, browser: { type: 'string' }, os: { type: 'string' }, seed: { type: 'string' } } },
    run: async (a, ctx) => {
      const fp = fingerprintLib.generate({ browser: a.browser, os: a.os, seed: a.seed });
      const r = await fingerprintLib.applyFingerprint(ctx.page, fp);
      await ensureUrl(ctx.page, a);
      return { json: { ...r, platform: fp.platform, screen: fp.screen, webgl: fp.webgl.vendor, cores: fp.cores } };
    },
  },
  {
    name: 'device', group: 'browser', primary: 'device',
    description: 'Emulate a mobile device (iphone|ipad|android|reset) or a custom {width,height,mobile,userAgent}. action:list returns available profiles.',
    input: { properties: { device: { type: 'string' }, url: { type: 'string' }, list: { type: 'boolean' } } },
    run: async (a, ctx) => {
      if (a.list) return { json: deviceEmulation.listDevices() };
      await ensureUrl(ctx.page, a);
      const r = await deviceEmulation.emulateDevice(ctx.page, a.device || 'reset');
      return { json: r || { device: a.device } };
    },
  },
  {
    name: 'geo', group: 'browser',
    description: 'Override GPS geolocation. Pass lat+lon (and optional accuracy), or clear:true to remove the override.',
    input: { properties: { url: { type: 'string' }, lat: { type: 'number' }, lon: { type: 'number' }, accuracy: { type: 'number' }, clear: { type: 'boolean' } } },
    run: async (a, ctx) => {
      await ensureUrl(ctx.page, a);
      if (a.clear) { await deviceEmulation.clearGeolocation(ctx.page); return { json: { cleared: true } }; }
      if (a.lat == null || a.lon == null) return { json: { error: 'pass lat and lon (or clear:true)' } };
      await deviceEmulation.setGeolocation(ctx.page, a.lat, a.lon, a.accuracy);
      return { json: { lat: a.lat, lon: a.lon, accuracy: a.accuracy || 10 } };
    },
  },
  {
    name: 'tabs', group: 'browser', primary: 'action',
    description: 'Multi-tab & iframe management (action: list|new|switch|close|frames). Drive multiple tabs in the same browser.',
    input: { properties: { action: { type: 'string', enum: ['list', 'new', 'switch', 'close', 'frames'] }, url: { type: 'string' }, targetId: { type: 'string' } } },
    run: async (a, ctx) => {
      const conn = ctx.page && ctx.page._c;
      const browser = ctx.pilot && ctx.pilot.browser;
      if (a.action === 'frames') return { json: await tabs.listFrames(ctx.page) };
      if (a.action === 'list') return { json: await tabs.listTabs(conn) };
      if (a.action === 'new') { const p = await tabs.newTab(browser, a.url); return { json: { targetId: p && p.targetId, url: a.url || 'about:blank' } }; }
      if (a.action === 'switch') { await tabs.switchTab(conn, a.targetId); return { json: { switched: a.targetId } }; }
      if (a.action === 'close') { await tabs.closeTab(conn, a.targetId); return { json: { closed: a.targetId } }; }
      return { json: { error: 'unknown action' } };
    },
  },
  {
    name: 'wipe', group: 'browser',
    description: 'Per-task state hygiene: clear cookies/storage/cache (optionally only entries older than N days).',
    input: { properties: { url: { type: 'string' }, cookies: { type: 'boolean' }, storage: { type: 'boolean' }, cache: { type: 'boolean' }, olderThanDays: { type: 'number' } } },
    run: async (a, ctx) => { await ensureUrl(ctx.page, a); return { json: await hygiene.wipe(ctx.page, { cookies: a.cookies !== false, storage: a.storage !== false, cache: !!a.cache, olderThanDays: a.olderThanDays }) }; },
  },
  {
    name: 'health', group: 'browser', pageless: false,
    description: 'Browser health: alive, port, tab count, active browser, and any recent crashes.',
    input: { properties: {} },
    run: async (a, ctx) => { return { json: await hygiene.health(ctx.page, ctx.page && ctx.page._c) }; },
  },
  {
    name: 'html', group: 'browser', primary: 'url',
    description: 'Return the raw HTML of the page (or a selector). Prefer `read`/`observe` (token-first) unless you truly need raw markup.',
    input: { properties: { url: { type: 'string' }, selector: { type: 'string' }, outer: { type: 'boolean' } } },
    run: async (a, ctx) => { await ensureUrl(ctx.page, a); const r = await hygiene.rawHtml(ctx.page, { selector: a.selector, outer: a.outer !== false }); return { text: (r && typeof r === 'object' && 'html' in r) ? r.html : r }; },
  },
  {
    name: 'fast', group: 'browser',
    description: 'Toggle fast mode: reduce per-command auto-wait for speed (on:true|false).',
    input: { properties: { on: { type: 'boolean' } } },
    run: async (a, ctx) => { await hygiene.setFastMode(ctx.page, a.on !== false); return { json: { fast: a.on !== false } }; },
  },

  // ── network control (block, throttle, intercept) ──
  {
    name: 'block', group: 'network',
    description: 'Block requests by preset (images|fonts|media|ads) or URL patterns — faster, leaner scraping. off:true disables.',
    input: { properties: { url: { type: 'string' }, what: { type: 'array', items: { type: 'string' } }, off: { type: 'boolean' } } },
    run: async (a, ctx) => {
      if (a.off) { await network.unblockResources(ctx.page); return { json: { blocking: false } }; }
      await network.blockResources(ctx.page, a.what || ['images', 'fonts', 'ads']);
      await ensureUrl(ctx.page, a);
      return { json: { blocking: a.what || ['images', 'fonts', 'ads'] } };
    },
  },
  {
    name: 'throttle', group: 'network', primary: 'profile',
    description: 'Simulate network conditions (slow3g|fast3g|offline) or off to restore.',
    input: { properties: { url: { type: 'string' }, profile: { type: 'string' } } },
    run: async (a, ctx) => {
      if (!a.profile || a.profile === 'off') { await network.unthrottle(ctx.page); return { json: { throttle: 'off' } }; }
      await network.throttle(ctx.page, a.profile);
      await ensureUrl(ctx.page, a);
      return { json: { throttle: a.profile } };
    },
  },
  {
    name: 'intercept', group: 'network', primary: 'action',
    description: 'Request interception (action: mock|headers|clear). mock: fulfill matching requests with a canned response; headers: inject extra HTTP headers on all requests.',
    input: { properties: { action: { type: 'string', enum: ['mock', 'headers', 'clear'] }, pattern: { type: 'string' }, response: { type: 'object' }, headers: { type: 'object' } } },
    run: async (a, ctx) => {
      if (a.action === 'clear') { await network.clearMocks(ctx.page); return { json: { cleared: true } }; }
      if (a.action === 'headers') { await network.setExtraHeaders(ctx.page, a.headers || {}); return { json: { headers: Object.keys(a.headers || {}) } }; }
      if (a.action === 'mock') { await network.mockResponse(ctx.page, a.pattern, a.response || {}); return { json: { mocking: a.pattern } }; }
      return { json: { error: 'unknown action' } };
    },
  },

  // ── devtools inspection + testing ──
  {
    name: 'inspect', group: 'devtools', primary: 'kind',
    description: 'DevTools inspection (kind: console|network|perf|eval). console/network capture for `duration` ms; perf returns metrics; eval runs JS with a stack trace on error.',
    input: { properties: { kind: { type: 'string', enum: ['console', 'network', 'perf', 'eval'] }, url: { type: 'string' }, duration: { type: 'number' }, filter: { type: 'string' }, expression: { type: 'string' } } },
    run: async (a, ctx) => {
      await ensureUrl(ctx.page, a);
      if (a.kind === 'console') return { json: await devtools.captureConsole(ctx.page, { duration: a.duration }) };
      if (a.kind === 'network') return { json: await devtools.captureNetwork(ctx.page, { duration: a.duration, filter: a.filter }) };
      if (a.kind === 'perf') return { json: await devtools.getPerformanceMetrics(ctx.page) };
      if (a.kind === 'eval') return { json: await devtools.debugEval(ctx.page, a.expression) };
      return { json: { error: 'kind must be console|network|perf|eval' } };
    },
  },
  {
    name: 'assert', group: 'testing', primary: 'type',
    description: 'Test assertions (title/url is|contains, text_visible, element_exists/count/text/value/visible, has_cookie, screenshot_match). Pass one {type,expected,selector?} or an `assertions` array.',
    input: { properties: { url: { type: 'string' }, type: { type: 'string' }, expected: {}, selector: { type: 'string' }, index: { type: 'number' }, name: { type: 'string' }, assertions: { type: 'array', items: { type: 'object' } } } },
    run: async (a, ctx) => {
      await ensureUrl(ctx.page, a);
      if (Array.isArray(a.assertions) && a.assertions.length) return { json: await assertions.runAssertions(ctx.page, a.assertions) };
      return { json: await assertions.runAssertion(ctx.page, { type: a.type, expected: a.expected, selector: a.selector, index: a.index, name: a.name }) };
    },
  },

  // ── extra action primitives (upload, dialog, storage, permission, drag, batch-eval) ──
  {
    name: 'upload', group: 'actions',
    description: 'Upload file(s) to an <input type="file"> by index or CSS selector.',
    input: { properties: { url: { type: 'string' }, target: {}, files: { type: 'array', items: { type: 'string' } } }, required: ['target', 'files'] },
    run: async (a, ctx) => { await ensureUrl(ctx.page, a); return { json: await primitives.uploadFile(ctx.page, a.target, a.files) }; },
  },
  {
    name: 'dialog', group: 'actions',
    description: 'Auto-handle native dialogs (alert/confirm/prompt/beforeunload): accept:true|false, optional promptText. Set before the action that triggers it.',
    input: { properties: { accept: { type: 'boolean' }, promptText: { type: 'string' } } },
    run: async (a, ctx) => { await primitives.setupDialogHandler(ctx.page, { accept: a.accept !== false, promptText: a.promptText }); return { json: { autoHandle: a.accept !== false } }; },
  },
  {
    name: 'drag', group: 'actions',
    description: 'Drag and drop from one element index to another.',
    input: { properties: { url: { type: 'string' }, from: { type: 'number' }, to: { type: 'number' } }, required: ['from', 'to'] },
    run: async (a, ctx) => { await ensureUrl(ctx.page, a); return { json: await primitives.dragAndDrop(ctx.page, a.from, a.to) || { dragged: [a.from, a.to] } }; },
  },
  {
    name: 'storage', group: 'actions', primary: 'action',
    description: 'Read/write localStorage or sessionStorage (action: get|set|remove|clear; type: localStorage|sessionStorage).',
    input: { properties: { url: { type: 'string' }, action: { type: 'string' }, type: { type: 'string' }, key: { type: 'string' }, value: { type: 'string' } }, required: ['action'] },
    run: async (a, ctx) => { await ensureUrl(ctx.page, a); return { json: await primitives.storage(ctx.page, a.action, a.type || 'localStorage', a.key, a.value) }; },
  },
  {
    name: 'kvs', group: 'http', primary: 'action', pageless: true,
    description: 'Key-Value Store (Apify KeyValueStore) for arbitrary blobs/records: screenshots, PDFs, Actor INPUT/OUTPUT, crawl checkpoints, RAG payloads. action: set|get|list|delete|stores|drop. Values: JSON object, text, or {base64,contentType} for binary.',
    input: { properties: { action: { type: 'string', enum: ['set', 'get', 'list', 'delete', 'stores', 'drop'] }, store: { type: 'string' }, key: { type: 'string' }, value: {}, contentType: { type: 'string' } } },
    run: async (a) => {
      if (a.action === 'stores') return { json: kvs.listStores() };
      if (a.action === 'drop') return { json: kvs.drop(a.store) };
      const store = a.store || 'default';
      if (a.action === 'set') { let v = a.value; if (typeof v === 'string') { try { v = JSON.parse(v); } catch {} } return { json: kvs.setValue(store, a.key, v, { contentType: a.contentType }) }; }
      if (a.action === 'get') { const v = kvs.getValue(store, a.key); return v == null ? { json: { error: 'key not found' } } : (typeof v === 'string' ? { text: v } : { json: v }); }
      if (a.action === 'delete') return { json: kvs.del(store, a.key) };
      return { json: kvs.listKeys(store) };
    },
  },
  {
    name: 'queue', group: 'http', primary: 'action', pageless: true,
    description: 'Durable, resumable, deduped request queue (Crawlee RequestQueue). action: add|stats|next|failed|list|drop. Persists to disk — a crawl killed mid-run resumes where it stopped, dedups across runs, tracks per-URL retry/dead-letter.',
    input: { properties: { action: { type: 'string', enum: ['add', 'stats', 'next', 'failed', 'list', 'drop'] }, name: { type: 'string' }, urls: { type: 'array', items: { type: 'string' } }, url: { type: 'string' }, label: { type: 'string' }, clear: { type: 'boolean' } } },
    run: async (a) => {
      if (a.action === 'list') return { json: requestQueue.list() };
      if (a.action === 'drop') return { json: requestQueue.drop(a.name) };
      const q = requestQueue.open(a.name || 'default', { clear: !!a.clear });
      if (a.action === 'add') { const urls = a.urls && a.urls.length ? a.urls : (a.url ? [a.url] : []); const r = q.addBatch(urls.map((u) => ({ url: u, label: a.label })));  return { json: { ...r, stats: q.stats() } }; }
      if (a.action === 'next') { const n = q.fetchNext(); return { json: n ? { url: n.url, label: n.label, key: n.k } : { empty: true } }; }
      if (a.action === 'failed') return { json: q.failed() };
      return { json: q.stats() };
    },
  },
  {
    name: 'crawler', group: 'site', primary: 'url',
    description: 'Crawlee-style structured crawler: durable queue + a pageFunction run on every matched page → rows into a named dataset, with auto link-enqueue, concurrency, retry, and RESUME. engine:http (cheap, no browser) or browser. pageFunction is JS whose return object(s) become dataset rows; `context.url/userData/enqueue()` available. strategy: same-domain|same-hostname|same-origin; globs to filter.',
    input: { properties: { url: { type: 'string' }, urls: { type: 'array', items: { type: 'string' } }, name: { type: 'string' }, pageFunction: { type: 'string' }, engine: { type: 'string', enum: ['http', 'browser', 'adaptive'] }, strategy: { type: 'string' }, globs: { type: 'array', items: { type: 'string' } }, maxDepth: { type: 'number' }, maxRequests: { type: 'number' }, maxConcurrency: { type: 'number' }, resume: { type: 'boolean' } } },
    run: async (a, ctx) => {
      const startUrls = a.urls && a.urls.length ? a.urls : (a.url ? [a.url] : []);
      if (!startUrls.length) return { json: { error: 'pass url or urls' } };
      const res = await crawlerLib.run(ctx.pilot, {
        startUrls, name: a.name, pageFunction: a.pageFunction, engine: a.engine || 'browser',
        strategy: a.strategy, globs: a.globs, maxDepth: a.maxDepth != null ? Number(a.maxDepth) : 2,
        maxRequests: a.maxRequests != null ? Number(a.maxRequests) : 200, maxConcurrency: a.maxConcurrency != null ? Number(a.maxConcurrency) : 5,
        resume: !!a.resume, onEvent: ctx.onEvent,
      });
      return { json: res };
    },
  },
  {
    name: 'fetch', group: 'http', primary: 'url', pageless: true,
    description: 'Raw HTTP fetch WITHOUT a browser (Apify/Crawlee cheap path): GET/POST a URL or JSON API. Follows redirects, gzip/br, browser-like headers, cookie jar, proxy (user:pass@host:port via CONNECT). as:json parses the body; as:text strips tags. 10-50x faster than a browser for static/SSR pages & APIs.',
    input: { properties: { url: { type: 'string' }, method: { type: 'string' }, headers: { type: 'object' }, body: { type: 'string' }, proxy: { type: 'string' }, as: { type: 'string', enum: ['raw', 'json', 'text'] }, maxBytes: { type: 'number' } }, required: ['url'] },
    run: async (a) => {
      const r = await httpEngine.httpFetch(a.url, { method: a.method || 'GET', headers: a.headers, body: a.body, proxy: a.proxy, maxBytes: a.maxBytes });
      if (a.as === 'json') { try { return { json: { status: r.status, url: r.url, data: JSON.parse(r.body) } }; } catch (e) { return { json: { status: r.status, url: r.url, error: 'not JSON: ' + e.message, body: r.body.slice(0, 500) } }; } }
      if (a.as === 'text') { const txt = r.body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); return { json: { status: r.status, url: r.url, contentType: r.contentType, text: txt.slice(0, 20000) } }; }
      return { json: { status: r.status, url: r.url, contentType: r.contentType, redirects: r.redirects, bytes: r.body.length, headers: r.headers, body: r.body.length > 20000 ? r.body.slice(0, 20000) + '…[truncated]' : r.body } };
    },
  },
  {
    name: 'permission', group: 'actions',
    description: 'Grant browser permissions (e.g. geolocation, notifications, camera, microphone, clipboard) via CDP. reset:true clears grants.',
    input: { properties: { permissions: { type: 'array', items: { type: 'string' } }, reset: { type: 'boolean' } } },
    run: async (a, ctx) => {
      if (a.reset) { await primitives.resetPermissions(ctx.page); return { json: { reset: true } }; }
      await primitives.grantPermissions(ctx.page, a.permissions || []);
      return { json: { granted: a.permissions || [] } };
    },
  },
  {
    name: 'evalbatch', group: 'actions',
    description: 'Run several JS expressions in one round-trip; returns each result (or error) in order.',
    input: { properties: { url: { type: 'string' }, expressions: { type: 'array', items: { type: 'string' } } }, required: ['expressions'] },
    run: async (a, ctx) => { await ensureUrl(ctx.page, a); return { json: await primitives.evalBatch(ctx.page, a.expressions || []) }; },
  },

  // ── visual feedback + window control ──
  {
    name: 'feedback', group: 'browser',
    description: 'Inject a visual feedback overlay (cursor trail, click ripples, keystroke/toast) so a human watching a headful run can see what the agent is doing. off:true removes it.',
    input: { properties: { url: { type: 'string' }, off: { type: 'boolean' }, cursor: { type: 'boolean' }, ripples: { type: 'boolean' }, keystrokes: { type: 'boolean' }, toast: { type: 'boolean' }, glow: { type: 'boolean' } } },
    run: async (a, ctx) => {
      await ensureUrl(ctx.page, a);
      if (a.off) { await feedbackLib.removeFeedback(ctx.page); return { json: { feedback: 'off' } }; }
      await feedbackLib.injectFeedback(ctx.page, { cursor: a.cursor !== false, ripples: a.ripples !== false, keystrokes: !!a.keystrokes, toast: a.toast !== false, glow: a.glow !== false });
      return { json: { feedback: 'on' } };
    },
  },
  {
    name: 'window', group: 'browser', primary: 'state',
    description: 'Control the real browser window (state: normal|minimized|maximized|fullscreen|offscreen), or set left/top/width/height. Headful only.',
    input: { properties: { state: { type: 'string' }, left: { type: 'number' }, top: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } } },
    run: async (a, ctx) => { return { json: await hygiene.setWindow(ctx.page, ctx.page && ctx.page._c, { state: a.state, left: a.left, top: a.top, width: a.width, height: a.height }) }; },
  },

  // ── CAPTCHA (detect; solving is opt-in) + video understanding ──
  {
    name: 'captcha', group: 'browser', primary: 'action',
    description: 'CAPTCHA/bot-wall handling (action: detect|solve). detect is read-only; solve is OPT-IN (env LOGICA_PILOT_CAPTCHA=1 + solver key) and otherwise recommends the `handoff` tool for a human. Supports reCAPTCHA/hCaptcha/Turnstile.',
    input: { properties: { url: { type: 'string' }, action: { type: 'string', enum: ['detect', 'solve'] } } },
    run: async (a, ctx) => {
      await ensureUrl(ctx.page, a);
      if (a.action === 'solve') return { json: await captchaLib.solve(ctx.page, {}) };
      return { json: await captchaLib.detect(ctx.page) };
    },
  },
  {
    name: 'video', group: 'perception', primary: 'url',
    description: 'Token-first video understanding: extract sources/duration/platform, fetch caption tracks into a transcript, optionally sample keyframes (frames:N) and LLM-summarize (describe:true).',
    input: { properties: { url: { type: 'string' }, describe: { type: 'boolean' }, frames: { type: 'number' }, index: { type: 'number' } } },
    run: async (a, ctx) => { await ensureUrl(ctx.page, a); const r = await video.analyze(ctx.page, { describe: a.describe, model: ctx.model, frames: a.frames, index: a.index }); if (r) delete r._frameData; return { json: r }; },
  },

  // ── proxy pools + cookie/CF persistence ──
  {
    name: 'proxypool', group: 'network', primary: 'action', pageless: true,
    description: 'Named proxy pools with rotation (action: list|pick|add|remove|presets). pick returns a proxy string for --proxy on navigate/gather/crawl. Strategies: round-robin|sticky|random; sticky keyed by --session.',
    input: { properties: { action: { type: 'string', enum: ['list', 'pick', 'add', 'remove', 'presets'] }, name: { type: 'string' }, proxies: { type: 'array', items: { type: 'string' } }, strategy: { type: 'string' }, geo: { type: 'string' }, session: { type: 'string' } } },
    run: async (a) => {
      if (a.action === 'presets') return { json: proxyPool.PRESETS };
      if (a.action === 'list' || !a.action) return { json: proxyPool.list() };
      if (a.action === 'add') return { json: proxyPool.add(a.name, a.proxies, { strategy: a.strategy, geo: a.geo }) };
      if (a.action === 'remove') return { json: proxyPool.remove(a.name) };
      if (a.action === 'pick') { const p = proxyPool.pick(a.name, { session: a.session, strategy: a.strategy, geo: a.geo }); return { json: p ? { proxy: p } : { error: 'pool empty or not found' } }; }
      return { json: { error: 'unknown action' } };
    },
  },
  {
    name: 'persist', group: 'session', primary: 'action',
    description: 'Domain-keyed cookie persistence tuned for Cloudflare clearance (action: save|load|list|clear). save/load apply to the current domain unless --domain is given; load BEFORE navigating so cf_clearance carries over.',
    input: { properties: { url: { type: 'string' }, action: { type: 'string', enum: ['save', 'load', 'list', 'clear'] }, domain: { type: 'string' } } },
    run: async (a, ctx) => {
      if (a.action === 'list') return { json: persist.list() };
      if (a.action === 'clear') return { json: persist.clear(a.domain) };
      if (a.action === 'load') { const r = await persist.load(ctx.page, a.domain); await ensureUrl(ctx.page, a); return { json: r }; }
      await ensureUrl(ctx.page, a);
      return { json: await persist.save(ctx.page, a.domain) };
    },
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));
function get(name) { return byName.get(name); }

module.exports = { TOOLS, get };
