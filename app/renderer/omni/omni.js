'use strict';

/* omni.js — UI of the omnibox floating suggestion list (SO window, above
   the <webview>). Does NOT handle keyboard: the parent window's address bar
   keeps focus (the floating window is showInactive) and continues handling
   typing/arrows/Enter/Esc. Here we only render the items + the selected index
   and send the index on CLICK (inactive window still receives mouse clicks).
   No inline HTML with handlers (CSP: script-src 'self'). */

const listEl = document.getElementById('omni-list');

// splits host/rest for highlighting (same logic as omnibox.js, anti-spoofing)
function splitUrl(url) {
  try {
    const u = new URL(url);
    const host = u.host;
    const rest = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
    return { host, rest, ok: true };
  } catch { return { ok: false }; }
}

// search icon (magnifying glass) — same SVG as renderSuggest
function searchIcon() {
  const span = document.createElement('span');
  span.className = 'oi-ico';
  span.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
  return span;
}

// generic icon (globe) for when there is no favicon
function globeIcon() {
  const span = document.createElement('span');
  span.className = 'oi-ico';
  span.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>';
  return span;
}

// favicon icon (img) — hides on error (broken favicon)
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

    // icon: magnifying glass (search) | favicon (if available) | globe (fallback)
    if (it.type === 'search') {
      row.appendChild(searchIcon());
    } else if (it.favicon) {
      row.appendChild(faviconIcon(it.favicon));
    } else {
      row.appendChild(globeIcon());
    }

    // main text + (history) title
    const main = buildMain(it);
    if (it.title && it.type === 'history') {
      const t = document.createElement('span');
      t.className = 'oi-title';
      t.textContent = it.title;
      main.appendChild(t);
    }
    row.appendChild(main);

    // CLICK → sends the index to main (which passes it to the main renderer).
    // mousedown (not 'click') matches the gesture of the old HTML dropdown and acts
    // before any blur.
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      window.omniPopup.choose(i);
    });

    listEl.appendChild(row);
  });
}

window.omniPopup.onData(render);
