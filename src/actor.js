'use strict';

/**
 * actor.js — Formal Actor packaging (Apify Actors). LP's adapters/workflows are
 * untyped placeholder registries; an Actor is the self-describing, versioned,
 * validatable, portable unit: a manifest + a typed INPUT schema + an entry (a
 * crawler config or a tool call) + baked-in engine settings. Running one validates
 * & coerces the input, executes, and writes rows to a named dataset + an OUTPUT
 * record to the run's key-value store.
 *
 * Store: ~/.logica-pilot/actors/<name>/actor.json
 *
 * Zero-dependency (fs + a ~JSON-Schema-subset validator that reuses no libs).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const dataset = require('./dataset');
const kvs = require('./kvs');

const DIR = path.join(process.env.LOGICA_PILOT_HOME || path.join(os.homedir(), '.logica-pilot'), 'actors');
const safe = (n) => String(n || '').replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
const manifestPath = (n) => path.join(DIR, safe(n), 'actor.json');

// ── JSON-Schema-subset validator: type coercion, required, defaults, enum, pattern.
function coerce(type, v) {
  if (v == null) return v;
  if (type === 'number' || type === 'integer') { const n = Number(v); return Number.isNaN(n) ? v : (type === 'integer' ? Math.trunc(n) : n); }
  if (type === 'boolean') { if (typeof v === 'boolean') return v; return v === 'true' || v === '1' || v === 1 || v === true; }
  if (type === 'array') { if (Array.isArray(v)) return v; if (typeof v === 'string') { try { const j = JSON.parse(v); if (Array.isArray(j)) return j; } catch {} return v.split(',').map((s) => s.trim()).filter(Boolean); } return [v]; }
  if (type === 'string') return String(v);
  if (type === 'object' && typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

function validate(schema, input) {
  const props = (schema && schema.properties) || {};
  const required = (schema && schema.required) || [];
  const out = {}; const errors = [];
  for (const [key, spec] of Object.entries(props)) {
    let v = input && input[key] !== undefined ? input[key] : undefined;
    if (v === undefined && spec.default !== undefined) v = spec.default;
    if (v === undefined) { if (required.includes(key)) errors.push(`missing required: ${key}`); continue; }
    if (spec.type) v = coerce(spec.type, v);
    if (spec.enum && !spec.enum.includes(v)) errors.push(`${key} must be one of ${JSON.stringify(spec.enum)}`);
    if (spec.pattern && typeof v === 'string' && !new RegExp(spec.pattern).test(v)) errors.push(`${key} does not match ${spec.pattern}`);
    if ((spec.type === 'number' || spec.type === 'integer')) { if (spec.minimum != null && v < spec.minimum) errors.push(`${key} < minimum ${spec.minimum}`); if (spec.maximum != null && v > spec.maximum) errors.push(`${key} > maximum ${spec.maximum}`); }
    out[key] = v;
  }
  // pass through unknown keys (lenient)
  for (const k of Object.keys(input || {})) if (!(k in props)) out[k] = input[k];
  for (const k of required) if (!(k in out)) if (!errors.some((e) => e.includes(k))) errors.push(`missing required: ${k}`);
  return { valid: errors.length === 0, value: out, errors };
}

function init(name, { description = '', version = '0.1.0', input = { properties: {} }, entry = { type: 'tool', tool: 'read' }, engine = {} } = {}) {
  const dir = path.join(DIR, safe(name));
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { specVersion: 1, name: safe(name), version, description, input, entry, engine };
  fs.writeFileSync(manifestPath(name), JSON.stringify(manifest, null, 2));
  return { name: safe(name), path: manifestPath(name), manifest };
}

function get(name) { try { return JSON.parse(fs.readFileSync(manifestPath(name), 'utf8')); } catch { return null; } }
function list() { try { return fs.readdirSync(DIR).filter((d) => fs.existsSync(manifestPath(d))).map((d) => { const m = get(d); return { name: d, version: m && m.version, description: m && m.description, entry: m && m.entry && m.entry.type }; }); } catch { return []; } }
function remove(name) { const dir = path.join(DIR, safe(name)); const e = fs.existsSync(dir); if (e) fs.rmSync(dir, { recursive: true, force: true }); return { name: safe(name), removed: e }; }

/**
 * Run an actor. Validates+coerces input, executes the entry, writes a dataset +
 * an OUTPUT record to a per-run KVS.
 * @param {object} deps { pilot, runTool }  runTool(name,args,ctx) executes a registry tool
 */
async function run(name, rawInput, { pilot, runTool, model, runId } = {}) {
  const manifest = get(name);
  if (!manifest) return { error: `actor not found: ${name}` };
  const v = validate(manifest.input || {}, rawInput || {});
  if (!v.valid) return { error: 'input validation failed', errors: v.errors };
  const input = v.value;
  const rid = runId || `${safe(name)}-${Object.keys(kvs.listStores()).length}`;
  const dsName = `${safe(name)}`;

  let result;
  const entry = manifest.entry || {};
  if (entry.type === 'crawler') {
    const crawler = require('./crawler');
    const startUrls = input.startUrls || (input.url ? [input.url] : []);
    result = await crawler.run(pilot, {
      name: dsName, startUrls, pageFunction: entry.pageFunction, engine: entry.engine || input.engine || 'browser',
      strategy: entry.strategy, globs: entry.globs, maxDepth: entry.maxDepth != null ? entry.maxDepth : (input.maxDepth != null ? input.maxDepth : 2),
      maxRequests: input.maxRequests != null ? input.maxRequests : (entry.maxRequests || 100), maxConcurrency: entry.maxConcurrency || 5,
    });
  } else if (entry.type === 'tool') {
    const args = { ...(entry.args || {}), ...input };
    const out = runTool ? await runTool(entry.tool, args, { model }) : null;
    const payload = out && (out.out || out);
    const rows = payload && payload.json && Array.isArray(payload.json) ? payload.json : [payload && (payload.json || payload.text)];
    if (rows.filter(Boolean).length) dataset.put(dsName, rows.filter((r) => r && typeof r === 'object'));
    result = { tool: entry.tool, output: payload && (payload.json !== undefined ? payload.json : payload.text) };
  } else {
    return { error: `unknown entry type: ${entry.type}` };
  }

  kvs.setValue(rid, 'INPUT', input);
  kvs.setValue(rid, 'OUTPUT', result);
  return { actor: safe(name), runId: rid, dataset: dsName, input, result };
}

module.exports = { init, get, list, remove, run, validate };
