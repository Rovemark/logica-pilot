'use strict';

/**
 * consent.js — Kill cookie banners, consent walls and soft popups BEFORE
 * perception runs (feature #8). A banner sitting over the page pollutes the
 * whole indexed map (dozens of junk elements + a blur), wastes tokens and often
 * blocks the real content. Removing it first makes every downstream tool cheaper
 * and more reliable.
 *
 * Strategy (in order, all in-page, 0-dep):
 *   1. Click a known CMP dismiss control (OneTrust/Cookiebot/Quantcast/…),
 *      preferring reject/close over accept so we don't consent on the user's behalf.
 *   2. Click a button whose visible label matches a dismiss phrase (multi-language).
 *   3. Nuke leftover full-screen fixed overlays + restore body scroll.
 */

/* eslint-disable */
// Phase 1: click a dismiss control (known CMP, then a labelled button inside a
// consent container). Prefer reject/close over accept. Returns {clicked, via}.
function __lp_consent_click() {
  var clicked = 0, via = '';
  function vis(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect(); var s = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0.05;
  }
  function clickIt(el) { try { el.scrollIntoView({ block: 'center' }); el.click(); clicked++; return true; } catch (e) { return false; } }
  var CMP = [
    '#onetrust-reject-all-handler', '.ot-pc-refuse-all-handler', '#onetrust-accept-btn-handler',
    '#CybotCookiebotDialogBodyButtonDecline', '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll', '#CybotCookiebotDialogBodyButtonAccept',
    '.qc-cmp2-summary-buttons button[mode="secondary"]', '.qc-cmp2-summary-buttons button[mode="primary"]',
    'button[data-testid="uc-deny-all-button"]', 'button[data-testid="uc-accept-all-button"]',
    '.fc-cta-consent', '.fc-cta-do-not-consent', '#didomi-notice-agree-button', '.didomi-continue-without-agreeing',
    'button#gdpr-consent-accept', '[aria-label="dismiss cookie message"]', '.cookie-consent-accept',
    'button.cc-dismiss', 'a.cc-dismiss', '.cc-btn.cc-allow', '#hs-eu-confirmation-button',
  ];
  for (var i = 0; i < CMP.length; i++) {
    var el = document.querySelector(CMP[i]);
    if (el && vis(el) && clickIt(el)) return { clicked: clicked, via: 'cmp:' + CMP[i] };
  }
  var PHRASES = [
    'accept all', 'accept cookies', 'i accept', 'allow all', 'got it', 'agree', 'i agree',
    'aceitar', 'aceitar todos', 'aceitar tudo', 'concordo', 'entendi', 'permitir',
    'reject all', 'reject', 'decline', 'necessary only', 'only necessary', 'deny',
    'rejeitar', 'recusar', 'somente necess', 'apenas necess', 'fechar', 'close',
    'akzeptieren', 'alle akzeptieren', 'ablehnen', 'accepter', 'tout accepter', 'refuser',
    'aceptar', 'aceptar todo', 'rechazar',
  ];
  var btns = [].slice.call(document.querySelectorAll('button, a[role="button"], [role="button"], input[type="button"], input[type="submit"]'));
  for (var j = 0; j < btns.length; j++) {
    var b = btns[j];
    var t = (b.innerText || b.value || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!t || t.length > 40 || !vis(b)) continue;
    for (var p = 0; p < PHRASES.length; p++) {
      if (t === PHRASES[p] || (PHRASES[p].length > 5 && t.indexOf(PHRASES[p]) >= 0)) {
        var ctx = b.closest('[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[id*="gdpr" i],[class*="gdpr" i],[aria-label*="cookie" i],[class*="cmp" i]');
        if (ctx && clickIt(b)) return { clicked: clicked, via: 'phrase:' + t };
      }
    }
  }
  return { clicked: 0, via: '' };
}

// Phase 2 (after a short wait): remove leftover full-screen blocking overlays and
// free the scroll. Conservative: only fixed/sticky elements covering most of the
// viewport with a high z-index OR a consent-ish id/class.
function __lp_consent_clean() {
  var removed = 0;
  function vis(el) { var r = el.getBoundingClientRect(); var s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0.05; }
  var all = document.querySelectorAll('div,section,aside,dialog');
  for (var k = 0; k < all.length && removed < 6; k++) {
    var e = all[k]; var s = getComputedStyle(e);
    if ((s.position !== 'fixed' && s.position !== 'sticky') || !vis(e)) continue;
    var r = e.getBoundingClientRect();
    var big = r.width >= innerWidth * 0.6 && r.height >= innerHeight * 0.4;
    var z = parseInt(s.zIndex || '0', 10) || 0;
    var looksConsent = /cookie|consent|gdpr|newsletter|subscribe|paywall|modal|overlay|backdrop/i.test((e.id || '') + ' ' + (typeof e.className === 'string' ? e.className : ''));
    if (big && (z >= 1000 || looksConsent)) { try { e.remove(); removed++; } catch (x) {} }
  }
  if (removed) { try { document.documentElement.style.overflow = ''; document.body.style.overflow = ''; document.body.style.position = ''; } catch (x) {} }
  return { removed: removed };
}
/* eslint-enable */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Dismiss consent/cookie overlays: click a dismiss control, let the site react,
 *  then remove any overlay still blocking the page. Best-effort, never throws. */
async function dismissConsent(page) {
  try {
    const c = await page.eval(`(${__lp_consent_click.toString()})()`);
    if (c && c.clicked) await sleep(250); // give the site's own JS time to close the banner
    const r = await page.eval(`(${__lp_consent_clean.toString()})()`);
    return { clicked: (c && c.clicked) || 0, removed: (r && r.removed) || 0, via: (c && c.via) || undefined };
  } catch { return { clicked: 0, removed: 0 }; }
}

module.exports = { dismissConsent };
