'use strict';

/**
 * rest-server.js — HTTP API surface (`logica-pilot serve`). Makes the whole tool
 * registry callable over HTTP, so Logica Pilot works as a drop-in for
 * ScrapingBee/ScraperAPI and as the backend for any integration (n8n/Zapier/
 * LangChain) or agent that speaks HTTP instead of MCP.
 *
 * Endpoints:
 *   GET  /                         ScrapingBee-shaped: ?url=...&render_js=&markdown=&
 *                                  screenshot=&extract=&wait=&proxy=&block=  -> scrape
 *   GET  /health                   { ok, tools, uptime }
 *   GET  /v1/tools                 list every tool (name, group, description, input)
 *   POST /v1/tools/:name           run any tool; JSON body = args -> tool result
 *   POST /v1/actors/:name/runs     run a saved adapter/workflow with {input}
 *   GET  /v1/datasets/:name/items  ?offset&limit&format=json|csv
 *   GET  /v1/key-value-stores/:store/records/:key
 *
 * Auth: x-api-key header or ?token= must match LOGICA_PILOT_API_KEY when set. When no
 * key is configured the server binds to loopback only (dev). Zero-dependency (http).
 */

const http = require('http');
const { URL } = require('url');
const { TOOLS, get } = require('./tools');
const dataset = require('./dataset');
const kvs = require('./kvs');

let _pilot = null;
async function sharedBrowser() {
  if (_pilot && _pilot.browser) return _pilot;
  const { LogicaPilot } = require('./index');
  _pilot = new LogicaPilot({ headless: true });
  await _pilot.launch();
  return _pilot;
}

// Run a registry tool with a fresh page per request (isolation on one browser).
async function runTool(name, args, { model } = {}) {
  const tool = get(name);
  if (!tool) return { error: `unknown tool: ${name}`, status: 404 };
  const ctx = { model };
  let page = null;
  try {
    if (!tool.pageless) {
      const pilot = await sharedBrowser();
      page = await pilot.browser.newPage();
      ctx.page = page; ctx.pilot = pilot;
    }
    const out = await tool.run(args || {}, ctx);
    return { out };
  } catch (e) {
    return { error: e.message, status: 500 };
  } finally {
    if (page) { try { await page.close(); } catch {} }
  }
}

function send(res, status, body, contentType) {
  const payload = Buffer.isBuffer(body) ? body : (contentType && contentType !== 'application/json' ? String(body) : JSON.stringify(body));
  res.writeHead(status, { 'content-type': contentType || 'application/json', 'access-control-allow-origin': '*' });
  res.end(payload);
}

