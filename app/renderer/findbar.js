'use strict';

/* findbar.js — localizar na página (⌘F).
   Usa a API do próprio <webview> (wv.findInPage / evento found-in-page),
   sem IPC (decisão do spec §2.3). Contador n/N + prev/next/✕. */

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
      this.boundWv = null;        // webview com listener ligado
      this.onFound = null;
      this.lastRequestId = 0;
      // Caminho primário: barra "Localizar" como JANELA FLUTUANTE (camada do SO,
      // acima do <webview>). A flutuante é dona da busca enquanto aberta — então
      // este módulo só rastreia se ela está aberta (p/ ⌘G/⌘⇧G e fechar no Esc).
      this._floatOpen = false;
    }

    // a flutuante existe? (IPC presente em runtime)
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

    // isOpen reflete a flutuante (caminho primário) ou a barra HTML (fallback).
    get isOpen() { return this._useFloat() ? this._floatOpen : !this.bar.hidden; }

    open() {
      if (this._useFloat()) {
        const dark = document.documentElement.getAttribute('data-theme') !== 'light';
        // pré-preenche com a seleção atual da página, se houver (paridade Chrome).
        let query = '';
        try { query = (window.getSelection && String(window.getSelection())) || ''; } catch {}
        try { window.pilot.findOpen({ dark, query: query.trim().slice(0, 200) }); this._floatOpen = true; return; } catch {}
      }
      // fallback: barra HTML (fica atrás do webview, mas preserva a função)
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

    // ⌘G / ⌘⇧G: com a flutuante aberta, reabrir foca-a (ela trata Enter/⇧Enter).
    next() { if (!this.isOpen) return; if (this._useFloat()) this.open(); else this.search(true, true); }
    prev() { if (!this.isOpen) return; if (this._useFloat()) this.open(); else this.search(false, true); }

    // o main avisa que a janela flutuante fechou (Esc/✕/destruída) → reseta estado.
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
