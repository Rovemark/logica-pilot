'use strict';

/* overlays.js — dropdown ⋮ (app menu) + overlays Settings/About/History/Downloads,
   downloads shelf and permission prompt.
   Everything calls dispatch(name) from the renderer (single source of action).
   Consumes window.pilot.* (degrades with optional chaining if missing at runtime). */

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

  // menu items ⋮ (label fallback, i18n key, dispatch action, displayed shortcut)
  const MENU_ITEMS = [
    { label: 'New Tab', i18n: 'menu.newTab', action: 'new-tab', key: '⌘T' },
    { label: 'New Window', i18n: 'menu.newWindow', action: 'new-window', key: '⌘N' },
    { sep: true },
    { label: 'Find in page', i18n: 'menu.find', action: 'find', key: '⌘F' },
    { label: 'Reader mode', i18n: 'menu.reader', action: 'reader', key: '⌥⌘R' },
    { label: 'Translate page', i18n: 'menu.translate', action: 'translate', key: '' },
    { label: 'Print', i18n: 'menu.print', action: 'print', key: '⌘P' },
    { label: 'Zoom in', i18n: 'menu.zoomIn', action: 'zoom-in', key: '⌘+' },
    { label: 'Zoom out', i18n: 'menu.zoomOut', action: 'zoom-out', key: '⌘-' },
    { label: 'Reset zoom', i18n: 'menu.zoomReset', action: 'zoom-reset', key: '⌘0' },
    { sep: true },
    { label: 'History', i18n: 'menu.history', action: 'history', key: '⌘Y' },
    { label: 'Downloads', i18n: 'menu.downloads', action: 'downloads', key: '⌘⇧J' },
    { label: 'Extensions', i18n: 'menu.extensions', action: 'extensions', key: '' },
    { label: 'Settings', i18n: 'menu.settings', action: 'settings', key: '⌘,' },
    { sep: true },
    { label: 'Developer tools', i18n: 'menu.devtools', action: 'devtools', key: '⌘⌥I' },
    { label: 'About Logica Pilot', i18n: 'menu.about', action: 'about', key: '' },
  ];
  // translated label for item (falls back to English label if i18n not ready)
  const miLabel = (it) => (window.i18n && it.i18n ? window.i18n.t(it.i18n) : it.label);
  // generic translation with English fallback + interpolation {var}
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
      this.dlMap = new Map(); // id → download state
      this._permQueue = []; // permission request queue (one prompt at a time)
    }

    init({ dispatch, settings, engines, onSettingsChange }) {
      this.dispatch = dispatch || (() => {});
      if (settings) this.settings = Object.assign(this.settings, settings);
      if (engines) this.engines = engines;
      this.onSettingsChange = onSettingsChange || (() => {});

      this.wireMenu(); // idempotent — ensures the ⋮ is wired up

      // close overlays on Esc / backdrop click
      for (const o of [this.settingsEl, this.aboutEl, this.historyEl, this.downloadsEl]) {
        o.addEventListener('click', (e) => { if (e.target === o) o.hidden = true; });
      }
    }

    // Wires the ⋮ in IDEMPOTENT manner. Called early during boot (before IPC
    // awaits) and also in init() — so menu works even if IPC is delayed/fails.
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

    // Menu ⋮ as NATIVE MENU (Menu.popup in the main process). The <webview> is
    // a native browser engine layer that paints above any HTML; a native OS menu
    // stays ALWAYS above it. Fallback: HTML menu.
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
      // Esc on perm-prompt = deny current request (granted=false) and process queue.
      if (this.permEl && !this.permEl.hidden) this.dismissPermission();
      this.closeMenu();
    }

    _card(title, bodyHtml, target) {
      target.innerHTML =
        '<div class="overlay-card">' +
        '  <div class="overlay-head"><h2>' + escapeHtml(title) + '</h2><button class="overlay-close" title="Close (Esc)">✕</button></div>' +
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
        '<option value="' + m + '"' + (m === theme ? ' selected' : '') + '>' + ({ system: 'System default', light: 'Light', dark: 'Dark' }[m]) + '</option>').join('');
      const body =
        '<div class="settings-row"><div><label>Theme</label><span class="sr-hint">Browser shell appearance</span></div>' +
        '  <select id="set-theme">' + themeOpts + '</select></div>' +
        '<div class="settings-row"><div><label>Search engine</label><span class="sr-hint">Used in the address bar</span></div>' +
        '  <select id="set-engine">' + engOpts + '</select></div>' +
        '<div class="settings-row"><div><label>Home page</label><span class="sr-hint">Opened in new tabs</span></div>' +
        '  <input id="set-home" type="text" value="' + escapeHtml(this.settings.homepage || 'pilot://newtab') + '" /></div>' +
        '<div class="settings-row"><div><label>Clear browsing data</label><span class="sr-hint">Cookies, cache and storage</span></div>' +
        '  <button id="set-clear" class="btn-soft btn-danger">Clear data</button></div>';
      this._card('Settings', body, this.settingsEl);

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
        if (btn) { btn.textContent = 'Data cleared ✓'; setTimeout(() => { btn.textContent = 'Clear data'; }, 1800); }
      });
    }

    _persist(patch) {
      try { window.pilot?.settingsSet?.(patch); } catch {}
      this.onSettingsChange(patch);
    }

    // ── About (visual proof of browser engine) ────────────────────
    async openAbout() {
      const v = (window.pilot && window.pilot.versions) || {};
      let appVersion = '';
      try { const info = await window.pilot?.appInfo?.(); if (info) { appVersion = info.appVersion || ''; } } catch {}
      const rows = [
        [T('about.version', 'Version'), appVersion || '—'],
        ['Browser Engine', v.chrome || '—'],
        ['Electron', v.electron || '—'],
        ['V8', v.v8 || '—'],
        ['Node.js', v.node || '—'],
      ];
      const body =
        '<div class="about-hero"><span class="brand-mark">◢</span><div><strong>Logica Pilot</strong>' +
        '<div class="sr-hint">' + escapeHtml(T('about.tagline', 'Autonomous browser · native browser engine')) + '</div></div></div>' +
        '<dl class="about-grid">' + rows.map((r) => '<dt>' + escapeHtml(r[0]) + '</dt><dd>' + escapeHtml(r[1]) + '</dd>').join('') + '</dl>';
      this._card(T('about.title', 'About'), body, this.aboutEl);
    }

    // ── History ───────────────────────────────────────────
    async openHistory() {
      let items = [];
      try { items = (await window.pilot?.historyRecent?.({ limit: 100 })) || []; } catch {}
      const list = items.length
        ? '<div class="hist-list">' + items.map((h) =>
            '<div class="hist-item" data-url="' + escapeHtml(h.url) + '"><span class="hi-title">' + escapeHtml(h.title || h.url) + '</span>' +
            '<span class="hi-url">' + escapeHtml(h.url) + '</span></div>').join('') + '</div>'
        : '<p class="sr-hint">' + escapeHtml(T('history.empty', 'No history yet.')) + '</p>';
      const body = '<div class="settings-row"><label>' + escapeHtml(T('history.recent', 'Recent history')) + '</label><button id="hist-clear" class="btn-soft btn-danger">' + escapeHtml(T('history.clear', 'Clear history')) + '</button></div>' + list;
      this._card(T('menu.history', 'History'), body, this.historyEl);

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
      // merge with live events
      for (const d of this.dlMap.values()) {
        if (!items.find((x) => x.id === d.id)) items.unshift(d);
      }
      const list = items.length
        ? '<div class="dl-list">' + items.map((d) => this._dlRow(d)).join('') + '</div>'
        : '<p class="sr-hint">' + escapeHtml(T('downloads.empty', 'No downloads.')) + '</p>';
      this._card(T('menu.downloads', 'Downloads'), list, this.downloadsEl);
      this._wireDlActions(this.downloadsEl);
    }

    _dlRow(d) {
      const pct = d.totalBytes ? Math.min(100, Math.round((d.receivedBytes / d.totalBytes) * 100)) : 0;
      const stateLabel = { started: T('dl.downloading', 'downloading…'), progress: T('dl.downloading', 'downloading…'), completed: T('dl.completed', 'completed'), cancelled: T('dl.cancelled', 'cancelled'), interrupted: T('dl.interrupted', 'interrupted') }[d.state] || (d.state || '');
      const acts = d.state === 'completed'
        ? '<button class="dl-act" data-id="' + escapeHtml(d.id) + '" data-act="open">' + escapeHtml(T('dl.open', 'Open')) + '</button><button class="dl-act" data-id="' + escapeHtml(d.id) + '" data-act="showInFolder">' + escapeHtml(T('dl.show', 'Show')) + '</button>'
        : '<button class="dl-act" data-id="' + escapeHtml(d.id) + '" data-act="cancel">' + escapeHtml(T('dl.cancel', 'Cancel')) + '</button>';
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

    // ── download events (renderer plugs onDownloadEvent) ──
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
      }).join('') + '<button class="dl-close" title="Close">✕</button>' +
        '<span class="dl-chip" id="dl-open-all" style="cursor:default">' + escapeHtml(T('dl.viewAll', 'View all')) + '</span>';
      this.shelf.hidden = false;
      const close = this.shelf.querySelector('.dl-close');
      if (close) close.addEventListener('click', () => { this.shelf.hidden = true; });
      const openAll = this.shelf.querySelector('#dl-open-all');
      if (openAll) openAll.addEventListener('click', () => this.openDownloads());
    }

    // ── permission prompt (queue: one request at a time) ───────
    showPermission(req) {
      if (!req) return;
      this._permQueue.push(req);
      // if a prompt is already visible (buttons not clicked yet), just enqueue.
      if (!this.permEl.hidden) return;
      this._renderNextPermission();
    }

    // renders next request from queue (or hides prompt if empty)
    _renderNextPermission() {
      const req = this._permQueue[0];
      if (!req) { this.permEl.hidden = true; this.permEl.innerHTML = ''; this._curPerm = null; return; }
      this._curPerm = req;
      const labels = {
        media: T('perm.media', 'use camera/microphone'),
        geolocation: T('perm.geolocation', 'access your location'),
        notifications: T('perm.notifications', 'send notifications'),
      };
      const what = labels[req.permission] || T('perm.generic', 'use: ' + req.permission, { what: req.permission });
      const origin = req.origin || T('perm.site', 'The site');
      const text = T('perm.text', escapeHtml(origin) + ' wants ' + escapeHtml(what) + '.',
        { origin: escapeHtml(origin), what: escapeHtml(what) });
      this.permEl.innerHTML =
        '<span class="pp-text">' + text + '</span>' +
        '<button class="pp-allow">' + escapeHtml(T('perm.allow', 'Allow')) + '</button>' +
        '<button class="pp-deny">' + escapeHtml(T('perm.deny', 'Deny')) + '</button>';
      this.permEl.hidden = false;
      this.permEl.querySelector('.pp-allow').addEventListener('click', () => this._respondPermission(true));
      this.permEl.querySelector('.pp-deny').addEventListener('click', () => this._respondPermission(false));
    }

    // responds to current request (at top of queue) and advances to next
    _respondPermission(granted) {
      const req = this._permQueue.shift();
      if (req) { try { window.pilot?.permissionRespond?.({ requestId: req.requestId, granted }); } catch {} }
      this._curPerm = null;
      this._renderNextPermission();
    }

    // Esc / closeAll: deny current request (granted=false) and process queue.
    dismissPermission() {
      if (this.permEl.hidden && !this._permQueue.length) return;
      this._respondPermission(false);
    }
    hidePermission() { this.dismissPermission(); }
  }

  window.Overlays = Overlays;
})();
