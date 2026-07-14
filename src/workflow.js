'use strict';

/**
 * workflow.js — Autopilot Recorder (feature #2): save a task as a named, replayable
 * workflow of CONCRETE steps and replay it deterministically — almost free, no LLM.
 * Steps target elements by LABEL (not index), so replay survives layout shuffles;
 * when a step can't be resolved, it falls back to the AI agent to finish, and the
 * healed run can be re-saved. The "Zapier of the logged-in web".
 *
 * Store: ~/.logica-pilot/workflows.json
 *   { workflows: [{ name, host, goal, steps:[{action,label?,text?,url?,submit?,
 *                   direction?,amount?,key?,ms?}], created }] }
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const actions = require('./actions');

const FILE = path.join(os.homedir(), '.logica-pilot', 'workflows.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadStore() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { workflows: [] }; } }
function saveStore(s) { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(s, null, 2)); } catch {} }

function save({ name, host, goal, steps } = {}) {
  if (!name) throw new Error('workflow: name required');
  if (!Array.isArray(steps) || !steps.length) throw new Error('workflow: steps[] required');
  const wf = { name: String(name).toLowerCase(), host: host || null, goal: goal || '', steps: steps.slice(0, 60), created: new Date().toISOString() };
  const s = loadStore();
  s.workflows = s.workflows.filter((w) => w.name !== wf.name);
  s.workflows.push(wf);
  saveStore(s);
  return { name: wf.name, steps: wf.steps.length, host: wf.host };
}
function list() { return loadStore().workflows.map((w) => ({ name: w.name, host: w.host, steps: w.steps.length, goal: w.goal })); }
function get(name) { return loadStore().workflows.find((w) => w.name === String(name).toLowerCase()) || null; }
function remove(name) { const s = loadStore(); const before = s.workflows.length; s.workflows = s.workflows.filter((w) => w.name !== String(name).toLowerCase()); saveStore(s); return { removed: before - s.workflows.length }; }

/** Type into the field whose placeholder/aria-label/name/label matches `label`. */
async function typeByLabel(page, label, text, submit) {
  const found = await page.eval(
    `(function(){var t=${JSON.stringify(String(label).toLowerCase())};` +
    `var els=[].slice.call(document.querySelectorAll('input:not([type=hidden]),textarea,[contenteditable=""],[contenteditable=true]'));` +
    `function score(e){var s=((e.getAttribute('placeholder')||'')+' '+(e.getAttribute('aria-label')||'')+' '+(e.getAttribute('name')||'')+' '+(e.id||'')).toLowerCase();` +
    `var lab=e.labels&&e.labels[0]?(e.labels[0].innerText||'').toLowerCase():'';s+=' '+lab;return s.indexOf(t)>=0;}` +
    `var m=els.filter(function(e){var r=e.getBoundingClientRect();return r.width>2&&r.height>2&&score(e);});` +
    `if(!m.length)return null;var el=m[0];el.setAttribute('data-lpilot-id','wf');el.scrollIntoView({block:'center'});return true;})()`,
  );
  if (!found) return { ok: false, error: `field not found for label "${label}"` };
  // reuse the robust type() via the temporary id
  const res = await actions.type(page, 'wf', text, !!submit).catch((e) => 'ERROR: ' + e.message);
  return { ok: !/ERROR|not found/i.test(String(res)), detail: res };
}

/**
 * Replay a workflow deterministically. Returns per-step results. If a step fails
 * and `agentFallback` is provided, it's called with the workflow goal to finish.
 */
async function replay(page, wf, { params = {}, agentFallback } = {}) {
  const fill = (v) => (typeof v === 'string' ? v.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m)) : v);
  const results = [];
  let failedAt = -1;
  for (let i = 0; i < wf.steps.length; i++) {
    const st = wf.steps[i];
    let r;
    try {
      if (st.action === 'navigate') r = await actions.navigate(page, fill(st.url));
      else if (st.action === 'click') r = await actions.clickText(page, fill(st.label), { exact: st.exact });
      else if (st.action === 'type') r = (await typeByLabel(page, fill(st.label), fill(st.text), st.submit)).detail || 'typed';
      else if (st.action === 'scroll') r = await actions.scroll(page, st.direction || 'down', st.amount || 600);
      else if (st.action === 'press') r = await actions.pressKey(page, st.key);
      else if (st.action === 'wait') { await sleep(Math.min(st.ms || 1000, 10000)); r = `waited ${st.ms || 1000}ms`; }
      else r = `unknown step action: ${st.action}`;
    } catch (e) { r = 'ERROR: ' + e.message; }
    const ok = !/ERROR|not found|not found for/i.test(String(r));
    results.push({ step: i + 1, action: st.action, ok, result: String(r).slice(0, 140) });
    await sleep(250);
    if (!ok) { failedAt = i; break; }
  }
  const out = { name: wf.name, steps: results, ok: failedAt < 0 };
  if (failedAt >= 0 && typeof agentFallback === 'function') {
    out.fallback = true;
    out.agent = await agentFallback(wf.goal || `Complete: ${wf.name}`);
    out.ok = !!(out.agent && out.agent.success);
  }
  return out;
}

module.exports = { save, list, get, remove, replay, FILE };