function toolResult(res, out, format) {
  if (out && out.image) return send(res, 200, Buffer.from(out.image, 'base64'), out.mimeType || 'image/png');
  if (out && out.json !== undefined) return send(res, 200, format === 'text' ? JSON.stringify(out.json) : out.json, 'application/json');
  const text = out && typeof out === 'object' && 'text' in out ? out.text : out;
  if (format === 'json') return send(res, 200, { text }, 'application/json');
  return send(res, 200, typeof text === 'string' ? text : JSON.stringify(text), 'text/plain; charset=utf-8');
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// Map ScrapingBee-style query params to the right tool + args.
function scrapeArgsFromQuery(q) {
  const truthy = (v) => v === '' || v === 'true' || v === '1' || v === 'yes';
  const url = q.get('url');
  const renderJs = q.has('render_js') ? truthy(q.get('render_js')) : true; // default: browser
  const common = { url, engine: renderJs ? 'browser' : 'http', proxy: q.get('proxy') || undefined };
  if (q.get('wait')) common.timeout = Number(q.get('wait'));
  if (truthy(q.get('screenshot'))) return { tool: 'screenshot', args: { ...common, fullPage: truthy(q.get('full_page')) } };
  if (q.get('extract')) return { tool: 'extract', args: { ...common, instruction: q.get('extract') } };
  if (q.get('extract_rules')) { let schema; try { schema = JSON.parse(q.get('extract_rules')); } catch {} return { tool: 'extract', args: { ...common, schema } }; }
  const markdown = truthy(q.get('markdown')) || truthy(q.get('md'));
  return { tool: 'read', args: { ...common, markdown } };
}

function makeServer({ apiKey, model } = {}) {
  const started = Date.now();
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-api-key', 'access-control-allow-methods': 'GET,POST,OPTIONS' }); return res.end(); }
      const u = new URL(req.url, 'http://localhost');
      const q = u.searchParams;

      if (u.pathname === '/health') return send(res, 200, { ok: true, tools: TOOLS.length, uptimeMs: Date.now() - started });

      // Auth (skip /health). Key from header or ?token=.
      if (apiKey) {
        const given = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || q.get('token');
        if (given !== apiKey) return send(res, 401, { error: 'unauthorized: missing/invalid api key' });
      }

      // GET / — ScrapingBee-shaped scrape
      if (req.method === 'GET' && u.pathname === '/') {
        if (!q.get('url')) return send(res, 400, { error: 'pass ?url=... (and optional render_js, markdown, screenshot, extract, wait, proxy)' });
        const { tool, args } = scrapeArgsFromQuery(q);
        const r = await runTool(tool, args, { model });
        if (r.error) return send(res, r.status || 500, { error: r.error });
        return toolResult(res, r.out, q.get('format'));
      }

      // GET /v1/tools
      if (req.method === 'GET' && u.pathname === '/v1/tools') {
        return send(res, 200, TOOLS.map((t) => ({ name: t.name, group: t.group, description: t.description, input: t.input || {}, pageless: !!t.pageless })));
      }

      // POST /v1/tools/:name
      let m;
      if (req.method === 'POST' && (m = u.pathname.match(/^\/v1\/tools\/([a-z0-9_-]+)$/i))) {
        const args = await readBody(req);
        const r = await runTool(m[1], args, { model });
        if (r.error) return send(res, r.status || 500, { error: r.error });
        return toolResult(res, r.out, q.get('format') || 'json');
      }

      // POST /v1/actors/:name/runs  → run saved adapter/workflow
      if (req.method === 'POST' && (m = u.pathname.match(/^\/v1\/actors\/([a-z0-9_-]+)\/runs$/i))) {
        const body = await readBody(req);
        const r = await runTool('adapter', { action: 'run', name: m[1], params: body.input || body.params || {} }, { model });
        if (r.error) return send(res, r.status || 500, { error: r.error });
        return toolResult(res, r.out, 'json');
      }

      // GET /v1/datasets/:name/items
      if (req.method === 'GET' && (m = u.pathname.match(/^\/v1\/datasets\/([^/]+)\/items$/))) {
        const items = dataset.items ? dataset.items(decodeURIComponent(m[1])) : (dataset.get ? dataset.get(decodeURIComponent(m[1])) : null);
        if (!items) return send(res, 404, { error: 'dataset not found' });
        const rows = Array.isArray(items) ? items : (items.rows ? Object.values(items.rows) : []);
        const offset = Number(q.get('offset')) || 0;
        const limit = q.get('limit') ? Number(q.get('limit')) : rows.length;
        return send(res, 200, rows.slice(offset, offset + limit));
      }

      // GET /v1/key-value-stores/:store/records/:key
      if (req.method === 'GET' && (m = u.pathname.match(/^\/v1\/key-value-stores\/([^/]+)\/records\/(.+)$/))) {
        const v = kvs.getValue(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (v == null) return send(res, 404, { error: 'record not found' });
        if (v && typeof v === 'object' && typeof v.base64 === 'string') return send(res, 200, Buffer.from(v.base64, 'base64'), v.contentType);
        return typeof v === 'string' ? send(res, 200, v, 'text/plain; charset=utf-8') : send(res, 200, v);
      }

      return send(res, 404, { error: 'not found', hint: 'GET /?url= · GET /v1/tools · POST /v1/tools/:name · GET /v1/datasets/:name/items · GET /health' });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  });
}

/** Start the server. Binds loopback unless an api key is set (then 0.0.0.0). */
function serve({ port = 8080, apiKey = process.env.LOGICA_PILOT_API_KEY || null, host, model } = {}) {
  const server = makeServer({ apiKey, model });
  const bind = host || (apiKey ? '0.0.0.0' : '127.0.0.1');
  return new Promise((resolve) => {
    server.listen(port, bind, () => resolve({ server, port, host: bind, authenticated: !!apiKey }));
  });
}

module.exports = { serve, makeServer, runTool };
