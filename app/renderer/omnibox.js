'use strict';

/* omnibox.js — address bar styled after the browser.
   - dropdown suggestions (debounce → window.pilot.historyQuery + search suggestion)
   - navigation ↑/↓/Enter/Esc
   - select-all on first focus; Esc restores tab's URL
   - clean display (hides https://, highlights host) when unfocused
   - REAL lock icon (http/https/error) replacing the static one
   Cooperates with renderer.js via init({ getActiveUrl, navigate, settings }). */

(function () {
  const HOME = 'pilot://newtab';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // splits host from rest for highlighting (without hiding the real host — anti-spoofing)
  function splitUrl(url) {
    try {
      const u = new URL(url);
      const scheme = u.protocol === 'http:' ? 'http://' : '';
      const host = u.host;
      const rest = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
      return { scheme, host, rest, ok: true };
    } catch { return { ok: false }; }
  }

  // fallback favicon (Google s2) derived from URL host — same as history icons.
  function faviconFromUrl(url) {
    try {
      const h = new URL(url).host;
      return h ? 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(h) + '&sz=32' : '';
    } catch { return ''; }
  }

  // text displayed when the field is NOT focused (hides https://)
  function displayValue(url) {
    if (!url || url === HOME) return '';
    if (/^pilot:\/\//.test(url) || /^about:/.test(url)) return '';
    const s = splitUrl(url);
    if (!s.ok) return url;
    return s.scheme + s.host + s.rest;
  }

  class Omnibox {
    constructor() {
      this.input = document.getElementById('address');
      this.form = document.getElementById('address-form');
      this.lock = document.getElementById('lock');
      this.suggest = document.getElementById('omni-suggest');
      this.lockSvg = this.lock ? this.lock.innerHTML : '';

      this.realUrl = '';      // real URL of active tab
      this.selectedOnFocus = false;
      this.items = [];        // current suggestions
      this.cursor = -1;       // selected index in dropdown
      this.debounce = null;
      this.settings = { searchEngine: 'google', homepage: HOME };
    }

    init({ getActiveUrl, navigate, settings }) {
      this.getActiveUrl = getActiveUrl || (() => '');
      this.navigate = navigate || (() => {});
      if (settings) this.settings = Object.assign(this.settings, settings);

      // form submit
      this.form.addEventListener('submit', (e) => {
        e.preventDefault();
        const sel = this.cursor >= 0 ? this.items[this.cursor] : null;
        const value = sel ? sel.value : this.input.value;
        this.hideSuggest();
        this.navigate(this.normalizeUrl(value));
        this.input.blur();
      });

      // focus: select-all on first interaction + show raw URL for editing
      this.input.addEventListener('focus', () => {
        if (this.realUrl) this.input.value = this.realUrl;
        if (!this.selectedOnFocus) { this.selectedOnFocus = true; this.input.select(); }
      });
      this.input.addEventListener('blur', () => {
        this.selectedOnFocus = false;
        // small delay to allow clicking a suggestion before hiding
        setTimeout(() => this.hideSuggest(), 120);
        this.renderDisplay();
      });

      this.input.addEventListener('input', () => {
        this.cursor = -1;
        this.querySuggest(this.input.value);
      });

      this.input.addEventListener('keydown', (e) => this.onKey(e));

      // click on suggestion (fallback HTML — when floating window doesn't exist)
      this.suggest.addEventListener('mousedown', (e) => {
        const it = e.target.closest('.omni-item');
        if (!it) return;
        e.preventDefault();
        const i = Number(it.dataset.i);
        this.chooseAt(i);
      });

      // click on suggestion IN FLOATING WINDOW → same action as Enter on that index.
      if (window.pilot && window.pilot.onOmniChosen) {
        window.pilot.onOmniChosen((index) => this.chooseAt(index));
      }
    }

    // does the floating suggestions window exist? (IPC present in runtime)
    _useFloat() { return !!(window.pilot && window.pilot.omniOpen); }

    // current theme (mirrors main renderer: data-theme !== 'light' = dark)
    _dark() { return document.documentElement.getAttribute('data-theme') !== 'light'; }

    // rect of .address-wrap (the form) to position floating window just below it.
    _rect() {
      try {
        const r = this.form.getBoundingClientRect();
        return { x: r.left, bottom: r.bottom, width: r.width };
      } catch { return null; }
    }

    // applies Enter action on index i (navigate/search) — used by click
    // (fallback HTML and floating window). Same normalization as form submit.
    chooseAt(i) {
      const item = this.items[i];
      if (!item) return;
      this.hideSuggest();
      this.navigate(this.normalizeUrl(item.value));
      this.input.blur();
    }

    // mirrors current list (items + selected index + theme) to floating window.
    // open=true opens on first call (passing rect); otherwise updates same window.
    _floatSync(open) {
      if (!this._useFloat()) return;
      // enriches favicon same as fallback HTML: captured one OR derived from
      // host (Google s2). Preserves other fields the floating window uses.
      const items = this.items.map((it) => ({
        type: it.type,
        value: it.value,
        title: it.title,
        url: it.url,
        favicon: it.type === 'search' ? '' : (it.favicon || faviconFromUrl(it.url || it.value)),
      }));
      const payload = { items, selected: this.cursor, dark: this._dark(), rect: this._rect() };
      try {
        if (open || !this._floatShown) { window.pilot.omniOpen(payload); this._floatShown = true; }
        else window.pilot.omniUpdate(payload);
      } catch {}
    }

    _floatClose() {
      if (!this._useFloat()) return;
      this._floatShown = false;
      try { window.pilot.omniClose(); } catch {}
    }

    // called by renderer when switching tabs / navigating
    setUrl(url) {
      this.realUrl = (url && url !== HOME && !/^pilot:\/\//.test(url) && !/^about:/.test(url)) ? url : '';
      this.setSecurity(url);
      if (document.activeElement !== this.input) this.renderDisplay();
    }

    renderDisplay() {
      const url = this.realUrl || this.getActiveUrl();
      this.input.value = displayValue(url);
    }

    // ── real lock icon ────────────────────────────────────────
    setSecurity(url, errored) {
      if (!this.lock) return;
      this.lock.classList.remove('secure', 'insecure', 'error');
      if (errored) {
        this.lock.classList.add('error');
        this.lock.title = 'Certificate / connection error';
        this.lock.innerHTML = this.lockSvg;
        return;
      }
      if (!url || url === HOME || /^pilot:\/\//.test(url) || /^about:/.test(url)) {
        this.lock.title = 'Internal page';
        this.lock.innerHTML = this.lockSvg;
        return;
      }
      if (/^https:\/\//i.test(url)) {
        this.lock.classList.add('secure');
        this.lock.title = 'Secure connection';
        this.lock.innerHTML = this.lockSvg;
      } else if (/^http:\/\//i.test(url)) {
        this.lock.classList.add('insecure');
        this.lock.title = 'Not secure';
        // warning icon + text label (parity with browser)
        this.lock.innerHTML =
          '<svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>' +
          '<span class="lock-label">Not secure</span>';
      } else {
        this.lock.title = '';
        this.lock.innerHTML = this.lockSvg;
      }
    }

    // ── suggestions ───────────────────────────────────────────
    querySuggest(q) {
      clearTimeout(this.debounce);
      const prefix = (q || '').trim();
      if (!prefix) { this.hideSuggest(); return; }
      this.debounce = setTimeout(async () => {
        const items = [];
        // history (via main, if available)
        try {
          if (window.pilot && window.pilot.historyQuery) {
            const hits = await window.pilot.historyQuery({ prefix, limit: 6 });
            for (const h of (hits || [])) {
              items.push({ type: 'history', value: h.url, title: h.title || '', url: h.url, favicon: h.favicon });
            }
          }
        } catch {}
        // search suggestion via default engine
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(prefix)) {
          items.push({ type: 'search', value: prefix, title: 'Search ' + prefix, url: null });
        } else {
          items.unshift({ type: 'url', value: prefix, title: '', url: prefix });
        }
        this.items = items.slice(0, 8);
        this.cursor = -1;
        this.renderSuggest();
      }, 120);
    }

    renderSuggest() {
      if (!this.items.length) { this.hideSuggest(); return; }

      // Primary path: FLOATING WINDOW (OS layer, above <webview>).
      // We mirror the list there and keep #omni-suggest HTML HIDDEN (it would
      // be behind the webview and still shrink active tab via :has()).
      if (this._useFloat()) {
        this.suggest.hidden = true;
        this._floatSync(true);
        return;
      }

      // Fallback HTML (no floating window): dropdown #omni-suggest (behind webview).
      const html = this.items.map((it, i) => {
        let main;
        if (it.type === 'search') {
          main = '<span class="oi-main">' + escapeHtml(it.title) + '</span>';
        } else {
          const s = splitUrl(it.url || it.value);
          if (s.ok) main = '<span class="oi-main"><span class="oi-host">' + escapeHtml(s.host) + '</span><span class="oi-rest">' + escapeHtml(s.rest) + '</span></span>';
          else main = '<span class="oi-main">' + escapeHtml(it.value) + '</span>';
          if (it.title && it.type === 'history') main += '<span class="oi-title">' + escapeHtml(it.title) + '</span>';
        }
        // favicon: captured one (if any) or derived from host (Google s2),
        // same as history icons. onerror hides broken <img>.
        const favSrc = it.favicon || faviconFromUrl(it.url || it.value);
        const ico = it.type === 'search'
          ? '<span class="oi-ico"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></span>'
          : (favSrc ? '<span class="oi-ico"><img src="' + escapeHtml(favSrc) + '" onerror="this.style.display=\'none\'"/></span>'
                    : '<span class="oi-ico"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg></span>');
        return '<div class="omni-item" data-i="' + i + '" role="option"' + (i === this.cursor ? ' aria-selected="true"' : '') + '>' + ico + main + '</div>';
      }).join('');
      this.suggest.innerHTML = html;
      this.suggest.hidden = false;
    }

    hideSuggest() {
      this.suggest.hidden = true; this.suggest.innerHTML = '';
      this.items = []; this.cursor = -1;
      this._floatClose(); // close floating window (Esc/blur/navigate/empty list)
    }

    onKey(e) {
      if (e.key === 'ArrowDown') {
        if (!this.items.length) return;
        e.preventDefault();
        this.cursor = Math.min(this.items.length - 1, this.cursor + 1);
        this.syncCursor();
      } else if (e.key === 'ArrowUp') {
        if (!this.items.length) return;
        e.preventDefault();
        this.cursor = Math.max(-1, this.cursor - 1);
        this.syncCursor();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (!this.suggest.hidden) { this.hideSuggest(); }
        // restores real URL and removes focus
        this.renderDisplay();
        this.input.blur();
      }
      // Enter is handled by form submit (uses this.cursor)
    }

    syncCursor() {
      // fallback HTML: updates aria-selected on visible items (if any)
      const opts = this.suggest.querySelectorAll('.omni-item');
      opts.forEach((o, i) => o.setAttribute('aria-selected', i === this.cursor ? 'true' : 'false'));
      // floating window: resend items + new selected index (same window)
      this._floatSync(false);
      if (this.cursor >= 0 && this.items[this.cursor]) {
        const it = this.items[this.cursor];
        this.input.value = it.type === 'search' ? it.value : (it.url || it.value);
      }
    }

    // ── normalization (reads engine/homepage from settings) ───────
    normalizeUrl(input) {
      const s = (input || '').trim();
      if (!s) return this.settings.homepage || HOME;
      if (/^pilot:\/\//i.test(s) || /^about:/i.test(s)) return s;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return s;
      if (s === 'localhost' || /^localhost:\d+/.test(s)) return 'http://' + s;
      // unique token ending in file extension (e.g., 'file.pdf', 'setup.dmg')
      // is NOT a domain → search (parity with browser).
      const FILE_EXT = /\.(pdf|docx?|xlsx?|pptx?|txt|csv|png|jpe?g|gif|webp|svg|zip|rar|7z|gz|tar|mp3|mp4|mov|avi|mkv|wav|exe|dmg|pkg|iso|app|html?)$/i;
      if (/^[^\s]+\.[^\s]{2,}$/.test(s) && !s.includes(' ') && !FILE_EXT.test(s)) return 'https://' + s;
      return this.searchUrl(s);
    }

    searchUrl(q) {
      const tpl = (this.settings && this.settings.searchTemplate)
        || ENGINE_TEMPLATES[(this.settings && this.settings.searchEngine) || 'google']
        || ENGINE_TEMPLATES.google;
      return tpl.replace('{q}', encodeURIComponent(q));
    }

    updateSettings(patch) { if (patch) this.settings = Object.assign(this.settings, patch); }
  }

  // local fallback templates (if main doesn't return the catalog)
  const ENGINE_TEMPLATES = {
    google: 'https://www.google.com/search?q={q}',
    bing: 'https://www.bing.com/search?q={q}',
    duckduckgo: 'https://duckduckgo.com/?q={q}',
    brave: 'https://search.brave.com/search?q={q}',
  };

  window.Omnibox = Omnibox;
})();
