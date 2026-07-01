'use strict';

/**
 * mcp-server.js — Logica Pilot MCP server (stdio · JSON-RPC 2.0).
 *
 * Exposes the browser engine as TOKEN-FIRST tools for any agent (Claude Desktop,
 * Cursor, Cline…). The advantage over Playwright+LLM: instead of sending raw HTML or
 * full screenshots to the model, it delivers COMPACT PERCEPTION (indexed map
 * `[0] button "Buy"`), and acts BY INDEX — 10–100× fewer tokens. Multi-agent
 * built-in (browser_fanout). Zero dependency: protocol implemented by hand.
 *
 * Run:  node bin/logica-pilot.js mcp
 * Config (Claude Desktop / Cursor):
 *   { "mcpServers": { "logica-pilot": { "command": "logica-pilot", "args": ["mcp"] } } }
 */

const { LogicaPilot } = require('./index');
const perception = require('./perception');
const actions = require('./actions');
const agent = require('./agent');
const llm = require('./llm');
const { fanout } = require('./fanout');
const session = require('./session-store');

const NAME = 'logica-pilot';
let VERSION = '0.1.0';
try { VERSION = require('../package.json').version; } catch {}

// ── single browser instance (headless by default), created on demand ──
let pilot = null;
async function P() {
  if (!pilot) {
    pilot = await new LogicaPilot({ headless: !process.env.LOGICA_PILOT_HEADFUL }).launch();
  }
  return pilot;
}
const watchLast = new Map(); // url → { hash, at }
let pending = 0; // tool calls in progress (to not exit mid-call)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function hash(s) { let h = 5381; s = String(s || ''); for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h >>> 0; }

// ── tool definitions (schemas exposed in tools/list) ──────────────────────
const TOOLS = [
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL and return the INDEXED MAP of the page (interactive elements + readable text). Cheap in tokens: use this instead of downloading HTML.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Target URL' } }, required: ['url'] },
  },
  {
    name: 'browser_observe',
    description: 'Return the INDEXED MAP of the current page (interactive elements `[n] type "label"` + text). This is the compact perception that replaces HTML/screenshot.',
    inputSchema: { type: 'object', properties: { maxElements: { type: 'number', description: 'max elements (default 120)' } } },
  },
  {
    name: 'browser_act',
    description: 'Act on the page BY INDEX (from browser_observe), without fragile selectors. action: click | type | press | scroll.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'type', 'press', 'scroll'] },
        index: { type: 'number', description: 'index [n] of element (click/type)' },
        text: { type: 'string', description: 'text to type (type)' },
        submit: { type: 'boolean', description: 'press Enter after typing (type)' },
        key: { type: 'string', description: 'key (press): Enter, Tab, Escape, ArrowDown…' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'direction (scroll)' },
        amount: { type: 'number', description: 'pixels to scroll (scroll)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_extract',
    description: 'Extract data from the page. With `schema`/`instruction` returns structured JSON (via AI, compact); with `query` (CSS selector) returns text of matches.',
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'what to extract (natural language)' },
        schema: { type: 'object', description: 'expected JSON format' },
        query: { type: 'string', description: 'CSS selector (deterministic alternative)' },
      },
    },
  },
  {
    name: 'browser_read',
    description: 'Return the READABLE content of the page (clean text, without nav/ads). With summarize:true, summarize via AI. Cheap read.',
    inputSchema: { type: 'object', properties: { summarize: { type: 'boolean' } } },
  },
  {
    name: 'browser_run',
    description: 'Execute a multi-step OBJECTIVE autonomously on the current page (agent observes→acts in a loop). Use for complete tasks ("search X and tell me Y").',
    inputSchema: { type: 'object', properties: { goal: { type: 'string' }, maxSteps: { type: 'number' } }, required: ['goal'] },
  },
  {
    name: 'browser_fanout',
    description: 'MULTI-AGENT: run the same task on MULTIPLE URLs in parallel (separate headless pages) and optionally SYNTHESIZE everything. Base for Deep Research / Compare / Best Deal.',
    inputSchema: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: 'URLs to process in parallel' },
        task: { type: 'string', description: 'what to do/extract from each' },
        mode: { type: 'string', enum: ['extract', 'read', 'run'], description: 'default extract' },
        schema: { type: 'object', description: 'expected JSON format (mode extract)' },
        synthesize: { type: 'string', description: 'if set, synthesize everything in this instruction' },
        concurrency: { type: 'number', description: 'simultaneous pages (default 4, max 8)' },
      },
      required: ['urls', 'task'],
    },
  },
  {
    name: 'browser_search',
    description: 'Search the web and return result URLs (title + url). Use to find sources before fanout/research.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
  },
  {
    name: 'browser_research',
    description: '🧠 Deep Research: research the question, read sources IN PARALLEL (multi-agent) and synthesize an answer with citations [n].',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
  },
  {
    name: 'browser_deal',
    description: '🧠 Best Deal: find product stores, extract price + shipping in parallel and rank by REAL VALUE.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, limit: { type: 'number' } }, required: ['product'] },
  },
  {
    name: 'browser_factcheck',
    description: '🧠 Fact-Check: search independent sources about the claim and give a VERDICT with citations.',
    inputSchema: { type: 'object', properties: { claim: { type: 'string' }, limit: { type: 'number' } }, required: ['claim'] },
  },
  {
    name: 'browser_watch',
    description: 'Check a URL and say if it CHANGED since last check (content diff). Base for monitors (price/stock/opening).',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'browser_session',
    description: 'Manage login sessions (cookies). action: save | load | list. Log in ONCE, reuse after.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['save', 'load', 'list'] }, name: { type: 'string' } },
      required: ['action'],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture the screen (fallback visual when accessibility alone is not enough). With marks:true draw the indices on the page first. Returns image.',
    inputSchema: { type: 'object', properties: { fullPage: { type: 'boolean' }, marks: { type: 'boolean' } } },
  },
];

