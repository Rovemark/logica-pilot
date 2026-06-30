'use strict';

/**
 * browser.js — Sobe o Chromium (Chrome/Edge/Brave/Chromium) via pipe CDP
 * e expõe páginas controláveis. Não usa Playwright nem Puppeteer.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CDPConnection } = require('./cdp-pipe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// Descoberta do binário do browser (cross-platform)
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

  // Fallback: reusar o binário já baixado pelo Playwright (só o binário, não a lib)
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
  // prefere chromium "full" (headful-capable) sobre headless-shell
  hits.sort((a, b) => (a.includes('headless') ? 1 : 0) - (b.includes('headless') ? 1 : 0));
  if (hits[0]) return hits[0];

  return null;
}

// ─────────────────────────────────────────────────────────────
// Page — uma aba controlável (sessão flat do CDP)
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
      throw new Error('eval: ' + (d.exception?.description || d.text || 'erro de avaliação'));
    }
    return res.result?.value;
  }

  _waitEvent(method, timeout) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        this._c.off(method, handler);
        reject(new Error('timeout aguardando ' + method));
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
// Browser — processo + conexão CDP
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
        'Nenhum browser Chromium encontrado. Instale Chrome/Edge ou defina LOGICA_PILOT_BROWSER=/caminho/do/binário',
      );
    }

    const userDataDir = opts.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'logica-pilot-'));

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
    if (Array.isArray(opts.extraArgs)) args.push(...opts.extraArgs);
    args.push('about:blank');

    // stdio: 0 ignore, 1 ignore, 2 stderr(pipe p/ debug), 3 write→chrome, 4 read←chrome
    const child = spawn(binary, args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let stderrTail = '';
    if (child.stderr) {
      child.stderr.on('data', (d) => {
        stderrTail = (stderrTail + d.toString()).slice(-2000);
        if (process.env.LOGICA_PILOT_DEBUG) process.stderr.write('[chrome] ' + d);
      });
    }

    const writable = child.stdio[3];
    const readable = child.stdio[4];
    if (!writable || !readable) {
      try { child.kill('SIGKILL'); } catch {}
      throw new Error('Falha ao abrir os pipes CDP (fd 3/4).');
    }

    const conn = new CDPConnection(writable, readable);

    // Corrida: ou o browser responde, ou o processo morre, ou estoura timeout
    const ready = (async () => {
      await conn.send('Target.setDiscoverTargets', { discover: true });
    })();

    const earlyExit = new Promise((_, reject) => {
      child.once('exit', (code) =>
        reject(new Error(`Browser saiu antes de conectar (code ${code}). stderr: ${stderrTail.slice(-400)}`)),
      );
    });
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout conectando ao CDP (15s)')), 15000),
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
    this.pages.push(page);
    return page;
  }

  async close() {
    try {
      await this._conn.send('Browser.close').catch(() => {});
    } catch {}
    try {
      this._conn.close();
    } catch {}
    try {
      this._child.kill('SIGKILL');
    } catch {}
    cleanupDir(this._userDataDir);
  }
}

function cleanupDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

module.exports = { Browser, Page, resolveBrowserBinary };
