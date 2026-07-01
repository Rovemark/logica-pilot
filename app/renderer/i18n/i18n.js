'use strict';
/**
 * i18n.js — Runtime for shell internationalization.
 * Loaded by <script> AFTER locales.js, BEFORE renderer.js.
 *
 * Usage in HTML (declarative):
 *   data-i18n="key"        → textContent
 *   data-i18n-title="key"  → title
 *   data-i18n-ph="key"     → placeholder
 *   data-i18n-aria="key"   → aria-label
 * Usage in JS: window.i18n.t('key', { var: value })
 *
 * Initial language: window.LP_LANG (injected), otherwise the <html lang>, otherwise pt-BR.
 * Change language: window.i18n.setLang('en') → reapplies to DOM + emits 'i18n:changed'.
 */
(function () {
  const LOCALES = window.LP_LOCALES || {};
  const FALLBACK = 'pt-BR';

  function pick(lang) {
    // 'auto'/empty → system language (Electron sets navigator.language from OS)
    if (!lang || lang === 'auto') {
      lang = (typeof navigator !== 'undefined' &&
        (navigator.language || (navigator.languages && navigator.languages[0]))) || FALLBACK;
    }
    if (LOCALES[lang]) return lang;
    // tolerates 'en-US' → 'en', 'pt-PT' → 'pt-BR', 'es-419' → 'es'
    const base = String(lang).toLowerCase().split('-')[0];
    const hit = Object.keys(LOCALES).find((k) => k.toLowerCase().split('-')[0] === base);
    return hit || FALLBACK;
  }

  let current = pick(window.LP_LANG || 'auto');

  function dict(lang) { return LOCALES[lang] || LOCALES[FALLBACK] || {}; }

  function t(key, vars) {
    const d = dict(current), f = dict(FALLBACK);
    let s = d[key] != null ? d[key] : (f[key] != null ? f[key] : key);
    if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
    return s;
  }

  function apply(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.getAttribute('data-i18n-title')); });
    root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
    root.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
    try { document.documentElement.lang = current; } catch {}
  }

  function setLang(lang) {
    const next = pick(lang);
    const changed = next !== current;
    current = next;
    apply(document);
    if (changed) { try { window.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang: current } })); } catch {} }
  }

  function available() {
    return Object.keys(LOCALES).map((id) => ({ id, name: (LOCALES[id] && LOCALES[id]['lang.name']) || id }));
  }

  window.i18n = { get lang() { return current; }, t, apply, setLang, available, FALLBACK };
})();
