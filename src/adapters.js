'use strict';

/**
 * adapters.js — Site Adapters (feature #1): turn any website into a named,
 * parameterized tool. You teach the Pilot a task once ("search Amazon",
 * "get my invoice"); it saves the host + a goal template with {params}, and
 * exposes it as a first-class tool — in the CLI and, dynamically, over MCP.
 * Every real site becomes an endpoint. The catalog is yours, local.
 *
 * Store: ~/.logica-pilot/adapters.json
 *   { adapters: [{ name, host, goal, description, params:[...], created }] }
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

const FILE = path.join(os.homedir(), '.logica-pilot', 'adapters.json');
const NAME_RE = /^[a-z][a-z0-9_-]{1,39}$/i;

function loadStore() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { adapters: [] }; } }
function saveStore(s) { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(s, null, 2)); } catch {} }

/** Extract {param} placeholders from a goal template. */
function paramsOf(goal) { return [...new Set([...String(goal).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))]; }

function save({ name, host, goal, description } = {}) {
  if (!NAME_RE.test(String(name || ''))) throw new Error('adapter: name must be [a-z][a-z0-9_-]{1,39}');
  if (!goal) throw new Error('adapter: goal template required (use {param} placeholders)');
  const s = loadStore();
  const adapter = {
    name: name.toLowerCase(), host: host || null, goal: String(goal),
    description: description || `Run the "${name}" task on ${host || 'the web'}`,
    params: paramsOf(goal), created: new Date().toISOString(),
  };
  s.adapters = s.adapters.filter((a) => a.name !== adapter.name);
  s.adapters.push(adapter);
  saveStore(s);
  return adapter;
}

function list() { return loadStore().adapters.map((a) => ({ name: a.name, host: a.host, params: a.params, description: a.description })); }
function get(name) { return loadStore().adapters.find((a) => a.name === String(name).toLowerCase()) || null; }
function remove(name) { const s = loadStore(); const before = s.adapters.length; s.adapters = s.adapters.filter((a) => a.name !== String(name).toLowerCase()); saveStore(s); return { removed: before - s.adapters.length }; }

/** Fill a goal template with params; unknown placeholders are left as-is. */
function fillGoal(goal, params = {}) {
  return String(goal).replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
}

/** Build MCP/CLI tool descriptors for every saved adapter (name → x_<name>). */
function toolDescriptors() {
  return loadStore().adapters.map((a) => {
    const props = {};
    for (const p of a.params) props[p] = { type: 'string' };
    return { name: 'x_' + a.name, adapter: a.name, description: `🔌 ${a.description}${a.host ? ' [' + a.host + ']' : ''}`, inputSchema: { type: 'object', properties: props, required: a.params } };
  });
}

module.exports = { save, list, get, remove, fillGoal, paramsOf, toolDescriptors, FILE };
