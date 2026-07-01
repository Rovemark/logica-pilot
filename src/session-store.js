'use strict';

/**
 * session-store.js — Persistência de sessão (cookies) por nome.
 *
 * Dor clássica do Playwright: relogar a cada script. Aqui você loga UMA vez,
 * salva a sessão, e reusa em qualquer chamada futura (CLI/MCP):
 *   logica-pilot session save minha-conta   # depois de logar num run/act
 *   logica-pilot ... --session minha-conta   # reusa os cookies
 *
 * Guarda em ~/.logica-pilot/sessions/<nome>.json (só cookies; 0 dep).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.logica-pilot', 'sessions');
const sane = (n) => (String(n || 'default').replace(/[^a-z0-9_-]/gi, '_') || 'default');
const fileOf = (n) => path.join(DIR, sane(n) + '.json');

/** Salva os cookies atuais da página sob um nome. */
async function save(page, name) {
  await page.send('Network.enable').catch(() => {});
  const res = await page.send('Network.getAllCookies').catch(() => ({ cookies: [] }));
  const cookies = (res && res.cookies) || [];
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(fileOf(name), JSON.stringify({ name: sane(name), savedAt: Date.now(), cookies }, null, 2));
  return { name: sane(name), cookies: cookies.length };
}

/** Restaura os cookies salvos na página (aplique ANTES de navegar). */
async function load(page, name) {
  const f = fileOf(name);
  if (!fs.existsSync(f)) return { name: sane(name), loaded: 0, error: 'sessão não encontrada' };
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  // filtra p/ os campos que o Network.setCookies aceita (evita erro com size/session/etc.)
  const cookies = (data.cookies || [])
    .filter((c) => c && c.name && c.domain)
    .map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
      secure: !!c.secure, httpOnly: !!c.httpOnly,
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      ...(typeof c.expires === 'number' && c.expires > 0 ? { expires: c.expires } : {}),
    }));
  await page.send('Network.enable').catch(() => {});
  let ok = false;
  try { await page.send('Network.setCookies', { cookies }); ok = true; } catch {}
  if (!ok) { for (const c of cookies) { try { await page.send('Network.setCookie', c); } catch {} } }
  return { name: sane(name), loaded: cookies.length };
}

/** Lista as sessões salvas. */
function list() {
  try {
    return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  } catch { return []; }
}

module.exports = { save, load, list, DIR };
