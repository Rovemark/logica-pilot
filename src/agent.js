'use strict';

/**
 * agent.js — The autonomous loop of Logica Pilot.
 *
 * Given an OBJECTIVE in natural language, the agent:
 *   1. perceives the page (indexed map + optional vision)
 *   2. asks Claude for the NEXT action (function calling)
 *   3. executes the action
 *   4. repeats until `done` or step limit is reached
 *
 * Transport-agnostic: receives a `page` (pipe or Electron). The same loop
 * runs in the headless engine and inside the Electron browser.
 */

const perception = require('./perception');
const actions = require('./actions');
const llm = require('./llm');

const SYSTEM_PROMPT = `You are Logica Pilot — an autonomous agent that controls a real browser engine.

You receive, at each step, the state of the page: a list of INTERACTIVE ELEMENTS indexed ([0], [1], ...) and visible text. When useful, you also receive a SCREENSHOT with the same indices drawn as colored labels.

Your job: fulfill the user's OBJECTIVE by taking ONE action at a time, using the tools.

In the element list, "[n]" is the index you act on; a "~" right after it means the element is below the fold; a final "citation refs:" line just lists footnote-style anchors ([1], [2], …) you can usually ignore.

RULES:
- Act by intent using the ELEMENT'S INDEX — never invent indices that aren't on the list.
- If the target is not visible, use "scroll" to search for it before giving up.
- To search/find: use "type" in the right field with submit=true (sends Enter).
- After navigating/clicking, the next page read already reflects the result — observe before acting again.
- Do not repeat the same action if it clearly didn't work; try a different approach.
- When the OBJECTIVE is fulfilled, call "done" with success=true and a clear, complete "result" (the final answer for the user, written in the SAME LANGUAGE the user wrote the OBJECTIVE in).
- If genuinely stuck (paywall, mandatory login, captcha, loop), call "done" with success=false explaining why.
- Be efficient: the minimum number of steps to the result.`;

const TOOLS = [
  {
    name: 'navigate',
    description: 'Navigate the browser to a URL.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL (https://...)' },
        reason: { type: 'string', description: 'Why (brief).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'click',
    description: 'Click an interactive element by index [n].',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: 'Element index in the list.' },
        reason: { type: 'string' },
      },
      required: ['index'],
    },
  },
  {
    name: 'type',
    description: 'Type text in a field by index [n]. submit=true sends (Enter).',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'integer' },
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'Press Enter afterward.' },
        reason: { type: 'string' },
      },
      required: ['index', 'text'],
    },
  },
  {
    name: 'press',
    description: 'Press a key (Enter, Tab, Escape, ArrowDown, PageDown, ...).',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string' }, reason: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page.',
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
    description: 'Extract text/data from the page (optional: a CSS selector).',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' }, reason: { type: 'string' } },
    },
  },
  {
    name: 'wait',
    description: 'Wait a few milliseconds (for content to load).',
    input_schema: {
      type: 'object',
      properties: { ms: { type: 'integer' }, reason: { type: 'string' } },
    },
  },
  {
    name: 'done',
    description: 'Finish: objective accomplished (or impossible). Return the final result.',
    input_schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        result: { type: 'string', description: 'The final result, in the SAME LANGUAGE as the objective.' },
      },
      required: ['success', 'result'],
    },
  },
];

const CACHE = { type: 'ephemeral' };

/**
 * Permanently drop screenshots from every user turn except the newest one.
 *
 * Mutates `history` IN PLACE so the conversation stays append-only: once a turn
 * stops being the newest, its bytes never change again. That stability is what
 * lets prompt caching read the whole prior prefix at ~0.1× instead of re-paying
 * full price for it every step. (Recomputing a stripped copy each call, the old
 * approach, produced a different object graph each step and defeated the cache.)
 */
function retireOldImages(history) {
  let lastUser = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') { lastUser = i; break; }
  }
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role !== 'user' || i === lastUser || !Array.isArray(m.content)) continue;
    let changed = false;
    m.content = m.content.map((b) => {
      if (b.type === 'image') { changed = true; return { type: 'text', text: '[previous screenshot omitted]' }; }
      return b;
    });
    void changed;
  }
  return history;
}

/**
 * Stub perception maps older than the last `keepLast` user turns.
 *
 * The agent re-sends the whole conversation each step, so without this the input
 * grows QUADRATICALLY: step k pays for k full page maps (~1.8K tokens each), even
 * though a map for a page we already left is dead weight — its element indices
 * are reassigned from 0 on every snapshot (perception.js), so acting on a stale
 * map would be a bug, and the system prompt already says the newest read wins.
 *
 * Non-mutating and DETERMINISTIC: a given old turn stubs to the exact same bytes
 * every step, so the cached prefix stays valid. Only the single map that leaves
 * the keep window each step changes — the one mutation point per step, which the
 * moving breakpoint sits after. The OBJECTIVE (and step header) are preserved.
 *
 * keepLast=1 (only the newest map full) measured cheapest live: keeping 2 forces
 * re-writing two full maps each step, and the cache-write premium (1.25×) makes
 * that dearer than the reads it saves. The prior action trace (assistant tool_use
 * + tool_result blocks) is kept intact, so loop-detection memory survives; the
 * older element lists are stale anyway (indices are reassigned every snapshot).
 */
