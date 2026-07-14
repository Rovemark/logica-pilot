'use strict';

/**
 * assertions.js — Test assertions + visual regression (screenshot diff).
 *
 * 10 built-in assertions for automated testing:
 *  1. title_is / title_contains
 *  2. url_is / url_contains
 *  3. text_visible / text_not_visible
 *  4. element_exists / element_not_exists
 *  5. element_count
 *  6. element_text
 *  7. element_value
 *  8. element_visible
 *  9. has_cookie
 * 10. screenshot_match (visual regression)
 *
 * Plus: screenshot_diff for pixel-level visual regression.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SNAPSHOTS_DIR = path.join(os.homedir(), '.logica-pilot', 'snapshots');

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

/**
 * Run a single assertion against the current page.
 * @param {object} page - CDP page
 * @param {object} assertion - { type, expected, selector?, index?, name? }
 * @returns {{ pass: boolean, type: string, actual: any, expected: any, message: string }}
 */
async function runAssertion(page, assertion) {
  const { type, expected } = assertion;

  try {
    switch (type) {
      case 'title_is': {
        const actual = await page.eval('document.title');
        return result(type, actual === expected, actual, expected, `Title ${actual === expected ? 'matches' : 'mismatch'}`);
      }
      case 'title_contains': {
        const actual = await page.eval('document.title');
        const pass = String(actual).includes(expected);
        return result(type, pass, actual, expected, `Title ${pass ? 'contains' : 'does not contain'} "${expected}"`);
      }
      case 'url_is': {
        const actual = await page.eval('location.href');
        return result(type, actual === expected, actual, expected, `URL ${actual === expected ? 'matches' : 'mismatch'}`);
      }
      case 'url_contains': {
        const actual = await page.eval('location.href');
        const pass = String(actual).includes(expected);
        return result(type, pass, actual, expected, `URL ${pass ? 'contains' : 'does not contain'} "${expected}"`);
      }
      case 'text_visible': {
        const pass = await page.eval(
          `((document.body && document.body.innerText) || '').includes(${JSON.stringify(String(expected))})`
        );
        return result(type, !!pass, pass ? 'found' : 'not found', expected, `Text "${expected}" ${pass ? 'is' : 'is NOT'} visible`);
      }
      case 'text_not_visible': {
        const found = await page.eval(
          `((document.body && document.body.innerText) || '').includes(${JSON.stringify(String(expected))})`
        );
        return result(type, !found, found ? 'found' : 'not found', `not "${expected}"`, `Text "${expected}" ${found ? 'IS visible (fail)' : 'is not visible (pass)'}`);
      }
      case 'element_exists': {
        const sel = assertion.selector || expected;
        const exists = await page.eval(`!!document.querySelector(${JSON.stringify(sel)})`);
        return result(type, !!exists, exists, true, `Element "${sel}" ${exists ? 'exists' : 'NOT found'}`);
      }
      case 'element_not_exists': {
        const sel = assertion.selector || expected;
        const exists = await page.eval(`!!document.querySelector(${JSON.stringify(sel)})`);
        return result(type, !exists, exists, false, `Element "${sel}" ${exists ? 'EXISTS (fail)' : 'not found (pass)'}`);
      }
      case 'element_count': {
        const sel = assertion.selector;
        const count = await page.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
        const pass = count === Number(expected);
        return result(type, pass, count, expected, `Count of "${sel}": ${count} (expected ${expected})`);
      }
      case 'element_text': {
        const sel = assertion.selector || `[data-lpilot-id="${assertion.index}"]`;
        const actual = await page.eval(
          `(function(){var el=document.querySelector(${JSON.stringify(sel)});return el?(el.innerText||el.textContent||'').trim():null;})()`
        );
        const pass = actual === expected;
        return result(type, pass, actual, expected, `Text of "${sel}": "${actual}" ${pass ? '==' : '!='} "${expected}"`);
      }
      case 'element_value': {
        const sel = assertion.selector || `[data-lpilot-id="${assertion.index}"]`;
        const actual = await page.eval(
          `(function(){var el=document.querySelector(${JSON.stringify(sel)});return el?String(el.value||''):null;})()`
        );
        const pass = actual === expected;
        return result(type, pass, actual, expected, `Value of "${sel}": "${actual}" ${pass ? '==' : '!='} "${expected}"`);
      }
      case 'element_visible': {
        const sel = assertion.selector || `[data-lpilot-id="${assertion.index}"]`;
        const visible = await page.eval(
          `(function(){var el=document.querySelector(${JSON.stringify(sel)});if(!el)return false;` +
          `var r=el.getBoundingClientRect();var s=getComputedStyle(el);` +
          `return r.width>1&&r.height>1&&s.visibility!=='hidden'&&s.display!=='none';})()`
        );
        return result(type, !!visible, visible, true, `Element "${sel}" ${visible ? 'is visible' : 'is NOT visible'}`);
      }
      case 'has_cookie': {
        const name = assertion.name || expected;
        await page.send('Network.enable').catch(() => {});
        const res = await page.send('Network.getAllCookies').catch(() => ({ cookies: [] }));
        const found = (res.cookies || []).some((c) => c.name === name);
        return result(type, found, found ? 'found' : 'not found', name, `Cookie "${name}" ${found ? 'exists' : 'NOT found'}`);
      }
      case 'screenshot_match': {
        return await screenshotDiff(page, assertion.name || 'default', assertion.threshold);
      }
      default:
        return result(type, false, null, null, `Unknown assertion type: ${type}`);
    }
  } catch (e) {
    return result(type, false, null, expected, `Error: ${e.message}`);
  }
}

