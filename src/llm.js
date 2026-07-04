'use strict';

/**
 * llm.js — The brain of Logica Pilot (Messages API, Anthropic-compatible).
 *
 * Target resolution (out-of-the-box for those installing without LogicaOS):
 *   1. Explicit URL (env/config) — always wins.
 *   2. User's Anthropic key (sk-ant-…, from Settings) → hits
 *      DIRECTLY on api.anthropic.com.
 *   3. Otherwise → local LogicaProxy (:8317) with internal key (dev/LogicaOS mode).
 * If primary is LogicaProxy and it's down, and user has a key,
 * automatically FALLBACK to Anthropic. With nothing available, error with hint.
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

// Config injected at runtime by main process (reads from user settings).
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

/** Primary target (URL + key) according to rules above. */
function resolveTarget() {
  if (runtime.url) return { url: runtime.url, key: runtime.key || DEFAULT_KEY, anthropic: false };
  const uk = userKey();
  if (uk) return { url: ANTHROPIC_URL, key: uk, anthropic: true };
  return { url: DEFAULT_URL, key: DEFAULT_KEY, anthropic: false };
}

/** True if there is ANY way to call the model (proxy likely OR user key). */
function isConfigured() {
  return !!(userKey() || runtime.url || DEFAULT_URL);
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 529]);
const REQUEST_TIMEOUT_MS = 120000;
const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) => Math.min(15000, 750 * 2 ** (attempt - 1)); // 750ms, 1.5s, …

async function callClaude({ system, messages, tools, model, maxTokens = 1024, temperature } = {}) {
  const body = {
    model: model || runtime.model || DEFAULT_MODEL,
    max_tokens: maxTokens,
    system,
    messages,
  };
  // Omit `temperature` unless explicitly requested: the newer model families
  // (Fable 5 / Opus 4.8 / Sonnet 5 …) reject any sampling param with a 400, and
  // it changes nothing for a forced tool-choice loop. Default = don't send it.
  if (temperature !== undefined && temperature !== null) body.temperature = temperature;
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = { type: 'auto' };
  }
  const payload = JSON.stringify(body);

  const primary = resolveTarget();
  // Fallback: primary = local LogicaProxy unreachable/5xx + user has key → Anthropic.
  const uk = userKey();
  const fallback = (!primary.anthropic && uk) ? { url: ANTHROPIC_URL, key: uk, anthropic: true } : null;
  const targets = fallback ? [primary, fallback] : [primary];

  const hit = async (target) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS); // a hung proxy must not block the run forever
    try {
      return await fetch(target.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': target.key,
        },
        body: payload,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let lastErr = null;
  let lastBad = null; // { status, text } from the most recent retryable HTTP failure
  for (const target of targets) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res;
      try {
        res = await hit(target);
      } catch (e) {
        lastErr = e; lastBad = null; // network error / timeout → retry, then next target
        if (attempt < MAX_ATTEMPTS) { await sleep(backoff(attempt)); continue; }
        break;
      }
      if (res.ok) return res.json();

      const status = res.status;
      const text = await res.text().catch(() => '');
      // 4xx (bad request / auth): our fault, not the endpoint's — don't retry, don't fall back.
      if (!RETRY_STATUS.has(status)) throw new Error(`LLM ${status}: ${text.slice(0, 400)}`);

      lastBad = { status, text }; lastErr = null;
      if (attempt < MAX_ATTEMPTS) {
        const ra = parseInt(res.headers.get('retry-after') || '', 10);
        await sleep(Number.isFinite(ra) ? Math.min(ra * 1000, 15000) : backoff(attempt));
        continue;
      }
      break; // retryable but exhausted on this target → try the fallback target
    }
  }

  if (lastBad) throw new Error(`LLM ${lastBad.status}: ${lastBad.text.slice(0, 400)}`);
  const hint = (!primary.anthropic && !uk)
    ? ' Without local LogicaProxy: paste your Anthropic key (sk-ant-…) in Settings → Pilot to use AI.'
    : '';
  throw new Error(`Failed to contact the brain (${primary.url}): ${lastErr && lastErr.message}.${hint}`);
}

/** Extracts first tool_use block from a response. */
function firstToolUse(resp) {
  if (!resp || !Array.isArray(resp.content)) return null;
  return resp.content.find((b) => b.type === 'tool_use') || null;
}

/** Concatenates text blocks from a response. */
function textOf(resp) {
  if (!resp || !Array.isArray(resp.content)) return '';
  return resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

module.exports = { callClaude, firstToolUse, textOf, configure, isConfigured, DEFAULT_MODEL, DEFAULT_URL };
