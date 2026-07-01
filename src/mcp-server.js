'use strict';

/**
 * mcp-server.js — Servidor MCP (stdio · JSON-RPC 2.0) do Logica Pilot.
 *
 * Expõe o motor CDP como tools TOKEN-FIRST pra qualquer agente (Claude Desktop,
 * Cursor, Cline…). O diferencial vs Playwright+LLM: em vez de mandar HTML cru ou
 * screenshot inteiro pro modelo, entrega PERCEPÇÃO COMPACTA (mapa indexado
 * `[0] button "Comprar"`) e age POR ÍNDICE — 10–100× menos tokens. Multi-agent
 * embutido (browser_fanout). Zero dependência: protocolo implementado à mão.
 *
 * Rodar:  node bin/logica-pilot.js mcp
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

// ── browser único (headless por padrão), criado sob demanda ──
let pilot = null;
async function P() {
  if (!pilot) {
    pilot = await new LogicaPilot({ headless: !process.env.LOGICA_PILOT_HEADFUL }).launch();
  }
  return pilot;
}
const watchLast = new Map(); // url → { hash, at }
let pending = 0; // tool calls em andamento (p/ não sair no meio)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function hash(s) { let h = 5381; s = String(s || ''); for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h >>> 0; }

// ── definição das tools (schemas expostos no tools/list) ──────────────────────
const TOOLS = [
  {
    name: 'browser_navigate',
    description: 'Navega para uma URL e retorna o MAPA INDEXADO da página (elementos interativos + texto legível). Barato em tokens: use isto no lugar de baixar o HTML.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL de destino' } }, required: ['url'] },
  },
  {
    name: 'browser_observe',
    description: 'Retorna o MAPA INDEXADO da página atual (elementos interativos `[n] tipo "rótulo"` + texto). É a percepção compacta que substitui HTML/screenshot.',
    inputSchema: { type: 'object', properties: { maxElements: { type: 'number', description: 'máx. de elementos (default 120)' } } },
  },
  {
    name: 'browser_act',
    description: 'Age na página por ÍNDICE (do browser_observe), sem seletor frágil. action: click | type | press | scroll.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'type', 'press', 'scroll'] },
        index: { type: 'number', description: 'índice [n] do elemento (click/type)' },
        text: { type: 'string', description: 'texto a digitar (type)' },
        submit: { type: 'boolean', description: 'dar Enter após digitar (type)' },
        key: { type: 'string', description: 'tecla (press): Enter, Tab, Escape, ArrowDown…' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'sentido (scroll)' },
        amount: { type: 'number', description: 'px a rolar (scroll)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_extract',
    description: 'Extrai dados da página. Com `schema`/`instruction` retorna JSON estruturado (via IA, compacto); com `query` (seletor CSS) retorna o texto dos matches.',
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'o que extrair (linguagem natural)' },
        schema: { type: 'object', description: 'formato JSON esperado' },
        query: { type: 'string', description: 'seletor CSS (alternativa determinística)' },
      },
    },
  },
  {
    name: 'browser_read',
    description: 'Retorna o conteúdo LEGÍVEL da página (texto limpo, sem nav/ads). Com summarize:true, resume via IA. Leitura barata.',
    inputSchema: { type: 'object', properties: { summarize: { type: 'boolean' } } },
  },
  {
    name: 'browser_run',
    description: 'Executa um OBJETIVO multi-passo de forma autônoma na página atual (o agente observa→age em loop). Use pra tarefas inteiras ("busque X e me diga Y").',
    inputSchema: { type: 'object', properties: { goal: { type: 'string' }, maxSteps: { type: 'number' } }, required: ['goal'] },
  },
  {
    name: 'browser_fanout',
    description: 'MULTI-AGENT: roda a mesma tarefa em VÁRIAS URLs em paralelo (páginas headless próprias) e opcionalmente SINTETIZA tudo. Base de Deep Research / Compare / Best Deal.',
    inputSchema: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: 'URLs a processar em paralelo' },
        task: { type: 'string', description: 'o que fazer/extrair em cada uma' },
        mode: { type: 'string', enum: ['extract', 'read', 'run'], description: 'default extract' },
        schema: { type: 'object', description: 'formato JSON esperado (mode extract)' },
        synthesize: { type: 'string', description: 'se setado, sintetiza tudo nessa instrução' },
        concurrency: { type: 'number', description: 'páginas simultâneas (default 4, máx 8)' },
      },
      required: ['urls', 'task'],
    },
  },
  {
    name: 'browser_watch',
    description: 'Checa uma URL e diz se MUDOU desde a última checagem (diff de conteúdo). Base de monitores (preço/estoque/vaga).',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'browser_session',
    description: 'Gerencia sessões de login (cookies). action: save | load | list. Loga UMA vez, reusa depois.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['save', 'load', 'list'] }, name: { type: 'string' } },
      required: ['action'],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Captura a tela (fallback visual quando a a11y não basta). Com marks:true desenha os índices na página antes. Retorna imagem.',
    inputSchema: { type: 'object', properties: { fullPage: { type: 'boolean' }, marks: { type: 'boolean' } } },
  },
];

// ── implementação das tools ───────────────────────────────────────────────────
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
      default: throw new Error('action inválida: ' + a.action);
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
        system: 'Você resume o conteúdo de uma página web de forma objetiva.',
        messages: [{ role: 'user', content: 'Resuma:\n\n' + text.slice(0, 8000) }], maxTokens: 700,
      });
      text = llm.textOf(resp);
    }
    return { text: text || '(sem texto)' };
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
    throw new Error('session action inválida: ' + act);
  }

  if (name === 'browser_screenshot') {
    const p = await P();
    if (a.marks) { try { await perception.mark(p.page); } catch {} }
    const b64 = await actions.screenshot(p.page, { format: 'jpeg', quality: 65, fullPage: !!a.fullPage });
    if (a.marks) { try { await perception.unmark(p.page); } catch {} }
    return { image: b64, mimeType: 'image/jpeg' };
  }

  throw new Error('tool desconhecida: ' + name);
}

// ── transporte: JSON-RPC 2.0 sobre stdio (mensagens 1 por linha) ──────────────
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
      log('tool', nm, 'erro:', (e && e.message) || e);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERRO: ' + ((e && e.message) || e) }], isError: true } });
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
      Promise.resolve(handle(msg)).catch((e) => log('handle erro:', (e && e.message) || e));
    }
  });
  process.stdin.on('end', () => {
    // drena as tool calls em andamento antes de fechar (não corta no meio)
    const tryExit = async () => {
      if (pending > 0) { setTimeout(tryExit, 200); return; }
      try { if (pilot) await pilot.close(); } catch {}
      process.exit(0);
    };
    tryExit();
  });
  process.on('SIGINT', async () => { try { if (pilot) await pilot.close(); } catch {} process.exit(0); });
  log(`${NAME} v${VERSION} — MCP server pronto (10 tools). stdin/stdout.`);
}

module.exports = { start, TOOLS, callTool };

if (require.main === module) start();
