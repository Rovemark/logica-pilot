'use strict';

/* findbar.js — find on page (⌘F).
   Uses the webview's own API (wv.findInPage / found-in-page event),
   without IPC (per spec §2.3). Counter n/N + prev/next/✕. */

(function () {
  class FindBar {
    constructor() {
      this.bar = document.getElementById('findbar');
      this.input = document.getElementById('find-input');
      this.count = document.getElementById('find-count');
      this.prevBtn = document.getElementById('find-prev');
      this.nextBtn = document.getElementById('find-next');
      this.closeBtn = document.getElementById('find-close');

      this.getActiveWebview = () => null;
      this.boundWv = null;        // webview with listener attached
      this.onFound = null;
      this.lastRequestId = 0;
      // Primary path: Find bar as FLOATING WINDOW (OS layer,
      // above the <webview>). The floating window owns the search while open — so
      // this module only tracks whether it is open (for ⌘G/⌘⇧G and close on Esc).
      this._floatOpen = false;
    }

    // Does the floating window exist? (IPC present at runtime)
    _useFloat() { return !!(window.pilot && window.pilot.findOpen); }

    init({ getActiveWebview }) {
      this.getActiveWebview = getActiveWebview || (() => null);

      this.input.addEventListener('input', () => this.search(true));
      this.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.search(!e.shiftKey, true); }
        else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
      });
      this.prevBtn.addEventListener('click', () => this.search(false, true));
      this.nextBtn.addEventListener('click', () => this.search(true, true));
      this.closeBtn.addEventListener('click', () => this.close());
    }

    // isOpen reflects the floating window (primary path) or the HTML bar (fallback).
    get isOpen() { return this._useFloat() ? this._floatOpen : !this.bar.hidden; }

    open() {
      if (this._useFloat()) {
        const dark = document.documentElement.getAttribute('data-theme') !== 'light';
        // pre-fills with current page selection, if any (parity with the browser).
        let query = '';
        try { query = (window.getSelection && String(window.getSelection())) || ''; } catch {}
        try { window.pilot.findOpen({ dark, query: query.trim().slice(0, 200) }); this._floatOpen = true; return; } catch {}
      }
      // fallback: HTML bar (sits behind the webview, but preserves functionality)
      const wv = this.getActiveWebview();
      if (!wv) return;
      this._bind(wv);
      this.bar.hidden = false;
      this.input.focus();
      this.input.select();
      if (this.input.value) this.search(true);
    }

    close() {
      if (this._useFloat()) {
        this._floatOpen = false;
        try { window.pilot.findClose(); } catch {}
        return;
      }
      this.bar.hidden = true;
      this.count.textContent = '0/0';
      const wv = this.boundWv;
      if (wv) { try { wv.stopFindInPage('clearSelection'); } catch {} }
      this._unbind();
    }

    // ⌘G / ⌘⇧G: with the floating window open, reopen focuses it (it handles Enter/⇧Enter).
    next() { if (!this.isOpen) return; if (this._useFloat()) this.open(); else this.search(true, true); }
    prev() { if (!this.isOpen) return; if (this._useFloat()) this.open(); else this.search(false, true); }

    // main notifies that the floating window closed (Esc/✕/destroyed) → reset state.
    notifyClosed() { this._floatOpen = false; }

    search(forward = true, findNext = false) {
      const wv = this.getActiveWebview();
      if (!wv) return;
      this._bind(wv);
      const text = this.input.value;
      if (!text) { this.count.textContent = '0/0'; try { wv.stopFindInPage('clearSelection'); } catch {} return; }
      try { this.lastRequestId = wv.findInPage(text, { forward, findNext }); } catch {}
    }

    _bind(wv) {
      if (this.boundWv === wv) return;
      this._unbind();
      this.boundWv = wv;
      this.onFound = (e) => {
        if (typeof e.matches === 'number') {
          this.count.textContent = (e.activeMatchOrdinal || 0) + '/' + e.matches;
        }
      };
      try { wv.addEventListener('found-in-page', this.onFound); } catch {}
    }

    _unbind() {
      if (this.boundWv && this.onFound) {
        try { this.boundWv.removeEventListener('found-in-page', this.onFound); } catch {}
      }
      this.boundWv = null; this.onFound = null;
    }
  }

  window.FindBar = FindBar;
})();
