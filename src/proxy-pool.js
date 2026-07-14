'use strict';

/**
 * proxy-pool.js — Named proxy pools with rotation, sticky sessions, and geo tags.
 *
 * Logica Pilot already accepts a single `proxy` (user:pass@host:port) per call.
 * This adds NAMED POOLS so an agent can round-robin / stick-per-session / filter by
 * geo across many endpoints (Webshare, Bright Data, IPRoyal, Oxylabs, …) without the
 * caller hardcoding IPs.
 *
 * Config (either one):
 *   env  LOGICA_PILOT_PROXY_POOLS = '{"webshare":{"strategy":"round-robin","geo":"us","proxies":["u:p@ip:port", ...]}}'
 *   file ~/.logica-pilot/proxy-pools.json   (same shape)
 *
 * Rotation state (round-robin cursor + sticky session→proxy map) persists to
 * ~/.logica-pilot/proxy-state.json so it survives across separate CLI runs.
 *
 * Zero-dependency.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = process.env.LOGICA_PILOT_HOME || path.join(os.homedir(), '.logica-pilot');
const CONFIG = path.join(DIR, 'proxy-pools.json');
const STATE = path.join(DIR, 'proxy-state.json');

// Provider hints so operators know what to paste. Not credentials — just formats.
const PRESETS = {
  webshare: 'Webshare: rotating endpoint p.webshare.io:80 or per-proxy user-XXXXX:pass@ip:port (dashboard → Proxy List → download).',
  brightdata: 'Bright Data: brd-customer-<id>-zone-<zone>:<pass>@brd.superproxy.io:22225 (sticky: add -session-<rand> to the user).',
  iproyal: 'IPRoyal: user:pass_country-us_session-<rand>@geo.iproyal.com:12321.',
  oxylabs: 'Oxylabs: customer-<user>-cc-us:<pass>@pr.oxylabs.io:7777.',
  smartproxy: 'Smartproxy/Decodo: user:pass@gate.smartproxy.com:7000 (sticky ports 10000-19999).',
};

function loadConfig() {
  let cfg = {};
  if (process.env.LOGICA_PILOT_PROXY_POOLS) {
    try { cfg = JSON.parse(process.env.LOGICA_PILOT_PROXY_POOLS); } catch {}
  }
  if (fs.existsSync(CONFIG)) {
    try { Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG, 'utf8'))); } catch {}
  }
  return cfg || {};
}

function saveConfig(cfg) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
}

function loadState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { cursors: {}, sticky: {} }; } }
function saveState(s) { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }

function normalizePool(p) {
  if (Array.isArray(p)) return { strategy: 'round-robin', proxies: p };
  return { strategy: p.strategy || 'round-robin', geo: p.geo || null, proxies: p.proxies || [] };
}

/** List configured pools (no secrets — only counts + strategy + geo). */
function list() {
  const cfg = loadConfig();
  return Object.keys(cfg).map((name) => {
    const p = normalizePool(cfg[name]);
    return { name, count: p.proxies.length, strategy: p.strategy, geo: p.geo || null };
  });
}

/**
 * Pick a proxy from a named pool.
 * @param {string} name pool name
 * @param {object} opts { session (sticky key), strategy override, geo filter }
 * @returns {string|null} proxy string usable as `--proxy` / opts.proxy
 */
function pick(name, { session, strategy, geo } = {}) {
  const cfg = loadConfig();
  if (!cfg[name]) return null;
  const pool = normalizePool(cfg[name]);
  if (geo && pool.geo && geo !== pool.geo) return null;
  const proxies = pool.proxies;
  if (!proxies.length) return null;

  const mode = strategy || pool.strategy || 'round-robin';
  const state = loadState();

  if (mode === 'sticky' && session) {
    const key = `${name}:${session}`;
    if (state.sticky[key] && proxies.includes(state.sticky[key])) return state.sticky[key];
    // assign the least-recently-used-ish: use cursor then remember it
    const idx = (state.cursors[name] || 0) % proxies.length;
    state.cursors[name] = idx + 1;
    state.sticky[key] = proxies[idx];
    saveState(state);
    return proxies[idx];
  }
  if (mode === 'random') {
    // deterministic-ish spread without Math.random: mix cursor + time-free counter
    const idx = (state.cursors[name] || 0);
    state.cursors[name] = idx + 1;
    saveState(state);
    return proxies[(idx * 7 + 3) % proxies.length];
  }
  // round-robin (default)
  const idx = (state.cursors[name] || 0) % proxies.length;
  state.cursors[name] = idx + 1;
  saveState(state);
  return proxies[idx];
}

/** Create/replace a named pool. */
function add(name, proxies, { strategy = 'round-robin', geo } = {}) {
  const cfg = loadConfig();
  const list = Array.isArray(proxies) ? proxies : String(proxies || '').split(',').map((s) => s.trim()).filter(Boolean);
  cfg[name] = { strategy, geo: geo || null, proxies: list };
  saveConfig(cfg);
  return { name, count: list.length, strategy, geo: geo || null };
}

/** Remove a named pool. */
function remove(name) {
  const cfg = loadConfig();
  const existed = !!cfg[name];
  delete cfg[name];
  saveConfig(cfg);
  return { name, removed: existed };
}

module.exports = { list, pick, add, remove, PRESETS, CONFIG, STATE };
