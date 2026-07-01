'use strict';

/* bookmarks.js — Bookmarks (Chrome parity):
   - bookmarks bar (#bookmarks-bar) below toolbar: favicon + title, clickable
   - star in omnibox (#star-btn): fills when bookmarked; click adds/removes
   - manager (#bookmarks-overlay): list / remove / edit
   - persistence: stored in main (bookmarks.json); bar preference in settings/localStorage
   Cooperates with renderer.js via init({ navigate, openTab }).
   Consumes window.pilot.bookmarks* (degrades with optional chaining if missing at runtime). */

(function () {
  const LS_BAR = 'lp.showBookmarksBar'; // fallback if settings doesn't have the flag

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function hostOf(url) {
    try { return new URL(url).host; } catch { return ''; }
  }

  // fallback favicon (Google s2) when the item didn't provide a captured one
  function faviconFor(item) {
    if (item && item.favicon) return item.favicon;
    const h = hostOf(item && item.url);
    return h ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h)}&sz=32` : '';
  }

  const GLOBE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';

  class Bookmarks {
    constructor() {
      this.bar = document.getElementById('bookmarks-bar');
      this.star = document.getElementById('star-btn');
      this.overlay = document.getElementById('bookmarks-overlay');

      this.navigate = (url) => {};     // navigates in active tab
      this.openTab = (url, opts) => {}; // opens in new tab (middle-click)
      this.getActive = () => null;     // { url, title, favicon } of active tab
      this.persistBarPref = () => {};  // saves bar display preference

      this.items = [];        // cache of bar bookmarks
      this.showBar = false;   // display preference
      this._editingUrl = null; // url being edited in manager
    }

    /**
     * @param {object} o
     *  - navigate(url): navigates in active tab
     *  - openTab(url, {background}): opens new tab
     *  - getActive(): { url, title, favicon } of active tab (for the star)
     *  - showBar: initial bool (from settings)
     *  - persistBarPref(bool): persists the preference (settings + fallback)
     */
    init(o = {}) {
      this.navigate = o.navigate || (() => {});
      this.openTab = o.openTab || (() => {});
      this.getActive = o.getActive || (() => null);
      this.persistBarPref = o.persistBarPref || (() => {});

      // initial preference: settings.showBookmarksBar takes priority; otherwise localStorage
      let pref = o.showBar;
      if (typeof pref !== 'boolean') {
        try { pref = localStorage.getItem(LS_BAR) === '1'; } catch { pref = false; }
      }
      this.showBar = !!pref;
      this._applyBarVisibility();

      // star click → toggle bookmark of active tab
      if (this.star) {
        this.star.addEventListener('click', (e) => { e.preventDefault(); this.toggleCurrent(); });
      }

      // clicks on bar items (delegation): navigate in active; middle button = new tab
      if (this.bar) {
        this.bar.addEventListener('click', (e) => {
          const it = e.target.closest('.bm-item');
          if (!it) return;
          this.navigate(it.dataset.url);
        });
        this.bar.addEventListener('auxclick', (e) => {
          const it = e.target.closest('.bm-item');
          if (!it) return;
          if (e.button === 1) { e.preventDefault(); this.openTab(it.dataset.url, { background: true }); }
        });
        this.bar.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
        // context-menu / long-press → remove (quick shortcut without opening manager)
        this.bar.addEventListener('contextmenu', (e) => {
          const it = e.target.closest('.bm-item');
          if (!it) return;
          e.preventDefault();
          this.remove(it.dataset.url);
        });
      }

      // manager overlay: Esc / backdrop click
      if (this.overlay) {
        this.overlay.addEventListener('click', (e) => { if (e.target === this.overlay) this.closeManager(); });
      }

      // syncs across windows (main broadcasts on every mutation)
      try {
        if (window.pilot && window.pilot.onBookmarksChanged) {
          window.pilot.onBookmarksChanged(() => { this.refresh(); this.refreshStar(); });
        }
      } catch {}

      this.refresh();
    }

    // ── bar: data ────────────────────────────────────────
    async refresh() {
      let items = [];
      try { items = (await window.pilot?.bookmarksList?.()) || []; } catch {}
      this.items = items;
      this._renderBar();
      // if manager is open, re-render it
      if (this.overlay && !this.overlay.hidden && !this._editingUrl) this._renderManager();
    }

    _renderBar() {
      if (!this.bar) return;
      if (!this.items.length) {
        this.bar.innerHTML = '<span class="bm-empty">Bookmarks appear here — click the star ⭐ to save the current page.</span>';
        return;
      }
      this.bar.innerHTML = this.items.map((b) => {
        const fav = faviconFor(b);
        const ico = fav
          ? `<span class="bm-ico"><img src="${escapeHtml(fav)}" onerror="this.style.display='none'"/></span>`
          : `<span class="bm-ico">${GLOBE_SVG}</span>`;
        const title = b.title || hostOf(b.url) || b.url;
        return `<button type="button" class="bm-item" data-url="${escapeHtml(b.url)}" title="${escapeHtml(b.title || b.url)}">${ico}<span class="bm-title">${escapeHtml(title)}</span></button>`;
      }).join('');
    }

    // ── bar: visibility / toggle (⌘⇧B) ──────────────────
    _applyBarVisibility() {
      if (this.bar) this.bar.hidden = !this.showBar;
    }
    toggleBar() {
      this.showBar = !this.showBar;
      this._applyBarVisibility();
      try { localStorage.setItem(LS_BAR, this.showBar ? '1' : '0'); } catch {}
      try { this.persistBarPref(this.showBar); } catch {}
    }
    isBarVisible() { return this.showBar; }

    // ── star ──────────────────────────────────────────────
    setStarred(on) {
      if (!this.star) return;
      this.star.classList.toggle('starred', !!on);
      this.star.title = on ? 'Edit bookmark (⌘D)' : 'Bookmark (⌘D)';
    }

    // recomputes star state from active tab (after external changes)
    async refreshStar() {
      const a = this.getActive();
      if (!a || !a.url) { this.setStarred(false); return; }
      try {
        const yes = await window.pilot?.bookmarksIsBookmarked?.({ url: a.url });
        this.setStarred(!!yes);
      } catch { this.setStarred(false); }
    }

    // called by renderer on did-navigate of active tab
    async onActiveUrl(url) {
      if (!url) { this.setStarred(false); return; }
      try {
        const yes = await window.pilot?.bookmarksIsBookmarked?.({ url });
        this.setStarred(!!yes);
      } catch { this.setStarred(false); }
    }

    // ── mutations ─────────────────────────────────────────────
    // toggle bookmark of active tab (star + shortcut ⌘D)
    async toggleCurrent() {
      const a = this.getActive();
      if (!a || !a.url) return;
      try {
        const res = await window.pilot?.bookmarksToggle?.({ url: a.url, title: a.title, favicon: a.favicon });
        const bookmarked = !!(res && res.bookmarked);
        this.setStarred(bookmarked);
      } catch {}
      // bar/star also update via broadcast onBookmarksChanged; refresh is defensive
      this.refresh();
    }

    async add(entry) {
      try { await window.pilot?.bookmarksAdd?.(entry); } catch {}
      this.refresh();
    }
    async remove(url) {
      try { await window.pilot?.bookmarksRemove?.({ url }); } catch {}
      this.refresh();
      this.refreshStar();
    }
    async update(url, patch) {
      try { await window.pilot?.bookmarksUpdate?.({ url, patch }); } catch {}
      this.refresh();
      this.refreshStar();
    }

    // ── manager (overlay) ────────────────────────────────
    async openManager() {
      this._editingUrl = null;
      await this.refresh();
      this._renderManager();
      if (this.overlay) this.overlay.hidden = false;
    }
    closeManager() {
      this._editingUrl = null;
      if (this.overlay) this.overlay.hidden = true;
    }
    isManagerOpen() { return this.overlay && !this.overlay.hidden; }

    _renderManager() {
      if (!this.overlay) return;
      const rows = this.items.length
        ? '<div class="bm-list">' + this.items.map((b) => this._managerRow(b)).join('') + '</div>'
        : '<div class="bm-empty-manager">No bookmarks yet. Click the star in the address bar to save the current page.</div>';

      this.overlay.innerHTML =
        '<div class="overlay-card">' +
        '  <div class="overlay-head"><h2>Manage bookmarks</h2><button class="overlay-close" title="Close (Esc)">✕</button></div>' +
        '  <div class="overlay-body">' + rows + '</div>' +
        '</div>';

      this.overlay.querySelector('.overlay-close').addEventListener('click', () => this.closeManager());
      this._wireManager();
    }

    _managerRow(b) {
      const url = escapeHtml(b.url);
      if (this._editingUrl === b.url) {
        return '<div class="bm-manager-row" data-url="' + url + '">' +
          '<div class="bm-edit">' +
          '  <input class="bm-edit-title" type="text" value="' + escapeHtml(b.title || '') + '" placeholder="Title" />' +
          '  <input class="bm-edit-url" type="text" value="' + url + '" placeholder="URL" />' +
          '  <div class="bm-edit-actions">' +
          '    <button class="bm-mact bm-save">Save</button>' +
          '    <button class="bm-mact bm-cancel">Cancel</button>' +
          '  </div>' +
          '</div>' +
          '</div>';
      }
      const fav = faviconFor(b);
      const ico = fav
        ? '<span class="bm-mico"><img src="' + escapeHtml(fav) + '" onerror="this.style.display=\'none\'"/></span>'
        : '<span class="bm-mico">' + GLOBE_SVG + '</span>';
      return '<div class="bm-manager-row" data-url="' + url + '">' +
        ico +
        '<div class="bm-mbody" data-open="' + url + '">' +
        '  <div class="bm-mtitle">' + escapeHtml(b.title || hostOf(b.url) || b.url) + '</div>' +
        '  <div class="bm-murl">' + url + '</div>' +
        '</div>' +
        '<button class="bm-mact bm-edit-btn" data-url="' + url + '">Edit</button>' +
        '<button class="bm-mact danger bm-del-btn" data-url="' + url + '">Remove</button>' +
        '</div>';
    }

    _wireManager() {
      // open bookmark (click body) → navigate in active tab and close
      this.overlay.querySelectorAll('.bm-mbody[data-open]').forEach((b) => {
        b.addEventListener('click', () => { const u = b.dataset.open; this.closeManager(); this.navigate(u); });
      });
      // remove
      this.overlay.querySelectorAll('.bm-del-btn').forEach((b) => {
        b.addEventListener('click', () => this.remove(b.dataset.url));
      });
      // enter edit mode
      this.overlay.querySelectorAll('.bm-edit-btn').forEach((b) => {
        b.addEventListener('click', () => { this._editingUrl = b.dataset.url; this._renderManager(); });
      });
      // save / cancel edit
      const saveBtn = this.overlay.querySelector('.bm-save');
      if (saveBtn) {
        const row = this.overlay.querySelector('.bm-manager-row[data-url]');
        const titleInp = this.overlay.querySelector('.bm-edit-title');
        const urlInp = this.overlay.querySelector('.bm-edit-url');
        const oldUrl = this._editingUrl;
        saveBtn.addEventListener('click', async () => {
          const patch = {};
          if (titleInp) patch.title = titleInp.value.trim();
          if (urlInp && urlInp.value.trim() && urlInp.value.trim() !== oldUrl) patch.url = urlInp.value.trim();
          this._editingUrl = null;
          await this.update(oldUrl, patch);
          this._renderManager();
        });
        const cancelBtn = this.overlay.querySelector('.bm-cancel');
        if (cancelBtn) cancelBtn.addEventListener('click', () => { this._editingUrl = null; this._renderManager(); });
      }
    }
  }

  window.Bookmarks = Bookmarks;
})();
