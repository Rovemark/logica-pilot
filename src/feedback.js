'use strict';

/**
 * feedback.js — Visual feedback injection for debug/demo.
 *
 * - Cursor visualization (shows where the AI is clicking)
 * - Click ripples (visual confirmation of clicks)
 * - Keystroke overlay (shows what's being typed)
 * - "AI in control" toast notification
 * - Green glow on interacted elements
 */

/**
 * Inject the feedback overlay system into the page.
 * @param {object} page - CDP page
 * @param {object} opts - { cursor, ripples, keystrokes, toast, glow }
 */
async function injectFeedback(page, {
  cursor = true,
  ripples = true,
  keystrokes = false,
  toast = true,
  glow = true,
} = {}) {
  const script = `
    (function() {
      if (window.__lpilot_feedback) return;
      window.__lpilot_feedback = true;

      var style = document.createElement('style');
      style.id = '__lpilot_feedback_css';
      style.textContent = \`
        ${cursor ? `
        #__lp_cursor {
          position: fixed; z-index: 2147483646; pointer-events: none;
          width: 20px; height: 20px; border-radius: 50%;
          border: 2px solid #34C759; background: rgba(52,199,89,0.3);
          transform: translate(-50%, -50%); transition: all 0.15s ease;
          display: none;
        }
        #__lp_cursor.active { display: block; }
        ` : ''}

        ${ripples ? `
        .lp-ripple {
          position: fixed; z-index: 2147483645; pointer-events: none;
          width: 40px; height: 40px; border-radius: 50%;
          border: 2px solid #34C759; background: rgba(52,199,89,0.2);
          transform: translate(-50%, -50%) scale(0);
          animation: lp-ripple-anim 0.6s ease-out forwards;
        }
        @keyframes lp-ripple-anim {
          0% { transform: translate(-50%, -50%) scale(0); opacity: 1; }
          100% { transform: translate(-50%, -50%) scale(3); opacity: 0; }
        }
        ` : ''}

        ${glow ? `
        .lp-glow {
          box-shadow: 0 0 8px 2px rgba(52,199,89,0.6) !important;
          transition: box-shadow 0.3s ease;
        }
        ` : ''}

        ${toast ? `
        #__lp_toast {
          position: fixed; top: 12px; right: 12px; z-index: 2147483647;
          background: #FF3B30; color: #fff; padding: 8px 16px;
          border-radius: 8px; font: bold 13px/1.4 -apple-system, sans-serif;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3); pointer-events: none;
          display: flex; align-items: center; gap: 8px;
          animation: lp-toast-pulse 2s ease infinite;
        }
        #__lp_toast::before {
          content: '🤖'; font-size: 16px;
        }
        @keyframes lp-toast-pulse {
          0%, 100% { opacity: 0.9; }
          50% { opacity: 1; }
        }
        ` : ''}

        ${keystrokes ? `
        #__lp_keys {
          position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%);
          z-index: 2147483647; pointer-events: none;
          background: rgba(0,0,0,0.8); color: #34C759; padding: 6px 14px;
          border-radius: 6px; font: 14px/1.4 ui-monospace, monospace;
          max-width: 400px; overflow: hidden; white-space: nowrap;
          text-overflow: ellipsis; opacity: 0; transition: opacity 0.2s;
        }
        #__lp_keys.active { opacity: 1; }
        ` : ''}
      \`;
      document.head.appendChild(style);

      ${cursor ? `
      var cur = document.createElement('div');
      cur.id = '__lp_cursor';
      document.documentElement.appendChild(cur);
      ` : ''}

      ${toast ? `
      var toast = document.createElement('div');
      toast.id = '__lp_toast';
      toast.textContent = 'IA no controle';
      document.documentElement.appendChild(toast);
      ` : ''}

      ${keystrokes ? `
      var keys = document.createElement('div');
      keys.id = '__lp_keys';
      document.documentElement.appendChild(keys);
      ` : ''}

      // Expose control functions
      window.__lp_showCursor = function(x, y) {
        ${cursor ? `cur.style.left = x + 'px'; cur.style.top = y + 'px'; cur.classList.add('active');` : ''}
      };

      window.__lp_showRipple = function(x, y) {
        ${ripples ? `
        var r = document.createElement('div');
        r.className = 'lp-ripple';
        r.style.left = x + 'px'; r.style.top = y + 'px';
        document.documentElement.appendChild(r);
        setTimeout(function() { r.remove(); }, 700);
        ` : ''}
      };

      window.__lp_showKeystroke = function(text) {
        ${keystrokes ? `
        keys.textContent = text;
        keys.classList.add('active');
        clearTimeout(keys._t);
        keys._t = setTimeout(function() { keys.classList.remove('active'); }, 2000);
        ` : ''}
      };

      window.__lp_glowElement = function(selector) {
        ${glow ? `
        var el = document.querySelector(selector);
        if (el) {
          el.classList.add('lp-glow');
          setTimeout(function() { el.classList.remove('lp-glow'); }, 1500);
        }
        ` : ''}
      };

      window.__lp_removeFeedback = function() {
        var s = document.getElementById('__lpilot_feedback_css'); if (s) s.remove();
        ${cursor ? 'var c = document.getElementById("__lp_cursor"); if (c) c.remove();' : ''}
        ${toast ? 'var t = document.getElementById("__lp_toast"); if (t) t.remove();' : ''}
        ${keystrokes ? 'var k = document.getElementById("__lp_keys"); if (k) k.remove();' : ''}
        window.__lpilot_feedback = false;
      };
    })();
  `;

  await page.eval(script).catch(() => {});

  // Also inject on future navigations
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: script }).catch(() => {});

  return { ok: true, features: { cursor, ripples, keystrokes, toast, glow } };
}

/**
 * Remove all feedback overlays.
 */
async function removeFeedback(page) {
  await page.eval('if(window.__lp_removeFeedback) __lp_removeFeedback()').catch(() => {});
  return { ok: true };
}

/**
 * Show cursor at position (for external action hooks).
 */
async function showCursor(page, x, y) {
  await page.eval(`if(window.__lp_showCursor) __lp_showCursor(${x},${y})`).catch(() => {});
}

/**
 * Show click ripple.
 */
async function showRipple(page, x, y) {
  await page.eval(`if(window.__lp_showRipple) __lp_showRipple(${x},${y})`).catch(() => {});
}

/**
 * Show keystroke overlay.
 */
async function showKeystroke(page, text) {
  await page.eval(`if(window.__lp_showKeystroke) __lp_showKeystroke(${JSON.stringify(text)})`).catch(() => {});
}

/**
 * Glow an element.
 */
async function glowElement(page, selector) {
  await page.eval(`if(window.__lp_glowElement) __lp_glowElement(${JSON.stringify(selector)})`).catch(() => {});
}

module.exports = { injectFeedback, removeFeedback, showCursor, showRipple, showKeystroke, glowElement };