// ── tool implementations ───────────────────────────────────────────────────
async function callTool(name, a = {}) {
  if (name === 'browser_navigate') {
    const p = await P();
    await p.goto(a.url);
    const snap = await p.snapshot({ maxEls: 120 });
    return { text: perception.format(snap) };
  }

  if (name === 'browser_observe') {
    const p = await P();
    const snap = await p.snapshot({ maxEls: a.maxElements || 120 });
    return { text: perception.format(snap) };
  }

  if (name === 'browser_act') {
    const p = await P();
    const page = p.page;
    let res;
    switch (a.action) {
      case 'click': res = await actions.click(page, a.index); break;
      case 'type': res = await actions.type(page, a.index, a.text || '', !!a.submit); break;
      case 'press': res = await actions.pressKey(page, a.key || 'Enter'); break;
      case 'scroll': res = await actions.scroll(page, a.direction || 'down', a.amount || 600); break;
      default: throw new Error('Invalid action: ' + a.action);
    }
    await sleep(250);
    const snap = await p.snapshot({ maxEls: 80 });
    return { text: res + '\n\n' + perception.format(snap) };
  }

  if (name === 'browser_extract') {
    const p = await P();
    if (a.instruction || a.schema) {
      const snap = await p.snapshot({ maxEls: 60 });
      const { extractStructured } = require('./fanout');
      const data = await extractStructured({ text: perception.format(snap), instruction: a.instruction, schema: a.schema });
      return { json: data };
    }
    const out = await actions.extract(p.page, a.query || '');
    return { text: out };
  }

  if (name === 'browser_read') {
    const p = await P();
    const snap = await p.snapshot({ maxEls: 0 });
    let text = String(snap.text || '').trim();
    if (a.summarize && text) {
      const resp = await llm.callClaude({
        system: 'You summarize web page content objectively.',
        messages: [{ role: 'user', content: 'Summarize:\n\n' + text.slice(0, 8000) }], maxTokens: 700,
      });
      text = llm.textOf(resp);
    }
    return { text: text || '(no text)' };
  }

  if (name === 'browser_run') {
    const p = await P();
    const r = await p.run(a.goal, { maxSteps: a.maxSteps || 12 });
    return { text: typeof r === 'string' ? r : (r && (r.result || r.summary)) || JSON.stringify(r) };
  }

  if (name === 'browser_fanout') {
    const r = await fanout({ urls: a.urls, task: a.task, mode: a.mode || 'extract', schema: a.schema, synthesize: a.synthesize, concurrency: a.concurrency });
    return { json: { count: r.count, ok: r.ok, synthesis: r.synthesis, results: r.results } };
  }

  if (name === 'browser_watch') {
    const p = await P();
    await p.goto(a.url);
    const snap = await p.snapshot({ maxEls: 0 });
    const h = hash(snap.text);
    const prev = watchLast.get(a.url);
    watchLast.set(a.url, { hash: h, at: Date.now() });
    const changed = prev ? prev.hash !== h : null;
    return { json: { url: a.url, changed, firstCheck: !prev, title: snap.title, textPreview: String(snap.text || '').slice(0, 500) } };
  }

  if (name === 'browser_session') {
    const act = a.action;
    if (act === 'list') return { json: { sessions: session.list() } };
    const p = await P();
    if (act === 'save') return { json: await session.save(p.page, a.name) };
    if (act === 'load') return { json: await session.load(p.page, a.name) };
    throw new Error('Invalid session action: ' + act);
  }

  if (name === 'browser_screenshot') {
    const p = await P();
    if (a.marks) { try { await perception.mark(p.page); } catch {} }
    const b64 = await actions.screenshot(p.page, { format: 'jpeg', quality: 65, fullPage: !!a.fullPage });
    if (a.marks) { try { await perception.unmark(p.page); } catch {} }
    return { image: b64, mimeType: 'image/jpeg' };
  }

  if (name === 'browser_search') {
    const { search } = require('./search');
    return { json: await search(a.query, { limit: a.limit }) };
  }
  if (name === 'browser_research') {
    const { research } = require('./recipes');
    const r = await research(a.query, { limit: a.limit });
    return { text: r.synthesis || JSON.stringify(r.results, null, 2) };
  }
  if (name === 'browser_deal') {
    const { deal } = require('./recipes');
    const r = await deal(a.product, { limit: a.limit });
    return { text: r.synthesis || JSON.stringify(r.results, null, 2) };
  }
  if (name === 'browser_factcheck') {
    const { factcheck } = require('./recipes');
    const r = await factcheck(a.claim, { limit: a.limit });
    return { text: r.synthesis || JSON.stringify(r.results, null, 2) };
  }

  throw new Error('Unknown tool: ' + name);
}

