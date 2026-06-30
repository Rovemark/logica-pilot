'use strict';

const menuEl = document.getElementById('menu');

window.menuPopup.onData(({ items, dark }) => {
  document.body.classList.toggle('light', !dark);
  menuEl.innerHTML = '';
  for (const it of items || []) {
    if (it.sep) {
      const s = document.createElement('div');
      s.className = 'sep';
      menuEl.appendChild(s);
      continue;
    }
    const d = document.createElement('div');
    d.className = 'mi';
    const l = document.createElement('span');
    l.className = 'l';
    l.textContent = it.label;
    d.appendChild(l);
    if (it.key) {
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = it.key;
      d.appendChild(k);
    }
    d.addEventListener('click', () => window.menuPopup.choose(it.action));
    menuEl.appendChild(d);
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.menuPopup.close();
});
