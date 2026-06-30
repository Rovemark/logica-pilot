'use strict';

/**
 * agent.js — O loop autônomo do Logica Pilot.
 *
 * Dado um OBJETIVO em linguagem natural, o agente:
 *   1. percebe a página (mapa indexado + visão opcional)
 *   2. pede ao Claude a PRÓXIMA ação (function calling)
 *   3. executa a ação
 *   4. repete até `done` ou esgotar os passos
 *
 * Agnóstico de transporte: recebe uma `page` (pipe ou Electron). O mesmo loop
 * roda no motor headless e dentro do browser Electron.
 */

const perception = require('./perception');
const actions = require('./actions');
const llm = require('./llm');

const SYSTEM_PROMPT = `Você é o Logica Pilot — um agente autônomo que controla um browser real de verdade.

Você recebe, a cada passo, o estado da página: uma lista de ELEMENTOS INTERATIVOS indexados ([0], [1], ...) e o texto visível. Quando útil, também recebe um SCREENSHOT com os mesmos índices desenhados como etiquetas coloridas.

Seu trabalho: cumprir o OBJETIVO do usuário agindo UMA ação por vez, usando as ferramentas.

REGRAS:
- Aja por intenção usando o ÍNDICE do elemento — nunca invente índices que não estão na lista.
- Se o alvo não está visível, use "scroll" para procurá-lo antes de desistir.
- Para buscar/pesquisar: use "type" no campo certo com submit=true (manda Enter).
- Depois de navegar/clicar, a próxima leitura da página já reflete o resultado — observe antes de agir de novo.
- Não repita a mesma ação que claramente não funcionou; tente outra abordagem.
- Quando o OBJETIVO estiver cumprido, chame "done" com success=true e um "result" claro e completo (a resposta final pro usuário, em PT-BR).
- Se ficar genuinamente travado (paywall, login obrigatório, captcha, loop), chame "done" com success=false explicando o porquê.
- Seja eficiente: o mínimo de passos para o resultado.`;

const TOOLS = [
  {
    name: 'navigate',
    description: 'Navega o browser para uma URL.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL completa (https://...)' },
        reason: { type: 'string', description: 'Por que (curto).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'click',
    description: 'Clica no elemento interativo pelo índice [n].',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: 'Índice do elemento na lista.' },
        reason: { type: 'string' },
      },
      required: ['index'],
    },
  },
  {
    name: 'type',
    description: 'Digita texto num campo pelo índice [n]. submit=true envia (Enter).',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'integer' },
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'Apertar Enter depois.' },
        reason: { type: 'string' },
      },
      required: ['index', 'text'],
    },
  },
  {
    name: 'press',
    description: 'Pressiona uma tecla (Enter, Tab, Escape, ArrowDown, PageDown, ...).',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string' }, reason: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'scroll',
    description: 'Rola a página.',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['down', 'up'] },
        amount: { type: 'integer', description: 'pixels (default 600)' },
        reason: { type: 'string' },
      },
      required: ['direction'],
    },
  },
  {
    name: 'extract',
    description: 'Extrai texto/dados da página (opcional: um seletor CSS).',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' }, reason: { type: 'string' } },
    },
  },
  {
    name: 'wait',
    description: 'Espera alguns milissegundos (para conteúdo carregar).',
    input_schema: {
      type: 'object',
      properties: { ms: { type: 'integer' }, reason: { type: 'string' } },
    },
  },
  {
    name: 'done',
    description: 'Encerra: objetivo cumprido (ou impossível). Retorne o resultado final.',
    input_schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        result: { type: 'string', description: 'Resposta/resultado final em PT-BR.' },
      },
      required: ['success', 'result'],
    },
  },
];

/** Remove imagens de todas as mensagens de usuário menos a última (economia de tokens). */
function trimImages(history) {
  let lastUser = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') { lastUser = i; break; }
  }
  return history.map((m, i) => {
    if (m.role === 'user' && Array.isArray(m.content) && i !== lastUser) {
      return {
        role: 'user',
        content: m.content.map((b) =>
          b.type === 'image' ? { type: 'text', text: '[screenshot anterior omitido]' } : b,
        ),
      };
    }
    return m;
  });
}

