'use strict';

/* tabs.js — TabStrip com reconciliação incremental do DOM.
   Mantém o estado das abas e cada tab.el estável (não usa innerHTML='').
   Atualiza só o que mudou e reordena com insertBefore.
   O renderer.js cria/equipa o <webview> (callbacks) — este módulo NÃO conhece o motor Pilot. */

(function () {
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  class TabStrip {
    /**
     * @param {object} opts
     *   - container: elemento .tabs (HTMLElement)
     *   - makeWebview(url): cria o <webview> e devolve o elemento
     *   - viewsContainer: onde os webviews vivem (#views)
     *   - onActivate(tab): chamado quando a aba ativa muda
     *   - onAllClosed(): chamado quando a última aba foi removida (renderer recria)
     *   - canClose(tab): retorna false p/ vetar fechamento (guarda do Pilot); pode chamar stop e retornar true
     *   - home: URL da nova aba (pilot://newtab)
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
      this.closedStack = []; // pilha p/ ⌘⇧T (limite ~25)
    }

    // ── ciclo de vida ───────────────────────────────────────
    create(url, { background = false } = {}) {
      const id = ++this.seq;
      const wv = this.makeWebview(url || this.home);
      this.views.appendChild(wv);
      const tab = {
        id, wv, el: null,
        title: 'Nova aba', url: url || this.home,
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
      // guarda do Pilot: o renderer decide (pode parar o run antes)
      if (!this.canClose(tab)) return;

      // pilha de undo (só a URL final — sem ressuscitar histórico do webContents)
      this.closedStack.push({ url: tab.url, title: tab.title });
      if (this.closedStack.length > 25) this.closedStack.shift();

      try { tab.wv.remove(); } catch {}
      if (tab.el && tab.el.parentNode) tab.el.parentNode.removeChild(tab.el);
      this.tabs.splice(idx, 1);

      if (this.tabs.length === 0) { this.onAllClosed(); return; }
      if (this.activeId === id) {
        // paridade Chrome: ao fechar a aba ativa vai pra DIREITA (o vizinho que
        // assumiu o slot idx após o splice); só cai pra esquerda se era a última.
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

    // ── seleção / navegação por índice ──────────────────────
    get(id) { return this.tabs.find((t) => t.id === id); }
    active() { return this.get(this.activeId); }

    selectIndex(n) {
      // n base-1; n===9 sempre vai pra última (paridade Chrome)
      const target = n === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[n - 1];
      if (target) this.activate(target.id);
    }
    selectRelative(delta) {
      if (!this.tabs.length) return;
      const idx = this.tabs.findIndex((t) => t.id === this.activeId);
      const next = (idx + delta + this.tabs.length) % this.tabs.length;
      this.activate(this.tabs[next].id);
    }

    // ── mutações de estado (renderer chama nos eventos do webview) ──
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

    // ── reconciliação incremental ───────────────────────────
    render() {
      const n = this.tabs.length || 1;
      // largura dinâmica: clamp entre mínimo e 200px conforme o espaço
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
            '<span class="t-close" title="Fechar aba">✕</span>';
          this._bind(el, t);
          t.el = el;
        }

        // ── slot de ícone (favicon ↔ spinner no mesmo lugar) ──
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

        // ── título ──
        const titleEl = el.querySelector('.t-title');
        const title = t.title || 'Nova aba';
        if (titleEl.textContent !== title) titleEl.textContent = title;
        if (el.title !== title) el.title = title;

        // ── áudio ──
        const audioEl = el.querySelector('.t-audio');
        if (t.audible) {
          audioEl.hidden = false;
          const glyph = t.muted ? '🔇' : '🔊';
          if (audioEl.textContent !== glyph) audioEl.textContent = glyph;
        } else if (!audioEl.hidden) {
          audioEl.hidden = true;
        }

        // ── classes de estado ──
        el.classList.toggle('active', t.id === this.activeId);
        el.classList.toggle('piloting', !!t.piloting);

        // ── largura animada ──
        el.style.width = width + 'px';

        // ── ordem: garante o nó na posição i ──
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
      // middle-click fecha (auxclick é o evento canônico do botão do meio)
      el.addEventListener('auxclick', (ev) => { if (ev.button === 1) { ev.preventDefault(); this.close(t.id); } });
      el.addEventListener('mousedown', (ev) => { if (ev.button === 1) ev.preventDefault(); });
    }
  }

  window.TabStrip = TabStrip;
})();
