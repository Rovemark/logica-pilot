'use strict';

/**
 * handoff.js — Human handoff (feature #6). When the agent hits a wall it should
 * NOT try to bypass — a login, a captcha, a Cloudflare challenge, a payment — it
 * hands control back to you: surfaces the (desktop/attached) window, waits while
 * you resolve it in seconds, then continues with the now-authenticated session.
 * The ethical, more-robust answer to "stealth" — and impossible for a cloud API.
 */

/* eslint-disable */
function __lp_handoff_detect() {
  function vis(el) { if (!el) return false; var r = el.getBoundingClientRect(); var s = getComputedStyle(el); return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none'; }
  var body = (document.body ? document.body.innerText : '') || '';
  var html = document.documentElement.innerHTML || '';
  // Captcha / anti-bot
  if (document.querySelector('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="turnstile"],.g-recaptcha,.h-captcha,#cf-challenge-running,.cf-turnstile')) return { needed: true, kind: 'captcha', hint: 'solve the captcha' };
  if (/checking your browser|verify you are human|are you a robot|unusual traffic|complete the security check/i.test(body)) return { needed: true, kind: 'challenge', hint: 'pass the anti-bot / verification challenge' };
  if (/cf-browser-verification|__cf_chl/i.test(html) && /just a moment|checking/i.test(body)) return { needed: true, kind: 'cloudflare', hint: 'wait for / pass the Cloudflare check' };
  // Login wall: a visible password field with no meaningful content behind it
  var pw = document.querySelector('input[type="password"]');
  if (pw && vis(pw)) {
    var contentLen = body.replace(/\s+/g, ' ').trim().length;
    return { needed: true, kind: 'login', hint: 'log in (a password field is present)', sparse: contentLen < 400 };
  }
  return { needed: false, kind: null };
}
/* eslint-enable */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Does the current page need a human? */
async function detect(page) {
  try { return await page.eval(`(${__lp_handoff_detect.toString()})()`); } catch { return { needed: false, kind: null }; }
}

/**
 * Wait while a human resolves the wall. Polls until the wall clears or timeout.
 * Best used with a VISIBLE window (desktop / headful / attach) the user can act in.
 * @returns {{resolved:boolean, kind, waitedMs}}
 */
async function waitForHuman(page, { timeoutMs = 180000, pollMs = 2000, onWait, bringToFront } = {}) {
  const start = Date.now();
  const first = await detect(page);
  if (!first.needed) return { resolved: true, kind: null, waitedMs: 0 };
  if (typeof bringToFront === 'function') { try { await bringToFront(); } catch {} }
  if (typeof onWait === 'function') { try { onWait(first); } catch {} }
  while (Date.now() - start < timeoutMs) {
    await sleep(pollMs);
    const d = await detect(page);
    if (!d.needed) return { resolved: true, kind: first.kind, waitedMs: Date.now() - start };
  }
  return { resolved: false, kind: first.kind, waitedMs: Date.now() - start };
}

module.exports = { detect, waitForHuman };
