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

window.permPopup.onData(({ origin, permission, dark }) => {
  document.body.classList.toggle('light', !dark);
  const labels = {
    media: 'use camera/microphone',
    geolocation: 'access your location',
    notifications: 'send notifications',
  };
  const what = labels[permission] || ('use: ' + permission);
  textEl.innerHTML = '';
  const who = document.createElement('b');
  who.textContent = origin || 'The website';
  textEl.appendChild(who);
  textEl.appendChild(document.createTextNode(' wants ' + what + '.'));
});
