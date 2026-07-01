'use strict';

const menuEl = document.getElementById('menu');

function makeRow(it) {
  // Separator
  if (it.sep) { const s = document.createElement('div'); s.className = 'sep'; return s; }
  // Section header (non-interactive)
  if (it.header) { const h = document.createElement('div'); h.className = 'mh'; h.textContent = it.header; return h; }
  // Muted placeholder (e.g., "No extensions installed")
  if (it.empty) { const e = document.createElement('div'); e.className = 'me'; e.textContent = it.empty; return e; }

  const d = document.createElement('div');
  d.className = 'mi';

  if (it.icon) {
    const img = document.createElement('img');
    img.className = 'ic'; img.src = it.icon; img.alt = '';
    d.appendChild(img);
  } else if (it.glyph) {
    const g = document.createElement('span');
    g.className = 'gl'; g.textContent = it.glyph;
    d.appendChild(g);
  }

  const l = document.createElement('span');
  l.className = 'l'; l.textContent = it.label;
  d.appendChild(l);

  if (it.key) {
    const k = document.createElement('span');
    k.className = 'k'; k.textContent = it.key;
    d.appendChild(k);
  }

  // Extension row → trailing pin + remove buttons (handled in-place, menu stays open)
  if (it.ext) {
    let pinned = it.ext.pinned !== false;

    // Pin toggle — only for extensions that actually have a toolbar icon.
    if (it.ext.hasAction !== false) {
      const pin = document.createElement('button');
      const setPinTitle = (p) => { pin.title = p ? 'Unpin from toolbar' : 'Pin to toolbar'; };
      pin.className = 'tb pin' + (pinned ? ' on' : '');
      pin.textContent = '📌';
      setPinTitle(pinned);
      pin.addEventListener('click', async (e) => {
        e.stopPropagation();
        const next = !pinned;
        pin.classList.toggle('on', next); setPinTitle(next); // optimistic
        let ok = true;
        try { const r = await window.menuPopup.extSetPinned(it.ext.id, next); ok = !r || r.ok !== false; } catch { ok = false; }
        if (ok) pinned = next;
        else { pin.classList.toggle('on', pinned); setPinTitle(pinned); } // revert on failure
      });
      d.appendChild(pin);
    }

    // Remove — two-step confirm (first click arms '✓?', second click removes).
    const rm = document.createElement('button');
    rm.className = 'tb rm';
    rm.textContent = '✕';
    rm.title = 'Remove';
    let armed = false, armTimer = null;
    rm.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true; rm.textContent = '✓?'; rm.classList.add('armed');
        armTimer = setTimeout(() => { armed = false; rm.textContent = '✕'; rm.classList.remove('armed'); }, 2500);
        return;
      }
      if (armTimer) clearTimeout(armTimer);
      try { await window.menuPopup.extUninstall(it.ext.id); } catch {}
      d.remove();
    });
    d.appendChild(rm);

    // Clicking the row (name/icon) opens the extension's options page.
    if (it.action) d.addEventListener('click', () => window.menuPopup.choose(it.action));
    return d;
  }

  if (it.action) d.addEventListener('click', () => window.menuPopup.choose(it.action));
  return d;
}

window.menuPopup.onData(({ items, dark }) => {
  document.body.classList.toggle('light', !dark);
  menuEl.innerHTML = '';
  for (const it of items || []) menuEl.appendChild(makeRow(it));
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.menuPopup.close();
});
