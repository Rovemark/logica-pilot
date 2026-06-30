'use strict';

/* omni.js — UI da lista de sugestões da omnibox flutuante (janela do SO, acima
   do <webview>). NÃO trata teclado: a barra de endereço da janela-mãe mantém o
   foco (a flutuante é showInactive) e continua tratando digitação/setas/Enter/Esc.
   Aqui só renderizamos os itens + o índice selecionado e mandamos o índice no
   CLIQUE (janela inativa ainda recebe cliques do mouse). Sem HTML inline com
   handlers (CSP: script-src 'self'). */

const listEl = document.getElementById('omni-list');

// separa host/resto p/ realce (mesma lógica do omnibox.js, anti-spoofing)
function splitUrl(url) {
  try {
    const u = new URL(url);
    const host = u.host;
    const rest = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
    return { host, rest, ok: true };
  } catch { return { ok: false }; }
}

// ícone de busca (lupa) — mesmo SVG do renderSuggest
function searchIcon() {
  const span = document.createElement('span');
  span.className = 'oi-ico';
  span.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
  return span;
}

// ícone genérico (globo) p/ quando não há favicon
function globeIcon() {
  const span = document.createElement('span');
  span.className = 'oi-ico';
  span.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>';
  return span;
}

// ícone de favicon (img) — esconde no erro (favicon quebrado)
function faviconIcon(src) {
  const span = document.createElement('span');
  span.className = 'oi-ico';
  const img = document.createElement('img');
  img.src = src;
  img.addEventListener('error', () => { img.style.display = 'none'; });
  span.appendChild(img);
  return span;
}

function buildMain(it) {
  const main = document.createElement('span');
  main.className = 'oi-main';
  if (it.type === 'search') {
    main.textContent = it.title || '';
    return main;
  }
  const s = splitUrl(it.url || it.value);
  if (s.ok) {
    const host = document.createElement('span');
    host.className = 'oi-host';
    host.textContent = s.host;
    const rest = document.createElement('span');
    rest.className = 'oi-rest';
    rest.textContent = s.rest;
    main.appendChild(host);
    main.appendChild(rest);
  } else {
    main.textContent = it.value || '';
  }
  return main;
}

function render({ items, selected, dark } = {}) {
  document.body.classList.toggle('light', dark === false);
  listEl.innerHTML = '';
  const list = Array.isArray(items) ? items : [];
  list.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'omni-item';
    row.setAttribute('role', 'option');
    if (i === selected) row.setAttribute('aria-selected', 'true');

    // ícone: lupa (busca) | favicon (se houver) | globo (fallback)
    if (it.type === 'search') {
      row.appendChild(searchIcon());
    } else if (it.favicon) {
      row.appendChild(faviconIcon(it.favicon));
    } else {
      row.appendChild(globeIcon());
    }

    // texto principal + (histórico) título
    const main = buildMain(it);
    if (it.title && it.type === 'history') {
      const t = document.createElement('span');
      t.className = 'oi-title';
      t.textContent = it.title;
      main.appendChild(t);
    }
    row.appendChild(main);

    // CLIQUE → manda o índice ao main (que repassa pro renderer principal).
    // mousedown (não 'click') casa com o gesto do dropdown HTML antigo e age
    // antes de qualquer blur.
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      window.omniPopup.choose(i);
    });

    listEl.appendChild(row);
  });
}

window.omniPopup.onData(render);
