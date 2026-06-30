// Página de histórico (pilot://history) — lógica autossuficiente.
// Roda num <webview> isolado: SEM window.pilot. Conversa com o main por fetch()
// de mesma origem (pilot://history/_data|_action). A navegação usa location.href.
(function () {
  'use strict';

  var listEl = document.getElementById('list');
  var searchInput = document.getElementById('search-input');
  var searchForm = document.getElementById('search-form');
  var clearBtn = document.getElementById('clear-all');

  // ── helpers ──────────────────────────────────────────────────
  function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch (_) { return ''; }
  }
  function faviconFor(url) {
    var d = domainOf(url);
    return 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(d || url) + '&sz=64';
  }
  function startOfDay(ts) {
    var d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime();
  }
  function dayLabel(ts) {
    var today = startOfDay(Date.now());
    var day = startOfDay(ts);
    var diff = Math.round((today - day) / 86400000);
    if (diff === 0) return 'Hoje';
    if (diff === 1) return 'Ontem';
    return new Date(ts).toLocaleDateString('pt-BR', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
    });
  }
  function timeLabel(ts) {
    return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  // ── data ─────────────────────────────────────────────────────
  function fetchList(q) {
    var url = 'pilot://history/_data/list?limit=500';
    if (q) url += '&q=' + encodeURIComponent(q);
    return fetch(url, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return (d && d.items) ? d.items : []; })
      .catch(function () { return []; });
  }
  function postAction(path, body) {
    return fetch('pilot://history' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.ok ? r.json() : { ok: false }; })
      .catch(function () { return { ok: false }; });
  }

  // ── render ───────────────────────────────────────────────────
  function buildItem(entry) {
    var row = document.createElement('div');
    row.className = 'hist-item';
    row.setAttribute('role', 'link');
    row.tabIndex = 0;
    row.dataset.url = entry.url;

    var favWrap = document.createElement('span');
    favWrap.className = 'hi-fav';
    var img = document.createElement('img');
    img.src = faviconFor(entry.url);
    img.alt = '';
    img.width = 16; img.height = 16; img.loading = 'lazy';
    img.addEventListener('error', function () { img.style.display = 'none'; });
    favWrap.appendChild(img);

    var main = document.createElement('span');
    main.className = 'hi-main';
    var title = document.createElement('span');
    title.className = 'hi-title';
    title.textContent = entry.title || domainOf(entry.url) || entry.url;
    var urlEl = document.createElement('span');
    urlEl.className = 'hi-url';
    urlEl.textContent = entry.url;
    main.appendChild(title);
    main.appendChild(urlEl);

    var time = document.createElement('span');
    time.className = 'hi-time';
    time.textContent = timeLabel(entry.ts);

    var del = document.createElement('button');
    del.className = 'hi-del';
    del.type = 'button';
    del.title = 'Remover do histórico';
    del.setAttribute('aria-label', 'Remover do histórico');
    del.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"></path></svg>';

    row.appendChild(favWrap);
    row.appendChild(main);
    row.appendChild(time);
    row.appendChild(del);

    function go() { location.href = entry.url; }
    row.addEventListener('click', go);
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      postAction('/_action/delete', { url: entry.url }).then(function (res) {
        if (res && res.ok) {
          var group = row.parentNode;
          row.remove();
          // se o grupo do dia ficou sem itens (só o label), remove o grupo
          if (group && group.querySelectorAll('.hist-item').length === 0) group.remove();
          if (!listEl.querySelector('.hist-item')) renderEmpty('Sem histórico.');
        }
      });
    });
    del.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });

    return row;
  }

  function renderEmpty(msg) {
    listEl.textContent = '';
    var p = document.createElement('p');
    p.className = 'empty';
    p.textContent = msg;
    listEl.appendChild(p);
  }

  function render(items) {
    if (!items.length) { renderEmpty('Sem histórico ainda.'); return; }
    // agrupa por dia preservando a ordem (items já vêm do mais recente)
    var groups = [];
    var index = {};
    items.forEach(function (e) {
      if (!e || !e.url) return;
      var key = startOfDay(e.ts);
      if (!(key in index)) { index[key] = groups.length; groups.push({ key: key, items: [] }); }
      groups[index[key]].items.push(e);
    });

    listEl.textContent = '';
    var frag = document.createDocumentFragment();
    groups.forEach(function (g) {
      var section = document.createElement('div');
      section.className = 'day-group';
      var label = document.createElement('div');
      label.className = 'day-label';
      label.textContent = dayLabel(g.key);
      section.appendChild(label);
      g.items.forEach(function (e) { section.appendChild(buildItem(e)); });
      frag.appendChild(section);
    });
    listEl.appendChild(frag);
  }

  function reload(q) {
    fetchList(q).then(render);
  }

  // ── busca (debounced) ────────────────────────────────────────
  var debounceTimer = null;
  function onSearch() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () { reload(searchInput.value.trim()); }, 180);
  }
  if (searchInput) searchInput.addEventListener('input', onSearch);
  if (searchForm) searchForm.addEventListener('submit', function (e) { e.preventDefault(); reload(searchInput.value.trim()); });

  // ── limpar tudo ──────────────────────────────────────────────
  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      postAction('/_action/clear', { range: 'all' }).then(function (res) {
        if (res && res.ok) { searchInput.value = ''; render([]); }
      });
    });
  }

  // ── boot ─────────────────────────────────────────────────────
  reload('');
})();
