'use strict';

// find.js — UI for the floating "Find in page" bar. Sends the query to main
// (which calls findInPage on the active <webview>) and shows the n/N counter.
// No inline HTML handlers (CSP).

const input = document.getElementById('find-input');
const countEl = document.getElementById('find-count');
const prevBtn = document.getElementById('find-prev');
const nextBtn = document.getElementById('find-next');
const closeBtn = document.getElementById('find-close');

let lastText = '';

function search(forward, findNext) {
  const text = input.value;
  if (!text) { countEl.textContent = '0/0'; window.findPopup.stop(); lastText = ''; return; }
  lastText = text;
  window.findPopup.query(text, { forward: forward !== false, findNext: !!findNext });
}

input.addEventListener('input', () => search(true, false));
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); search(!e.shiftKey, true); }
  else if (e.key === 'Escape') { e.preventDefault(); window.findPopup.close(); }
});
prevBtn.addEventListener('click', () => search(false, true));
nextBtn.addEventListener('click', () => search(true, true));
closeBtn.addEventListener('click', () => window.findPopup.close());

window.findPopup.onData(({ dark, query, labels } = {}) => {
  document.body.classList.toggle('light', !dark);
  if (labels) {
    if (labels.placeholder) input.placeholder = labels.placeholder;
    if (labels.prev) prevBtn.title = labels.prev;
    if (labels.next) nextBtn.title = labels.next;
    if (labels.close) closeBtn.title = labels.close;
  }
  if (query) { input.value = query; }
  input.focus();
  input.select();
  if (input.value) search(true, false);
});

window.findPopup.onResult((r) => {
  if (r && typeof r.matches === 'number') {
    countEl.textContent = (r.activeMatchOrdinal || 0) + '/' + r.matches;
  }
});
