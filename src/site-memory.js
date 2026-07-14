'use strict';

/**
 * site-memory.js — the learning flywheel (Logica Pilot's MOAT).
 *
 * Persists what the browser learns about each site: which elements the agent acts
 * on (an importance signal) and successful goal → step "recipes". Repeat visits
 * warm-start from this memory, so the more your agents drive Logica Pilot, the
 * CHEAPER (fewer perception tokens), FASTER (skip re-discovery) and MORE RELIABLE
 * (known flows) it gets — per site. A stock Playwright script starts cold every run.
 *
 * Local-first: stored on the user's machine (never leaves it), so the moat is the
 * user's own accumulated interaction data, not a vendor's.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = process.env.LOGICA_PILOT_HOME || path.join(os.homedir(), '.logica-pilot');
const FILE = path.join(DIR, 'site-memory.json');

let store = null;
let writeTimer = null;
let dirty = false;

function load() {
  if (store) return store;
  try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { store = { version: 1, sites: {} }; }
  if (!store.sites) store.sites = {};
  return store;
}

// Debounced in the long-running app; flushed synchronously on process exit so a
// one-shot CLI invocation (which exits before the timer fires) still persists.
function flushSync() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (!dirty || !store) return;
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(store, null, 2)); dirty = false; } catch {}
}
function save() {
  dirty = true;
  if (writeTimer) return;
  writeTimer = setTimeout(flushSync, 300);
  if (writeTimer.unref) writeTimer.unref();
}
try { process.on('exit', flushSync); } catch {}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

function siteFor(host) {
  const s = load();
  if (!s.sites[host]) s.sites[host] = { visits: 0, elements: {}, recipes: [], fixes: [] };
  if (!s.sites[host].fixes) s.sites[host].fixes = [];
  return s.sites[host];
}

/** Bumps the visit counter for the URL's host. */
function recordVisit(url) {
  const h = hostOf(url); if (!h) return;
  const site = siteFor(h); site.visits++; site.lastSeen = Date.now(); save();
}

/** Records that the agent acted on an element (label + type) — an importance signal. */
function recordAction(url, { label, type } = {}) {
  const h = hostOf(url); if (!h || !label) return;
  const site = siteFor(h);
  const key = (type || 'el') + ':' + String(label).slice(0, 60).toLowerCase().trim();
  if (key.length < 4) return;
  site.elements[key] = (site.elements[key] || 0) + 1;
  save();
}

/** Records a successful goal → step sequence (a reusable recipe for the host). */
function recordRecipe(url, goal, steps) {
  const h = hostOf(url); if (!h || !goal) return;
  const site = siteFor(h);
  site.recipes = (site.recipes || []).filter((r) => r.goal !== goal);
  site.recipes.unshift({ goal: String(goal).slice(0, 120), steps: (steps || []).slice(0, 12), ts: Date.now() });
  site.recipes = site.recipes.slice(0, 20);
  save();
}

/**
 * Self-repair (#3): remember a failure and the fix that worked on this host, so
 * next time the model is warned BEFORE it repeats the mistake. Converges toward
 * zero breakage per site — impossible for a cold Playwright script.
 */
function recordFix(url, { problem, fix } = {}) {
  const h = hostOf(url); if (!h || !problem || !fix) return;
  const site = siteFor(h);
  const key = String(problem).slice(0, 80).toLowerCase().trim();
  site.fixes = (site.fixes || []).filter((f) => f.problem.toLowerCase().trim() !== key);
  site.fixes.unshift({ problem: String(problem).slice(0, 120), fix: String(fix).slice(0, 160), ts: Date.now(), hits: 1 });
  site.fixes = site.fixes.slice(0, 12);
  save();
}

/** Learned hints for a host: top elements + known recipes + repair notes. */
function recall(url) {
  const h = hostOf(url); if (!h) return null;
  const s = load().sites[h];
  if (!s) return null;
  const hot = Object.entries(s.elements || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([k, n]) => ({ type: k.split(':')[0], label: k.split(':').slice(1).join(':'), count: n }));
  return { host: h, visits: s.visits || 0, hot, recipes: (s.recipes || []).slice(0, 3), fixes: (s.fixes || []).slice(0, 3) };
}

/** One compact line appended to the perception map, so the model sees what's learned. */
function hintLine(url) {
  const r = recall(url);
  if (!r) return '';
  const bits = [];
  if (r.visits > 1) bits.push(`seen ${r.visits}×`);
  if (r.hot.length) bits.push('often used here: ' + r.hot.slice(0, 3).map((e) => `"${e.label}"`).join(', '));
  if (r.recipes.length) bits.push(`${r.recipes.length} known recipe(s)`);
  let line = bits.length ? '★ MEMORY (' + r.host + '): ' + bits.join(' · ') : '';
  // Repair notes go on their own line so they read as explicit warnings.
  if (r.fixes && r.fixes.length) {
    const fixes = r.fixes.map((f) => `• ${f.problem} → ${f.fix}`).join('\n');
    line += (line ? '\n' : '') + '⚠️ LEARNED ON THIS SITE:\n' + fixes;
  }
  return line;
}

function stats() {
  const s = load();
  const hosts = Object.keys(s.sites);
  let actions = 0, recipes = 0;
  for (const h of hosts) {
    actions += Object.values(s.sites[h].elements || {}).reduce((a, b) => a + b, 0);
    recipes += (s.sites[h].recipes || []).length;
  }
  return { sites: hosts.length, actions, recipes, file: FILE };
}

function dump(host) {
  const s = load();
  if (host) return s.sites[hostOf('http://' + host) || host.replace(/^www\./, '')] || null;
  return s.sites;
}

module.exports = { recordVisit, recordAction, recordRecipe, recordFix, recall, hintLine, stats, dump, hostOf, FILE };
