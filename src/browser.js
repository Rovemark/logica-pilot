'use strict';

/**
 * browser.js — Launches the browser engine (Chrome/Edge/Brave/Chromium) via CDP pipe
 * and exposes controllable pages. Does not use Playwright or Puppeteer.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CDPConnection } = require('./cdp-pipe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// Proxy & location (BYO-proxy: Webshare/Bright/etc. — local-first)
// ─────────────────────────────────────────────────────────────

/** "user:pass@host:port" | "scheme://user:pass@host:port" | "host:port" →
 *  { server, username, password }. Chromium's --proxy-server takes no creds,
 *  so credentials are answered via CDP Fetch.authRequired per page. */
function parseProxy(raw) {
  if (!raw || !String(raw).trim()) return null;
  let s = String(raw).trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    return {
      server: `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`,
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
    };
  } catch { return null; }
}

// Reasonable defaults per country (Firecrawl-style location emulation).
const COUNTRY_DEFAULTS = {
  US: { timezone: 'America/New_York', locale: 'en-US' },
  BR: { timezone: 'America/Sao_Paulo', locale: 'pt-BR' },
  GB: { timezone: 'Europe/London', locale: 'en-GB' },
  DE: { timezone: 'Europe/Berlin', locale: 'de-DE' },
  FR: { timezone: 'Europe/Paris', locale: 'fr-FR' },
  ES: { timezone: 'Europe/Madrid', locale: 'es-ES' },
  PT: { timezone: 'Europe/Lisbon', locale: 'pt-PT' },
  IT: { timezone: 'Europe/Rome', locale: 'it-IT' },
  NL: { timezone: 'Europe/Amsterdam', locale: 'nl-NL' },
  JP: { timezone: 'Asia/Tokyo', locale: 'ja-JP' },
  IN: { timezone: 'Asia/Kolkata', locale: 'en-IN' },
  AU: { timezone: 'Australia/Sydney', locale: 'en-AU' },
  CA: { timezone: 'America/Toronto', locale: 'en-CA' },
  MX: { timezone: 'America/Mexico_City', locale: 'es-MX' },
  AR: { timezone: 'America/Buenos_Aires', locale: 'es-AR' },
};

/** { country?, languages?, timezone? } → { timezone, locale, acceptLanguage } */
function resolveLocation(loc) {
  if (!loc) return null;
  const norm = typeof loc === 'string' ? { country: loc } : loc;
  const cc = String(norm.country || '').toUpperCase();
  const base = COUNTRY_DEFAULTS[cc] || {};
  const languages = Array.isArray(norm.languages) && norm.languages.length
    ? norm.languages
    : (base.locale ? [base.locale] : []);
  return {
    timezone: norm.timezone || base.timezone || null,
    locale: languages[0] || base.locale || null,
    acceptLanguage: languages.length
      ? languages.map((l, i) => (i ? `${l};q=${Math.max(0.1, 1 - i * 0.2).toFixed(1)}` : l)).join(', ')
      : null,
  };
}

// ─────────────────────────────────────────────────────────────
// Browser binary discovery (cross-platform)
// ─────────────────────────────────────────────────────────────
function walkFind(root, names, maxDepth = 5) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (depth > maxDepth) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push([full, depth + 1]);
      } else if (names.includes(e.name)) {
        found.push(full);
      }
    }
  }
  return found;
}

