'use strict';

/**
 * llm.js — O cérebro do Logica Pilot (API Messages, compatível Anthropic).
 *
 * Resolução de destino (out-of-the-box para quem instala sem o LogicaOS):
 *   1. URL explícita (env/config) — sempre ganha.
 *   2. Chave Anthropic do usuário (sk-ant-…, vinda das Configurações) → bate
 *      DIRETO na api.anthropic.com.
 *   3. Senão → LogicaProxy local (:8317) com a chave interna (modo dev/LogicaOS).
 * Se o primário for o LogicaProxy e ele estiver morto, e houver chave do usuário,
 * faz FALLBACK automático para a Anthropic. Sem nada disponível, erro com dica.
 *
 * Envs: LOGICA_PILOT_LLM_URL · LOGICA_PILOT_MODEL · ANTHROPIC_API_KEY · LOGICA_PILOT_KEY
 */

const DEFAULT_URL =
  process.env.LOGICA_PILOT_LLM_URL ||
  process.env.LOGICAPROXY_URL ||
  'http://127.0.0.1:8317/v1/messages';
const DEFAULT_MODEL = process.env.LOGICA_PILOT_MODEL || 'claude-sonnet-4-6';
const DEFAULT_KEY =
  process.env.LOGICA_PILOT_KEY ||
  process.env.LOGICAPROXY_API_KEY ||
  'logicaos-internal';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Config injetada em runtime pelo processo principal (lê das settings do usuário).
const runtime = { key: null, url: null, model: null };
function configure(opts = {}) {
  if ('apiKey' in opts) runtime.key = (opts.apiKey || '').trim() || null;
  if ('url' in opts) runtime.url = (opts.url || '').trim() || null;
  if ('model' in opts) runtime.model = (opts.model || '').trim() || null;
}
function userKey() {
  const k = runtime.key || process.env.ANTHROPIC_API_KEY || '';
  return /^sk-ant-/.test(k) ? k : null;
}

/** Destino primário (URL + chave) conforme as regras acima. */
function resolveTarget() {
  if (runtime.url) return { url: runtime.url, key: runtime.key || DEFAULT_KEY, anthropic: false };
  const uk = userKey();
  if (uk) return { url: ANTHROPIC_URL, key: uk, anthropic: true };
  return { url: DEFAULT_URL, key: DEFAULT_KEY, anthropic: false };
}

/** True se há QUALQUER forma de chamar o modelo (proxy provável OU chave do usuário). */
function isConfigured() {
  return !!(userKey() || runtime.url || DEFAULT_URL);
}

async function callClaude({ system, messages, tools, model, maxTokens = 1024, temperature = 0 }) {
  const body = {
    model: model || runtime.model || DEFAULT_MODEL,
    max_tokens: maxTokens,
    temperature,
    system,
    messages,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = { type: 'auto' };
  }

  const primary = resolveTarget();
  // Fallback: primário = LogicaProxy local morto + usuário tem chave → Anthropic.
  const uk = userKey();
  const fallback = (!primary.anthropic && uk) ? { url: ANTHROPIC_URL, key: uk, anthropic: true } : null;

  const hit = (target) =>
    fetch(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': target.key,
      },
      body: JSON.stringify(body),
    });

  let res = null;
  let lastErr = null;
  try {
    res = await hit(primary);
  } catch (e) {
    lastErr = e;
    if (fallback) { try { res = await hit(fallback); } catch (e2) { lastErr = e2; } }
  }

  if (!res) {
    const hint = (!primary.anthropic && !uk)
      ? ' Sem LogicaProxy local: cole sua chave da Anthropic (sk-ant-…) em Configurações → Pilot pra usar a IA.'
      : '';
    throw new Error(`Falha ao contatar o cérebro (${primary.url}): ${lastErr && lastErr.message}.${hint}`);
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

module.exports = { callClaude, firstToolUse, textOf, configure, isConfigured, DEFAULT_MODEL, DEFAULT_URL };
