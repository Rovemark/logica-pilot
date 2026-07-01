'use strict';

// perm.js — UI of the floating permission prompt. Renders the text sent by
// main and responds with granted=true/false. No inline HTML with handlers (CSP).

const textEl = document.getElementById('pp-text');
const allowBtn = document.getElementById('pp-allow');
const denyBtn = document.getElementById('pp-deny');

allowBtn.addEventListener('click', () => window.permPopup.respond(true));
denyBtn.addEventListener('click', () => window.permPopup.respond(false));

// Esc = deny (same behavior as old prompt).
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.permPopup.respond(false);
});

window.permPopup.onData(({ origin, permission, dark, labels } = {}) => {
  document.body.classList.toggle('light', !dark);
  const L = labels || {};
  if (L.allow) allowBtn.textContent = L.allow;
  if (L.deny) denyBtn.textContent = L.deny;
  const wl = L.what || {};
  const genericTpl = wl.generic || 'use: {what}';
  const what = wl[permission] || genericTpl.replace('{what}', permission);
  const who = origin || L.site || 'The website';
  const tpl = L.text || '{origin} wants {what}.';

  // Render the sentence with the origin bolded: split the template on {origin}.
  textEl.innerHTML = '';
  const [before = '', after = ''] = tpl.split('{origin}');
  const pre = before.replace('{what}', what);
  if (pre) textEl.appendChild(document.createTextNode(pre));
  const whoEl = document.createElement('b');
  whoEl.textContent = who;
  textEl.appendChild(whoEl);
  const post = after.replace('{what}', what);
  if (post) textEl.appendChild(document.createTextNode(post));
});
