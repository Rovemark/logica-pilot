// Start page local (pilot://newtab) — lógica autossuficiente.
// Roda dentro de um <webview> isolado: SEM window.pilot, SEM IPC.
// A navegação acontece via location.href; o host detecta did-navigate.
(function () {
  'use strict';

  // ── Detecção de URL vs termo de busca ──────────────────────────
  // Heurística no estilo omnibox do Chrome: decide se o texto digitado
  // deve virar uma navegação direta ou uma pesquisa no Google.
  function looksLikeUrl(raw) {
    var text = raw.trim();
    if (!text || /\s/.test(text)) return false;          // espaço → busca

    // Esquema explícito conhecido (http, https, ftp, file, about, pilot…)
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return true;
    if (/^(about|pilot|mailto|tel):/i.test(text)) return true;

    // localhost (com porta/caminho opcional)
    if (/^localhost(:\d+)?(\/.*)?$/i.test(text)) return true;

    // IPv4 (com porta/caminho opcional)
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(text)) return true;

    // domínio com TLD: ex. exemplo.com, sub.exemplo.com.br, site.io/caminho
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(text)) return true;

    return false;
  }

  function toUrl(raw) {
    var text = raw.trim();
    // Se já tem esquema, usa como está; senão assume https.
    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
    return 'https://' + text;
  }

  function submitQuery(raw) {
    var text = (raw || '').trim();
    if (!text) return;
    if (looksLikeUrl(text)) {
      location.href = toUrl(text);
    } else {
      location.href = 'https://www.google.com/search?q=' + encodeURIComponent(text);
    }
  }

  // ── Busca central ──────────────────────────────────────────────
  var form = document.getElementById('search-form');
  var input = document.getElementById('search-input');

  if (form && input) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      submitQuery(input.value);
    });
    // Foco imediato (além do autofocus do HTML) para começar a digitar.
    requestAnimationFrame(function () {
      try { input.focus(); } catch (_) {}
    });
  }

  // ── Atalhos rápidos / Mais visitados ───────────────────────────
  // Default estático (mostrado enquanto não há histórico suficiente).
  var DEFAULT_SHORTCUTS = [
    { label: 'Gmail',     url: 'https://mail.google.com',  domain: 'mail.google.com' },
    { label: 'YouTube',   url: 'https://www.youtube.com',  domain: 'youtube.com' },
    { label: 'GitHub',    url: 'https://github.com',       domain: 'github.com' },
    { label: 'Wikipedia', url: 'https://www.wikipedia.org', domain: 'wikipedia.org' }
  ];

  function faviconFor(domain) {
    return 'https://www.google.com/s2/favicons?domain=' +
      encodeURIComponent(domain) + '&sz=64';
  }

  // domínio "limpo" a partir de uma URL (para o favicon do s2 e fallback de título)
  function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch (_) { return ''; }
  }

  function titleFor(item) {
    if (item.title && item.title.trim()) return item.title.trim();
    return item.domain || domainOf(item.url) || item.url;
  }

  function buildShortcut(item) {
    var domain = item.domain || domainOf(item.url);
    var label = titleFor(item);

    var a = document.createElement('a');
    a.className = 'shortcut';
    a.href = item.url;
    a.title = label + (item.url ? '\n' + item.url : '');
    a.setAttribute('aria-label', label);

    var iconWrap = document.createElement('span');
    iconWrap.className = 'shortcut-icon';

    var img = document.createElement('img');
    img.src = faviconFor(domain);
    img.alt = '';
    img.width = 26;
    img.height = 26;
    img.loading = 'lazy';
    iconWrap.appendChild(img);

    var labelEl = document.createElement('span');
    labelEl.className = 'shortcut-label';
    labelEl.textContent = label;

    a.appendChild(iconWrap);
    a.appendChild(labelEl);

    // Navegação explícita (garante href mesmo se algo cancelar o default).
    a.addEventListener('click', function (e) {
      e.preventDefault();
      location.href = item.url;
    });

    return a;
  }

  function renderShortcuts(items) {
    var grid = document.getElementById('shortcuts');
    if (!grid) return;
    grid.textContent = '';
    var frag = document.createDocumentFragment();
    items.slice(0, 8).forEach(function (item) {
      frag.appendChild(buildShortcut(item));
    });
    grid.appendChild(frag);
  }

  // Pinta o default na hora; troca pelos mais visitados quando o store responder.
  renderShortcuts(DEFAULT_SHORTCUTS);

  fetch('pilot://newtab/_data/topsites?limit=8', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      var items = data && data.items ? data.items : [];
      // exige um mínimo de histórico real para sobrepor os defaults curados
      var usable = items.filter(function (e) { return e && /^https?:\/\//i.test(e.url); });
      if (usable.length >= 3) {
        renderShortcuts(usable.map(function (e) {
          return { url: e.url, title: e.title, domain: domainOf(e.url) };
        }));
      }
    })
    .catch(function () { /* sem histórico/offline → mantém defaults */ });
})();
