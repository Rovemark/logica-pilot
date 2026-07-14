'use strict';

/**
 * captcha.js — CAPTCHA detection + (opt-in) solving.
 *
 * Philosophy: the honest default is DETECT + hand off to a human (`handoff` tool).
 * Automated solving is GATED OFF and only runs when the operator explicitly opts in
 * with their own third-party solver credentials — this keeps Logica Pilot from
 * shipping a bypass tool that "just works" against sites that don't want bots.
 *
 * Enable solving (per operator, at their own risk / ToS):
 *   LOGICA_PILOT_CAPTCHA=1
 *   LOGICA_PILOT_CAPTCHA_PROVIDER=2captcha        (2captcha-compatible HTTP API)
 *   LOGICA_PILOT_CAPTCHA_KEY=<your solver api key>
 *
 * Zero-dependency: uses Node's global fetch (Node 18+).
 */

const DETECT = `(() => {
  const out = { found: false, type: null, sitekey: null, iframes: [] };
  const grab = (sel, type, attr) => {
    const el = document.querySelector(sel);
    if (el) { out.found = true; out.type = out.type || type; out.sitekey = out.sitekey || (attr && el.getAttribute(attr)) || null; }
  };
  grab('.g-recaptcha[data-sitekey]', 'recaptcha', 'data-sitekey');
  grab('.h-captcha[data-sitekey]', 'hcaptcha', 'data-sitekey');
  grab('.cf-turnstile[data-sitekey]', 'turnstile', 'data-sitekey');
  for (const f of document.querySelectorAll('iframe')) {
    const src = f.src || '';
    if (/recaptcha/i.test(src)) { out.found = true; out.type = out.type || 'recaptcha'; out.iframes.push('recaptcha'); }
    else if (/hcaptcha/i.test(src)) { out.found = true; out.type = out.type || 'hcaptcha'; out.iframes.push('hcaptcha'); }
    else if (/challenges\\.cloudflare\\.com/i.test(src)) { out.found = true; out.type = out.type || 'turnstile'; out.iframes.push('turnstile'); }
  }
  // Cloudflare "I'm under attack" interstitial
  if (document.title && /just a moment|checking your browser|attention required/i.test(document.title)) {
    out.found = true; out.type = out.type || 'cloudflare-interstitial';
  }
  return out;
})()`;

/** Detect a CAPTCHA / bot-wall on the current page. Read-only. */
async function detect(page) {
  const r = await page.eval(DETECT).catch(() => null);
  return r || { found: false, type: null, sitekey: null, iframes: [] };
}

function enabled() {
  return process.env.LOGICA_PILOT_CAPTCHA === '1' && !!process.env.LOGICA_PILOT_CAPTCHA_KEY;
}

/**
 * Solve a detected CAPTCHA. GATED: returns a handoff recommendation unless the
 * operator opted in with a solver key. When enabled, submits the sitekey+pageurl
 * to a 2captcha-compatible endpoint and injects the returned token.
 */
async function solve(page, { pageUrl } = {}) {
  const info = await detect(page);
  if (!info.found) return { solved: false, found: false, message: 'no CAPTCHA detected' };

  if (!enabled()) {
    return {
      solved: false, found: true, type: info.type, gated: true,
      message: 'CAPTCHA solving is opt-in and OFF. Either hand off to a human with the `handoff` tool, '
        + 'or set LOGICA_PILOT_CAPTCHA=1 + LOGICA_PILOT_CAPTCHA_KEY (2captcha-compatible) to enable automated solving at your own risk.',
    };
  }
  if (!info.sitekey) return { solved: false, found: true, type: info.type, message: 'sitekey not found; use the `handoff` tool for interactive solving' };
  if (info.type === 'cloudflare-interstitial') return { solved: false, found: true, type: info.type, message: 'Cloudflare JS interstitial — use stealth mode + retry, or `handoff`; token solving does not apply' };

  const provider = (process.env.LOGICA_PILOT_CAPTCHA_PROVIDER || '2captcha').toLowerCase();
  const key = process.env.LOGICA_PILOT_CAPTCHA_KEY;
  const url = pageUrl || (await page.eval('location.href').catch(() => '')) || '';
  const base = process.env.LOGICA_PILOT_CAPTCHA_BASE || 'https://2captcha.com';
  const method = info.type === 'hcaptcha' ? 'hcaptcha' : info.type === 'turnstile' ? 'turnstile' : 'userrecaptcha';

  if (provider !== '2captcha') return { solved: false, found: true, message: `provider "${provider}" not supported; use 2captcha-compatible or \`handoff\`` };

  // Submit
  const inUrl = `${base}/in.php?key=${encodeURIComponent(key)}&method=${method}&googlekey=${encodeURIComponent(info.sitekey)}&sitekey=${encodeURIComponent(info.sitekey)}&pageurl=${encodeURIComponent(url)}&json=1`;
  const submit = await fetch(inUrl).then((r) => r.json()).catch((e) => ({ status: 0, request: String(e) }));
  if (!submit || submit.status !== 1) return { solved: false, found: true, message: `solver submit failed: ${submit && submit.request}` };
  const id = submit.request;

  // Poll for the token (up to ~120s)
  let token = null;
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(`${base}/res.php?key=${encodeURIComponent(key)}&action=get&id=${id}&json=1`).then((r) => r.json()).catch(() => null);
    if (res && res.status === 1) { token = res.request; break; }
    if (res && res.request && res.request !== 'CAPCHA_NOT_READY') return { solved: false, found: true, message: `solver error: ${res.request}` };
  }
  if (!token) return { solved: false, found: true, message: 'solver timeout (~120s)' };

  // Inject the token into the standard response fields + fire common callbacks.
  await page.eval(`(() => {
    const set = (sel) => { const el = document.querySelector(sel); if (el) { el.value = ${JSON.stringify(token)}; el.style.display=''; } };
    set('#g-recaptcha-response'); set('textarea[name="g-recaptcha-response"]');
    set('[name="h-captcha-response"]'); set('[name="cf-turnstile-response"]');
    try { if (typeof ___grecaptcha_cfg !== 'undefined') { for (const k in ___grecaptcha_cfg.clients) {} } } catch {}
  })()`).catch(() => {});

  return { solved: true, found: true, type: info.type, token: token.slice(0, 12) + '…' };
}

module.exports = { detect, solve, enabled };