async function execAction(page, name, input) {
  switch (name) {
    case 'navigate': return actions.navigate(page, input.url);
    case 'click': return actions.click(page, input.index);
    case 'type': return actions.type(page, input.index, input.text, !!input.submit);
    case 'press': return actions.pressKey(page, input.key);
    case 'scroll': return actions.scroll(page, input.direction, input.amount || 600);
    case 'extract': return actions.extract(page, input.query);
    case 'wait': return actions.wait(page, input.ms || 1000);
    default: return `ação desconhecida: ${name}`;
  }
}

/**
 * Roda o loop autônomo.
 * @param {object} page  página agnóstica de transporte
 * @param {string} objective
 * @param {object} opts  { maxSteps, vision, model, startUrl, onStep }
 * @returns {Promise<{success:boolean, result:string, steps:number, trace:Array}>}
 */
async function run(page, objective, opts = {}) {
  const maxSteps = opts.maxSteps || 25;
  const visionMode = !!opts.vision;
  const model = opts.model;
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : () => {};

  if (opts.startUrl) {
    await actions.navigate(page, opts.startUrl);
  }

  const history = [];
  const trace = [];
  let pendingToolResult = null;

  for (let step = 1; step <= maxSteps; step++) {
    if (typeof opts.shouldStop === 'function' && opts.shouldStop()) {
      return { success: false, result: 'Interrompido pelo usuário.', steps: step - 1, trace };
    }
    const snap = await perception.snapshot(page);
    const useVision = visionMode || snap.elements.length === 0;

    const content = [];
    if (pendingToolResult) content.push(pendingToolResult);

    const header =
      step === 1
        ? `OBJETIVO: ${objective}\n\n--- PASSO 1/${maxSteps} ---\n`
        : `--- PASSO ${step}/${maxSteps} ---\n`;
    content.push({ type: 'text', text: header + perception.format(snap) });

    if (useVision) {
      await perception.mark(page);
      let shot = null;
      try { shot = await actions.screenshot(page); } catch {}
      await perception.unmark(page);
      if (shot) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: shot },
        });
      }
    }

    history.push({ role: 'user', content });

    let resp;
    try {
      resp = await llm.callClaude({
        system: SYSTEM_PROMPT,
        messages: trimImages(history),
        tools: TOOLS,
        model,
        maxTokens: 1024,
      });
    } catch (e) {
      onStep({ step, action: 'error', input: {}, result: e.message });
      return { success: false, result: `Erro do cérebro: ${e.message}`, steps: step, trace };
    }

    history.push({ role: 'assistant', content: resp.content });
    const tool = llm.firstToolUse(resp);

    if (!tool) {
      // sem ação → trata o texto como resposta final
      const txt = llm.textOf(resp) || '(sem resposta)';
      onStep({ step, action: 'done', input: { success: true }, result: txt });
      return { success: true, result: txt, steps: step, trace };
    }

    if (tool.name === 'done') {
      onStep({ step, action: 'done', input: tool.input, result: tool.input.result });
      trace.push({ step, action: 'done', input: tool.input });
      return {
        success: tool.input.success !== false,
        result: tool.input.result || '',
        steps: step,
        trace,
      };
    }

    let result;
    try {
      result = await execAction(page, tool.name, tool.input);
    } catch (e) {
      result = `ERRO: ${e.message}`;
    }

    onStep({ step, action: tool.name, input: tool.input, result });
    trace.push({ step, action: tool.name, input: tool.input, result });

    pendingToolResult = {
      type: 'tool_result',
      tool_use_id: tool.id,
      content: String(result).slice(0, 2000),
    };
  }

  return {
    success: false,
    result: `Limite de ${maxSteps} passos atingido sem concluir o objetivo.`,
    steps: maxSteps,
    trace,
  };
}

module.exports = { run, TOOLS, SYSTEM_PROMPT };
