'use strict';

/**
 * vectorize.js — Scrape → RAG bridge (Apify vector-database-integrations). Turn a
 * dataset (from crawl/crawler/gather) into vector-DB records: chunk → embed → upsert,
 * with an INCREMENTAL delta so recurring crawls only re-embed what changed.
 *
 *   vectorize({ dataset: 'docs', embed: 'local', target: 'qdrant',
 *               url: 'http://localhost:6333', collection: 'docs' })
 *
 * embed: 'local' (default — deterministic, offline, private; good for tests & lexical
 * fallback) | 'openai' | 'voyage' (real semantic, needs the provider key in env).
 * target: 'qdrant' | 'chroma' | 'pinecone' | 'dry' (returns the upsert plan, no DB).
 *
 * Zero-dependency (crypto + global fetch). Delta sidecar:
 * ~/.logica-pilot/vector-state/<dataset>-<collection>.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dataset = require('./dataset');

const STATE_DIR = path.join(process.env.LOGICA_PILOT_HOME || path.join(os.homedir(), '.logica-pilot'), 'vector-state');

// ── recursive character splitter (no LangChain) ──
function chunk(text, { chunkSize = 1000, overlap = 150 } = {}) {
  const t = String(text || '').trim();
  if (t.length <= chunkSize) return t ? [t] : [];
  const seps = ['\n\n', '\n', '. ', ' '];
  const out = [];
  let i = 0;
  while (i < t.length) {
    let end = Math.min(i + chunkSize, t.length);
    if (end < t.length) {
      // back off to the nearest separator for a clean cut
      for (const s of seps) { const idx = t.lastIndexOf(s, end); if (idx > i + chunkSize * 0.5) { end = idx + s.length; break; } }
    }
    out.push(t.slice(i, end).trim());
    i = end - overlap;
    if (i < 0) i = 0;
    if (end >= t.length) break;
  }
  return out.filter(Boolean);
}

// ── embedders ──
// Deterministic local embedding: hashed bag-of-tokens → fixed-dim unit vector.
// Offline + private + stable. Lexical, not semantic — real RAG wants a provider.
function localEmbed(text, dim = 256) {
  const v = new Array(dim).fill(0);
  for (const tok of String(text).toLowerCase().match(/[a-z0-9]{2,}/g) || []) {
    const h = crypto.createHash('md5').update(tok).digest();
    const idx = h.readUInt32BE(0) % dim;
    v[idx] += 1;
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

async function providerEmbed(texts, provider, model) {
  if (provider === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY not set');
    const r = await fetch('https://api.openai.com/v1/embeddings', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ model: model || 'text-embedding-3-small', input: texts }) }).then((x) => x.json());
    return r.data.map((d) => d.embedding);
  }
  if (provider === 'voyage') {
    const key = process.env.VOYAGE_API_KEY;
    if (!key) throw new Error('VOYAGE_API_KEY not set');
    const r = await fetch('https://api.voyageai.com/v1/embeddings', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ model: model || 'voyage-3', input: texts }) }).then((x) => x.json());
    return r.data.map((d) => d.embedding);
  }
  throw new Error(`unknown embed provider: ${provider}`);
}

async function embedAll(texts, { embed = 'local', model, dim = 256 } = {}) {
  if (embed === 'local') return texts.map((t) => localEmbed(t, dim));
  return providerEmbed(texts, embed, model);
}

// ── vector-DB REST clients ──
async function upsertQdrant({ url, collection, apiKey }, points, dim) {
  const h = { 'content-type': 'application/json', ...(apiKey ? { 'api-key': apiKey } : {}) };
  await fetch(`${url}/collections/${collection}`, { method: 'PUT', headers: h, body: JSON.stringify({ vectors: { size: dim, distance: 'Cosine' } }) }).catch(() => {});
  const body = { points: points.map((p) => ({ id: p.id, vector: p.vector, payload: p.payload })) };
  const r = await fetch(`${url}/collections/${collection}/points?wait=true`, { method: 'PUT', headers: h, body: JSON.stringify(body) });
  return { status: r.status, ok: r.ok };
}
async function upsertChroma({ url, collection }, points) {
  const r = await fetch(`${url}/api/v1/collections/${collection}/upsert`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: points.map((p) => String(p.id)), embeddings: points.map((p) => p.vector), metadatas: points.map((p) => p.payload) }) });
  return { status: r.status, ok: r.ok };
}
async function upsertPinecone({ url, apiKey }, points) {
  const r = await fetch(`${url}/vectors/upsert`, { method: 'POST', headers: { 'content-type': 'application/json', 'api-key': apiKey }, body: JSON.stringify({ vectors: points.map((p) => ({ id: String(p.id), values: p.vector, metadata: p.payload })) }) });
  return { status: r.status, ok: r.ok };
}

// ── incremental delta ──
function stateFile(datasetName, collection) { return path.join(STATE_DIR, `${datasetName}-${collection}.json`.replace(/[^a-z0-9._-]/gi, '_')); }
function loadState(datasetName, collection) { try { return JSON.parse(fs.readFileSync(stateFile(datasetName, collection), 'utf8')); } catch { return {}; } }
function saveState(datasetName, collection, s) { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(stateFile(datasetName, collection), JSON.stringify(s)); }

function rowText(row, fields) {
  if (fields && fields.length) return fields.map((f) => row[f]).filter(Boolean).join('\n');
  return Object.entries(row).filter(([k]) => !k.startsWith('_')).map(([, v]) => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n');
}
function rowKey(row) { return row._url || row.url || row.id || crypto.createHash('sha1').update(JSON.stringify(row)).digest('hex').slice(0, 16); }

/**
 * Compute the delta of a dataset vs the last vectorized state.
 * @returns {{adds, updates, deletes, rows}}  rows = the changed rows to (re)embed
 */
