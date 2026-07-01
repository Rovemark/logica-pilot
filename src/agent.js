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

RULES:
- Act by intent using the ELEMENT'S INDEX — never invent indices that aren't on the list.
- If the target is not visible, use "scroll" to search for it before giving up.
- To search/find: use "type" in the right field with submit=true (sends Enter).
- After navigating/clicking, the next page read already reflects the result — observe before acting again.
- Do not repeat the same action if it clearly didn't work; try a different approach.
- When the OBJECTIVE is fulfilled, call "done" with success=true and a clear, complete "result" (the final answer for the user, in PT-BR).
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
        result: { type: 'string', description: 'Response/final result in PT-BR.' },
      },
      required: ['success', 'result'],
    },
  },
];

/** Remove images from all user messages except the last one (token economy). */
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
          b.type === 'image' ? { type: 'text', text: '[previous screenshot omitted]' } : b,
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

  if (opts.startUrl) {
    await actions.navigate(page, opts.startUrl);
  }

  const history = [];
  const trace = [];
  let pendingToolResult = null;

  for (let step = 1; step <= maxSteps; step++) {
    if (typeof opts.shouldStop === 'function' && opts.shouldStop()) {
      return { success: false, result: 'Stopped by user.', steps: step - 1, trace };
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
      return { success: false, result: `Brain error: ${e.message}`, steps: step, trace };
    }

    history.push({ role: 'assistant', content: resp.content });
    const tool = llm.firstToolUse(resp);

    if (!tool) {
      // No action → treat text as final response
      const txt = llm.textOf(resp) || '(no response)';
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
      result = `ERROR: ${e.message}`;
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
    result: `Step limit of ${maxSteps} reached without completing the objective.`,
    steps: maxSteps,
    trace,
  };
}

module.exports = { run, TOOLS, SYSTEM_PROMPT };
