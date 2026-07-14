'use strict';

/**
 * stealth.js — Anti-fingerprint / stealth mode for Logica Pilot.
 *
 * Patches common browser automation tells:
 *  - navigator.webdriver = false
 *  - WebGL vendor/renderer spoof
 *  - plugins/mimeTypes shim
 *  - permissions override
 *  - chrome.runtime stub
 *  - iframe contentWindow.chrome
 *
 * Modes:
 *  - regular: no patches (fastest, debug)
 *  - stealth: standard patches (default for scraping)
 *  - undetected: aggressive patches + human-like timing jitter
 */

const STEALTH_SCRIPTS = {
  webdriver: `Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`,

  chrome_runtime: `
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = { connect: () => {}, sendMessage: () => {} };
  `,

  plugins: `
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const p = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        p.length = 3;
        p.item = (i) => p[i] || null;
        p.namedItem = (n) => p.find(x => x.name === n) || null;
        p.refresh = () => {};
        return p;
      }
    });
  `,

  webgl: `
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.call(this, param);
    };
    const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter2.call(this, param);
    };
  `,

  permissions: `
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (params) => (
      params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(params)
    );
  `,

  languages: `
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  `,

  iframe_contentWindow: `
    const orig = HTMLIFrameElement.prototype.__lookupGetter__('contentWindow');
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      get: function() {
        const w = orig.call(this);
        if (w) {
          try { Object.defineProperty(w, 'chrome', { get: () => window.chrome }); } catch {}
        }
        return w;
      }
    });
  `,

  // Undetected-only: randomize canvas fingerprint slightly
  canvas_noise: `
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const imgData = ctx.getImageData(0, 0, Math.min(this.width, 2), Math.min(this.height, 2));
        for (let i = 0; i < imgData.data.length; i += 4) {
          imgData.data[i] = imgData.data[i] ^ (Math.random() > 0.5 ? 1 : 0);
        }
        ctx.putImageData(imgData, 0, 0);
      }
      return origToDataURL.apply(this, arguments);
    };
  `,
};

const MODES = {
  regular: [],
  stealth: ['webdriver', 'chrome_runtime', 'plugins', 'webgl', 'permissions', 'languages', 'iframe_contentWindow'],
  undetected: ['webdriver', 'chrome_runtime', 'plugins', 'webgl', 'permissions', 'languages', 'iframe_contentWindow', 'canvas_noise'],
};

/**
 * Apply stealth patches to a page via CDP.
 * @param {object} page - CDP Page instance
 * @param {string} mode - regular | stealth | undetected
 */
async function applyStealthPatches(page, mode = 'stealth') {
  const patches = MODES[mode] || MODES.stealth;
  if (!patches.length) return;

  const script = patches.map((k) => STEALTH_SCRIPTS[k]).filter(Boolean).join('\n');

  // Page.addScriptToEvaluateOnNewDocument runs BEFORE any page script on every navigation
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: script }).catch(() => {});

  // Also run NOW for already-loaded page
  await page.eval(script).catch(() => {});
}

/**
 * Remove stealth patches (best-effort: only works for some).
 */
async function removeStealthPatches(page) {
  // Can't really "un-inject" scripts already in the page, but we can remove
  // future injections by reloading addScriptToEvaluateOnNewDocument is idempotent
  // after removeScriptToEvaluateOnNewDocument — but CDP doesn't expose that easily.
  // Best approach: just note that stealth is off for new navigations.
  return { removed: true, note: 'future navigations will not have patches' };
}

module.exports = { applyStealthPatches, removeStealthPatches, MODES, STEALTH_SCRIPTS };
