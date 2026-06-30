'use strict';

/* panel.js — UI do painel flutuante. Renderiza 'settings' ou 'about' conforme
   o { type } enviado pelo main. Sem HTML inline com handlers — tudo via DOM API
   (CSP: script-src 'self'). Reusa os canais existentes via window.panel.* */

const titleEl = document.getElementById('ph-title');
const bodyEl = document.getElementById('pb');
const closeBtn = document.getElementById('ph-close');

closeBtn.addEventListener('click', () => window.panel.close());
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.panel.close(); });

// helper: cria elemento com classe/texto
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// monta uma linha de settings: rótulo + dica + controle à direita
function settingsRow(label, hint, control) {
  const row = el('div', 'row');
  const left = el('div', 'rl');
  left.appendChild(el('label', null, label));
  if (hint) left.appendChild(el('span', 'hint', hint));
  row.appendChild(left);
  row.appendChild(control);
  return row;
}

window.panel.onData(async ({ type, dark }) => {
  document.body.classList.toggle('light', !dark);
  if (type === 'about') return renderAbout();
  return renderSettings();
});

// ── ABOUT — prova visual de Chromium ──────────────────────────────────────────
async function renderAbout() {
  titleEl.textContent = 'Sobre';
  bodyEl.innerHTML = '';

  const v = (window.panel && window.panel.versions) || {};
  let appVersion = '';
  try {
    const info = await window.panel.appInfo();
    if (info) {
      appVersion = info.appVersion || '';
      // process.versions do preload já cobre chrome/electron/v8/node; o app:info
      // confirma do main (mesma fonte). Mantém o que vier do appInfo se presente.
      v.chrome = info.chrome || v.chrome;
      v.electron = info.electron || v.electron;
      v.v8 = info.v8 || v.v8;
      v.node = info.node || v.node;
    }
  } catch {}

  // hero
  const hero = el('div', 'hero');
  hero.appendChild(el('span', 'mark', '◢'));
  const ht = el('div', 'ht');
  ht.appendChild(el('strong', null, 'Logica Pilot'));
  ht.appendChild(el('span', 'sub', 'Navegador autônomo · motor Chromium'));
  hero.appendChild(ht);
  bodyEl.appendChild(hero);

  // grade de versões (prova de Chromium)
  const rows = [
    ['Versão', appVersion || '—'],
    ['Chromium', v.chrome || '—'],
    ['Electron', v.electron || '—'],
    ['V8', v.v8 || '—'],
    ['Node.js', v.node || '—'],
  ];
  const dl = el('dl', 'about-grid');
  for (const [k, val] of rows) {
    dl.appendChild(el('dt', null, k));
    dl.appendChild(el('dd', null, val));
  }
  bodyEl.appendChild(dl);

  bodyEl.appendChild(el('span', 'engine-tag', '⚡ Renderizado pelo Chromium ' + (v.chrome || '')));
}

// ── SETTINGS — tema, motor de busca, homepage, limpar dados ───────────────────
async function renderSettings() {
  // carrega settings + aplica o idioma (segue o SO se 'auto') no documento do painel
  let settings = { theme: 'system', searchEngine: 'google', homepage: 'pilot://newtab', language: 'auto' };
  try { const s = await window.panel.settingsGet(); if (s) settings = Object.assign(settings, s); } catch {}
  try { if (window.i18n) window.i18n.setLang(settings.language || 'auto'); } catch {}
  const t = (k) => (window.i18n ? window.i18n.t(k) : k);

  titleEl.textContent = t('settings.title');
  bodyEl.innerHTML = '';

  let engines = [];
  try { engines = (await window.panel.getEngines()) || []; } catch {}
  if (!engines.length) {
    engines = [{ id: 'google', name: 'Google' }, { id: 'bing', name: 'Bing' },
      { id: 'duckduckgo', name: 'DuckDuckGo' }, { id: 'brave', name: 'Brave Search' }];
  }

  // Tema
  const themeSel = el('select');
  themeSel.id = 'set-theme';
  for (const [val, key] of [['system', 'settings.theme.system'], ['light', 'settings.theme.light'], ['dark', 'settings.theme.dark']]) {
    const o = el('option', null, t(key)); o.value = val;
    if (val === (settings.theme || 'system')) o.selected = true;
    themeSel.appendChild(o);
  }
  themeSel.addEventListener('change', () => {
    const mode = themeSel.value;
    // persiste no main (settings.json + nativeTheme + backgroundColor das janelas).
    try { window.panel.setTheme({ mode }); } catch {}
    try { window.panel.settingsSet({ theme: mode }); } catch {}
    document.body.classList.toggle('light', mode === 'light'
      || (mode === 'system' && !window.matchMedia('(prefers-color-scheme: dark)').matches));
  });
  bodyEl.appendChild(settingsRow(t('settings.theme'), t('settings.themeDesc'), themeSel));

  // Idioma (detecção automática + escolha manual)
  const langSel = el('select');
  langSel.id = 'set-language';
  const langOpts = [['auto', t('settings.language.auto')]].concat(
    (window.i18n ? window.i18n.available() : []).map((l) => [l.id, l.name]));
  for (const [val, lbl] of langOpts) {
    const o = el('option', null, lbl); o.value = val;
    if (val === (settings.language || 'auto')) o.selected = true;
    langSel.appendChild(o);
  }
  langSel.addEventListener('change', () => {
    try { window.panel.settingsSet({ language: langSel.value }); } catch {}
    try { if (window.i18n) window.i18n.setLang(langSel.value); } catch {}
    renderSettings(); // re-renderiza o painel já no novo idioma
  });
  bodyEl.appendChild(settingsRow(t('settings.language'), t('settings.languageDesc'), langSel));

  // Motor de busca
  const engSel = el('select');
  engSel.id = 'set-engine';
  for (const e of engines) {
    const o = el('option', null, e.name || e.id); o.value = e.id;
    if (e.id === settings.searchEngine) o.selected = true;
    engSel.appendChild(o);
  }
  engSel.addEventListener('change', () => {
    try { window.panel.settingsSet({ searchEngine: engSel.value }); } catch {}
  });
  bodyEl.appendChild(settingsRow(t('settings.engine'), t('settings.engineDesc'), engSel));

  // Homepage
  const homeInp = el('input');
  homeInp.type = 'text';
  homeInp.id = 'set-home';
  homeInp.value = settings.homepage || 'pilot://newtab';
  homeInp.placeholder = 'pilot://newtab';
  const persistHome = () => {
    const val = homeInp.value.trim() || 'pilot://newtab';
    homeInp.value = val;
    try { window.panel.settingsSet({ homepage: val }); } catch {}
  };
  homeInp.addEventListener('change', persistHome);
  homeInp.addEventListener('blur', persistHome);
  bodyEl.appendChild(settingsRow(t('settings.home'), t('settings.homeDesc'), homeInp));

  // Limpar dados de navegação
  const clearBtn = el('button', 'btn danger', t('settings.clearBtn'));
  clearBtn.id = 'set-clear';
  clearBtn.addEventListener('click', async () => {
    clearBtn.disabled = true;
    try { await window.panel.clearData({ range: 'all' }); } catch {}
    clearBtn.textContent = t('settings.clearDone');
    setTimeout(() => { clearBtn.textContent = t('settings.clearBtn'); clearBtn.disabled = false; }, 1800);
  });
  bodyEl.appendChild(settingsRow(t('settings.clear'), t('settings.clearDesc'), clearBtn));
}
