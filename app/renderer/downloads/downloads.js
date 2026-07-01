// Downloads page (pilot://downloads) — self-contained logic.
// Runs in an isolated <webview>: NO window.pilot. Communicates with main via fetch()
// from same origin (pilot://downloads/_data|_action). Auto-refresh while there's an
// active download (progress). Actions: open, show in folder, cancel.
(function () {
  'use strict';

  var listEl = document.getElementById('list');
  var refreshBtn = document.getElementById('refresh');
  var pollTimer = null;

  // ── helpers ──────────────────────────────────────────────────
  function fmtBytes(b) {
    if (!b && b !== 0) return '';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0, n = b;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + ' ' + u[i];
  }
  function pct(d) {
    if (!d.totalBytes) return d.state === 'completed' ? 100 : 0;
    return Math.min(100, Math.round((d.receivedBytes / d.totalBytes) * 100));
  }
  var STATE_LABEL = {
    started: 'downloading…', progress: 'downloading…',
    completed: 'completed', cancelled: 'cancelled', interrupted: 'interrupted'
  };
  function isActive(d) { return d.state === 'started' || d.state === 'progress'; }

  var ICON_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path></svg>';
  var ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"></path></svg>';
  var ICON_ERR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M15 9l-6 6M9 9l6 6"></path></svg>';

  // ── data ─────────────────────────────────────────────────────
  function fetchList() {
    return fetch('pilot://downloads/_data/list', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return (d && d.items) ? d.items : []; })
      .catch(function () { return []; });
  }
  function postAction(id, action) {
    return fetch('pilot://downloads/_action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: id, action: action })
    }).then(function (r) { return r.ok ? r.json() : { ok: false }; })
      .catch(function () { return { ok: false }; });
  }

  // ── render ───────────────────────────────────────────────────
  function buildRow(d) {
    var item = document.createElement('div');
    item.className = 'dl-item';
    item.dataset.id = d.id;

    var done = d.state === 'completed';
    var failed = d.state === 'cancelled' || d.state === 'interrupted';

    var icon = document.createElement('span');
    icon.className = 'dl-icon' + (done ? ' ok' : failed ? ' err' : '');
    icon.innerHTML = done ? ICON_OK : failed ? ICON_ERR : ICON_FILE;

    var main = document.createElement('span');
    main.className = 'dl-main';
    var name = document.createElement('span');
    name.className = 'dl-name';
    name.textContent = d.filename || d.url || '';
    name.title = d.savePath || d.url || '';
    var meta = document.createElement('span');
    meta.className = 'dl-meta';
    var sizePart = d.totalBytes
      ? fmtBytes(d.receivedBytes) + ' / ' + fmtBytes(d.totalBytes)
      : fmtBytes(d.receivedBytes);
    meta.textContent = (STATE_LABEL[d.state] || d.state || '') + (sizePart ? ' · ' + sizePart : '');
    main.appendChild(name);
    main.appendChild(meta);

    var actions = document.createElement('span');
    actions.className = 'dl-actions';
    if (done) {
      actions.appendChild(makeAction(d.id, 'open', 'Open', false));
      actions.appendChild(makeAction(d.id, 'showInFolder', 'Show in folder', false));
    } else if (isActive(d)) {
      actions.appendChild(makeAction(d.id, 'cancel', 'Cancel', true));
    }

    item.appendChild(icon);
    item.appendChild(main);
    item.appendChild(actions);

    // progress bar only while not completed
    if (!done) {
      var bar = document.createElement('span');
      bar.className = 'dl-bar';
      var fill = document.createElement('i');
      fill.style.width = pct(d) + '%';
      bar.appendChild(fill);
      item.appendChild(bar);
    }

    return item;
  }

  function makeAction(id, action, label, danger) {
    var b = document.createElement('button');
    b.className = 'dl-act' + (danger ? ' danger' : '');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', function () {
      postAction(id, action).then(function (res) {
        // 'cancel' changes state → reload; open/show do not change the list
        if (action === 'cancel' && res && res.ok) reload();
      });
    });
    return b;
  }

  function render(items) {
    if (!items.length) {
      listEl.textContent = '';
      var p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'No downloads yet.';
      listEl.appendChild(p);
      stopPolling();
      return;
    }
    listEl.textContent = '';
    var frag = document.createDocumentFragment();
    items.forEach(function (d) { frag.appendChild(buildRow(d)); });
    listEl.appendChild(frag);

    // keep polling while there's an active download
    if (items.some(isActive)) startPolling(); else stopPolling();
  }

  function reload() { fetchList().then(render); }

  // ── polling (only while there's an active download) ──────────────────
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(reload, 700);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  if (refreshBtn) refreshBtn.addEventListener('click', reload);
  window.addEventListener('beforeunload', stopPolling);

  // ── boot ─────────────────────────────────────────────────────
  reload();
})();
