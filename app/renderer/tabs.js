'use strict';

/* tabs.js — TabStrip with incremental DOM reconciliation.
   Maintains the state of tabs and keeps each tab.el stable (does not use innerHTML='').
   Updates only what changed and reorders with insertBefore.
   The renderer.js creates/equips the <webview> (callbacks) — this module does NOT know about the Pilot engine. */

(function () {
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  class TabStrip {
    /**
     * @param {object} opts
     *   - container: element .tabs (HTMLElement)
     *   - makeWebview(url): creates the <webview> and returns the element
     *   - viewsContainer: where webviews live (#views)
     *   - onActivate(tab): called when the active tab changes
     *   - onAllClosed(): called when the last tab was closed (renderer recreates)
     *   - canClose(tab): returns false to prevent closure (Pilot guard); may call stop and return true
     *   - home: URL for new tab (pilot://newtab)
     */
    constructor(opts) {
      this.container = opts.container;
      this.views = opts.viewsContainer;
      this.makeWebview = opts.makeWebview;
      this.onActivate = opts.onActivate || (() => {});
      this.onAllClosed = opts.onAllClosed || (() => {});
      this.canClose = opts.canClose || (() => true);
      this.home = opts.home || 'about:blank';

      this.tabs = [];
      this.activeId = null;
      this.seq = 0;
      this.closedStack = []; // stack for ⌘⇧T (limit ~25)
    }

    // ── lifecycle ───────────────────────────────────────
    create(url, { background = false } = {}) {
      const id = ++this.seq;
      const wv = this.makeWebview(url || this.home);
      this.views.appendChild(wv);
      const tab = {
        id, wv, el: null,
        title: 'New tab', url: url || this.home,
        loading: false, favicon: null,
        audible: false, muted: false,
        piloting: false, zoomLevel: 0,
      };
      this.tabs.push(tab);
      this.render();
      if (!background || this.activeId === null) this.activate(id);
      return tab;
    }

    activate(id) {
      this.activeId = id;
      for (const t of this.tabs) t.wv.classList.toggle('active', t.id === id);
      const t = this.get(id);
      this.render();
      if (t) this.onActivate(t);
    }

    close(id) {
      const idx = this.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return;
      const tab = this.tabs[idx];
      // Pilot guard: the renderer decides (can stop the run first)
      if (!this.canClose(tab)) return;

      // undo stack (only the final URL — without resurrecting webContents history)
      this.closedStack.push({ url: tab.url, title: tab.title });
      if (this.closedStack.length > 25) this.closedStack.shift();

      try { tab.wv.remove(); } catch {}
      if (tab.el && tab.el.parentNode) tab.el.parentNode.removeChild(tab.el);
      this.tabs.splice(idx, 1);

      if (this.tabs.length === 0) { this.onAllClosed(); return; }
      if (this.activeId === id) {
        // Chrome parity: closing the active tab moves to the RIGHT (the neighbor that
        // took the slot idx after splice); only falls left if it was the last one.
        const next = this.tabs[idx] || this.tabs[idx - 1];
        this.activate(next.id);
      } else {
        this.render();
      }
    }

    reopenClosed() {
      const last = this.closedStack.pop();
      if (last) return this.create(last.url);
      return null;
    }

    // ── selection / navigation by index ──────────────────────
    get(id) { return this.tabs.find((t) => t.id === id); }
    active() { return this.get(this.activeId); }

    selectIndex(n) {
      // n is 1-based; n===9 always goes to the last (Chrome parity)
      const target = n === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[n - 1];
      if (target) this.activate(target.id);
    }
    selectRelative(delta) {
      if (!this.tabs.length) return;
      const idx = this.tabs.findIndex((t) => t.id === this.activeId);
      const next = (idx + delta + this.tabs.length) % this.tabs.length;
      this.activate(this.tabs[next].id);
    }

    // ── state mutations (renderer calls on webview events) ──
    setLoading(id, v) { const t = this.get(id); if (t && t.loading !== v) { t.loading = v; this.render(); } }
    setTitle(id, title) { const t = this.get(id); if (t) { t.title = title; this.render(); } }
    setUrl(id, url) { const t = this.get(id); if (t) t.url = url; }
    setFavicon(id, fav) { const t = this.get(id); if (t) { t.favicon = fav || null; this.render(); } }
    setAudible(id, v) { const t = this.get(id); if (t && t.audible !== v) { t.audible = v; this.render(); } }
    setPiloting(id, v) { const t = this.get(id); if (t) { t.piloting = v; this.render(); } }

    toggleMute(id) {
      const t = this.get(id); if (!t) return;
      t.muted = !t.muted;
      try { t.wv.setAudioMuted(t.muted); } catch {}
      this.render();
    }

    // ── incremental reconciliation ───────────────────────────
    render() {
      const n = this.tabs.length || 1;
      // dynamic width: clamp between minimum and 200px based on available space
      const avail = this.container.clientWidth || 0;
      const gap = 6;
      let width = 200;
      if (avail > 0) {
        width = Math.floor((avail - gap * (n - 1)) / n);
        width = Math.max(54, Math.min(200, width));
      }

      for (let i = 0; i < this.tabs.length; i++) {
        const t = this.tabs[i];
        let el = t.el;
        if (!el) {
          el = document.createElement('div');
          el.className = 'tab';
          el.dataset.tabId = String(t.id);
          el.innerHTML =
            '<span class="t-lead"></span>' +
            '<span class="t-title"></span>' +
            '<span class="t-audio" hidden></span>' +
            '<span class="t-close" title="Close tab">✕</span>';
          this._bind(el, t);
          t.el = el;
        }

        // ── icon slot (favicon ↔ spinner in the same place) ──
        const lead = el.querySelector('.t-lead');
        if (t.loading) {
          if (lead.dataset.kind !== 'spin') { lead.dataset.kind = 'spin'; lead.innerHTML = '<span class="t-spin"></span>'; }
        } else if (t.favicon) {
          if (lead.dataset.kind !== 'fav' || lead.dataset.src !== t.favicon) {
            lead.dataset.kind = 'fav'; lead.dataset.src = t.favicon;
            lead.innerHTML = `<img class="t-favicon" src="${escapeHtml(t.favicon)}" onerror="this.style.display='none'" />`;
          }
        } else if (lead.dataset.kind !== 'none') {
          lead.dataset.kind = 'none'; lead.dataset.src = ''; lead.innerHTML = '';
        }

        // ── title ──
        const titleEl = el.querySelector('.t-title');
        const title = t.title || 'New tab';
        if (titleEl.textContent !== title) titleEl.textContent = title;
        if (el.title !== title) el.title = title;

        // ── audio ──
        const audioEl = el.querySelector('.t-audio');
        if (t.audible) {
          audioEl.hidden = false;
          const glyph = t.muted ? '🔇' : '🔊';
          if (audioEl.textContent !== glyph) audioEl.textContent = glyph;
        } else if (!audioEl.hidden) {
          audioEl.hidden = true;
        }

        // ── state classes ──
        el.classList.toggle('active', t.id === this.activeId);
        el.classList.toggle('piloting', !!t.piloting);

        // ── animated width ──
        el.style.width = width + 'px';

        // ── order: ensures the node is at position i ──
        const ref = this.container.children[i];
        if (ref !== el) this.container.insertBefore(el, ref || null);
      }
    }

    _bind(el, t) {
      el.addEventListener('click', (ev) => {
        if (ev.target.classList.contains('t-close')) { ev.stopPropagation(); this.close(t.id); return; }
        if (ev.target.classList.contains('t-audio')) { ev.stopPropagation(); this.toggleMute(t.id); return; }
        this.activate(t.id);
      });
      // middle-click closes (auxclick is the canonical middle-button event)
      el.addEventListener('auxclick', (ev) => { if (ev.button === 1) { ev.preventDefault(); this.close(t.id); } });
      el.addEventListener('mousedown', (ev) => { if (ev.button === 1) ev.preventDefault(); });
    }
  }

  window.TabStrip = TabStrip;
})();
