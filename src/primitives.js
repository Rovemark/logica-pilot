'use strict';

/**
 * primitives.js — Missing browser primitives:
 *  - File upload (by input index or selector)
 *  - Dialog auto-accept/dismiss (alert/confirm/prompt/beforeunload)
 *  - Drag and drop (by element index)
 *  - Storage access (localStorage/sessionStorage read/write/clear)
 *  - Batch eval (multiple expressions in sequence)
 *  - Permission grant via CDP
 */

const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (id) => `[data-lpilot-id="${String(id).replace(/"/g, '')}"]`;

/**
 * Upload a file to an <input type="file"> element.
 * @param {object} page - CDP page
 * @param {number|string} target - element index or CSS selector
 * @param {string|string[]} files - file path(s)
 */
async function uploadFile(page, target, files) {
  const filePaths = Array.isArray(files) ? files : [files];

  // Validate files exist
  for (const f of filePaths) {
    if (!fs.existsSync(f)) return { ok: false, error: `File not found: ${f}` };
  }

  // Resolve the DOM node
  const selector = typeof target === 'number' ? q(target) : target;
  const { root } = await page.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await page.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector,
  }).catch(() => ({ nodeId: 0 }));

  if (!nodeId) return { ok: false, error: `Element not found: ${selector}` };

  await page.send('DOM.setFileInputFiles', {
    nodeId,
    files: filePaths.map((f) => path.resolve(f)),
  });

  // Trigger change event
  await page.eval(
    `(function(){var el=document.querySelector(${JSON.stringify(selector)});` +
    `if(el){el.dispatchEvent(new Event('change',{bubbles:true}));el.dispatchEvent(new Event('input',{bubbles:true}));}})()`,
  );

  return { ok: true, files: filePaths, target: selector };
}

/**
 * Setup automatic dialog handling (alert/confirm/prompt/beforeunload).
 * @param {object} page - CDP page
 * @param {object} opts - { accept?: boolean (default true), promptText?: string }
 */
async function setupDialogHandler(page, { accept = true, promptText } = {}) {
  await page.send('Page.enable').catch(() => {});

  const conn = page._c;

  // Remove old handler if any
  if (page._dialogHandler) {
    conn.off('Page.javascriptDialogOpening', page._dialogHandler);
  }

  const handler = (params, sid) => {
    if (sid !== page.sessionId) return;
    page.send('Page.handleJavaScriptDialog', {
      accept: !!accept,
      ...(promptText !== undefined && params.type === 'prompt' ? { promptText: String(promptText) } : {}),
    }).catch(() => {});
  };

  conn.on('Page.javascriptDialogOpening', handler);
  page._dialogHandler = handler;

  return { ok: true, mode: accept ? 'accept' : 'dismiss', promptText };
}

/**
 * Remove dialog handler.
 */
function removeDialogHandler(page) {
  if (page._dialogHandler && page._c) {
    page._c.off('Page.javascriptDialogOpening', page._dialogHandler);
    page._dialogHandler = null;
  }
  return { ok: true };
}

/**
 * Drag an element from one position to another.
 * @param {object} page - CDP page
 * @param {number} fromIndex - source element index
 * @param {number} toIndex - target element index
 */
async function dragAndDrop(page, fromIndex, toIndex) {
  const getCenter = (id) => page.eval(
    `(function(){var el=document.querySelector('[data-lpilot-id="${id}"]');if(!el)return null;` +
    `el.scrollIntoView({block:'center'});var r=el.getBoundingClientRect();` +
    `return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`,
  );

  const from = await getCenter(fromIndex);
  const to = await getCenter(toIndex);
  if (!from) return { ok: false, error: `Source element [${fromIndex}] not found` };
  if (!to) return { ok: false, error: `Target element [${toIndex}] not found` };

  // Simulate drag sequence: mousemove → mousedown → mousemove(steps) → mouseup
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await sleep(50);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(100);

  // Move in steps for smoother drag
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(from.x + (to.x - from.x) * (i / steps));
    const y = Math.round(from.y + (to.y - from.y) * (i / steps));
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 1 });
    await sleep(30);
  }

  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(100);

  return { ok: true, from: { index: fromIndex, ...from }, to: { index: toIndex, ...to } };
}

/**
 * Read/write/clear localStorage or sessionStorage.
 * @param {object} page - CDP page
 * @param {string} action - get | set | remove | clear | keys | dump
 * @param {string} [storageType='localStorage'] - localStorage | sessionStorage
 * @param {string} [key]
 * @param {string} [value]
 */
async function storage(page, action, storageType = 'localStorage', key, value) {
  const st = storageType === 'sessionStorage' ? 'sessionStorage' : 'localStorage';

  switch (action) {
    case 'get': {
      const val = await page.eval(`${st}.getItem(${JSON.stringify(key)})`);
      return { ok: true, key, value: val };
    }
    case 'set': {
      await page.eval(`${st}.setItem(${JSON.stringify(key)}, ${JSON.stringify(String(value))})`);
      return { ok: true, key, value };
    }
    case 'remove': {
      await page.eval(`${st}.removeItem(${JSON.stringify(key)})`);
      return { ok: true, key, removed: true };
    }
    case 'clear': {
      await page.eval(`${st}.clear()`);
      return { ok: true, cleared: st };
    }
    case 'keys': {
      const keys = await page.eval(`Object.keys(${st})`);
      return { ok: true, storage: st, keys: keys || [] };
    }
    case 'dump': {
      const data = await page.eval(
        `(function(){var o={};for(var i=0;i<${st}.length;i++){var k=${st}.key(i);o[k]=${st}.getItem(k);}return o;})()`
      );
      return { ok: true, storage: st, data: data || {} };
    }
    default:
      return { ok: false, error: `Unknown storage action: ${action}` };
  }
}

/**
 * Execute multiple JS expressions in sequence, returning all results.
 * @param {object} page - CDP page
 * @param {string[]} expressions
 */
async function evalBatch(page, expressions) {
  const results = [];
  for (const expr of expressions) {
    try {
      const val = await page.eval(expr);
      results.push({ ok: true, expression: expr.slice(0, 80), value: val });
    } catch (e) {
      results.push({ ok: false, expression: expr.slice(0, 80), error: e.message });
    }
  }
  return { count: results.length, results };
}

/**
 * Grant browser permissions via CDP (geolocation, notifications, camera, microphone, etc.).
 * @param {object} page - CDP page
 * @param {string[]} permissions - e.g. ['geolocation', 'notifications', 'camera']
 */
async function grantPermissions(page, permissions) {
  try {
    const url = await page.eval('location.href').catch(() => '');
    const origin = url ? new URL(url).origin : undefined;
    // Browser.grantPermissions works at browser level
    await page.send('Browser.grantPermissions', {
      permissions,
      ...(origin ? { origin } : {}),
    });
    return { ok: true, granted: permissions, origin };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Reset all granted permissions.
 */
async function resetPermissions(page) {
  try {
    await page.send('Browser.resetPermissions');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  uploadFile, setupDialogHandler, removeDialogHandler,
  dragAndDrop, storage, evalBatch, grantPermissions, resetPermissions,
};
