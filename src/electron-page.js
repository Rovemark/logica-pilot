'use strict';

/**
 * electron-page.js — Adaptador que faz um `webContents` do Electron parecer
 * uma `page` do Logica Pilot (mesmo contrato: send/eval/goto).
 *
 * O `webContents.debugger` do Electron É o Chrome DevTools Protocol falando com
 * o Chromium embarcado. Então perception.js / actions.js / agent.js rodam aqui
 * SEM NENHUMA mudança — é o mesmo motor do modo headless, agora dentro da janela.
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
        // já anexado por outro consumidor — segue
      }
    }
  }

  /** Comando CDP → mesma assinatura do motor headless. */
  async send(method, params = {}) {
    return this._dbg.sendCommand(method, params);
  }

  /** Runtime.evaluate com returnByValue. */
  async eval(expression) {
    return this.wc.executeJavaScript(expression, true);
  }

  /** Navegação com espera de carregamento. */
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
