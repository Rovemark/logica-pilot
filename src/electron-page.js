'use strict';

/**
 * electron-page.js — Adapter that makes an Electron `webContents` look like
 * a Logica Pilot `page` (same contract: send/eval/goto).
 *
 * The Electron `webContents.debugger` IS the Chrome DevTools Protocol talking to
 * the embedded browser engine. So perception.js / actions.js / agent.js run here
 * WITHOUT ANY changes — it's the same engine as headless mode, now inside the window.
 */

class ElectronPage {
  /** @param {import('electron').WebContents} webContents */
  constructor(webContents) {
    this.wc = webContents;
    this._dbg = webContents.debugger;
    if (!this._dbg.isAttached()) {
      try {
        this._dbg.attach('1.3');
      } catch (e) {
        // already attached by another consumer — continue
      }
    }
  }

  /** CDP command → same signature as headless engine. */
  async send(method, params = {}) {
    return this._dbg.sendCommand(method, params);
  }

  /** Runtime.evaluate with returnByValue. */
  async eval(expression) {
    return this.wc.executeJavaScript(expression, true);
  }

  /** Navigation with load completion wait. */
  async goto(url, { timeout = 30000 } = {}) {
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = 'https://' + url;
    await this.wc.loadURL(url);
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.wc.removeListener('did-finish-load', finish);
        this.wc.removeListener('did-fail-load', finish);
        resolve();
      };
      this.wc.once('did-finish-load', finish);
      this.wc.once('did-fail-load', finish);
      setTimeout(finish, timeout);
    });
    await new Promise((r) => setTimeout(r, 400));
    return url;
  }

  async url() {
    try {
      return this.wc.getURL();
    } catch {
      return null;
    }
  }

  detach() {
    try {
      if (this._dbg.isAttached()) this._dbg.detach();
    } catch {}
  }
}

module.exports = { ElectronPage };