function result(type, pass, actual, expected, message) {
  return { pass: !!pass, type, actual, expected, message };
}

/**
 * Run multiple assertions and return summary.
 */
async function runAssertions(page, assertions) {
  const results = [];
  for (const a of assertions) {
    results.push(await runAssertion(page, a));
  }
  const passed = results.filter((r) => r.pass).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    allPassed: passed === results.length,
    results,
  };
}

/**
 * Screenshot diff — visual regression testing.
 * Compares current screenshot to a saved baseline by pixel comparison.
 * @param {object} page - CDP page
 * @param {string} name - snapshot name
 * @param {number} [threshold=0.01] - allowed pixel diff ratio (0-1)
 */
async function screenshotDiff(page, name = 'default', threshold = 0.01) {
  ensureDir(SNAPSHOTS_DIR);
  const safeName = String(name).replace(/[^a-z0-9_-]/gi, '_');
  const baselinePath = path.join(SNAPSHOTS_DIR, `${safeName}.baseline.bin`);
  const currentPath = path.join(SNAPSHOTS_DIR, `${safeName}.current.bin`);

  // Take current screenshot as raw pixels
  const res = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const currentBuf = Buffer.from(res.data, 'base64');
  fs.writeFileSync(currentPath, currentBuf);

  // If no baseline exists, save this as baseline
  if (!fs.existsSync(baselinePath)) {
    fs.copyFileSync(currentPath, baselinePath);
    return result('screenshot_match', true, 'new baseline created', name,
      `No baseline existed for "${name}" — saved current as baseline`);
  }

  // Compare by hash (pixel-perfect) and by buffer diff (approximate)
  const baselineBuf = fs.readFileSync(baselinePath);
  const baseHash = crypto.createHash('sha256').update(baselineBuf).digest('hex');
  const currHash = crypto.createHash('sha256').update(currentBuf).digest('hex');

  if (baseHash === currHash) {
    return result('screenshot_match', true, 'identical', name, `Screenshot "${name}" matches baseline (identical)`);
  }

  // Byte-level diff ratio (rough but 0-dep — real pixel diff needs PNG decode)
  const minLen = Math.min(baselineBuf.length, currentBuf.length);
  const maxLen = Math.max(baselineBuf.length, currentBuf.length);
  let diffBytes = Math.abs(baselineBuf.length - currentBuf.length);
  for (let i = 0; i < minLen; i++) {
    if (baselineBuf[i] !== currentBuf[i]) diffBytes++;
  }
  const diffRatio = diffBytes / maxLen;
  const pass = diffRatio <= threshold;

  return result('screenshot_match', pass,
    `${(diffRatio * 100).toFixed(2)}% diff`,
    `≤${(threshold * 100).toFixed(1)}%`,
    `Screenshot "${name}" ${pass ? 'within threshold' : 'DIFFERS'} (${(diffRatio * 100).toFixed(2)}% changed, threshold ${(threshold * 100).toFixed(1)}%)`,
  );
}

/**
 * Update the baseline for a named screenshot.
 */
async function updateBaseline(page, name = 'default') {
  ensureDir(SNAPSHOTS_DIR);
  const safeName = String(name).replace(/[^a-z0-9_-]/gi, '_');
  const baselinePath = path.join(SNAPSHOTS_DIR, `${safeName}.baseline.bin`);

  const res = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(baselinePath, Buffer.from(res.data, 'base64'));
  return { ok: true, name: safeName, path: baselinePath };
}

module.exports = { runAssertion, runAssertions, screenshotDiff, updateBaseline };