function resolveBrowserBinary() {
  const override = process.env.LOGICA_PILOT_BROWSER || process.env.CHROME_PATH;
  if (override && fs.existsSync(override)) return override;

  const plat = process.platform;
  const candidates = [];

  if (plat === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    );
  } else if (plat === 'win32') {
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/snap/bin/chromium',
      '/opt/google/chrome/chrome',
    );
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }

  // Fallback: reuse binary already downloaded by Playwright (binary only, not the library)
  const pwRoots = {
    darwin: path.join(os.homedir(), 'Library/Caches/ms-playwright'),
    win32: path.join(os.homedir(), 'AppData/Local/ms-playwright'),
    linux: path.join(os.homedir(), '.cache/ms-playwright'),
  };
  const root = pwRoots[plat] || pwRoots.linux;
  const names = ['Chromium', 'chrome', 'chrome-headless-shell', 'headless_shell'];
  const hits = walkFind(root, names, 5).filter((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  // prefer full browser (headful-capable) over headless-shell
  hits.sort((a, b) => (a.includes('headless') ? 1 : 0) - (b.includes('headless') ? 1 : 0));
  if (hits[0]) return hits[0];

  return null;
}

// ─────────────────────────────────────────────────────────────
// Page — a controllable tab (flat CDP session)
// ─────────────────────────────────────────────────────────────
class Page {
  constructor(conn, sessionId, targetId, viewport) {
    this._c = conn;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.viewport = viewport;
  }

  send(method, params = {}) {
    return this._c.send(method, params, this.sessionId);
  }

  async eval(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error('eval: ' + (d.exception?.description || d.text || 'evaluation error'));
    }
    return res.result?.value;
  }

  _waitEvent(method, timeout) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        this._c.off(method, handler);
        reject(new Error('timeout waiting for ' + method));
      }, timeout);
      const handler = (params, sid) => {
        if (sid === this.sessionId) {
          clearTimeout(to);
          this._c.off(method, handler);
          resolve(params);
        }
      };
      this._c.on(method, handler);
    });
  }

  async goto(url, { timeout = 30000, waitUntil = 'load', settle = 500 } = {}) {
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = 'https://' + url;
    const ev = waitUntil === 'domcontentloaded' ? 'Page.domContentEventFired' : 'Page.loadEventFired';
    const loaded = this._waitEvent(ev, timeout).catch(() => {});
    await this.send('Page.navigate', { url });
    await loaded;
    await sleep(settle);
    return url;
  }

  async url() {
    try {
      return await this.eval('location.href');
    } catch {
      return null;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Browser — process + CDP connection
// ─────────────────────────────────────────────────────────────
class Browser {
  constructor(child, conn, userDataDir, opts) {
    this._child = child;
    this._conn = conn;
    this._userDataDir = userDataDir;
    this.opts = opts;
    this.pages = [];
    this.binary = opts.binary;
  }

  static async launch(opts = {}) {
    const headless = opts.headless !== false; // default headless
    const width = opts.width || 1280;
    const height = opts.height || 900;
    const binary = opts.binary || resolveBrowserBinary();
    if (!binary) {
      throw new Error(
        'No Chromium-based browser found. Install Chrome/Edge or set LOGICA_PILOT_BROWSER=/path/to/binary',
      );
    }

    const userDataDir = opts.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'logica-pilot-'));

    // BYO proxy (Webshare, Bright Data, Oxylabs, Smartproxy, …): per-call `proxy`
    // wins, then LOGICA_PILOT_PROXY, then the standard HTTPS_PROXY/HTTP_PROXY.
    const proxy = parseProxy(
      opts.proxy || process.env.LOGICA_PILOT_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY,
    );

    // Named proxy pool (per-request auth + rotation): Chromium's --proxy-server can't
    // carry creds or rotate, so we stand up a local forwarding proxy that rotates
    // upstreams from the pool and point Chromium at it. See proxy-server.js.
    let localProxyServer = null;
    let proxyServerArg = proxy ? proxy.server : null;
    if (opts.proxyPool) {
      const lp = await require('./proxy-server').startProxy({ pool: opts.proxyPool, strategy: opts.proxyStrategy, session: opts.proxySession });
      localProxyServer = lp.server;
      proxyServerArg = lp.url;
    }

    const args = [
      `--user-data-dir=${userDataDir}`,
      '--remote-debugging-pipe',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints,DialMediaRouteProvider',
      '--disable-hang-monitor',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-sync',
      '--metrics-recording-only',
      '--password-store=basic',
      '--use-mock-keychain',
      '--disable-blink-features=AutomationControlled',
      `--window-size=${width},${height}`,
    ];
    if (headless) args.push('--headless=new', '--hide-scrollbars', '--mute-audio');
    if (proxyServerArg) args.push(`--proxy-server=${proxyServerArg}`);
    if (Array.isArray(opts.extraArgs)) args.push(...opts.extraArgs);
    args.push('about:blank');

    // stdio: 0 ignore, 1 ignore, 2 stderr (pipe for debug), 3 write→browser, 4 read←browser
    const child = spawn(binary, args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let stderrTail = '';
    if (child.stderr) {
      child.stderr.on('data', (d) => {
        stderrTail = (stderrTail + d.toString()).slice(-2000);
        if (process.env.LOGICA_PILOT_DEBUG) process.stderr.write('[browser] ' + d);
      });
    }

    const writable = child.stdio[3];
    const readable = child.stdio[4];
    if (!writable || !readable) {
      try { child.kill('SIGKILL'); } catch {}
      throw new Error('Failed to open CDP pipes (fd 3/4).');
    }

    const conn = new CDPConnection(writable, readable);

    // Race: either the browser responds, or the process dies, or timeout is exceeded
    const ready = (async () => {
      await conn.send('Target.setDiscoverTargets', { discover: true });
    })();

    const earlyExit = new Promise((_, reject) => {
      child.once('exit', (code) =>
        reject(new Error(`Browser exited before connecting (code ${code}). stderr: ${stderrTail.slice(-400)}`)),
      );
    });
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout connecting to CDP (15s)')), 15000),
    );

    try {
      await Promise.race([ready, earlyExit, timeout]);
    } catch (e) {
      try { child.kill('SIGKILL'); } catch {}
      cleanupDir(userDataDir);
      throw e;
    }

    const browser = new Browser(child, conn, userDataDir, {
      ...opts,
      headless,
      width,
      height,
      binary,
    });
    browser._proxyAuth = proxy && proxy.username ? { username: proxy.username, password: proxy.password } : null;
    browser._localProxy = localProxyServer;
    browser._location = resolveLocation(opts.location || process.env.LOGICA_PILOT_LOCATION || null);
    return browser;
  }

  /**
   * ATTACH to an already-running Chromium/Edge/Brave (or our desktop app) started
   * with --remote-debugging-port=PORT. Drives the user's REAL browser — their
   * profile, logins, extensions — which no cloud scraper can do. close() only
   * detaches (never kills the user's browser).
   */
  static async attach({ port = 9222, host = '127.0.0.1', match } = {}) {
    const { CDPWebSocket, httpGetJSON } = require('./cdp-ws');
    let version;
    try { version = await httpGetJSON(`http://${host}:${port}/json/version`); }
    catch (e) { throw new Error(`No debuggable browser at ${host}:${port}. Start one with --remote-debugging-port=${port}. (${e.message})`); }
    const conn = await CDPWebSocket.connect(version.webSocketDebuggerUrl);
    await conn.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await conn.send('Target.getTargets', {});
    const pages = (targetInfos || []).filter((t) => t.type === 'page' && !/^devtools:/.test(t.url || ''));
    if (!pages.length) throw new Error('attached, but the browser has no open page/tab');
    const chosen = (match && pages.find((p) => (p.url || '').includes(match))) || pages.find((p) => p.attached) || pages[0];
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId: chosen.targetId, flatten: true });
    const page = new Page(conn, sessionId, chosen.targetId, { width: 1280, height: 900 });
    await page.send('Page.enable').catch(() => {});
    await page.send('Runtime.enable').catch(() => {});
    await page.send('DOM.enable').catch(() => {});
    const browser = new Browser(null, conn, null, { attached: true, width: 1280, height: 900 });
    browser.page = page;
    browser.pages = [page];
    return browser;
  }

  async newPage() {
    const { targetId } = await this._conn.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this._conn.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const page = new Page(this._conn, sessionId, targetId, {
      width: this.opts.width,
      height: this.opts.height,
    });
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('DOM.enable').catch(() => {});
    await page
      .send('Emulation.setDeviceMetricsOverride', {
        width: this.opts.width,
        height: this.opts.height,
        deviceScaleFactor: 1,
        mobile: false,
      })
      .catch(() => {});

    // Proxy auth: --proxy-server carries no credentials, so answer the 407
    // challenge via CDP. Fetch.enable(handleAuthRequests) pauses requests —
    // continue them all, and provide credentials on authRequired.
    if (this._proxyAuth) {
      const auth = this._proxyAuth;
      this._conn.on('Fetch.requestPaused', (p, sid) => {
        if (sid !== page.sessionId) return;
        page.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      });
      this._conn.on('Fetch.authRequired', (p, sid) => {
        if (sid !== page.sessionId) return;
        page.send('Fetch.continueWithAuth', {
          requestId: p.requestId,
          authChallengeResponse: { response: 'ProvideCredentials', username: auth.username, password: auth.password },
        }).catch(() => {});
      });
      await page.send('Fetch.enable', { handleAuthRequests: true }).catch(() => {});
    }

    // Location emulation (Firecrawl-style): timezone + locale + Accept-Language.
    if (this._location) {
      const L = this._location;
      if (L.timezone) await page.send('Emulation.setTimezoneOverride', { timezoneId: L.timezone }).catch(() => {});
      if (L.locale) await page.send('Emulation.setLocaleOverride', { locale: L.locale }).catch(() => {});
      if (L.acceptLanguage) {
        await page.send('Network.enable').catch(() => {});
        await page.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': L.acceptLanguage } }).catch(() => {});
      }
    }

    this.pages.push(page);
    return page;
  }

  async close() {
    // Attached mode: only detach — NEVER kill the user's own browser.
    if (this.opts && this.opts.attached) { try { this._conn.close(); } catch {} return; }
    try {
      await this._conn.send('Browser.close').catch(() => {});
    } catch {}
    try {
      this._conn.close();
    } catch {}
    try {
      this._child.kill('SIGKILL');
    } catch {}
    try { if (this._localProxy) this._localProxy.close(); } catch {}
    cleanupDir(this._userDataDir);
  }
}

function cleanupDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

module.exports = { Browser, Page, resolveBrowserBinary, parseProxy, resolveLocation };
