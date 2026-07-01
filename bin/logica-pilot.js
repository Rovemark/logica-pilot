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

// ── fanout: multi-agent (N URLs em paralelo) ─────────────────────────────────
async function cmdFanout(args) {
  const { fanout } = require('../src/fanout');
  const urls = String(args.urls || args._[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const task = args.task || args._[2];
  if (!urls.length || !task) {
    console.error(`${C.red}Uso:${C.reset} logica-pilot fanout --urls a.com,b.com --task "extraia X" [--synthesize "compare"] [--mode extract|read|run] [--json]`);
    process.exit(1);
  }
  banner();
  console.log(`${C.cyan}◎ fanout${C.reset} ${urls.length} URLs · ${C.dim}${task}${C.reset}\n`);
  const r = await fanout({
    urls, task, mode: args.mode || 'extract', synthesize: args.synthesize,
    concurrency: args.concurrency ? parseInt(args.concurrency, 10) : 4, model: args.model,
    onEvent: (ev) => {
      if (ev.type === 'done') console.log(`  ${ev.ok ? C.green + '✓' : C.red + '✗'}${C.reset} ${C.dim}${ev.url}${C.reset}`);
      if (ev.type === 'synthesize') console.log(`  ${C.mag}∴ sintetizando…${C.reset}`);
    },
  });
  if (args.json) { console.log(JSON.stringify(r, null, 2)); }
  else {
    console.log(`\n${C.green}✓${C.reset} ${r.ok}/${r.count} ok`);
    if (r.synthesis) console.log(`\n${C.bold}Síntese:${C.reset}\n${r.synthesis}`);
    else r.results.forEach((x, i) => console.log(('\n[' + i + '] ' + x.url + '\n' + JSON.stringify(x.data || x.text || x.result || x.error)).slice(0, 600)));
  }
  process.exit(0);
}

// ── read: conteúdo legível de uma URL (opcional --summarize) ─────────────────
async function cmdRead(args) {
  const url = args._[1] || args.url;
  if (!url) { console.error(`${C.red}Uso:${C.reset} logica-pilot read <url> [--summarize]`); process.exit(1); }
  const pilot = new LogicaPilot({ headless: true });
  await pilot.launch();
  try {
    await pilot.goto(url);
    const snap = await pilot.snapshot({ maxEls: 0 });
    let text = String(snap.text || '').trim();
    if (args.summarize) {
      const llm = require('../src/llm');
      const resp = await llm.callClaude({ system: 'Resuma a página de forma objetiva, em tópicos.', messages: [{ role: 'user', content: 'Resuma:\n\n' + text.slice(0, 8000) }], maxTokens: 700 });
      text = llm.textOf(resp);
    }
    console.log(text || '(sem texto)');
  } finally { await pilot.close(); }
  process.exit(0);
}

// ── extract: dados estruturados (JSON) de uma URL ────────────────────────────
async function cmdExtract(args) {
  const url = args._[1] || args.url;
  const instruction = args.task || args.instruction || args._[2];
  if (!url) { console.error(`${C.red}Uso:${C.reset} logica-pilot extract <url> --task "o que extrair"`); process.exit(1); }
  const pilot = new LogicaPilot({ headless: true });
  await pilot.launch();
  try {
    await pilot.goto(url);
    const snap = await pilot.snapshot({ maxEls: 60 });
    const perception = require('../src/perception');
    const { extractStructured } = require('../src/fanout');
    const data = await extractStructured({ text: perception.format(snap), instruction });
    console.log(JSON.stringify(data, null, 2));
  } finally { await pilot.close(); }
  process.exit(0);
}

// ── search: URLs de resultado ────────────────────────────────────────────────
async function cmdSearch(args) {
  const q = args._[1] || args.q;
  if (!q) { console.error(`${C.red}Uso:${C.reset} logica-pilot search "<consulta>" [--limit N]`); process.exit(1); }
  const { search } = require('../src/search');
  const r = await search(q, { limit: args.limit ? parseInt(args.limit, 10) : 8 });
  if (args.json) console.log(JSON.stringify(r, null, 2));
  else r.forEach((x, i) => console.log(`${i + 1}. ${x.url}  ${C.dim}${(x.title || '').slice(0, 70)}${C.reset}`));
  process.exit(0);
}

// ── receitas multi-agent: research / compare / deal / factcheck ──────────────
async function cmdRecipe(name, args) {
  const recipes = require('../src/recipes');
  const onEvent = (ev) => {
    if (ev.type === 'done') console.log(`  ${ev.ok ? C.green + '✓' : C.red + '✗'}${C.reset} ${C.dim}${ev.url}${C.reset}`);
    if (ev.type === 'synthesize') console.log(`  ${C.mag}∴ sintetizando…${C.reset}`);
  };
  banner();
  let r;
  if (name === 'compare') {
    const urls = String(args.urls || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!urls.length) { console.error(`${C.red}Uso:${C.reset} logica-pilot compare --urls a.com,b.com [--task "..."]`); process.exit(1); }
    console.log(`${C.cyan}◎ compare${C.reset} ${urls.length} itens\n`);
    r = await recipes.compare(urls, { task: args.task, model: args.model, onEvent });
  } else {
    const q = args._[1] || args.q;
    if (!q) { console.error(`${C.red}Uso:${C.reset} logica-pilot ${name} "<consulta>"`); process.exit(1); }
    console.log(`${C.cyan}◎ ${name}${C.reset} ${C.dim}${q}${C.reset}\n`);
    r = await recipes[name](q, { limit: args.limit ? parseInt(args.limit, 10) : undefined, model: args.model, onEvent });
  }
  if (args.json) console.log(JSON.stringify(r, null, 2));
  else console.log(`\n${C.bold}Resultado:${C.reset}\n${r.synthesis || JSON.stringify(r.results, null, 2)}`);
  process.exit(0);
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
      case 'mcp':
      case 'serve': return require('../src/mcp-server').start();
      case 'fanout': return await cmdFanout(args);
      case 'read': return await cmdRead(args);
      case 'extract': return await cmdExtract(args);
      case 'search': return await cmdSearch(args);
      case 'research': return await cmdRecipe('research', args);
      case 'compare': return await cmdRecipe('compare', args);
      case 'deal': return await cmdRecipe('deal', args);
      case 'factcheck': return await cmdRecipe('factcheck', args);
      case 'version':
      case '--version':
      case '-v':
        return console.log('logica-pilot ' + require('../package.json').version);
      default:
        banner();
        console.log(`
${C.bold}Comandos:${C.reset}
  ${C.cyan}mcp${C.reset}                servidor MCP (stdio) — pilota o browser via Claude/Cursor, token-first
  ${C.cyan}run${C.reset} "<objetivo>"   loop autônomo (a IA navega sozinha)
                     flags: --url --headful --vision --model --max-steps --json
  ${C.cyan}fanout${C.reset}             multi-agent: N URLs em paralelo + síntese
                     --urls a,b,c --task "..." [--synthesize "..."] [--mode extract|read|run]
  ${C.cyan}research${C.reset} "<?>"     🧠 pesquisa + lê fontes em paralelo + relatório citado
  ${C.cyan}compare${C.reset} --urls…   🧠 tabela comparativa + recomendação
  ${C.cyan}deal${C.reset} "<produto>"  🧠 acha lojas + rankeia por valor real
  ${C.cyan}factcheck${C.reset} "<?>"    🧠 veredito sobre uma afirmação, com citações
  ${C.cyan}search${C.reset} "<?>"       URLs de resultado (Bing/Brave)
  ${C.cyan}extract${C.reset} <url>      dados estruturados (JSON) de uma página  --task "..."
  ${C.cyan}read${C.reset} <url>         conteúdo legível da página              [--summarize]
  ${C.cyan}open${C.reset} <url>         abre e imprime o mapa indexado (observe)
  ${C.cyan}browser${C.reset}            abre o BROWSER Electron (janela Chromium real)
  ${C.cyan}version${C.reset}

${C.dim}Substituto parrudo do Playwright · CDP puro · token-first · 0 dep · IA via chave própria ou LogicaProxy${C.reset}
`);
    }
  } catch (e) {
    console.error(`${C.red}✗${C.reset} ${e.message}`);
    if (process.env.LOGICA_PILOT_DEBUG) console.error(e.stack);
    process.exit(1);
  }
}

main();
