'use strict';

/**
 * history-store.js — Histórico de navegação persistente (paridade Chrome).
 *
 * Armazena entradas { url, title, visitCount, lastVisit, firstVisit } em
 * userData/history.json com escrita debounced. Dedup por URL (mesma URL ++visitCount).
 * Alimenta as sugestões do omnibox (query) e o most-visited do newtab (topSites).
 */

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 5000; // teto duro para o arquivo não crescer sem limite

let filePath = null;
/** @type {Map<string, {url,title,visitCount,lastVisit,firstVisit}>} */
let byUrl = new Map();
let writeTimer = null;

/** Inicializa apontando para o diretório de dados do usuário. */
function init(userDataDir) {
  filePath = path.join(userDataDir, 'history.json');
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
    title: typeof e.title === 'string' ? e.title : '',
    visitCount: Number.isFinite(e.visitCount) ? e.visitCount : 1,
    lastVisit: Number.isFinite(e.lastVisit) ? e.lastVisit : Date.now(),
    firstVisit: Number.isFinite(e.firstVisit) ? e.firstVisit : Date.now(),
  };
}

/** URLs internas/vazias não entram no histórico. */
function isTrackable(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('pilot://')) return false;
  if (url.startsWith('about:')) return false;
  if (url.startsWith('chrome://') || url.startsWith('devtools://')) return false;
  if (url === 'about:blank') return false;
  return /^https?:\/\//i.test(url) || /^file:\/\//i.test(url);
}

/** Registra/atualiza uma visita (dedup por url, ++visitCount, atualiza título). */
function add({ url, title, ts } = {}) {
  if (!isTrackable(url)) return;
  const now = Number.isFinite(ts) ? ts : Date.now();
  const existing = byUrl.get(url);
  if (existing) {
    existing.visitCount += 1;
    existing.lastVisit = now;
    if (title) existing.title = title;
  } else {
    byUrl.set(url, {
      url,
      title: title || '',
      visitCount: 1,
      lastVisit: now,
      firstVisit: now,
    });
    enforceCap();
  }
  scheduleWrite();
}

/**
 * Atualiza SÓ o título de uma URL já existente (sem ++visitCount).
 * Usado pelo page-title-updated, que chega depois do did-navigate (que cria a
 * entrada com o título antigo da aba). Evita inflar visitCount em ~2x por navegação.
 */
function updateTitle(url, title) {
  if (!isTrackable(url) || !title) return;
  const existing = byUrl.get(url);
  if (existing) {
    existing.title = title;
    scheduleWrite();
  }
}

/** Se passar do teto, remove as entradas menos relevantes (menor visitCount + mais antigas). */
function enforceCap() {
  if (byUrl.size <= MAX_ENTRIES) return;
  const all = [...byUrl.values()].sort((a, b) => {
    if (a.visitCount !== b.visitCount) return a.visitCount - b.visitCount;
    return a.lastVisit - b.lastVisit;
  });
  const toRemove = byUrl.size - MAX_ENTRIES;
  for (let i = 0; i < toRemove; i++) byUrl.delete(all[i].url);
}

/** Pontuação de relevância: frequência + recência (decai com o tempo). */
function score(e) {
  const ageDays = (Date.now() - e.lastVisit) / 86400000;
  const recency = 1 / (1 + ageDays); // 1.0 hoje → cai com o tempo
  return e.visitCount * 2 + recency * 5;
}

/** Sugestões por prefixo (match em url ou título), ordenadas por relevância. */
function query(prefix, limit = 8) {
  const p = String(prefix || '').toLowerCase().trim();
  let entries = [...byUrl.values()];
  if (p) {
    entries = entries.filter(
      (e) => e.url.toLowerCase().includes(p) || (e.title && e.title.toLowerCase().includes(p)),
    );
  }
  entries.sort((a, b) => score(b) - score(a));
  return entries.slice(0, Math.max(0, limit)).map((e) => ({
    url: e.url,
    title: e.title,
    visitCount: e.visitCount,
    lastVisit: e.lastVisit,
  }));
}

/** Sites mais visitados (para o grid do newtab). */
function topSites(limit = 8) {
  const entries = [...byUrl.values()].sort((a, b) => {
    if (b.visitCount !== a.visitCount) return b.visitCount - a.visitCount;
    return b.lastVisit - a.lastVisit;
  });
  return entries.slice(0, Math.max(0, limit)).map((e) => ({
    url: e.url,
    title: e.title,
    visitCount: e.visitCount,
  }));
}

/** Itens mais recentes (para a tela de histórico). */
function recent(limit = 100) {
  const entries = [...byUrl.values()].sort((a, b) => b.lastVisit - a.lastVisit);
  return entries.slice(0, Math.max(0, limit)).map((e) => ({
    url: e.url,
    title: e.title,
    ts: e.lastVisit,
    visitCount: e.visitCount,
  }));
}

/** Remove uma única entrada pela URL. Retorna true se removeu. */
function remove(url) {
  if (!url || typeof url !== 'string') return false;
  const had = byUrl.delete(url);
  if (had) scheduleWrite();
  return had;
}

/** Limpa por intervalo: 'hour' | 'day' | 'all'. Retorna true. */
function clear(range = 'all') {
  if (range === 'all') {
    byUrl.clear();
  } else {
    const cutoff = Date.now() - (range === 'hour' ? 3600000 : 86400000);
    for (const [url, e] of byUrl) {
      if (e.lastVisit >= cutoff) byUrl.delete(url);
    }
  }
  scheduleWrite();
  return true;
}

function scheduleWrite() {
  if (!filePath) return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 400);
  if (writeTimer.unref) writeTimer.unref();
}

function flush() {
  if (!filePath) return;
  try {
    fs.writeFileSync(filePath, JSON.stringify([...byUrl.values()]), 'utf8');
  } catch {
    // disco indisponível — histórico fica só em memória
  }
}

module.exports = { init, add, updateTitle, query, topSites, recent, remove, clear, flush };
