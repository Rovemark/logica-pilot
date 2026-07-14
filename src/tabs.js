'use strict';

/**
 * tabs.js — Multi-tab management and iframe control.
 *
 * Manages multiple browser tabs: create, switch, close, list.
 * Also discovers and attaches to iframes within a page.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * List all open tabs/pages in the browser.
 * @param {object} conn - CDP connection (browser-level)
 * @returns {Array<{targetId, url, title, type, attached}>}
 */
async function listTabs(conn) {
  const { targetInfos } = await conn.send('Target.getTargets', {});
  return (targetInfos || [])
    .filter((t) => t.type === 'page' && !/^devtools:/.test(t.url || ''))
    .map((t) => ({
      targetId: t.targetId,
      url: t.url || '',
      title: t.title || '',
      type: t.type,
      attached: !!t.attached,
    }));
}

/**
 * Open a new tab and return its Page object.
 * @param {object} browser - Browser instance
 * @param {string} [url] - URL to navigate to
 */
async function newTab(browser, url) {
  const page = await browser.newPage();
  if (url) await page.goto(url);
  return page;
}

/**
 * Switch to an existing tab by targetId.
 * @param {object} conn - CDP connection
 * @param {string} targetId
 * @returns {object} Page-like object for the tab
 */
async function switchTab(conn, targetId) {
  // Activate the target (bring to front)
  await conn.send('Target.activateTarget', { targetId }).catch(() => {});

  // Attach if not already attached
  let sessionId;
  try {
    const res = await conn.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = res.sessionId;
  } catch {
    // Might already be attached — try to find the session
    const { targetInfos } = await conn.send('Target.getTargets', {});
    const info = (targetInfos || []).find((t) => t.targetId === targetId);
    if (!info) throw new Error(`Tab ${targetId} not found`);
    // Re-attach
    const res = await conn.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = res.sessionId;
  }

  // We need to import Page to construct properly — but to avoid circular deps,
  // we return a minimal page-like object. The caller can use it with actions.
  const { Page } = require('./browser');
  const page = new Page(conn, sessionId, targetId, { width: 1280, height: 900 });

  await page.send('Page.enable').catch(() => {});
  await page.send('Runtime.enable').catch(() => {});
  await page.send('DOM.enable').catch(() => {});

  return page;
}

/**
 * Close a tab by targetId.
 * @param {object} conn - CDP connection
 * @param {string} targetId
 */
async function closeTab(conn, targetId) {
  await conn.send('Target.closeTarget', { targetId });
  return { ok: true, closed: targetId };
}

/**
 * List all iframes in the current page.
 * @param {object} page - CDP page
 * @returns {Array<{frameId, url, name, securityOrigin}>}
 */
async function listFrames(page) {
  const { frameTree } = await page.send('Page.getFrameTree').catch(() => ({ frameTree: { childFrames: [] } }));

  const frames = [];
  function walk(node, depth = 0) {
    if (node.frame) {
      frames.push({
        frameId: node.frame.id,
        url: node.frame.url || '',
        name: node.frame.name || '',
        securityOrigin: node.frame.securityOrigin || '',
        depth,
      });
    }
    for (const child of (node.childFrames || [])) {
      walk(child, depth + 1);
    }
  }
  walk(frameTree);
  return frames;
}

/**
 * Execute JS in a specific iframe by frameId.
 * @param {object} page - CDP page
 * @param {string} frameId
 * @param {string} expression
 */
async function evalInFrame(page, frameId, expression) {
  // Create an isolated world in the frame for evaluation
  try {
    const { executionContextId } = await page.send('Page.createIsolatedWorld', {
      frameId,
      grantUniveralAccess: true,
    });

    const res = await page.send('Runtime.evaluate', {
      expression,
      contextId: executionContextId,
      awaitPromise: true,
      returnByValue: true,
    });

    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return { ok: true, value: res.result?.value };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { listTabs, newTab, switchTab, closeTab, listFrames, evalInFrame };
