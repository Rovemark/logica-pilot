'use strict';

/**
 * registry.js — Shareable Actor registry (Apify Store, self-hostable). Turns LP's
 * local-only actors into an ecosystem: publish an actor, search a catalog, and add
 * someone else's working scraper instead of re-deriving it. Federated — a registry is
 * a local dir and/or remote HTTP endpoints, so it fits the multi-tenant appliance.
 *
 *   registry.publish('amazon-scraper')          // local actor → registry
 *   registry.search('amazon price')             // BM25-ish over the catalog
 *   await registry.add('amazon-scraper')        // install into ~/.logica-pilot/actors
 *
 * Local store: ~/.logica-pilot/registry/{index.json, <name>@<version>/actor.json}.
 * Remote: any URL serving the same index.json + /<name>@<version>/actor.json.
 * Zero-dependency (fs + global fetch).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const actor = require('./actor');

const HOME = process.env.LOGICA_PILOT_HOME || path.join(os.homedir(), '.logica-pilot');
const DIR = path.join(HOME, 'registry');
const indexPath = () => path.join(DIR, 'index.json');
const remotesPath = () => path.join(DIR, 'remotes.json');

function loadIndex() { try { return JSON.parse(fs.readFileSync(indexPath(), 'utf8')); } catch { return { actors: [] }; } }
function saveIndex(idx) { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(indexPath(), JSON.stringify(idx, null, 2)); }
function remotes() { try { return JSON.parse(fs.readFileSync(remotesPath(), 'utf8')); } catch { return []; } }

/** Publish a local actor to the registry (snapshots its manifest under name@version). */
function publish(name) {
  const manifest = actor.get(name);
  if (!manifest) return { error: `local actor not found: ${name}` };
  const version = manifest.version || '0.1.0';
  const slug = `${manifest.name}@${version}`;
  const dir = path.join(DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'actor.json'), JSON.stringify(manifest, null, 2));
  const idx = loadIndex();
  idx.actors = idx.actors.filter((a) => !(a.name === manifest.name && a.version === version));
  idx.actors.push({ name: manifest.name, version, description: manifest.description || '', entry: manifest.entry && manifest.entry.type, keywords: keywordsOf(manifest), publishedAt: Date.now() });
  saveIndex(idx);
  return { published: slug, description: manifest.description };
}

function keywordsOf(m) {
  return (`${m.name} ${m.description || ''} ${m.entry && m.entry.type || ''} ${Object.keys((m.input && m.input.properties) || {}).join(' ')}`).toLowerCase().match(/[a-z0-9]{2,}/g) || [];
}

// lightweight ranking: token overlap between query and each actor's keywords.
function rank(query, actors) {
  const q = String(query || '').toLowerCase().match(/[a-z0-9]{2,}/g) || [];
  return actors
    .map((a) => ({ a, score: q.reduce((s, t) => s + ((a.keywords || []).includes(t) ? 2 : (a.name + a.description).toLowerCase().includes(t) ? 1 : 0), 0) }))
    .filter((x) => !query || x.score > 0)
    .sort((x, y) => y.score - x.score)
    .map((x) => x.a);
}

/** Search local + remote catalogs. */
async function search(query, { includeRemote = true } = {}) {
  const local = loadIndex().actors.map((a) => ({ ...a, source: 'local' }));
  let all = [...local];
  if (includeRemote) {
    for (const url of remotes()) {
      try { const r = await fetch(`${url.replace(/\/$/, '')}/index.json`).then((x) => x.json()); (r.actors || []).forEach((a) => all.push({ ...a, source: url })); } catch {}
    }
  }
  return rank(query, all).slice(0, 25);
}

/** Install a registry actor locally (from local store or a remote). */
async function add(name, { version } = {}) {
  const idx = loadIndex();
  let entry = idx.actors.find((a) => a.name === name && (!version || a.version === version)) || idx.actors.filter((a) => a.name === name).sort((x, y) => y.publishedAt - x.publishedAt)[0];
  let manifest = null;
  if (entry) { try { manifest = JSON.parse(fs.readFileSync(path.join(DIR, `${entry.name}@${entry.version}`, 'actor.json'), 'utf8')); } catch {} }
  if (!manifest) {
    // try remotes
    for (const url of remotes()) {
      try {
        const rIdx = await fetch(`${url.replace(/\/$/, '')}/index.json`).then((x) => x.json());
        const re = (rIdx.actors || []).find((a) => a.name === name && (!version || a.version === version));
        if (re) { manifest = await fetch(`${url.replace(/\/$/, '')}/${re.name}@${re.version}/actor.json`).then((x) => x.json()); break; }
      } catch {}
    }
  }
  if (!manifest) return { error: `actor not found in registry: ${name}` };
  actor.init(manifest.name, { description: manifest.description, version: manifest.version, input: manifest.input, entry: manifest.entry, engine: manifest.engine });
  return { added: manifest.name, version: manifest.version, entry: manifest.entry && manifest.entry.type };
}

function list() { return loadIndex().actors; }
function info(name, version) { const e = loadIndex().actors.find((a) => a.name === name && (!version || a.version === version)); if (!e) return null; try { return JSON.parse(fs.readFileSync(path.join(DIR, `${e.name}@${e.version}`, 'actor.json'), 'utf8')); } catch { return e; } }
function addRemote(url) { const r = remotes(); if (!r.includes(url)) r.push(url); fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(remotesPath(), JSON.stringify(r, null, 2)); return { remotes: r }; }
function unpublish(name, version) { const idx = loadIndex(); const before = idx.actors.length; idx.actors = idx.actors.filter((a) => !(a.name === name && (!version || a.version === version))); saveIndex(idx); return { removed: before - idx.actors.length }; }

module.exports = { publish, search, add, list, info, addRemote, unpublish, DIR };
