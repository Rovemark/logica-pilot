'use strict';

/**
 * mcp-server.js — Logica Pilot MCP server (stdio · JSON-RPC 2.0).
 *
 * Thin adapter: the tools come from the SHARED registry (src/tools.js), the same
 * source the CLI uses — so MCP and CLI are always identical. Exposes the browser
 * engine as TOKEN-FIRST tools for any agent (Claude Desktop, Cursor, Cline…):
 * compact indexed perception instead of raw HTML/screenshots, actions by index,
 * built-in multi-agent. Zero dependency: protocol implemented by hand.
 *
 * Run:  node bin/logica-pilot.js mcp
 * Config: { "mcpServers": { "logica-pilot": { "command": "logica-pilot", "args": ["mcp"] } } }
 */

const { LogicaPilot } = require('./index');
const { TOOLS, get } = require('./tools');
const adapters = require('./adapters');

const NAME = 'logica-pilot';
let VERSION = '0.1.0';
try { VERSION = require('../package.json').version; } catch {}

// single browser instance (headless by default), created on demand
let pilot = null;
async function P() {
  if (!pilot) {
    // LOGICA_PILOT_ATTACH=<port> drives an already-running browser (real profile).
    const attach = process.env.LOGICA_PILOT_ATTACH;
    pilot = await new LogicaPilot(attach ? { attach: parseInt(attach, 10) || 9222 } : { headless: !process.env.LOGICA_PILOT_HEADFUL }).launch();
  }
  return pilot;
}
const watchLast = new Map();
let pending = 0;

// MCP tools are the registry tools prefixed with `browser_`
function toMcpSchema(input) {
  const s = { type: 'object', properties: (input && input.properties) || {} };
  if (input && input.required) s.required = input.required;
  return s;
}
const MCP_TOOLS = TOOLS.map((t) => ({ name: 'browser_' + t.name, description: t.description, inputSchema: toMcpSchema(t.input) }));

// Built-in tools + the user's saved Site Adapters (recomputed each list so newly
// saved adapters show up without a restart). Adapter tools are named x_<name>.
function listTools() {
  return MCP_TOOLS.concat(adapters.toolDescriptors().map((a) => ({ name: a.name, description: a.description, inputSchema: a.inputSchema })));
}

async function callTool(mcpName, args) {
  // Dynamic Site Adapter (x_<name>): fill the goal and drive the agent.
  if (/^x_/.test(String(mcpName))) {
    const ad = adapters.get(String(mcpName).replace(/^x_/, ''));
    if (!ad) throw new Error('unknown adapter: ' + mcpName);
    const runTool = get('adapter');
    const p = await P();
    return runTool.run({ action: 'run', name: ad.name, params: args || {} }, { model: undefined, page: p.page, pilot: p });
  }
  const tool = get(String(mcpName).replace(/^browser_/, ''));
  if (!tool) throw new Error('unknown tool: ' + mcpName);
  const ctx = { model: undefined, watchLast };
  if (!tool.pageless) { const p = await P(); ctx.page = p.page; ctx.pilot = p; }
  return tool.run(args || {}, ctx);
}

// ── transport: JSON-RPC 2.0 over stdio (one message per line) ─────────────────
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function log(...m) { process.stderr.write('[mcp] ' + m.join(' ') + '\n'); }

function resultContent(out) {
  if (out && out.image) return { content: [{ type: 'image', data: out.image, mimeType: out.mimeType || 'image/jpeg' }] };
  // Compact JSON: the consumer is another model/agent, not a human — pretty-printing
  // burns ~17% of every payload on indentation whitespace for zero information.
  if (out && out.json !== undefined) return { content: [{ type: 'text', text: JSON.stringify(out.json) }] };
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
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: listTools() } });
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
    } finally { pending--; }
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
    const tryExit = async () => {
      if (pending > 0) { setTimeout(tryExit, 200); return; }
      try { if (pilot) await pilot.close(); } catch {}
      process.exit(0);
    };
    tryExit();
  });
  process.on('SIGINT', async () => { try { if (pilot) await pilot.close(); } catch {} process.exit(0); });
  log(`${NAME} v${VERSION} — MCP server ready (${MCP_TOOLS.length} tools). stdin/stdout.`);
}

module.exports = { start, MCP_TOOLS, callTool };

if (require.main === module) start();
