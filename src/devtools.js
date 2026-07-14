'use strict';

/**
 * devtools.js — DevTools inspection: console logs, network requests, performance metrics, JS debugging.
 *
 * Exposes CDP domains (Console, Network, Performance, Debugger) as clean, compact APIs.
 * Captures are BUFFERED in-memory and returned on demand — no streaming to keep it token-first.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Capture console messages for a duration or until explicitly stopped.
 * @param {object} page - CDP page
 * @param {object} opts - { duration?: number (ms, default 5000), levels?: string[] }
 * @returns {{ messages: Array<{level, text, url, line}> }}
 */
async function captureConsole(page, { duration = 5000, levels } = {}) {
  const messages = [];
  const allowedLevels = levels ? new Set(levels.map((l) => l.toLowerCase())) : null;

  await page.send('Runtime.enable').catch(() => {});

  const handler = (params, sid) => {
    if (sid !== page.sessionId) return;
    const entry = params.entry || params;
    const level = (entry.level || entry.type || 'log').toLowerCase();
    if (allowedLevels && !allowedLevels.has(level)) return;
    messages.push({
      level,
      text: entry.text || (entry.args && entry.args.map((a) => a.value || a.description || '').join(' ')) || '',
      url: entry.url || entry.source || '',
      line: entry.lineNumber || entry.line || 0,
      ts: Date.now(),
    });
  };

  const conn = page._c;
  conn.on('Runtime.consoleAPICalled', handler);
  conn.on('Runtime.exceptionThrown', (params, sid) => {
    if (sid !== page.sessionId) return;
    const ex = params.exceptionDetails;
    messages.push({
      level: 'error',
      text: ex?.exception?.description || ex?.text || 'unknown exception',
      url: ex?.url || '',
      line: ex?.lineNumber || 0,
      ts: Date.now(),
    });
  });

  await sleep(Math.min(duration, 30000));

  conn.off('Runtime.consoleAPICalled', handler);

  return { count: messages.length, messages: messages.slice(0, 200) };
}

/**
 * Capture network requests (HAR-lite) for a duration.
 * @param {object} page - CDP page
 * @param {object} opts - { duration?: number (ms), filter?: string (url substring) }
 */
async function captureNetwork(page, { duration = 5000, filter } = {}) {
  const requests = [];
  const pending = new Map();

  await page.send('Network.enable').catch(() => {});

  const conn = page._c;

  const onReqWillBeSent = (params, sid) => {
    if (sid !== page.sessionId) return;
    const r = params.request;
    if (filter && !(r.url || '').includes(filter)) return;
    pending.set(params.requestId, {
      id: params.requestId,
      method: r.method,
      url: r.url,
      type: params.type || '',
      headers: r.headers || {},
      startTime: params.timestamp,
    });
  };

  const onRespReceived = (params, sid) => {
    if (sid !== page.sessionId) return;
    const entry = pending.get(params.requestId);
    if (!entry) return;
    const resp = params.response;
    entry.status = resp.status;
    entry.statusText = resp.statusText || '';
    entry.mimeType = resp.mimeType || '';
    entry.responseHeaders = resp.headers || {};
    entry.encodedDataLength = resp.encodedDataLength;
  };

  const onLoadingFinished = (params, sid) => {
    if (sid !== page.sessionId) return;
    const entry = pending.get(params.requestId);
    if (!entry) return;
    entry.endTime = params.timestamp;
    entry.size = params.encodedDataLength || entry.encodedDataLength || 0;
    entry.duration = entry.endTime && entry.startTime
      ? Math.round((entry.endTime - entry.startTime) * 1000) + 'ms'
      : '';
    requests.push(entry);
    pending.delete(params.requestId);
  };

  const onLoadingFailed = (params, sid) => {
    if (sid !== page.sessionId) return;
    const entry = pending.get(params.requestId);
    if (!entry) return;
    entry.error = params.errorText || 'failed';
    entry.status = 0;
    requests.push(entry);
    pending.delete(params.requestId);
  };

  conn.on('Network.requestWillBeSent', onReqWillBeSent);
  conn.on('Network.responseReceived', onRespReceived);
  conn.on('Network.loadingFinished', onLoadingFinished);
  conn.on('Network.loadingFailed', onLoadingFailed);

  await sleep(Math.min(duration, 60000));

  conn.off('Network.requestWillBeSent', onReqWillBeSent);
  conn.off('Network.responseReceived', onRespReceived);
  conn.off('Network.loadingFinished', onLoadingFinished);
  conn.off('Network.loadingFailed', onLoadingFailed);

  // Also grab any remaining pending
  for (const entry of pending.values()) {
    entry.status = entry.status || 'pending';
    requests.push(entry);
  }

  return {
    count: requests.length,
    requests: requests.slice(0, 300).map((r) => ({
      method: r.method,
      url: (r.url || '').slice(0, 200),
      status: r.status,
      type: r.type,
      size: r.size,
      duration: r.duration,
      error: r.error,
    })),
  };
}

/**
 * Get performance metrics (FCP, LCP, CLS, memory, DOM nodes, etc.).
 * @param {object} page - CDP page
 */
async function getPerformanceMetrics(page) {
  await page.send('Performance.enable').catch(() => {});
  const { metrics: rawMetrics } = await page.send('Performance.getMetrics').catch(() => ({ metrics: [] }));

  const metrics = {};
  for (const m of rawMetrics || []) {
    metrics[m.name] = m.value;
  }

  // Also grab Web Vitals if available
  const webVitals = await page.eval(`
    (function() {
      var out = {};
      try {
        var entries = performance.getEntriesByType('paint');
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].name === 'first-contentful-paint') out.FCP = Math.round(entries[i].startTime);
        }
      } catch(e) {}
      try {
        var nav = performance.getEntriesByType('navigation')[0];
        if (nav) {
          out.TTFB = Math.round(nav.responseStart - nav.requestStart);
          out.DOMContentLoaded = Math.round(nav.domContentLoadedEventEnd);
          out.Load = Math.round(nav.loadEventEnd);
          out.TransferSize = nav.transferSize;
        }
      } catch(e) {}
      try { out.DOMNodes = document.querySelectorAll('*').length; } catch(e) {}
      try { out.JSHeapUsed = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1024 / 1024) + 'MB' : null; } catch(e) {}
      return out;
    })()
  `).catch(() => ({}));

  return { cdpMetrics: metrics, webVitals: webVitals || {} };
}

/**
 * Evaluate a JS expression with the debugger paused (breakpoint support).
 * Simpler version: just runs with error catching and stack trace.
 */
async function debugEval(page, expression) {
  try {
    const res = await page.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      generatePreview: true,
      includeCommandLineAPI: true,
    });
    if (res.exceptionDetails) {
      return {
        ok: false,
        error: res.exceptionDetails.exception?.description || res.exceptionDetails.text,
        line: res.exceptionDetails.lineNumber,
        column: res.exceptionDetails.columnNumber,
        stack: res.exceptionDetails.stackTrace?.callFrames?.map((f) => `${f.functionName || '(anon)'} @ ${f.url}:${f.lineNumber}`),
      };
    }
    return { ok: true, value: res.result?.value, type: res.result?.type, description: res.result?.description };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { captureConsole, captureNetwork, getPerformanceMetrics, debugEval };