// ── transport: JSON-RPC 2.0 over stdio (one message per line) ──────────────
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function log(...m) { process.stderr.write('[mcp] ' + m.join(' ') + '\n'); }

function resultContent(out) {
  if (out && out.image) return { content: [{ type: 'image', data: out.image, mimeType: out.mimeType || 'image/jpeg' }] };
  if (out && out.json !== undefined) return { content: [{ type: 'text', text: JSON.stringify(out.json, null, 2) }] };
  const text = out && typeof out === 'object' && 'text' in out ? out.text : (typeof out === 'string' ? out : JSON.stringify(out));
  return { content: [{ type: 'text', text: String(text) }] };
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: NAME, version: VERSION } } });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const nm = params && params.name;
    const args = (params && params.arguments) || {};
    pending++;
    try {
      const out = await callTool(nm, args);
      return send({ jsonrpc: '2.0', id, result: resultContent(out) });
    } catch (e) {
      log('tool', nm, 'error:', (e && e.message) || e);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR: ' + ((e && e.message) || e) }], isError: true } });
    } finally {
      pending--;
    }
  }
  if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
}

function start() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      Promise.resolve(handle(msg)).catch((e) => log('handle error:', (e && e.message) || e));
    }
  });
  process.stdin.on('end', () => {
    // drain in-progress tool calls before exit (no mid-call cutoff)
    const tryExit = async () => {
      if (pending > 0) { setTimeout(tryExit, 200); return; }
      try { if (pilot) await pilot.close(); } catch {}
      process.exit(0);
    };
    tryExit();
  });
  process.on('SIGINT', async () => { try { if (pilot) await pilot.close(); } catch {} process.exit(0); });
  log(`${NAME} v${VERSION} — MCP server ready (10 tools). stdin/stdout.`);
}

module.exports = { start, TOOLS, callTool };

if (require.main === module) start();
