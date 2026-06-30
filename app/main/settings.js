'use strict';

/**
 * settings.js — Preferências persistentes do navegador (tema, motor de busca, homepage).
 *
 * Guarda em userData/settings.json com escrita debounced. Defaults seguros:
 *   { theme: 'system', searchEngine: 'google', homepage: 'pilot://newtab' }.
 *
 * Não depende de Electron diretamente: recebe o caminho do arquivo via init()
 * (chamado pelo main com app.getPath('userData')) para facilitar teste/portabilidade.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  theme: 'system', // 'light' | 'dark' | 'system'
  searchEngine: 'google', // id do catálogo (search-engines.js)
  homepage: 'pilot://newtab',
  showBookmarksBar: false, // exibir a barra de favoritos abaixo da toolbar
});

let filePath = null;
let state = { ...DEFAULTS };
let writeTimer = null;

/** Inicializa o store apontando para o diretório de dados do usuário. */
function init(userDataDir) {
  filePath = path.join(userDataDir, 'settings.json');
  load();
  return get();
}

/** Lê o JSON do disco (tolerante a arquivo ausente/corrompido → mantém defaults). */
function load() {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      state = sanitize({ ...DEFAULTS, ...parsed });
    }
  } catch {
    state = { ...DEFAULTS };
  }
}

/** Garante valores válidos (não confiar cegamente no disco). */
function sanitize(s) {
  const out = { ...DEFAULTS };
  if (s.theme === 'light' || s.theme === 'dark' || s.theme === 'system') out.theme = s.theme;
  if (typeof s.searchEngine === 'string' && s.searchEngine) out.searchEngine = s.searchEngine;
  if (typeof s.homepage === 'string' && s.homepage) out.homepage = s.homepage;
  if (typeof s.showBookmarksBar === 'boolean') out.showBookmarksBar = s.showBookmarksBar;
  return out;
}

/** Snapshot completo das settings (cópia, para o caller não mutar o estado interno). */
function get() {
  return { ...state };
}

/** Aplica um patch parcial, persiste e devolve o settings completo. */
function set(patch = {}) {
  const next = sanitize({ ...state, ...patch });
  state = next;
  scheduleWrite();
  return get();
}

/** Escrita debounced (~200ms) para não martelar o disco. */
function scheduleWrite() {
  if (!filePath) return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 200);
  if (writeTimer.unref) writeTimer.unref();
}

/** Persiste imediatamente (usado no debounce e em saída). */
function flush() {
  if (!filePath) return;
  try {
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // disco indisponível — settings continuam em memória; nada fatal
  }
}

module.exports = { init, get, set, flush, DEFAULTS };
