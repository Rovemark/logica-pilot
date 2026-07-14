#!/usr/bin/env node
'use strict';

/**
 * Logica Pilot CLI.
 *
 * The commands are generated from the shared tool registry (src/tools.js), so the
 * CLI and the MCP server expose exactly the same capabilities. Special commands:
 *   logica-pilot mcp                 # start the MCP server (stdio)
 *   logica-pilot browser [--url U]   # open the Electron browser (real window)
 *   logica-pilot version
 * Every registry tool is also a command, e.g.:
 *   logica-pilot navigate <url> · observe --url U · act --url U --action click --index 0
 *   logica-pilot research "<question>" · deal "<product>" · fanout --urls a,b --task "..."
 */

const path = require('path');
const { spawn } = require('child_process');
const { LogicaPilot } = require('../src/index');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', mag: '\x1b[35m',
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function banner() {
  console.log(`${C.mag}${C.bold}  ◢ Logica Pilot${C.reset} ${C.dim}— AI-native browser · token-first automation${C.reset}`);
}

// Generic dispatch of ANY registry tool → keeps the CLI identical to the MCP server.
async function cmdTool(tool, args) {
  const a = {};
  for (const k of Object.keys(args)) if (k !== '_') a[k] = args[k];
  if (tool.primary && args._[1] !== undefined && a[tool.primary] === undefined) a[tool.primary] = args._[1];
  if (typeof a.urls === 'string') a.urls = a.urls.split(',').map((s) => s.trim()).filter(Boolean);
  for (const k of ['schema', 'fields', 'includePaths', 'excludePaths', 'notify', 'rows', 'location']) if (typeof a[k] === 'string') { try { a[k] = JSON.parse(a[k]); } catch {} }
  for (const k of ['index', 'maxSteps', 'limit', 'amount', 'maxElements', 'timeout', 'concurrency', 'maxChars', 'offset', 'textChars', 'maxDepth']) {
    if (typeof a[k] === 'string') a[k] = parseInt(a[k], 10);
  }

  banner();
  const onEvent = (ev) => {
    if (ev.type === 'done') console.log(`  ${ev.ok ? C.green + '✓' : C.red + '✗'}${C.reset} ${C.dim}${ev.url}${C.reset}`);
    if (ev.type === 'synthesize') console.log(`  ${C.mag}∴ synthesizing…${C.reset}`);
  };
  const ctx = { model: args.model, watchLast: new Map(), onEvent };
  let pilot = null;
  try {
    if (!tool.pageless) { pilot = new LogicaPilot({ headless: !args.headful }); await pilot.launch(); ctx.page = pilot.page; ctx.pilot = pilot; }
    printOut(await tool.run(a, ctx), !!args.json);
  } finally {
    if (pilot) { try { await pilot.close(); } catch {} }
  }
  process.exit(0);
}

function printOut(out, asJson) {
  if (out && out.image) { console.log(`${C.dim}[image ${out.mimeType || ''} · base64 ${String(out.image).length} chars]${C.reset}`); return; }
  // Pretty-print only for a human at a TTY; piped/Bash-consumed output goes compact
  // (a downstream agent reading via `| ...` doesn't need the indentation whitespace).
  const ind = process.stdout.isTTY ? 2 : 0;
  if (out && out.json !== undefined) { console.log(JSON.stringify(out.json, null, ind)); return; }
  const text = out && typeof out === 'object' && 'text' in out ? out.text : out;
  console.log(typeof text === 'string' ? text : JSON.stringify(text, null, ind));
}

function buildHelp() {
  const { TOOLS } = require('../src/tools');
  const groups = {};
  for (const t of TOOLS) { (groups[t.group] = groups[t.group] || []).push(t); }
  let s = `\n${C.bold}Logica Pilot${C.reset} — CLI ${C.dim}(same tools as the MCP server)${C.reset}\n\n${C.bold}special:${C.reset}\n`;
  s += `  ${C.cyan}mcp${C.reset}        start the MCP server (stdio)\n  ${C.cyan}browser${C.reset}    open the Electron browser (real window)\n  ${C.cyan}version${C.reset}\n`;
  for (const g of Object.keys(groups)) {
    s += `\n${C.bold}${g}:${C.reset}\n`;
    for (const t of groups[g]) {
      const arg = t.primary ? ` ${C.dim}<${t.primary}>${C.reset}` : (t.pageless ? '' : ` ${C.dim}[--url U]${C.reset}`);
      s += `  ${C.cyan}${t.name.padEnd(10)}${C.reset}${arg}\n`;
    }
  }
  s += `\n${C.dim}Heavyweight Playwright alternative · pure CDP · token-first · 0 deps · AI via your own key${C.reset}\n`;
  return s;
}

function cmdBrowser(args) {
  // launches the Electron app (real window)
  const appMain = path.resolve(__dirname, '../app/main.js');
  let electronBin;
  try {
    electronBin = require('electron');
  } catch {
    console.error(`${C.red}Electron not installed.${C.reset} Run: ${C.bold}npm install${C.reset} inside "Logica Pilot/".`);
    process.exit(1);
  }
  // ELECTRON_RUN_AS_NODE=1 in the environment makes the binary run as pure Node
  // (without app APIs). We clear it so it launches as a browser.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBin, [appMain, ...(args.url ? ['--url', args.url] : [])], { stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code || 0));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  try {
    if (cmd === 'browser' || cmd === 'ui') return cmdBrowser(args);
    if (cmd === 'mcp' || cmd === 'serve') return require('../src/mcp-server').start();
    if (cmd === 'monitor-daemon') { banner(); return require('../src/monitor').runDaemon({ tickMs: args.tick ? parseInt(args.tick, 10) : 30000 }); }
    if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
      return console.log('logica-pilot ' + require('../package.json').version);
    }
    if (cmd === 'open' || cmd === 'snapshot') { // aliases for observe
      return await cmdTool(require('../src/tools').get('observe'), args);
    }
    const tool = require('../src/tools').get(cmd);
    if (tool) return await cmdTool(tool, args);
    banner();
    console.log(buildHelp());
  } catch (e) {
    console.error(`${C.red}✗${C.reset} ${e.message}`);
    if (process.env.LOGICA_PILOT_DEBUG) console.error(e.stack);
    process.exit(1);
  }
}

main();
