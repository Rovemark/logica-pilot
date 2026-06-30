'use strict';

// perm.js — UI do prompt de permissão flutuante. Renderiza o texto enviado pelo
// main e responde com granted=true/false. Sem HTML inline com handlers (CSP).

const textEl = document.getElementById('pp-text');
const allowBtn = document.getElementById('pp-allow');
const denyBtn = document.getElementById('pp-deny');

allowBtn.addEventListener('click', () => window.permPopup.respond(true));
denyBtn.addEventListener('click', () => window.permPopup.respond(false));

// Esc = bloquear (mesmo comportamento do prompt antigo).
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.permPopup.respond(false);
});

window.permPopup.onData(({ origin, permission, dark }) => {
  document.body.classList.toggle('light', !dark);
  const labels = {
    media: 'usar câmera/microfone',
    geolocation: 'acessar sua localização',
    notifications: 'enviar notificações',
  };
  const what = labels[permission] || ('usar: ' + permission);
  textEl.innerHTML = '';
  const who = document.createElement('b');
  who.textContent = origin || 'O site';
  textEl.appendChild(who);
  textEl.appendChild(document.createTextNode(' quer ' + what + '.'));
});
