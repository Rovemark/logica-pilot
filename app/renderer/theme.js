'use strict';

/* theme.js — sistema de tema da casca.
   Carregado cedo no <head> p/ aplicar o tema antes do paint principal.
   Escolha do usuário: 'light' | 'dark' | 'system' (persistida em localStorage 'lp.theme').
   Quando 'system', resolve via matchMedia e re-resolve no evento nativo do main. */

(function () {
  const STORAGE_KEY = 'lp.theme';
  const VALID = ['light', 'dark', 'system'];
  const root = document.documentElement;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');

  // override vindo do main (nativeTheme) — tem prioridade sobre matchMedia quando definido
  let nativeDark = null;

  function load() {
    let v = null;
    try { v = localStorage.getItem(STORAGE_KEY); } catch {}
    return VALID.includes(v) ? v : 'system';
  }

  function resolveSystem() {
    if (nativeDark === null) return mq.matches ? 'dark' : 'light';
    return nativeDark ? 'dark' : 'light';
  }

  // grava só o atributo resolvido (light|dark) no <html>
  function paint(choice) {
    const resolved = choice === 'system' ? resolveSystem() : choice;
    root.setAttribute('data-theme', resolved);
    return resolved;
  }

  let current = load();
  paint(current); // aplica imediatamente (antes do resto do app)

  // transição suave temporária (não bloqueia o boot)
  function withTransition(fn) {
    root.classList.add('theme-transition');
    fn();
    setTimeout(() => root.classList.remove('theme-transition'), 260);
  }

  function persist(choice) {
    try { localStorage.setItem(STORAGE_KEY, choice); } catch {}
    // informa o main p/ ajustar nativeTheme.themeSource + backgroundColor da janela
    try { window.pilot && window.pilot.setTheme && window.pilot.setTheme({ mode: choice }); } catch {}
  }

  // aplica uma escolha do usuário (com transição + persistência)
  function apply(choice) {
    if (!VALID.includes(choice)) choice = 'system';
    current = choice;
    withTransition(() => paint(choice));
    persist(choice);
    notify();
    return choice;
  }

  // cicla light -> dark -> system
  function cycle() {
    const next = current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light';
    return apply(next);
  }

  function getChoice() { return current; }
  function getResolved() { return current === 'system' ? resolveSystem() : current; }

  // observadores (renderer.js atualiza o ícone do botão)
  const listeners = new Set();
  function onChange(cb) { if (typeof cb === 'function') listeners.add(cb); }
  function notify() { for (const cb of listeners) { try { cb(current, getResolved()); } catch {} } }

  // re-resolve 'system' quando o SO troca (fallback do matchMedia)
  mq.addEventListener && mq.addEventListener('change', () => {
    if (current === 'system') { paint('system'); notify(); }
  });

  // expõe API global p/ renderer.js
  window.LPTheme = { load, apply, cycle, getChoice, getResolved, onChange };

  // liga o evento nativo do main quando o preload estiver pronto.
  function bindNative() {
    if (!window.pilot) return;
    // estado inicial do nativeTheme (resolve 'system' sem depender só do matchMedia)
    if (window.pilot.getTheme) {
      Promise.resolve()
        .then(() => window.pilot.getTheme())
        .then((st) => {
          if (!st) return;
          if (typeof st.shouldUseDarkColors === 'boolean') nativeDark = st.shouldUseDarkColors;
          // reconcilia: a escolha persistida no main (settings.json) prevalece sobre o
          // cache do localStorage, eliminando divergência permanente em 'light'/'dark'.
          if (VALID.includes(st.source) && st.source !== current) {
            current = st.source;
            try { localStorage.setItem(STORAGE_KEY, current); } catch {}
          }
          paint(current); notify();
        })
        .catch(() => {});
    }
    if (window.pilot.onNativeThemeUpdated) {
      window.pilot.onNativeThemeUpdated((d) => {
        if (d && typeof d.shouldUseDarkColors === 'boolean') nativeDark = d.shouldUseDarkColors;
        if (current === 'system') { paint('system'); notify(); }
      });
    }
    // garante que o main saiba da escolha persistida no boot (backgroundColor)
    try { window.pilot.setTheme && window.pilot.setTheme({ mode: current }); } catch {}
  }

  if (window.pilot) bindNative();
  else window.addEventListener('DOMContentLoaded', bindNative, { once: true });
})();
