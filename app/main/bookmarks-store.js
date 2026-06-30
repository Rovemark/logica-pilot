'use strict';

/**
 * bookmarks-store.js — Favoritos (bookmarks) persistentes (paridade Chrome).
 *
 * Armazena entradas { url, title, favicon, ts } em userData/bookmarks.json com
 * escrita debounced. Dedup por URL (uma URL = um favorito). Alimenta a estrela da
 * omnibox, a barra de favoritos e o gerenciador.
 *
 * Mesmo PADRÃO de store do history-store.js / settings.js: init(userData),
 * estado em memória, debounce + flush, tolerante a disco ausente/corrompido.
 */

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 5000; // teto duro para o arquivo não crescer sem limite

let filePath = null;
/** @type {Map<string, {url,title,favicon,ts}>} ordem de inserção = ordem da barra */
let byUrl = new Map();
let writeTimer = null;

/** Inicializa apontando para o diretório de dados do usuário. */
function init(userDataDir) {
  filePath = path.join(userDataDir, 'bookmarks.json');
  load();
}

function load() {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      byUrl = new Map();
      for (const e of arr) {
        if (e && typeof e.url === 'string') byUrl.set(e.url, normalize(e));
      }
    }
  } catch {
    byUrl = new Map();
  }
}

function normalize(e) {
  return {
    url: String(e.url),
    title: typeof e.title === 'string' && e.title ? e.title : String(e.url),
    favicon: typeof e.favicon === 'string' ? e.favicon : '',
    ts: Number.isFinite(e.ts) ? e.ts : Date.now(),
  };
}

/** URLs internas/vazias não são favoritáveis (sem sentido salvar pilot://newtab). */
function isBookmarkable(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('about:')) return false;
  if (url.startsWith('chrome://') || url.startsWith('devtools://')) return false;
  // pilot:// (newtab) não vira favorito; http/https/file sim
  if (url.startsWith('pilot://')) return false;
  return /^https?:\/\//i.test(url) || /^file:\/\//i.test(url);
}

/** Lista (array) na ordem de inserção — é como a barra de favoritos exibe. */
function list() {
  return [...byUrl.values()].map((e) => ({ ...e }));
}

function isBookmarked(url) {
  return !!url && byUrl.has(url);
}

/** Adiciona/atualiza um favorito (dedup por url). Retorna o registro salvo (ou null). */
function add({ url, title, favicon, ts } = {}) {
  if (!isBookmarkable(url)) return null;
  const now = Number.isFinite(ts) ? ts : Date.now();
  const existing = byUrl.get(url);
  if (existing) {
    // atualiza metadados sem perder a posição na barra
    if (title) existing.title = title;
    if (favicon) existing.favicon = favicon;
    scheduleWrite();
    return { ...existing };
  }
  const rec = normalize({ url, title, favicon, ts: now });
  byUrl.set(url, rec);
  enforceCap();
  scheduleWrite();
  return { ...rec };
}

/** Remove um favorito por URL. Retorna true se removeu. */
function remove(url) {
  const ok = byUrl.delete(url);
  if (ok) scheduleWrite();
  return ok;
}

/**
 * Alterna o favorito da URL. Retorna { bookmarked: bool } com o estado FINAL.
 * Se não estava → adiciona (precisa de title/favicon); se estava → remove.
 */
function toggle({ url, title, favicon } = {}) {
  if (!isBookmarkable(url)) return { bookmarked: false };
  if (byUrl.has(url)) {
    byUrl.delete(url);
    scheduleWrite();
    return { bookmarked: false };
  }
  add({ url, title, favicon });
  return { bookmarked: true };
}

/** Edita um favorito existente (patch parcial: title/favicon/url). Retorna o registro ou null. */
function update(url, patch = {}) {
  const existing = byUrl.get(url);
  if (!existing) return null;
  const next = { ...existing };
  if (typeof patch.title === 'string' && patch.title) next.title = patch.title;
  if (typeof patch.favicon === 'string') next.favicon = patch.favicon;

  // troca de URL (re-chaveia preservando posição relativa)
  if (typeof patch.url === 'string' && patch.url && patch.url !== url) {
    if (!isBookmarkable(patch.url)) return { ...existing };
    next.url = patch.url;
    // reconstrói o Map preservando a ordem, trocando a entrada no lugar
    const rebuilt = new Map();
    for (const [k, v] of byUrl) {
      if (k === url) rebuilt.set(next.url, normalize(next));
      else if (k === next.url) continue; // evita duplicar se já existia
      else rebuilt.set(k, v);
    }
    byUrl = rebuilt;
    scheduleWrite();
    return { ...next };
  }

  byUrl.set(url, normalize(next));
  scheduleWrite();
  return { ...next };
}

/** Se passar do teto, remove os favoritos mais antigos. */
function enforceCap() {
  if (byUrl.size <= MAX_ENTRIES) return;
  const all = [...byUrl.values()].sort((a, b) => a.ts - b.ts);
  const toRemove = byUrl.size - MAX_ENTRIES;
  for (let i = 0; i < toRemove; i++) byUrl.delete(all[i].url);
}

function scheduleWrite() {
  if (!filePath) return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 300);
  if (writeTimer.unref) writeTimer.unref();
}

function flush() {
  if (!filePath) return;
  try {
    fs.writeFileSync(filePath, JSON.stringify([...byUrl.values()], null, 2), 'utf8');
  } catch {
    // disco indisponível — favoritos ficam só em memória
  }
}

module.exports = {
  init,
  list,
  add,
  remove,
  toggle,
  isBookmarked,
  update,
  flush,
};
