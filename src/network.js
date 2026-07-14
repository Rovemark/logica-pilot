'use strict';

/**
 * network.js — Network control: blocking, throttling, request interception, header injection.
 *
 * Capabilities:
 *  - Block resources by type (images, fonts, media, ads) or pattern
 *  - Throttle connection (slow-3g, fast-3g, offline, custom)
 *  - Intercept & mock responses (pattern → JSON/body)
 *  - Inject extra HTTP headers on all requests
 */

// ── Preset throttle profiles (Chrome DevTools-compatible) ──
const THROTTLE_PRESETS = {
  'offline':  { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  'slow-3g':  { offline: false, latency: 2000, downloadThroughput: 50 * 1024 / 8, uploadThroughput: 50 * 1024 / 8 },
  'fast-3g':  { offline: false, latency: 562.5, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 },
  '4g':       { offline: false, latency: 170, downloadThroughput: 9 * 1024 * 1024 / 8, uploadThroughput: 3.6 * 1024 * 1024 / 8 },
  'wifi':     { offline: false, latency: 28, downloadThroughput: 30 * 1024 * 1024 / 8, uploadThroughput: 15 * 1024 * 1024 / 8 },
};

// ── Resource type presets for blocking ──
const BLOCK_PRESETS = {
  images: ['Image'],
  fonts: ['Font'],
  media: ['Media'],
  stylesheets: ['Stylesheet'],
  ads: [], // pattern-based, not type-based
};

const AD_PATTERNS = [
  '*doubleclick.net*', '*googlesyndication*', '*googleadservices*',
  '*facebook.com/tr*', '*analytics.google.com*', '*google-analytics.com*',
  '*adservice.google*', '*pagead*', '*adsrvr.org*', '*adnxs.com*',
  '*criteo.com*', '*outbrain.com*', '*taboola.com*',
];

/**
 * Block resources by preset or URL pattern.
 * @param {object} page - CDP page
 * @param {string|string[]} what - preset name(s) or URL patterns
 */
async function blockResources(page, what) {
  const items = Array.isArray(what) ? what : [what];
  const patterns = [];

  for (const item of items) {
    const preset = BLOCK_PRESETS[item.toLowerCase()];
    if (preset && preset.length) {
      // Type-based blocking via Fetch
      for (const rt of preset) patterns.push({ resourceType: rt });
    } else if (item.toLowerCase() === 'ads') {
      for (const p of AD_PATTERNS) patterns.push({ urlPattern: p });
    } else {
      // Treat as URL pattern
      patterns.push({ urlPattern: item });
    }
  }

  if (!patterns.length) return { ok: false, error: 'no valid patterns' };

  await page.send('Fetch.enable', { patterns: patterns.map((p) => ({ ...p, requestStage: 'Request' })) });

  // Store the connection listener reference for cleanup
  const conn = page._c;
  const handler = (params, sid) => {
    if (sid !== page.sessionId) return;
    // Check if this request matches our block criteria
    const req = params;
    const shouldBlock = patterns.some((p) => {
      if (p.resourceType && req.resourceType === p.resourceType) return true;
      if (p.urlPattern) {
        const regex = new RegExp(p.urlPattern.replace(/\*/g, '.*'), 'i');
        return regex.test(req.request?.url || '');
      }
      return false;
    });

    if (shouldBlock) {
      page.send('Fetch.failRequest', { requestId: req.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    } else {
      page.send('Fetch.continueRequest', { requestId: req.requestId }).catch(() => {});
    }
  };

  conn.on('Fetch.requestPaused', handler);
  page._blockHandler = handler;

  return { ok: true, blocked: items, patternCount: patterns.length };
}

/**
 * Unblock all resources (disable Fetch interception).
 */
async function unblockResources(page) {
  await page.send('Fetch.disable').catch(() => {});
  if (page._blockHandler && page._c) {
    page._c.off('Fetch.requestPaused', page._blockHandler);
    page._blockHandler = null;
  }
  return { ok: true };
}

/**
 * Apply network throttling.
 * @param {object} page - CDP page
 * @param {string|object} profile - preset name or { latency, downloadThroughput, uploadThroughput, offline }
 */
async function throttle(page, profile) {
  const conditions = typeof profile === 'string'
    ? THROTTLE_PRESETS[profile.toLowerCase().replace(/\s/g, '-')]
    : profile;

  if (!conditions) {
    return { ok: false, error: `Unknown profile: ${profile}. Available: ${Object.keys(THROTTLE_PRESETS).join(', ')}` };
  }

  await page.send('Network.enable').catch(() => {});
  await page.send('Network.emulateNetworkConditions', conditions);

  return { ok: true, profile: typeof profile === 'string' ? profile : 'custom', conditions };
}

/**
 * Remove network throttling.
 */
async function unthrottle(page) {
  await page.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  return { ok: true };
}

/**
 * Intercept requests matching a pattern and return a mock response.
 * @param {object} page - CDP page
 * @param {string} urlPattern - URL pattern (glob-style with *)
 * @param {object} response - { status, headers, body } — body can be string or object (auto-JSON)
 */
async function mockResponse(page, urlPattern, response) {
  await page.send('Fetch.enable', {
    patterns: [{ urlPattern, requestStage: 'Request' }],
  });

  const conn = page._c;
  const handler = (params, sid) => {
    if (sid !== page.sessionId) return;
    const regex = new RegExp(urlPattern.replace(/\*/g, '.*'), 'i');
    if (!regex.test(params.request?.url || '')) {
      page.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      return;
    }

    const body = typeof response.body === 'object'
      ? JSON.stringify(response.body)
      : String(response.body || '');

    const headers = Object.entries(response.headers || { 'content-type': 'application/json' })
      .map(([name, value]) => ({ name, value: String(value) }));

    page.send('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: response.status || 200,
      responseHeaders: headers,
      body: Buffer.from(body).toString('base64'),
    }).catch(() => {});
  };

  conn.on('Fetch.requestPaused', handler);
  if (!page._mockHandlers) page._mockHandlers = [];
  page._mockHandlers.push(handler);

  return { ok: true, urlPattern, status: response.status || 200 };
}

/**
 * Inject extra HTTP headers on all outgoing requests.
 * @param {object} page - CDP page
 * @param {object} headers - { headerName: headerValue, ... }
 */
async function setExtraHeaders(page, headers) {
  await page.send('Network.enable').catch(() => {});
  await page.send('Network.setExtraHTTPHeaders', { headers });
  return { ok: true, headers: Object.keys(headers) };
}

/**
 * Clear all mocks.
 */
async function clearMocks(page) {
  await page.send('Fetch.disable').catch(() => {});
  if (page._mockHandlers && page._c) {
    for (const h of page._mockHandlers) page._c.off('Fetch.requestPaused', h);
    page._mockHandlers = [];
  }
  return { ok: true };
}

module.exports = {
  blockResources, unblockResources,
  throttle, unthrottle,
  mockResponse, setExtraHeaders, clearMocks,
  THROTTLE_PRESETS, BLOCK_PRESETS,
};
