'use strict';

const card = document.getElementById('card');

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function fmt(tpl, n) { return String(tpl).split('{n}').join(n); }

function render(d) {
  document.body.classList.toggle('light', !d.dark);
  card.innerHTML = '';
  const L = d.labels || {};

  // Header: shield + title + master toggle
  const head = h('div', 'head');
  const shield = h('span', 'shield' + (d.enabled ? '' : ' off'));
  shield.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 2l8 3v6c0 5-3.4 8.6-8 11-4.6-2.4-8-6-8-11V5z"/></svg>';
  head.appendChild(shield);
  head.appendChild(h('span', 'title', L.title || 'Ad blocker'));
  const master = h('label', 'switch');
  const mchk = h('input');
  mchk.type = 'checkbox';
  mchk.checked = !!d.enabled;
  mchk.disabled = d.available === false;
  mchk.addEventListener('change', async () => {
    try { await window.adblockPanel.toggle(); } catch {}
    try { const nd = await window.adblockPanel.refresh(); render(Object.assign({ dark: d.dark }, nd)); } catch {}
  });
  master.appendChild(mchk);
  master.appendChild(h('span', 'slider'));
  head.appendChild(master);
  card.appendChild(head);

  // Blocked-on-this-page big number + total
  const big = h('div', 'big');
  big.appendChild(h('span', 'num', String(d.pageCount || 0)));
  big.appendChild(h('span', 'lbl', L.here || 'Blocked on this page'));
  card.appendChild(big);
  card.appendChild(h('div', 'total', fmt(L.total || '{n} blocked in total', d.count || 0)));

  // Per-site allow toggle
  const site = h('div', 'row' + (d.host ? '' : ' disabled'));
  const sl = h('div', 'sl');
  sl.appendChild(h('span', 'allow', L.allow || 'Allow ads on this site'));
  sl.appendChild(h('span', 'host', d.host || '—'));
  site.appendChild(sl);
  const asw = h('label', 'switch');
  const achk = h('input');
  achk.type = 'checkbox';
  achk.checked = !!d.allowed;
  achk.disabled = !d.host;
  achk.addEventListener('change', async () => {
    try {
      const nd = await window.adblockPanel.setAllowlist(d.host, achk.checked);
      window.adblockPanel.reloadActive();
      render(Object.assign({ dark: d.dark }, nd));
    } catch {}
  });
  asw.appendChild(achk);
  asw.appendChild(h('span', 'slider'));
  site.appendChild(asw);
  card.appendChild(site);

  // Footer: active filter lists
  card.appendChild(h('div', 'foot', (L.lists || 'Filter lists') + ': ' + ((d.lists || []).join(' · '))));
}

window.adblockPanel.onData(render);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.adblockPanel.close(); });
