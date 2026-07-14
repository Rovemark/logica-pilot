'use strict';

/**
 * hygiene.js — State hygiene (wipe) + health check + raw HTML + speed mode.
 *
 * - wipe: clean cookies/storage/tabs between tasks
 * - health: alive check with port/tab/crash info
 * - html: raw HTML of the page (escape hatch)
 * - fast: reduce/disable auto-wait for speed-critical operations
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wipe browser state for a clean slate between tasks.
 * @param {object} page - CDP page
 * @param {object} opts - { cookies, storage, cache, tabs }
 */
async function wipe(page, { cookies = true, storage = true, cache = false, olderThanDays } = {}) {
  const results = {};

  if (cookies) {
    await page.send('Network.enable').catch(() => {});

    if (olderThanDays) {
      // Only clear cookies older than N days
      const threshold = Date.now() / 1000 - (olderThanDays * 86400);
      const { cookies: all } = await page.send('Network.getAllCookies').catch(() => ({ cookies: [] }));
      let cleared = 0;
      for (const c of all) {
        // cookies without expires are session cookies — clear them too if they're "old"
        if (!c.expires || c.expires === -1 || c.expires < threshold) {
          await page.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path }).catch(() => {});
          cleared++;
        }
      }
      results.cookies = { cleared, total: all.length };
    } else {
      await page.send('Network.clearBrowserCookies').catch(() => {});
      results.cookies = { cleared: 'all' };
    }
  }

  if (storage) {
    await page.eval(`
      try { localStorage.clear(); } catch(e) {}
      try { sessionStorage.clear(); } catch(e) {}
    `).catch(() => {});
    results.storage = { cleared: true };
  }

  if (cache) {
    await page.send('Network.clearBrowserCache').catch(() => {});
    results.cache = { cleared: true };
  }

  return { ok: true, wiped: results };
}

/**
 * Health check — is the browser alive and responsive?
 * @param {object} page - CDP page
 * @param {object} conn - CDP connection (browser-level, optional)
 */
async function health(page, conn) {
  const result = {
    alive: false,
    url: null,
    title: null,
    tabs: 0,
    uptime: null,
    memory: null,
    errors: [],
  };

  // Check page is responsive
  try {
    result.url = await Promise.race([
      page.eval('location.href'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
    ]);
    result.title = await page.eval('document.title').catch(() => '');
    result.alive = true;
  } catch (e) {
    result.errors.push(`page unresponsive: ${e.message}`);
  }

  // Count open tabs
  if (conn) {
    try {
      const { targetInfos } = await conn.send('Target.getTargets', {});
      const pages = (targetInfos || []).filter((t) => t.type === 'page');
      result.tabs = pages.length;

      // Check for crashed tabs
      const crashed = pages.filter((t) => (t.url || '').includes('chrome://crash') || t.title === 'Aw, Snap!');
      if (crashed.length) {
        result.errors.push(`${crashed.length} crashed tab(s)`);
      }
    } catch (e) {
      result.errors.push(`target enumeration failed: ${e.message}`);
    }
  }

  // Memory
  try {
    const mem = await page.eval(
      `performance.memory ? { used: Math.round(performance.memory.usedJSHeapSize/1024/1024), total: Math.round(performance.memory.totalJSHeapSize/1024/1024) } : null`
    );
    result.memory = mem;
  } catch {}

  return result;
}

/**
 * Get the raw HTML of the page (escape hatch — NOT recommended for token-sensitive flows).
 * @param {object} page - CDP page
 * @param {object} opts - { selector?: string, outer?: boolean }
 */
async function rawHtml(page, { selector, outer = true } = {}) {
  if (selector) {
    const html = await page.eval(
      `(function(){var el=document.querySelector(${JSON.stringify(selector)});` +
      `return el ? (${outer ? 'el.outerHTML' : 'el.innerHTML'}) : null;})()`
    );
    return { ok: !!html, html: html ? html.slice(0, 100000) : null, selector };
  }

  const html = await page.eval('document.documentElement.outerHTML');
  return { ok: !!html, html: html ? html.slice(0, 200000) : null, chars: html ? html.length : 0 };
}

/**
 * Fast mode — reduce or disable auto-wait for speed-critical operations.
 * This works by setting minimal wait times in the page context.
 * @param {object} page - CDP page
 * @param {boolean} enabled - true to enable fast mode
 */
async function setFastMode(page, enabled = true) {
  if (enabled) {
    // Disable animations and transitions
    await page.eval(`
      (function() {
        var style = document.createElement('style');
        style.id = '__lpilot_fast';
        style.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; animation-duration: 0s !important; transition-duration: 0s !important; }';
        document.head.appendChild(style);
      })()
    `).catch(() => {});

    // Add script to speed up timers (reduce setTimeout/setInterval delays)
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        (function() {
          var style = document.createElement('style');
          style.id = '__lpilot_fast';
          style.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
          if (document.head) document.head.appendChild(style);
          else document.addEventListener('DOMContentLoaded', function() { document.head.appendChild(style); });
        })();
      `,
    }).catch(() => {});

    return { ok: true, fastMode: 'enabled', note: 'animations/transitions disabled' };
  }

  // Disable fast mode
  await page.eval(`
    (function() { var s = document.getElementById('__lpilot_fast'); if (s) s.remove(); })()
  `).catch(() => {});

  return { ok: true, fastMode: 'disabled' };
}

/**
 * Control the real browser window: minimize / maximize / fullscreen / normal,
 * or move it off-screen (headful only — no-op-ish in headless). Uses CDP
 * Browser.setWindowBounds. `state` = normal|minimized|maximized|fullscreen|offscreen.
 */
async function setWindow(page, conn, { state, left, top, width, height } = {}) {
  const c = conn || (page && page._c);
  if (!c) return { ok: false, error: 'no CDP connection' };
  let windowId;
  try {
    const r = await c.send('Browser.getWindowForTarget', page && page.targetId ? { targetId: page.targetId } : {});
    windowId = r && r.windowId;
  } catch (e) { return { ok: false, error: 'getWindowForTarget: ' + e.message }; }
  if (windowId == null) return { ok: false, error: 'no window (headless?)' };

  let bounds;
  if (state === 'offscreen') bounds = { left: -32000, top: -32000, windowState: 'normal' };
  else if (state && state !== 'normal') bounds = { windowState: state };
  else bounds = { windowState: 'normal', ...(left != null ? { left } : {}), ...(top != null ? { top } : {}), ...(width != null ? { width } : {}), ...(height != null ? { height } : {}) };

  try { await c.send('Browser.setWindowBounds', { windowId, bounds }); }
  catch (e) { return { ok: false, error: 'setWindowBounds: ' + e.message }; }
  return { ok: true, windowId, state: state || 'normal' };
}

module.exports = { wipe, health, rawHtml, setFastMode, setWindow };
