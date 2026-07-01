'use strict';

/* theme.js — shell theme system.
   Loaded early in <head> to apply the theme before main paint.
   User choice: 'light' | 'dark' | 'system' (persisted in localStorage 'lp.theme').
   When 'system', resolves via matchMedia and re-resolves on native main event. */

(function () {
  const STORAGE_KEY = 'lp.theme';
  const VALID = ['light', 'dark', 'system'];
  const root = document.documentElement;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');

  // override from main (nativeTheme) — takes priority over matchMedia when set
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

  // writes only the resolved attribute (light|dark) to <html>
  function paint(choice) {
    const resolved = choice === 'system' ? resolveSystem() : choice;
    root.setAttribute('data-theme', resolved);
    return resolved;
  }

  let current = load();
  paint(current); // applies immediately (before the rest of the app)

  // temporary smooth transition (does not block boot)
  function withTransition(fn) {
    root.classList.add('theme-transition');
    fn();
    setTimeout(() => root.classList.remove('theme-transition'), 260);
  }

  function persist(choice) {
    try { localStorage.setItem(STORAGE_KEY, choice); } catch {}
    // informs main to adjust nativeTheme.themeSource + window backgroundColor
    try { window.pilot && window.pilot.setTheme && window.pilot.setTheme({ mode: choice }); } catch {}
  }

  // applies a user choice (with transition + persistence)
  function apply(choice) {
    if (!VALID.includes(choice)) choice = 'system';
    current = choice;
    withTransition(() => paint(choice));
    persist(choice);
    notify();
    return choice;
  }

  // cycles light -> dark -> system
  function cycle() {
    const next = current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light';
    return apply(next);
  }

  function getChoice() { return current; }
  function getResolved() { return current === 'system' ? resolveSystem() : current; }

  // observers (renderer.js updates the button icon)
  const listeners = new Set();
  function onChange(cb) { if (typeof cb === 'function') listeners.add(cb); }
  function notify() { for (const cb of listeners) { try { cb(current, getResolved()); } catch {} } }

  // re-resolve 'system' when the OS changes (fallback from matchMedia)
  mq.addEventListener && mq.addEventListener('change', () => {
    if (current === 'system') { paint('system'); notify(); }
  });

  // exposes global API for renderer.js
  window.LPTheme = { load, apply, cycle, getChoice, getResolved, onChange };

  // binds the native main event when preload is ready
  function bindNative() {
    if (!window.pilot) return;
    // initial nativeTheme state (resolves 'system' without relying solely on matchMedia)
    if (window.pilot.getTheme) {
      Promise.resolve()
        .then(() => window.pilot.getTheme())
        .then((st) => {
          if (!st) return;
          if (typeof st.shouldUseDarkColors === 'boolean') nativeDark = st.shouldUseDarkColors;
          // reconciles: the persisted choice in main (settings.json) takes precedence over
          // localStorage cache, eliminating permanent divergence in 'light'/'dark'.
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
    // ensures main knows of the persisted choice on boot (backgroundColor)
    try { window.pilot.setTheme && window.pilot.setTheme({ mode: current }); } catch {}
  }

  if (window.pilot) bindNative();
  else window.addEventListener('DOMContentLoaded', bindNative, { once: true });
})();
