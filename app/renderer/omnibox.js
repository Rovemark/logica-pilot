'use strict';

/* omnibox.js — barra de endereço estilo Chrome.
   - dropdown de sugestões (debounce → window.pilot.historyQuery + sugestão de busca)
   - navegação ↑/↓/Enter/Esc
   - select-all no primeiro foco; Esc restaura a URL da aba
   - exibição limpa (esconde https://, destaca host) quando não focado
   - cadeado REAL (http/https/erro) substituindo o estático
   Coopera com renderer.js via init({ getActiveUrl, navigate, settings }). */

(function () {
  const HOME = 'pilot://newtab';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // separa host e resto p/ realce (sem esconder o host real — anti-spoofing)
  function splitUrl(url) {
    try {
      const u = new URL(url);
      const scheme = u.protocol === 'http:' ? 'http://' : '';
      const host = u.host;
      const rest = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
      return { scheme, host, rest, ok: true };
    } catch { return { ok: false }; }
  }

  // favicon de fallback (Google s2) derivado do host da URL — igual aos favoritos.
  function faviconFromUrl(url) {
    try {
      const h = new URL(url).host;
      return h ? 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(h) + '&sz=32' : '';
    } catch { return ''; }
  }

  // texto exibido quando o campo NÃO está focado (esconde https://)
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

      this.realUrl = '';      // URL real da aba ativa
      this.selectedOnFocus = false;
      this.items = [];        // sugestões atuais
      this.cursor = -1;       // índice selecionado no dropdown
      this.debounce = null;
      this.settings = { searchEngine: 'google', homepage: HOME };
    }

    init({ getActiveUrl, navigate, settings }) {
      this.getActiveUrl = getActiveUrl || (() => '');
      this.navigate = navigate || (() => {});
      if (settings) this.settings = Object.assign(this.settings, settings);

      // submit do form
      this.form.addEventListener('submit', (e) => {
        e.preventDefault();
        const sel = this.cursor >= 0 ? this.items[this.cursor] : null;
        const value = sel ? sel.value : this.input.value;
        this.hideSuggest();
        this.navigate(this.normalizeUrl(value));
        this.input.blur();
      });

      // foco: select-all na primeira interação + mostrar URL crua p/ editar
      this.input.addEventListener('focus', () => {
        if (this.realUrl) this.input.value = this.realUrl;
        if (!this.selectedOnFocus) { this.selectedOnFocus = true; this.input.select(); }
      });
      this.input.addEventListener('blur', () => {
        this.selectedOnFocus = false;
        // pequeno atraso p/ permitir clique numa sugestão antes de esconder
        setTimeout(() => this.hideSuggest(), 120);
        this.renderDisplay();
      });

      this.input.addEventListener('input', () => {
        this.cursor = -1;
        this.querySuggest(this.input.value);
      });

      this.input.addEventListener('keydown', (e) => this.onKey(e));

      // clique numa sugestão (fallback HTML — quando a flutuante não existe)
      this.suggest.addEventListener('mousedown', (e) => {
        const it = e.target.closest('.omni-item');
        if (!it) return;
        e.preventDefault();
        const i = Number(it.dataset.i);
        this.chooseAt(i);
      });

      // clique numa sugestão NA JANELA FLUTUANTE → mesma ação do Enter naquele índice.
      if (window.pilot && window.pilot.onOmniChosen) {
        window.pilot.onOmniChosen((index) => this.chooseAt(index));
      }
    }

    // a janela flutuante de sugestões existe? (IPC presente em runtime)
    _useFloat() { return !!(window.pilot && window.pilot.omniOpen); }

    // tema atual (espelha o renderer principal: data-theme !== 'light' = escuro)
    _dark() { return document.documentElement.getAttribute('data-theme') !== 'light'; }

    // rect da .address-wrap (o form) p/ posicionar a flutuante logo abaixo dela.
    _rect() {
      try {
        const r = this.form.getBoundingClientRect();
        return { x: r.left, bottom: r.bottom, width: r.width };
      } catch { return null; }
    }

    // aplica a ação do Enter no índice i (navegar/buscar) — usado por clique
    // (fallback HTML e flutuante). Mesma normalização do submit do form.
    chooseAt(i) {
      const item = this.items[i];
      if (!item) return;
      this.hideSuggest();
      this.navigate(this.normalizeUrl(item.value));
      this.input.blur();
    }

    // espelha a lista atual (items + índice selecionado + tema) na flutuante.
    // open=true abre na 1ª vez (passando o rect); senão atualiza a mesma janela.
    _floatSync(open) {
      if (!this._useFloat()) return;
      // enriquece o favicon igual ao fallback HTML: o capturado OU o derivado do
      // host (Google s2). Mantém os demais campos que a flutuante usa.
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

    // chamado pelo renderer ao trocar de aba / navegar
    setUrl(url) {
      this.realUrl = (url && url !== HOME && !/^pilot:\/\//.test(url) && !/^about:/.test(url)) ? url : '';
      this.setSecurity(url);
      if (document.activeElement !== this.input) this.renderDisplay();
    }

    renderDisplay() {
      const url = this.realUrl || this.getActiveUrl();
      this.input.value = displayValue(url);
    }

    // ── cadeado real ────────────────────────────────────────
    setSecurity(url, errored) {
      if (!this.lock) return;
      this.lock.classList.remove('secure', 'insecure', 'error');
      if (errored) {
        this.lock.classList.add('error');
        this.lock.title = 'Erro de certificado / conexão';
        this.lock.innerHTML = this.lockSvg;
        return;
      }
      if (!url || url === HOME || /^pilot:\/\//.test(url) || /^about:/.test(url)) {
        this.lock.title = 'Página interna';
        this.lock.innerHTML = this.lockSvg;
        return;
      }
      if (/^https:\/\//i.test(url)) {
        this.lock.classList.add('secure');
        this.lock.title = 'Conexão segura';
        this.lock.innerHTML = this.lockSvg;
      } else if (/^http:\/\//i.test(url)) {
        this.lock.classList.add('insecure');
        this.lock.title = 'Não seguro';
        // ícone de alerta + rótulo textual (paridade Chrome)
        this.lock.innerHTML =
          '<svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>' +
          '<span class="lock-label">Não seguro</span>';
      } else {
        this.lock.title = '';
        this.lock.innerHTML = this.lockSvg;
      }
    }

    // ── sugestões ───────────────────────────────────────────
    querySuggest(q) {
      clearTimeout(this.debounce);
      const prefix = (q || '').trim();
      if (!prefix) { this.hideSuggest(); return; }
      this.debounce = setTimeout(async () => {
        const items = [];
        // histórico (via main, se existir)
        try {
          if (window.pilot && window.pilot.historyQuery) {
            const hits = await window.pilot.historyQuery({ prefix, limit: 6 });
            for (const h of (hits || [])) {
              items.push({ type: 'history', value: h.url, title: h.title || '', url: h.url, favicon: h.favicon });
            }
          }
        } catch {}
        // sugestão de busca pelo motor default
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(prefix)) {
          items.push({ type: 'search', value: prefix, title: 'Buscar ' + prefix, url: null });
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

      // Caminho primário: JANELA FLUTUANTE (camada do SO, acima do <webview>).
      // Espelhamos a lista nela e mantemos o #omni-suggest HTML ESCONDIDO (ele
      // ficaria atrás do webview e ainda encolheria a aba ativa via :has()).
      if (this._useFloat()) {
        this.suggest.hidden = true;
        this._floatSync(true);
        return;
      }

      // Fallback HTML (sem flutuante): dropdown #omni-suggest (atrás do webview).
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
        // favicon: o capturado (se houver) ou o derivado do host (Google s2),
        // igual aos favoritos. onerror esconde o <img> quebrado.
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
      this._floatClose(); // fecha a flutuante (Esc/blur/navegar/lista vazia)
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
        // restaura a URL real e tira o foco
        this.renderDisplay();
        this.input.blur();
      }
      // Enter é tratado pelo submit do form (usa this.cursor)
    }

    syncCursor() {
      // fallback HTML: atualiza o aria-selected dos itens visíveis (se houver)
      const opts = this.suggest.querySelectorAll('.omni-item');
      opts.forEach((o, i) => o.setAttribute('aria-selected', i === this.cursor ? 'true' : 'false'));
      // flutuante: reenvia items + novo índice selecionado (mesma janela)
      this._floatSync(false);
      if (this.cursor >= 0 && this.items[this.cursor]) {
        const it = this.items[this.cursor];
        this.input.value = it.type === 'search' ? it.value : (it.url || it.value);
      }
    }

    // ── normalização (lê motor/homepage das settings) ───────
    normalizeUrl(input) {
      const s = (input || '').trim();
      if (!s) return this.settings.homepage || HOME;
      if (/^pilot:\/\//i.test(s) || /^about:/i.test(s)) return s;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return s;
      if (s === 'localhost' || /^localhost:\d+/.test(s)) return 'http://' + s;
      // token único terminado em extensão de arquivo (ex.: 'arquivo.pdf', 'setup.dmg')
      // NÃO é domínio → vai pra busca (paridade Chrome).
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

  // fallback local de templates (caso o main não devolva o catálogo)
  const ENGINE_TEMPLATES = {
    google: 'https://www.google.com/search?q={q}',
    bing: 'https://www.bing.com/search?q={q}',
    duckduckgo: 'https://duckduckgo.com/?q={q}',
    brave: 'https://search.brave.com/search?q={q}',
  };

  window.Omnibox = Omnibox;
})();
