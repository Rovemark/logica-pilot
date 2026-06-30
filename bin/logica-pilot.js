#!/usr/bin/env node
'use strict';

/**
 * CLI do Logica Pilot.
 *
 *   logica-pilot run "<objetivo>" [--url U] [--headful] [--vision] [--model M] [--max-steps N] [--json]
 *   logica-pilot open <url>          # abre, imprime o mapa da página e sai
 *   logica-pilot snapshot <url>      # idem (alias)
 *   logica-pilot browser             # abre o BROWSER Electron (janela real)
 *   logica-pilot version
 */

const path = require('path');
const { spawn } = require('child_process');
const { LogicaPilot, resolveBrowserBinary } = require('../src/index');

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
  console.log(`${C.mag}${C.bold}  ◢ Logica Pilot${C.reset} ${C.dim}— browser AI-nativo do LogicaOS${C.reset}`);
}

async function cmdOpen(url) {
  banner();
  const bin = resolveBrowserBinary();
  console.log(`${C.dim}  browser:${C.reset} ${bin || '(nenhum encontrado!)'}`);
  const pilot = new LogicaPilot({ headless: true });
  await pilot.launch();
  try {
    await pilot.goto(url);
    const snap = await pilot.snapshot();
    console.log('\n' + pilot.format(snap) + '\n');
    console.log(`${C.green}✓${C.reset} ${snap.elements.length} elementos interativos mapeados.`);
  } finally {
    await pilot.close();
  }
}

async function cmdRun(args) {
  const objective = args._[1];
  if (!objective) {
    console.error(`${C.red}Uso:${C.reset} logica-pilot run "<objetivo>" [--url U] [--headful] [--vision]`);
    process.exit(1);
  }
  banner();
  console.log(`${C.cyan}◎ Objetivo:${C.reset} ${objective}\n`);

  const pilot = new LogicaPilot({ headless: !args.headful });
  await pilot.launch();

  let result;
  try {
    result = await pilot.run(objective, {
      vision: !!args.vision,
      model: args.model,
      maxSteps: args['max-steps'] ? parseInt(args['max-steps'], 10) : 25,
      startUrl: args.url,
      onStep: ({ step, action, input, result }) => {
        const icon = action === 'done' ? '🏁' : '→';
        const detail =
          action === 'navigate' ? input.url
            : action === 'click' ? `[${input.index}]`
            : action === 'type' ? `[${input.index}] "${input.text}"${input.submit ? ' ⏎' : ''}`
            : action === 'scroll' ? `${input.direction} ${input.amount || 600}px`
            : action === 'press' ? input.key
            : '';
        console.log(`${C.dim}${String(step).padStart(2)}${C.reset} ${icon} ${C.bold}${action}${C.reset} ${C.dim}${detail}${C.reset}`);
        if (result && action !== 'done') console.log(`     ${C.dim}${String(result).slice(0, 100)}${C.reset}`);
      },
    });
  } finally {
    await pilot.close();
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const tag = result.success ? `${C.green}✓ concluído${C.reset}` : `${C.yellow}⚠ não concluído${C.reset}`;
    console.log(`\n${tag} ${C.dim}(${result.steps} passos)${C.reset}\n`);
    console.log(result.result);
  }
  process.exit(result.success ? 0 : 2);
}

function cmdBrowser(args) {
  // sobe o app Electron (janela real)
  const appMain = path.resolve(__dirname, '../app/main.js');
  let electronBin;
  try {
    electronBin = require('electron');
  } catch {
    console.error(`${C.red}Electron não instalado.${C.reset} Rode: ${C.bold}npm install${C.reset} dentro de "Logica Pilot/".`);
    process.exit(1);
  }
  // ELECTRON_RUN_AS_NODE=1 no ambiente faz o binário rodar como Node puro
  // (sem as APIs de app). Limpamos pra garantir que sobe como browser.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBin, [appMain, ...(args.url ? ['--url', args.url] : [])], {
    stdio: 'inherit',
    env,
  });
  child.on('exit', (code) => process.exit(code || 0));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  try {
    switch (cmd) {
      case 'run': return await cmdRun(args);
      case 'open':
      case 'snapshot': {
        const url = args._[1] || args.url;
        if (!url) { console.error('Informe a URL.'); process.exit(1); }
        return await cmdOpen(url);
      }
      case 'browser':
      case 'ui': return cmdBrowser(args);
      case 'version':
      case '--version':
      case '-v':
        return console.log('logica-pilot ' + require('../package.json').version);
      default:
        banner();
        console.log(`
${C.bold}Comandos:${C.reset}
  ${C.cyan}run${C.reset} "<objetivo>"   loop autônomo (a IA navega sozinha)
                     flags: --url --headful --vision --model --max-steps --json
  ${C.cyan}open${C.reset} <url>         abre e imprime o mapa indexado da página
  ${C.cyan}browser${C.reset}            abre o BROWSER Electron (janela Chromium real)
  ${C.cyan}version${C.reset}

${C.dim}Cérebro via LogicaProxy :8317 · motor CDP puro · 0 dep de Playwright${C.reset}
`);
    }
  } catch (e) {
    console.error(`${C.red}✗${C.reset} ${e.message}`);
    if (process.env.LOGICA_PILOT_DEBUG) console.error(e.stack);
    process.exit(1);
  }
}

main();