function computeDelta(rows, prevState, { dataFields } = {}) {
  const seen = new Set();
  const adds = [], updates = [], changed = [];
  for (const row of rows) {
    const key = rowKey(row);
    seen.add(key);
    const checksum = crypto.createHash('sha256').update(rowText(row, dataFields)).digest('hex').slice(0, 24);
    const prev = prevState[key];
    if (!prev) { adds.push(key); changed.push({ key, row, checksum }); }
    else if (prev.checksum !== checksum) { updates.push(key); changed.push({ key, row, checksum }); }
  }
  const deletes = Object.keys(prevState).filter((k) => !seen.has(k));
  return { adds, updates, deletes, changed };
}

/**
 * Chunk + embed + upsert a dataset into a vector DB, incrementally.
 * @param {object} opts { dataset, embed, target, url, collection, apiKey, model,
 *                         dataFields, metadataFields, chunkSize, overlap, dim }
 */
async function vectorize({ dataset: dsName, embed = 'local', target = 'dry', url, collection, apiKey, model, dataFields, metadataFields, chunkSize = 1000, overlap = 150, dim = 256 } = {}) {
  const raw = dataset.get ? dataset.get(dsName) : null;
  const rows = raw && raw.rows ? Object.values(raw.rows) : (Array.isArray(raw) ? raw : []);
  if (!rows.length) return { error: `dataset "${dsName}" is empty or not found` };
  const coll = collection || dsName;

  const prev = loadState(dsName, coll);
  const { adds, updates, deletes, changed } = computeDelta(rows, prev, { dataFields });

  // chunk the changed rows
  const points = [];
  for (const { key, row, checksum } of changed) {
    const chunks = chunk(rowText(row, dataFields), { chunkSize, overlap });
    chunks.forEach((c, i) => {
      const meta = { _key: key, _chunk: i, text: c.slice(0, 500) };
      if (metadataFields) for (const f of metadataFields) meta[f] = row[f];
      points.push({ id: crypto.createHash('sha1').update(key + ':' + i).digest('hex').slice(0, 16), text: c, payload: meta, _key: key, _checksum: checksum });
    });
  }

  // embed
  const vectors = points.length ? await embedAll(points.map((p) => p.text), { embed, model, dim }) : [];
  points.forEach((p, i) => { p.vector = vectors[i]; delete p.text; });
  const vdim = vectors[0] ? vectors[0].length : dim;

  // upsert
  let upsertResult = { target: 'dry', points: points.length };
  if (target !== 'dry' && points.length) {
    if (target === 'qdrant') upsertResult = await upsertQdrant({ url, collection: coll, apiKey }, points, vdim);
    else if (target === 'chroma') upsertResult = await upsertChroma({ url, collection: coll }, points);
    else if (target === 'pinecone') upsertResult = await upsertPinecone({ url, apiKey }, points);
    else return { error: `unknown target: ${target}` };
  }

  // persist new state (only if not a dry run, or always — track for next delta)
  const nextState = { ...prev };
  for (const { key, checksum } of changed) nextState[key] = { checksum, ts: Date.now() };
  for (const k of deletes) delete nextState[k];
  saveState(dsName, coll, nextState);

  return { dataset: dsName, collection: coll, embed, target, dim: vdim, delta: { adds: adds.length, updates: updates.length, deletes: deletes.length }, chunks: points.length, upsert: upsertResult };
}

module.exports = { vectorize, chunk, localEmbed, computeDelta, embedAll };