function trimPerception(history, keepLast = 1) {
  const userIdx = [];
  for (let i = 0; i < history.length; i++) if (history[i].role === 'user') userIdx.push(i);
  const keep = new Set(userIdx.slice(-keepLast));
  return history.map((m, i) => {
    if (m.role !== 'user' || keep.has(i) || !Array.isArray(m.content)) return m;
    return {
      role: 'user',
      content: m.content.map((b) => {
        if (b.type !== 'text' || !b.text.includes('ELEMENTS (')) return b;
        const lines = b.text.split('\n');
        const stepIdx = lines.findIndex((l) => l.startsWith('--- STEP '));
        const urlLine = lines.find((l) => l.startsWith('URL:')) || '';
        const head = stepIdx >= 0 ? lines.slice(0, stepIdx + 1).join('\n') : (lines[0] || '');
        return { type: 'text', text: `${head}\n${urlLine}\n[page state superseded — see latest observation]` };
      }),
    };
  });
}

/**
 * Build the request `messages` with a single MOVING cache breakpoint on the last
 * content block of the last turn. Combined with the static breakpoint on
 * system+tools, this makes each step read the entire prior conversation from
 * cache and write only the newest turn. The marker is added on a shallow copy so
 * it never persists into `history` (stale markers would blow the 4-breakpoint
 * limit and shift bytes, breaking the very cache we want).
 */
function withMovingBreakpoint(history) {
  if (!history.length) return history;
  const last = history[history.length - 1];
  if (!Array.isArray(last.content) || !last.content.length) return history;
  const blocks = last.content.slice();
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: CACHE };
  return [...history.slice(0, -1), { ...last, content: blocks }];
}

/** Fold one response's usage into the running totals (for measuring savings). */
function addUsage(acc, u) {
  if (!u) return acc;
  acc.input += u.input_tokens || 0;
  acc.output += u.output_tokens || 0;
  acc.cacheRead += u.cache_read_input_tokens || 0;
  acc.cacheWrite += u.cache_creation_input_tokens || 0;
  return acc;
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
    default: return `unknown action: ${name}`;
  }
}

/**
 * Run the autonomous loop.
 * @param {object} page  transport-agnostic page
 * @param {string} objective
 * @param {object} opts  { maxSteps, vision, model, startUrl, onStep }
 * @returns {Promise<{success:boolean, result:string, steps:number, trace:Array}>}
 */
async function run(page, objective, opts = {}) {
  const maxSteps = opts.maxSteps || 25;
  const visionMode = !!opts.vision;
  const model = opts.model;
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : () => {};
  // Respond in the caller's language (the browser UI language) when provided;
  // otherwise the prompt already tells the model to mirror the objective's language.
  const systemText = opts.language
    ? `${SYSTEM_PROMPT}\n\nIMPORTANT: write the final "result" in ${opts.language}.`
    : SYSTEM_PROMPT;
  // System as a cached block: the breakpoint sits after `tools` in render order
  // (tools → system → messages), so ONE marker here caches the whole static
  // prefix (tools + system) and every step after the first reads it at ~0.1×.
  const system = [{ type: 'text', text: systemText, cache_control: CACHE }];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  if (opts.startUrl) {
    await actions.navigate(page, opts.startUrl);
  }

  const history = [];
  const trace = [];
  let pendingToolResult = null;

  for (let step = 1; step <= maxSteps; step++) {
    if (typeof opts.shouldStop === 'function' && opts.shouldStop()) {
      return { success: false, result: 'Stopped by user.', steps: step - 1, trace, usage };
    }
    const snap = await perception.snapshot(page);
    const useVision = visionMode || snap.elements.length === 0;

    const content = [];
    if (pendingToolResult) content.push(pendingToolResult);

    const header =
      step === 1
        ? `OBJECTIVE: ${objective}\n\n--- STEP 1/${maxSteps} ---\n`
        : `--- STEP ${step}/${maxSteps} ---\n`;
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
    retireOldImages(history);

    let resp;
    try {
      resp = await llm.callClaude({
        system,
        messages: withMovingBreakpoint(trimPerception(history)),
        tools: TOOLS,
        model,
        maxTokens: 1024,
      });
    } catch (e) {
      onStep({ step, action: 'error', input: {}, result: e.message });
      return { success: false, result: `Brain error: ${e.message}`, steps: step, trace, usage };
    }

    addUsage(usage, resp.usage);
    if (process.env.LOGICA_PILOT_USAGE) console.error(`[usage] step ${step}`, JSON.stringify(resp.usage));
    history.push({ role: 'assistant', content: resp.content });
    const tool = llm.firstToolUse(resp);

    if (!tool) {
      // No action → treat text as final response
      const txt = llm.textOf(resp) || '(no response)';
      onStep({ step, action: 'done', input: { success: true }, result: txt });
      return { success: true, result: txt, steps: step, trace, usage };
    }

    if (tool.name === 'done') {
      onStep({ step, action: 'done', input: tool.input, result: tool.input.result });
      trace.push({ step, action: 'done', input: tool.input });
      return {
        success: tool.input.success !== false,
        result: tool.input.result || '',
        steps: step,
        trace,
        usage,
      };
    }

    let result;
    try {
      result = await execAction(page, tool.name, tool.input);
    } catch (e) {
      result = `ERROR: ${e.message}`;
    }

    onStep({ step, action: tool.name, input: tool.input, result, usage: resp.usage });
    trace.push({ step, action: tool.name, input: tool.input, result });

    pendingToolResult = {
      type: 'tool_result',
      tool_use_id: tool.id,
      content: String(result).slice(0, 2000),
    };
  }

  return {
    success: false,
    result: `Step limit of ${maxSteps} reached without completing the objective.`,
    steps: maxSteps,
    trace,
    usage,
  };
}

module.exports = { run, TOOLS, SYSTEM_PROMPT };
