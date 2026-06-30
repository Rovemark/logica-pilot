'use strict';

/* overlays.js — dropdown ⋮ (app menu) + overlays Settings/About/History/Downloads,
   shelf de downloads e prompt de permissão.
   Tudo chama dispatch(name) do renderer (fonte única de ação).
   Consome window.pilot.* (degrada com optional chaining se faltar em runtime). */

(function () {
  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtBytes(b) {
    if (!b && b !== 0) return '';
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let n = b;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + ' ' + u[i];
  }

  // itens do menu ⋮ (label fallback, chave i18n, ação dispatch, atalho exibido)
  const MENU_ITEMS = [
    { label: 'Nova aba', i18n: 'menu.newTab', action: 'new-tab', key: '⌘T' },
    { label: 'Nova janela', i18n: 'menu.newWindow', action: 'new-window', key: '⌘N' },
    { sep: true },
    { label: 'Localizar na página', i18n: 'menu.find', action: 'find', key: '⌘F' },
    { label: 'Modo leitor', i18n: 'menu.reader', action: 'reader', key: '⌥⌘R' },
    { label: 'Traduzir página', i18n: 'menu.translate', action: 'translate', key: '' },
    { label: 'Imprimir', i18n: 'menu.print', action: 'print', key: '⌘P' },
    { label: 'Mais zoom', i18n: 'menu.zoomIn', action: 'zoom-in', key: '⌘+' },
    { label: 'Menos zoom', i18n: 'menu.zoomOut', action: 'zoom-out', key: '⌘-' },
    { label: 'Zoom padrão', i18n: 'menu.zoomReset', action: 'zoom-reset', key: '⌘0' },
    { sep: true },
    { label: 'Histórico', i18n: 'menu.history', action: 'history', key: '⌘Y' },
    { label: 'Downloads', i18n: 'menu.downloads', action: 'downloads', key: '⌘⇧J' },
    { label: 'Extensões', i18n: 'menu.extensions', action: 'extensions', key: '' },
    { label: 'Configurações', i18n: 'menu.settings', action: 'settings', key: '⌘,' },
    { sep: true },
    { label: 'Ferramentas do desenvolvedor', i18n: 'menu.devtools', action: 'devtools', key: '⌘⌥I' },
    { label: 'Sobre o Logica Pilot', i18n: 'menu.about', action: 'about', key: '' },
  ];
  // rótulo traduzido do item (cai no label PT-BR se o i18n não estiver pronto)
  const miLabel = (it) => (window.i18n && it.i18n ? window.i18n.t(it.i18n) : it.label);
  // tradução genérica com fallback PT-BR + interpolação {var}
  const T = (key, fb, vars) => { try { return window.i18n ? window.i18n.t(key, vars) : fb; } catch (e) { return fb; } };

  class Overlays {
    constructor() {
      this.appMenu = document.getElementById('app-menu');
      this.menuBtn = document.getElementById('menu-btn');
      this.settingsEl = document.getElementById('settings-overlay');
      this.aboutEl = document.getElementById('about-overlay');
      this.historyEl = document.getElementById('history-overlay');
      this.downloadsEl = document.getElementById('downloads-overlay');
      this.shelf = document.getElementById('downloads-shelf');
      this.permEl = document.getElementById('perm-prompt');

      this.dispatch = () => {};
      this.settings = { theme: 'system', searchEngine: 'google', homepage: 'pilot://newtab' };
      this.engines = [];
      this.dlMap = new Map(); // id → estado do download
      this._permQueue = []; // fila de pedidos de permissão (um prompt por vez)
    }

    init({ dispatch, settings, engines, onSettingsChange }) {
      this.dispatch = dispatch || (() => {});
      if (settings) this.settings = Object.assign(this.settings, settings);
      if (engines) this.engines = engines;
      this.onSettingsChange = onSettingsChange || (() => {});

      this.wireMenu(); // idempotente — garante o ⋮ ligado

      // fechar overlays por Esc / clique no backdrop
      for (const o of [this.settingsEl, this.aboutEl, this.historyEl, this.downloadsEl]) {
        o.addEventListener('click', (e) => { if (e.target === o) o.hidden = true; });
      }
    }

    // Liga o ⋮ de forma IDEMPOTENTE. Chamado cedo no boot (antes dos awaits de
    // IPC) e também no init() — assim o menu funciona mesmo se o IPC demorar/falhar.
    wireMenu() {
      if (this._menuWired || !this.appMenu || !this.menuBtn) return;
      this._menuWired = true;
      this._buildMenu();
      document.addEventListener('click', (e) => {
        const tgt = e.target;
        const onBtn = tgt && tgt.closest && tgt.closest('#menu-btn');
        if (onBtn) { e.preventDefault(); e.stopPropagation(); this.openMenuNative(); return; }
        if (this.appMenu && !this.appMenu.hidden && !this.appMenu.contains(tgt)) this.closeMenu();
      }, true);
    }

    // Menu ⋮ como MENU NATIVO (Menu.popup no processo principal). O <webview> é
    // uma camada nativa do Chromium que pinta acima de qualquer HTML; um menu
    // nativo do SO fica SEMPRE acima dela. Fallback: menu HTML.
    openMenuNative() {
      if (window.pilot && window.pilot.showAppMenu) {
        const items = MENU_ITEMS.map((it) => (it.sep ? { sep: true } : { label: miLabel(it), action: it.action, key: it.key }));
        const r = this.menuBtn.getBoundingClientRect();
        const dark = document.documentElement.getAttribute('data-theme') !== 'light';
        window.pilot.showAppMenu({
          items,
          rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
          dark,
        });
      } else {
        this.toggleMenu();
      }
    }

    // ── menu ⋮ ──────────────────────────────────────────────
    _buildMenu() {
      this.appMenu.innerHTML = '';
      for (const it of MENU_ITEMS) {
        if (it.sep) { this.appMenu.appendChild(el('div', 'menu-sep')); continue; }
        const item = el('div', 'menu-item',
          '<span>' + escapeHtml(miLabel(it)) + '</span>' + (it.key ? '<span class="mi-key">' + escapeHtml(it.key) + '</span>' : ''));
        item.addEventListener('click', (e) => { e.stopPropagation(); this.closeMenu(); this.dispatch(it.action); });
        this.appMenu.appendChild(item);
      }
    }
    toggleMenu() { this.appMenu.hidden ? this.openMenu() : this.closeMenu(); }
    openMenu() { this.appMenu.hidden = false; }
    closeMenu() { this.appMenu.hidden = true; }

    anyOverlayOpen() {
      return !this.settingsEl.hidden || !this.aboutEl.hidden || !this.historyEl.hidden ||
        !this.downloadsEl.hidden || (this.permEl && !this.permEl.hidden);
    }
    closeAll() {
      this.settingsEl.hidden = true; this.aboutEl.hidden = true;
      this.historyEl.hidden = true; this.downloadsEl.hidden = true;
      // Esc no perm-prompt = negar o pedido atual (granted=false) e seguir a fila.
      if (this.permEl && !this.permEl.hidden) this.dismissPermission();
      this.closeMenu();
    }

    _card(title, bodyHtml, target) {
      target.innerHTML =
        '<div class="overlay-card">' +
        '  <div class="overlay-head"><h2>' + escapeHtml(title) + '</h2><button class="overlay-close" title="Fechar (Esc)">✕</button></div>' +
        '  <div class="overlay-body">' + bodyHtml + '</div>' +
        '</div>';
      target.querySelector('.overlay-close').addEventListener('click', () => { target.hidden = true; });
      target.hidden = false;
    }

    // ── Settings ────────────────────────────────────────────
    async openSettings() {
      const engines = this.engines.length ? this.engines
        : [{ id: 'google', name: 'Google' }, { id: 'bing', name: 'Bing' }, { id: 'duckduckgo', name: 'DuckDuckGo' }, { id: 'brave', name: 'Brave' }];
      const engOpts = engines.map((e) => '<option value="' + escapeHtml(e.id) + '"' + (e.id === this.settings.searchEngine ? ' selected' : '') + '>' + escapeHtml(e.name) + '</option>').join('');
      const theme = this.settings.theme || 'system';
      const themeOpts = ['system', 'light', 'dark'].map((m) =>
        '<option value="' + m + '"' + (m === theme ? ' selected' : '') + '>' + ({ system: 'Padrão do sistema', light: 'Claro', dark: 'Escuro' }[m]) + '</option>').join('');
      const body =
        '<div class="settings-row"><div><label>Tema</label><span class="sr-hint">Aparência da casca</span></div>' +
        '  <select id="set-theme">' + themeOpts + '</select></div>' +
        '<div class="settings-row"><div><label>Motor de busca</label><span class="sr-hint">Usado na barra de endereço</span></div>' +
        '  <select id="set-engine">' + engOpts + '</select></div>' +
        '<div class="settings-row"><div><label>Página inicial</label><span class="sr-hint">Aberta em novas abas</span></div>' +
        '  <input id="set-home" type="text" value="' + escapeHtml(this.settings.homepage || 'pilot://newtab') + '" /></div>' +
        '<div class="settings-row"><div><label>Limpar dados de navegação</label><span class="sr-hint">Cookies, cache e armazenamento</span></div>' +
        '  <button id="set-clear" class="btn-soft btn-danger">Limpar dados</button></div>';
      this._card('Configurações', body, this.settingsEl);

      const themeSel = this.settingsEl.querySelector('#set-theme');
      themeSel.addEventListener('change', () => {
        this.settings.theme = themeSel.value;
        if (window.LPTheme) window.LPTheme.apply(themeSel.value);
        this._persist({ theme: themeSel.value });
      });
      const engSel = this.settingsEl.querySelector('#set-engine');
      engSel.addEventListener('change', () => { this.settings.searchEngine = engSel.value; this._persist({ searchEngine: engSel.value }); });
      const homeInp = this.settingsEl.querySelector('#set-home');
      homeInp.addEventListener('change', () => { this.settings.homepage = homeInp.value.trim() || 'pilot://newtab'; this._persist({ homepage: this.settings.homepage }); });
      this.settingsEl.querySelector('#set-clear').addEventListener('click', async () => {
        try { await window.pilot?.clearData?.({ range: 'all' }); } catch {}
        const btn = this.settingsEl.querySelector('#set-clear');
        if (btn) { btn.textContent = 'Dados limpos ✓'; setTimeout(() => { btn.textContent = 'Limpar dados'; }, 1800); }
      });
    }

    _persist(patch) {
      try { window.pilot?.settingsSet?.(patch); } catch {}
      this.onSettingsChange(patch);
    }

    // ── About (prova visual de Chromium) ────────────────────
    async openAbout() {
      const v = (window.pilot && window.pilot.versions) || {};
      let appVersion = '';
      try { const info = await window.pilot?.appInfo?.(); if (info) { appVersion = info.appVersion || ''; } } catch {}
      const rows = [
        [T('about.version', 'Versão'), appVersion || '—'],
        ['Chromium', v.chrome || '—'],
        ['Electron', v.electron || '—'],
        ['V8', v.v8 || '—'],
        ['Node.js', v.node || '—'],
      ];
      const body =
        '<div class="about-hero"><span class="brand-mark">◢</span><div><strong>Logica Pilot</strong>' +
        '<div class="sr-hint">' + escapeHtml(T('about.tagline', 'Navegador autônomo · motor Chromium')) + '</div></div></div>' +
        '<dl class="about-grid">' + rows.map((r) => '<dt>' + escapeHtml(r[0]) + '</dt><dd>' + escapeHtml(r[1]) + '</dd>').join('') + '</dl>';
      this._card(T('about.title', 'Sobre'), body, this.aboutEl);
    }

    // ── Histórico ───────────────────────────────────────────
    async openHistory() {
      let items = [];
      try { items = (await window.pilot?.historyRecent?.({ limit: 100 })) || []; } catch {}
      const list = items.length
        ? '<div class="hist-list">' + items.map((h) =>
            '<div class="hist-item" data-url="' + escapeHtml(h.url) + '"><span class="hi-title">' + escapeHtml(h.title || h.url) + '</span>' +
            '<span class="hi-url">' + escapeHtml(h.url) + '</span></div>').join('') + '</div>'
        : '<p class="sr-hint">' + escapeHtml(T('history.empty', 'Sem histórico ainda.')) + '</p>';
      const body = '<div class="settings-row"><label>' + escapeHtml(T('history.recent', 'Histórico recente')) + '</label><button id="hist-clear" class="btn-soft btn-danger">' + escapeHtml(T('history.clear', 'Limpar histórico')) + '</button></div>' + list;
      this._card(T('menu.history', 'Histórico'), body, this.historyEl);

      this.historyEl.querySelectorAll('.hist-item').forEach((it) => {
        it.addEventListener('click', () => { this.historyEl.hidden = true; this.dispatch('open-url', it.dataset.url); });
      });
      const clr = this.historyEl.querySelector('#hist-clear');
      if (clr) clr.addEventListener('click', async () => { try { await window.pilot?.historyClear?.({ range: 'all' }); } catch {} this.openHistory(); });
    }

    // ── Downloads ───────────────────────────────────────────
    async openDownloads() {
      let items = [];
      try { items = (await window.pilot?.downloadsList?.()) || []; } catch {}
      // mescla com eventos vivos
      for (const d of this.dlMap.values()) {
        if (!items.find((x) => x.id === d.id)) items.unshift(d);
      }
      const list = items.length
        ? '<div class="dl-list">' + items.map((d) => this._dlRow(d)).join('') + '</div>'
        : '<p class="sr-hint">' + escapeHtml(T('downloads.empty', 'Nenhum download.')) + '</p>';
      this._card(T('menu.downloads', 'Downloads'), list, this.downloadsEl);
      this._wireDlActions(this.downloadsEl);
    }

    _dlRow(d) {
      const pct = d.totalBytes ? Math.min(100, Math.round((d.receivedBytes / d.totalBytes) * 100)) : 0;
      const stateLabel = { started: T('dl.downloading', 'baixando…'), progress: T('dl.downloading', 'baixando…'), completed: T('dl.completed', 'concluído'), cancelled: T('dl.cancelled', 'cancelado'), interrupted: T('dl.interrupted', 'interrompido') }[d.state] || (d.state || '');
      const acts = d.state === 'completed'
        ? '<button class="dl-act" data-id="' + escapeHtml(d.id) + '" data-act="open">' + escapeHtml(T('dl.open', 'Abrir')) + '</button><button class="dl-act" data-id="' + escapeHtml(d.id) + '" data-act="showInFolder">' + escapeHtml(T('dl.show', 'Mostrar')) + '</button>'
        : '<button class="dl-act" data-id="' + escapeHtml(d.id) + '" data-act="cancel">' + escapeHtml(T('dl.cancel', 'Cancelar')) + '</button>';
      return '<div class="dl-item"><span class="dl-name">' + escapeHtml(d.filename || d.url || '') + '</span>' +
        (d.state === 'completed' ? '' : '<span class="dl-bar"><i style="width:' + pct + '%"></i></span>') +
        '<span class="dl-state">' + escapeHtml(stateLabel) + '</span>' + acts + '</div>';
    }

    _wireDlActions(scope) {
      scope.querySelectorAll('.dl-act').forEach((b) => {
        b.addEventListener('click', async () => {
          try { await window.pilot?.downloadsAction?.({ id: b.dataset.id, action: b.dataset.act }); } catch {}
          if (b.dataset.act === 'cancel') this.openDownloads();
        });
      });
    }

    // ── eventos de download (renderer pluga onDownloadEvent) ──
    onDownload(d) {
      if (!d || d.id == null) return;
      this.dlMap.set(d.id, Object.assign(this.dlMap.get(d.id) || {}, d));
      this._renderShelf();
      if (!this.downloadsEl.hidden) this.openDownloads();
    }

    _renderShelf() {
      const active = [...this.dlMap.values()].filter((d) => d.state && d.state !== 'cancelled');
      const recent = active.slice(-3);
      if (!recent.length) { this.shelf.hidden = true; return; }
      this.shelf.innerHTML = recent.map((d) => {
        const pct = d.totalBytes ? Math.min(100, Math.round((d.receivedBytes / d.totalBytes) * 100)) : (d.state === 'completed' ? 100 : 0);
        const label = d.state === 'completed' ? '✓' : fmtBytes(d.receivedBytes);
        return '<span class="dl-chip"><span>' + escapeHtml(d.filename || '') + '</span>' +
          '<span class="dl-bar"><i style="width:' + pct + '%"></i></span><span>' + escapeHtml(label) + '</span></span>';
      }).join('') + '<button class="dl-close" title="Fechar">✕</button>' +
        '<span class="dl-chip" id="dl-open-all" style="cursor:default">' + escapeHtml(T('dl.viewAll', 'Ver tudo')) + '</span>';
      this.shelf.hidden = false;
      const close = this.shelf.querySelector('.dl-close');
      if (close) close.addEventListener('click', () => { this.shelf.hidden = true; });
      const openAll = this.shelf.querySelector('#dl-open-all');
      if (openAll) openAll.addEventListener('click', () => this.openDownloads());
    }

    // ── prompt de permissão (fila: um pedido por vez) ───────
    showPermission(req) {
      if (!req) return;
      this._permQueue.push(req);
      // se já há um prompt visível (botões ainda não clicados), só enfileira.
      if (!this.permEl.hidden) return;
      this._renderNextPermission();
    }

    // renderiza o próximo pedido da fila (ou esconde o prompt se vazia)
    _renderNextPermission() {
      const req = this._permQueue[0];
      if (!req) { this.permEl.hidden = true; this.permEl.innerHTML = ''; this._curPerm = null; return; }
      this._curPerm = req;
      const labels = {
        media: T('perm.media', 'usar câmera/microfone'),
        geolocation: T('perm.geolocation', 'acessar sua localização'),
        notifications: T('perm.notifications', 'enviar notificações'),
      };
      const what = labels[req.permission] || T('perm.generic', 'usar: ' + req.permission, { what: req.permission });
      const origin = req.origin || T('perm.site', 'O site');
      const text = T('perm.text', escapeHtml(origin) + ' quer ' + escapeHtml(what) + '.',
        { origin: escapeHtml(origin), what: escapeHtml(what) });
      this.permEl.innerHTML =
        '<span class="pp-text">' + text + '</span>' +
        '<button class="pp-allow">' + escapeHtml(T('perm.allow', 'Permitir')) + '</button>' +
        '<button class="pp-deny">' + escapeHtml(T('perm.deny', 'Bloquear')) + '</button>';
      this.permEl.hidden = false;
      this.permEl.querySelector('.pp-allow').addEventListener('click', () => this._respondPermission(true));
      this.permEl.querySelector('.pp-deny').addEventListener('click', () => this._respondPermission(false));
    }

    // responde o pedido atual (no topo da fila) e avança para o próximo
    _respondPermission(granted) {
      const req = this._permQueue.shift();
      if (req) { try { window.pilot?.permissionRespond?.({ requestId: req.requestId, granted }); } catch {} }
      this._curPerm = null;
      this._renderNextPermission();
    }

    // Esc / closeAll: nega o pedido atual (granted=false) e processa a fila.
    dismissPermission() {
      if (this.permEl.hidden && !this._permQueue.length) return;
      this._respondPermission(false);
    }
    hidePermission() { this.dismissPermission(); }
  }

  window.Overlays = Overlays;
})();
