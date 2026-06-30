// Start page local (pilot://newtab) — lógica autossuficiente.
// Roda dentro de um <webview> isolado: SEM window.pilot, SEM IPC.
// A navegação acontece via location.href; o host detecta did-navigate.
(function () {
  'use strict';

  // ── i18n da home: a home é isolada (pilot://), então o main entrega o idioma
  // resolvido + o mapa de strings via fetch _data/i18n. t()=traduz com fallback. ──
  var LP_I18N = {};
  function t(key, fallback) { return (LP_I18N[key] != null) ? LP_I18N[key] : fallback; }
  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(function (e) {
      var v = LP_I18N[e.getAttribute('data-i18n')]; if (v != null) e.textContent = v;
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (e) {
      var v = LP_I18N[e.getAttribute('data-i18n-ph')]; if (v != null) e.setAttribute('placeholder', v);
    });
  }

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

  // ── Card Pilot (IA) ────────────────────────────────────────────
  // A home é isolada (sem window.pilot). Pede à casca para abrir o painel Pilot
  // já preenchido via window.lpHome.pilot(objetivo) — exposto pelo webview-preload,
  // guardado por protocolo pilot://. Se a API faltar (preload ausente), é no-op.
  var pilotForm = document.getElementById('pilot-form');
  var pilotInput = document.getElementById('pilot-input');

  if (pilotForm && pilotInput) {
    var submitPilot = function () {
      var goal = (pilotInput.value || '').trim();
      if (!goal) return;
      if (window.lpHome && typeof window.lpHome.pilot === 'function') {
        window.lpHome.pilot(goal);
      }
      // sem API → no-op silencioso (não quebra a home)
    };
    pilotForm.addEventListener('submit', function (e) {
      e.preventDefault();
      submitPilot();
    });
    // Cmd/Ctrl+Enter no textarea também envia (consistência com o painel da casca).
    pilotInput.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        submitPilot();
      }
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

  // ── Feed de notícias (PT-BR/Brasil) ────────────────────────────────────────
  // Abas de categoria + grade de cards estilo Edge/MSN. O main busca RSS
  // server-side e devolve JSON via pilot://newtab/_data/news?cat=.
  var NEWS_CATEGORIES = [
    { id: 'top',            label: 'Para você' },
    { id: 'brasil',         label: 'Brasil' },
    { id: 'mundo',          label: 'Mundo' },
    { id: 'tecnologia',     label: 'Tecnologia' },
    { id: 'esportes',       label: 'Esportes' },
    { id: 'economia',       label: 'Economia' },
    { id: 'entretenimento', label: 'Entretenimento' }
  ];

  var newsTabsEl = document.getElementById('news-tabs');
  var newsGridEl = document.getElementById('news-grid');
  var newsCurrentCat = 'top';
  var newsReqToken = 0; // ignora respostas de requisições antigas (race)
  // cache de catálogo já buscado nesta sessão (troca instantânea de aba)
  var newsCache = Object.create(null);

  // Cores estáveis por inicial (placeholder quando o item não tem imagem).
  var PLACEHOLDER_GRADS = [
    ['#7c5cff', '#4da3ff'], ['#ff7eb3', '#ff5f6d'], ['#11998e', '#38ef7d'],
    ['#f7971e', '#ffd200'], ['#2193b0', '#6dd5ed'], ['#c94b4b', '#4b134f'],
    ['#0083B0', '#00B4DB'], ['#8E2DE2', '#4A00E0']
  ];
  function gradForSource(src) {
    var s = String(src || '?');
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return PLACEHOLDER_GRADS[h % PLACEHOLDER_GRADS.length];
  }
  function initialOf(src) {
    var s = String(src || '?').trim();
    return (s ? s[0] : '?').toUpperCase();
  }

  // Tempo relativo em PT-BR ("agora", "há 2 min", "há 3 h", "ontem", "há 4 d").
  function relTime(ts) {
    var n = Number(ts);
    if (!n || !isFinite(n)) return '';
    var diff = Date.now() - n;
    if (diff < 0) diff = 0;
    var min = Math.floor(diff / 60000);
    if (min < 1) return 'agora';
    if (min < 60) return 'há ' + min + ' min';
    var h = Math.floor(min / 60);
    if (h < 24) return 'há ' + h + ' h';
    var d = Math.floor(h / 24);
    if (d === 1) return 'ontem';
    if (d < 7) return 'há ' + d + ' d';
    var w = Math.floor(d / 7);
    if (w < 5) return 'há ' + w + ' sem';
    var mo = Math.floor(d / 30);
    if (mo < 12) return 'há ' + mo + ' mês' + (mo > 1 ? 'es' : '');
    return 'há ' + Math.floor(d / 365) + ' a';
  }

  function buildNewsCard(item) {
    var a = document.createElement('a');
    a.className = 'news-card';
    a.href = item.link;
    a.title = item.title;

    // Mídia (imagem ou placeholder gradiente com a inicial da fonte)
    var media = document.createElement('span');
    media.className = 'news-card-media';
    if (item.image) {
      var img = document.createElement('img');
      img.className = 'news-card-img';
      img.src = item.image;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      // imagem quebrada → vira placeholder, sem ícone de erro
      img.addEventListener('error', function () {
        media.removeChild(img);
        media.appendChild(buildPlaceholder(item.source));
        media.classList.add('is-ph');
      });
      media.appendChild(img);
    } else {
      media.appendChild(buildPlaceholder(item.source));
      media.classList.add('is-ph');
    }

    var body = document.createElement('span');
    body.className = 'news-card-body';

    var h = document.createElement('span');
    h.className = 'news-card-headline';
    h.textContent = item.title;

    var foot = document.createElement('span');
    foot.className = 'news-card-foot';
    var srcEl = document.createElement('span');
    srcEl.className = 'news-card-source';
    srcEl.textContent = item.source || '';
    foot.appendChild(srcEl);
    var t = relTime(item.ts);
    if (t) {
      var sep = document.createElement('span');
      sep.className = 'news-card-dot';
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '·';
      var timeEl = document.createElement('span');
      timeEl.className = 'news-card-time';
      timeEl.textContent = t;
      foot.appendChild(sep);
      foot.appendChild(timeEl);
    }

    body.appendChild(h);
    body.appendChild(foot);
    a.appendChild(media);
    a.appendChild(body);

    // Navegação explícita (abre a notícia na própria aba).
    a.addEventListener('click', function (e) {
      e.preventDefault();
      location.href = item.link;
    });
    return a;
  }

  function buildPlaceholder(source) {
    var ph = document.createElement('span');
    ph.className = 'news-ph';
    var g = gradForSource(source);
    ph.style.background = 'linear-gradient(135deg, ' + g[0] + ' 0%, ' + g[1] + ' 100%)';
    var letter = document.createElement('span');
    letter.className = 'news-ph-letter';
    letter.textContent = initialOf(source);
    ph.appendChild(letter);
    return ph;
  }

  function renderNewsSkeletons() {
    if (!newsGridEl) return;
    newsGridEl.textContent = '';
    var frag = document.createDocumentFragment();
    for (var i = 0; i < 8; i++) {
      var sk = document.createElement('div');
      sk.className = 'news-card news-card-skeleton';
      var m = document.createElement('span'); m.className = 'news-card-media';
      var b = document.createElement('span'); b.className = 'news-card-body';
      var l1 = document.createElement('span'); l1.className = 'sk-line';
      var l2 = document.createElement('span'); l2.className = 'sk-line sk-line-short';
      b.appendChild(l1); b.appendChild(l2);
      sk.appendChild(m); sk.appendChild(b);
      frag.appendChild(sk);
    }
    newsGridEl.appendChild(frag);
  }

  function renderNewsState(message) {
    if (!newsGridEl) return;
    newsGridEl.textContent = '';
    var msg = document.createElement('div');
    msg.className = 'news-empty';
    msg.textContent = message;
    newsGridEl.appendChild(msg);
  }

  function renderNewsItems(items) {
    if (!newsGridEl) return;
    newsGridEl.textContent = '';
    if (!items || !items.length) {
      renderNewsState(t('news.error', 'Não consegui carregar as notícias agora.'));
      return;
    }
    var frag = document.createDocumentFragment();
    items.forEach(function (it) {
      if (it && it.title && it.link) frag.appendChild(buildNewsCard(it));
    });
    newsGridEl.appendChild(frag);
  }

  function loadNews(cat) {
    newsCurrentCat = cat;
    var token = ++newsReqToken;

    if (newsCache[cat]) { renderNewsItems(newsCache[cat]); return; }
    renderNewsSkeletons();

    fetch('pilot://newtab/_data/news?cat=' + encodeURIComponent(cat),
          { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (token !== newsReqToken) return; // resposta velha → ignora
        var items = data && data.ok && data.items ? data.items : [];
        if (items.length) {
          newsCache[cat] = items;
          renderNewsItems(items);
        } else {
          renderNewsState(t('news.error', 'Não consegui carregar as notícias agora.'));
        }
      })
      .catch(function () {
        if (token !== newsReqToken) return;
        renderNewsState(t('news.error', 'Não consegui carregar as notícias agora.'));
      });
  }

  function setActiveTab(cat) {
    if (!newsTabsEl) return;
    var chips = newsTabsEl.querySelectorAll('.news-tab');
    for (var i = 0; i < chips.length; i++) {
      var on = chips[i].getAttribute('data-cat') === cat;
      chips[i].classList.toggle('is-active', on);
      chips[i].setAttribute('aria-selected', on ? 'true' : 'false');
      chips[i].tabIndex = on ? 0 : -1;
    }
  }

  function buildNewsTabs() {
    if (!newsTabsEl) return;
    newsTabsEl.textContent = '';
    NEWS_CATEGORIES.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'news-tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('data-cat', c.id);
      b.setAttribute('aria-selected', 'false');
      b.tabIndex = -1;
      b.textContent = t('news.cat.' + c.id, c.label);
      b.addEventListener('click', function () {
        if (newsCurrentCat === c.id) return;
        setActiveTab(c.id);
        loadNews(c.id);
      });
      newsTabsEl.appendChild(b);
    });
    setActiveTab(newsCurrentCat);
  }

  if (newsTabsEl && newsGridEl) {
    buildNewsTabs();
    loadNews(newsCurrentCat);
  }

  // idioma + traduções (entregues pelo main) → reaplica na home isolada.
  fetch('pilot://newtab/_data/i18n', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.ok || !d.map) return;
      LP_I18N = d.map;
      try { document.documentElement.lang = d.lang || 'pt-BR'; } catch (e) {}
      applyI18n();
      if (newsTabsEl) buildNewsTabs(); // re-renderiza as abas de categoria traduzidas
    })
    .catch(function () {});
})();
