'use strict';

/**
 * llm.js — O cérebro do Logica Pilot.
 *
 * Fala a API Messages (compatível Anthropic) via LogicaProxy (:8317) por padrão,
 * então nenhuma chave fica exposta no código. Configurável por env:
 *   - LOGICA_PILOT_LLM_URL  (default http://127.0.0.1:8317/v1/messages)
 *   - LOGICA_PILOT_MODEL    (default claude-sonnet-4-6)
 *   - ANTHROPIC_API_KEY     (se for bater direto na Anthropic)
 */

const DEFAULT_URL =
  process.env.LOGICA_PILOT_LLM_URL ||
  process.env.LOGICAPROXY_URL ||
  'http://127.0.0.1:8317/v1/messages';
const DEFAULT_MODEL = process.env.LOGICA_PILOT_MODEL || 'claude-sonnet-4-6';
// LogicaProxy aceita a chave interna do LogicaOS por padrão.
const DEFAULT_KEY =
  process.env.LOGICA_PILOT_KEY ||
  process.env.LOGICAPROXY_API_KEY ||
  process.env.ANTHROPIC_API_KEY ||
  'logicaos-internal';

async function callClaude({ system, messages, tools, model, maxTokens = 1024, temperature = 0 }) {
  const url = DEFAULT_URL;
  const key = DEFAULT_KEY;

  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: maxTokens,
    temperature,
    system,
    messages,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = { type: 'auto' };
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': key,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`Falha ao contatar o cérebro (${url}): ${e.message}. O LogicaProxy está vivo?`);
  }

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`LLM ${res.status}: ${t.slice(0, 400)}`);
  }
  return res.json();
}

/** Extrai o primeiro bloco tool_use de uma resposta. */
function firstToolUse(resp) {
  if (!resp || !Array.isArray(resp.content)) return null;
  return resp.content.find((b) => b.type === 'tool_use') || null;
}

/** Concatena os blocos de texto de uma resposta. */
function textOf(resp) {
  if (!resp || !Array.isArray(resp.content)) return '';
  return resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

module.exports = { callClaude, firstToolUse, textOf, DEFAULT_MODEL, DEFAULT_URL };
